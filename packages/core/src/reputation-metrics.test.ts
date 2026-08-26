import { describe, expect, it } from "vitest";
import type { WalletReputationSnapshot } from "./index.js";
import { deriveWalletMetricsFromReputation } from "./discovery.js";
import { scoreWallet } from "./scoring.js";

const strongReputation: WalletReputationSnapshot = { id: "rep-1", wallet: "Wallet1111111111111111111111111111111111111", observedCandidateBuys: 20, copyableOpportunities: 10, uncopyableOpportunities: 0, medianFollowerReturn: 0.4, followerReturnDistribution: Array.from({ length: 20 }, () => 0.4), medianDeteriorationBps: 100, earlyEntryFrequency: null, crowdingFrequency: 0.1, consistency: 0.9, sampleSize: 20, dataCompleteness: 1, provisionalScore: 70, calculatedAt: "2026-01-01T00:00:00.000Z", rulesetHash: "hash", trimmedMeanFollowerReturn: 0.4, downsideDistribution: [], winRate: 1, lossRate: 0, independentTokenSampleSize: 4 };

const weakReputation: WalletReputationSnapshot = { id: "rep-2", wallet: "Wallet2222222222222222222222222222222222222", observedCandidateBuys: 2, copyableOpportunities: 0, uncopyableOpportunities: 0, medianFollowerReturn: null, followerReturnDistribution: [], medianDeteriorationBps: null, earlyEntryFrequency: null, crowdingFrequency: null, consistency: null, sampleSize: 3, dataCompleteness: 0.5, provisionalScore: 17.5, calculatedAt: "2026-01-01T00:00:00.000Z", rulesetHash: "hash" };

describe("reputation to metrics derivation", () => {
  it("maps follower evidence into scoring metrics without inventing values", () => {
    const derived = deriveWalletMetricsFromReputation("wallet-row-1", strongReputation, strongReputation.calculatedAt);
    expect(derived).toMatchObject({ walletId: "wallet-row-1", sampleSize: 20, observedTrades: 20, realizedWins: 20, realizedLosses: 0, realizedPnLUsd: null, medianReturn: 0.4, averageReturn: 0.4, hitRate: 1, earlyEntryScore: null, consistencyScore: 0.9, copyabilityScore: 1, crowdingScore: 0.1, followerSlippageEstimate: 0.01, suspiciousCoordinationScore: null, dataConfidence: 1 });
    expect(derived.scoreCalculatedAt).toBe(strongReputation.calculatedAt);
  });

  it("preserves unknown evidence as null instead of fabricated defaults", () => {
    const derived = deriveWalletMetricsFromReputation("wallet-row-2", weakReputation, "2026-01-01T00:00:00.000Z");
    expect(derived).toMatchObject({ sampleSize: 3, medianReturn: null, hitRate: null, consistencyScore: null, copyabilityScore: null, crowdingScore: null, followerSlippageEstimate: null });
    expect(derived.averageReturn).toBeNull();
  });

  it("falls back to the raw distribution mean when no trimmed mean exists", () => {
    const withoutTrimmedMean: WalletReputationSnapshot = { ...strongReputation };
    delete withoutTrimmedMean.trimmedMeanFollowerReturn;
    const derived = deriveWalletMetricsFromReputation("wallet-row-3", withoutTrimmedMean, "2026-01-01T00:00:00.000Z");
    expect(derived.averageReturn).toBeCloseTo(0.4, 10);
  });

  it("caps the slippage estimate at total deterioration", () => {
    const derived = deriveWalletMetricsFromReputation("wallet-row-4", { ...strongReputation, medianDeteriorationBps: 25_000 }, "2026-01-01T00:00:00.000Z");
    expect(derived.followerSlippageEstimate).toBe(1);
  });

  it("crosses deterministic BUY gates only when follower evidence is genuinely strong", () => {
    const at = "2026-01-02T00:00:00.000Z";
    const strong = scoreWallet(deriveWalletMetricsFromReputation("w", strongReputation, at), strongReputation.calculatedAt, at);
    expect(strong.total).toBeGreaterThanOrEqual(60);
    expect(strong.confidence).toBeGreaterThanOrEqual(0.5);
    const weak = scoreWallet(deriveWalletMetricsFromReputation("w", weakReputation, at), weakReputation.calculatedAt, at);
    expect(weak.total).toBeLessThan(60);
  });
});
