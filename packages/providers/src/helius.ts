import { z } from "zod";
import type { JsonValue, ProviderTransactionEnvelope, SolanaRpcTransaction } from "@intelligence/core";
import type { ChainDataProvider, WalletHistoryPage, WalletHistoryRequest, WalletHistoryResult } from "./interfaces.js";
import { StandardSolanaRpcProvider } from "./solana-rpc.js";

const safeNonnegativeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer");
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
  readonly historyMode = "STANDARD_RPC" as const;
  private readonly standardRpc: StandardSolanaRpcProvider;

  constructor(private readonly options: HeliusProviderOptions) {
    const rpcUrl = new URL(options.rpcUrl);
    rpcUrl.searchParams.set("api-key", options.apiKey);
    this.standardRpc = new StandardSolanaRpcProvider({
      rpcUrl: rpcUrl.toString(),
      maximumAttempts: 2,
      historyConcurrency: 3,
      retryDelayMs: 250,
      ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation })
    });
  }

  fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage> {
    return this.standardRpc.fetchWalletSignatures(request);
  }

  fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    return this.standardRpc.fetchTransaction(signature);
  }

  fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult> {
    return this.standardRpc.fetchWalletHistory(request);
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
}

export function parseHeliusWebhookPayload(payload: unknown, receivedAt: string): ProviderTransactionEnvelope[] {
  const provider = new HeliusChainDataProvider({ rpcUrl: "https://mainnet.helius-rpc.com", apiKey: "unused-for-parsing" });
  return provider.parseWebhook(payload, receivedAt);
}
