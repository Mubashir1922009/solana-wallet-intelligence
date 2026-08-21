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
}
export interface ForwardResearchQuoteProvider { readonly enabled: boolean; getQuote(request: MarketQuoteRequest): Promise<MarketQuoteResult> }

export class ForwardReturnResearchService {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly store: ForwardResearchStore, private readonly quotes: ForwardResearchQuoteProvider, private readonly options: { windowsMs: number[]; stableMint: string; stableDecimals: number }) {}
  schedule(input: { wallet: string; transactionSignature: string; tokenMint: string; tokenRawAmount: bigint; tokenDecimals: number; entry: MarketObservation }): void {
    if (!this.quotes.enabled) return;
    for (const windowMs of this.options.windowsMs) {
      const timer = setTimeout(() => { this.timers.delete(timer); void this.observeWindow(input, windowMs); }, Math.max(1_000, windowMs));
      this.timers.add(timer);
    }
  }
  shutdown(): void { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  async observeWindow(input: { wallet: string; transactionSignature: string; tokenMint: string; tokenRawAmount: bigint; tokenDecimals: number; entry: MarketObservation }, windowMs: number, observedAt = new Date().toISOString()): Promise<ForwardReturnObservation> {
    let forward: MarketObservation | null = null;
    try {
      const result = await this.quotes.getQuote({ inputMint: input.tokenMint, outputMint: this.options.stableMint, inputRawAmount: input.tokenRawAmount, inputDecimals: input.tokenDecimals, outputDecimals: this.options.stableDecimals });
      forward = result.observation;
      await this.store.insertMarketObservation(forward);
    } catch { /* A missing provider observation is persisted explicitly below. */ }
    const observation = evaluateForwardReturn(input.wallet, input.transactionSignature, input.tokenMint, windowMs, input.entry, forward, observedAt);
    await this.store.insertForwardReturnObservation(observation);
    const copyability = await this.store.getCopyabilityBySourceTransaction(input.transactionSignature);
    const reputation = calculateWalletReputation(input.wallet, await this.store.listForwardReturnObservations(input.wallet), copyability === null ? [] : [copyability], [], observedAt);
    await this.store.upsertWalletReputation(reputation);
    return observation;
  }
}

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
  return {
    id: newId(), wallet, observedCandidateBuys: new Set(forward.map((item) => item.transactionSignature)).size, copyableOpportunities: copyable, uncopyableOpportunities: uncopyable,
    medianFollowerReturn, followerReturnDistribution: [...returns].sort((a, b) => a - b), medianDeteriorationBps: median(deterioration),
    earlyEntryFrequency: null, crowdingFrequency: crowding.length === 0 ? null : crowded / crowding.length,
    consistency: returns.length < 2 ? null : consistency(returns), sampleSize, dataCompleteness, provisionalScore, calculatedAt,
    rulesetHash: stableHash(rules as unknown as JsonValue)
  };
}

function median(values: number[]): number | null { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); const value = sorted[middle]; if (value === undefined) return null; return sorted.length % 2 === 1 ? value : ((sorted[middle - 1] ?? value) + value) / 2; }
function consistency(values: number[]): number { const mean = values.reduce((sum, value) => sum + value, 0) / values.length; const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length; return Math.max(0, 1 - Math.min(1, Math.sqrt(variance))); }
