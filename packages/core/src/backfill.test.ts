import { describe, expect, it } from "vitest";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { WalletHistoryBackfillService } from "./backfill.js";
import type { SolanaRpcTransaction } from "./solana.js";

const wallet = "Wallet1111111111111111111111111111111111111";
const token = "Token11111111111111111111111111111111111111";
const transaction: SolanaRpcTransaction = {
  signature: "5".repeat(64), slot: 42n, blockTime: "2026-08-20T12:00:00.000Z", version: 0,
  accountKeys: [
    { pubkey: wallet, signer: true, writable: true, source: "transaction" },
    { pubkey: "TokenAccount1111111111111111111111111111111", signer: false, writable: true, source: "transaction" }
  ],
  feeLamports: 5_000n, error: null,
  preBalances: [1_000_000_000n, 0n], postBalances: [899_995_000n, 0n],
  preTokenBalances: [{ accountIndex: 1, mint: token, owner: wallet, rawAmount: "0", decimals: 6 }],
  postTokenBalances: [{ accountIndex: 1, mint: token, owner: wallet, rawAmount: "500000", decimals: 6 }], raw: { fixture: "synthetic" }
};

describe("wallet history backfill", () => {
  it("continues an incomplete cursor after service restart", async () => { const store = new InMemoryIntelligenceStore(); const before: Array<string | undefined> = []; const provider = { name: "fixture-rpc", historyMode: "STANDARD_RPC", fetchWalletHistory: async (request: { before?: string }) => { before.push(request.before); return { transactions: [], diagnostics: { mode: "STANDARD_RPC", signaturesFetched: 1, transactionsFetched: 0, transactionsMissing: 0, failures: [], complete: before.length > 1, completenessState: before.length > 1 ? "COMPLETE_WITHIN_REQUESTED_WINDOW" as const : "PARTIAL_PAGINATION_LIMIT" as const, continuationCursor: before.length > 1 ? null : "cursor-1" } }; } }; await new WalletHistoryBackfillService(store, provider).backfill(wallet, 10, { maximumTransactions: 10, concurrency: 1 }); await new WalletHistoryBackfillService(store, provider).backfill(wallet, 10, { maximumTransactions: 10, concurrency: 1 }); expect(before).toEqual([undefined, "cursor-1"]); expect((await store.getLatestBackfillRun(wallet))?.attemptCount).toBe(2); });
  it("persists normalized history idempotently and retains metrics on rerun", async () => {
    const store = new InMemoryIntelligenceStore();
    const provider = {
      name: "fixture-rpc", historyMode: "STANDARD_RPC",
      fetchWalletHistory: async () => ({ transactions: [transaction], diagnostics: { mode: "STANDARD_RPC", signaturesFetched: 1, transactionsFetched: 1, transactionsMissing: 0, failures: [], complete: true } })
    };
    const service = new WalletHistoryBackfillService(store, provider);
    const first = await service.backfill(wallet, 10, { maximumTransactions: 100, concurrency: 4 });
    const second = await service.backfill(wallet, 10, { maximumTransactions: 100, concurrency: 4 });
    expect(first.actions[0]).toMatchObject({ classification: "SWAP_BUY", inputMint: "SOL", outputMint: token });
    expect(first.run.actionsPersisted).toBe(1);
    expect(second.run.actionsPersisted).toBe(0);
    expect(second.run.duplicatesIgnored).toBe(2);
    expect(second.metrics).toMatchObject({ sampleSize: 1, observedTrades: 1 });
    expect(store.transactions.size).toBe(1);
    expect(store.walletActions.size).toBe(1);
  });
});
