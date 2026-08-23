import type { JsonValue } from "@intelligence/shared";
import type { CopyabilityEvaluation } from "./copyability.js";
import type { CrowdingObservation } from "./crowding.js";
import type { MarketObservation } from "./market.js";
import type { TokenRiskSnapshot, WalletScore } from "./domain.js";

export type ObservationConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface TokenSupplyObservation {
  rawSupply: bigint;
  decimals: number;
  slot: bigint;
  observedAt: string;
  provenance: "SOLANA_GET_TOKEN_SUPPLY";
}

export interface TokenMintObservation {
  tokenProgram: "SPL_TOKEN" | "TOKEN_2022" | "UNKNOWN";
  tokenProgramAddress: string | null;
  decimals: number | null;
  rawSupply: bigint | null;
  mintAuthority: string | null;
  mintAuthorityKnown: boolean;
  freezeAuthority: string | null;
  freezeAuthorityKnown: boolean;
  initialized: boolean | null;
  extensionsStatus: "NOT_APPLICABLE" | "KNOWN_SUPPORTED" | "UNKNOWN_UNSUPPORTED" | "UNKNOWN";
  extensions?: string[];
  unsupportedExtensionPresent?: boolean | null;
  slot: bigint | null;
  observedAt: string;
  provenance: "SOLANA_GET_ACCOUNT_INFO";
  reasons: string[];
}

export interface LargestTokenAccountObservation {
  tokenAccount: string;
  rawBalance: bigint;
  decimals: number;
  percentageOfSupply: string | null;
  resolvedOwner: string | null;
  ownerClassification: "UNKNOWN";
  slot: bigint;
  observedAt: string;
  provenance: "SOLANA_GET_TOKEN_LARGEST_ACCOUNTS";
}

export interface OwnerConcentrationObservation {
  owner: string;
  rawBalance: bigint;
  percentageOfSupply: string | null;
  accountCount: number;
}

export interface TokenConcentrationObservation {
  largestAccountPct: string | null;
  top5AccountsPct: string | null;
  top10AccountsPct: string | null;
  largestKnownOwnerPct: string | null;
  top5KnownOwnersPct: string | null;
  top10KnownOwnersPct: string | null;
  unresolvedAccountPct: string | null;
  observationCoverage: string | null;
  knownOwners: OwnerConcentrationObservation[];
  observedAccountCount: number;
  resolvedAccountCount: number;
}

export interface TokenIntelligenceSnapshot {
  id: string;
  tokenMint: string;
  supply: TokenSupplyObservation | null;
  mint: TokenMintObservation;
  largestAccounts: LargestTokenAccountObservation[];
  concentration: TokenConcentrationObservation;
  confidence: ObservationConfidence;
  completeness: number;
  reasons: string[];
  observedAt: string;
}

export interface TokenRiskComponent {
  name: "AUTHORITY" | "CONCENTRATION" | "MARKET_ROUTE" | "PRICE_IMPACT" | "DATA_QUALITY";
  risk: number;
  weight: number;
  contribution: number;
  confidence: ObservationConfidence;
  reasonCodes: string[];
}

export interface TokenRiskEvaluation {
  id: string;
  tokenMint: string;
  totalRisk: number;
  components: TokenRiskComponent[];
  reasonCodes: string[];
  confidence: ObservationConfidence;
  dataCompleteness: number;
  evaluatedAt: string;
  rulesetHash: string;
  intelligenceSnapshotId: string | null;
  marketObservationId: string | null;
}

export interface ShadowPositionContext {
  mode: "PAPER" | "SHADOW";
  sourceTransactionSignature: string;
  signalTimestamp: string;
  quoteTimestamp: string;
  walletScore: WalletScore;
  tokenRisk: TokenRiskEvaluation;
  crowding: CrowdingObservation | null;
  copyability: CopyabilityEvaluation;
  sourceOutputRawAmount: bigint | null;
  simulatedOutputRawAmount: bigint;
  quoteProvenance: string;
  latencies: Record<string, number | null>;
}

export interface ShadowPositionRecord {
  positionId: string;
  context: ShadowPositionContext;
  createdAt: string;
}

export interface PositionMark {
  id: string;
  positionId: string;
  marketObservationId: string | null;
  observedAt: string;
  estimatedValueUsd: string | null;
  grossUnrealizedPnlUsd: string | null;
  netUnrealizedPnlUsd: string | null;
  estimatedFeesUsd: string | null;
  maxFavorableExcursionUsd: string | null;
  maxAdverseExcursionUsd: string | null;
  timeHeldMs: number;
  quoteAgeMs: number | null;
  routeAvailable: boolean;
  confidence: ObservationConfidence;
  provenance: "JUPITER_QUOTE" | "UNKNOWN";
}

export type ExitRecommendationKind = "HOLD" | "CONSIDER_SELL" | "STRONG_SELL_SIGNAL" | "INSUFFICIENT_DATA";
export interface ExitRecommendation {
  id: string;
  positionId: string;
  recommendation: ExitRecommendationKind;
  reasonCodes: string[];
  confidence: ObservationConfidence;
  inputSnapshot: JsonValue;
  createdAt: string;
  rulesetHash: string;
}

export interface LiveSubscriptionState {
  wallet: string;
  lifecycle: "ACTIVE" | "QUEUED_CAPACITY" | "PAUSED" | "REJECTED" | "INACTIVE";
  priority: number;
  provider: string;
  subscriptionHealthy: boolean;
  lastObservedSignature: string | null;
  lastObservedSlot: bigint | null;
  lastActivityAt: string | null;
  lastSuccessfulIngestionAt: string | null;
  updatedAt: string;
}

export interface CandidateDiscovery {
  id: string;
  wallet: string;
  reason: string;
  sourceToken: string;
  sourceEvent: string;
  independentObservationCount: number;
  confidence: ObservationConfidence;
  firstDiscoveredAt: string;
  lastObservedAt: string;
  idempotencyKey: string;
}

export type ForwardObservationStatus = "VALID_OBSERVATION" | "NO_ROUTE" | "MISSING_OBSERVATION";
export interface ForwardReturnObservation {
  id: string;
  wallet: string;
  transactionSignature: string;
  tokenMint: string;
  windowMs: number;
  status: ForwardObservationStatus;
  entryMarketObservationId: string | null;
  forwardMarketObservationId: string | null;
  followerReturn: number | null;
  sourceEventId?: string | null;
  dataCompleteness?: number;
  providerProvenance?: string | null;
  estimatedNetReturn?: number | null;
  observedAt: string;
  requestedAt?: string | null;
  latenessMs?: number | null;
  idempotencyKey: string;
}

export interface FollowerSourceEvent {
  id: string; sourceWallet: string; sourceTransaction: string; tokenMint: string;
  sourceBlockTime: string | null; sourceObservedAt: string; decisionEvidenceAt: string;
  entryMarketObservationId: string | null; copyabilityEvaluationId: string | null;
  status: "ENTRY_QUOTED" | "NO_ROUTE" | "MISSING_ENTRY" | "HISTORICAL_UNUSABLE";
  sourceEffectiveEntry: string | null; followerQuotedEntry: string | null; routeAvailable: boolean | null;
  quoteRequestedAt: string | null; quoteReceivedAt: string | null; quoteLatencyMs: number | null; priceImpactPct: string | null;
  dataCompleteness: number; providerProvenance: string | null; idempotencyKey: string; createdAt: string;
}

export interface WalletReputationSnapshot {
  id: string;
  wallet: string;
  observedCandidateBuys: number;
  copyableOpportunities: number;
  uncopyableOpportunities: number;
  medianFollowerReturn: number | null;
  followerReturnDistribution: number[];
  medianDeteriorationBps: number | null;
  earlyEntryFrequency: number | null;
  crowdingFrequency: number | null;
  consistency: number | null;
  sampleSize: number;
  dataCompleteness: number;
  provisionalScore: number;
  calculatedAt: string;
  rulesetHash: string;
  validCopyabilityEvaluations?: number;
  noRouteEvents?: number;
  trimmedMeanFollowerReturn?: number | null;
  downsideDistribution?: number[];
  winRate?: number | null;
  lossRate?: number | null;
  maximumObservedFollowerLoss?: number | null;
  medianSignalLatencyMs?: number | null;
  riskGateRejectionFrequency?: number | null;
  independentTokenSampleSize?: number;
  knownCrowdingSampleCount?: number;
  unknownCrowdingSampleCount?: number;
}

export type NotificationCategory = "SHADOW_BUY" | "HIGH_SIGNAL_WALLET" | "TOKEN_RISK_CHANGE" | "SOURCE_WALLET_SELL" | "EXIT_RECOMMENDATION" | "SYSTEM_DEGRADED" | "WATCHER_RECONNECTED" | "WATCHER_GAP_RECOVERED" | "KILL_SWITCH";
export interface NotificationRecord {
  id: string;
  category: NotificationCategory;
  payload: JsonValue;
  provider: string;
  status: "PENDING" | "SENT" | "FAILED" | "DISABLED";
  errorCode: string | null;
  createdAt: string;
  attemptedAt: string | null;
  deliveredAt: string | null;
  idempotencyKey: string;
  attemptCount?: number;
  nextAttemptAt?: string | null;
  responseClass?: "SUCCESS" | "TRANSIENT" | "PERMANENT" | "DISABLED" | null;
}

export interface ProviderBudgetSnapshot {
  provider: string;
  calls: number;
  successfulCalls: number;
  rateLimited: number;
  timeouts: number;
  retries: number;
  queueWaitMs: number;
  averageLatencyMs: number | null;
  inFlight: number;
  queued: number;
  degraded: boolean;
  clientErrors: number;
  serverErrors: number;
  cacheHits: number;
  deduplicatedRequests: number;
  circuitState: "CLOSED" | "OPEN" | "HALF_OPEN";
  health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "DISABLED";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export interface ProviderTelemetrySnapshot {
  provider: "SOLANA_HTTP" | "SOLANA_WS" | "HELIUS" | "JUPITER" | "TELEGRAM" | "OPENROUTER";
  health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "DISABLED";
  callsOrEvents: number | null;
  errors: number | null;
  rateLimited: number | null;
  timeouts: number | null;
  reconnects: number | null;
  retries: number | null;
  averageLatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  detail: string;
}

export type RuntimeJobType = "POSITION_MARK" | "FORWARD_RETURN" | "WALLET_BACKFILL" | "REPUTATION_RECALCULATION" | "TOKEN_RISK_REFRESH" | "EXIT_RECALCULATION" | "NOTIFICATION_RETRY" | "GAP_RECOVERY" | "TOKEN_DISCOVERY_POLL" | "CANDIDATE_EVALUATION" | "RUNTIME_CONTROL";
export type RuntimeJobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface RuntimeJob {
  id: string; type: RuntimeJobType; payload: JsonValue; status: RuntimeJobStatus; runAt: string; createdAt: string;
  startedAt: string | null; completedAt: string | null; attempts: number; maxAttempts: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; lastError: string | null; idempotencyKey: string;
}

export interface WorkerLease {
  role: "SHADOW_RUNTIME"; workerId: string; startedAt: string; heartbeatAt: string; leaseExpiresAt: string;
  status: "STARTING" | "HEALTHY" | "STOPPING"; lastProcessedSlot: bigint | null; activeSubscriptions: number;
  queueDepth: number; revision: string | null;
}

export interface RuntimeSettings {
  key: "PRIMARY";
  watcherEnabled: boolean;
  shadowEntryEnabled: boolean;
  killSwitch: boolean;
  updatedAt: string;
  updatedBy: string;
  revision: number;
}

export interface OperatorLoginBucket {
  clientLabelHash: string;
  windowStartedAt: string;
  attempts: number;
  updatedAt: string;
}

export interface OperatorSession {
  id: string; tokenHash: string; csrfHash: string; createdAt: string; expiresAt: string; revokedAt: string | null;
  lastUsedAt: string | null; clientLabel: string | null;
}

export type OperatorSecurityEventType = "LOGIN_SUCCEEDED" | "LOGIN_FAILED" | "LOGIN_RATE_LIMITED" | "LOGOUT" | "SESSION_REJECTED" | "CSRF_REJECTED" | "OPERATOR_ACTION" | "TELEGRAM_REJECTED" | "TELEGRAM_ACTION";
export interface OperatorSecurityEvent {
  id: string; type: OperatorSecurityEventType; occurredAt: string; sessionId: string | null;
  actor: "DASHBOARD" | "TELEGRAM" | "SYSTEM"; clientLabel: string | null; details: JsonValue;
}

export type TelegramAction = "SELL_SHADOW" | "WAIT" | "RECALCULATE" | "MANUAL_CONTROL" | "SYSTEM_CONTROL";
export interface TelegramInteraction {
  nonceHash: string; positionId: string; action: TelegramAction; expectedPositionState: string; createdAt: string;
  expiresAt: string; consumedAt: string | null; updateId: string | null;
}

export interface TokenDiscovery {
  mint: string; firstPoolCreatedAt: string | null; symbol: string | null; name: string | null; decimals: number | null;
  organicScore: number | null; organicScoreLabel: string | null; provider: "JUPITER_TOKENS_V2";
  provenance: "EXTERNAL_HEURISTIC"; firstObservedAt: string; lastObservedAt: string; providerObservedAt: string;
}

export type CandidateEvaluationState = "DISCOVERED" | "RESEARCH_WATCH" | "EVALUATING" | "TRACK_ELIGIBLE" | "TRACKING" | "PAUSED" | "REJECTED" | "INSUFFICIENT_DATA";
export interface CandidateEvaluation {
  wallet: string; state: CandidateEvaluationState; sampleSize: number; independentTokenCount: number;
  provisionalScore: number | null; evidenceAtEvaluation: JsonValue; reasonCodes: string[]; evaluatedAt: string; rulesetHash: string;
}

export interface ResearchRun {
  id: string; kind: "WALK_FORWARD" | "SOAK"; startedAt: string; completedAt: string | null;
  status: "RUNNING" | "COMPLETED" | "FAILED"; parameters: JsonValue; report: JsonValue | null; errorCode: string | null;
}

export interface ShadowSignalContext {
  tokenIntelligence: TokenIntelligenceSnapshot;
  tokenRisk: TokenRiskEvaluation;
  market: MarketObservation;
  copyability: CopyabilityEvaluation;
  crowding: CrowdingObservation | null;
  legacyRiskSnapshot: TokenRiskSnapshot;
}
