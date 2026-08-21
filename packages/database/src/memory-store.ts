import type {
  ChainTransaction,
  AIAnalysis,
  IntelligenceStore,
  PaperPosition,
  PositionEvent,
  Signal,
  TradeDecision,
  UserAction,
  Wallet,
  WalletMetrics,
  WalletStatus,
  WalletAction,
  MarketObservation,
  CopyabilityEvaluation,
  CrowdingObservation
} from "@intelligence/core";
import type { CandidateDiscovery, ExitRecommendation, ForwardReturnObservation, LiveSubscriptionState, NotificationRecord, PositionMark, ShadowPositionRecord, TokenIntelligenceSnapshot, TokenRiskEvaluation, WalletBackfillRun, WalletReputationSnapshot } from "@intelligence/core";
import { newId } from "@intelligence/shared";

export class InMemoryIntelligenceStore implements IntelligenceStore {
  readonly transactions = new Map<string, ChainTransaction>();
  readonly aiAnalyses: AIAnalysis[] = [];
  readonly decisions: TradeDecision[] = [];
  readonly userActions: UserAction[] = [];
  readonly walletActions = new Map<string, WalletAction>();
  readonly marketObservations = new Map<string, MarketObservation>();
  readonly copyabilityEvaluations = new Map<string, CopyabilityEvaluation>();
  readonly crowdingObservations = new Map<string, CrowdingObservation>();
  readonly backfillRuns: WalletBackfillRun[] = [];
  readonly tokenIntelligenceSnapshots = new Map<string, TokenIntelligenceSnapshot>();
  readonly tokenRiskEvaluations: TokenRiskEvaluation[] = [];
  readonly liveSubscriptionStates = new Map<string, LiveSubscriptionState>();
  readonly shadowPositionRecords = new Map<string, ShadowPositionRecord>();
  readonly positionMarks: PositionMark[] = [];
  readonly exitRecommendations: ExitRecommendation[] = [];
  readonly notifications = new Map<string, NotificationRecord>();
  readonly candidateDiscoveries = new Map<string, CandidateDiscovery>();
  readonly forwardReturnObservations = new Map<string, ForwardReturnObservation>();
  readonly walletReputations = new Map<string, WalletReputationSnapshot>();
  private readonly wallets = new Map<string, Wallet>();
  private readonly metrics = new Map<string, WalletMetrics>();
  private readonly signals = new Map<string, Signal>();
  private readonly signalKeys = new Set<string>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly positionBySignal = new Map<string, string>();
  private readonly events = new Map<string, PositionEvent>();

  async upsertWallet(publicKey: string, now: string): Promise<Wallet> {
    const existing = this.wallets.get(publicKey);
    if (existing !== undefined) return existing;
    const wallet: Wallet = { id: newId(), publicKey, discoveredAt: now, firstObservedAt: null, lastObservedAt: null, status: "candidate", dataConfidence: null, flags: [], notes: null };
    this.wallets.set(publicKey, wallet);
    return wallet;
  }

  async getWallet(publicKey: string): Promise<(Wallet & { metrics: WalletMetrics | null }) | null> {
    const wallet = this.wallets.get(publicKey);
    return wallet === undefined ? null : { ...wallet, metrics: this.metrics.get(wallet.id) ?? null };
  }

  async listWallets(): Promise<Array<Wallet & { metrics: WalletMetrics | null }>> {
    return [...this.wallets.values()].map((wallet) => ({ ...wallet, metrics: this.metrics.get(wallet.id) ?? null }));
  }

  async setWalletStatus(publicKey: string, status: WalletStatus, now: string): Promise<Wallet | null> {
    const wallet = this.wallets.get(publicKey);
    if (wallet === undefined) return null;
    const updated = { ...wallet, status, lastObservedAt: now };
    this.wallets.set(publicKey, updated);
    return updated;
  }
  async upsertWalletMetrics(next: WalletMetrics): Promise<void> { this.metrics.set(next.walletId, next); }
  async insertAIAnalysis(analysis: AIAnalysis): Promise<void> { this.aiAnalyses.push(analysis); }

  async insertTransaction(transaction: ChainTransaction): Promise<"inserted" | "duplicate"> {
    if (this.transactions.has(transaction.signature)) return "duplicate";
    this.transactions.set(transaction.signature, transaction);
    return "inserted";
  }
  async getTransaction(signature: string): Promise<ChainTransaction | null> { return this.transactions.get(signature) ?? null; }
  async insertWalletAction(action: WalletAction): Promise<"inserted" | "duplicate"> {
    const key = `${action.transactionSignature}:${action.wallet}:${action.actionType}`;
    if (this.walletActions.has(key)) return "duplicate";
    this.walletActions.set(key, action);
    return "inserted";
  }
  async listWalletActions(publicKey: string, limit: number): Promise<WalletAction[]> {
    return [...this.walletActions.values()].filter((action) => action.wallet === publicKey).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, limit);
  }
  async listRecentWalletActions(limit: number): Promise<WalletAction[]> { return [...this.walletActions.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, limit); }

  async insertSignal(signal: Signal): Promise<"inserted" | "duplicate"> {
    const key = `${signal.sourceTransactionSignature}:${signal.sourceWallet}:${signal.tokenMint}`;
    if (this.signalKeys.has(key)) return "duplicate";
    this.signalKeys.add(key);
    this.signals.set(signal.id, signal);
    return "inserted";
  }

  async getSignal(id: string): Promise<Signal | null> { return this.signals.get(id) ?? null; }
  async listSignals(): Promise<Signal[]> { return [...this.signals.values()].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)); }
  async insertMarketObservation(observation: MarketObservation): Promise<void> { this.marketObservations.set(observation.id, observation); }
  async getMarketObservation(id: string): Promise<MarketObservation | null> { return this.marketObservations.get(id) ?? null; }
  async insertCopyabilityEvaluation(evaluation: CopyabilityEvaluation): Promise<"inserted" | "duplicate"> {
    if (this.copyabilityEvaluations.has(evaluation.sourceTransactionSignature)) return "duplicate";
    this.copyabilityEvaluations.set(evaluation.sourceTransactionSignature, evaluation);
    return "inserted";
  }
  async getCopyabilityBySourceTransaction(signature: string): Promise<CopyabilityEvaluation | null> { return this.copyabilityEvaluations.get(signature) ?? null; }
  async listRecentCopyability(limit: number): Promise<CopyabilityEvaluation[]> { return [...this.copyabilityEvaluations.values()].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt)).slice(0, limit); }
  async insertCrowdingObservation(observation: CrowdingObservation): Promise<"inserted" | "duplicate"> {
    if (this.crowdingObservations.has(observation.sourceTransactionSignature)) return "duplicate";
    this.crowdingObservations.set(observation.sourceTransactionSignature, observation);
    return "inserted";
  }
  async insertBackfillRun(run: WalletBackfillRun): Promise<void> { this.backfillRuns.push(run); }
  async insertTokenIntelligenceSnapshot(snapshot: TokenIntelligenceSnapshot): Promise<void> { this.tokenIntelligenceSnapshots.set(snapshot.tokenMint, snapshot); }
  async getTokenIntelligenceSnapshot(mint: string): Promise<TokenIntelligenceSnapshot | null> { return this.tokenIntelligenceSnapshots.get(mint) ?? null; }
  async insertTokenRiskEvaluation(evaluation: TokenRiskEvaluation): Promise<void> { this.tokenRiskEvaluations.push(evaluation); }
  async listRecentTokenRiskEvaluations(limit: number): Promise<TokenRiskEvaluation[]> { return [...this.tokenRiskEvaluations].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt)).slice(0, limit); }
  async upsertLiveSubscriptionState(state: LiveSubscriptionState): Promise<void> { this.liveSubscriptionStates.set(state.wallet, state); }
  async getLiveSubscriptionState(wallet: string): Promise<LiveSubscriptionState | null> { return this.liveSubscriptionStates.get(wallet) ?? null; }
  async listLiveSubscriptionStates(): Promise<LiveSubscriptionState[]> { return [...this.liveSubscriptionStates.values()]; }
  async insertShadowPositionRecord(record: ShadowPositionRecord): Promise<void> { this.shadowPositionRecords.set(record.positionId, record); }
  async getShadowPositionRecord(positionId: string): Promise<ShadowPositionRecord | null> { return this.shadowPositionRecords.get(positionId) ?? null; }
  async insertPositionMark(mark: PositionMark): Promise<void> { this.positionMarks.push(mark); }
  async listPositionMarks(positionId: string, limit: number): Promise<PositionMark[]> { return this.positionMarks.filter((mark) => mark.positionId === positionId).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, limit); }
  async insertExitRecommendation(recommendation: ExitRecommendation): Promise<void> { this.exitRecommendations.push(recommendation); }
  async listExitRecommendations(positionId: string, limit: number): Promise<ExitRecommendation[]> { return this.exitRecommendations.filter((item) => item.positionId === positionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  async listPositionEvents(positionId: string, limit: number): Promise<PositionEvent[]> { return [...this.events.values()].filter((event) => event.positionId === positionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  async insertNotification(record: NotificationRecord): Promise<"inserted" | "duplicate"> { if (this.notifications.has(record.idempotencyKey)) return "duplicate"; this.notifications.set(record.idempotencyKey, record); return "inserted"; }
  async updateNotification(record: NotificationRecord): Promise<void> { this.notifications.set(record.idempotencyKey, record); }
  async listNotifications(limit: number): Promise<NotificationRecord[]> { return [...this.notifications.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  async insertCandidateDiscovery(discovery: CandidateDiscovery): Promise<"inserted" | "duplicate"> { if (this.candidateDiscoveries.has(discovery.idempotencyKey)) return "duplicate"; this.candidateDiscoveries.set(discovery.idempotencyKey, discovery); return "inserted"; }
  async listCandidateDiscoveries(wallet: string): Promise<CandidateDiscovery[]> { return [...this.candidateDiscoveries.values()].filter((item) => item.wallet === wallet); }
  async insertForwardReturnObservation(observation: ForwardReturnObservation): Promise<"inserted" | "duplicate"> { if (this.forwardReturnObservations.has(observation.idempotencyKey)) return "duplicate"; this.forwardReturnObservations.set(observation.idempotencyKey, observation); return "inserted"; }
  async listForwardReturnObservations(wallet: string): Promise<ForwardReturnObservation[]> { return [...this.forwardReturnObservations.values()].filter((item) => item.wallet === wallet); }
  async upsertWalletReputation(snapshot: WalletReputationSnapshot): Promise<void> { this.walletReputations.set(snapshot.wallet, snapshot); }
  async insertDecision(decision: TradeDecision): Promise<void> { this.decisions.push(decision); }

  async createPosition(position: PaperPosition): Promise<"inserted" | "duplicate"> {
    if (this.positionBySignal.has(position.signalId)) return "duplicate";
    this.positions.set(position.id, position);
    this.positionBySignal.set(position.signalId, position.id);
    return "inserted";
  }

  async getPosition(id: string): Promise<PaperPosition | null> { return this.positions.get(id) ?? null; }
  async getPositionBySignal(signalId: string): Promise<PaperPosition | null> {
    const id = this.positionBySignal.get(signalId);
    return id === undefined ? null : this.positions.get(id) ?? null;
  }
  async listPositions(): Promise<PaperPosition[]> { return [...this.positions.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt)); }
  async updatePosition(position: PaperPosition): Promise<void> {
    if (!this.positions.has(position.id)) throw new Error("Position not found");
    this.positions.set(position.id, position);
  }
  async appendPositionEvent(event: PositionEvent): Promise<"inserted" | "duplicate"> {
    if (this.events.has(event.idempotencyKey)) return "duplicate";
    this.events.set(event.idempotencyKey, event);
    return "inserted";
  }
  async appendUserAction(action: UserAction): Promise<void> { this.userActions.push(action); }
  async listRecentEvents(limit: number): Promise<PositionEvent[]> { return [...this.events.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
}
