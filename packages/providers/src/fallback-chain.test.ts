import { describe, expect, it } from "vitest";
import type { ChainDataProvider, WalletHistoryResult } from "./interfaces.js";
import { FallbackChainDataProvider, type FallbackNotice } from "./fallback-chain.js";

function provider(name: string, behavior: { fail?: boolean; complete?: boolean } = {}): ChainDataProvider & { calls: number } {
  return {
    name,
    historyMode: name === "helius" ? "HELIUS_GTFA" : "STANDARD_RPC",
    calls: 0,
    async fetchWalletSignatures() { this.calls += 1; if (behavior.fail) throw new Error(`failed https://rpc.invalid?api-key=secret-${name}`); return { items: [], nextBefore: null }; },
    async fetchWalletHistory(): Promise<WalletHistoryResult> { this.calls += 1; if (behavior.fail) throw new Error("history failed"); return { signatures: [], transactions: [], diagnostics: { mode: this.historyMode, signaturesFetched: 0, transactionsFetched: 0, transactionsMissing: behavior.complete === false ? 1 : 0, failures: [], totalDurationMs: 1, totalRpcLatencyMs: 1, complete: behavior.complete !== false } }; },
    async fetchTransaction() { this.calls += 1; if (behavior.fail) throw new Error("transaction failed"); return null; }
  };
}

describe("health-aware chain provider fallback", () => {
  it("prefers the primary provider when healthy", async () => {
    const primary = provider("helius"); const fallback = provider("standard");
    const chain = new FallbackChainDataProvider(primary, fallback, () => undefined);

    await chain.fetchWalletSignatures({ address: "wallet" });

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
    expect(chain.snapshot().activeProvider).toBe("helius");
  });

  it("uses a cooldown after failure and probes primary again afterward", async () => {
    let now = 1_000; const primaryBehavior = { fail: true }; const primary = provider("helius", primaryBehavior); const fallback = provider("standard"); const notices: FallbackNotice[] = [];
    const chain = new FallbackChainDataProvider(primary, fallback, (notice) => notices.push(notice), { cooldownMs: 5_000, now: () => now });

    await chain.fetchWalletSignatures({ address: "wallet" });
    await chain.fetchWalletSignatures({ address: "wallet" });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(2);
    expect(chain.snapshot()).toMatchObject({ activeProvider: "standard", primaryProvider: "helius" });
    expect(notices[0]?.reason).not.toContain("secret-helius");

    now = 6_001; primaryBehavior.fail = false;
    await chain.fetchWalletSignatures({ address: "wallet" });
    expect(primary.calls).toBe(2);
    expect(chain.snapshot().activeProvider).toBe("helius");
  });

  it("falls back when primary history is explicitly incomplete", async () => {
    const primary = provider("helius", { complete: false }); const fallback = provider("standard");
    const chain = new FallbackChainDataProvider(primary, fallback, () => undefined);

    await chain.fetchWalletHistory({ address: "wallet" });

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });
});
