import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

const required = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
  SOLANA_WS_URL: "wss://api.mainnet-beta.solana.com"
};

describe("configuration safety", () => {
  it("fails explicitly in LIVE mode", () => expect(() => parseConfig({ ...required, EXECUTION_MODE: "LIVE" })).toThrow(/LIVE execution is disabled/));
  it("does not require an OpenRouter key", () => expect(parseConfig(required).OPENROUTER_API_KEY).toBeUndefined());
  it("reports a missing database configuration", () => expect(() => parseConfig({ ...required, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/));
  it("enforces the absolute five-dollar ceiling", () => expect(() => parseConfig({ ...required, MAX_TRADE_USD: "5.01" })).toThrow(/hard safety ceiling/));
});
