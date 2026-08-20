import { z } from "zod";
import type { JsonValue, SolanaRpcTransaction } from "@intelligence/core";
import type { ChainDataProvider, WalletHistoryPage, WalletHistoryRequest, WalletHistoryResult, WalletHistoryItem } from "./interfaces.js";

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
}

export class StandardSolanaRpcProvider implements ChainDataProvider {
  readonly name = "standard-solana-rpc";
  readonly historyMode = "STANDARD_RPC" as const;
  private readonly request: typeof fetch;

  constructor(private readonly options: StandardSolanaRpcOptions) { this.request = options.fetchImplementation ?? fetch; }

  async fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage> {
    return (await this.fetchWalletSignaturesWithLatency(request)).value;
  }

  async fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    return (await this.fetchTransactionWithLatency(signature)).value;
  }

  async fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult> {
    const started = Date.now();
    const signatureResult = await this.fetchWalletSignaturesWithLatency(request);
    const signatures = signatureResult.value.items;
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
          const result = await this.fetchTransactionWithLatency(item.signature);
          transactionLatencyMs += result.latencyMs;
          if (result.value === null) missing += 1;
          else transactions.push(result.value);
        } catch (error) {
          failures.push({ signature: item.signature, code: error instanceof RpcProviderError ? error.code : "UNKNOWN" });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return {
      signatures, transactions,
      diagnostics: {
        mode: this.historyMode, signaturesFetched: signatures.length, transactionsFetched: transactions.length,
        transactionsMissing: missing, failures, totalDurationMs: Date.now() - started,
        totalRpcLatencyMs: signatureResult.latencyMs + transactionLatencyMs,
        complete: missing === 0 && failures.length === 0
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
          throw new RpcProviderError(code, `Solana RPC ${method} failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500);
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
        const delay = this.options.retryDelayMs ?? 100;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay * attempt));
      }
    }
    throw lastError ?? new RpcProviderError("HTTP_ERROR", `Solana RPC ${method} failed`, false);
  }
}
