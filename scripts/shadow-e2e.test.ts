import { describe, expect, it } from "vitest";
import { assertFunnelConsistency, shouldProcessCandidate } from "./shadow-e2e.js";

describe("shadow E2E funnel safety", () => {
  it("does not process insufficient candidates merely to obtain a decision", () => {
    expect(shouldProcessCandidate("INSUFFICIENT_DATA")).toBe(false);
    expect(shouldProcessCandidate("REJECTED")).toBe(false);
    expect(shouldProcessCandidate("TRACK_ELIGIBLE")).toBe(true);
  });

  it("accepts a zero-candidate, zero-buy result", () => {
    expect(() => assertFunnelConsistency({ candidateSeeds: 0, candidateEvaluations: 0, trackEligible: 0, sourceOpportunities: 0, quoteRequests: 0, decisions: { BUY: 0, OBSERVE: 0, REJECT: 0 }, shadowPositions: 0 })).not.toThrow();
  });

  it("rejects positions not backed by a deterministic BUY", () => {
    expect(() => assertFunnelConsistency({ candidateSeeds: 1, candidateEvaluations: 1, trackEligible: 1, sourceOpportunities: 1, quoteRequests: 0, decisions: { BUY: 0, OBSERVE: 1, REJECT: 0 }, shadowPositions: 1 })).toThrow(/require deterministic BUY/);
  });
});
