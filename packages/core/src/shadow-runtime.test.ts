import { describe, expect, it } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { ClassifiedWalletAction, MarketObservation, TokenIntelligenceSnapshot } from "./index.js";
import { ContinuousShadowRuntime, ShadowRuntimeControl } from "./shadow-runtime.js";

const walletKey = "Wallet1111111111111111111111111111111111111";
const tokenMint = "Token11111111111111111111111111111111111111";
const stableMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const action = (): ClassifiedWalletAction => ({ classification: "SWAP_BUY", confidence: "HIGH", evidence: ["fixture"], ambiguityReasons: [], inputMint: stableMint, inputRawAmount: 1_000_000n, inputDecimals: 6, outputMint: tokenMint, outputRawAmount: 2_000_000n, outputDecimals: 6, transactionSignature: "9".repeat(64), wallet: walletKey, slot: 10n, blockTime: new Date().toISOString(), observedAt: new Date().toISOString() });
const intelligence = (activeAuthority = false): TokenIntelligenceSnapshot => ({ id: "intel", tokenMint, supply: { rawSupply: 1_000n, decimals: 6, slot: 1n, observedAt: new Date().toISOString(), provenance: "SOLANA_GET_TOKEN_SUPPLY" }, mint: { tokenProgram: "SPL_TOKEN", tokenProgramAddress: "Tokenkeg", decimals: 6, rawSupply: 1_000n, mintAuthority: activeAuthority ? walletKey : null, mintAuthorityKnown: true, freezeAuthority: null, freezeAuthorityKnown: true, initialized: true, extensionsStatus: "NOT_APPLICABLE", slot: 1n, observedAt: new Date().toISOString(), provenance: "SOLANA_GET_ACCOUNT_INFO", reasons: [] }, largestAccounts: [], concentration: { largestAccountPct: "1", top5AccountsPct: "5", top10AccountsPct: "10", largestKnownOwnerPct: "1", top5KnownOwnersPct: "5", top10KnownOwnersPct: "10", unresolvedAccountPct: "0", observationCoverage: "0.1", knownOwners: [], observedAccountCount: 10, resolvedAccountCount: 10 }, confidence: "HIGH", completeness: 1, reasons: [], observedAt: new Date().toISOString() });
const quote = (receivedAt = new Date().toISOString()): MarketObservation => ({ id: "quote", provider: "test", provenance: "MARKET_QUOTE", inputMint: stableMint, outputMint: tokenMint, inputRawAmount: 1_000_000n, outputRawAmount: 2_000_000n, otherAmountThresholdRaw: 1_900_000n, inputDecimals: 6, outputDecimals: 6, priceImpactPct: "0.1", inputUsdValue: "1", outputUsdValue: "1", router: null, feeInformation: null, routeAvailable: true, requestedAt: receivedAt, receivedAt, providerLatencyMs: 1, transactionIncluded: false });

async function storeWithStrongWallet(): Promise<InMemoryIntelligenceStore> {
  const store = new InMemoryIntelligenceStore();
  const wallet = await store.upsertWallet(walletKey, new Date().toISOString());
  await store.setWalletStatus(walletKey, "tracking", new Date().toISOString());
  await store.upsertWalletMetrics({ walletId: wallet.id, sampleSize: 30, observedTrades: 30, realizedWins: 25, realizedLosses: 5, realizedPnLUsd: "10", medianReturn: 0.4, averageReturn: 0.5, hitRate: 0.8, earlyEntryScore: 1, consistencyScore: 1, copyabilityScore: 1, crowdingScore: 0, followerSlippageEstimate: 0, suspiciousCoordinationScore: 0, dataConfidence: 1, scoreCalculatedAt: new Date().toISOString() });
  return store;
}

describe("continuous shadow runtime", () => {
  it("opens a simulated position from an approved live signal and persists context", async () => {
    const store = await storeWithStrongWallet();
    const runtime = new ContinuousShadowRuntime(store, { observeToken: async () => intelligence() }, { enabled: true, getQuote: async () => ({ observation: quote(), errorCode: null }) }, new ShadowRuntimeControl(), { executionMode: "SHADOW", paperTradeUsd: "1", maximumTradeUsd: "5", maximumQuoteAgeMs: 2_000, quoteInputMint: stableMint, quoteInputDecimals: 6, crowdingCoverageExpected: 1, decisionRules: { minimumWalletScore: 1, minimumWalletConfidence: 0.1, maximumTokenRisk: 1, maximumCrowdingRatio: 1, minimumCopyabilityConfidence: "LOW" } });
    const result = await runtime.process(action());
    expect(result.outcome).toBe("OPENED");
    expect(result.position?.tokenRawAmount).toBe(2_000_000n);
    expect(await store.getShadowPositionRecord(result.position?.id ?? "missing")).toMatchObject({ context: { mode: "SHADOW", quoteProvenance: "MARKET_QUOTE" } });
  });

  it("blocks new positions when deterministic token risk exceeds the gate", async () => {
    const store = await storeWithStrongWallet();
    const runtime = new ContinuousShadowRuntime(store, { observeToken: async () => intelligence(true) }, { enabled: true, getQuote: async () => ({ observation: quote(), errorCode: null }) }, new ShadowRuntimeControl(), { executionMode: "SHADOW", paperTradeUsd: "1", maximumTradeUsd: "5", maximumQuoteAgeMs: 2_000, quoteInputMint: stableMint, quoteInputDecimals: 6, crowdingCoverageExpected: 1, decisionRules: { minimumWalletScore: 1, minimumWalletConfidence: 0.1, maximumTokenRisk: 0.1, maximumCrowdingRatio: 1, minimumCopyabilityConfidence: "LOW" } });
    const result = await runtime.process(action());
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasonCodes).toContain("REJECT_TOKEN_AUTHORITY_RISK");
    expect(await store.listPositions()).toEqual([]);
  });

  it("refuses to open from a stale market quote", async () => {
    const store = await storeWithStrongWallet();
    const runtime = new ContinuousShadowRuntime(store, { observeToken: async () => intelligence() }, { enabled: true, getQuote: async () => ({ observation: quote("2020-01-01T00:00:00.000Z"), errorCode: null }) }, new ShadowRuntimeControl(), { executionMode: "SHADOW", paperTradeUsd: "1", maximumTradeUsd: "5", maximumQuoteAgeMs: 2_000, quoteInputMint: stableMint, quoteInputDecimals: 6, crowdingCoverageExpected: 1, decisionRules: { minimumWalletScore: 1, minimumWalletConfidence: 0.1, maximumTokenRisk: 1, maximumCrowdingRatio: 1, minimumCopyabilityConfidence: "LOW" } });
    await expect(runtime.process(action())).rejects.toThrow(/stale/);
    expect(await store.listPositions()).toEqual([]);
  });
});
