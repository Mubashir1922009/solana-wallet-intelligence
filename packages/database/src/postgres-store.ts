import { and, count, desc, eq, gt, inArray, isNull, like, lt, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AIAnalysis, CandidateDiscovery, CandidateEvaluation, ChainTransaction, CopyabilityEvaluation, CrowdingObservation, ExitRecommendation, FollowerSourceEvent, ForwardReturnObservation, IntelligenceStore, LiveSubscriptionState, MarketObservation, NotificationRecord, OperatorLoginBucket, OperatorSecurityEvent, OperatorSession, PaperPosition, PositionEvent, PositionMark, ResearchRun, RuntimeJob, RuntimeSettings, ShadowPositionContext, ShadowPositionRecord, Signal, TelegramInteraction, TokenConcentrationObservation, TokenDiscovery, TokenIntelligenceSnapshot, TokenMintObservation, TokenRiskEvaluation, TradeDecision, UserAction, Wallet, WalletAction, WalletBackfillRun, WalletMetrics, WalletReputationSnapshot, WalletStatus, WorkerLease } from "@intelligence/core";
import { newId } from "@intelligence/shared";
import { aiAnalyses, candidateDiscoveries, candidateEvaluations, chainTransactions, copyabilityEvaluations, crowdingObservations, exitRecommendations, followerSourceEvents, forwardReturnObservations, liveSubscriptionState, marketObservations, notifications, operatorLoginBuckets, operatorSecurityEvents, operatorSessions, paperPositions, positionEvents, positionMarks, researchRuns, runtimeJobs, runtimeSettings, shadowPositionRecords, signals, telegramInteractions, tokenDiscoveries, tokenIntelligenceSnapshots, tokenLargestAccounts, tokenRiskEvaluations, tradeDecisions, transactionWallets, userActions, walletActions, walletBackfillRuns, walletMetrics, walletReputationSnapshots, wallets, workerLeases } from "./schema.js";

type Database = ReturnType<typeof drizzle>;

export class PostgresIntelligenceStore implements IntelligenceStore {
  constructor(private readonly db: Database) {}

  async upsertWallet(publicKey: string, now: string): Promise<Wallet> {
    const [row] = await this.db.insert(wallets).values({ id: newId(), publicKey, discoveredAt: now, status: "candidate", flags: [] }).onConflictDoNothing({ target: wallets.publicKey }).returning();
    if (row !== undefined) return row;
    const existing = await this.getWallet(publicKey);
    if (existing === null) throw new Error("Wallet upsert failed");
    return existing;
  }

  async getWallet(publicKey: string): Promise<(Wallet & { metrics: WalletMetrics | null }) | null> {
    const [result] = await this.db.select({ wallet: wallets, metrics: walletMetrics }).from(wallets).leftJoin(walletMetrics, eq(wallets.id, walletMetrics.walletId)).where(eq(wallets.publicKey, publicKey)).limit(1);
    return result === undefined ? null : { ...result.wallet, metrics: result.metrics };
  }
  async listWallets(): Promise<Array<Wallet & { metrics: WalletMetrics | null }>> {
    const rows = await this.db.select({ wallet: wallets, metrics: walletMetrics }).from(wallets).leftJoin(walletMetrics, eq(wallets.id, walletMetrics.walletId)).orderBy(desc(wallets.discoveredAt));
    return rows.map((row) => ({ ...row.wallet, metrics: row.metrics }));
  }
  async setWalletStatus(publicKey: string, status: WalletStatus, now: string): Promise<Wallet | null> {
    const [row] = await this.db.update(wallets).set({ status, lastObservedAt: now }).where(eq(wallets.publicKey, publicKey)).returning();
    return row ?? null;
  }
  async upsertWalletMetrics(metrics: WalletMetrics): Promise<void> {
    await this.db.insert(walletMetrics).values(metrics).onConflictDoUpdate({ target: walletMetrics.walletId, set: metrics });
  }
  async insertAIAnalysis(analysis: AIAnalysis): Promise<void> { await this.db.insert(aiAnalyses).values(analysis); }
  async insertTransaction(transaction: ChainTransaction): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.transaction(async (tx) => {
      const inserted = await tx.insert(chainTransactions).values({
        signature: transaction.signature, slot: transaction.slot, blockTime: transaction.blockTime, status: transaction.status,
        feeLamports: transaction.feeLamports, provider: transaction.provider, rawPayload: transaction.rawPayload,
        observedAt: transaction.observedAt, providerReceivedAt: transaction.providerReceivedAt,
        normalizationCompletedAt: transaction.normalizationCompletedAt, ingestionLatencyMs: transaction.ingestionLatencyMs
      }).onConflictDoNothing({ target: chainTransactions.signature }).returning({ signature: chainTransactions.signature });
      if (inserted.length > 0 && transaction.relevantWallets.length > 0) {
        await tx.insert(transactionWallets).values(transaction.relevantWallets.map((publicKey) => ({ signature: transaction.signature, publicKey }))).onConflictDoNothing();
      }
      return inserted;
    });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async getTransaction(signature: string): Promise<ChainTransaction | null> {
    const [row] = await this.db.select().from(chainTransactions).where(eq(chainTransactions.signature, signature)).limit(1);
    if (row === undefined) return null;
    const related = await this.db.select().from(transactionWallets).where(eq(transactionWallets.signature, signature));
    return { ...row, status: row.status as ChainTransaction["status"], relevantWallets: related.map((item) => item.publicKey), tokenBalanceDeltas: [], nativeBalanceDeltas: [] };
  }
  async insertWalletAction(action: WalletAction): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(walletActions).values({
      ...action, inputRawAmount: action.inputRawAmount?.toString() ?? null, outputRawAmount: action.outputRawAmount?.toString() ?? null
    }).onConflictDoNothing({ target: [walletActions.transactionSignature, walletActions.wallet, walletActions.actionType] }).returning({ id: walletActions.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async listWalletActions(publicKey: string, limit: number): Promise<WalletAction[]> {
    const rows = await this.db.select().from(walletActions).where(eq(walletActions.wallet, publicKey)).orderBy(desc(walletActions.observedAt)).limit(limit);
    return rows.map((row) => this.mapWalletAction(row));
  }
  async listRecentWalletActions(limit: number): Promise<WalletAction[]> {
    const rows = await this.db.select().from(walletActions).orderBy(desc(walletActions.observedAt)).limit(limit);
    return rows.map((row) => this.mapWalletAction(row));
  }
  private mapWalletAction(row: typeof walletActions.$inferSelect): WalletAction {
    return {
      ...row, actionType: row.actionType as WalletAction["actionType"], classification: row.classification as WalletAction["classification"],
      classificationConfidence: row.classificationConfidence as WalletAction["classificationConfidence"], ambiguityReasons: row.ambiguityReasons as WalletAction["ambiguityReasons"],
      inputRawAmount: row.inputRawAmount === null ? null : BigInt(row.inputRawAmount), outputRawAmount: row.outputRawAmount === null ? null : BigInt(row.outputRawAmount)
    };
  }
  async insertSignal(signal: Signal): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(signals).values(signal).onConflictDoNothing({ target: [signals.sourceTransactionSignature, signals.sourceWallet, signals.tokenMint] }).returning({ id: signals.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async getSignal(id: string): Promise<Signal | null> { const [row] = await this.db.select().from(signals).where(eq(signals.id, id)).limit(1); return row ?? null; }
  async listSignals(): Promise<Signal[]> { return await this.db.select().from(signals).orderBy(desc(signals.detectedAt)); }
  async insertMarketObservation(observation: MarketObservation): Promise<void> {
    await this.db.insert(marketObservations).values({ ...observation, inputRawAmount: observation.inputRawAmount.toString(), outputRawAmount: observation.outputRawAmount?.toString() ?? null, otherAmountThresholdRaw: observation.otherAmountThresholdRaw?.toString() ?? null });
  }
  async getMarketObservation(id: string): Promise<MarketObservation | null> {
    const [row] = await this.db.select().from(marketObservations).where(eq(marketObservations.id, id)).limit(1);
    return row === undefined ? null : { ...row, provenance: row.provenance as MarketObservation["provenance"], inputRawAmount: BigInt(row.inputRawAmount), outputRawAmount: row.outputRawAmount === null ? null : BigInt(row.outputRawAmount), otherAmountThresholdRaw: row.otherAmountThresholdRaw === null ? null : BigInt(row.otherAmountThresholdRaw), transactionIncluded: false };
  }
  async insertCopyabilityEvaluation(evaluation: CopyabilityEvaluation): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(copyabilityEvaluations).values(evaluation).onConflictDoNothing({ target: copyabilityEvaluations.sourceTransactionSignature }).returning({ id: copyabilityEvaluations.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  private mapCopyability(row: typeof copyabilityEvaluations.$inferSelect): CopyabilityEvaluation {
    return { ...row, status: row.status as CopyabilityEvaluation["status"], confidence: row.confidence as CopyabilityEvaluation["confidence"], reasons: row.reasons as CopyabilityEvaluation["reasons"] };
  }
  async getCopyabilityBySourceTransaction(signature: string): Promise<CopyabilityEvaluation | null> {
    const [row] = await this.db.select().from(copyabilityEvaluations).where(eq(copyabilityEvaluations.sourceTransactionSignature, signature)).limit(1);
    return row === undefined ? null : this.mapCopyability(row);
  }
  async listRecentCopyability(limit: number): Promise<CopyabilityEvaluation[]> {
    const rows = await this.db.select().from(copyabilityEvaluations).orderBy(desc(copyabilityEvaluations.evaluatedAt)).limit(limit);
    return rows.map((row) => this.mapCopyability(row));
  }
  async insertCrowdingObservation(observation: CrowdingObservation): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(crowdingObservations).values({ ...observation, observedInputVolumeRaw: observation.observedInputVolumeRaw?.toString() ?? null }).onConflictDoNothing({ target: crowdingObservations.sourceTransactionSignature }).returning({ id: crowdingObservations.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async listCrowdingObservations(sourceTransactionSignatures: string[]): Promise<CrowdingObservation[]> { if (sourceTransactionSignatures.length === 0) return []; const rows = await this.db.select().from(crowdingObservations).where(inArray(crowdingObservations.sourceTransactionSignature, sourceTransactionSignatures)); return rows.map((row) => ({ ...row, windows: row.windows as CrowdingObservation["windows"], observedInputVolumeRaw: row.observedInputVolumeRaw === null ? null : BigInt(row.observedInputVolumeRaw), confidence: row.confidence as CrowdingObservation["confidence"], status: row.status as CrowdingObservation["status"] })); }
  async insertBackfillRun(run: WalletBackfillRun): Promise<void> { await this.db.insert(walletBackfillRuns).values(run); }
  async getLatestBackfillRun(wallet: string): Promise<WalletBackfillRun | null> { const [row] = await this.db.select().from(walletBackfillRuns).where(eq(walletBackfillRuns.wallet, wallet)).orderBy(desc(walletBackfillRuns.updatedAt)).limit(1); return row === undefined ? null : { ...row, failures: row.failures as WalletBackfillRun["failures"], completenessState: row.completenessState as WalletBackfillRun["completenessState"] }; }
  async insertTokenIntelligenceSnapshot(snapshot: TokenIntelligenceSnapshot): Promise<void> {
    const mintObservation = serializeBigInts(snapshot.mint) as TokenMintObservation;
    const concentration = serializeBigInts(snapshot.concentration) as TokenConcentrationObservation;
    await this.db.transaction(async (tx) => {
      await tx.insert(tokenIntelligenceSnapshots).values({
        id: snapshot.id, tokenMint: snapshot.tokenMint, rawSupply: snapshot.supply?.rawSupply.toString() ?? null,
        decimals: snapshot.supply?.decimals ?? null, supplySlot: snapshot.supply?.slot ?? null, mintObservation,
        concentration, confidence: snapshot.confidence, completeness: snapshot.completeness, reasons: snapshot.reasons, observedAt: snapshot.observedAt
      });
      if (snapshot.largestAccounts.length > 0) {
        await tx.insert(tokenLargestAccounts).values(snapshot.largestAccounts.map((account) => ({
          id: newId(), snapshotId: snapshot.id, tokenAccount: account.tokenAccount, rawBalance: account.rawBalance.toString(), decimals: account.decimals,
          percentageOfSupply: account.percentageOfSupply, resolvedOwner: account.resolvedOwner, ownerClassification: account.ownerClassification,
          slot: account.slot, observedAt: account.observedAt, provenance: account.provenance
        })));
      }
    });
  }
  async getTokenIntelligenceSnapshot(mint: string): Promise<TokenIntelligenceSnapshot | null> {
    const [row] = await this.db.select().from(tokenIntelligenceSnapshots).where(eq(tokenIntelligenceSnapshots.tokenMint, mint)).orderBy(desc(tokenIntelligenceSnapshots.observedAt)).limit(1);
    if (row === undefined) return null;
    const accounts = await this.db.select().from(tokenLargestAccounts).where(eq(tokenLargestAccounts.snapshotId, row.id));
    const mintObservation = reviveMint(row.mintObservation);
    const concentration = reviveConcentration(row.concentration);
    return {
      id: row.id, tokenMint: row.tokenMint,
      supply: row.rawSupply === null || row.decimals === null || row.supplySlot === null ? null : { rawSupply: BigInt(row.rawSupply), decimals: row.decimals, slot: row.supplySlot, observedAt: row.observedAt, provenance: "SOLANA_GET_TOKEN_SUPPLY" },
      mint: mintObservation,
      largestAccounts: accounts.map((account) => ({ ...account, rawBalance: BigInt(account.rawBalance), ownerClassification: "UNKNOWN", provenance: "SOLANA_GET_TOKEN_LARGEST_ACCOUNTS" })),
      concentration, confidence: row.confidence as TokenIntelligenceSnapshot["confidence"], completeness: row.completeness, reasons: row.reasons, observedAt: row.observedAt
    };
  }
  async insertTokenRiskEvaluation(evaluation: TokenRiskEvaluation): Promise<void> { await this.db.insert(tokenRiskEvaluations).values(evaluation); }
  async listRecentTokenRiskEvaluations(limit: number): Promise<TokenRiskEvaluation[]> {
    const rows = await this.db.select().from(tokenRiskEvaluations).orderBy(desc(tokenRiskEvaluations.evaluatedAt)).limit(limit);
    return rows.map((row) => ({ ...row, confidence: row.confidence as TokenRiskEvaluation["confidence"], components: row.components }));
  }
  async upsertLiveSubscriptionState(state: LiveSubscriptionState): Promise<void> {
    await this.db.insert(liveSubscriptionState).values(state).onConflictDoUpdate({ target: liveSubscriptionState.wallet, set: state });
  }
  async getLiveSubscriptionState(wallet: string): Promise<LiveSubscriptionState | null> {
    const [row] = await this.db.select().from(liveSubscriptionState).where(eq(liveSubscriptionState.wallet, wallet)).limit(1);
    return row === undefined ? null : { ...row, lifecycle: row.lifecycle as LiveSubscriptionState["lifecycle"] };
  }
  async listLiveSubscriptionStates(): Promise<LiveSubscriptionState[]> {
    const rows = await this.db.select().from(liveSubscriptionState).orderBy(desc(liveSubscriptionState.priority));
    return rows.map((row) => ({ ...row, lifecycle: row.lifecycle as LiveSubscriptionState["lifecycle"] }));
  }
  async insertShadowPositionRecord(record: ShadowPositionRecord): Promise<void> {
    await this.db.insert(shadowPositionRecords).values({ ...record, context: serializeBigInts(record.context) as ShadowPositionContext });
  }
  async getShadowPositionRecord(positionId: string): Promise<ShadowPositionRecord | null> {
    const [row] = await this.db.select().from(shadowPositionRecords).where(eq(shadowPositionRecords.positionId, positionId)).limit(1);
    return row === undefined ? null : { ...row, context: reviveShadowContext(row.context) };
  }
  async insertPositionMark(mark: PositionMark): Promise<"inserted" | "duplicate"> { const rows = await this.db.insert(positionMarks).values(mark).onConflictDoNothing({ target: positionMarks.id }).returning({ id: positionMarks.id }); return rows.length === 0 ? "duplicate" : "inserted"; }
  async listPositionMarks(positionId: string, limit: number): Promise<PositionMark[]> {
    const rows = await this.db.select().from(positionMarks).where(eq(positionMarks.positionId, positionId)).orderBy(desc(positionMarks.observedAt)).limit(limit);
    return rows.map((row) => ({ ...row, confidence: row.confidence as PositionMark["confidence"], provenance: row.provenance as PositionMark["provenance"] }));
  }
  async insertExitRecommendation(recommendation: ExitRecommendation): Promise<void> { await this.db.insert(exitRecommendations).values(recommendation); }
  async listExitRecommendations(positionId: string, limit: number): Promise<ExitRecommendation[]> {
    const rows = await this.db.select().from(exitRecommendations).where(eq(exitRecommendations.positionId, positionId)).orderBy(desc(exitRecommendations.createdAt)).limit(limit);
    return rows.map((row) => ({ ...row, recommendation: row.recommendation as ExitRecommendation["recommendation"], confidence: row.confidence as ExitRecommendation["confidence"] }));
  }
  async listPositionEvents(positionId: string, limit: number): Promise<PositionEvent[]> {
    const rows = await this.db.select().from(positionEvents).where(eq(positionEvents.positionId, positionId)).orderBy(desc(positionEvents.createdAt)).limit(limit);
    return rows.map((row) => ({ ...row, type: row.type as PositionEvent["type"] }));
  }
  async insertNotification(record: NotificationRecord): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(notifications).values({ ...record, type: record.category }).onConflictDoNothing({ target: notifications.idempotencyKey }).returning({ id: notifications.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async updateNotification(record: NotificationRecord): Promise<void> {
    await this.db.update(notifications).set({ type: record.category, payload: record.payload, provider: record.provider, status: record.status, errorCode: record.errorCode, attemptedAt: record.attemptedAt, deliveredAt: record.deliveredAt, attemptCount: record.attemptCount, nextAttemptAt: record.nextAttemptAt, responseClass: record.responseClass }).where(eq(notifications.id, record.id));
  }
  async getNotification(id: string): Promise<NotificationRecord | null> { const [row] = await this.db.select().from(notifications).where(eq(notifications.id, id)).limit(1); return row === undefined ? null : this.mapNotification(row); }
  async listNotifications(limit: number): Promise<NotificationRecord[]> {
    const rows = await this.db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
    return rows.map((row) => this.mapNotification(row));
  }
  private mapNotification(row: typeof notifications.$inferSelect): NotificationRecord { return { id: row.id, category: row.type as NotificationRecord["category"], payload: row.payload, provider: row.provider, status: row.status as NotificationRecord["status"], errorCode: row.errorCode, createdAt: isoTimestamp(row.createdAt), attemptedAt: nullableIsoTimestamp(row.attemptedAt), deliveredAt: nullableIsoTimestamp(row.deliveredAt), idempotencyKey: row.idempotencyKey ?? row.id, attemptCount: row.attemptCount, nextAttemptAt: nullableIsoTimestamp(row.nextAttemptAt), responseClass: row.responseClass as "SUCCESS" | "TRANSIENT" | "PERMANENT" | "DISABLED" | null }; }
  async insertCandidateDiscovery(discovery: CandidateDiscovery): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(candidateDiscoveries).values(discovery).onConflictDoNothing({ target: candidateDiscoveries.idempotencyKey }).returning({ id: candidateDiscoveries.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async listCandidateDiscoveries(wallet: string): Promise<CandidateDiscovery[]> {
    const rows = await this.db.select().from(candidateDiscoveries).where(eq(candidateDiscoveries.wallet, wallet)).orderBy(desc(candidateDiscoveries.lastObservedAt));
    return rows.map((row) => ({ ...row, confidence: row.confidence as CandidateDiscovery["confidence"] }));
  }
  async insertForwardReturnObservation(observation: ForwardReturnObservation): Promise<"inserted" | "duplicate"> {
    const rows = await this.db.insert(forwardReturnObservations).values(observation).onConflictDoNothing({ target: forwardReturnObservations.idempotencyKey }).returning({ id: forwardReturnObservations.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  async listForwardReturnObservations(wallet: string): Promise<ForwardReturnObservation[]> {
    const rows = await this.db.select().from(forwardReturnObservations).where(eq(forwardReturnObservations.wallet, wallet)).orderBy(desc(forwardReturnObservations.observedAt));
    return rows.map((row) => ({ ...row, observedAt: isoTimestamp(row.observedAt), requestedAt: nullableIsoTimestamp(row.requestedAt), status: row.status as ForwardReturnObservation["status"] }));
  }
  async insertFollowerSourceEvent(event: FollowerSourceEvent): Promise<"inserted" | "duplicate"> { const rows = await this.db.insert(followerSourceEvents).values(event).onConflictDoNothing({ target: followerSourceEvents.idempotencyKey }).returning({ id: followerSourceEvents.id }); return rows.length === 0 ? "duplicate" : "inserted"; }
  async getFollowerSourceEventByTransaction(signature: string): Promise<FollowerSourceEvent | null> { const [row] = await this.db.select().from(followerSourceEvents).where(eq(followerSourceEvents.sourceTransaction, signature)).limit(1); return row ?? null; }
  async listFollowerSourceEvents(wallet: string): Promise<FollowerSourceEvent[]> { return this.db.select().from(followerSourceEvents).where(eq(followerSourceEvents.sourceWallet, wallet)).orderBy(desc(followerSourceEvents.sourceObservedAt)); }
  async upsertWalletReputation(snapshot: WalletReputationSnapshot): Promise<void> {
    await this.db.insert(walletReputationSnapshots).values({ id: snapshot.id, wallet: snapshot.wallet, snapshot, calculatedAt: snapshot.calculatedAt }).onConflictDoUpdate({ target: walletReputationSnapshots.wallet, set: { id: snapshot.id, snapshot, calculatedAt: snapshot.calculatedAt } });
  }
  async getWalletReputation(wallet: string): Promise<WalletReputationSnapshot | null> { const [row] = await this.db.select().from(walletReputationSnapshots).where(eq(walletReputationSnapshots.wallet, wallet)).limit(1); return row?.snapshot ?? null; }
  async insertDecision(decision: TradeDecision): Promise<void> { await this.db.insert(tradeDecisions).values(decision); }
  async createPosition(position: PaperPosition): Promise<"inserted" | "duplicate"> {
    const entryMarketSnapshot = { ...position.entryMarketSnapshot, expectedOutputRaw: position.entryMarketSnapshot.expectedOutputRaw?.toString() ?? null } as unknown as PaperPosition["entryMarketSnapshot"];
    const rows = await this.db.insert(paperPositions).values({ ...position, entryMarketSnapshot, tokenRawAmount: position.tokenRawAmount.toString() }).onConflictDoNothing({ target: paperPositions.signalId }).returning({ id: paperPositions.id });
    return rows.length === 0 ? "duplicate" : "inserted";
  }
  private mapPosition(row: typeof paperPositions.$inferSelect): PaperPosition {
    const expected = row.entryMarketSnapshot.expectedOutputRaw;
    return { ...row, tokenRawAmount: BigInt(row.tokenRawAmount), entryMarketSnapshot: { ...row.entryMarketSnapshot, expectedOutputRaw: expected === null ? null : BigInt(String(expected)) } };
  }
  async getPosition(id: string): Promise<PaperPosition | null> { const [row] = await this.db.select().from(paperPositions).where(eq(paperPositions.id, id)).limit(1); return row === undefined ? null : this.mapPosition(row); }
  async getPositionBySignal(signalId: string): Promise<PaperPosition | null> { const [row] = await this.db.select().from(paperPositions).where(eq(paperPositions.signalId, signalId)).limit(1); return row === undefined ? null : this.mapPosition(row); }
  async listPositions(): Promise<PaperPosition[]> { const rows = await this.db.select().from(paperPositions).orderBy(desc(paperPositions.openedAt)); return rows.map((row) => this.mapPosition(row)); }
  async updatePosition(position: PaperPosition): Promise<void> {
    const entryMarketSnapshot = { ...position.entryMarketSnapshot, expectedOutputRaw: position.entryMarketSnapshot.expectedOutputRaw?.toString() ?? null } as unknown as PaperPosition["entryMarketSnapshot"];
    await this.db.update(paperPositions).set({ ...position, entryMarketSnapshot, tokenRawAmount: position.tokenRawAmount.toString() }).where(eq(paperPositions.id, position.id));
  }
  async appendPositionEvent(event: PositionEvent): Promise<"inserted" | "duplicate"> { const rows = await this.db.insert(positionEvents).values(event).onConflictDoNothing({ target: positionEvents.idempotencyKey }).returning({ id: positionEvents.id }); return rows.length === 0 ? "duplicate" : "inserted"; }
  async appendUserAction(action: UserAction): Promise<void> { await this.db.insert(userActions).values(action); }
  async listRecentEvents(limit: number): Promise<PositionEvent[]> {
    const rows = await this.db.select().from(positionEvents).orderBy(desc(positionEvents.createdAt)).limit(limit);
    return rows.map((row) => ({ ...row, type: row.type as PositionEvent["type"] }));
  }
  async enqueueRuntimeJob(job: RuntimeJob): Promise<"inserted" | "duplicate"> { const rows = await this.db.insert(runtimeJobs).values(job).onConflictDoNothing({ target: runtimeJobs.idempotencyKey }).returning({ id: runtimeJobs.id }); return rows.length === 0 ? "duplicate" : "inserted"; }
  async claimRuntimeJobs(workerId: string, now: string, leaseExpiresAt: string, limit: number, idempotencyKeyPrefix?: string): Promise<RuntimeJob[]> {
    return await this.db.transaction(async (tx) => {
      const eligible = await tx.select().from(runtimeJobs).where(and(lt(runtimeJobs.attempts, runtimeJobs.maxAttempts), idempotencyKeyPrefix === undefined ? undefined : like(runtimeJobs.idempotencyKey, `${idempotencyKeyPrefix}%`), or(and(eq(runtimeJobs.status, "PENDING"), lte(runtimeJobs.runAt, now)), and(eq(runtimeJobs.status, "RUNNING"), lte(runtimeJobs.leaseExpiresAt, now))))).orderBy(runtimeJobs.runAt).limit(limit).for("update", { skipLocked: true });
      if (eligible.length === 0) return [];
      const rows = await tx.update(runtimeJobs).set({ status: "RUNNING", leaseOwner: workerId, leaseExpiresAt, startedAt: now, attempts: sql`${runtimeJobs.attempts} + 1` }).where(inArray(runtimeJobs.id, eligible.map((job) => job.id))).returning();
      return rows.map((row) => this.mapRuntimeJob(row));
    });
  }
  async completeRuntimeJob(id: string, workerId: string, completedAt: string): Promise<boolean> { const rows = await this.db.update(runtimeJobs).set({ status: "COMPLETED", completedAt, leaseOwner: null, leaseExpiresAt: null }).where(and(eq(runtimeJobs.id, id), eq(runtimeJobs.status, "RUNNING"), eq(runtimeJobs.leaseOwner, workerId))).returning({ id: runtimeJobs.id }); return rows.length > 0; }
  async failRuntimeJob(id: string, workerId: string, now: string, retryAt: string, errorCode: string): Promise<RuntimeJob | null> {
    return await this.db.transaction(async (tx) => { const [job] = await tx.select().from(runtimeJobs).where(and(eq(runtimeJobs.id, id), eq(runtimeJobs.status, "RUNNING"), eq(runtimeJobs.leaseOwner, workerId))).limit(1).for("update"); if (job === undefined) return null; const terminal = job.attempts >= job.maxAttempts; const [row] = await tx.update(runtimeJobs).set({ status: terminal ? "FAILED" : "PENDING", runAt: terminal ? job.runAt : retryAt, completedAt: terminal ? now : null, leaseOwner: null, leaseExpiresAt: null, lastError: errorCode }).where(eq(runtimeJobs.id, id)).returning(); return row === undefined ? null : this.mapRuntimeJob(row); });
  }
  async listRuntimeJobs(limit: number): Promise<RuntimeJob[]> { return (await this.db.select().from(runtimeJobs).orderBy(desc(runtimeJobs.createdAt)).limit(limit)).map((row) => this.mapRuntimeJob(row)); }
  async countPendingRuntimeJobs(now: string): Promise<number> { const [row] = await this.db.select({ value: count() }).from(runtimeJobs).where(or(and(eq(runtimeJobs.status, "PENDING"), lte(runtimeJobs.runAt, now)), and(eq(runtimeJobs.status, "RUNNING"), lte(runtimeJobs.leaseExpiresAt, now)))); return row?.value ?? 0; }
  private mapRuntimeJob(row: typeof runtimeJobs.$inferSelect): RuntimeJob { return { ...row, runAt: isoTimestamp(row.runAt), createdAt: isoTimestamp(row.createdAt), startedAt: nullableIsoTimestamp(row.startedAt), completedAt: nullableIsoTimestamp(row.completedAt), leaseExpiresAt: nullableIsoTimestamp(row.leaseExpiresAt), type: row.type as RuntimeJob["type"], status: row.status as RuntimeJob["status"] }; }
  async acquireWorkerLease(lease: WorkerLease, now: string): Promise<boolean> { return await this.db.transaction(async (tx) => { await tx.insert(workerLeases).values(lease).onConflictDoNothing({ target: workerLeases.role }); const [current] = await tx.select().from(workerLeases).where(eq(workerLeases.role, lease.role)).limit(1).for("update"); if (current === undefined || (current.workerId !== lease.workerId && Date.parse(current.leaseExpiresAt) > Date.parse(now))) return false; await tx.update(workerLeases).set(lease).where(eq(workerLeases.role, lease.role)); return true; }); }
  async heartbeatWorkerLease(lease: WorkerLease): Promise<boolean> { const rows = await this.db.update(workerLeases).set(lease).where(and(eq(workerLeases.role, lease.role), eq(workerLeases.workerId, lease.workerId))).returning({ role: workerLeases.role }); return rows.length > 0; }
  async releaseWorkerLease(workerId: string, now: string): Promise<void> { await this.db.update(workerLeases).set({ status: "STOPPING", heartbeatAt: now, leaseExpiresAt: now }).where(eq(workerLeases.workerId, workerId)); }
  async getWorkerLease(): Promise<WorkerLease | null> { const [row] = await this.db.select().from(workerLeases).where(eq(workerLeases.role, "SHADOW_RUNTIME")).limit(1); return row === undefined ? null : { ...row, startedAt: isoTimestamp(row.startedAt), heartbeatAt: isoTimestamp(row.heartbeatAt), leaseExpiresAt: isoTimestamp(row.leaseExpiresAt), role: "SHADOW_RUNTIME", status: row.status as WorkerLease["status"] }; }
  async getRuntimeSettings(): Promise<RuntimeSettings> { const [row] = await this.db.select().from(runtimeSettings).where(eq(runtimeSettings.key, "PRIMARY")).limit(1); if (row === undefined) throw new Error("Authoritative runtime settings are missing"); return { ...row, updatedAt: isoTimestamp(row.updatedAt), key: "PRIMARY" }; }
  async updateRuntimeSettings(settings: RuntimeSettings): Promise<boolean> { const rows = await this.db.update(runtimeSettings).set({ watcherEnabled: settings.watcherEnabled, shadowEntryEnabled: settings.shadowEntryEnabled, killSwitch: settings.killSwitch, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy, revision: settings.revision }).where(and(eq(runtimeSettings.key, "PRIMARY"), eq(runtimeSettings.revision, settings.revision - 1))).returning({ key: runtimeSettings.key }); return rows.length === 1; }
  async consumeOperatorLoginAttempt(clientLabelHash: string, now: string, windowStartedAt: string, maximumAttempts: number): Promise<{ allowed: boolean; bucket: OperatorLoginBucket }> { const rows = await this.db.execute(sql`insert into operator_login_buckets (client_label_hash, window_started_at, attempts, updated_at) values (${clientLabelHash}, ${now}, 1, ${now}) on conflict (client_label_hash) do update set attempts = case when operator_login_buckets.window_started_at < ${windowStartedAt} then 1 else operator_login_buckets.attempts + 1 end, window_started_at = case when operator_login_buckets.window_started_at < ${windowStartedAt} then ${now}::timestamptz else operator_login_buckets.window_started_at end, updated_at = ${now}::timestamptz returning client_label_hash, window_started_at, attempts, updated_at`); const row = rows[0] as { client_label_hash: string; window_started_at: string | Date; attempts: number; updated_at: string | Date } | undefined; if (row === undefined) throw new Error("Login attempt persistence failed"); const bucket = { clientLabelHash: row.client_label_hash, windowStartedAt: new Date(row.window_started_at).toISOString(), attempts: row.attempts, updatedAt: new Date(row.updated_at).toISOString() }; return { allowed: bucket.attempts <= maximumAttempts, bucket }; }
  async getOperatorLoginBucket(clientLabelHash: string): Promise<OperatorLoginBucket | null> { const [row] = await this.db.select().from(operatorLoginBuckets).where(eq(operatorLoginBuckets.clientLabelHash, clientLabelHash)).limit(1); return row ?? null; }
  async clearOperatorLoginBucket(clientLabelHash: string): Promise<void> { await this.db.delete(operatorLoginBuckets).where(eq(operatorLoginBuckets.clientLabelHash, clientLabelHash)); }
  async createOperatorSession(session: OperatorSession): Promise<void> { await this.db.insert(operatorSessions).values(session); }
  async getOperatorSessionByTokenHash(tokenHash: string): Promise<OperatorSession | null> { const [row] = await this.db.select().from(operatorSessions).where(eq(operatorSessions.tokenHash, tokenHash)).limit(1); return row === undefined ? null : { ...row, createdAt: isoTimestamp(row.createdAt), expiresAt: isoTimestamp(row.expiresAt), revokedAt: nullableIsoTimestamp(row.revokedAt), lastUsedAt: nullableIsoTimestamp(row.lastUsedAt) }; }
  async touchOperatorSession(id: string, at: string): Promise<void> { await this.db.update(operatorSessions).set({ lastUsedAt: at }).where(eq(operatorSessions.id, id)); }
  async revokeOperatorSession(id: string, at: string): Promise<void> { await this.db.update(operatorSessions).set({ revokedAt: at }).where(eq(operatorSessions.id, id)); }
  async countActiveOperatorSessions(now: string): Promise<number> { const [row] = await this.db.select({ value: count() }).from(operatorSessions).where(and(isNull(operatorSessions.revokedAt), gt(operatorSessions.expiresAt, now))); return row?.value ?? 0; }
  async insertOperatorSecurityEvent(event: OperatorSecurityEvent): Promise<void> { await this.db.insert(operatorSecurityEvents).values(event); }
  async listOperatorSecurityEvents(limit: number): Promise<OperatorSecurityEvent[]> { const rows = await this.db.select().from(operatorSecurityEvents).orderBy(desc(operatorSecurityEvents.occurredAt)).limit(limit); return rows.map((row) => ({ ...row, type: row.type as OperatorSecurityEvent["type"], actor: row.actor as OperatorSecurityEvent["actor"] })); }
  async createTelegramInteraction(interaction: TelegramInteraction): Promise<"inserted" | "duplicate"> { const rows = await this.db.insert(telegramInteractions).values(interaction).onConflictDoNothing({ target: telegramInteractions.nonceHash }).returning({ nonceHash: telegramInteractions.nonceHash }); return rows.length === 0 ? "duplicate" : "inserted"; }
  async consumeTelegramInteraction(nonceHash: string, updateId: string, now: string): Promise<TelegramInteraction | null> { return await this.db.transaction(async (tx) => { const [row] = await tx.select().from(telegramInteractions).where(eq(telegramInteractions.nonceHash, nonceHash)).limit(1).for("update"); if (row === undefined || row.consumedAt !== null || Date.parse(row.expiresAt) <= Date.parse(now)) return null; const [updated] = await tx.update(telegramInteractions).set({ consumedAt: now, updateId }).where(and(eq(telegramInteractions.nonceHash, nonceHash), isNull(telegramInteractions.consumedAt))).returning(); return updated === undefined ? null : { ...updated, createdAt: isoTimestamp(updated.createdAt), expiresAt: isoTimestamp(updated.expiresAt), consumedAt: nullableIsoTimestamp(updated.consumedAt), action: updated.action as TelegramInteraction["action"] }; }); }
  async upsertTokenDiscovery(discovery: TokenDiscovery): Promise<"inserted" | "updated"> {
    const rows = await this.db.insert(tokenDiscoveries).values(discovery).onConflictDoNothing({ target: tokenDiscoveries.mint }).returning({ mint: tokenDiscoveries.mint });
    if (rows.length > 0) return "inserted";
    await this.db.update(tokenDiscoveries).set({
      firstPoolCreatedAt: discovery.firstPoolCreatedAt,
      symbol: discovery.symbol,
      name: discovery.name,
      decimals: discovery.decimals,
      organicScore: discovery.organicScore,
      organicScoreLabel: discovery.organicScoreLabel,
      provider: discovery.provider,
      provenance: discovery.provenance,
      lastObservedAt: discovery.lastObservedAt,
      providerObservedAt: discovery.providerObservedAt,
    }).where(eq(tokenDiscoveries.mint, discovery.mint));
    return "updated";
  }
  async listTokenDiscoveries(limit: number): Promise<TokenDiscovery[]> { return (await this.db.select().from(tokenDiscoveries).orderBy(desc(tokenDiscoveries.lastObservedAt)).limit(limit)).map((row) => ({ ...row, provider: "JUPITER_TOKENS_V2", provenance: "EXTERNAL_HEURISTIC" })); }
  async upsertCandidateEvaluation(evaluation: CandidateEvaluation): Promise<void> { await this.db.insert(candidateEvaluations).values(evaluation).onConflictDoUpdate({ target: candidateEvaluations.wallet, set: evaluation }); }
  async getCandidateEvaluation(wallet: string): Promise<CandidateEvaluation | null> { const [row] = await this.db.select().from(candidateEvaluations).where(eq(candidateEvaluations.wallet, wallet)).limit(1); return row === undefined ? null : { ...row, state: row.state as CandidateEvaluation["state"] }; }
  async listCandidateEvaluations(limit: number): Promise<CandidateEvaluation[]> { return (await this.db.select().from(candidateEvaluations).orderBy(desc(candidateEvaluations.evaluatedAt)).limit(limit)).map((row) => ({ ...row, state: row.state as CandidateEvaluation["state"] })); }
  async insertResearchRun(run: ResearchRun): Promise<void> { await this.db.insert(researchRuns).values(run); }
  async updateResearchRun(run: ResearchRun): Promise<void> { await this.db.update(researchRuns).set(run).where(eq(researchRuns.id, run.id)); }
  async listResearchRuns(limit: number): Promise<ResearchRun[]> { return (await this.db.select().from(researchRuns).orderBy(desc(researchRuns.startedAt)).limit(limit)).map((row) => ({ ...row, kind: row.kind as ResearchRun["kind"], status: row.status as ResearchRun["status"] })); }
}

export const EXPECTED_SCHEMA_REVISION = "runtime-schema-0006";
export interface MigrationReadiness { expected: string; current: string | null; ready: boolean }
export function evaluateMigrationReadiness(current: string | null, expected = EXPECTED_SCHEMA_REVISION): MigrationReadiness { return { expected, current, ready: current === expected }; }

export function createPostgresStore(databaseUrl: string): { store: PostgresIntelligenceStore; close: () => Promise<void>; ping: () => Promise<void>; serverVersion: () => Promise<string>; currentUser: () => Promise<string>; migrationReadiness: () => Promise<MigrationReadiness>; schemaReady: () => Promise<void>; cleanupStagingRehearsal: (prefix: string) => Promise<void>; pruneRawPayloads: (retentionDays: number, apply: boolean) => Promise<{ chainTransactions: number; webhookDeliveries: number; applied: boolean; cutoff: string }> } {
  const client = postgres(databaseUrl, { max: 10, prepare: false });
  const db = drizzle(client);
  const migrationReadiness = async (): Promise<MigrationReadiness> => { const [exists] = await client<{ table_name: string | null }[]>`select to_regclass('public.schema_revisions')::text as table_name`; if (exists?.table_name === null) return evaluateMigrationReadiness(null); const [row] = await client<{ revision: string }[]>`select revision from schema_revisions where component = 'runtime'`; return evaluateMigrationReadiness(row?.revision ?? null); };
  return {
    store: new PostgresIntelligenceStore(db),
    close: async () => { await client.end(); },
    ping: async () => { await client`select 1`; },
    serverVersion: async () => { const [row] = await client<{ version: string }[]>`select version()`; return row?.version ?? "UNKNOWN"; },
    currentUser: async () => { const [row] = await client<{ current_user: string }[]>`select current_user`; return row?.current_user ?? "UNKNOWN"; },
    migrationReadiness,
    schemaReady: async () => { const state = await migrationReadiness(); if (!state.ready) throw new Error(`Schema NOT_READY: EXPECTED=${state.expected} CURRENT=${state.current ?? "MISSING"}; run pnpm db:migrate`); },
    cleanupStagingRehearsal: async (prefix) => { await client.begin(async (tx) => { await tx`delete from runtime_jobs where idempotency_key like ${`${prefix}%`} or payload ->> 'notificationId' in (select id::text from notifications where provider = ${prefix})`; await tx`delete from worker_leases where worker_id like ${`${prefix}%`}`; await tx`delete from operator_login_buckets where client_label_hash like ${`${prefix}%`}`; await tx`delete from operator_sessions where client_label = ${prefix}`; await tx`delete from notifications where provider = ${prefix}`; await tx`delete from forward_return_observations where wallet = ${prefix}`; await tx`delete from paper_positions where trigger_wallet = ${prefix}`; await tx`delete from signals where source_wallet = ${prefix}`; await tx`delete from chain_transactions where provider = ${prefix}`; }); },
    pruneRawPayloads: async (retentionDays, apply) => {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const [chain] = await client<{ count: number }[]>`select count(*)::int as count from chain_transactions where observed_at < ${cutoff} and not (raw_payload ? 'retained')`;
      const [webhooks] = await client<{ count: number }[]>`select count(*)::int as count from webhook_deliveries where received_at < ${cutoff} and not (raw_payload ? 'retained')`;
      if (apply) await client.begin(async (tx) => { await tx`update chain_transactions set raw_payload = jsonb_build_object('retained', false, 'prunedAt', ${new Date().toISOString()}) where observed_at < ${cutoff} and not (raw_payload ? 'retained')`; await tx`update webhook_deliveries set raw_payload = jsonb_build_object('retained', false, 'prunedAt', ${new Date().toISOString()}) where received_at < ${cutoff} and not (raw_payload ? 'retained')`; });
      return { chainTransactions: chain?.count ?? 0, webhookDeliveries: webhooks?.count ?? 0, applied: apply, cutoff };
    }
  };
}

function serializeBigInts(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)) as unknown;
}

function isoTimestamp(value: string | Date): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("PostgreSQL returned an invalid timestamp");
  return timestamp.toISOString();
}

function nullableIsoTimestamp(value: string | Date | null): string | null { return value === null ? null : isoTimestamp(value); }

function reviveMint(value: TokenMintObservation): TokenMintObservation {
  return {
    ...value,
    rawSupply: value.rawSupply === null ? null : BigInt(String(value.rawSupply)),
    slot: value.slot === null ? null : BigInt(String(value.slot))
  };
}

function reviveConcentration(value: TokenConcentrationObservation): TokenConcentrationObservation {
  return { ...value, knownOwners: value.knownOwners.map((owner) => ({ ...owner, rawBalance: BigInt(String(owner.rawBalance)) })) };
}

function reviveShadowContext(value: ShadowPositionContext): ShadowPositionContext {
  return {
    ...value,
    sourceOutputRawAmount: value.sourceOutputRawAmount === null ? null : BigInt(String(value.sourceOutputRawAmount)),
    simulatedOutputRawAmount: BigInt(String(value.simulatedOutputRawAmount))
  };
}
