import process from "node:process";
import { createClient } from "redis";
import { parseConfig, safeConfigSummary } from "@intelligence/config";
import { createPostgresStore } from "@intelligence/database";
import { ContinuousShadowRuntime, ForwardReturnResearchService, LiveIngestionCoordinator, ObservedDatasetCandidateDiscoveryEngine, OptionalAIExitAnalyzer, PaperPositionService, PositionMonitor, ShadowRuntimeControl, SourceWalletPositionMonitor, TrackedWalletManager, recommendExit } from "@intelligence/core";
import { ConsoleNotificationProvider, DurableNotificationService, FallbackChainDataProvider, HeliusChainDataProvider, HeliusWebhookLiveChainProvider, JupiterSwapV2MarketDataProvider, OpenRouterAIProvider, ProviderBudgetManager, StandardSolanaLiveChainProvider, StandardSolanaRpcProvider, StandardSolanaTokenIntelligenceProvider, TelegramNotificationProvider, type LiveChainEventProvider } from "@intelligence/providers";
import { buildApp } from "./app.js";

try { process.loadEnvFile?.(".env"); } catch { /* Environment may be supplied by the process manager. */ }

const config = parseConfig(process.env);
const database = createPostgresStore(config.DATABASE_URL);
const redis = createClient({ url: config.REDIS_URL });
redis.on("error", (error: unknown) => console.error(JSON.stringify({ level: "error", component: "redis", message: error instanceof Error ? error.message : "unknown redis error" })));
void redis.connect().catch(() => undefined);

const standardRpc = new StandardSolanaRpcProvider({ rpcUrl: config.SOLANA_RPC_URL, historyConcurrency: config.HISTORY_CONCURRENCY });
const helius = config.HELIUS_API_KEY === undefined ? undefined : new HeliusChainDataProvider({
  rpcUrl: config.HELIUS_RPC_URL,
  apiKey: config.HELIUS_API_KEY
});
const chainProvider = helius === undefined ? standardRpc : new FallbackChainDataProvider(standardRpc, helius, (notice) => {
  console.warn(JSON.stringify({ level: "warn", event: "chain_provider_fallback", ...notice }));
});
const jupiter = new JupiterSwapV2MarketDataProvider({ ...(config.JUPITER_API_KEY === undefined ? {} : { apiKey: config.JUPITER_API_KEY }) });
const quoteBudget = new ProviderBudgetManager({ provider: "jupiter-swap-v2", concurrency: config.PROVIDER_CONCURRENCY, maximumAttempts: 2, cacheTtlMs: 500 });
const budgetedJupiter = { name: jupiter.name, enabled: jupiter.enabled, getQuote: async (request: Parameters<typeof jupiter.getQuote>[0]) => quoteBudget.run(`quote:${request.inputMint}:${request.outputMint}:${request.inputRawAmount}`, async () => jupiter.getQuote(request)) };
const tokenBudget = new ProviderBudgetManager({ provider: "standard-solana-token-rpc", concurrency: config.PROVIDER_CONCURRENCY, maximumAttempts: 3, cacheTtlMs: config.TOKEN_INTELLIGENCE_CACHE_MS });
const tokenProvider = new StandardSolanaTokenIntelligenceProvider({ rpcUrl: config.SOLANA_RPC_URL, budget: tokenBudget });
const runtimeControl = new ShadowRuntimeControl();
const sourcePositionMonitor = new SourceWalletPositionMonitor(database.store);
const discovery = new ObservedDatasetCandidateDiscoveryEngine(database.store);
const openRouter = new OpenRouterAIProvider({ ...(config.OPENROUTER_API_KEY === undefined ? {} : { apiKey: config.OPENROUTER_API_KEY }), model: config.OPENROUTER_MODEL });
const aiExitAnalyzer = new OptionalAIExitAnalyzer(database.store, { enabled: openRouter.enabled, analyze: async (request) => openRouter.analyze(request) });
const shadowExecutionMode = config.EXECUTION_MODE === "SHADOW" ? "SHADOW" : "PAPER";
const notifications = new DurableNotificationService(database.store, [
  new ConsoleNotificationProvider(),
  new TelegramNotificationProvider({ ...(config.TELEGRAM_BOT_TOKEN === undefined ? {} : { botToken: config.TELEGRAM_BOT_TOKEN }), ...(config.TELEGRAM_CHAT_ID === undefined ? {} : { chatId: config.TELEGRAM_CHAT_ID }), ...(config.DASHBOARD_PUBLIC_URL === undefined ? {} : { dashboardUrl: config.DASHBOARD_PUBLIC_URL }) })
]);
const shadow = new ContinuousShadowRuntime(database.store, tokenProvider, budgetedJupiter, runtimeControl, {
  executionMode: shadowExecutionMode,
  paperTradeUsd: config.PAPER_TRADE_USD,
  maximumTradeUsd: config.MAX_TRADE_USD,
  maximumQuoteAgeMs: config.MAX_PAPER_QUOTE_AGE_MS,
  quoteInputMint: config.STABLE_TOKEN_MINT,
  quoteInputDecimals: config.STABLE_TOKEN_DECIMALS,
  crowdingCoverageExpected: config.MAX_LIVE_SUBSCRIPTIONS,
  onOpened: async (position, signal) => {
    const copyability = await database.store.getCopyabilityBySourceTransaction(signal.sourceTransactionSignature);
    await notifications.send("SHADOW_BUY", { positionId: position.id, tokenMint: position.tokenMint, sourceWallet: signal.sourceWallet, walletScore: signal.walletScore.total, tokenRisk: signal.tokenRiskSnapshot?.riskScore ?? null, copyability: copyability?.confidence ?? "UNKNOWN", simulatedUsdAmount: position.simulatedUsdAmount, entryBasis: position.entryMarketSnapshot.fillBasis }, `shadow-buy:${position.id}`);
  }
});
const forwardResearch = new ForwardReturnResearchService(database.store, budgetedJupiter, { windowsMs: config.FORWARD_RETURN_WINDOWS_MS, stableMint: config.STABLE_TOKEN_MINT, stableDecimals: config.STABLE_TOKEN_DECIMALS });
let liveProvider: LiveChainEventProvider;
let heliusWebhookLive: HeliusWebhookLiveChainProvider | null = null;
const coordinator = new LiveIngestionCoordinator(database.store, chainProvider, {
  gapLimit: config.GAP_RECOVERY_LIMIT,
  concurrency: config.HISTORY_CONCURRENCY,
  onAction: async (action) => {
    if (runtimeControl.snapshot().watcherPaused) return;
    try {
      const sourceEvents = await sourcePositionMonitor.observe({ id: "runtime", wallet: action.wallet, actionType: action.classification === "SWAP_SELL" ? "swap_sell" : action.classification === "SWAP_BUY" ? "swap_buy" : action.classification === "TRANSFER_OUT" ? "transfer_out" : action.classification === "TRANSFER_IN" ? "transfer_in" : "unknown", classification: action.classification, classificationConfidence: action.confidence, evidence: action.evidence, ambiguityReasons: action.ambiguityReasons, tokenMint: action.classification === "SWAP_SELL" ? action.inputMint : action.outputMint, inputMint: action.inputMint, outputMint: action.outputMint, inputRawAmount: action.inputRawAmount, inputDecimals: action.inputDecimals, outputRawAmount: action.outputRawAmount, outputDecimals: action.outputDecimals, approximateInputUsd: null, approximateOutputUsd: null, transactionSignature: action.transactionSignature, slot: action.slot, observedAt: action.observedAt, chainTime: action.blockTime, sourceConfidence: action.confidence === "HIGH" ? 1 : action.confidence === "MEDIUM" ? 0.7 : action.confidence === "LOW" ? 0.4 : null });
      for (const event of sourceEvents) await notifications.send("SOURCE_WALLET_SELL", { positionId: event.positionId, sourceWallet: action.wallet, type: event.type, transactionSignature: action.transactionSignature }, `source-exit:${event.id}`);
      const shadowResult = await shadow.process(action);
      if (shadowResult.signal !== null && action.outputMint !== null && action.outputRawAmount !== null && action.outputDecimals !== null) {
        const copyability = await database.store.getCopyabilityBySourceTransaction(action.transactionSignature);
        const entry = copyability?.marketObservationId === null || copyability?.marketObservationId === undefined ? null : await database.store.getMarketObservation(copyability.marketObservationId);
        if (entry !== null) forwardResearch.schedule({ wallet: action.wallet, transactionSignature: action.transactionSignature, tokenMint: action.outputMint, tokenRawAmount: action.outputRawAmount, tokenDecimals: action.outputDecimals, entry });
      }
    }
    catch (error) { console.error(JSON.stringify({ level: "error", component: "shadow_runtime", message: error instanceof Error ? error.message : "unknown error" })); }
  },
  onCandidate: async (wallet, tokenMint, sourceEvent, observedAt) => { await discovery.observe(wallet, tokenMint, sourceEvent, "REPEATED_OBSERVED_COSIGNER", observedAt); },
  onGapRecovered: async (result) => { await notifications.send("WATCHER_GAP_RECOVERED", { wallet: result.wallet, retrieved: result.retrieved, inserted: result.inserted, duplicates: result.duplicates, complete: result.complete }, `gap:${result.wallet}:${Date.now()}`); }
});
if (config.LIVE_PROVIDER_MODE === "HELIUS_WEBHOOK") {
  heliusWebhookLive = new HeliusWebhookLiveChainProvider(async (event) => { await coordinator.processLiveEvent(event); });
  liveProvider = heliusWebhookLive;
} else {
  liveProvider = new StandardSolanaLiveChainProvider({
    wsUrl: config.SOLANA_WS_URL, maximumSubscriptions: config.MAX_LIVE_SUBSCRIPTIONS,
    reconnectBaseMs: config.WS_RECONNECT_BASE_MS, reconnectCapMs: config.WS_RECONNECT_CAP_MS, livenessTimeoutMs: config.WS_LIVENESS_TIMEOUT_MS,
    onEvent: async (event) => { if (!runtimeControl.snapshot().watcherPaused) await coordinator.processLiveEvent(event); },
    onReconnect: async (wallets) => { await coordinator.recoverAll(wallets); await notifications.send("WATCHER_RECONNECTED", { recoveredWallets: wallets.length }, `reconnect:${Date.now()}`); }
  });
}
const watchlist = new TrackedWalletManager(database.store, liveProvider, config.MAX_LIVE_SUBSCRIPTIONS);
const positionService = new PaperPositionService(database.store);
const positionMonitor = budgetedJupiter.enabled ? new PositionMonitor(database.store, budgetedJupiter, {
  intervalMs: config.POSITION_MARK_INTERVAL_MS, maximumQuoteAgeMs: config.MAX_PAPER_QUOTE_AGE_MS, stableMint: config.STABLE_TOKEN_MINT, stableDecimals: config.STABLE_TOKEN_DECIMALS,
  onMark: async (position, mark) => {
    const risks = await database.store.listRecentTokenRiskEvaluations(250);
    const risk = risks.find((item) => item.tokenMint === position.tokenMint) ?? null;
    const events = await database.store.listPositionEvents(position.id, 250);
    const exit = recommendExit(position, mark, risk, events, new Date().toISOString());
    await database.store.insertExitRecommendation(exit);
    await aiExitAnalyzer.analyze(position, exit);
    if (exit.recommendation !== "HOLD" && exit.recommendation !== "INSUFFICIENT_DATA") await positionService.recommendExit(position.id, exit.recommendation);
    if (exit.recommendation === "STRONG_SELL_SIGNAL" || exit.recommendation === "CONSIDER_SELL") await notifications.send("EXIT_RECOMMENDATION", { positionId: position.id, tokenMint: position.tokenMint, estimatedPnlUsd: mark.netUnrealizedPnlUsd ?? mark.grossUnrealizedPnlUsd, tokenRisk: risk?.totalRisk ?? null, recommendation: exit.recommendation, reasons: exit.reasonCodes }, `exit:${exit.id}`);
  },
  onError: async (error, position) => { await notifications.send("SYSTEM_DEGRADED", { component: "position_monitor", positionId: position?.id ?? null, error: error instanceof Error ? error.name : "unknown" }, `position-monitor:${position?.id ?? "runtime"}:${Date.now()}`); }
}) : null;

const app = await buildApp({
  store: database.store,
  logger: true,
  executionMode: config.EXECUTION_MODE,
  network: config.SOLANA_NETWORK,
  chainProvider,
  quoteProvider: budgetedJupiter,
  historyMaximumTransactions: config.HISTORY_MAX_TRANSACTIONS,
  historyConcurrency: config.HISTORY_CONCURRENCY,
  ...(config.HELIUS_WEBHOOK_AUTH === undefined ? {} : { webhookAuth: config.HELIUS_WEBHOOK_AUTH }),
  databasePing: database.ping,
  redisPing: async () => { await redis.ping(); },
  chainPing: async () => { await standardRpc.fetchWalletSignatures({ address: "Vote111111111111111111111111111111111111111", limit: 1 }); },
  openRouterEnabled: config.OPENROUTER_API_KEY !== undefined,
  watchlist,
  liveStatus: () => liveProvider.snapshot(),
  providerBudgets: () => [tokenBudget.snapshot(), quoteBudget.snapshot()],
  runtimeControl: {
    watcherPaused: () => runtimeControl.snapshot().watcherPaused,
    shadowKilled: () => runtimeControl.snapshot().killSwitchActive,
    pauseWatcher: () => runtimeControl.pauseWatcher(), resumeWatcher: () => runtimeControl.resumeWatcher(),
    killShadow: () => { runtimeControl.killShadowEngine(); void notifications.send("KILL_SWITCH", { active: true, scope: "new_shadow_positions" }, `kill:${Date.now()}`); },
    restoreShadow: () => runtimeControl.restoreShadowEngine()
  },
  ...(heliusWebhookLive === null ? {} : { onWebhookEnvelope: async (envelope) => { for (const wallet of envelope.relevantWallets) await heliusWebhookLive?.ingest({ wallet, signature: envelope.signature, slot: envelope.slot, succeeded: envelope.status === "succeeded", receivedAt: envelope.receivedAt, provider: "helius-webhook" }); } })
});

app.log.info(safeConfigSummary(config), "configuration loaded");
await app.listen({ host: config.HOST, port: config.PORT });
void liveProvider.connect().then(async () => { await watchlist.reconcile(); positionMonitor?.start(); }).catch((error: unknown) => {
  app.log.error({ component: "live_watcher", message: error instanceof Error ? error.message : "connection failed" }, "live watcher degraded");
});

const shutdown = async (): Promise<void> => {
  await app.close();
  positionMonitor?.stop();
  forwardResearch.shutdown();
  await liveProvider.shutdown();
  if (redis.isOpen) await redis.quit();
  await database.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
