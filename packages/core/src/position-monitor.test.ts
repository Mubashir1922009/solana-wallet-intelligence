import { describe, expect, it } from "vitest";
import type { MarketObservation, PaperPosition, PositionMark } from "./index.js";
import { calculatePositionMark } from "./position-monitor.js";

const position: PaperPosition = { id: "position", tokenMint: "mint", triggerWallet: "wallet", signalId: "signal", simulatedEntryAt: "2026-01-01T00:00:00.000Z", simulatedEntryPriceUsd: "0.5", simulatedUsdAmount: "1", tokenRawAmount: 2_000_000n, tokenDecimals: 6, feesEstimateUsd: null, slippageEstimateBps: null, entryMarketSnapshot: { source: "test", observedAt: "2026-01-01T00:00:00.000Z", priceUsd: "0.5", executablePriceVerified: true, provenance: "SIMULATED_FILL", estimatedFeeUsd: null, estimatedSlippageBps: null, liquidityUsd: null, fillBasis: "VERIFIED_MARKET_OBSERVATION", inputMint: null, outputMint: null, expectedOutputRaw: null, quotedInputUsdValue: null, quoteRequestedAt: null, quoteReceivedAt: null, quoteLatencyMs: null }, quoteAgeAtDecisionMs: null, state: "open", markPriceUsd: "0.5", unrealizedPnlUsd: "0", realizedPnlUsd: null, exitRecommendation: null, openedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", closedAt: null };
const market: MarketObservation = { id: "market", provider: "test", provenance: "MARKET_QUOTE", inputMint: "mint", outputMint: "usdc", inputRawAmount: 2_000_000n, outputRawAmount: 1_250_000n, otherAmountThresholdRaw: null, inputDecimals: 6, outputDecimals: 6, priceImpactPct: "0.2", inputUsdValue: null, outputUsdValue: "1.25", router: null, feeInformation: { feeUsd: "0.01" }, routeAvailable: true, requestedAt: "2026-01-01T00:00:09.000Z", receivedAt: "2026-01-01T00:00:09.500Z", providerLatencyMs: 500, transactionIncluded: false };

describe("position mark calculation", () => {
  it("calculates gross, net, age, and excursions without fabricated fees", () => {
    const mark = calculatePositionMark(position, market, [], "2026-01-01T00:00:10.000Z", 2_000);
    expect(mark).toMatchObject({ estimatedValueUsd: "1.25", grossUnrealizedPnlUsd: "0.25", netUnrealizedPnlUsd: "0.24", estimatedFeesUsd: "0.01", timeHeldMs: 10_000, quoteAgeMs: 500, confidence: "HIGH" });
  });

  it("carries prior MFE and updates MAE", () => {
    const previous = [{ id: "old", positionId: "position", marketObservationId: null, observedAt: "2026-01-01T00:00:05.000Z", estimatedValueUsd: "1.5", grossUnrealizedPnlUsd: "0.5", netUnrealizedPnlUsd: null, estimatedFeesUsd: null, maxFavorableExcursionUsd: "0.5", maxAdverseExcursionUsd: "0.5", timeHeldMs: 5_000, quoteAgeMs: 0, routeAvailable: true, confidence: "HIGH", provenance: "JUPITER_QUOTE" }] satisfies PositionMark[];
    const mark = calculatePositionMark(position, { ...market, outputUsdValue: "0.8" }, previous, "2026-01-01T00:00:10.000Z", 2_000);
    expect(mark.maxFavorableExcursionUsd).toBe("0.5");
    expect(mark.maxAdverseExcursionUsd).toBe("-0.2");
  });

  it("does not invent a value when the route disappears", () => {
    const mark = calculatePositionMark(position, { ...market, routeAvailable: false, outputUsdValue: null, outputRawAmount: null }, [], "2026-01-01T00:00:10.000Z", 2_000);
    expect(mark.estimatedValueUsd).toBeNull();
    expect(mark.confidence).toBe("LOW");
  });
});
