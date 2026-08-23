import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { newRuntimeJob, PaperPositionService, TransactionIngestionService, workerHealth, type ExecutionMode, type IntelligenceStore, type OperatorSession, type ProviderBudgetSnapshot, type ProviderTelemetrySnapshot, type ProviderTransactionEnvelope, type SystemComponentHealth, type TrackedWalletManager } from "@intelligence/core";
import type { LiveConnectionSnapshot } from "@intelligence/providers";
import { JupiterMarketError, parseHeliusWebhookPayload, type ChainDataProvider, type QuoteMarketDataProvider } from "@intelligence/providers";
import { RuntimeCounters } from "./metrics.js";
import { cookieValue, OperatorAuthService } from "./auth.js";
import type { TelegramShadowController } from "@intelligence/providers";

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
  chainProviderState?: () => { primaryProvider: string; fallbackProvider: string | null; activeProvider: string; primaryDegradedUntil: string | null; heliusConfigured: boolean };
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
  auth?: OperatorAuthService;
  corsAllowedOrigin?: string;
  schemaReady?: () => Promise<void>;
  migrationReadiness?: () => Promise<{ expected: string; current: string | null; ready: boolean }>;
  telegram?: TelegramShadowController;
  production?: boolean;
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
  const allowedOrigins = new Set(["http://127.0.0.1:3000", "http://localhost:3000", ...(dependencies.corsAllowedOrigin === undefined ? [] : [dependencies.corsAllowedOrigin])]);
  await app.register(cors, { origin: (origin, callback) => callback(null, origin === undefined || allowedOrigins.has(origin)), credentials: true });
  const counters = dependencies.counters ?? new RuntimeCounters();
  const ingestion = new TransactionIngestionService(dependencies.store);
  const positions = new PaperPositionService(dependencies.store);
  const sessions = new WeakMap<object, OperatorSession>();

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("x-frame-options", "DENY").header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (dependencies.production === true || process.env.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    const publicPath = request.url === "/health" || request.url === "/livez" || request.url === "/readyz" || request.url.startsWith("/api/auth/login") || request.url.startsWith("/api/webhooks/");
    if (dependencies.auth === undefined || publicPath) return;
    const auth = await dependencies.auth.authenticate(cookieValue(request.headers.cookie, "operator_session"), typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : null);
    if (auth === null) { await dependencies.auth.audit("SESSION_REJECTED", null, request.ip, { path: request.url }); return reply.code(401).send({ error: "unauthorized" }); }
    sessions.set(request, auth.session);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !auth.csrfValid) { await dependencies.auth.audit("CSRF_REJECTED", auth.session.id, request.ip, { path: request.url }); return reply.code(403).send({ error: "csrf_rejected" }); }
  });
  app.addHook("onResponse", async (request, reply) => { const session = sessions.get(request); if (dependencies.auth !== undefined && session !== undefined && !["GET", "HEAD", "OPTIONS"].includes(request.method) && reply.statusCode < 400) await dependencies.auth.audit("OPERATOR_ACTION", session.id, request.ip, { method: request.method, path: request.url, statusCode: reply.statusCode }); });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "validation_error", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (error instanceof Error && error.message === "Position not found") return reply.code(404).send({ error: "not_found" });
    if (error instanceof Error && error.message.startsWith("Invalid position transition")) return reply.code(409).send({ error: "invalid_transition", message: error.message });
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", () => ({ status: "ok", service: "wallet-intelligence-api", timestamp: new Date().toISOString() }));
  app.get("/livez", () => ({ status: "alive", role: "api", timestamp: new Date().toISOString() }));
  app.get("/readyz", async (_request, reply) => { try { await dependencies.databasePing?.(); await dependencies.schemaReady?.(); return { status: "ready", role: "api" }; } catch { return reply.code(503).send({ status: "not_ready", role: "api" }); } });

  app.post("/api/auth/login", async (request, reply) => {
    if (dependencies.auth === undefined) return reply.code(503).send({ error: "authentication_not_configured" });
    const { password } = z.object({ password: z.string().min(1).max(1_024) }).parse(request.body); const result = await dependencies.auth.login(password, request.ip);
    if (result === null) { const limited = await dependencies.auth.isRateLimited(request.ip); return reply.code(limited ? 429 : 401).send({ error: limited ? "login_rate_limited" : "invalid_credentials" }); }
    reply.header("set-cookie", dependencies.auth.cookie(result.sessionToken)); return { authenticated: true, csrfToken: result.csrfToken, expiresAt: result.session.expiresAt };
  });
  app.get("/api/auth/session", async (request) => { const session = sessions.get(request); return { authenticated: session !== undefined, expiresAt: session?.expiresAt ?? null, activeSessions: await dependencies.store.countActiveOperatorSessions(new Date().toISOString()) }; });
  app.post("/api/auth/logout", async (request, reply) => { const session = sessions.get(request); if (session !== undefined && dependencies.auth !== undefined) await dependencies.auth.logout(session); reply.header("set-cookie", dependencies.auth?.clearCookie() ?? "operator_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict"); return { authenticated: false }; });

  app.get("/api/system/status", async () => {
    const components = await Promise.all([
      check("chain_provider", dependencies.chainPing), check("database", dependencies.databasePing), check("redis", dependencies.redisPing),
      check("openrouter", undefined, !dependencies.openRouterEnabled),
      Promise.resolve<SystemComponentHealth>({ component: "webhook", status: dependencies.webhookAuth === undefined ? "degraded" : "healthy", checkedAt: new Date().toISOString(), detail: dependencies.webhookAuth === undefined ? "authentication not configured" : "authentication configured", latencyMs: null })
    ]);
    const live = dependencies.liveStatus?.() ?? null; const chainProviderState = dependencies.chainProviderState?.() ?? null;
    const now = new Date().toISOString(); const [worker, settings, jobs, migration] = await Promise.all([dependencies.store.getWorkerLease(), dependencies.store.getRuntimeSettings(), dependencies.store.listRuntimeJobs(1_000), dependencies.migrationReadiness?.() ?? Promise.resolve(null)]); const pending = jobs.filter((job) => job.status === "PENDING" || job.status === "RUNNING"); const overdue = pending.filter((job) => job.runAt < now); const oldest = [...pending].sort((a, b) => a.runAt.localeCompare(b.runAt))[0] ?? null;
    const budgets = dependencies.providerBudgets?.() ?? []; const chainHealth = components.find((item) => item.component === "chain_provider"); const staticTelemetry = (provider: ProviderTelemetrySnapshot["provider"], health: ProviderTelemetrySnapshot["health"], detail: string): ProviderTelemetrySnapshot => ({ provider, health, callsOrEvents: null, errors: null, rateLimited: null, timeouts: null, reconnects: null, retries: null, averageLatencyMs: null, lastSuccessAt: null, lastFailureAt: null, detail }); const heliusHealth: ProviderTelemetrySnapshot["health"] = chainProviderState?.heliusConfigured !== true ? "DISABLED" : chainProviderState.activeProvider === "helius" && chainHealth?.status === "healthy" ? "HEALTHY" : "DEGRADED"; const providerTelemetry: ProviderTelemetrySnapshot[] = [staticTelemetry("SOLANA_HTTP", chainHealth?.status === "healthy" ? "HEALTHY" : chainHealth?.status === "degraded" ? "DEGRADED" : "DISABLED", chainHealth?.detail ?? "not configured"), live === null ? staticTelemetry("SOLANA_WS", "DISABLED", "owned by worker process") : { ...staticTelemetry("SOLANA_WS", live.status === "CONNECTED" ? "HEALTHY" : "DEGRADED", live.status), callsOrEvents: live.activeSubscriptions, errors: live.malformedMessages, reconnects: live.reconnectCount, lastSuccessAt: live.lastEventAt }, staticTelemetry("HELIUS", heliusHealth, chainProviderState?.heliusConfigured === true ? `active=${chainProviderState.activeProvider}` : "not configured"), ...budgets.map((budget): ProviderTelemetrySnapshot => ({ provider: "JUPITER", health: budget.health, callsOrEvents: budget.calls, errors: budget.clientErrors + budget.serverErrors, rateLimited: budget.rateLimited, timeouts: budget.timeouts, reconnects: null, retries: budget.retries, averageLatencyMs: budget.averageLatencyMs, lastSuccessAt: budget.lastSuccessAt, lastFailureAt: budget.lastFailureAt, detail: budget.provider })), staticTelemetry("TELEGRAM", dependencies.telegram === undefined ? "DISABLED" : "HEALTHY", dependencies.telegram === undefined ? "not configured" : "controller configured"), staticTelemetry("OPENROUTER", dependencies.openRouterEnabled ? "UNAVAILABLE" : "DISABLED", dependencies.openRouterEnabled ? "enabled; no request telemetry in API process" : "not configured")];
    return { executionMode: dependencies.executionMode, network: dependencies.network, killSwitchActive: settings.killSwitch, watcherPaused: !settings.watcherEnabled, runtimeSettings: settings, database: migration, durability: { queueDepth: pending.length, overdueJobs: overdue.length, oldestPendingAt: oldest?.runAt ?? null, oldestPendingType: oldest?.type ?? null }, lastProcessedSlot: live?.lastObservedSlot ?? worker?.lastProcessedSlot ?? null, queueLagMs: oldest === null ? null : Math.max(0, Date.now() - Date.parse(oldest.runAt)), counters: counters.snapshot(), live, worker: { health: workerHealth(worker), lease: worker }, activeChainProvider: chainProviderState?.activeProvider ?? null, providerBudgets: budgets, providerTelemetry, components };
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
    const result = await dependencies.store.enqueueRuntimeJob(newRuntimeJob("WALLET_BACKFILL", { wallet: publicKey, limit }, new Date().toISOString(), `wallet-backfill:${publicKey}:${limit}`, 8));
    return reply.code(202).send({ accepted: true, duplicate: result === "duplicate" });
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
    const requestedAt = new Date().toISOString();
    const position = await positions.recalculate(id);
    await dependencies.store.enqueueRuntimeJob(newRuntimeJob("EXIT_RECALCULATION", { positionId: id }, requestedAt, `dashboard-exit-recalculation:${id}:${requestedAt}`, 5));
    return safeJson(position);
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
    return safeJson({
      discoveries: await dependencies.store.listCandidateDiscoveries(publicKey),
      candidateEvaluation: await dependencies.store.getCandidateEvaluation(publicKey),
      reputation: await dependencies.store.getWalletReputation(publicKey),
      followerSourceEvents: await dependencies.store.listFollowerSourceEvents(publicKey),
      forwardReturns: await dependencies.store.listForwardReturnObservations(publicKey),
      latestBackfill: await dependencies.store.getLatestBackfillRun(publicKey),
    });
  });
  app.get("/api/research", async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    let latest: Record<string, unknown> | null = null;
    try {
      const directory = join(process.cwd(), "runtime", "reports");
      const filename = (await readdir(directory)).filter((name) => /^research-.*\.json$/.test(name)).sort().at(-1);
      if (filename !== undefined) latest = JSON.parse(await readFile(join(directory, filename), "utf8")) as Record<string, unknown>;
    } catch {
      latest = null;
    }
    return safeJson({
      runs: await dependencies.store.listResearchRuns(limit),
      candidates: await dependencies.store.listCandidateEvaluations(limit),
      tokens: await dependencies.store.listTokenDiscoveries(limit),
      sampleSize: typeof latest?.sampleSize === "number" ? latest.sampleSize : null,
      deterministicDecisionOutcomeSampleSize: typeof latest?.deterministicDecisionOutcomeSampleSize === "number" ? latest.deterministicDecisionOutcomeSampleSize : null,
      followerEvidenceSampleSize: typeof latest?.followerEvidenceSampleSize === "number" ? latest.followerEvidenceSampleSize : null,
      followerSourceEventCount: typeof latest?.followerSourceEventCount === "number" ? latest.followerSourceEventCount : null,
      pendingOutcomes: typeof latest?.pendingOutcomes === "number" ? latest.pendingOutcomes : null,
      candidateProgress: Array.isArray(latest?.candidateProgress) ? latest.candidateProgress : [],
      temporalIntegrity: latest?.temporalIntegrity ?? null,
    });
  });
  app.get("/api/e2e/latest", async () => { try { const directory = join(process.cwd(), "runtime", "reports"); const latest = (await readdir(directory)).filter((name) => /^shadow-e2e-.*\.json$/.test(name)).sort().at(-1); if (latest === undefined) return { status: "NOT_RUN", report: null }; const report = JSON.parse(await readFile(join(directory, latest), "utf8")) as Record<string, unknown> & { end?: string; errors?: unknown[]; decisions?: Record<string, number>; wallClockDurationMs?: number; dropReasons?: Record<string, number> }; const funnelKeys = ["recentTokens", "tokenIntelligenceSuccess", "largestAccountAttempts", "largestAccountSuccess", "ownerEvidenceAttempts", "ownerEvidenceSuccess", "earlyParticipantAttempts", "earlyParticipantSuccess", "candidateSeeds", "candidateHistoryAttempts", "candidateHistorySuccess", "historyPartial", "history429", "transactionsFetched", "transactionsNormalized", "candidateEvaluations", "insufficientData", "trackEligible", "sourceOpportunities", "riskEvaluations", "quoteAttempts", "quoteSuccess", "copyabilityValid", "shadowPositions", "marks", "exitRecommendations"] as const; const funnel = Object.fromEntries(funnelKeys.map((key) => [key, typeof report[key] === "number" ? report[key] : null])); return { status: (report.errors?.length ?? 0) === 0 ? "COMPLETED" : "COMPLETED_WITH_PROVIDER_LIMITS", file: latest, completedAt: report.end ?? null, decisions: report.decisions ?? null, funnel, dropReasons: report.dropReasons ?? null, wallClockDurationMs: report.wallClockDurationMs ?? null }; } catch { return { status: "NOT_RUN", report: null }; } });
  app.get("/api/soak/latest", async () => { try { const directory = join(process.cwd(), "runtime", "reports"); const latest = (await readdir(directory)).filter((name) => /^shadow-soak-.*\.json$/.test(name) || name === "shadow-soak-latest.json").sort().at(-1); if (latest === undefined) return { status: "NOT_RUN", report: null }; const report = JSON.parse(await readFile(join(directory, latest), "utf8")) as { completedAt?: string; errors?: unknown[]; mode?: string; storeMode?: string; durationMs?: number; decisions?: Record<string, number> }; return { status: (report.errors?.length ?? 0) === 0 ? "COMPLETED" : "COMPLETED_WITH_ERRORS", file: latest, completedAt: report.completedAt ?? null, mode: report.mode ?? null, storeMode: report.storeMode ?? null, durationMs: report.durationMs ?? null, decisions: report.decisions ?? null }; } catch { return { status: "NOT_RUN", report: null }; } });
  app.get("/api/readiness/latest", async () => { try { const directory = join(process.cwd(), "runtime", "reports"); const latest = (await readdir(directory)).filter((name) => /^readiness-.*\.json$/.test(name)).sort().at(-1); if (latest === undefined) return { status: "NOT_RUN", report: null }; const report = JSON.parse(await readFile(join(directory, latest), "utf8")) as { generatedAt?: string; areas?: Record<string, { status: string; reasons: string[] }> }; return { status: "COMPLETED", file: latest, generatedAt: report.generatedAt ?? null, areas: report.areas ?? null }; } catch { return { status: "NOT_RUN", report: null }; } });
  app.get("/api/security", async () => safeJson({ activeSessions: await dependencies.store.countActiveOperatorSessions(new Date().toISOString()), events: await dependencies.store.listOperatorSecurityEvents(25) }));
  app.get("/api/export/research", async (request) => { const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(1_000).default(250) }).parse(request.query); const [signals, copyability, positionsList, candidates, wallets] = await Promise.all([dependencies.store.listSignals(), dependencies.store.listRecentCopyability(limit), dependencies.store.listPositions(), dependencies.store.listCandidateEvaluations(limit), dependencies.store.listWallets()]); const selectedWallets = wallets.slice(0, Math.min(limit, 100)); const [walletReputation, forwardOutcomes] = await Promise.all([Promise.all(selectedWallets.map((wallet) => dependencies.store.getWalletReputation(wallet.publicKey))), Promise.all(selectedWallets.map((wallet) => dependencies.store.listForwardReturnObservations(wallet.publicKey)))]); return safeJson({ generatedAt: new Date().toISOString(), posture: "SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS", signals: signals.slice(0, limit), copyability, positions: positionsList.slice(0, limit), candidateEvaluations: candidates, walletReputation: walletReputation.filter((item) => item !== null), forwardOutcomes: forwardOutcomes.flat().slice(0, limit) }); });

  const runtimeAction = async (action: "WATCHER_PAUSE" | "WATCHER_RESUME" | "SHADOW_KILL" | "SHADOW_RESTORE"): Promise<void> => { const current = await dependencies.store.getRuntimeSettings(); const now = new Date().toISOString(); const next = { ...current, watcherEnabled: action === "WATCHER_PAUSE" ? false : action === "WATCHER_RESUME" ? true : current.watcherEnabled, shadowEntryEnabled: action === "SHADOW_KILL" ? false : action === "SHADOW_RESTORE" ? true : current.shadowEntryEnabled, killSwitch: action === "SHADOW_KILL" ? true : action === "SHADOW_RESTORE" ? false : current.killSwitch, updatedAt: now, updatedBy: `dashboard:${action}`, revision: current.revision + 1 }; if (!await dependencies.store.updateRuntimeSettings(next)) throw new Error("Runtime settings changed concurrently; retry the action"); await dependencies.store.enqueueRuntimeJob(newRuntimeJob("RUNTIME_CONTROL", { action, settingsRevision: next.revision }, now, `runtime-control:${next.revision}`, 3)); };
  app.post("/api/runtime/watcher/pause", async () => { dependencies.runtimeControl?.pauseWatcher(); await runtimeAction("WATCHER_PAUSE"); return { watcherPaused: true }; });
  app.post("/api/runtime/watcher/resume", async () => { dependencies.runtimeControl?.resumeWatcher(); await runtimeAction("WATCHER_RESUME"); return { watcherPaused: false }; });
  app.post("/api/runtime/shadow/kill", async () => { dependencies.runtimeControl?.killShadow(); await runtimeAction("SHADOW_KILL"); return { killSwitchActive: true }; });
  app.post("/api/runtime/shadow/restore", async () => { dependencies.runtimeControl?.restoreShadow(); await runtimeAction("SHADOW_RESTORE"); return { killSwitchActive: false }; });

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
  app.post("/api/webhooks/telegram", async (request, reply) => {
    if (dependencies.telegram === undefined) return reply.code(503).send({ error: "telegram_not_configured" });
    const secret = typeof request.headers["x-telegram-bot-api-secret-token"] === "string" ? request.headers["x-telegram-bot-api-secret-token"] : undefined;
    if (!dependencies.telegram.validWebhookSecret(secret)) return reply.code(401).send({ error: "unauthorized" });
    const result = await dependencies.telegram.handle(request.body); return reply.code(result.accepted ? 200 : 202).send(result);
  });

  return app;
}
