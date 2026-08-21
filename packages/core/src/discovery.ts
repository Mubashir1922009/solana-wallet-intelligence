import { newId, stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { CopyabilityEvaluation } from "./copyability.js";
import type { CrowdingObservation } from "./crowding.js";
import type { IntelligenceStore } from "./store.js";
import type { MarketObservation } from "./market.js";
import type { MarketQuoteRequest, MarketQuoteResult } from "./market.js";
import type { CandidateDiscovery, ForwardReturnObservation, WalletReputationSnapshot } from "./runtime-domain.js";

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
  insertMarketObservation(observation: MarketObservation): Promise<void>;
  getCopyabilityBySourceTransaction(signature: string): Promise<CopyabilityEvaluation | null>;
  getMarketObservation(id: string): Promise<MarketObservation | null>;
  enqueueRuntimeJob(job: import("./runtime-domain.js").RuntimeJob): Promise<"inserted" | "duplicate">;
}
export interface ForwardResearchQuoteProvider { readonly enabled: boolean; getQuote(request: MarketQuoteRequest): Promise<MarketQuoteResult> }

export class ForwardReturnResearchService {
  constructor(private readonly store: ForwardResearchStore, private readonly quotes: ForwardResearchQuoteProvider, private readonly options: { windowsMs: number[]; stableMint: string; stableDecimals: number }) {}
  async schedule(input: { wallet: string; transactionSignature: string; tokenMint: string; tokenRawAmount: bigint; tokenDecimals: number; entry: MarketObservation }): Promise<void> {
    if (!this.quotes.enabled) return;
    const scheduledAt = new Date().toISOString();
    for (const windowMs of this.options.windowsMs) {
      const requestedAt = new Date(Date.parse(scheduledAt) + windowMs).toISOString();
      await this.store.enqueueRuntimeJob({ id: newId(), type: "FORWARD_RETURN", payload: { wallet: input.wallet, transactionSignature: input.transactionSignature, tokenMint: input.tokenMint, tokenRawAmount: input.tokenRawAmount.toString(), tokenDecimals: input.tokenDecimals, entryMarketObservationId: input.entry.id, windowMs, requestedAt }, status: "PENDING", runAt: requestedAt, createdAt: scheduledAt, startedAt: null, completedAt: null, attempts: 0, maxAttempts: 8, leaseOwner: null, leaseExpiresAt: null, lastError: null, idempotencyKey: `forward-job:${input.transactionSignature}:${input.wallet}:${windowMs}` });
    }
  }
  shutdown(): void { /* Scheduling is PostgreSQL-durable; no process-local timers exist. */ }
  async observeDurableJob(payload: unknown, observedAt = new Date().toISOString()): Promise<ForwardReturnObservation> {
    const input = durableForwardPayload.parse(payload); const entry = await this.store.getMarketObservation(input.entryMarketObservationId);
    if (entry === null) return this.persistMissing(input, observedAt);
    return this.observeWindow({ wallet: input.wallet, transactionSignature: input.transactionSignature, tokenMint: input.tokenMint, tokenRawAmount: BigInt(input.tokenRawAmount), tokenDecimals: input.tokenDecimals, entry }, input.windowMs, observedAt, input.requestedAt);
  }
  async observeWindow(input: { wallet: string; transactionSignature: string; tokenMint: string; tokenRawAmount: bigint; tokenDecimals: number; entry: MarketObservation }, windowMs: number, observedAt = new Date().toISOString(), requestedAt: string | null = null): Promise<ForwardReturnObservation> {
    let forward: MarketObservation | null = null;
    try {
      const result = await this.quotes.getQuote({ inputMint: input.tokenMint, outputMint: this.options.stableMint, inputRawAmount: input.tokenRawAmount, inputDecimals: input.tokenDecimals, outputDecimals: this.options.stableDecimals });
      forward = result.observation;
      await this.store.insertMarketObservation(forward);
    } catch { /* A missing provider observation is persisted explicitly below. */ }
    const observation = { ...evaluateForwardReturn(input.wallet, input.transactionSignature, input.tokenMint, windowMs, input.entry, forward, observedAt), requestedAt, latenessMs: requestedAt === null ? null : Math.max(0, Date.parse(observedAt) - Date.parse(requestedAt)) };
    await this.store.insertForwardReturnObservation(observation);
    await this.refreshReputation(input.wallet, input.transactionSignature, observedAt);
    return observation;
  }
  private async persistMissing(input: z.infer<typeof durableForwardPayload>, observedAt: string): Promise<ForwardReturnObservation> { const observation: ForwardReturnObservation = { ...evaluateForwardReturn(input.wallet, input.transactionSignature, input.tokenMint, input.windowMs, null, null, observedAt), requestedAt: input.requestedAt, latenessMs: Math.max(0, Date.parse(observedAt) - Date.parse(input.requestedAt)) }; await this.store.insertForwardReturnObservation(observation); await this.refreshReputation(input.wallet, input.transactionSignature, observedAt); return observation; }
  private async refreshReputation(wallet: string, transactionSignature: string, observedAt: string): Promise<void> { const copyability = await this.store.getCopyabilityBySourceTransaction(transactionSignature); const reputation = calculateWalletReputation(wallet, await this.store.listForwardReturnObservations(wallet), copyability === null ? [] : [copyability], [], observedAt); await this.store.upsertWalletReputation(reputation); }
}

import { z } from "zod";
const durableForwardPayload = z.object({ wallet: z.string(), transactionSignature: z.string(), tokenMint: z.string(), tokenRawAmount: z.string().regex(/^\d+$/), tokenDecimals: z.number().int().min(0).max(255), entryMarketObservationId: z.string(), windowMs: z.number().int().positive(), requestedAt: z.iso.datetime({ offset: true }) });

export function evaluateForwardReturn(wallet: string, transactionSignature: string, tokenMint: string, windowMs: number, entry: MarketObservation | null, forward: MarketObservation | null, observedAt: string): ForwardReturnObservation {
  let status: ForwardReturnObservation["status"] = "VALID_OBSERVATION";
  let followerReturn: number | null = null;
  if (forward === null || entry === null) status = "MISSING_OBSERVATION";
  else if (!entry.routeAvailable || !forward.routeAvailable) status = "NO_ROUTE";
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

export function calculateWalletReputation(wallet: string, forward: ForwardReturnObservation[], copyability: CopyabilityEvaluation[], crowding: CrowdingObservation[], calculatedAt: string, rules: ReputationRules = PROVISIONAL_REPUTATION_RULES): WalletReputationSnapshot {
  const returns = forward.filter((item) => item.status === "VALID_OBSERVATION" && item.followerReturn !== null).map((item) => Math.max(-rules.returnCap, Math.min(rules.returnCap, item.followerReturn ?? 0)));
  const medianFollowerReturn = median(returns);
  const deterioration = copyability.flatMap((item) => item.entryPriceDeteriorationBps === null ? [] : [item.entryPriceDeteriorationBps]);
  const copyable = copyability.filter((item) => item.status === "KNOWN" && (item.entryPriceDeteriorationBps ?? Number.POSITIVE_INFINITY) <= 500).length;
  const uncopyable = copyability.length - copyable;
  const crowded = crowding.filter((item) => item.status === "OBSERVED" && (item.windows.at(-1)?.followerWalletCount ?? 0) >= 3).length;
  const sampleSize = returns.length;
  const dataCompleteness = forward.length === 0 ? 0 : returns.length / forward.length;
  const returnQuality = medianFollowerReturn === null ? 0.35 : Math.max(0, Math.min(1, (medianFollowerReturn + 0.25) / 0.5));
  const copyableRate = copyability.length === 0 ? 0.35 : copyable / copyability.length;
  const crowdingPenalty = crowding.length === 0 ? 0.35 : crowded / crowding.length;
  const raw = 100 * (returnQuality * rules.followerReturnWeight + copyableRate * rules.copyabilityWeight + (1 - crowdingPenalty) * rules.crowdingWeight);
  const sampleConfidence = Math.min(1, sampleSize / rules.minimumSample);
  const provisionalScore = raw * sampleConfidence;
  const sortedReturns = [...returns].sort((a, b) => a - b); const trim = sortedReturns.length >= 5 ? Math.floor(sortedReturns.length * 0.1) : 0; const trimmed = sortedReturns.slice(trim, sortedReturns.length - trim || undefined);
  const signalLatencies = copyability.flatMap((item) => item.totalFollowerLatencyMs === null ? [] : [item.totalFollowerLatencyMs]);
  return {
    id: newId(), wallet, observedCandidateBuys: new Set(forward.map((item) => item.transactionSignature)).size, copyableOpportunities: copyable, uncopyableOpportunities: uncopyable,
    medianFollowerReturn, followerReturnDistribution: [...returns].sort((a, b) => a - b), medianDeteriorationBps: median(deterioration),
    earlyEntryFrequency: null, crowdingFrequency: crowding.length === 0 ? null : crowded / crowding.length,
    consistency: returns.length < 2 ? null : consistency(returns), sampleSize, dataCompleteness, provisionalScore, calculatedAt,
    rulesetHash: stableHash(rules as unknown as JsonValue), validCopyabilityEvaluations: copyability.filter((item) => item.status === "KNOWN").length,
    noRouteEvents: forward.filter((item) => item.status === "NO_ROUTE").length, trimmedMeanFollowerReturn: trimmed.length === 0 ? null : trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length,
    downsideDistribution: sortedReturns.filter((value) => value < 0), winRate: returns.length === 0 ? null : returns.filter((value) => value > 0).length / returns.length,
    lossRate: returns.length === 0 ? null : returns.filter((value) => value < 0).length / returns.length, maximumObservedFollowerLoss: sortedReturns[0] ?? null,
    medianSignalLatencyMs: median(signalLatencies), riskGateRejectionFrequency: null, independentTokenSampleSize: new Set(forward.map((item) => item.tokenMint)).size
  };
}

function median(values: number[]): number | null { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); const value = sorted[middle]; if (value === undefined) return null; return sorted.length % 2 === 1 ? value : ((sorted[middle - 1] ?? value) + value) / 2; }
function consistency(values: number[]): number { const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length; return Math.max(0, 1 - Math.min(1, Math.sqrt(variance))); }
