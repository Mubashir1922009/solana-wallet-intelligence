import { describe, expect, it, vi } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import type { SolanaRpcTransaction } from "./solana.js";
import { LiveIngestionCoordinator } from "./live-runtime.js";

const wallet = "Wallet1111111111111111111111111111111111111";
const token = "Token11111111111111111111111111111111111111";
const transaction = (signature: string, slot: bigint): SolanaRpcTransaction => ({ signature, slot, blockTime: "2026-08-20T12:00:00.000Z", version: 0, accountKeys: [{ pubkey: wallet, signer: true, writable: true, source: "transaction" }, { pubkey: token, signer: false, writable: true, source: "transaction" }], feeLamports: 5_000n, error: null, preBalances: [1_000_000_000n, 0n], postBalances: [899_995_000n, 0n], preTokenBalances: [{ accountIndex: 1, mint: token, owner: wallet, rawAmount: "0", decimals: 6 }], postTokenBalances: [{ accountIndex: 1, mint: token, owner: wallet, rawAmount: "500000", decimals: 6 }], raw: { fixture: true } });

describe("live ingestion and gap recovery", () => {
  it("uses the durable signature boundary, sorts history, and converges duplicates", async () => {
    const store = new InMemoryIntelligenceStore();
    await store.upsertLiveSubscriptionState({ wallet, lifecycle: "ACTIVE", priority: 1, provider: "test", subscriptionHealthy: true, lastObservedSignature: "boundary", lastObservedSlot: 1n, lastActivityAt: null, lastSuccessfulIngestionAt: null, updatedAt: "2026-08-20T11:00:00.000Z" });
    const fetchWalletHistory = vi.fn(async (request: { address: string; limit: number; until?: string; commitment: "confirmed" | "finalized"; concurrency: number }) => { void request; return { transactions: [transaction("7".repeat(64), 3n), transaction("6".repeat(64), 2n)], diagnostics: { complete: true, failures: [] } }; });
    const coordinator = new LiveIngestionCoordinator(store, { name: "test", fetchTransaction: async () => null, fetchWalletHistory }, { gapLimit: 10, concurrency: 2 });
    const first = await coordinator.recoverGap(wallet);
    const second = await coordinator.recoverGap(wallet);
    expect(fetchWalletHistory.mock.calls[0]?.[0]).toMatchObject({ address: wallet, until: "boundary", limit: 10 });
    expect(first).toMatchObject({ retrieved: 2, inserted: 2, duplicates: 0, complete: true });
    expect(second).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(store.transactions.size).toBe(2);
    expect((await store.getLiveSubscriptionState(wallet))?.lastObservedSignature).toBe("7".repeat(64));
  });

  it("processes a live signature idempotently and records its slot", async () => {
    const store = new InMemoryIntelligenceStore();
    const tx = transaction("8".repeat(64), 9n);
    const coordinator = new LiveIngestionCoordinator(store, { name: "test", fetchTransaction: async () => tx, fetchWalletHistory: async () => ({ transactions: [], diagnostics: { complete: true, failures: [] } }) }, { gapLimit: 10, concurrency: 2 });
    const event = { wallet, signature: tx.signature, slot: tx.slot, succeeded: true, receivedAt: "2026-08-20T12:00:01.000Z", provider: "test" };
    expect(await coordinator.processLiveEvent(event)).toBe("inserted");
    expect(await coordinator.processLiveEvent(event)).toBe("duplicate");
    expect(await store.getLiveSubscriptionState(wallet)).toMatchObject({ lastObservedSignature: tx.signature, lastObservedSlot: 9n });
  });
});
