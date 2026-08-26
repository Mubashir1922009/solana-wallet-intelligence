import { newId, stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import { evaluateCopyability, type CopyabilityEvaluation } from "./copyability.js";
import type { CrowdingObservation } from "./crowding.js";
import type { WalletMetrics } from "./domain.js";
import type { IntelligenceStore } from "./store.js";
import type { MarketObservation } from "./market.js";
import type { MarketQuoteRequest, MarketQuoteResult } from "./market.js";
import type { CandidateDiscovery, FollowerSourceEvent, ForwardReturnObservation, WalletReputationSnapshot } from "./runtime-domain.js";
import type { ClassifiedWalletAction } from "./solana.js";

export interface CandidateDiscoveryStore {
  insertCandidateDiscovery(discovery: CandidateDiscovery): Promise<"inserted" | "duplicate">;
  listCandidateDiscoveries(wallet: string): Promise<CandidateDiscovery[]>;
  insertForwardReturnObservation(observation: ForwardReturnObservation): Promise<"inserted" | "duplicate">;
  listForwardReturnObservations(wallet: string): Promise<ForwardReturnObservation[]>;
  upsertWalletReputation(snapshot: WalletReputationSnapshot): Promise<void>;
}

export interface CandidateDiscoveryEngine {
  observe(wallet: string, tokenMint: string, sourceEvent: string, reason: string, at: string): Promise<{ discovery: CandidateDiscovery; promotedToCandidate: boolean }>;
}

export class ObservedDatasetCandidateDiscoveryEngine implements CandidateDiscoveryEngine {
  constructor(private readonly store: IntelligenceStore & CandidateDiscoveryStore, private readonly minimumIndependentTokens = 2) {}
  async observe(wallet: string, tokenMint: string, sourceEvent: string, reason: string, at: string): Promise<{ discovery: CandidateDiscovery; promotedToCandidate: boolean }> {
    const prior = await this.store.listCandidateDiscoveries(wallet);
    const tokens = new Set(prior.map((item) => item.sourceToken));
    tokens.add(tokenMint);
    const discovery: CandidateDiscovery = {
      id: newId(), wallet, reason, sourceToken: tokenMint, sourceEvent, independentObservationCount: tokens.size,
      confidence: tokens.size >= 3 ? "MEDIUM" : "LOW", firstDiscoveredAt: prior.map((item) => item.firstDiscoveredAt).sort()[0] ?? at,
      lastObservedAt: at, idempotencyKey: `${wallet}:${tokenMint}:${sourceEvent}`
    };
    await this.store.insertCandidateDiscovery(discovery);
    const promotedToCandidate = tokens.size >= this.minimumIndependentTokens;
    if (promotedToCandidate) await this.store.upsertWallet(wallet, at);
    return { discovery, promotedToCandidate };
  }
}

export interface ForwardResearchStore extends CandidateDiscoveryStore {
  getWallet(publicKey: string): Promise<{ id: string } | null>;
  upsertWalletMetrics(metrics: WalletMetrics): Promise<void>;
  insertMarketObservation(observation: MarketObservation): Promise<void>;
  getCopyabilityBySourceTransaction(signature: string): Promise<CopyabilityEvaluation | null>;
  listRecentCopyability(limit: number): Promise<CopyabilityEvaluation[]>;
  listCrowdingObservations(sourceTransactionSignatures: string[]): Promise<CrowdingObservation[]>;
  getMarketObservation(id: string): Promise<MarketObservation | null>;
  listFollowerSourceEvents(wallet: string): Promise<FollowerSourceEvent[]>;
  enqueueRuntimeJob(job: import("./runtime-domain.js").RuntimeJob): Promise<"inserted" | "duplicate">;
}
export interface ForwardResearchQuoteProvider { readonly enabled: boolean; getQuote(request: MarketQuoteRequest): Promise<MarketQuoteResult> }

export interface FollowerEvidenceStore extends ForwardResearchStore {
  getCandidateEvaluation(wallet: string): Promise<import("./runtime-domain.js").CandidateEvaluation | null>;
  insertCopyabilityEvaluation(evaluation: CopyabilityEvaluation): Promise<"inserted" | "duplicate">;
  insertFollowerSourceEvent(event: FollowerSourceEvent): Promise<"inserted" | "duplicate">;
  getFollowerSourceEventByTransaction(signature: string): Promise<FollowerSourceEvent | null>;
}

export class FollowerOutcomeAccumulator {
  constructor(
    private readonly store: FollowerEvidenceStore,
    private readonly quotes: ForwardResearchQuoteProvider,
    private readonly forward: ForwardReturnResearchService,
    private readonly options: { stableMint: string; stableDecimals: number; followerInputRawAmount?: bigint; maximumProspectiveLagMs?: number }
  ) {}

  async observeProspectiveBuy(action: ClassifiedWalletAction, decisionEvidenceAt = new Date().toISOString()): Promise<FollowerSourceEvent | null> {
    if (action.classification !== "SWAP_BUY" || action.outputMint === null || action.outputDecimals === null) return null;
    const evaluation = await this.store.getCandidateEvaluation(action.wallet);
    if (evaluation === null || !["RESEARCH_WATCH", "TRACK_ELIGIBLE", "TRACKING"].includes(evaluation.state)) return null;

    // Gap recovery and historical backfills must never be treated as decision-time follower entries.
    const sourceAt = action.blockTime === null ? Number.NaN : Date.parse(action.blockTime);
    const evidenceAt = Date.parse(decisionEvidenceAt);
    const maximumProspectiveLagMs = this.options.maximumProspectiveLagMs ?? 120_000;
    if (!Number.isFinite(sourceAt) || !Number.isFinite(evidenceAt) || evidenceAt < sourceAt || evidenceAt - sourceAt > maximumProspectiveLagMs) {
      return this.markHistoricalUnusable(action, decisionEvidenceAt);
    }

    const duplicate = await this.store.getFollowerSourceEventByTransaction(action.transactionSignature);
    if (duplicate !== null) {
      await this.ensureForwardJobs(duplicate, action);
      return duplicate;
    }

    let entry: MarketObservation | null = null;
    let copyability: CopyabilityEvaluation | null = null;
    if (this.quotes.enabled) {
      try {
        entry = (await this.quotes.getQuote({
          inputMint: this.options.stableMint,
          outputMint: action.outputMint,
          inputRawAmount: this.options.followerInputRawAmount ?? 10n ** BigInt(this.options.stableDecimals),
          inputDecimals: this.options.stableDecimals,
          outputDecimals: action.outputDecimals
        })).observation;
        await this.store.insertMarketObservation(entry);
        copyability = evaluateCopyability(action, entry, {
          transactionObservedAt: action.observedAt,
          normalizationCompletedAt: decisionEvidenceAt,
          signalGeneratedAt: decisionEvidenceAt,
          decisionAt: decisionEvidenceAt
        }, decisionEvidenceAt);
        await this.store.insertCopyabilityEvaluation(copyability);
      } catch {
        entry = null;
      }
    }

    const event: FollowerSourceEvent = {
      id: newId(), sourceWallet: action.wallet, sourceTransaction: action.transactionSignature, tokenMint: action.outputMint,
      sourceBlockTime: action.blockTime, sourceObservedAt: action.observedAt, decisionEvidenceAt,
      entryMarketObservationId: entry?.id ?? null, copyabilityEvaluationId: copyability?.id ?? null,
      status: entry === null ? "MISSING_ENTRY" : entry.routeAvailable ? "ENTRY_QUOTED" : "NO_ROUTE",
      sourceEffectiveEntry: copyability?.sourceEffectivePrice ?? null, followerQuotedEntry: copyability?.followerQuotedPrice ?? null,
      routeAvailable: entry?.routeAvailable ?? null, quoteRequestedAt: entry?.requestedAt ?? null, quoteReceivedAt: entry?.receivedAt ?? null,
      quoteLatencyMs: entry?.providerLatencyMs ?? null, priceImpactPct: entry?.priceImpactPct ?? null,
      dataCompleteness: entry === null ? 0 : 1, providerProvenance: entry === null ? null : `${entry.provider}:${entry.provenance}`,
      idempotencyKey: `follower-source:${action.wallet}:${action.transactionSignature}`, createdAt: decisionEvidenceAt
    };
    if (await this.store.insertFollowerSourceEvent(event) === "duplicate") {
      const persisted = await this.store.getFollowerSourceEventByTransaction(action.transactionSignature);
      if (persisted !== null) await this.ensureForwardJobs(persisted, action);
      return persisted;
    }
    await this.ensureForwardJobs(event, action, entry);
    return event;
  }

  async markHistoricalUnusable(action: ClassifiedWalletAction, recordedAt = new Date().toISOString()): Promise<FollowerSourceEvent | null> {
    if (action.classification !== "SWAP_BUY" || action.outputMint === null) return null;
    const evaluation = await this.store.getCandidateEvaluation(action.wallet);
    if (evaluation === null || !["RESEARCH_WATCH", "TRACK_ELIGIBLE", "TRACKING"].includes(evaluation.state)) {
      const discoveries = await this.store.listCandidateDiscoveries(action.wallet);
      if (discoveries.length === 0) return null;
    }
    const prior = await this.store.getFollowerSourceEventByTransaction(action.transactionSignature);
    if (prior !== null) return prior;
    const event: FollowerSourceEvent = {
      id: newId(), sourceWallet: action.wallet, sourceTransaction: action.transactionSignature, tokenMint: action.outputMint,
      sourceBlockTime: action.blockTime, sourceObservedAt: action.observedAt, decisionEvidenceAt: recordedAt,
      entryMarketObservationId: null, copyabilityEvaluationId: null, status: "HISTORICAL_UNUSABLE",
      sourceEffectiveEntry: null, followerQuotedEntry: null, routeAvailable: null, quoteRequestedAt: null, quoteReceivedAt: null,
      quoteLatencyMs: null, priceImpactPct: null, dataCompleteness: 0, providerProvenance: null,
      idempotencyKey: `follower-source:${action.wallet}:${action.transactionSignature}`, createdAt: recordedAt
    };
    if (await this.store.insertFollowerSourceEvent(event) === "duplicate") return this.store.getFollowerSourceEventByTransaction(action.transactionSignature);
    return event;
  }

  private async ensureForwardJobs(event: FollowerSourceEvent, action: ClassifiedWalletAction, knownEntry?: MarketObservation | null): Promise<void> {
    if (action.outputMint === null || action.outputDecimals === null || event.status === "HISTORICAL_UNUSABLE") return;
    const entry = knownEntry !== undefined ? knownEntry : event.entryMarketObservationId === null ? null : await this.store.getMarketObservation(event.entryMarketObservationId);
    await this.forward.schedule({
      wallet: action.wallet,
      transactionSignature: action.transactionSignature,
      tokenMint: action.outputMint,
      tokenRawAmount: entry?.outputRawAmount ?? 0n,
      tokenDecimals: entry?.outputDecimals ?? action.outputDecimals,
      entry,
      sourceEventId: event.id,
      anchorAt: event.quoteReceivedAt ?? event.decisionEvidenceAt
    });
  }
}

export class ForwardReturnResearchService {
  constructor(private readonly store: ForwardResearchStore, private readonly quotes: ForwardResearchQuoteProvider, private readonly options: { windowsMs: number[]; stableMint: string; stableDecimals: number }) {}
  async schedule(input: { wallet: string; transactionSignature: string; tokenMint: string; tokenRawAmount: bigint; tokenDecimals: number; entry: MarketObservation | null; sourceEventId?: string | null; anchorAt?: string }): Promise<void> {
    if (!this.quotes.enabled) return;
    const scheduledAt = new Date().toISOString();
    const anchorMs = Date.parse(input.anchorAt ?? input.entry?.receivedAt ?? scheduledAt);
    const anchorAt = Number.isFinite(anchorMs) ? anchorMs : Date.parse(scheduledAt);
    for (const windowMs of this.options.windowsMs) {
      const requestedAt = new Date(anchorAt + windowMs).toISOString();
      await this.store.enqueueRuntimeJob({ id: newId(), type: "FORWARD_RETURN", payload: { wallet: input.wallet, transactionSignature: input.transactionSignature, tokenMint: input.tokenMint, tokenRawAmount: input.tokenRawAmount.toString(), tokenDecimals: input.tokenDecimals, entryMarketObservationId: input.entry?.id ?? null, sourceEventId: input.sourceEventId ?? null, windowMs, requestedAt }, status: "PENDING", runAt: requestedAt, createdAt: scheduledAt, startedAt: null, completedAt: null, attempts: 0, maxAttempts: 8, leaseOwner: null, leaseExpiresAt: null, lastError: null, idempotencyKey: `forward-job:${input.transactionSignature}:${input.wallet}:${windowMs}` });
    }
  }
  shutdown(): void { /* Scheduling is PostgreSQL-durable; no process-local timers exist. */ }
  async observeDurableJob(payload: unknown, observedAt = new Date().toISOString()): Promise<ForwardReturnObservation> {
    const input = durableForwardPayload.parse(payload); const entry = input.entryMarketObservationId === null ? null : await this.store.getMarketObservation(input.entryMarketObservationId);
    if (entry === null) return this.persistMissing(input, observedAt);
    return this.observeWindow({ wallet: input.wallet, transactionSignature: input.transactionSignature, tokenMint: input.tokenMint, tokenRawAmount: BigInt(input.tokenRawAmount), tokenDecimals: input.tokenDecimals, entry }, input.windowMs, observedAt, input.requestedAt, input.sourceEventId ?? null);
  }
  async observeWindow(input: { wallet: string; transactionSignature: string; tokenMint: string; tokenRawAmount: bigint; tokenDecimals: number; entry: MarketObservation }, windowMs: number, observedAt = new Date().toISOString(), requestedAt: string | null = null, sourceEventId: string | null = null): Promise<ForwardReturnObservation> {
    let forward: MarketObservation | null = null;
    try {
      if (!input.entry.routeAvailable) throw new NoRouteEntryError();
      const result = await this.quotes.getQuote({ inputMint: input.tokenMint, outputMint: this.options.stableMint, inputRawAmount: input.tokenRawAmount, inputDecimals: input.tokenDecimals, outputDecimals: this.options.stableDecimals });
      forward = result.observation;
      await this.store.insertMarketObservation(forward);
    } catch { /* NO_ROUTE and provider failure remain explicit non-return states. */ }
    const base = evaluateForwardReturn(input.wallet, input.transactionSignature, input.tokenMint, windowMs, input.entry, forward, observedAt);
    const observation = { ...base, sourceEventId, dataCompleteness: base.status === "MISSING_OBSERVATION" ? 0 : 1, providerProvenance: forward === null ? input.entry.provider : `${forward.provider}:${forward.provenance}`, estimatedNetReturn: null, requestedAt, latenessMs: requestedAt === null ? null : Math.max(0, Date.parse(observedAt) - Date.parse(requestedAt)) };
    await this.store.insertForwardReturnObservation(observation);
    await this.refreshReputation(input.wallet, observedAt);
    return observation;
  }
  private async persistMissing(input: z.infer<typeof durableForwardPayload>, observedAt: string): Promise<ForwardReturnObservation> { const observation: ForwardReturnObservation = { ...evaluateForwardReturn(input.wallet, input.transactionSignature, input.tokenMint, input.windowMs, null, null, observedAt), sourceEventId: input.sourceEventId ?? null, dataCompleteness: 0, providerProvenance: null, estimatedNetReturn: null, requestedAt: input.requestedAt, latenessMs: Math.max(0, Date.parse(observedAt) - Date.parse(input.requestedAt)) }; await this.store.insertForwardReturnObservation(observation); await this.refreshReputation(input.wallet, observedAt); return observation; }
  private async refreshReputation(wallet: string, observedAt: string): Promise<void> {
    const [forward, sourceEvents, recentCopyability] = await Promise.all([
      this.store.listForwardReturnObservations(wallet),
      this.store.listFollowerSourceEvents(wallet),
      this.store.listRecentCopyability(10_000)
    ]);
    const sourceTransactions = new Set(sourceEvents.filter((item) => item.status !== "HISTORICAL_UNUSABLE").map((item) => item.sourceTransaction));
    const copyability = recentCopyability.filter((item) => sourceTransactions.has(item.sourceTransactionSignature));
    const crowding = await this.store.listCrowdingObservations([...sourceTransactions]);
    const reputation = calculateWalletReputation(wallet, forward, copyability, crowding, observedAt);
    await this.store.upsertWalletReputation(reputation);
    const walletRecord = await this.store.getWallet(wallet);
    if (walletRecord !== null) await this.store.upsertWalletMetrics(deriveWalletMetricsFromReputation(walletRecord.id, reputation, observedAt));
  }
}

import { z } from "zod";
const durableForwardPayload = z.object({ wallet: z.string(), transactionSignature: z.string(), tokenMint: z.string(), tokenRawAmount: z.string().regex(/^\d+$/), tokenDecimals: z.number().int().min(0).max(255), entryMarketObservationId: z.string().nullable(), sourceEventId: z.string().nullable().optional(), windowMs: z.number().int().positive(), requestedAt: z.iso.datetime({ offset: true }) });
class NoRouteEntryError extends Error {}

export function evaluateForwardReturn(wallet: string, transactionSignature: string, tokenMint: string, windowMs: number, entry: MarketObservation | null, forward: MarketObservation | null, observedAt: string): ForwardReturnObservation {
  let status: ForwardReturnObservation["status"] = "VALID_OBSERVATION";
  let followerReturn: number | null = null;
  if (entry === null) status = "MISSING_OBSERVATION";
  else if (!entry.routeAvailable) status = "NO_ROUTE";
  else if (forward === null) status = "MISSING_OBSERVATION";
  else if (!forward.routeAvailable) status = "NO_ROUTE";
  else {
    const entryUsd = entry.inputUsdValue === null ? null : Number(entry.inputUsdValue);
    const forwardUsd = forward.outputUsdValue === null ? null : Number(forward.outputUsdValue);
    if (entryUsd === null || forwardUsd === null || !Number.isFinite(entryUsd) || !Number.isFinite(forwardUsd) || entryUsd <= 0) status = "MISSING_OBSERVATION";
    else followerReturn = forwardUsd / entryUsd - 1;
  }
  return { id: newId(), wallet, transactionSignature, tokenMint, windowMs, status, entryMarketObservationId: entry?.id ?? null, forwardMarketObservationId: forward?.id ?? null, followerReturn, observedAt, idempotencyKey: `${transactionSignature}:${wallet}:${windowMs}` };
}

export interface ReputationRules { minimumSample: number; returnCap: number; followerReturnWeight: number; copyabilityWeight: number; crowdingWeight: number }
export const PROVISIONAL_REPUTATION_RULES: ReputationRules = { minimumSample: 10, returnCap: 1, followerReturnWeight: 0.55, copyabilityWeight: 0.3, crowdingWeight: 0.15 };

export function deriveWalletMetricsFromReputation(walletId: string, reputation: WalletReputationSnapshot, calculatedAt: string): WalletMetrics {
  const distribution = reputation.followerReturnDistribution ?? [];
  const copyabilitySamples = reputation.copyableOpportunities + reputation.uncopyableOpportunities;
  const trimmedMean = reputation.trimmedMeanFollowerReturn;
  return {
    walletId,
    sampleSize: reputation.sampleSize,
    observedTrades: reputation.observedCandidateBuys,
    realizedWins: distribution.filter((value) => value > 0).length,
    realizedLosses: (reputation.downsideDistribution ?? []).length,
    realizedPnLUsd: null,
    medianReturn: reputation.medianFollowerReturn,
    averageReturn: trimmedMean === undefined || trimmedMean === null ? (distribution.length === 0 ? null : distribution.reduce((sum, value) => sum + value, 0) / distribution.length) : trimmedMean,
    hitRate: reputation.winRate ?? null,
    earlyEntryScore: null,
    consistencyScore: reputation.consistency,
    copyabilityScore: copyabilitySamples === 0 ? null : reputation.copyableOpportunities / copyabilitySamples,
    crowdingScore: reputation.crowdingFrequency,
    followerSlippageEstimate: reputation.medianDeteriorationBps === null ? null : Math.max(0, Math.min(1, reputation.medianDeteriorationBps / 10_000)),
    suspiciousCoordinationScore: null,
    dataConfidence: reputation.dataCompleteness,
    scoreCalculatedAt: calculatedAt
  };
}

export function calculateWalletReputation(wallet: string, forward: ForwardReturnObservation[], copyability: CopyabilityEvaluation[], crowding: CrowdingObservation[], calculatedAt: string, rules: ReputationRules = PROVISIONAL_REPUTATION_RULES): WalletReputationSnapshot {
  const returns = forward.filter((item) => item.status === "VALID_OBSERVATION" && item.followerReturn !== null).map((item) => Math.max(-rules.returnCap, Math.min(rules.returnCap, item.followerReturn ?? 0)));
  const medianFollowerReturn = median(returns);
  const deterioration = copyability.flatMap((item) => item.entryPriceDeteriorationBps === null ? [] : [item.entryPriceDeteriorationBps]);
  const copyable = copyability.filter((item) => item.status === "KNOWN" && (item.entryPriceDeteriorationBps ?? Number.POSITIVE_INFINITY) <= 500).length;
  const uncopyable = copyability.length - copyable;
  const knownCrowding = crowding.filter((item) => item.status === "OBSERVED");
  const unknownCrowding = crowding.length - knownCrowding.length;
  const crowded = knownCrowding.filter((item) => (item.windows.at(-1)?.followerWalletCount ?? 0) >= 3).length;
  const sampleSize = returns.length;
  const dataCompleteness = forward.length === 0 ? 0 : returns.length / forward.length;
  const returnQuality = medianFollowerReturn === null ? 0.35 : Math.max(0, Math.min(1, (medianFollowerReturn + 0.25) / 0.5));
  const copyableRate = copyability.length === 0 ? 0.35 : copyable / copyability.length;
  const crowdingPenalty = knownCrowding.length === 0 ? 0.35 : crowded / knownCrowding.length;
  const raw = 100 * (returnQuality * rules.followerReturnWeight + copyableRate * rules.copyabilityWeight + (1 - crowdingPenalty) * rules.crowdingWeight);
  const sampleConfidence = Math.min(1, sampleSize / rules.minimumSample);
  const provisionalScore = raw * sampleConfidence;
  const sortedReturns = [...returns].sort((a, b) => a - b); const trim = sortedReturns.length >= 5 ? Math.floor(sortedReturns.length * 0.1) : 0; const trimmed = sortedReturns.slice(trim, sortedReturns.length - trim || undefined);
  const signalLatencies = copyability.flatMap((item) => item.totalFollowerLatencyMs === null ? [] : [item.totalFollowerLatencyMs]);
  return {
    id: newId(), wallet, observedCandidateBuys: new Set(forward.map((item) => item.transactionSignature)).size, copyableOpportunities: copyable, uncopyableOpportunities: uncopyable,
    medianFollowerReturn, followerReturnDistribution: [...returns].sort((a, b) => a - b), medianDeteriorationBps: median(deterioration),
    earlyEntryFrequency: null, crowdingFrequency: knownCrowding.length === 0 ? null : crowded / knownCrowding.length,
    consistency: returns.length < 2 ? null : consistency(returns), sampleSize, dataCompleteness, provisionalScore, calculatedAt,
    rulesetHash: stableHash(rules as unknown as JsonValue), validCopyabilityEvaluations: copyability.filter((item) => item.status === "KNOWN").length,
    noRouteEvents: forward.filter((item) => item.status === "NO_ROUTE").length, trimmedMeanFollowerReturn: trimmed.length === 0 ? null : trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length,
    downsideDistribution: sortedReturns.filter((value) => value < 0), winRate: returns.length === 0 ? null : returns.filter((value) => value > 0).length / returns.length,
    lossRate: returns.length === 0 ? null : returns.filter((value) => value < 0).length / returns.length, maximumObservedFollowerLoss: sortedReturns[0] ?? null,
    medianSignalLatencyMs: median(signalLatencies), riskGateRejectionFrequency: null, independentTokenSampleSize: new Set(forward.map((item) => item.tokenMint)).size,
    knownCrowdingSampleCount: knownCrowding.length, unknownCrowdingSampleCount: unknownCrowding
  };
}

function median(values: number[]): number | null { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); const value = sorted[middle]; if (value === undefined) return null; return sorted.length % 2 === 1 ? value : ((sorted[middle - 1] ?? value) + value) / 2; }
function consistency(values: number[]): number { const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length; return Math.max(0, 1 - Math.min(1, Math.sqrt(variance))); }
