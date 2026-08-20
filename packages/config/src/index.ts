import { z } from "zod";

const positiveUsd = z.string().regex(/^\d+(?:\.\d{1,2})?$/, "must be a positive USD decimal with at most two fractional digits").refine((value) => cents(value) > 0n, "must be greater than zero");

const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.url("DATABASE_URL must be a valid PostgreSQL URL").startsWith("postgresql://", "DATABASE_URL must use postgresql://"),
  REDIS_URL: z.url("REDIS_URL must be a valid Redis URL").refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), "REDIS_URL must use redis:// or rediss://"),
  SOLANA_NETWORK: z.string().default("mainnet-beta"),
  SOLANA_RPC_URL: z.url(),
  SOLANA_WS_URL: z.url().refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), "SOLANA_WS_URL must use ws:// or wss://"),
  HELIUS_API_KEY: optionalSecret,
  HELIUS_RPC_URL: z.url().default("https://mainnet.helius-rpc.com"),
  HELIUS_WEBHOOK_AUTH: optionalSecret,
  JUPITER_API_KEY: optionalSecret,
  OPENROUTER_API_KEY: optionalSecret,
  OPENROUTER_MODEL: z.string().min(1).default("openrouter/free"),
  EXECUTION_MODE: z.enum(["PAPER", "SHADOW", "LIVE"]).default("PAPER"),
  PAPER_TRADE_USD: positiveUsd.default("1"),
  MAX_TRADE_USD: positiveUsd.default("5"),
  MAX_PAPER_QUOTE_AGE_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
  HISTORY_MAX_TRANSACTIONS: z.coerce.number().int().min(1).max(1_000).default(100),
  HISTORY_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
  RECOGNIZED_INPUT_MINTS: z.string().default("SOL,So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
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
    jupiterEnabled: config.JUPITER_API_KEY !== undefined
  };
}
