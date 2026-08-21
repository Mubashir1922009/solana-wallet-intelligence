import { describe, expect, it } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { ForwardReturnObservation, MarketObservation } from "./index.js";
import { ForwardReturnResearchService, ObservedDatasetCandidateDiscoveryEngine, calculateWalletReputation, evaluateForwardReturn } from "./discovery.js";

const market = (id: string, inputUsdValue: string | null, outputUsdValue: string | null, routeAvailable = true): MarketObservation => ({ id, provider: "test", provenance: "MARKET_QUOTE", inputMint: "usdc", outputMint: "token", inputRawAmount: 1n, outputRawAmount: 1n, otherAmountThresholdRaw: null, inputDecimals: 6, outputDecimals: 6, priceImpactPct: null, inputUsdValue, outputUsdValue, router: null, feeInformation: null, routeAvailable, requestedAt: "2026-01-01T00:00:00.000Z", receivedAt: "2026-01-01T00:00:00.000Z", providerLatencyMs: 0, transactionIncluded: false });

describe("wallet discovery and reputation", () => {
  it("requires independent token evidence before candidate promotion", async () => {
    const store = new InMemoryIntelligenceStore();
    const engine = new ObservedDatasetCandidateDiscoveryEngine(store, 2);
    expect((await engine.observe("wallet", "token-a", "tx-a", "co-occurrence", "2026-01-01T00:00:00.000Z")).promotedToCandidate).toBe(false);
    expect((await engine.observe("wallet", "token-b", "tx-b", "co-occurrence", "2026-01-02T00:00:00.000Z")).promotedToCandidate).toBe(true);
    expect((await store.getWallet("wallet"))?.status).toBe("candidate");
  });

  it("distinguishes valid, no-route, and missing forward observations", () => {
    const valid = evaluateForwardReturn("w", "tx", "t", 1_000, market("entry", "1", null), market("forward", null, "1.2"), "2026-01-01T00:00:01.000Z");
    expect(valid.status).toBe("VALID_OBSERVATION");
    expect(valid.followerReturn).toBeCloseTo(0.2);
    expect(evaluateForwardReturn("w", "tx", "t", 2_000, market("entry", "1", null), market("forward", null, null, false), "2026-01-01T00:00:02.000Z").status).toBe("NO_ROUTE");
    expect(evaluateForwardReturn("w", "tx", "t", 3_000, null, null, "2026-01-01T00:00:03.000Z").status).toBe("MISSING_OBSERVATION");
  });

  it("caps return outliers and discounts small samples", () => {
    const observations = [10, -10].map((value, index) => ({ id: String(index), wallet: "w", transactionSignature: `tx-${index}`, tokenMint: "t", windowMs: 1_000, status: "VALID_OBSERVATION", entryMarketObservationId: null, forwardMarketObservationId: null, followerReturn: value, observedAt: "2026-01-01T00:00:00.000Z", idempotencyKey: String(index) })) satisfies ForwardReturnObservation[];
    const result = calculateWalletReputation("w", observations, [], [], "2026-01-01T00:00:00.000Z");
    expect(result.followerReturnDistribution).toEqual([-1, 1]);
    expect(result.sampleSize).toBe(2);
    expect(result.provisionalScore).toBeLessThan(20);
  });
  it("hydrates known crowding while preserving unknown samples", () => { const base = { id: "crowd", sourceWallet: "w", sourceTransactionSignature: "tx", tokenMint: "t", observedAt: "2026-01-01T00:00:00.000Z", windows: [{ windowMs: 60_000, followerWalletCount: 4, followerActionCount: 4, delayMs: [] }], observedInputVolumeRaw: null, observedInputMint: null, monitoredWalletCount: 10, expectedCoverageWalletCount: 10, coverageRatio: 1, confidence: "HIGH" as const, status: "OBSERVED" as const, reasons: [] }; const result = calculateWalletReputation("w", [], [], [base, { ...base, id: "unknown", sourceTransactionSignature: "tx-2", status: "UNKNOWN", confidence: "UNKNOWN", coverageRatio: null }], "2026-01-01T00:00:00.000Z"); expect(result).toMatchObject({ crowdingFrequency: 1, knownCrowdingSampleCount: 1, unknownCrowdingSampleCount: 1 }); });

  it("persists scheduled-window research and updates reputation", async () => {
    const store = new InMemoryIntelligenceStore();
    const service = new ForwardReturnResearchService(store, { enabled: true, getQuote: async () => ({ observation: market("forward", null, "1.2"), errorCode: null }) }, { windowsMs: [60_000], stableMint: "usdc", stableDecimals: 6 });
    const observation = await service.observeWindow({ wallet: "w", transactionSignature: "tx", tokenMint: "token", tokenRawAmount: 1n, tokenDecimals: 6, entry: market("entry", "1", null) }, 60_000);
    expect(observation).toMatchObject({ status: "VALID_OBSERVATION" });
    expect(await store.listForwardReturnObservations("w")).toHaveLength(1);
    expect(store.walletReputations.get("w")).toMatchObject({ sampleSize: 1, observedCandidateBuys: 1 });
  });
});
