import { describe, expect, it } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { Signal } from "./domain.js";
import { TransactionIngestionService } from "./ingestion.js";

describe("event ingestion idempotency", () => {
  it("ignores a repeated transaction signature", async () => {
    const store = new InMemoryIntelligenceStore();
    const service = new TransactionIngestionService(store);
    const event = { signature: "signature-1", slot: 10n, blockTime: null, status: "succeeded" as const, feeLamports: 5000n, provider: "fixture", rawPayload: {}, relevantWallets: [], receivedAt: "2026-08-20T12:00:00.000Z" };
    expect((await service.ingest(event)).outcome).toBe("accepted");
    expect((await service.ingest(event)).outcome).toBe("duplicate");
    expect(store.transactions.size).toBe(1);
  });

  it("does not duplicate a signal from a repeated provider event", async () => {
    const store = new InMemoryIntelligenceStore();
    const signal = signalFixture();
    expect(await store.insertSignal(signal)).toBe("inserted");
    expect(await store.insertSignal({ ...signal, id: "second-id" })).toBe("duplicate");
    expect(await store.listSignals()).toHaveLength(1);
  });
});

function signalFixture(): Signal {
  return {
    id: "signal-id", sourceWallet: "wallet", tokenMint: "mint", sourceTransactionSignature: "signature",
    detectedAt: "2026-08-20T12:00:00.000Z", chainEventAt: null, chainSlot: 1n,
    walletScore: { total: 80, confidence: 0.8, components: [], reasonCodes: [], rulesetHash: "hash", calculatedAt: "2026-08-20T12:00:00.000Z" },
    antiCrowdingScore: 0.1, tokenRiskSnapshot: null, decision: "OBSERVE", rejectionReasons: [], confidence: 0.8
  };
}
