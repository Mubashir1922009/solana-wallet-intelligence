import { describe, expect, it, vi } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { PROVISIONAL_CANDIDATE_RULES } from "./candidate-evaluation.js";
import { FollowerOutcomeAccumulator, ForwardReturnResearchService } from "./discovery.js";
import type { ClassifiedWalletAction } from "./solana.js";
import type { MarketObservation } from "./market.js";

const wallet = "Wallet1111111111111111111111111111111111111";
const stable = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const token = "Token11111111111111111111111111111111111111";
const at = "2026-08-21T12:00:00.000Z";
const action: ClassifiedWalletAction = { wallet, transactionSignature: "a".repeat(64), slot: 1n, blockTime: at, observedAt: at, classification: "SWAP_BUY", confidence: "HIGH", evidence: ["fixture"], ambiguityReasons: [], inputMint: stable, inputRawAmount: 1_000_000n, inputDecimals: 6, outputMint: token, outputRawAmount: 2_000_000n, outputDecimals: 6 };
const quote = (): MarketObservation => ({ id: "00000000-0000-4000-8000-000000000001", provider: "jupiter-fixture", provenance: "MARKET_QUOTE", inputMint: stable, outputMint: token, inputRawAmount: 1_000_000n, outputRawAmount: 2_000_000n, otherAmountThresholdRaw: null, inputDecimals: 6, outputDecimals: 6, priceImpactPct: "0.01", inputUsdValue: "1", outputUsdValue: "1", router: null, feeInformation: null, routeAvailable: true, requestedAt: at, receivedAt: at, providerLatencyMs: 8, transactionIncluded: false });

describe("research-watch follower evidence", () => {
  it("accumulates follower jobs before eligibility without duplicating a source event", async () => {
    const store = new InMemoryIntelligenceStore(); await store.upsertWallet(wallet, at); await store.upsertCandidateEvaluation({ wallet, state: "RESEARCH_WATCH", sampleSize: 0, independentTokenCount: 2, provisionalScore: null, evidenceAtEvaluation: {}, reasonCodes: ["RESEARCH_ONLY"], evaluatedAt: at, rulesetHash: "rules" });
    const provider = { enabled: true, getQuote: vi.fn(async () => ({ observation: quote(), errorCode: null })) };
    const forward = new ForwardReturnResearchService(store, provider, { windowsMs: [60_000, 300_000, 900_000, 3_600_000], stableMint: stable, stableDecimals: 6 });
    const accumulator = new FollowerOutcomeAccumulator(store, provider, forward, { stableMint: stable, stableDecimals: 6 });
    const first = await accumulator.observeProspectiveBuy(action, at); const second = await accumulator.observeProspectiveBuy(action, at);
    expect(first?.status).toBe("ENTRY_QUOTED"); expect(second?.id).toBe(first?.id); expect(store.followerSourceEvents.size).toBe(1); expect(store.runtimeJobs.size).toBe(4); expect((await store.getWallet(wallet))?.status).toBe("candidate");
  });


  it("does not fabricate decision-time evidence for a recovered historical buy", async () => {
    const store = new InMemoryIntelligenceStore();
    await store.upsertWallet(wallet, at);
    await store.upsertCandidateEvaluation({ wallet, state: "RESEARCH_WATCH", sampleSize: 0, independentTokenCount: 0, provisionalScore: null, evidenceAtEvaluation: {}, reasonCodes: ["RESEARCH_ONLY"], evaluatedAt: at, rulesetHash: "rules" });
    const provider = { enabled: true, getQuote: vi.fn(async () => ({ observation: quote(), errorCode: null })) };
    const forward = new ForwardReturnResearchService(store, provider, { windowsMs: [60_000, 300_000, 900_000, 3_600_000], stableMint: stable, stableDecimals: 6 });
    const accumulator = new FollowerOutcomeAccumulator(store, provider, forward, { stableMint: stable, stableDecimals: 6, maximumProspectiveLagMs: 120_000 });
    const recovered = { ...action, blockTime: "2026-08-21T11:00:00.000Z", observedAt: at };
    const event = await accumulator.observeProspectiveBuy(recovered, at);
    expect(event?.status).toBe("HISTORICAL_UNUSABLE");
    expect(provider.getQuote).not.toHaveBeenCalled();
    expect(store.runtimeJobs.size).toBe(0);
  });

  it("repairs durable forward jobs when a duplicate source event is observed after an interrupted schedule", async () => {
    const store = new InMemoryIntelligenceStore();
    await store.upsertWallet(wallet, at);
    await store.upsertCandidateEvaluation({ wallet, state: "RESEARCH_WATCH", sampleSize: 0, independentTokenCount: 0, provisionalScore: null, evidenceAtEvaluation: {}, reasonCodes: ["RESEARCH_ONLY"], evaluatedAt: at, rulesetHash: "rules" });
    const provider = { enabled: true, getQuote: vi.fn(async () => ({ observation: quote(), errorCode: null })) };
    const forward = new ForwardReturnResearchService(store, provider, { windowsMs: [60_000, 300_000, 900_000, 3_600_000], stableMint: stable, stableDecimals: 6 });
    const accumulator = new FollowerOutcomeAccumulator(store, provider, forward, { stableMint: stable, stableDecimals: 6 });
    const first = await accumulator.observeProspectiveBuy(action, at);
    expect(first?.status).toBe("ENTRY_QUOTED");
    store.runtimeJobs.clear();
    const duplicate = await accumulator.observeProspectiveBuy(action, at);
    expect(duplicate?.id).toBe(first?.id);
    expect(store.runtimeJobs.size).toBe(4);
    expect(provider.getQuote).toHaveBeenCalledTimes(1);
  });

  it("preserves unchanged eligibility thresholds", () => { expect(PROVISIONAL_CANDIDATE_RULES).toEqual({ minimumSampleSize: 8, minimumIndependentTokens: 3, minimumProvisionalScore: 62, maximumCrowdingFrequency: 0.45 }); });
});
