import { z } from "zod";

const positiveUsd = z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a positive USD decimal with at most two fractional digits").refine((value) => cents(value) > 0n, "must be greater than zero");

const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url("DATABASE_URL must be a valid PostgreSQL URL").startsWith("postgresql://", "DATABASE_URL must use postgresql://"),
  REDIS_URL: z.preprocess((value) => value === "" ? undefined : value, z.url("REDIS_URL must be a valid Redis URL").refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), "REDIS_URL must use redis:// or rediss://").optional()),
  SOLANA_NETWORK: z.string().default("mainnet-beta"),
  SOLANA_RPC_URL: z.url(),
  SOLANA_WS_URL: z.url().refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), "SOLANA_WS_URL must use ws:// or wss://"),
  LIVE_PROVIDER_MODE: z.enum(["STANDARD_WS", "HELIUS_WEBHOOK"]).default("STANDARD_WS"),
  MAX_LIVE_SUBSCRIPTIONS: z.coerce.number().int().min(1).max(1_000).default(100),
  WS_MAX_SUBSCRIPTIONS_PER_CONNECTION: z.coerce.number().int().min(1).max(500).default(100),
  WS_MAX_SHARDS: z.coerce.number().int().min(1).max(10).default(4),
  WS_RECONNECT_BASE_MS: z.coerce.number().int().min(100).max(30_000).default(500),
  WS_RECONNECT_CAP_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  WS_LIVENESS_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(45_000),
  GAP_RECOVERY_LIMIT: z.coerce.number().int().min(1).max(1_000).default(100),
  POSITION_MARK_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(30_000),
  PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  TOKEN_INTELLIGENCE_CACHE_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  FORWARD_RETURN_WINDOWS_MS: z.string().default("60000,300000,900000,3600000").transform((value) => value.split(",").map((item) => Number(item.trim()))).pipe(z.array(z.number().int().min(1_000).max(86_400_000)).min(1).max(8)),
  HELIUS_API_KEY: optionalSecret,
  HELIUS_RPC_URL: z.url().default("https://mainnet.helius-rpc.com"),
  HELIUS_WEBHOOK_AUTH: optionalSecret,
  JUPITER_API_KEY: optionalSecret,
  JUPITER_AUTH_MODE: z.enum(["AUTO", "API_KEY", "KEYLESS", "DISABLED"]).default("AUTO"),
  JUPITER_KEYLESS_RPS: z.coerce.number().min(0.1).max(0.5).default(0.5),
  OPENROUTER_API_KEY: optionalSecret,
  OPENROUTER_MODEL: z.string().min(1).default("openrouter/free"),
  XAI_API_KEY: optionalSecret,
  XAI_MODEL: z.string().min(1).default("grok-3-mini"),
  TELEGRAM_BOT_TOKEN: optionalSecret,
  TELEGRAM_CHAT_ID: optionalSecret,
  TELEGRAM_USER_ID: optionalSecret,
  TELEGRAM_WEBHOOK_SECRET: optionalSecret,
  SESSION_SECRET: z.preprocess((value) => value === "" ? undefined : value, z.string().min(32).optional()),
  OPERATOR_PASSWORD_HASH: z.preprocess((value) => value === "" ? undefined : value, z.string().startsWith("scrypt$").optional()),
  SESSION_TTL_MS: z.coerce.number().int().min(300_000).max(604_800_000).default(43_200_000),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(2).max(20).default(5),
  LOGIN_WINDOW_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),
  CORS_ALLOWED_ORIGIN: z.preprocess((value) => value === "" ? undefined : value, z.url().optional()),
  DASHBOARD_PUBLIC_URL: z.preprocess((value) => value === "" ? undefined : value, z.url().optional()),
  EXECUTION_MODE: z.enum(["PAPER", "SHADOW", "LIVE"]).default("PAPER"),
  PAPER_TRADE_USD: positiveUsd.default("1"),
  MAX_TRADE_USD: positiveUsd.default("5"),
  MAX_PAPER_QUOTE_AGE_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  HISTORY_MAX_TRANSACTIONS: z.coerce.number().int().min(1).max(1_000).default(100),
  HISTORY_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
  STABLE_TOKEN_MINT: z.string().min(32).max(44).default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  STABLE_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  RECOGNIZED_INPUT_MINTS: z.string().default("SOL,So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  WORKER_ID: z.string().min(3).default(`worker-${process.pid}`),
  WORKER_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  TOKEN_DISCOVERY_INTERVAL_MS: z.coerce.number().int().min(120_000).max(86_400_000).default(300_000),
  RAW_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14)
});

export type AppConfig = z.infer<typeof environmentSchema>;

function cents(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function parseConfig(environment: Record<string, string | undefined>): AppConfig {
  const parsed = environmentSchema.parse(environment);
  if (cents(parsed.MAX_TRADE_USD) > 500n) {
    throw new Error("MAX_TRADE_USD cannot exceed the hard safety ceiling of 5 USD");
  }
  if (cents(parsed.PAPER_TRADE_USD) > cents(parsed.MAX_TRADE_USD)) {
    throw new Error("PAPER_TRADE_USD cannot exceed MAX_TRADE_USD");
  }
  if (parsed.EXECUTION_MODE === "LIVE") {
    throw new Error("LIVE execution is disabled: no reviewed live execution provider is installed");
  }
  if (parsed.JUPITER_AUTH_MODE === "API_KEY" && parsed.JUPITER_API_KEY === undefined) throw new Error("JUPITER_AUTH_MODE=API_KEY requires JUPITER_API_KEY");
  if (parsed.MAX_LIVE_SUBSCRIPTIONS > parsed.WS_MAX_SUBSCRIPTIONS_PER_CONNECTION * parsed.WS_MAX_SHARDS) throw new Error("MAX_LIVE_SUBSCRIPTIONS exceeds configured WebSocket shard capacity");
  if (parsed.NODE_ENV === "production" && (parsed.SESSION_SECRET === undefined || parsed.OPERATOR_PASSWORD_HASH === undefined || parsed.CORS_ALLOWED_ORIGIN === undefined)) throw new Error("Production requires SESSION_SECRET, OPERATOR_PASSWORD_HASH, and CORS_ALLOWED_ORIGIN");
  if (parsed.NODE_ENV === "production" && parsed.EXECUTION_MODE !== "SHADOW") throw new Error("Production remote deployment must explicitly use EXECUTION_MODE=SHADOW");
  return parsed;
}

export function safeConfigSummary(config: AppConfig): Record<string, string | number | boolean> {
  return {
    nodeEnv: config.NODE_ENV,
    host: config.HOST,
    port: config.PORT,
    network: config.SOLANA_NETWORK,
    executionMode: config.EXECUTION_MODE,
    paperTradeUsd: config.PAPER_TRADE_USD,
    maxTradeUsd: config.MAX_TRADE_USD,
    heliusEnabled: config.HELIUS_API_KEY !== undefined,
    openRouterEnabled: config.OPENROUTER_API_KEY !== undefined,
    jupiterEnabled: config.JUPITER_AUTH_MODE !== "DISABLED" && (config.JUPITER_AUTH_MODE !== "API_KEY" || config.JUPITER_API_KEY !== undefined),
    jupiterAuthMode: config.JUPITER_AUTH_MODE,
    telegramEnabled: config.TELEGRAM_BOT_TOKEN !== undefined && config.TELEGRAM_CHAT_ID !== undefined,
    liveProviderMode: config.LIVE_PROVIDER_MODE,
    maximumLiveSubscriptions: config.MAX_LIVE_SUBSCRIPTIONS,
    redisEnabled: config.REDIS_URL !== undefined,
    operatorAuthEnabled: config.SESSION_SECRET !== undefined && config.OPERATOR_PASSWORD_HASH !== undefined
  };
}
