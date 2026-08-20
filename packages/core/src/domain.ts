import type { JsonValue } from "@intelligence/shared";
import type { AmbiguityReason, ClassificationConfidence, WalletActivityClassification } from "./solana.js";

export type IsoTimestamp = string;
export type PublicKey = string;
export type TransactionSignature = string;
export type DecimalString = string;

export type DataConfidence = number | null;
export type WalletStatus = "candidate" | "tracking" | "rejected" | "paused" | "insufficient_data";
export type WalletActionType = "swap_buy" | "swap_sell" | "transfer_in" | "transfer_out" | "unknown";
export type DecisionKind = "BUY" | "REJECT" | "OBSERVE";
export type ExecutionMode = "PAPER" | "SHADOW" | "LIVE";
export type PositionState = "open" | "manual_control" | "sell_recommended" | "closed";
export type PositionEventType =
  | "opened"
  | "price_update"
  | "source_wallet_partial_exit"
  | "source_wallet_full_exit"
  | "liquidity_change"
  | "risk_change"
  | "AI_exit_analysis"
  | "user_wait"
  | "user_sell_authorized"
  | "user_manual_override"
  | "closed";

export interface Wallet {
  id: string;
  publicKey: PublicKey;
  discoveredAt: IsoTimestamp;
  firstObservedAt: IsoTimestamp | null;
  lastObservedAt: IsoTimestamp | null;
  status: WalletStatus;
  dataConfidence: DataConfidence;
  flags: string[];
  notes: string | null;
}

export interface WalletMetrics {
  walletId: string;
  sampleSize: number;
  observedTrades: number;
  realizedWins: number;
  realizedLosses: number;
  realizedPnLUsd: DecimalString | null;
  medianReturn: number | null;
  averageReturn: number | null;
  hitRate: number | null;
  earlyEntryScore: number | null;
  consistencyScore: number | null;
  copyabilityScore: number | null;
  crowdingScore: number | null;
  followerSlippageEstimate: number | null;
  suspiciousCoordinationScore: number | null;
  dataConfidence: DataConfidence;
  scoreCalculatedAt: IsoTimestamp;
}

export interface Token {
  mint: PublicKey;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  firstSeenAt: IsoTimestamp;
  metadataSource: string | null;
}

export interface TokenRiskSnapshot {
  id: string;
  tokenMint: PublicKey;
  timestamp: IsoTimestamp;
  liquidityUsd: DecimalString | null;
  holderConcentration: number | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  creator: PublicKey | null;
  funder: PublicKey | null;
  priceImpactBps: number | null;
  routeAvailable: boolean | null;
  warningFlags: string[];
  riskScore: number | null;
  dataConfidence: DataConfidence;
}

export interface TokenBalanceDelta {
  owner: PublicKey | null;
  tokenAccount: PublicKey;
  mint: PublicKey;
  rawAmount: bigint;
  decimals: number | null;
}

export interface NativeBalanceDelta {
  account: PublicKey;
  lamports: bigint;
}

export interface ChainTransaction {
  signature: TransactionSignature;
  slot: bigint;
  blockTime: IsoTimestamp | null;
  status: "succeeded" | "failed" | "unknown";
  feeLamports: bigint | null;
  provider: string;
  rawPayload: JsonValue;
  observedAt: IsoTimestamp;
  providerReceivedAt: IsoTimestamp;
  normalizationCompletedAt: IsoTimestamp | null;
  ingestionLatencyMs: number | null;
  relevantWallets: PublicKey[];
  tokenBalanceDeltas: TokenBalanceDelta[];
  nativeBalanceDeltas: NativeBalanceDelta[];
}

export interface WalletAction {
  id: string;
  wallet: PublicKey;
  actionType: WalletActionType;
  classification: WalletActivityClassification;
  classificationConfidence: ClassificationConfidence;
  evidence: string[];
  ambiguityReasons: AmbiguityReason[];
  tokenMint: PublicKey | null;
  inputMint: PublicKey | null;
  outputMint: PublicKey | null;
  inputRawAmount: bigint | null;
  inputDecimals: number | null;
  outputRawAmount: bigint | null;
  outputDecimals: number | null;
  approximateInputUsd: DecimalString | null;
  approximateOutputUsd: DecimalString | null;
  transactionSignature: TransactionSignature;
  slot: bigint;
  observedAt: IsoTimestamp;
  chainTime: IsoTimestamp | null;
  sourceConfidence: DataConfidence;
}

export interface PipelineTimestamps {
  chainEventAt: IsoTimestamp | null;
  providerReceivedAt: IsoTimestamp;
  normalizationCompletedAt: IsoTimestamp | null;
  signalCreatedAt: IsoTimestamp | null;
  decisionCompletedAt: IsoTimestamp | null;
  simulatedExecutionAt: IsoTimestamp | null;
}

export interface PipelineLatency {
  observableIngestionMs: number | null;
  normalizationMs: number | null;
  signalDecisionMs: number | null;
  decisionExecutionMs: number | null;
  totalObservableMs: number | null;
}

export interface ScoreComponent {
  name: string;
  value: number;
  weight: number;
  contribution: number;
  source: "observed" | "derived" | "unknown_default";
}

export interface WalletScore {
  total: number;
  confidence: number;
  components: ScoreComponent[];
  reasonCodes: string[];
  rulesetHash: string;
  calculatedAt: IsoTimestamp;
}

export interface Signal {
  id: string;
  sourceWallet: PublicKey;
  tokenMint: PublicKey;
  sourceTransactionSignature: TransactionSignature;
  detectedAt: IsoTimestamp;
  chainEventAt: IsoTimestamp | null;
  chainSlot: bigint;
  walletScore: WalletScore;
  antiCrowdingScore: number | null;
  tokenRiskSnapshot: TokenRiskSnapshot | null;
  decision: DecisionKind;
  rejectionReasons: string[];
  confidence: DataConfidence;
}

export interface TradeDecision {
  id: string;
  signalId: string;
  decision: DecisionKind;
  reasonCodes: string[];
  parameters: JsonValue;
  rulesetHash: string;
  createdAt: IsoTimestamp;
}

export interface EntryMarketSnapshot {
  observedAt: IsoTimestamp;
  priceUsd: DecimalString | null;
  executablePriceVerified: boolean;
  provenance: "MARKET_QUOTE" | "SIMULATED_FILL" | "UNKNOWN";
  fillBasis: "JUPITER_QUOTE" | "VERIFIED_MARKET_OBSERVATION" | "UNAVAILABLE";
  quoteRequestedAt: IsoTimestamp | null;
  quoteReceivedAt: IsoTimestamp | null;
  quoteLatencyMs: number | null;
  expectedOutputRaw: bigint | null;
  quotedInputUsdValue: DecimalString | null;
  inputMint: PublicKey | null;
  outputMint: PublicKey | null;
  liquidityUsd: DecimalString | null;
  estimatedFeeUsd: DecimalString | null;
  estimatedSlippageBps: number | null;
  source: string;
}

export interface PaperPosition {
  id: string;
  tokenMint: PublicKey;
  triggerWallet: PublicKey;
  signalId: string;
  simulatedEntryAt: IsoTimestamp;
  simulatedEntryPriceUsd: DecimalString | null;
  simulatedUsdAmount: DecimalString;
  tokenRawAmount: bigint;
  tokenDecimals: number;
  feesEstimateUsd: DecimalString | null;
  slippageEstimateBps: number | null;
  entryMarketSnapshot: EntryMarketSnapshot;
  quoteAgeAtDecisionMs: number | null;
  state: PositionState;
  markPriceUsd: DecimalString | null;
  unrealizedPnlUsd: DecimalString | null;
  realizedPnlUsd: DecimalString | null;
  exitRecommendation: string | null;
  openedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  closedAt: IsoTimestamp | null;
}

export interface PositionEvent {
  id: string;
  positionId: string;
  type: PositionEventType;
  createdAt: IsoTimestamp;
  details: JsonValue;
  idempotencyKey: string;
}

export interface AIAnalysis {
  id: string;
  purpose: string;
  modelRequested: string;
  modelReturned: string | null;
  promptHash: string;
  structuredResponse: JsonValue | null;
  latencyMs: number | null;
  errorCode: string | null;
  requestMetadata: JsonValue;
  createdAt: IsoTimestamp;
}

export interface UserAction {
  id: string;
  positionId: string | null;
  action: "sell_authorized" | "sell_rejected" | "wait" | "recalculate_exit" | "manual_mode_enabled" | "ai_control_restored" | "emergency_kill_switch" | "settings_changed";
  details: JsonValue;
  createdAt: IsoTimestamp;
}

export interface SystemComponentHealth {
  component: "chain_provider" | "database" | "redis" | "openrouter" | "webhook";
  status: "healthy" | "degraded" | "disabled" | "unknown";
  checkedAt: IsoTimestamp;
  detail: string;
  latencyMs: number | null;
}

export interface SystemStatus {
  executionMode: ExecutionMode;
  network: string;
  killSwitchActive: boolean;
  lastProcessedSlot: string | null;
  queueLagMs: number | null;
  counters: Record<string, number>;
  components: SystemComponentHealth[];
}

export interface WalletBackfillRun {
  id: string;
  wallet: string;
  provider: string;
  historyMode: string;
  requestedLimit: number;
  signaturesFetched: number;
  transactionsFetched: number;
  actionsPersisted: number;
  duplicatesIgnored: number;
  failures: Array<{ signature: string; code: string }>;
  complete: boolean;
  startedAt: string;
  completedAt: string;
}
