import { z } from "zod";
import type { JsonValue, SolanaRpcTransaction } from "@intelligence/core";
import type { ChainDataProvider, HistoryCompletenessState, WalletHistoryPage, WalletHistoryRequest, WalletHistoryResult, WalletHistoryItem } from "./interfaces.js";

export type RpcProviderErrorCode = "HTTP_ERROR" | "RATE_LIMITED" | "TIMEOUT" | "JSON_RPC_ERROR" | "UNSUPPORTED_TRANSACTION_VERSION" | "MALFORMED_RESPONSE";

export class RpcProviderError extends Error {
  constructor(readonly code: RpcProviderErrorCode, message: string, readonly retryable: boolean) { super(message); }
}

const rpcErrorSchema = z.object({ jsonrpc: z.literal("2.0"), error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) });
const safeNonnegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");
const signatureSchema = z.object({
  signature: z.string().min(32), slot: safeNonnegativeInteger, err: z.unknown().nullable(), memo: z.string().nullable(),
  blockTime: safeNonnegativeInteger.nullable(), confirmationStatus: z.string().nullable().optional()
});
const signaturesEnvelopeSchema = z.object({ jsonrpc: z.literal("2.0"), result: z.array(signatureSchema) });
const accountKeySchema = z.object({ pubkey: z.string().min(32), signer: z.boolean(), writable: z.boolean(), source: z.enum(["transaction", "lookupTable"]).nullable().optional() });
const tokenBalanceSchema = z.object({
  accountIndex: safeNonnegativeInteger, mint: z.string().min(32), owner: z.string().min(32).optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int().min(0).max(255) })
});
const transactionResultSchema = z.object({
  slot: safeNonnegativeInteger, blockTime: safeNonnegativeInteger.nullable(), version: z.union([z.literal("legacy"), safeNonnegativeInteger]).optional(),
  transaction: z.object({ signatures: z.array(z.string().min(32)).min(1), message: z.object({ accountKeys: z.array(accountKeySchema) }).loose() }).loose(),
  meta: z.object({
    err: z.unknown().nullable(), fee: safeNonnegativeInteger, preBalances: z.array(safeNonnegativeInteger), postBalances: z.array(safeNonnegativeInteger),
    preTokenBalances: z.array(tokenBalanceSchema).optional(), postTokenBalances: z.array(tokenBalanceSchema).optional()
  }).nullable()
}).loose();
const transactionEnvelopeSchema = z.object({ jsonrpc: z.literal("2.0"), result: transactionResultSchema.nullable() });

interface RpcCallResult<T> { value: T; latencyMs: number }

export interface StandardSolanaRpcOptions {
  rpcUrl: string;
  commitment?: "confirmed" | "finalized";
  timeoutMs?: number;
  maximumAttempts?: number;
  historyConcurrency?: number;
  retryDelayMs?: number;
  fetchImplementation?: typeof fetch;
  random?: () => number;
}

export class StandardSolanaRpcProvider implements ChainDataProvider {
  readonly name = "standard-solana-rpc";
  readonly historyMode = "STANDARD_RPC" as const;
  private readonly request: typeof fetch;
  private readonly transactionCache = new Map<string, SolanaRpcTransaction | null>();

  constructor(private readonly options: StandardSolanaRpcOptions) { this.request = options.fetchImplementation ?? fetch; }

  async fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage> {
    return (await this.fetchWalletSignaturesWithLatency(request)).value;
  }

  async fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    const cached = this.transactionCache.get(signature);
    if (cached !== undefined || this.transactionCache.has(signature)) return cached ?? null;
    const value = (await this.fetchTransactionWithLatency(signature)).value;
    this.cacheTransaction(signature, value);
    return value;
  }

  async fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult> {
    const started = Date.now();
    const maximumPages = Math.min(20, Math.max(1, request.maxPages ?? 1));
    const maximumSignatures = Math.min(5_000, Math.max(1, request.maxSignatures ?? request.limit ?? 100));
    const pageSize = Math.min(1000, maximumSignatures);
    const minimumBlockTimeMs = request.minimumBlockTime === undefined ? null : Date.parse(request.minimumBlockTime);
    if (minimumBlockTimeMs !== null && !Number.isFinite(minimumBlockTimeMs)) throw new Error("minimumBlockTime must be an ISO timestamp");
    const signatures: WalletHistoryItem[] = [];
    const seen = new Set<string>();
    let before = request.before;
    let signatureLatencyMs = 0;
    let pagesFetched = 0;
    let reachedNaturalEnd = false;
    let reachedTimeCutoff = false;
    while (pagesFetched < maximumPages && signatures.length < maximumSignatures) {
      const requestedPageLimit = Math.min(pageSize, maximumSignatures - signatures.length);
      const signatureResult = await this.fetchWalletSignaturesWithLatency({
        ...request,
        limit: requestedPageLimit,
        ...(before === undefined ? {} : { before })
      });
      pagesFetched += 1;
      signatureLatencyMs += signatureResult.latencyMs;
      for (const item of signatureResult.value.items) {
        if (minimumBlockTimeMs !== null && item.blockTime !== null && Date.parse(item.blockTime) < minimumBlockTimeMs) {
          reachedTimeCutoff = true;
          break;
        }
        if (!seen.has(item.signature)) {
          seen.add(item.signature);
          signatures.push(item);
        }
      }
      if (reachedTimeCutoff || signatureResult.value.items.length < requestedPageLimit || signatureResult.value.nextBefore === null) {
        reachedNaturalEnd = true;
        break;
      }
      before = signatureResult.value.nextBefore;
    }
    const transactions: SolanaRpcTransaction[] = [];
    const failures: Array<{ signature: string; code: string }> = [];
    let missing = 0;
    let transactionLatencyMs = 0;
    let cursor = 0;
    const concurrency = Math.min(8, Math.max(1, request.concurrency ?? this.options.historyConcurrency ?? 4), Math.max(1, signatures.length));
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const item = signatures[index];
        if (item === undefined) return;
        try {
          const cached = this.transactionCache.get(item.signature);
          const result = cached !== undefined || this.transactionCache.has(item.signature)
            ? { value: cached ?? null, latencyMs: 0 }
            : await this.fetchTransactionWithLatency(item.signature);
          transactionLatencyMs += result.latencyMs;
          this.cacheTransaction(item.signature, result.value);
          if (result.value === null) missing += 1;
          else transactions.push(result.value);
        } catch (error) {
          failures.push({ signature: item.signature, code: error instanceof RpcProviderError ? error.code : "UNKNOWN" });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const hasRateLimit = failures.some((failure) => failure.code === "RATE_LIMITED");
    const paginationLimited = !reachedNaturalEnd && (pagesFetched >= maximumPages || signatures.length >= maximumSignatures);
    const completenessState: HistoryCompletenessState = hasRateLimit
      ? "PARTIAL_RATE_LIMIT"
      : failures.length > 0 || missing > 0
        ? "PARTIAL_PROVIDER_FAILURE"
        : paginationLimited
          ? "PARTIAL_PAGINATION_LIMIT"
          : "COMPLETE_WITHIN_REQUESTED_WINDOW";
    const complete = completenessState === "COMPLETE_WITHIN_REQUESTED_WINDOW";
    return {
      signatures, transactions,
      diagnostics: {
        mode: this.historyMode, signaturesFetched: signatures.length, transactionsFetched: transactions.length,
        transactionsMissing: missing, failures, totalDurationMs: Date.now() - started,
        totalRpcLatencyMs: signatureLatencyMs + transactionLatencyMs,
        complete,
        completenessState,
        pagesFetched,
        continuationCursor: paginationLimited ? signatures.at(-1)?.signature ?? before ?? null : null
      }
    };
  }

  private async fetchWalletSignaturesWithLatency(request: WalletHistoryRequest): Promise<RpcCallResult<WalletHistoryPage>> {
    const config: Record<string, string | number> = {
      limit: Math.min(1000, Math.max(1, request.limit ?? 100)),
      commitment: request.commitment ?? this.options.commitment ?? "confirmed"
    };
    if (request.before !== undefined) config.before = request.before;
    if (request.until !== undefined) config.until = request.until;
    const result = await this.rpc("getSignaturesForAddress", [request.address, config], signaturesEnvelopeSchema);
    const items: WalletHistoryItem[] = result.value.result.map((item) => ({
      signature: item.signature, slot: BigInt(item.slot), blockTime: item.blockTime === null ? null : new Date(item.blockTime * 1000).toISOString(), succeeded: item.err === null
    }));
    return { value: { items, nextBefore: items.at(-1)?.signature ?? null }, latencyMs: result.latencyMs };
  }

  private async fetchTransactionWithLatency(signature: string): Promise<RpcCallResult<SolanaRpcTransaction | null>> {
    const result = await this.rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: this.options.commitment ?? "confirmed", maxSupportedTransactionVersion: 0 }], transactionEnvelopeSchema);
    if (result.value.result === null) return { value: null, latencyMs: result.latencyMs };
    const transaction = result.value.result;
    if (transaction.meta === null) throw new RpcProviderError("MALFORMED_RESPONSE", "getTransaction returned no transaction metadata", false);
    const parsed: SolanaRpcTransaction = {
      signature: transaction.transaction.signatures[0] ?? signature,
      slot: BigInt(transaction.slot),
      blockTime: transaction.blockTime === null ? null : new Date(transaction.blockTime * 1000).toISOString(),
      version: transaction.version ?? null,
      accountKeys: transaction.transaction.message.accountKeys.map((key) => ({ pubkey: key.pubkey, signer: key.signer, writable: key.writable, source: key.source ?? null })),
      feeLamports: BigInt(transaction.meta.fee),
      error: transaction.meta.err as JsonValue | null,
      preBalances: transaction.meta.preBalances.map(BigInt), postBalances: transaction.meta.postBalances.map(BigInt),
      preTokenBalances: transaction.meta.preTokenBalances?.map((balance) => ({ accountIndex: balance.accountIndex, mint: balance.mint, owner: balance.owner ?? null, rawAmount: balance.uiTokenAmount.amount, decimals: balance.uiTokenAmount.decimals })) ?? null,
      postTokenBalances: transaction.meta.postTokenBalances?.map((balance) => ({ accountIndex: balance.accountIndex, mint: balance.mint, owner: balance.owner ?? null, rawAmount: balance.uiTokenAmount.amount, decimals: balance.uiTokenAmount.decimals })) ?? null,
      raw: transaction as unknown as JsonValue
    };
    return { value: parsed, latencyMs: result.latencyMs };
  }

  private async rpc<TSchema extends z.ZodType>(method: string, params: unknown[], schema: TSchema): Promise<RpcCallResult<z.infer<TSchema>>> {
    const attempts = Math.min(3, Math.max(1, this.options.maximumAttempts ?? 2));
    let lastError: RpcProviderError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await this.request(this.options.rpcUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${attempt}`, method, params }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
        });
        if (!response.ok) {
          const code: RpcProviderErrorCode = response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
          const error = new RpcProviderError(code, `Solana RPC ${method} failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500);
          Object.assign(error, { retryAfterMs: retryAfter });
          throw error;
        }
        const payload: unknown = await response.json();
        const rpcError = rpcErrorSchema.safeParse(payload);
        if (rpcError.success) {
          const versionMessage = rpcError.data.error.message.toLowerCase();
          const unsupported = versionMessage.includes("unsupported transaction version") || (versionMessage.includes("transaction version") && versionMessage.includes("not supported"));
          throw new RpcProviderError(unsupported ? "UNSUPPORTED_TRANSACTION_VERSION" : "JSON_RPC_ERROR", `Solana RPC ${method} returned JSON-RPC error ${rpcError.data.error.code}: ${rpcError.data.error.message}`, !unsupported && rpcError.data.error.code === -32005);
        }
        const parsed = schema.safeParse(payload);
        if (!parsed.success) throw new RpcProviderError("MALFORMED_RESPONSE", `Solana RPC ${method} returned a malformed response`, false);
        return { value: parsed.data, latencyMs: Date.now() - started };
      } catch (error) {
        const normalized = error instanceof RpcProviderError ? error : error instanceof DOMException && error.name === "TimeoutError"
          ? new RpcProviderError("TIMEOUT", `Solana RPC ${method} timed out`, true)
          : new RpcProviderError("HTTP_ERROR", `Solana RPC ${method} request failed`, true);
        lastError = normalized;
        if (!normalized.retryable || attempt === attempts) throw normalized;
        const retryAfterMs = "retryAfterMs" in normalized && typeof normalized.retryAfterMs === "number" ? normalized.retryAfterMs : 0;
        const delay = Math.max(retryAfterMs, (this.options.retryDelayMs ?? 100) * attempt);
        const jitteredDelay = Math.round(delay * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4));
        if (jitteredDelay > 0) await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
      }
    }
    throw lastError ?? new RpcProviderError("HTTP_ERROR", `Solana RPC ${method} failed`, false);
  }

  private cacheTransaction(signature: string, transaction: SolanaRpcTransaction | null): void {
    this.transactionCache.set(signature, transaction);
    if (this.transactionCache.size > 250) this.transactionCache.delete(this.transactionCache.keys().next().value as string);
  }
}

function parseRetryAfter(value: string | null): number {
  if (value === null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}
