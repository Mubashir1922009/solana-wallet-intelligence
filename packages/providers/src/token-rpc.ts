import { newId } from "@intelligence/shared";
import { calculateTokenConcentration, percentageOfSupply, type LargestTokenAccountObservation, type TokenIntelligenceSnapshot, type TokenMintObservation, type TokenSupplyObservation } from "@intelligence/core";
import { z } from "zod";
import { ProviderBudgetManager } from "./rate-budget.js";

const safeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const tokenAmount = z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int().min(0).max(255) }).loose();
const context = z.object({ slot: safeInteger }).loose();
const supplyEnvelope = z.object({ jsonrpc: z.literal("2.0"), result: z.object({ context, value: tokenAmount }) });
const largestEnvelope = z.object({ jsonrpc: z.literal("2.0"), result: z.object({ context, value: z.array(z.object({ address: z.string().min(32), amount: z.string().regex(/^\d+$/), decimals: z.number().int().min(0).max(255) }).loose()).max(20) }) });
const parsedMintInfo = z.object({ decimals: z.number().int().min(0).max(255), isInitialized: z.boolean(), mintAuthority: z.string().min(32).nullable(), freezeAuthority: z.string().min(32).nullable(), supply: z.string().regex(/^\d+$/), extensions: z.array(z.looseObject({ extension: z.string().optional() })).optional() }).loose();
const parsedTokenInfo = z.object({ owner: z.string().min(32), mint: z.string().min(32), tokenAmount }).loose();
const parsedData = z.object({ program: z.string(), parsed: z.object({ type: z.string(), info: z.unknown() }).loose() }).loose();
const accountValue = z.object({ owner: z.string().min(32), data: z.union([parsedData, z.tuple([z.string(), z.string()])]) }).loose();
const accountEnvelope = z.object({ jsonrpc: z.literal("2.0"), result: z.object({ context, value: accountValue.nullable() }) });
const multipleEnvelope = z.object({ jsonrpc: z.literal("2.0"), result: z.object({ context, value: z.array(accountValue.nullable()).max(100) }) });
const rpcError = z.object({ jsonrpc: z.literal("2.0"), error: z.object({ code: z.number(), message: z.string() }) });

const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export class TokenIntelligenceRpcError extends Error {
  constructor(readonly code: "HTTP_ERROR" | "RATE_LIMITED" | "TIMEOUT" | "RPC_ERROR" | "MALFORMED_RESPONSE", message: string, readonly retryable: boolean) { super(message); }
}

export interface TokenIntelligenceProvider {
  readonly name: string;
  observeToken(mint: string): Promise<TokenIntelligenceSnapshot>;
}

export interface StandardTokenRpcOptions {
  rpcUrl: string;
  commitment?: "confirmed" | "finalized";
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  budget?: ProviderBudgetManager;
}

export class StandardSolanaTokenIntelligenceProvider implements TokenIntelligenceProvider {
  readonly name = "standard-solana-token-rpc";
  private readonly request: typeof fetch;
  readonly budget: ProviderBudgetManager;
  constructor(private readonly options: StandardTokenRpcOptions) {
    this.request = options.fetchImplementation ?? fetch;
    this.budget = options.budget ?? new ProviderBudgetManager({ provider: this.name, concurrency: 4, maximumAttempts: 3, cacheTtlMs: 5_000 });
  }

  async getSupply(mint: string, observedAt = new Date().toISOString()): Promise<TokenSupplyObservation> {
    const data = await this.call("getTokenSupply", [mint, { commitment: this.options.commitment ?? "confirmed" }], supplyEnvelope, `supply:${mint}`);
    return { rawSupply: BigInt(data.result.value.amount), decimals: data.result.value.decimals, slot: BigInt(data.result.context.slot), observedAt, provenance: "SOLANA_GET_TOKEN_SUPPLY" };
  }

  async getLargestAccounts(mint: string, rawSupply: bigint | null, observedAt = new Date().toISOString()): Promise<LargestTokenAccountObservation[]> {
    const data = await this.call("getTokenLargestAccounts", [mint, { commitment: this.options.commitment ?? "confirmed" }], largestEnvelope, `largest:${mint}`);
    const addresses = data.result.value.map((item) => item.address);
    const owners = await this.resolveOwners(addresses, mint);
    return data.result.value.map((item, index) => {
      const rawBalance = BigInt(item.amount);
      return {
        tokenAccount: item.address, rawBalance, decimals: item.decimals,
        percentageOfSupply: rawSupply === null ? null : percentageOfSupply(rawBalance, rawSupply),
        resolvedOwner: owners[index] ?? null, ownerClassification: "UNKNOWN", slot: BigInt(data.result.context.slot), observedAt,
        provenance: "SOLANA_GET_TOKEN_LARGEST_ACCOUNTS"
      };
    });
  }

  async getMint(mint: string, observedAt = new Date().toISOString()): Promise<TokenMintObservation> {
    const data = await this.call("getAccountInfo", [mint, { commitment: this.options.commitment ?? "confirmed", encoding: "jsonParsed" }], accountEnvelope, `mint:${mint}`);
    const value = data.result.value;
    const program = value?.owner === LEGACY_TOKEN_PROGRAM ? "SPL_TOKEN" : value?.owner === TOKEN_2022_PROGRAM ? "TOKEN_2022" : "UNKNOWN";
    const reasons: string[] = [];
    if (value === null) reasons.push("MINT_ACCOUNT_NOT_FOUND");
    if (program === "UNKNOWN") reasons.push("TOKEN_PROGRAM_UNKNOWN");
    if (value === null || Array.isArray(value.data)) return { tokenProgram: program, tokenProgramAddress: value?.owner ?? null, decimals: null, rawSupply: null, mintAuthority: null, mintAuthorityKnown: false, freezeAuthority: null, freezeAuthorityKnown: false, initialized: null, extensionsStatus: program === "TOKEN_2022" ? "UNKNOWN_UNSUPPORTED" : "UNKNOWN", slot: BigInt(data.result.context.slot), observedAt, provenance: "SOLANA_GET_ACCOUNT_INFO", reasons: [...reasons, "MINT_PARSE_UNKNOWN"] };
    const parsed = parsedMintInfo.safeParse(value.data.parsed.info);
    if (!parsed.success || value.data.parsed.type !== "mint") return { tokenProgram: program, tokenProgramAddress: value.owner, decimals: null, rawSupply: null, mintAuthority: null, mintAuthorityKnown: false, freezeAuthority: null, freezeAuthorityKnown: false, initialized: null, extensionsStatus: program === "TOKEN_2022" ? "UNKNOWN_UNSUPPORTED" : "UNKNOWN", slot: BigInt(data.result.context.slot), observedAt, provenance: "SOLANA_GET_ACCOUNT_INFO", reasons: [...reasons, "MINT_PARSE_UNKNOWN"] };
    const extensions = parsed.data.extensions?.map((item) => item.extension).filter((item): item is string => item !== undefined) ?? [];
    const extensionMetadataKnown = parsed.data.extensions !== undefined;
    if (program === "TOKEN_2022" && !extensionMetadataKnown) reasons.push("TOKEN_2022_EXTENSIONS_UNKNOWN");
    if (program === "TOKEN_2022" && extensions.length > 0) reasons.push("TOKEN_2022_UNSUPPORTED_EXTENSION_PRESENT");
    return { tokenProgram: program, tokenProgramAddress: value.owner, decimals: parsed.data.decimals, rawSupply: BigInt(parsed.data.supply), mintAuthority: parsed.data.mintAuthority, mintAuthorityKnown: true, freezeAuthority: parsed.data.freezeAuthority, freezeAuthorityKnown: true, initialized: parsed.data.isInitialized, extensionsStatus: program !== "TOKEN_2022" ? "NOT_APPLICABLE" : !extensionMetadataKnown || extensions.length > 0 ? "UNKNOWN_UNSUPPORTED" : "KNOWN_SUPPORTED", extensions, unsupportedExtensionPresent: program === "TOKEN_2022" ? extensions.length > 0 : false, slot: BigInt(data.result.context.slot), observedAt, provenance: "SOLANA_GET_ACCOUNT_INFO", reasons };
  }

  async observeToken(mint: string): Promise<TokenIntelligenceSnapshot> {
    const observedAt = new Date().toISOString();
    const reasons: string[] = [];
    const [supplyResult, mintResult] = await Promise.allSettled([this.getSupply(mint, observedAt), this.getMint(mint, observedAt)]);
    const supply = supplyResult.status === "fulfilled" ? supplyResult.value : null;
    if (supply === null) reasons.push("SUPPLY_UNKNOWN");
    const mintObservation = mintResult.status === "fulfilled" ? mintResult.value : { tokenProgram: "UNKNOWN" as const, tokenProgramAddress: null, decimals: null, rawSupply: null, mintAuthority: null, mintAuthorityKnown: false, freezeAuthority: null, freezeAuthorityKnown: false, initialized: null, extensionsStatus: "UNKNOWN" as const, slot: null, observedAt, provenance: "SOLANA_GET_ACCOUNT_INFO" as const, reasons: ["MINT_PARSE_UNKNOWN"] };
    reasons.push(...mintObservation.reasons);
    let largestAccounts: LargestTokenAccountObservation[] = [];
    try { largestAccounts = await this.getLargestAccounts(mint, supply?.rawSupply ?? mintObservation.rawSupply, observedAt); }
    catch { reasons.push("LARGEST_ACCOUNTS_UNKNOWN"); }
    const concentration = calculateTokenConcentration(largestAccounts, supply?.rawSupply ?? mintObservation.rawSupply);
    const completeness = ([supply !== null, mintObservation.mintAuthorityKnown, mintObservation.freezeAuthorityKnown, largestAccounts.length > 0, concentration.observationCoverage !== null].filter(Boolean).length) / 5;
    return { id: newId(), tokenMint: mint, supply, mint: mintObservation, largestAccounts, concentration, confidence: completeness >= 0.8 ? "HIGH" : completeness >= 0.6 ? "MEDIUM" : completeness > 0 ? "LOW" : "UNKNOWN", completeness, reasons: [...new Set(reasons)], observedAt };
  }

  private async resolveOwners(addresses: string[], mint: string): Promise<Array<string | null>> {
    if (addresses.length === 0) return [];
    try {
      const data = await this.call("getMultipleAccounts", [addresses, { commitment: this.options.commitment ?? "confirmed", encoding: "jsonParsed" }], multipleEnvelope, `owners:${mint}:${addresses.join(",")}`);
      return data.result.value.map((value) => {
        if (value === null || Array.isArray(value.data) || value.data.parsed.type !== "account") return null;
        const parsed = parsedTokenInfo.safeParse(value.data.parsed.info);
        return parsed.success && parsed.data.mint === mint ? parsed.data.owner : null;
      });
    } catch { return addresses.map(() => null); }
  }

  private call<TSchema extends z.ZodType>(method: string, params: unknown[], schema: TSchema, key: string): Promise<z.infer<TSchema>> {
    return this.budget.run(key, async () => {
      let response: Response;
      try {
        response = await this.request(this.options.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }), signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") throw new TokenIntelligenceRpcError("TIMEOUT", `${method} timed out`, true);
        throw new TokenIntelligenceRpcError("HTTP_ERROR", `${method} request failed`, true);
      }
      if (!response.ok) throw new TokenIntelligenceRpcError(response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR", `${method} failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500);
      const payload: unknown = await response.json();
      const error = rpcError.safeParse(payload);
      if (error.success) throw new TokenIntelligenceRpcError("RPC_ERROR", `${method} RPC ${error.data.error.code}: ${error.data.error.message}`, false);
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new TokenIntelligenceRpcError("MALFORMED_RESPONSE", `${method} returned malformed data`, false);
      return parsed.data;
    });
  }
}
