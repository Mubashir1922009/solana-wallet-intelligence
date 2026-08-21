import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AIAnalysis, CandidateDiscovery, ChainTransaction, CopyabilityEvaluation, CrowdingObservation, ExitRecommendation, ForwardReturnObservation, IntelligenceStore, LiveSubscriptionState, MarketObservation, NotificationRecord, PaperPosition, PositionEvent, PositionMark, ShadowPositionContext, ShadowPositionRecord, Signal, TokenConcentrationObservation, TokenIntelligenceSnapshot, TokenMintObservation, TokenRiskEvaluation, TradeDecision, UserAction, Wallet, WalletAction, WalletBackfillRun, WalletMetrics, WalletReputationSnapshot, WalletStatus } from "@intelligence/core";
import { newId } from "@intelligence/shared";
import { aiAnalyses, candidateDiscoveries, chainTransactions, copyabilityEvaluations, crowdingObservations, exitRecommendations, forwardReturnObservations, liveSubscriptionState, marketObservations, notifications, paperPositions, positionEvents, positionMarks, shadowPositionRecords, signals, tokenIntelligenceSnapshots, tokenLargestAccounts, tokenRiskEvaluations, tradeDecisions, transactionWallets, userActions, walletActions, walletBackfillRuns, walletMetrics, walletReputationSnapshots, wallets } from "./schema.js";

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
  async insertBackfillRun(run: WalletBackfillRun): Promise<void> { await this.db.insert(walletBackfillRuns).values(run); }
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
  async insertPositionMark(mark: PositionMark): Promise<void> { await this.db.insert(positionMarks).values(mark); }
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
    await this.db.update(notifications).set({ type: record.category, payload: record.payload, provider: record.provider, status: record.status, errorCode: record.errorCode, attemptedAt: record.attemptedAt, deliveredAt: record.deliveredAt }).where(eq(notifications.id, record.id));
  }
  async listNotifications(limit: number): Promise<NotificationRecord[]> {
    const rows = await this.db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
    return rows.map((row) => ({ id: row.id, category: row.type as NotificationRecord["category"], payload: row.payload, provider: row.provider, status: row.status as NotificationRecord["status"], errorCode: row.errorCode, createdAt: row.createdAt, attemptedAt: row.attemptedAt, deliveredAt: row.deliveredAt, idempotencyKey: row.idempotencyKey ?? row.id }));
  }
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
    return rows.map((row) => ({ ...row, status: row.status as ForwardReturnObservation["status"] }));
  }
  async upsertWalletReputation(snapshot: WalletReputationSnapshot): Promise<void> {
    await this.db.insert(walletReputationSnapshots).values({ id: snapshot.id, wallet: snapshot.wallet, snapshot, calculatedAt: snapshot.calculatedAt }).onConflictDoUpdate({ target: walletReputationSnapshots.wallet, set: { id: snapshot.id, snapshot, calculatedAt: snapshot.calculatedAt } });
  }
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
}

export function createPostgresStore(databaseUrl: string): { store: PostgresIntelligenceStore; close: () => Promise<void>; ping: () => Promise<void> } {
  const client = postgres(databaseUrl, { max: 10, prepare: false });
  const db = drizzle(client);
  return {
    store: new PostgresIntelligenceStore(db),
    close: async () => { await client.end(); },
    ping: async () => { await client`select 1`; }
  };
}

function serializeBigInts(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)) as unknown;
}

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
