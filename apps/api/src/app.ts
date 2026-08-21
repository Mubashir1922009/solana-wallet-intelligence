import { createHash, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { PaperPositionService, TransactionIngestionService, WalletHistoryBackfillService, type ExecutionMode, type IntelligenceStore, type ProviderBudgetSnapshot, type ProviderTransactionEnvelope, type SystemComponentHealth, type TrackedWalletManager } from "@intelligence/core";
import type { LiveConnectionSnapshot } from "@intelligence/providers";
import { JupiterMarketError, parseHeliusWebhookPayload, type ChainDataProvider, type QuoteMarketDataProvider } from "@intelligence/providers";
import { RuntimeCounters } from "./metrics.js";

const publicKeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must be a base58 Solana public key");
const idSchema = z.uuid();
const signatureSchema = z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must be a base58 Solana transaction signature");

export interface AppDependencies {
  store: IntelligenceStore;
  executionMode: ExecutionMode;
  network: string;
  webhookAuth?: string;
  databasePing?: () => Promise<void>;
  redisPing?: () => Promise<void>;
  chainPing?: () => Promise<void>;
  openRouterEnabled?: boolean;
  counters?: RuntimeCounters;
  logger?: boolean;
  chainProvider?: ChainDataProvider;
  quoteProvider?: QuoteMarketDataProvider;
  historyMaximumTransactions?: number;
  historyConcurrency?: number;
  watchlist?: TrackedWalletManager;
  liveStatus?: () => LiveConnectionSnapshot;
  providerBudgets?: () => ProviderBudgetSnapshot[];
  runtimeControl?: {
    watcherPaused(): boolean;
    shadowKilled(): boolean;
    pauseWatcher(): void;
    resumeWatcher(): void;
    killShadow(): void;
    restoreShadow(): void;
  };
  onWebhookEnvelope?: (envelope: ProviderTransactionEnvelope) => Promise<void>;
}

function safeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)) as unknown;
}

function authenticated(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

async function check(component: SystemComponentHealth["component"], operation: (() => Promise<void>) | undefined, disabled = false): Promise<SystemComponentHealth> {
  const started = Date.now();
  if (disabled || operation === undefined) return { component, status: "disabled", checkedAt: new Date().toISOString(), detail: "not configured", latencyMs: null };
  try {
    await Promise.race([operation(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("health check timeout")), 1500))]);
    return { component, status: "healthy", checkedAt: new Date().toISOString(), detail: "reachable", latencyMs: Date.now() - started };
  } catch {
    return { component, status: "degraded", checkedAt: new Date().toISOString(), detail: "unreachable", latencyMs: Date.now() - started };
  }
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? false, bodyLimit: 1_048_576 });
  await app.register(cors, { origin: ["http://127.0.0.1:3000", "http://localhost:3000"] });
  const counters = dependencies.counters ?? new RuntimeCounters();
  const ingestion = new TransactionIngestionService(dependencies.store);
  const positions = new PaperPositionService(dependencies.store);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "validation_error", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (error instanceof Error && error.message === "Position not found") return reply.code(404).send({ error: "not_found" });
    if (error instanceof Error && error.message.startsWith("Invalid position transition")) return reply.code(409).send({ error: "invalid_transition", message: error.message });
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", () => ({ status: "ok", service: "wallet-intelligence-api", timestamp: new Date().toISOString() }));

  app.get("/api/system/status", async () => {
    const components = await Promise.all([
      check("chain_provider", dependencies.chainPing), check("database", dependencies.databasePing), check("redis", dependencies.redisPing),
      check("openrouter", undefined, !dependencies.openRouterEnabled),
      Promise.resolve<SystemComponentHealth>({ component: "webhook", status: dependencies.webhookAuth === undefined ? "degraded" : "healthy", checkedAt: new Date().toISOString(), detail: dependencies.webhookAuth === undefined ? "authentication not configured" : "authentication configured", latencyMs: null })
    ]);
    const live = dependencies.liveStatus?.() ?? null;
    return { executionMode: dependencies.executionMode, network: dependencies.network, killSwitchActive: dependencies.runtimeControl?.shadowKilled() ?? false, watcherPaused: dependencies.runtimeControl?.watcherPaused() ?? false, lastProcessedSlot: live?.lastObservedSlot ?? null, queueLagMs: null, counters: counters.snapshot(), live, providerBudgets: dependencies.providerBudgets?.() ?? [], components };
  });

  app.get("/api/live/status", async () => safeJson({ connection: dependencies.liveStatus?.() ?? null, subscriptions: await dependencies.store.listLiveSubscriptionStates(), providerBudgets: dependencies.providerBudgets?.() ?? [] }));

  app.get("/api/wallets", async () => safeJson(await dependencies.store.listWallets()));
  app.get("/api/wallets/:publicKey", async (request, reply) => {
    const { publicKey } = z.object({ publicKey: publicKeySchema }).parse(request.params);
    const wallet = await dependencies.store.getWallet(publicKey);
    return wallet === null ? reply.code(404).send({ error: "not_found" }) : safeJson(wallet);
  });
  app.post("/api/wallets/:publicKey/track", async (request, reply) => {
    const { publicKey } = z.object({ publicKey: publicKeySchema }).parse(request.params);
    const now = new Date().toISOString();
    if (dependencies.watchlist !== undefined) await dependencies.watchlist.add(publicKey);
    else { await dependencies.store.upsertWallet(publicKey, now); await dependencies.store.setWalletStatus(publicKey, "tracking", now); }
    const wallet = await dependencies.store.getWallet(publicKey);
    return reply.code(200).send(safeJson(wallet));
  });
  app.post("/api/wallets/:publicKey/pause", async (request, reply) => {
    const { publicKey } = z.object({ publicKey: publicKeySchema }).parse(request.params);
    if (dependencies.watchlist !== undefined) await dependencies.watchlist.pause(publicKey);
    const wallet = dependencies.watchlist === undefined ? await dependencies.store.setWalletStatus(publicKey, "paused", new Date().toISOString()) : await dependencies.store.getWallet(publicKey);
    return wallet === null ? reply.code(404).send({ error: "not_found" }) : safeJson(wallet);
  });
  app.get("/api/wallets/:publicKey/actions", async (request) => {
    const { publicKey } = z.object({ publicKey: publicKeySchema }).parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(250).default(100) }).parse(request.query);
    return safeJson(await dependencies.store.listWalletActions(publicKey, limit));
  });
  app.post("/api/wallets/:publicKey/backfill", async (request, reply) => {
    const { publicKey } = z.object({ publicKey: publicKeySchema }).parse(request.params);
    const requestOptions = request.body !== undefined && request.body !== null ? request.body : request.query;
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(dependencies.historyMaximumTransactions ?? 100).default(Math.min(50, dependencies.historyMaximumTransactions ?? 100)) }).parse(requestOptions);
    if (dependencies.chainProvider === undefined) return reply.code(503).send({ error: "history_provider_unavailable" });
    try {
      const service = new WalletHistoryBackfillService(dependencies.store, dependencies.chainProvider);
      return safeJson(await service.backfill(publicKey, limit, { maximumTransactions: dependencies.historyMaximumTransactions ?? 100, concurrency: dependencies.historyConcurrency ?? 4 }));
    } catch {
      return reply.code(502).send({ error: "history_provider_error" });
    }
  });

  app.get("/api/transactions/:signature", async (request, reply) => {
    const { signature } = z.object({ signature: signatureSchema }).parse(request.params);
    const transaction = await dependencies.store.getTransaction(signature);
    return transaction === null ? reply.code(404).send({ error: "not_found" }) : safeJson(transaction);
  });

  app.get("/api/signals", async () => safeJson(await dependencies.store.listSignals()));
  app.get("/api/signals/:id", async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const signal = await dependencies.store.getSignal(id);
    return signal === null ? reply.code(404).send({ error: "not_found" }) : safeJson(signal);
  });
  app.get("/api/signals/:id/copyability", async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const signal = await dependencies.store.getSignal(id);
    if (signal === null) return reply.code(404).send({ error: "not_found" });
    const evaluation = await dependencies.store.getCopyabilityBySourceTransaction(signal.sourceTransactionSignature);
    return evaluation === null ? reply.code(404).send({ error: "copyability_not_available" }) : safeJson(evaluation);
  });
  app.get("/api/copyability/recent", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(request.query);
    return safeJson(await dependencies.store.listRecentCopyability(limit));
  });
  app.get("/api/market/quote", async (request, reply) => {
    const query = z.object({
      inputMint: publicKeySchema, outputMint: publicKeySchema, amount: z.string().regex(/^\d+$/).refine((value) => BigInt(value) > 0n),
      inputDecimals: z.coerce.number().int().min(0).max(255).optional(), outputDecimals: z.coerce.number().int().min(0).max(255).optional()
    }).parse(request.query);
    if (dependencies.quoteProvider === undefined || !dependencies.quoteProvider.enabled) return reply.code(503).send({ error: "jupiter_quote_provider_disabled" });
    try {
      const result = await dependencies.quoteProvider.getQuote({ inputMint: query.inputMint, outputMint: query.outputMint, inputRawAmount: BigInt(query.amount), ...(query.inputDecimals === undefined ? {} : { inputDecimals: query.inputDecimals }), ...(query.outputDecimals === undefined ? {} : { outputDecimals: query.outputDecimals }) });
      await dependencies.store.insertMarketObservation(result.observation);
      return safeJson(result);
    } catch (error) {
      if (error instanceof JupiterMarketError && error.code === "RATE_LIMITED") return reply.code(429).send({ error: "jupiter_rate_limited" });
      return reply.code(502).send({ error: "jupiter_quote_failed" });
    }
  });
  app.get("/api/positions", async () => safeJson(await dependencies.store.listPositions()));
  app.get("/api/positions/:id", async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const position = await dependencies.store.getPosition(id);
    return position === null ? reply.code(404).send({ error: "not_found" }) : safeJson(position);
  });
  app.get("/api/positions/:id/intelligence", async (request, reply) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const position = await dependencies.store.getPosition(id);
    if (position === null) return reply.code(404).send({ error: "not_found" });
    const [context, marks, exits, events] = await Promise.all([dependencies.store.getShadowPositionRecord(id), dependencies.store.listPositionMarks(id, 250), dependencies.store.listExitRecommendations(id, 100), dependencies.store.listPositionEvents(id, 250)]);
    return safeJson({ position, context, marks, exitRecommendations: exits, events });
  });
  app.post("/api/positions/:id/wait", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return safeJson(await positions.wait(id));
  });
  app.post("/api/positions/:id/recalculate", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return safeJson(await positions.recalculate(id));
  });
  app.post("/api/positions/:id/manual-control", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return safeJson(await positions.takeManualControl(id));
  });
  app.post("/api/positions/:id/system-control", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return safeJson(await positions.returnSystemControl(id));
  });
  app.post("/api/positions/:id/authorize-paper-sell", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    if (dependencies.executionMode === "LIVE") throw new Error("LIVE execution unavailable");
    return safeJson(await positions.authorizePaperSell(id));
  });
  app.get("/api/events/recent", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    return safeJson(await dependencies.store.listRecentEvents(limit));
  });

  app.get("/api/tokens/:mint/intelligence", async (request, reply) => {
    const { mint } = z.object({ mint: publicKeySchema }).parse(request.params);
    const snapshot = await dependencies.store.getTokenIntelligenceSnapshot(mint);
    return snapshot === null ? reply.code(404).send({ error: "not_found" }) : safeJson(snapshot);
  });
  app.get("/api/token-risk/recent", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(250).default(50) }).parse(request.query);
    return safeJson(await dependencies.store.listRecentTokenRiskEvaluations(limit));
  });
  app.get("/api/notifications", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(250).default(50) }).parse(request.query);
    return safeJson(await dependencies.store.listNotifications(limit));
  });
  app.get("/api/discovery/:publicKey", async (request) => {
    const { publicKey } = z.object({ publicKey: publicKeySchema }).parse(request.params);
    return safeJson({ discoveries: await dependencies.store.listCandidateDiscoveries(publicKey), forwardReturns: await dependencies.store.listForwardReturnObservations(publicKey) });
  });

  app.post("/api/runtime/watcher/pause", (_request, reply) => { if (dependencies.runtimeControl === undefined) return reply.code(503).send({ error: "runtime_unavailable" }); dependencies.runtimeControl.pauseWatcher(); return { watcherPaused: true }; });
  app.post("/api/runtime/watcher/resume", (_request, reply) => { if (dependencies.runtimeControl === undefined) return reply.code(503).send({ error: "runtime_unavailable" }); dependencies.runtimeControl.resumeWatcher(); return { watcherPaused: false }; });
  app.post("/api/runtime/shadow/kill", (_request, reply) => { if (dependencies.runtimeControl === undefined) return reply.code(503).send({ error: "runtime_unavailable" }); dependencies.runtimeControl.killShadow(); return { killSwitchActive: true }; });
  app.post("/api/runtime/shadow/restore", (_request, reply) => { if (dependencies.runtimeControl === undefined) return reply.code(503).send({ error: "runtime_unavailable" }); dependencies.runtimeControl.restoreShadow(); return { killSwitchActive: false }; });

  app.get("/api/stream", async (request, reply) => {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = async (): Promise<void> => {
      const payload = safeJson({ at: new Date().toISOString(), live: dependencies.liveStatus?.() ?? null, positions: await dependencies.store.listPositions(), notifications: await dependencies.store.listNotifications(20), tokenRisk: await dependencies.store.listRecentTokenRiskEvaluations(20) });
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    await send();
    const timer = setInterval(() => { void send().catch(() => reply.raw.end()); }, 5_000);
    request.raw.once("close", () => clearInterval(timer));
    reply.hijack();
  });

  app.post("/api/webhooks/helius", async (request, reply) => {
    if (dependencies.webhookAuth !== undefined && !authenticated(request.headers.authorization, dependencies.webhookAuth)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    counters.increment("events_received");
    let envelopes;
    try {
      envelopes = parseHeliusWebhookPayload(request.body, new Date().toISOString());
    } catch (error) {
      counters.increment("normalization_failures");
      throw error;
    }
    const results = await Promise.all(envelopes.map((envelope) => ingestion.ingest(envelope)));
    if (dependencies.onWebhookEnvelope !== undefined) await Promise.all(envelopes.map((envelope) => dependencies.onWebhookEnvelope?.(envelope)));
    for (const result of results) counters.increment(result.outcome === "duplicate" ? "duplicates_ignored" : "events_processed");
    return reply.code(202).send({ accepted: results.filter((result) => result.outcome === "accepted").length, duplicates: results.filter((result) => result.outcome === "duplicate").length });
  });

  return app;
}
