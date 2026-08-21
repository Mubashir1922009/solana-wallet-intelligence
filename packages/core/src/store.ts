import type {
  ChainTransaction,
  AIAnalysis,
  PaperPosition,
  PositionEvent,
  Signal,
  TradeDecision,
  UserAction,
  Wallet,
  WalletMetrics,
  WalletStatus,
  WalletAction
} from "./domain.js";
import type { WalletBackfillRun } from "./domain.js";
import type { CopyabilityEvaluation } from "./copyability.js";
import type { CrowdingObservation } from "./crowding.js";
import type { MarketObservation } from "./market.js";
import type { CandidateDiscovery, CandidateEvaluation, ExitRecommendation, ForwardReturnObservation, LiveSubscriptionState, NotificationRecord, OperatorSecurityEvent, OperatorSession, PositionMark, ResearchRun, RuntimeJob, ShadowPositionRecord, TelegramInteraction, TokenDiscovery, TokenIntelligenceSnapshot, TokenRiskEvaluation, WalletReputationSnapshot, WorkerLease } from "./runtime-domain.js";

export interface IntelligenceStore {
  upsertWallet(publicKey: string, now: string): Promise<Wallet>;
  getWallet(publicKey: string): Promise<(Wallet & { metrics: WalletMetrics | null }) | null>;
  listWallets(): Promise<Array<Wallet & { metrics: WalletMetrics | null }>>;
  setWalletStatus(publicKey: string, status: WalletStatus, now: string): Promise<Wallet | null>;
  upsertWalletMetrics(metrics: WalletMetrics): Promise<void>;
  insertAIAnalysis(analysis: AIAnalysis): Promise<void>;
  insertTransaction(transaction: ChainTransaction): Promise<"inserted" | "duplicate">;
  getTransaction(signature: string): Promise<ChainTransaction | null>;
  insertWalletAction(action: WalletAction): Promise<"inserted" | "duplicate">;
  listWalletActions(publicKey: string, limit: number): Promise<WalletAction[]>;
  listRecentWalletActions(limit: number): Promise<WalletAction[]>;
  insertSignal(signal: Signal): Promise<"inserted" | "duplicate">;
  getSignal(id: string): Promise<Signal | null>;
  listSignals(): Promise<Signal[]>;
  insertMarketObservation(observation: MarketObservation): Promise<void>;
  getMarketObservation(id: string): Promise<MarketObservation | null>;
  insertCopyabilityEvaluation(evaluation: CopyabilityEvaluation): Promise<"inserted" | "duplicate">;
  getCopyabilityBySourceTransaction(signature: string): Promise<CopyabilityEvaluation | null>;
  listRecentCopyability(limit: number): Promise<CopyabilityEvaluation[]>;
  insertCrowdingObservation(observation: CrowdingObservation): Promise<"inserted" | "duplicate">;
  insertBackfillRun(run: WalletBackfillRun): Promise<void>;
  insertTokenIntelligenceSnapshot(snapshot: TokenIntelligenceSnapshot): Promise<void>;
  getTokenIntelligenceSnapshot(mint: string): Promise<TokenIntelligenceSnapshot | null>;
  insertTokenRiskEvaluation(evaluation: TokenRiskEvaluation): Promise<void>;
  listRecentTokenRiskEvaluations(limit: number): Promise<TokenRiskEvaluation[]>;
  upsertLiveSubscriptionState(state: LiveSubscriptionState): Promise<void>;
  getLiveSubscriptionState(wallet: string): Promise<LiveSubscriptionState | null>;
  listLiveSubscriptionStates(): Promise<LiveSubscriptionState[]>;
  insertShadowPositionRecord(record: ShadowPositionRecord): Promise<void>;
  getShadowPositionRecord(positionId: string): Promise<ShadowPositionRecord | null>;
  insertPositionMark(mark: PositionMark): Promise<"inserted" | "duplicate">;
  listPositionMarks(positionId: string, limit: number): Promise<PositionMark[]>;
  insertExitRecommendation(recommendation: ExitRecommendation): Promise<void>;
  listExitRecommendations(positionId: string, limit: number): Promise<ExitRecommendation[]>;
  listPositionEvents(positionId: string, limit: number): Promise<PositionEvent[]>;
  insertNotification(record: NotificationRecord): Promise<"inserted" | "duplicate">;
  updateNotification(record: NotificationRecord): Promise<void>;
  getNotification(id: string): Promise<NotificationRecord | null>;
  listNotifications(limit: number): Promise<NotificationRecord[]>;
  insertCandidateDiscovery(discovery: CandidateDiscovery): Promise<"inserted" | "duplicate">;
  listCandidateDiscoveries(wallet: string): Promise<CandidateDiscovery[]>;
  insertForwardReturnObservation(observation: ForwardReturnObservation): Promise<"inserted" | "duplicate">;
  listForwardReturnObservations(wallet: string): Promise<ForwardReturnObservation[]>;
  upsertWalletReputation(snapshot: WalletReputationSnapshot): Promise<void>;
  getWalletReputation(wallet: string): Promise<WalletReputationSnapshot | null>;
  insertDecision(decision: TradeDecision): Promise<void>;
  createPosition(position: PaperPosition): Promise<"inserted" | "duplicate">;
  getPosition(id: string): Promise<PaperPosition | null>;
  getPositionBySignal(signalId: string): Promise<PaperPosition | null>;
  listPositions(): Promise<PaperPosition[]>;
  updatePosition(position: PaperPosition): Promise<void>;
  appendPositionEvent(event: PositionEvent): Promise<"inserted" | "duplicate">;
  appendUserAction(action: UserAction): Promise<void>;
  listRecentEvents(limit: number): Promise<PositionEvent[]>;
  enqueueRuntimeJob(job: RuntimeJob): Promise<"inserted" | "duplicate">;
  claimRuntimeJobs(workerId: string, now: string, leaseExpiresAt: string, limit: number): Promise<RuntimeJob[]>;
  completeRuntimeJob(id: string, workerId: string, completedAt: string): Promise<boolean>;
  failRuntimeJob(id: string, workerId: string, now: string, retryAt: string, errorCode: string): Promise<RuntimeJob | null>;
  listRuntimeJobs(limit: number): Promise<RuntimeJob[]>;
  countPendingRuntimeJobs(now: string): Promise<number>;
  acquireWorkerLease(lease: WorkerLease, now: string): Promise<boolean>;
  heartbeatWorkerLease(lease: WorkerLease): Promise<boolean>;
  releaseWorkerLease(workerId: string, now: string): Promise<void>;
  getWorkerLease(): Promise<WorkerLease | null>;
  createOperatorSession(session: OperatorSession): Promise<void>;
  getOperatorSessionByTokenHash(tokenHash: string): Promise<OperatorSession | null>;
  touchOperatorSession(id: string, at: string): Promise<void>;
  revokeOperatorSession(id: string, at: string): Promise<void>;
  countActiveOperatorSessions(now: string): Promise<number>;
  insertOperatorSecurityEvent(event: OperatorSecurityEvent): Promise<void>;
  listOperatorSecurityEvents(limit: number): Promise<OperatorSecurityEvent[]>;
  createTelegramInteraction(interaction: TelegramInteraction): Promise<"inserted" | "duplicate">;
  consumeTelegramInteraction(nonceHash: string, updateId: string, now: string): Promise<TelegramInteraction | null>;
  upsertTokenDiscovery(discovery: TokenDiscovery): Promise<"inserted" | "updated">;
  listTokenDiscoveries(limit: number): Promise<TokenDiscovery[]>;
  upsertCandidateEvaluation(evaluation: CandidateEvaluation): Promise<void>;
  getCandidateEvaluation(wallet: string): Promise<CandidateEvaluation | null>;
  listCandidateEvaluations(limit: number): Promise<CandidateEvaluation[]>;
  insertResearchRun(run: ResearchRun): Promise<void>;
  updateResearchRun(run: ResearchRun): Promise<void>;
  listResearchRuns(limit: number): Promise<ResearchRun[]>;
}
