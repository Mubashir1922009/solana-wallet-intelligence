import { randomUUID } from "node:crypto";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { createPostgresStore } from "@intelligence/database";
import type { ChainTransaction, ClassifiedWalletAction, CopyabilityEvaluation, MarketObservation, TokenIntelligenceSnapshot } from "@intelligence/core";
import { calculateWalletReputation, ContinuousShadowRuntime, deriveWalletMetricsFromReputation, evaluateCandidate, ShadowRuntimeControl } from "@intelligence/core";
import { assertFunnelConsistency } from "./shadow-e2e.js";

const stableMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const preconditionsMet = process.env.DATABASE_URL !== undefined && process.env.STAGING_DATABASE_ACK === "wallet-intelligence-shadow";

const d = describe.skipIf(!preconditionsMet);

d("deterministic candidate-to-decision proof against staging PostgreSQL", () => {
  it("promotes seeded follower evidence to a persisted deterministic decision and shadow position", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required for the deterministic decision proof");
    const database = createPostgresStore(databaseUrl);
    try {
      await database.schemaReady();
      const store = database.store;
      const runTag = randomUUID().replace(/-/g, "").slice(0, 12);
      const wallet = `SYNTHPROOF${runTag}`;
      const mintA = `pfminta${runTag}`;
      const mintB = `pfmintb${runTag}`;
      const mintC = `pfmintc${runTag}`;
      const now = new Date().toISOString();
      const walletRecord = await store.upsertWallet(wallet, now);

      for (let index = 0; index < 20; index += 1) {
        const tokenMint = [mintA, mintB, mintC][index % 3] ?? mintA;
        const transactionSignature = `${wallet}-fwd-${index}`;
        await store.insertForwardReturnObservation({ id: randomUUID(), wallet, transactionSignature, tokenMint, windowMs: 60_000, status: "VALID_OBSERVATION", entryMarketObservationId: null, forwardMarketObservationId: null, followerReturn: 0.5, observedAt: now, requestedAt: now, latenessMs: 0, idempotencyKey: `${transactionSignature}:${wallet}:60000` });
      }

      const [forwardReturns, sourceEvents, recentCopyability] = await Promise.all([store.listForwardReturnObservations(wallet), store.listFollowerSourceEvents(wallet), store.listRecentCopyability(10_000)]);
      const sourceTransactions = new Set(sourceEvents.filter((item) => item.status !== "HISTORICAL_UNUSABLE").map((item) => item.sourceTransaction));
      const crowding = await store.listCrowdingObservations([...sourceTransactions]);
      const reputation = calculateWalletReputation(wallet, forwardReturns, recentCopyability.filter((item) => sourceTransactions.has(item.sourceTransactionSignature)), crowding, now);
      await store.upsertWalletReputation(reputation);
      expect(reputation.sampleSize).toBe(20);
      expect(reputation.independentTokenSampleSize).toBe(3);
      expect(reputation.provisionalScore ?? -1).toBeGreaterThanOrEqual(62);

      const evaluation = evaluateCandidate(wallet, reputation, reputation.independentTokenSampleSize ?? 0, { provenance: "DETERMINISTIC_DECISION_PROOF_SYNTHETIC_EVIDENCE", discoveries: [] }, now);
      expect(evaluation.state).toBe("TRACK_ELIGIBLE");
      await store.setWalletStatus(wallet, "tracking", now);
      await store.upsertCandidateEvaluation({ ...evaluation, state: "TRACKING", reasonCodes: [...evaluation.reasonCodes, "PROMOTED_TO_BOUNDED_WATCHLIST"] });

      const runtimeOptions = { executionMode: "SHADOW" as const, paperTradeUsd: "1", maximumTradeUsd: "5", maximumQuoteAgeMs: 120_000, quoteInputMint: stableMint, quoteInputDecimals: 6, crowdingCoverageExpected: 100 };
      const runtime = new ContinuousShadowRuntime(store, { observeToken: async (mint: string) => syntheticIntelligence(mint) }, { enabled: true, getQuote: async (request) => ({ observation: freshQuote(request.outputMint), errorCode: null }) }, new ShadowRuntimeControl(), runtimeOptions);

      await store.upsertWalletMetrics(deriveWalletMetricsFromReputation(walletRecord.id, reputation, now));
      await seedChainTransaction(store, wallet, `${wallet}-sig-observe`, mintA);
      const observedResult = await runtime.process(candidateBuy(wallet, `${wallet}-sig-observe`, mintA));
      expect(observedResult.outcome).toBe("OBSERVED");
      expect(observedResult.decision?.decision).toBe("OBSERVE");
      expect(observedResult.decision?.reasonCodes).toContain("OBSERVE_INSUFFICIENT_WALLET_EVIDENCE");
      expect(observedResult.signal).not.toBeNull();

      const strongReputation = calculateWalletReputation(wallet, await store.listForwardReturnObservations(wallet), syntheticCopyability(wallet, now), [], now);
      const strongMetrics = deriveWalletMetricsFromReputation(walletRecord.id, strongReputation, now);
      expect(strongMetrics.copyabilityScore).toBe(1);
      await store.upsertWalletMetrics(strongMetrics);
      await seedChainTransaction(store, wallet, `${wallet}-sig-buy`, mintB);
      const openedResult = await runtime.process(candidateBuy(wallet, `${wallet}-sig-buy`, mintB));
      expect(openedResult.outcome).toBe("OPENED");
      expect(openedResult.decision?.decision).toBe("BUY");
      expect(openedResult.position?.tokenRawAmount).toBe(2_000_000n);
      const record = await store.getShadowPositionRecord(openedResult.position?.id ?? "missing");
      expect(record).toMatchObject({ context: { mode: "SHADOW", quoteProvenance: "MARKET_QUOTE" } });
      expect((await store.listPositions()).some((position) => position.id === openedResult.position?.id)).toBe(true);

      assertFunnelConsistency({ candidateSeeds: 1, candidateEvaluations: 1, trackEligible: 1, sourceOpportunities: 2, quoteRequests: 2, decisions: { BUY: 1, OBSERVE: 1, REJECT: 0 }, shadowPositions: 1 });
    } finally {
      await database.close();
    }
  }, 120_000);
});

function syntheticCopyability(wallet: string, evaluatedAt: string): CopyabilityEvaluation[] {
  return Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), sourceWallet: wallet, sourceTransactionSignature: `${wallet}-copy-${index}`, tokenMint: `pfcopymint${index}`, marketObservationId: null, status: "KNOWN" as const, sourceEffectivePrice: "1", followerQuotedPrice: "1", entryPriceDeteriorationBps: 100, entryPriceImprovementBps: null, detectionLatencyMs: 50, normalizationLatencyMs: 10, decisionLatencyMs: 10, quoteLatencyMs: 30, totalFollowerLatencyMs: 90, confidence: "HIGH" as const, reasons: [], evaluatedAt }));
}

async function seedChainTransaction(store: { insertTransaction(transaction: ChainTransaction): Promise<"inserted" | "duplicate"> }, wallet: string, signature: string, outputMint: string): Promise<void> {
  const now = new Date().toISOString();
  await store.insertTransaction({ signature, slot: 10n, blockTime: now, status: "succeeded", feeLamports: 5_000n, provider: "deterministic-proof-stub", rawPayload: { synthetic: true, wallet }, observedAt: now, providerReceivedAt: now, normalizationCompletedAt: now, ingestionLatencyMs: 0, relevantWallets: [wallet], tokenBalanceDeltas: [{ owner: wallet, tokenAccount: `${signature}-ta`, mint: outputMint, rawAmount: 2_000_000n, decimals: 6 }], nativeBalanceDeltas: [] });
}

function candidateBuy(wallet: string, signature: string, outputMint: string): ClassifiedWalletAction {
  return { classification: "SWAP_BUY", confidence: "HIGH", evidence: ["DETERMINISTIC_DECISION_PROOF"], ambiguityReasons: [], inputMint: stableMint, inputRawAmount: 1_000_000n, inputDecimals: 6, outputMint, outputRawAmount: 2_000_000n, outputDecimals: 6, transactionSignature: signature, wallet, slot: 10n, blockTime: new Date().toISOString(), observedAt: new Date().toISOString() };
}

function syntheticIntelligence(tokenMint: string): TokenIntelligenceSnapshot {
  return { id: randomUUID(), tokenMint, supply: { rawSupply: 1_000n, decimals: 6, slot: 1n, observedAt: new Date().toISOString(), provenance: "SOLANA_GET_TOKEN_SUPPLY" }, mint: { tokenProgram: "SPL_TOKEN", tokenProgramAddress: "Tokenkeg", decimals: 6, rawSupply: 1_000n, mintAuthority: null, mintAuthorityKnown: true, freezeAuthority: null, freezeAuthorityKnown: true, initialized: true, extensionsStatus: "NOT_APPLICABLE", slot: 1n, observedAt: new Date().toISOString(), provenance: "SOLANA_GET_ACCOUNT_INFO", reasons: [] }, largestAccounts: [], concentration: { largestAccountPct: "1", top5AccountsPct: "5", top10AccountsPct: "10", largestKnownOwnerPct: "1", top5KnownOwnersPct: "5", top10KnownOwnersPct: "10", unresolvedAccountPct: "0", observationCoverage: "0.1", knownOwners: [], observedAccountCount: 10, resolvedAccountCount: 10 }, confidence: "HIGH", completeness: 1, reasons: [], observedAt: new Date().toISOString() };
}

function freshQuote(outputMint: string): MarketObservation {
  const at = new Date().toISOString();
  return { id: randomUUID(), provider: "deterministic-proof-stub", provenance: "MARKET_QUOTE", inputMint: stableMint, outputMint, inputRawAmount: 1_000_000n, outputRawAmount: 2_000_000n, otherAmountThresholdRaw: 1_900_000n, inputDecimals: 6, outputDecimals: 6, priceImpactPct: "0.1", inputUsdValue: "1", outputUsdValue: "1", router: null, feeInformation: null, routeAvailable: true, requestedAt: at, receivedAt: at, providerLatencyMs: 1, transactionIncluded: false };
}
