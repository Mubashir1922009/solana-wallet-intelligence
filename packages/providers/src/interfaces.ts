import type { EntryMarketSnapshot, ExecutionProvider, JsonValue, MarketQuoteRequest, MarketQuoteResult, SolanaRpcTransaction } from "@intelligence/core";
import type { ProviderTransactionEnvelope } from "@intelligence/core";
import type { z } from "zod";

export interface WalletHistoryRequest {
  address: string;
  limit?: number;
  before?: string;
  until?: string;
  commitment?: "confirmed" | "finalized";
  concurrency?: number;
  maxPages?: number;
  maxSignatures?: number;
  minimumBlockTime?: string;
}

export interface WalletHistoryItem {
  signature: string;
  slot: bigint;
  blockTime: string | null;
  succeeded: boolean | null;
}

export interface WalletHistoryPage {
  items: WalletHistoryItem[];
  nextBefore: string | null;
}

export type HistoryMode = "HELIUS_GTFA" | "STANDARD_RPC" | "UNAVAILABLE";

export type HistoryCompletenessState =
  | "COMPLETE_WITHIN_REQUESTED_WINDOW"
  | "PARTIAL_RATE_LIMIT"
  | "PARTIAL_PROVIDER_FAILURE"
  | "PARTIAL_PAGINATION_LIMIT"
  | "UNKNOWN";

export interface WalletHistoryDiagnostics {
  mode: HistoryMode;
  signaturesFetched: number;
  transactionsFetched: number;
  transactionsMissing: number;
  failures: Array<{ signature: string; code: string }>;
  totalDurationMs: number;
  totalRpcLatencyMs: number;
  complete: boolean;
  completenessState?: HistoryCompletenessState;
  pagesFetched?: number;
  continuationCursor?: string | null;
}

export interface WalletHistoryResult {
  signatures: WalletHistoryItem[];
  transactions: SolanaRpcTransaction[];
  diagnostics: WalletHistoryDiagnostics;
}

export interface ChainDataProvider {
  readonly name: string;
  readonly historyMode: HistoryMode;
  fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage>;
  fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult>;
  fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null>;
  parseWebhook?(payload: unknown, receivedAt: string): ProviderTransactionEnvelope[];
}

export interface MarketDataProvider {
  readonly name: string;
  getBuyMarketSnapshot(tokenMint: string, usdAmount: string): Promise<EntryMarketSnapshot>;
  getSellMarketSnapshot(tokenMint: string, rawTokenAmount: bigint, tokenDecimals: number): Promise<EntryMarketSnapshot>;
}

export interface QuoteMarketDataProvider {
  readonly name: string;
  readonly enabled: boolean;
  getQuote(request: MarketQuoteRequest): Promise<MarketQuoteResult>;
}

export interface AIRequest<TSchema extends z.ZodType> {
  purpose: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: TSchema;
}

export interface AIResult<T> {
  modelRequested: string;
  modelReturned: string | null;
  value: T | null;
  latencyMs: number;
  cached: boolean;
  errorCode: string | null;
}

export interface AIProvider {
  readonly enabled: boolean;
  analyze<TSchema extends z.ZodType>(request: AIRequest<TSchema>): Promise<AIResult<z.infer<TSchema>>>;
}

export type NotificationType = "high_confidence_signal" | "paper_buy_opened" | "major_risk_change" | "source_wallet_exit" | "sell_recommendation" | "system_degraded" | "kill_switch_triggered" | "SHADOW_BUY" | "HIGH_SIGNAL_WALLET" | "TOKEN_RISK_CHANGE" | "SOURCE_WALLET_SELL" | "EXIT_RECOMMENDATION" | "SYSTEM_DEGRADED" | "WATCHER_RECONNECTED" | "WATCHER_GAP_RECOVERED" | "KILL_SWITCH";

export interface NotificationProvider {
  readonly name?: string;
  readonly enabled?: boolean;
  notify(type: NotificationType, payload: JsonValue): Promise<void>;
}

export interface FutureJupiterSwapV2ExecutionProvider extends ExecutionProvider {
  readonly mode: "LIVE";
}
