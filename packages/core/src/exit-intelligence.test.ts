import { describe, expect, it } from "vitest";
import type { PaperPosition, PositionEvent, PositionMark } from "./index.js";
import { OptionalAIExitAnalyzer, recommendExit } from "./exit-intelligence.js";

const position = { id: "position", openedAt: "2026-01-01T00:00:00.000Z", state: "open" } as PaperPosition;
const mark = { id: "mark", positionId: "position", grossUnrealizedPnlUsd: "0.1", routeAvailable: true } as PositionMark;

describe("exit intelligence", () => {
  it("holds when no transparent trigger is present", () => {
    expect(recommendExit(position, mark, null, [], "2026-01-01T00:10:00.000Z")).toMatchObject({ recommendation: "HOLD", reasonCodes: ["NO_EXIT_TRIGGER"] });
  });

  it("raises a strong signal when the route disappears", () => {
    expect(recommendExit(position, { ...mark, routeAvailable: false }, null, [], "2026-01-01T00:10:00.000Z")).toMatchObject({ recommendation: "STRONG_SELL_SIGNAL", reasonCodes: ["MARKET_ROUTE_DISAPPEARED"] });
  });

  it("reacts to source-wallet full sell evidence", () => {
    const sourceEvent = { id: "event", type: "source_wallet_full_sell" } as PositionEvent;
    const result = recommendExit(position, mark, null, [sourceEvent], "2026-01-01T00:10:00.000Z");
    expect(result.recommendation).toBe("STRONG_SELL_SIGNAL");
    expect(result.reasonCodes).toContain("SOURCE_WALLET_FULL_SELL");
  });

  it("preserves manual-control state as an audited input", () => {
    const result = recommendExit({ ...position, state: "manual_control" }, mark, null, [], "2026-01-01T00:10:00.000Z");
    expect(result.inputSnapshot).toMatchObject({ manualControl: true });
  });

  it("keeps optional AI disabled and outside HOLD decisions", async () => {
    const stored: unknown[] = [];
    const analyzer = new OptionalAIExitAnalyzer({ insertAIAnalysis: async (analysis) => { stored.push(analysis); } }, { enabled: false, analyze: async () => { throw new Error("must not run"); } });
    expect(await analyzer.analyze(position, recommendExit(position, mark, null, [], "2026-01-01T00:10:00.000Z"))).toBeNull();
    expect(stored).toEqual([]);
  });

  it("validates and persists secondary analysis without authorizing a sell", async () => {
    const stored: unknown[] = [];
    const recommendation = recommendExit(position, { ...mark, routeAvailable: false }, null, [], "2026-01-01T00:10:00.000Z");
    const analyzer = new OptionalAIExitAnalyzer({ insertAIAnalysis: async (analysis) => { stored.push(analysis); } }, { enabled: true, analyze: async () => ({ modelRequested: "test", modelReturned: "test", value: { summary: "Route evidence supports review.", supportingFactors: ["route unavailable"], contradictingFactors: [], suggestedAction: "CONSIDER_SELL", confidence: 0.7 }, latencyMs: 2, cached: false, errorCode: null }) });
    expect(await analyzer.analyze(position, recommendation)).toMatchObject({ suggestedAction: "CONSIDER_SELL" });
    expect(stored).toHaveLength(1);
    expect(position.state).toBe("open");
  });
});
