import { newId } from "@intelligence/shared";
import type { ChainTransaction, WalletAction, WalletBackfillRun, WalletMetrics } from "./domain.js";
import type { IntelligenceStore } from "./store.js";
import { classifyWalletAction, normalizeWalletTransaction, type SolanaRpcTransaction, type WalletActionClassifierConfig } from "./solana.js";

export interface BackfillHistoryResult {
  transactions: SolanaRpcTransaction[];
  diagnostics: {
    mode: string;
    signaturesFetched: number;
    transactionsFetched: number;
    transactionsMissing: number;
    failures: Array<{ signature: string; code: string }>;
    complete: boolean;
    completenessState?: WalletBackfillRun["completenessState"];
    continuationCursor?: string | null;
  };
}

export interface WalletHistorySource {
  readonly name: string;
  readonly historyMode: string;
  fetchWalletHistory(request: { address: string; limit: number; before?: string; concurrency: number; commitment: "confirmed" | "finalized" }): Promise<BackfillHistoryResult>;
}

export interface WalletBackfillOptions {
  maximumTransactions: number;
  concurrency: number;
  commitment?: "confirmed" | "finalized";
  classifier?: WalletActionClassifierConfig;
}

export interface WalletBackfillResult { run: WalletBackfillRun; actions: WalletAction[]; metrics: WalletMetrics }

export class WalletHistoryBackfillService {
  constructor(private readonly store: IntelligenceStore, private readonly provider: WalletHistorySource) {}

  async backfill(walletPublicKey: string, requestedLimit: number, options: WalletBackfillOptions): Promise<WalletBackfillResult> {
    const startedAt = new Date().toISOString();
    const limit = Math.min(options.maximumTransactions, Math.max(1, requestedLimit));
    const wallet = await this.store.upsertWallet(walletPublicKey, startedAt);
    const prior = await this.store.getLatestBackfillRun(walletPublicKey);
    const requestBefore = prior !== null && !prior.complete ? prior.continuationCursor : null;
    const attemptCount = prior !== null && !prior.complete ? prior.attemptCount + 1 : 1;
    let history: BackfillHistoryResult;
    try {
      history = await this.provider.fetchWalletHistory({ address: walletPublicKey, limit, ...(requestBefore === null ? {} : { before: requestBefore }), concurrency: Math.min(8, Math.max(1, options.concurrency)), commitment: options.commitment ?? "confirmed" });
    } catch (error) {
      const failedAt = new Date().toISOString();
      await this.store.insertBackfillRun({ id: newId(), wallet: walletPublicKey, provider: this.provider.name, historyMode: this.provider.historyMode, requestedLimit: limit, signaturesFetched: 0, transactionsFetched: 0, actionsPersisted: 0, duplicatesIgnored: 0, failures: [], complete: false, requestBefore, continuationCursor: requestBefore, lastProcessedSignature: prior?.lastProcessedSignature ?? null, lastProcessedSlot: prior?.lastProcessedSlot ?? null, lastProcessedAt: prior?.lastProcessedAt ?? null, completenessState: "PARTIAL_PROVIDER_FAILURE", attemptCount, lastErrorClass: error instanceof Error ? error.name : "UNKNOWN", updatedAt: failedAt, startedAt, completedAt: failedAt });
      throw error;
    }
    const actions: WalletAction[] = [];
    let actionsPersisted = 0;
    let duplicatesIgnored = 0;
    for (const transaction of history.transactions) {
      const observedAt = new Date().toISOString();
      const normalized = normalizeWalletTransaction(transaction, walletPublicKey, observedAt);
      const classified = classifyWalletAction(normalized, options.classifier);
      const chainTransaction: ChainTransaction = {
        signature: transaction.signature, slot: transaction.slot, blockTime: transaction.blockTime,
        status: transaction.error === null ? "succeeded" : "failed", feeLamports: transaction.feeLamports,
        provider: this.provider.name, rawPayload: transaction.raw, observedAt, providerReceivedAt: observedAt,
        normalizationCompletedAt: new Date().toISOString(), ingestionLatencyMs: transaction.blockTime === null ? null : Math.max(0, Date.parse(observedAt) - Date.parse(transaction.blockTime)),
        relevantWallets: [walletPublicKey],
        tokenBalanceDeltas: normalized.tokenChanges.map((change) => ({ owner: walletPublicKey, tokenAccount: change.accountDeltas[0]?.tokenAccount ?? `aggregate:${change.mint}`, mint: change.mint, rawAmount: change.rawDelta, decimals: change.decimals })),
        nativeBalanceDeltas: normalized.native === null ? [] : [{ account: walletPublicKey, lamports: normalized.native.rawDeltaLamports }]
      };
      if (await this.store.insertTransaction(chainTransaction) === "duplicate") duplicatesIgnored += 1;
      const action: WalletAction = {
        id: newId(), wallet: walletPublicKey, actionType: mapActionType(classified.classification), classification: classified.classification,
        classificationConfidence: classified.confidence, evidence: classified.evidence, ambiguityReasons: classified.ambiguityReasons,
        tokenMint: classified.classification === "SWAP_SELL" ? classified.inputMint : classified.outputMint,
        inputMint: classified.inputMint, outputMint: classified.outputMint,
        inputRawAmount: classified.inputRawAmount, inputDecimals: classified.inputDecimals,
        outputRawAmount: classified.outputRawAmount, outputDecimals: classified.outputDecimals,
        approximateInputUsd: null, approximateOutputUsd: null, transactionSignature: transaction.signature, slot: transaction.slot,
        observedAt, chainTime: transaction.blockTime, sourceConfidence: confidenceNumber(classified.confidence)
      };
      if (await this.store.insertWalletAction(action) === "inserted") { actionsPersisted += 1; actions.push(action); }
      else duplicatesIgnored += 1;
    }
    const completedAt = new Date().toISOString();
    const lastProcessed = history.transactions.at(-1) ?? null;
    const persistedActions = await this.store.listWalletActions(walletPublicKey, limit);
    const observedTrades = persistedActions.filter((action) => action.classification === "SWAP_BUY" || action.classification === "SWAP_SELL").length;
    const metrics: WalletMetrics = {
      walletId: wallet.id, sampleSize: persistedActions.length, observedTrades, realizedWins: 0, realizedLosses: 0,
      realizedPnLUsd: null, medianReturn: null, averageReturn: null, hitRate: null, earlyEntryScore: null,
      consistencyScore: null, copyabilityScore: null, crowdingScore: null, followerSlippageEstimate: null,
      suspiciousCoordinationScore: null, dataConfidence: history.diagnostics.complete ? Math.min(0.7, persistedActions.length / 20) : null,
      scoreCalculatedAt: completedAt
    };
    await this.store.upsertWalletMetrics(metrics);
    const run: WalletBackfillRun = {
      id: newId(), wallet: walletPublicKey, provider: this.provider.name, historyMode: history.diagnostics.mode,
      requestedLimit: limit, signaturesFetched: history.diagnostics.signaturesFetched, transactionsFetched: history.diagnostics.transactionsFetched,
      actionsPersisted, duplicatesIgnored, failures: history.diagnostics.failures, complete: history.diagnostics.complete,
      requestBefore, continuationCursor: history.diagnostics.continuationCursor ?? null,
      lastProcessedSignature: lastProcessed?.signature ?? prior?.lastProcessedSignature ?? null,
      lastProcessedSlot: lastProcessed?.slot ?? prior?.lastProcessedSlot ?? null,
      lastProcessedAt: lastProcessed?.blockTime ?? prior?.lastProcessedAt ?? null,
      completenessState: history.diagnostics.completenessState ?? (history.diagnostics.complete ? "COMPLETE_WITHIN_REQUESTED_WINDOW" : "UNKNOWN"),
      attemptCount, lastErrorClass: history.diagnostics.failures.at(-1)?.code ?? null, updatedAt: completedAt, startedAt, completedAt
    };
    await this.store.insertBackfillRun(run);
    return { run, actions, metrics };
  }
}

function mapActionType(classification: WalletAction["classification"]): WalletAction["actionType"] {
  if (classification === "SWAP_BUY") return "swap_buy";
  if (classification === "SWAP_SELL") return "swap_sell";
  if (classification === "TRANSFER_IN") return "transfer_in";
  if (classification === "TRANSFER_OUT") return "transfer_out";
  return "unknown";
}

function confidenceNumber(confidence: WalletAction["classificationConfidence"]): number | null {
  if (confidence === "HIGH") return 0.9;
  if (confidence === "MEDIUM") return 0.65;
  if (confidence === "LOW") return 0.35;
  return null;
}
