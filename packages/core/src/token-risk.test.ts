import { describe, expect, it } from "vitest";
import type { MarketObservation, TokenIntelligenceSnapshot } from "./index.js";
import { evaluateTokenRisk } from "./token-risk.js";

function snapshot(overrides: Partial<TokenIntelligenceSnapshot["mint"]> = {}): TokenIntelligenceSnapshot {
  return { id: "snapshot", tokenMint: "mint", supply: null, mint: { tokenProgram: "SPL_TOKEN", tokenProgramAddress: "Tokenkeg", decimals: 6, rawSupply: 1_000n, mintAuthority: null, mintAuthorityKnown: true, freezeAuthority: null, freezeAuthorityKnown: true, initialized: true, extensionsStatus: "NOT_APPLICABLE", slot: 1n, observedAt: "2026-01-01T00:00:00.000Z", provenance: "SOLANA_GET_ACCOUNT_INFO", reasons: [], ...overrides }, largestAccounts: [], concentration: { largestAccountPct: "5", top5AccountsPct: "15", top10AccountsPct: "25", largestKnownOwnerPct: "5", top5KnownOwnersPct: "15", top10KnownOwnersPct: "25", unresolvedAccountPct: "0", observationCoverage: "25", knownOwners: [], observedAccountCount: 10, resolvedAccountCount: 10 }, confidence: "HIGH", completeness: 1, reasons: [], observedAt: "2026-01-01T00:00:00.000Z" };
}
const market: MarketObservation = { id: "market", provider: "test", provenance: "MARKET_QUOTE", inputMint: "usdc", outputMint: "mint", inputRawAmount: 1_000_000n, outputRawAmount: 2_000n, otherAmountThresholdRaw: null, inputDecimals: 6, outputDecimals: 6, priceImpactPct: "0.1", inputUsdValue: "1", outputUsdValue: "1", router: null, feeInformation: null, routeAvailable: true, requestedAt: "2026-01-01T00:00:00.000Z", receivedAt: "2026-01-01T00:00:00.100Z", providerLatencyMs: 100, transactionIncluded: false };

describe("token risk", () => {
  it("is deterministic for identical observations", () => {
    const first = evaluateTokenRisk(snapshot(), market, "2026-01-01T00:00:01.000Z");
    const second = evaluateTokenRisk(snapshot(), market, "2026-01-01T00:00:01.000Z");
    expect(first.totalRisk).toBe(second.totalRisk);
    expect(first.rulesetHash).toBe(second.rulesetHash);
    expect(first.reasonCodes).toEqual(second.reasonCodes);
  });

  it("surfaces active authorities with explicit reason codes", () => {
    const result = evaluateTokenRisk(snapshot({ mintAuthority: "authority" }), market, "2026-01-01T00:00:01.000Z");
    expect(result.reasonCodes).toContain("MINT_AUTHORITY_ACTIVE");
    expect(result.components.find((item) => item.name === "AUTHORITY")?.risk).toBeGreaterThanOrEqual(0.85);
  });

  it("treats unavailable critical data conservatively", () => {
    const incomplete = snapshot({ mintAuthorityKnown: false, freezeAuthorityKnown: false });
    incomplete.concentration.largestAccountPct = null;
    incomplete.concentration.top10AccountsPct = null;
    incomplete.completeness = 0.2;
    const result = evaluateTokenRisk(incomplete, null, "2026-01-01T00:00:01.000Z");
    expect(result.reasonCodes).toEqual(expect.arrayContaining(["TOKEN_AUTHORITY_UNKNOWN", "CONCENTRATION_UNKNOWN", "MARKET_ROUTE_UNKNOWN"]));
    expect(result.confidence).toBe("LOW");
  });
});
