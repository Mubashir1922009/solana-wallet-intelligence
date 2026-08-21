import type { IntelligenceStore } from "./store.js";
import type { LiveSubscriptionState } from "./runtime-domain.js";

export interface WalletSubscriptionController {
  readonly name: string;
  subscribe(wallet: string): Promise<boolean>;
  unsubscribe(wallet: string): Promise<void>;
}

export interface LiveSubscriptionStore {
  upsertLiveSubscriptionState(state: LiveSubscriptionState): Promise<void>;
  getLiveSubscriptionState(wallet: string): Promise<LiveSubscriptionState | null>;
  listLiveSubscriptionStates(): Promise<LiveSubscriptionState[]>;
}

export class TrackedWalletManager {
  private readonly priorities = new Map<string, number>();
  private readonly active = new Set<string>();
  constructor(private readonly store: IntelligenceStore & LiveSubscriptionStore, private readonly provider: WalletSubscriptionController, private readonly capacity: number) {}

  async add(wallet: string, priority = 0): Promise<void> {
    const now = new Date().toISOString();
    await this.store.upsertWallet(wallet, now);
    await this.store.setWalletStatus(wallet, "tracking", now);
    this.priorities.set(wallet, priority);
    await this.reconcile();
  }

  async pause(wallet: string): Promise<void> { await this.transition(wallet, "paused"); }
  async resume(wallet: string): Promise<void> { await this.transition(wallet, "tracking"); }
  async reject(wallet: string): Promise<void> { await this.transition(wallet, "rejected"); }
  setPriority(wallet: string, priority: number): Promise<void> { this.priorities.set(wallet, priority); return this.reconcile(); }

  async reconcile(): Promise<void> {
    const wallets = await this.store.listWallets();
    const durableStates = new Map((await this.store.listLiveSubscriptionStates()).map((state) => [state.wallet, state]));
    const priority = (wallet: string): number => this.priorities.get(wallet) ?? durableStates.get(wallet)?.priority ?? 0;
    const tracking = wallets.filter((wallet) => wallet.status === "tracking").sort((a, b) => priority(b.publicKey) - priority(a.publicKey) || a.discoveredAt.localeCompare(b.discoveredAt));
    const selected = new Set(tracking.slice(0, Math.max(0, this.capacity)).map((wallet) => wallet.publicKey));
    for (const wallet of [...this.active]) {
      if (!selected.has(wallet)) { await this.provider.unsubscribe(wallet); this.active.delete(wallet); }
    }
    const now = new Date().toISOString();
    for (const wallet of wallets) {
      const walletPriority = priority(wallet.publicKey);
      let lifecycle: LiveSubscriptionState["lifecycle"];
      let healthy = false;
      if (wallet.status === "tracking" && selected.has(wallet.publicKey)) {
        healthy = this.active.has(wallet.publicKey) || await this.provider.subscribe(wallet.publicKey);
        lifecycle = healthy ? "ACTIVE" : "QUEUED_CAPACITY";
        if (healthy) this.active.add(wallet.publicKey);
      } else if (wallet.status === "tracking") lifecycle = "QUEUED_CAPACITY";
      else if (wallet.status === "paused") lifecycle = "PAUSED";
      else if (wallet.status === "rejected") lifecycle = "REJECTED";
      else lifecycle = "INACTIVE";
      const existing = await this.store.getLiveSubscriptionState(wallet.publicKey);
      await this.store.upsertLiveSubscriptionState({
        wallet: wallet.publicKey, lifecycle, priority: walletPriority, provider: this.provider.name, subscriptionHealthy: healthy,
        lastObservedSignature: existing?.lastObservedSignature ?? null, lastObservedSlot: existing?.lastObservedSlot ?? null,
        lastActivityAt: existing?.lastActivityAt ?? wallet.lastObservedAt, lastSuccessfulIngestionAt: existing?.lastSuccessfulIngestionAt ?? null, updatedAt: now
      });
    }
  }

  private async transition(wallet: string, status: "tracking" | "paused" | "rejected"): Promise<void> {
    const changed = await this.store.setWalletStatus(wallet, status, new Date().toISOString());
    if (changed === null) throw new Error("Wallet not found");
    await this.reconcile();
  }
}
