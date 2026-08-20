import process from "node:process";
import { createClient } from "redis";
import { parseConfig, safeConfigSummary } from "@intelligence/config";
import { createPostgresStore } from "@intelligence/database";
import { FallbackChainDataProvider, HeliusChainDataProvider, JupiterSwapV2MarketDataProvider, StandardSolanaRpcProvider } from "@intelligence/providers";
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

const app = await buildApp({
  store: database.store,
  logger: true,
  executionMode: config.EXECUTION_MODE,
  network: config.SOLANA_NETWORK,
  chainProvider,
  quoteProvider: jupiter,
  historyMaximumTransactions: config.HISTORY_MAX_TRANSACTIONS,
  historyConcurrency: config.HISTORY_CONCURRENCY,
  ...(config.HELIUS_WEBHOOK_AUTH === undefined ? {} : { webhookAuth: config.HELIUS_WEBHOOK_AUTH }),
  databasePing: database.ping,
  redisPing: async () => { await redis.ping(); },
  chainPing: async () => { await standardRpc.fetchWalletSignatures({ address: "Vote111111111111111111111111111111111111111", limit: 1 }); },
  openRouterEnabled: config.OPENROUTER_API_KEY !== undefined
});

app.log.info(safeConfigSummary(config), "configuration loaded");
await app.listen({ host: config.HOST, port: config.PORT });

const shutdown = async (): Promise<void> => {
  await app.close();
  if (redis.isOpen) await redis.quit();
  await database.close();
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
