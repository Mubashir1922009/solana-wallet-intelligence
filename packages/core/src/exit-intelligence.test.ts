import { describe, expect, it } from "vitest";
import type { PaperPosition, PositionEvent, PositionMark, ShadowPositionRecord, WalletAction } from "./index.js";
import { OptionalAIExitAnalyzer, recommendExit, SourceWalletPositionMonitor } from "./exit-intelligence.js";

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
  it("reconstructs partial and full observed source exits without treating gaps as zero", async () => {
    const tracked = { ...position, id: "tracked", triggerWallet: "source", tokenMint: "mint", state: "open" } as PaperPosition; const events: PositionEvent[] = [];
    const context = { positionId: tracked.id, createdAt: tracked.openedAt, context: { sourceOutputRawAmount: 100n } } as ShadowPositionRecord;
    const monitor = new SourceWalletPositionMonitor({ listPositions: async () => [tracked], getShadowPositionRecord: async () => context, listPositionEvents: async () => events, appendPositionEvent: async (event) => { events.push(event); return "inserted"; } });
    const action = (signature: string, amount: bigint, sourceConfidence: number | null = 0.9): WalletAction => ({ id: signature, wallet: "source", actionType: "swap_sell", classification: "SWAP_SELL", classificationConfidence: sourceConfidence === null ? "UNKNOWN" : "HIGH", evidence: [], ambiguityReasons: [], tokenMint: "mint", inputMint: "mint", outputMint: "stable", inputRawAmount: amount, inputDecimals: 0, outputRawAmount: 1n, outputDecimals: 0, approximateInputUsd: null, approximateOutputUsd: null, transactionSignature: signature, slot: 1n, observedAt: "2026-01-01T00:01:00.000Z", chainTime: null, sourceConfidence });
    expect((await monitor.observe(action("partial", 40n)))[0]).toMatchObject({ type: "source_wallet_partial_sell", details: { reconstructedBalanceRaw: "60", classification: "PARTIAL_SELL" } });
    expect((await monitor.observe(action("full", 60n)))[0]).toMatchObject({ type: "source_wallet_full_sell", details: { reconstructedBalanceRaw: "0", classification: "FULL_OBSERVED_EXIT" } });
    const gapEvents: PositionEvent[] = []; const gapMonitor = new SourceWalletPositionMonitor({ listPositions: async () => [tracked], getShadowPositionRecord: async () => context, listPositionEvents: async () => gapEvents, appendPositionEvent: async (event) => { gapEvents.push(event); return "inserted"; } });
    expect((await gapMonitor.observe(action("gap", 100n, null)))[0]).toMatchObject({ type: "source_activity_ambiguous", details: { reconstructedBalanceRaw: null, classification: "UNKNOWN_REDUCTION" } });
    const transfer = { ...action("transfer", 10n), actionType: "transfer_out" as const, classification: "TRANSFER_OUT" as const };
    expect((await gapMonitor.observe(transfer))[0]).toMatchObject({ type: "source_wallet_transfer_out", details: { classification: "TRANSFER_OUT" } });
  });
});
