import { describe, expect, it } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { Signal, TradeDecision } from "./domain.js";
import { PaperExecutionService, PaperPositionService } from "./execution.js";

const now = "2026-08-20T12:00:00.000Z";
function signal(decision: Signal["decision"] = "BUY"): Signal {
  return {
    id: "89afd0a7-ae34-47da-9000-41ece253e43d", sourceWallet: "wallet", tokenMint: "mint", sourceTransactionSignature: "sig", detectedAt: now,
    chainEventAt: now, chainSlot: 2n, walletScore: { total: 82, confidence: 0.8, components: [], reasonCodes: [], rulesetHash: "hash", calculatedAt: now },
    antiCrowdingScore: 0.2, tokenRiskSnapshot: null, decision, rejectionReasons: [], confidence: 0.8
  };
}
function tradeDecision(decision: TradeDecision["decision"] = "BUY"): TradeDecision {
  return { id: "decision", signalId: signal().id, decision, reasonCodes: [], parameters: {}, rulesetHash: "hash", createdAt: now };
}
const fill = { market: { observedAt: now, priceUsd: "0.000002", executablePriceVerified: true, provenance: "SIMULATED_FILL", fillBasis: "VERIFIED_MARKET_OBSERVATION", quoteRequestedAt: null, quoteReceivedAt: null, quoteLatencyMs: null, expectedOutputRaw: null, quotedInputUsdValue: null, inputMint: null, outputMint: null, liquidityUsd: "15000", estimatedFeeUsd: "0.01", estimatedSlippageBps: 75, source: "verified-test-fixture" }, tokenDecimals: 6 } as const;

describe("paper execution and sell authorization", () => {
  it("opens an approved signal and persists its entry and event", async () => {
    const store = new InMemoryIntelligenceStore();
    const opened = await new PaperExecutionService(store, "1", "5").openApprovedSignal(signal(), tradeDecision(), fill);
    expect(opened?.simulatedEntryPriceUsd).toBe("0.000002");
    expect(opened?.tokenRawAmount).toBe(500_000_000_000n);
    expect(await store.listRecentEvents(10)).toHaveLength(1);
  });
  it("does not open a rejected signal", async () => {
    const store = new InMemoryIntelligenceStore();
    expect(await new PaperExecutionService(store, "1", "5").openApprovedSignal(signal("REJECT"), tradeDecision("REJECT"), fill)).toBeNull();
    expect(await store.listPositions()).toHaveLength(0);
  });
  it("refuses to fabricate an unavailable fill price", async () => {
    const store = new InMemoryIntelligenceStore();
    const unavailable = { market: { ...fill.market, priceUsd: null, executablePriceVerified: false }, tokenDecimals: 6 };
    await expect(new PaperExecutionService(store, "1", "5").openApprovedSignal(signal(), tradeDecision(), unavailable)).rejects.toThrow(/never fabricated/);
  });
  it("enforces the configured limit above the provider", async () => {
    const store = new InMemoryIntelligenceStore();
    await expect(new PaperExecutionService(store, "5.01", "5").openApprovedSignal(signal(), tradeDecision(), fill)).rejects.toThrow(/exceeds/);
  });
  it("uses a fresh quote as a paper-only fill and rejects a stale quote", async () => {
    const quoteFill = {
      market: { ...fill.market, priceUsd: null, executablePriceVerified: false, provenance: "MARKET_QUOTE" as const, fillBasis: "JUPITER_QUOTE" as const, quoteRequestedAt: new Date(Date.now() - 100).toISOString(), quoteReceivedAt: new Date().toISOString(), expectedOutputRaw: 250_000_000n, quotedInputUsdValue: "1", inputMint: "USDC", outputMint: "mint" },
      tokenDecimals: 6
    };
    const store = new InMemoryIntelligenceStore();
    const opened = await new PaperExecutionService(store, "1", "5", 2_000).openApprovedSignal(signal(), tradeDecision(), quoteFill);
    expect(opened?.tokenRawAmount).toBe(250_000_000n);

    const staleStore = new InMemoryIntelligenceStore();
    const stale = { ...quoteFill, market: { ...quoteFill.market, quoteReceivedAt: new Date(Date.now() - 5_000).toISOString() } };
    await expect(new PaperExecutionService(staleStore, "1", "5", 2_000).openApprovedSignal(signal(), tradeDecision(), stale)).rejects.toThrow(/stale/);
  });
  it("WAIT does not close a position", async () => {
    const store = new InMemoryIntelligenceStore();
    const opened = await new PaperExecutionService(store, "1", "5").openApprovedSignal(signal(), tradeDecision(), fill);
    if (opened === null) throw new Error("Expected a paper position");
    const waited = await new PaperPositionService(store).wait(opened.id);
    expect(waited.state).toBe("open");
  });
  it("an exit recommendation does not authorize or close", async () => {
    const store = new InMemoryIntelligenceStore();
    const opened = await new PaperExecutionService(store, "1", "5").openApprovedSignal(signal(), tradeDecision(), fill);
    if (opened === null) throw new Error("Expected a paper position");
    const recommended = await new PaperPositionService(store).recommendExit(opened.id, "Risk increased");
    expect(recommended.state).toBe("sell_recommended");
    expect(recommended.closedAt).toBeNull();
  });
  it("paper sell authorization closes and audits the position", async () => {
    const store = new InMemoryIntelligenceStore();
    const opened = await new PaperExecutionService(store, "1", "5").openApprovedSignal(signal(), tradeDecision(), fill);
    if (opened === null) throw new Error("Expected a paper position");
    const closed = await new PaperPositionService(store).authorizePaperSell(opened.id, "0.000003");
    expect(closed.state).toBe("closed");
    expect(store.userActions.at(-1)?.action).toBe("sell_authorized");
    await expect(new PaperPositionService(store).wait(opened.id)).rejects.toThrow(/already closed/);
  });
});
