import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ChainTransaction, CopyabilityEvaluation, CrowdingObservation, IntelligenceStore, MarketObservation, PaperPosition, PositionEvent, Signal, TradeDecision, UserAction, Wallet, WalletAction, WalletBackfillRun, WalletMetrics, WalletStatus } from "@intelligence/core";
import { newId } from "@intelligence/shared";
import { chainTransactions, copyabilityEvaluations, crowdingObservations, marketObservations, paperPositions, positionEvents, signals, tradeDecisions, transactionWallets, userActions, walletActions, walletBackfillRuns, walletMetrics, wallets } from "./schema.js";

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
    return rows.map((row) => ({
      ...row, actionType: row.actionType as WalletAction["actionType"], classification: row.classification as WalletAction["classification"],
      classificationConfidence: row.classificationConfidence as WalletAction["classificationConfidence"], ambiguityReasons: row.ambiguityReasons as WalletAction["ambiguityReasons"],
      inputRawAmount: row.inputRawAmount === null ? null : BigInt(row.inputRawAmount), outputRawAmount: row.outputRawAmount === null ? null : BigInt(row.outputRawAmount)
    }));
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
