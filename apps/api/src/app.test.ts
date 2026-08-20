import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { buildApp } from "./app.js";

const wallet = "Vote111111111111111111111111111111111111111";
let app: FastifyInstance | undefined;
afterEach(async () => { if (app !== undefined) await app.close(); app = undefined; });

describe("Fastify API", () => {
  it("serves health", async () => {
    app = await buildApp({ store: new InMemoryIntelligenceStore(), executionMode: "PAPER", network: "mainnet-beta" });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
  it("creates and retrieves a tracked wallet", async () => {
    app = await buildApp({ store: new InMemoryIntelligenceStore(), executionMode: "PAPER", network: "mainnet-beta" });
    expect((await app.inject({ method: "POST", url: `/api/wallets/${wallet}/track` })).statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: `/api/wallets/${wallet}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ publicKey: wallet, status: "tracking" });
  });
  it("requires configured Helius webhook authorization", async () => {
    app = await buildApp({ store: new InMemoryIntelligenceStore(), executionMode: "PAPER", network: "mainnet-beta", webhookAuth: "secret" });
    const response = await app.inject({ method: "POST", url: "/api/webhooks/helius", payload: [] });
    expect(response.statusCode).toBe(401);
  });
  it("rejects malformed webhook data", async () => {
    app = await buildApp({ store: new InMemoryIntelligenceStore(), executionMode: "PAPER", network: "mainnet-beta" });
    const response = await app.inject({ method: "POST", url: "/api/webhooks/helius", payload: { bad: true } });
    expect(response.statusCode).toBe(400);
  });
  it("reports duplicate webhook transactions idempotently", async () => {
    app = await buildApp({ store: new InMemoryIntelligenceStore(), executionMode: "PAPER", network: "mainnet-beta", webhookAuth: "secret" });
    const payload = [{ signature: "5".repeat(64), slot: 123, timestamp: 1_700_000_000, accountData: [{ account: wallet }] }];
    const first = await app.inject({ method: "POST", url: "/api/webhooks/helius", headers: { authorization: "secret" }, payload });
    const second = await app.inject({ method: "POST", url: "/api/webhooks/helius", headers: { authorization: "secret" }, payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(second.json()).toEqual({ accepted: 0, duplicates: 1 });
  });
});
