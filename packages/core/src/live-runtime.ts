import { newId } from "@intelligence/shared";
import type { ChainTransaction, WalletAction } from "./domain.js";
import type { IntelligenceStore } from "./store.js";
import { classifyWalletAction, normalizeWalletTransaction, type ClassifiedWalletAction, type SolanaRpcTransaction, type WalletActionClassifierConfig } from "./solana.js";
import type { LiveSubscriptionStore } from "./watchlist.js";

export interface LiveEventInput { wallet: string; signature: string; slot: bigint; succeeded: boolean; receivedAt: string; provider: string }
export interface LiveHistorySource {
  readonly name: string;
  fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null>;
  fetchWalletHistory(request: { address: string; limit: number; until?: string; commitment: "confirmed" | "finalized"; concurrency: number }): Promise<{ transactions: SolanaRpcTransaction[]; diagnostics: { complete: boolean; failures: Array<{ signature: string; code: string }> } }>;
}

export interface GapRecoveryResult { wallet: string; retrieved: number; inserted: number; duplicates: number; complete: boolean; boundarySignature: string | null }

export class LiveIngestionCoordinator {
  constructor(
    private readonly store: IntelligenceStore & LiveSubscriptionStore,
    private readonly history: LiveHistorySource,
    private readonly options: { gapLimit: number; concurrency: number; classifier?: WalletActionClassifierConfig; onAction?: (action: ClassifiedWalletAction, persisted: WalletAction) => Promise<void> | void; onCandidate?: (wallet: string, tokenMint: string, sourceEvent: string, observedAt: string) => Promise<void> | void; onGapRecovered?: (result: GapRecoveryResult) => Promise<void> | void }
  ) {}

  async processLiveEvent(event: LiveEventInput): Promise<"inserted" | "duplicate" | "missing"> {
    const transaction = await this.history.fetchTransaction(event.signature);
    if (transaction === null) return "missing";
    const result = await this.processTransaction(event.wallet, transaction, event.receivedAt);
    await this.updateDurableBoundary(event.wallet, transaction.signature, transaction.slot, event.receivedAt, result !== "missing");
    return result;
  }

  async recoverGap(wallet: string): Promise<GapRecoveryResult> {
    const state = await this.store.getLiveSubscriptionState(wallet);
    const boundarySignature = state?.lastObservedSignature ?? null;
    const request = { address: wallet, limit: this.options.gapLimit, commitment: "confirmed" as const, concurrency: this.options.concurrency, ...(boundarySignature === null ? {} : { until: boundarySignature }) };
    const history = await this.history.fetchWalletHistory(request);
    let inserted = 0;
    let duplicates = 0;
    const ordered = [...history.transactions].sort((a, b) => a.slot === b.slot ? 0 : a.slot < b.slot ? -1 : 1);
    for (const transaction of ordered) {
      const outcome = await this.processTransaction(wallet, transaction, new Date().toISOString());
      if (outcome === "inserted") inserted += 1; else if (outcome === "duplicate") duplicates += 1;
      await this.updateDurableBoundary(wallet, transaction.signature, transaction.slot, new Date().toISOString(), outcome !== "missing");
    }
    const result = { wallet, retrieved: history.transactions.length, inserted, duplicates, complete: history.diagnostics.complete, boundarySignature };
    await this.options.onGapRecovered?.(result);
    return result;
  }

  async recoverAll(wallets: string[]): Promise<GapRecoveryResult[]> {
    const results: GapRecoveryResult[] = [];
    for (const wallet of wallets) results.push(await this.recoverGap(wallet));
    return results;
  }

  private async processTransaction(wallet: string, transaction: SolanaRpcTransaction, observedAt: string): Promise<"inserted" | "duplicate" | "missing"> {
    const normalized = normalizeWalletTransaction(transaction, wallet, observedAt);
    const classified = classifyWalletAction(normalized, this.options.classifier);
    const chainTransaction: ChainTransaction = {
      signature: transaction.signature, slot: transaction.slot, blockTime: transaction.blockTime, status: transaction.error === null ? "succeeded" : "failed",
      feeLamports: transaction.feeLamports, provider: this.history.name, rawPayload: transaction.raw, observedAt, providerReceivedAt: observedAt,
      normalizationCompletedAt: new Date().toISOString(), ingestionLatencyMs: transaction.blockTime === null ? null : Math.max(0, Date.parse(observedAt) - Date.parse(transaction.blockTime)), relevantWallets: [wallet],
      tokenBalanceDeltas: normalized.tokenChanges.map((change) => ({ owner: wallet, tokenAccount: change.accountDeltas[0]?.tokenAccount ?? `aggregate:${change.mint}`, mint: change.mint, rawAmount: change.rawDelta, decimals: change.decimals })),
      nativeBalanceDeltas: normalized.native === null ? [] : [{ account: wallet, lamports: normalized.native.rawDeltaLamports }]
    };
    const transactionOutcome = await this.store.insertTransaction(chainTransaction);
    const action: WalletAction = {
      id: newId(), wallet, actionType: actionType(classified.classification), classification: classified.classification, classificationConfidence: classified.confidence,
      evidence: classified.evidence, ambiguityReasons: classified.ambiguityReasons, tokenMint: classified.classification === "SWAP_SELL" ? classified.inputMint : classified.outputMint,
      inputMint: classified.inputMint, outputMint: classified.outputMint, inputRawAmount: classified.inputRawAmount, inputDecimals: classified.inputDecimals,
      outputRawAmount: classified.outputRawAmount, outputDecimals: classified.outputDecimals, approximateInputUsd: null, approximateOutputUsd: null,
      transactionSignature: transaction.signature, slot: transaction.slot, observedAt, chainTime: transaction.blockTime, sourceConfidence: confidence(classified.confidence)
    };
    const actionOutcome = await this.store.insertWalletAction(action);
    if (actionOutcome === "inserted") {
      await this.options.onAction?.(classified, action);
      if (classified.classification === "SWAP_BUY" && classified.outputMint !== null) {
        const coSigners = transaction.accountKeys.filter((key) => key.signer && key.pubkey !== wallet).map((key) => key.pubkey);
        for (const candidate of coSigners) await this.options.onCandidate?.(candidate, classified.outputMint, transaction.signature, observedAt);
      }
    }
    return transactionOutcome === "duplicate" && actionOutcome === "duplicate" ? "duplicate" : "inserted";
  }

  private async updateDurableBoundary(wallet: string, signature: string, slot: bigint, now: string, successful: boolean): Promise<void> {
    const state = await this.store.getLiveSubscriptionState(wallet);
    await this.store.upsertLiveSubscriptionState({ wallet, lifecycle: state?.lifecycle ?? "ACTIVE", priority: state?.priority ?? 0, provider: state?.provider ?? this.history.name, subscriptionHealthy: state?.subscriptionHealthy ?? true, lastObservedSignature: signature, lastObservedSlot: slot, lastActivityAt: now, lastSuccessfulIngestionAt: successful ? now : state?.lastSuccessfulIngestionAt ?? null, updatedAt: now });
  }
}

function actionType(classification: WalletAction["classification"]): WalletAction["actionType"] {
  if (classification === "SWAP_BUY") return "swap_buy";
  if (classification === "SWAP_SELL") return "swap_sell";
  if (classification === "TRANSFER_IN") return "transfer_in";
  if (classification === "TRANSFER_OUT") return "transfer_out";
  return "unknown";
}
function confidence(value: WalletAction["classificationConfidence"]): number | null { return value === "HIGH" ? 0.9 : value === "MEDIUM" ? 0.65 : value === "LOW" ? 0.35 : null; }
