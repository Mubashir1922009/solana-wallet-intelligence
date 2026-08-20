import { describe, expect, it } from "vitest";
import type { WalletMetrics } from "./domain.js";
import { scoreWallet } from "./scoring.js";

const now = "2026-08-20T12:00:00.000Z";
function metrics(overrides: Partial<WalletMetrics> = {}): WalletMetrics {
  return {
    walletId: "wallet-id", sampleSize: 40, observedTrades: 40, realizedWins: 25, realizedLosses: 15,
    realizedPnLUsd: "18.25", medianReturn: 0.3, averageReturn: 0.4, hitRate: 0.625,
    earlyEntryScore: 0.8, consistencyScore: 0.75, copyabilityScore: 0.8, crowdingScore: 0.1,
    followerSlippageEstimate: 0.1, suspiciousCoordinationScore: 0.05, dataConfidence: 0.9,
    scoreCalculatedAt: now, ...overrides
  };
}

describe("deterministic wallet scoring", () => {
  it("returns the same output for the same input", () => {
    expect(scoreWallet(metrics(), now, now)).toEqual(scoreWallet(metrics(), now, now));
  });
  it("lowers the score when crowding rises", () => {
    const low = scoreWallet(metrics({ crowdingScore: 0 }), now, now);
    const high = scoreWallet(metrics({ crowdingScore: 1 }), now, now);
    expect(high.total).toBeLessThan(low.total);
    expect(high.reasonCodes).toContain("CROWDING_PENALTY");
  });
  it("prevents an insufficient sample from receiving maximum confidence", () => {
    const score = scoreWallet(metrics({ sampleSize: 1, dataConfidence: 1 }), now, now);
    expect(score.confidence).toBe(0.05);
    expect(score.reasonCodes).toContain("INSUFFICIENT_SAMPLE");
  });
  it("uses a conservative marked default for unknown metrics", () => {
    const score = scoreWallet(metrics({ earlyEntryScore: null, consistencyScore: null, copyabilityScore: null, dataConfidence: null }), now, now);
    expect(score.reasonCodes).toContain("UNKNOWN_METRICS_PRESENT");
    expect(score.components.filter((item) => item.source === "unknown_default").length).toBeGreaterThan(0);
    expect(score.total).toBeLessThan(100);
  });
  it("caps the influence of an absurd average-return outlier", () => {
    const normal = scoreWallet(metrics({ averageReturn: 2 }), now, now);
    const absurd = scoreWallet(metrics({ averageReturn: 1_000_000 }), now, now);
    expect(absurd.total).toBe(normal.total);
    expect(absurd.total).toBeLessThan(100);
  });
});
