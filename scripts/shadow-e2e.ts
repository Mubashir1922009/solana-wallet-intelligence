import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { calculateWalletReputation, ContinuousShadowRuntime, evaluateCandidate, evaluateTokenRisk, ObservedDatasetCandidateDiscoveryEngine, ShadowRuntimeControl, WalletHistoryBackfillService } from "@intelligence/core";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { JupiterRecentTokenProvider, JupiterSwapV2MarketDataProvider, ProviderBudgetManager, StandardSolanaRpcProvider, StandardSolanaTokenIntelligenceProvider } from "@intelligence/providers";

interface Options { maxRecentTokens: number; maxCandidatesPerToken: number; historyTransactions: number; maximumDurationMs: number }
const stableMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ((args.get("mode") ?? "recent-token-research") !== "recent-token-research") throw new Error("Only --mode recent-token-research is currently supported");
  const options: Options = { maxRecentTokens: bounded(args, "max-recent-tokens", 3, 1, 5), maxCandidatesPerToken: bounded(args, "max-candidates-per-token", 2, 1, 3), historyTransactions: bounded(args, "history-transactions", 5, 1, 20), maximumDurationMs: bounded(args, "duration-seconds", 300, 30, 600) * 1_000 };
  const started = Date.now(); const startedAt = new Date(started).toISOString(); const errors: Array<{ stage: string; code: string }> = [];
  const store = new InMemoryIntelligenceStore();
  const recentBudget = new ProviderBudgetManager({ provider: "jupiter-tokens-v2", concurrency: 1, maximumAttempts: 2, baseBackoffMs: 2_000 });
  const tokenBudget = new ProviderBudgetManager({ provider: "solana-token-rpc", concurrency: 1, maximumAttempts: 2, baseBackoffMs: 500, cacheTtlMs: 30_000 });
  const quoteBudget = new ProviderBudgetManager({ provider: "jupiter-swap-v2", concurrency: 1, maximumAttempts: 2, baseBackoffMs: 2_000, cacheTtlMs: 500 });
  const recentProvider = new JupiterRecentTokenProvider({ authMode: process.env.JUPITER_API_KEY === undefined ? "KEYLESS" : "API_KEY", ...(process.env.JUPITER_API_KEY === undefined ? {} : { apiKey: process.env.JUPITER_API_KEY }) });
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const chain = new StandardSolanaRpcProvider({ rpcUrl, historyConcurrency: 1, maximumAttempts: 2, retryDelayMs: 750 });
  const tokenProvider = new StandardSolanaTokenIntelligenceProvider({ rpcUrl, budget: tokenBudget });
  const jupiter = new JupiterSwapV2MarketDataProvider({ authMode: process.env.JUPITER_API_KEY === undefined ? "KEYLESS" : "API_KEY", ...(process.env.JUPITER_API_KEY === undefined ? {} : { apiKey: process.env.JUPITER_API_KEY }) });
  const quotes = { name: jupiter.name, enabled: jupiter.enabled, getQuote: async (request: Parameters<typeof jupiter.getQuote>[0]) => quoteBudget.run(`quote:${request.inputMint}:${request.outputMint}:${request.inputRawAmount}`, () => jupiter.getQuote(request)) };
  const discovery = new ObservedDatasetCandidateDiscoveryEngine(store); const backfill = new WalletHistoryBackfillService(store, chain); const control = new ShadowRuntimeControl();
  const shadow = new ContinuousShadowRuntime(store, tokenProvider, quotes, control, { executionMode: "SHADOW", paperTradeUsd: "1", maximumTradeUsd: "5", maximumQuoteAgeMs: 2_000, quoteInputMint: stableMint, quoteInputDecimals: 6, crowdingCoverageExpected: 100 });
  let tokens: Awaited<ReturnType<typeof recentProvider.recent>> = [];
  try { tokens = (await recentBudget.run("recent", () => recentProvider.recent())).slice(0, options.maxRecentTokens); } catch (error) { errors.push(issue("recent_tokens", error)); }
  let seeds = 0; let transactionsFetched = 0; let transactionsNormalized = 0; let buys = 0; let sells = 0; let ambiguous = 0; let riskEvaluations = 0; const decisions = { BUY: 0, OBSERVE: 0, REJECT: 0 }; const candidateStates: Record<string, number> = {};
  outer: for (const token of tokens) {
    if (Date.now() - started >= options.maximumDurationMs) { errors.push({ stage: "bounds", code: "MAXIMUM_DURATION_REACHED" }); break; }
    await store.upsertTokenDiscovery(token);
    try {
      const intelligence = await tokenProvider.observeToken(token.mint); await store.insertTokenIntelligenceSnapshot(intelligence); await store.insertTokenRiskEvaluation(evaluateTokenRisk(intelligence, null, new Date().toISOString())); riskEvaluations += 1;
      const candidates = intelligence.largestAccounts.filter((account) => account.resolvedOwner !== null && Number(account.percentageOfSupply ?? "0") >= 1).slice(0, options.maxCandidatesPerToken);
      for (const account of candidates) {
        if (Date.now() - started >= options.maximumDurationMs) break outer;
        const wallet = account.resolvedOwner; if (wallet === null) continue; seeds += 1;
        await discovery.observe(wallet, token.mint, `token-account:${account.tokenAccount}`, "SIGNIFICANT_TOKEN_ACCOUNT_OWNER_SEED_ONLY", intelligence.observedAt);
        try {
          const result = await backfill.backfill(wallet, options.historyTransactions, { maximumTransactions: options.historyTransactions, concurrency: 1 }); transactionsFetched += result.run.transactionsFetched; transactionsNormalized += result.actions.length;
          buys += result.actions.filter((action) => action.classification === "SWAP_BUY").length; sells += result.actions.filter((action) => action.classification === "SWAP_SELL").length; ambiguous += result.actions.filter((action) => action.classification === "COMPLEX_SWAP" || action.classification === "UNKNOWN").length;
          const reputation = calculateWalletReputation(wallet, [], [], [], new Date().toISOString()); await store.upsertWalletReputation(reputation);
          const observations = await store.listCandidateDiscoveries(wallet); const evaluation = evaluateCandidate(wallet, reputation, new Set(observations.map((item) => item.sourceToken)).size, { provenance: "LIVE_READ_ONLY_SHADOW_REHEARSAL", discoveries: observations.map((item) => ({ token: item.sourceToken, reason: item.reason, observedAt: item.lastObservedAt })) }, new Date().toISOString()); await store.upsertCandidateEvaluation(evaluation); candidateStates[evaluation.state] = (candidateStates[evaluation.state] ?? 0) + 1;
          const candidateBuy = result.actions.find((action) => action.classification === "SWAP_BUY" && action.outputMint === token.mint);
          if (candidateBuy !== undefined) { const outcome = await shadow.process({ wallet: candidateBuy.wallet, transactionSignature: candidateBuy.transactionSignature, slot: candidateBuy.slot, blockTime: candidateBuy.chainTime, classification: candidateBuy.classification, confidence: candidateBuy.classificationConfidence, evidence: candidateBuy.evidence, ambiguityReasons: candidateBuy.ambiguityReasons, inputMint: candidateBuy.inputMint, outputMint: candidateBuy.outputMint, inputRawAmount: candidateBuy.inputRawAmount, inputDecimals: candidateBuy.inputDecimals, outputRawAmount: candidateBuy.outputRawAmount, outputDecimals: candidateBuy.outputDecimals, observedAt: candidateBuy.observedAt }); if (outcome.decision !== null) decisions[outcome.decision.decision] += 1; }
        } catch (error) { errors.push(issue("candidate_history", error)); }
      }
    } catch (error) { errors.push(issue("token_intelligence", error)); }
  }
  const completedAt = new Date().toISOString(); const quote = quoteBudget.snapshot(); const report = { dataset: "LIVE_READ_ONLY_SHADOW_REHEARSAL", posture: "MAINNET READ-ONLY SHADOW; NO SIGNING, SUBMISSION, OR LIVE EXECUTION", start: startedAt, end: completedAt, providerModes: { solana: "PUBLIC_OR_CONFIGURED_RPC", jupiterTokens: recentProvider.authMode, jupiterSwap: jupiter.authMode }, bounds: options, recentTokens: tokens.length, candidateSeeds: seeds, candidateEvaluations: Object.values(candidateStates).reduce((a, b) => a + b, 0), candidateStates, transactionsFetched, transactionsNormalized, buysClassified: buys, sellsClassified: sells, ambiguousActions: ambiguous, riskEvaluations, quoteRequests: quote.calls, quoteSuccesses: quote.successfulCalls, noRoute: quote.clientErrors, rateLimited: recentBudget.snapshot().rateLimited + tokenBudget.snapshot().rateLimited + quote.rateLimited, copyabilityEvaluations: (await store.listRecentCopyability(10_000)).length, decisions, shadowPositions: (await store.listPositions()).length, marks: 0, notifications: 0, errors, providerLatency: { recent: recentBudget.snapshot().averageLatencyMs, token: tokenBudget.snapshot().averageLatencyMs, quote: quote.averageLatencyMs }, wallClockDurationMs: Date.now() - started, provenance: { freshTokenMeaning: "JUPITER_FIRST_POOL_CREATION", candidateSeedReason: "SIGNIFICANT_TOKEN_ACCOUNT_OWNER_SEED_ONLY", quoteMeaning: "QUOTE_NOT_FILL" } };
  const directory = join(process.cwd(), "runtime", "reports"); await mkdir(directory, { recursive: true }); const filename = join(directory, `shadow-e2e-${completedAt.replace(/[:.]/g, "-")}.json`); await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.info(JSON.stringify({ ...report, evidenceFile: filename }, null, 2));
}
function parseArgs(values: string[]): Map<string, string> { return new Map(values.map((value) => { const [key = "", entry = "true"] = value.replace(/^--/, "").split("="); return [key, entry]; })); }
function bounded(args: Map<string, string>, key: string, fallback: number, minimum: number, maximum: number): number { const value = Number(args.get(key) ?? fallback); if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`--${key} must be an integer from ${minimum} to ${maximum}`); return value; }
function issue(stage: string, error: unknown): { stage: string; code: string } { return { stage, code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.name : "UNKNOWN" }; }
void main();
