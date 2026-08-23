import { describe, expect, it, vi } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { TrackedWalletManager } from "./watchlist.js";

describe("tracked wallet manager", () => {
  it("subscribes a durable research watch without making it track eligible", async () => { const store = new InMemoryIntelligenceStore(); const provider = { name: "test-live", subscribe: vi.fn(async () => true), unsubscribe: vi.fn(async () => undefined) }; const manager = new TrackedWalletManager(store, provider, 10); await manager.addResearchWatch("candidate"); expect((await store.getWallet("candidate"))?.status).toBe("research_watch"); expect(await store.getLiveSubscriptionState("candidate")).toMatchObject({ lifecycle: "ACTIVE" }); });
  it("persists explicit active and capacity-queued lifecycle states", async () => {
    const store = new InMemoryIntelligenceStore();
    const provider = { name: "test-live", subscribe: vi.fn(async () => true), unsubscribe: vi.fn(async () => undefined) };
    const manager = new TrackedWalletManager(store, provider, 1);
    await manager.add("wallet-a", 10);
    await manager.add("wallet-b", 1);
    expect(await store.getLiveSubscriptionState("wallet-a")).toMatchObject({ lifecycle: "ACTIVE", subscriptionHealthy: true, priority: 10 });
    expect(await store.getLiveSubscriptionState("wallet-b")).toMatchObject({ lifecycle: "QUEUED_CAPACITY", subscriptionHealthy: false });
    expect(provider.subscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes paused wallets and promotes queued capacity", async () => {
    const store = new InMemoryIntelligenceStore();
    const provider = { name: "test-live", subscribe: vi.fn(async () => true), unsubscribe: vi.fn(async () => undefined) };
    const manager = new TrackedWalletManager(store, provider, 1);
    await manager.add("wallet-a", 10); await manager.add("wallet-b", 1); await manager.pause("wallet-a");
    expect(provider.unsubscribe).toHaveBeenCalledWith("wallet-a");
    expect(await store.getLiveSubscriptionState("wallet-a")).toMatchObject({ lifecycle: "PAUSED" });
    expect(await store.getLiveSubscriptionState("wallet-b")).toMatchObject({ lifecycle: "ACTIVE" });
  });
});
