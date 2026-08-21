import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { classifyWalletAction, newRuntimeJob, normalizeWalletTransaction, scoreWallet, TrackedWalletManager, type SolanaRpcTransaction, type WalletMetrics } from "@intelligence/core";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { ProviderBudgetManager } from "@intelligence/providers";

async function main(): Promise<void> {

const wallet = "Wallet1111111111111111111111111111111111111";
const meme = "Meme111111111111111111111111111111111111111";
const transaction: SolanaRpcTransaction = { signature: "5".repeat(64), slot: 100n, blockTime: "2026-08-20T12:00:00.000Z", version: 0, accountKeys: [{ pubkey: wallet, signer: true, writable: true, source: "transaction" }, { pubkey: "Token11111111111111111111111111111111111111", signer: false, writable: true, source: "transaction" }], feeLamports: 5_000n, error: null, preBalances: [1_000_000_000n, 0n], postBalances: [899_995_000n, 0n], preTokenBalances: [{ accountIndex: 1, mint: meme, owner: wallet, rawAmount: "0", decimals: 6 }], postTokenBalances: [{ accountIndex: 1, mint: meme, owner: wallet, rawAmount: "500000", decimals: 6 }], raw: {} };
const metrics: WalletMetrics = { walletId: "wallet-id", sampleSize: 40, observedTrades: 40, realizedWins: 25, realizedLosses: 15, realizedPnLUsd: "18.25", medianReturn: 0.3, averageReturn: 0.4, hitRate: 0.625, earlyEntryScore: 0.8, consistencyScore: 0.75, copyabilityScore: 0.8, crowdingScore: 0.1, followerSlippageEstimate: 0.1, suspiciousCoordinationScore: 0.05, dataConfidence: 0.9, scoreCalculatedAt: "2026-08-20T12:00:00.000Z" };

const normalization = measure(50_000, () => { classifyWalletAction(normalizeWalletTransaction(transaction, wallet, "2026-08-20T12:00:02.000Z")); });
const scoring = measure(100_000, () => { scoreWallet(metrics, metrics.scoreCalculatedAt, metrics.scoreCalculatedAt); });

const jobStore = new InMemoryIntelligenceStore();
for (let index = 0; index < 5_000; index += 1) await jobStore.enqueueRuntimeJob(newRuntimeJob("TOKEN_DISCOVERY_POLL", { index }, "2026-08-20T12:00:00.000Z", `perf:${index}`));
const claimStarted = performance.now(); let claimed = 0;
while (claimed < 5_000) claimed += (await jobStore.claimRuntimeJobs("perf", "2026-08-20T12:00:00.000Z", "2026-08-20T12:01:00.000Z", 100)).length;
const jobClaimMs = performance.now() - claimStarted;

const sse = new PassThrough(); sse.resume(); const ssePayload = `event: snapshot\ndata: ${JSON.stringify({ positions: [], notifications: [], tokenRisk: [] })}\n\n`;
const sseStarted = performance.now(); for (let index = 0; index < 50_000; index += 1) sse.write(ssePayload); sse.end(); const sseMs = performance.now() - sseStarted;

const watchStore = new InMemoryIntelligenceStore(); let subscriptions = 0;
const watchlist = new TrackedWalletManager(watchStore, { name: "perf", subscribe: async () => { subscriptions += 1; return true; }, unsubscribe: async () => undefined }, 100);
const watchStarted = performance.now(); for (let index = 0; index < 200; index += 1) await watchlist.add(`wallet-${String(index).padStart(4, "0")}`); const watchMs = performance.now() - watchStarted;

const budget = new ProviderBudgetManager({ provider: "perf", concurrency: 1, maximumAttempts: 1 }); const budgetStarted = performance.now();
await Promise.all(Array.from({ length: 50 }, (_, index) => budget.run(`request:${index}`, async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return index; })));
const budgetMs = performance.now() - budgetStarted;

console.info(JSON.stringify({ posture: "LOCAL IN-MEMORY PERFORMANCE VALIDATION; NOT A PRODUCTION CAPACITY CLAIM", normalization: { iterations: normalization.iterations, elapsedMs: normalization.elapsedMs, operationsPerSecond: normalization.operationsPerSecond }, jobClaiming: { jobs: claimed, elapsedMs: jobClaimMs, claimsPerSecond: rate(claimed, jobClaimMs), store: "InMemoryIntelligenceStore (not PostgreSQL)" }, scoring: { iterations: scoring.iterations, elapsedMs: scoring.elapsedMs, operationsPerSecond: scoring.operationsPerSecond }, sseEncodingAndStreamWrite: { messages: 50_000, elapsedMs: sseMs, writesPerSecond: rate(50_000, sseMs), clients: 1 }, subscriptionBookkeeping: { wallets: 200, activeSubscriptions: subscriptions, elapsedMs: watchMs, walletsPerSecond: rate(200, watchMs) }, providerQueue: { operations: 50, elapsedMs: budgetMs, snapshot: budget.snapshot() } }, null, 2));

function measure(iterations: number, operation: () => void): { iterations: number; elapsedMs: number; operationsPerSecond: number } { const started = performance.now(); for (let index = 0; index < iterations; index += 1) operation(); const elapsedMs = performance.now() - started; return { iterations, elapsedMs, operationsPerSecond: rate(iterations, elapsedMs) }; }
function rate(count: number, elapsedMs: number): number { return Math.round(count / (elapsedMs / 1_000)); }
}
void main();
