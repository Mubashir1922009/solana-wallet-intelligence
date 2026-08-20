import { describe, expect, it } from "vitest";
import type { MarketObservation } from "./market.js";
import type { ClassifiedWalletAction } from "./solana.js";
import { evaluateCopyability } from "./copyability.js";

const action: ClassifiedWalletAction = {
  classification: "SWAP_BUY", confidence: "HIGH", evidence: [], ambiguityReasons: [],
  inputMint: "USDC", inputRawAmount: 1_000_000n, inputDecimals: 6,
  outputMint: "TOKEN", outputRawAmount: 100_000_000n, outputDecimals: 6,
  transactionSignature: "sig", wallet: "wallet", slot: 1n,
  blockTime: "2026-08-20T12:00:00.000Z", observedAt: "2026-08-20T12:00:01.000Z"
};
const quote: MarketObservation = {
  id: "quote", provider: "jupiter", provenance: "MARKET_QUOTE", inputMint: "USDC", outputMint: "TOKEN",
  inputRawAmount: 1_000_000n, outputRawAmount: 80_000_000n, otherAmountThresholdRaw: 79_000_000n,
  inputDecimals: 6, outputDecimals: 6, priceImpactPct: null, inputUsdValue: "1", outputUsdValue: null,
  router: null, feeInformation: null, routeAvailable: true,
  requestedAt: "2026-08-20T12:00:01.500Z", receivedAt: "2026-08-20T12:00:01.550Z", providerLatencyMs: 50, transactionIncluded: false
};
const timestamps = { transactionObservedAt: action.observedAt, normalizationCompletedAt: "2026-08-20T12:00:01.100Z", signalGeneratedAt: "2026-08-20T12:00:01.200Z", decisionAt: "2026-08-20T12:00:01.300Z" };

describe("copyability evaluation", () => {
  it("uses exact base-unit ratios and separates deterioration from improvement", () => {
    const result = evaluateCopyability(action, quote, timestamps, "2026-08-20T12:00:02.000Z");
    expect(result).toMatchObject({ status: "KNOWN", sourceEffectivePrice: "0.01", followerQuotedPrice: "0.0125", entryPriceDeteriorationBps: 2500, entryPriceImprovementBps: 0, detectionLatencyMs: 1000, quoteLatencyMs: 50, totalFollowerLatencyMs: 1550 });
  });

  it("reports unavailable data as unknown rather than zero", () => {
    const result = evaluateCopyability({ ...action, outputRawAmount: null }, null, timestamps, "2026-08-20T12:00:02.000Z");
    expect(result.status).toBe("UNKNOWN");
    expect(result.entryPriceDeteriorationBps).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining(["SOURCE_AMOUNTS_MISSING", "NO_ROUTE"]));
  });
});
