import { z } from "zod";
import type { JsonValue, ProviderTransactionEnvelope, SolanaRpcTransaction } from "@intelligence/core";
import type { ChainDataProvider, WalletHistoryPage, WalletHistoryRequest, WalletHistoryResult } from "./interfaces.js";
import { StandardSolanaRpcProvider } from "./solana-rpc.js";

const safeNonnegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");
const signatureItemSchema = z.looseObject({
  signature: z.string().min(32),
  slot: safeNonnegativeInteger,
  err: z.unknown().nullable().optional(),
  blockTime: safeNonnegativeInteger.nullable()
});

const historyResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  result: z.object({ data: z.array(signatureItemSchema), paginationToken: z.string().nullable().optional() })
});

const enhancedWebhookItemSchema = z.looseObject({
  signature: z.string().min(32),
  slot: safeNonnegativeInteger,
  timestamp: safeNonnegativeInteger.nullable().optional(),
  fee: safeNonnegativeInteger.nullable().optional(),
  transactionError: z.unknown().nullable().optional(),
  accountData: z.array(z.looseObject({ account: z.string().min(32) })).optional()
});

const enhancedWebhookSchema = z.array(enhancedWebhookItemSchema).min(1).max(1000);

export interface HeliusProviderOptions {
  rpcUrl: string;
  apiKey: string;
  fetchImplementation?: typeof fetch;
}

export class HeliusChainDataProvider implements ChainDataProvider {
  readonly name = "helius";
  readonly historyMode = "HELIUS_GTFA" as const;
  private readonly request: typeof fetch;
  private readonly standardRpc: StandardSolanaRpcProvider;

  constructor(private readonly options: HeliusProviderOptions) {
    this.request = options.fetchImplementation ?? fetch;
    const rpcUrl = new URL(options.rpcUrl);
    rpcUrl.searchParams.set("api-key", options.apiKey);
    this.standardRpc = new StandardSolanaRpcProvider({ rpcUrl: rpcUrl.toString(), fetchImplementation: this.request });
  }

  async fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage> {
    const limit = Math.min(1000, Math.max(1, request.limit ?? 100));
    const config: Record<string, unknown> = {
      transactionDetails: "signatures",
      limit,
      sortOrder: "desc",
      filters: { tokenAccounts: "balanceChanged" }
    };
    if (request.before !== undefined) config.paginationToken = request.before;
    const payload = await this.rpc({ jsonrpc: "2.0", id: "wallet-history", method: "getTransactionsForAddress", params: [request.address, config] });
    const parsed = historyResponseSchema.parse(payload);
    return {
      items: parsed.result.data.map((item) => ({
        signature: item.signature,
        slot: BigInt(item.slot),
        blockTime: item.blockTime === null ? null : new Date(item.blockTime * 1000).toISOString(),
        succeeded: item.err === undefined ? null : item.err === null
      })),
      nextBefore: parsed.result.paginationToken ?? null
    };
  }

  fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    return this.standardRpc.fetchTransaction(signature);
  }

  async fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult> {
    const started = Date.now();
    const page = await this.fetchWalletSignatures(request);
    const transactions: SolanaRpcTransaction[] = [];
    const failures: Array<{ signature: string; code: string }> = [];
    let missing = 0;
    let cursor = 0;
    const concurrency = Math.min(8, Math.max(1, request.concurrency ?? 4), Math.max(1, page.items.length));
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = page.items[cursor];
        cursor += 1;
        if (item === undefined) return;
        try {
          const transaction = await this.fetchTransaction(item.signature);
          if (transaction === null) missing += 1;
          else transactions.push(transaction);
        } catch { failures.push({ signature: item.signature, code: "TRANSACTION_FETCH_FAILED" }); }
      }
    }));
    return {
      signatures: page.items, transactions,
      diagnostics: { mode: this.historyMode, signaturesFetched: page.items.length, transactionsFetched: transactions.length, transactionsMissing: missing, failures, totalDurationMs: Date.now() - started, totalRpcLatencyMs: 0, complete: missing === 0 && failures.length === 0 }
    };
  }

  parseWebhook(payload: unknown, receivedAt: string): ProviderTransactionEnvelope[] {
    const items = enhancedWebhookSchema.parse(payload);
    return items.map((item) => ({
      signature: item.signature,
      slot: BigInt(item.slot),
      blockTime: item.timestamp === undefined || item.timestamp === null ? null : new Date(item.timestamp * 1000).toISOString(),
      status: item.transactionError === undefined ? "unknown" : item.transactionError === null ? "succeeded" : "failed",
      feeLamports: item.fee === undefined || item.fee === null ? null : BigInt(item.fee),
      provider: this.name,
      rawPayload: item as JsonValue,
      relevantWallets: [...new Set((item.accountData ?? []).map((entry) => entry.account))],
      receivedAt
    }));
  }

  private async rpc(body: unknown): Promise<unknown> {
    const url = new URL(this.options.rpcUrl);
    url.searchParams.set("api-key", this.options.apiKey);
    const response = await this.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Helius RPC request failed with status ${response.status}`);
    return await response.json();
  }
}

export function parseHeliusWebhookPayload(payload: unknown, receivedAt: string): ProviderTransactionEnvelope[] {
  const provider = new HeliusChainDataProvider({ rpcUrl: "https://mainnet.helius-rpc.com", apiKey: "unused-for-parsing" });
  return provider.parseWebhook(payload, receivedAt);
}
