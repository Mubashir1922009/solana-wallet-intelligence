import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryIntelligenceStore } from "@intelligence/database";
import { buildApp } from "./app.js";
import { hashPassword, OperatorAuthService, verifyPassword } from "./auth.js";

const wallet = "Vote111111111111111111111111111111111111111"; let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
async function fixture(maxAttempts = 3): Promise<{ store: InMemoryIntelligenceStore; auth: OperatorAuthService }> { const store = new InMemoryIntelligenceStore(); const passwordHash = await hashPassword("correct horse battery", Buffer.alloc(16, 7), 1_024); return { store, auth: new OperatorAuthService(store, { passwordHash, sessionSecret: "s".repeat(32), secureCookies: true, sessionTtlMs: 60_000, loginMaxAttempts: maxAttempts, loginWindowMs: 60_000 }) }; }
describe("single operator authentication", () => {
  it("hashes and verifies without storing plaintext", async () => { const encoded = await hashPassword("correct horse battery", Buffer.alloc(16, 1), 1_024); expect(encoded).not.toContain("correct horse"); expect(await verifyPassword("correct horse battery", encoded)).toBe(true); expect(await verifyPassword("wrong", encoded)).toBe(false); });
  it("creates hashed sessions", async () => { const { store, auth } = await fixture(); const login = await auth.login("correct horse battery", "client"); expect(login).not.toBeNull(); expect(JSON.stringify([...store.operatorSessions.values()])).not.toContain(login?.sessionToken); });
  it("rate limits repeated failures", async () => { const { auth } = await fixture(2); expect(await auth.login("wrong", "client")).toBeNull(); expect(await auth.login("wrong", "client")).toBeNull(); expect(auth.isRateLimited("client")).toBe(true); });
  it("rejects revoked and expired sessions", async () => { const { auth } = await fixture(); const login = await auth.login("correct horse battery", "client"); if (login === null) throw new Error("login"); await auth.logout(login.session); expect(await auth.authenticate(login.sessionToken)).toBeNull(); });
  it("protects mutations and SSE", async () => { const { store, auth } = await fixture(); app = await buildApp({ store, auth, executionMode: "SHADOW", network: "mainnet-beta" }); expect((await app.inject({ method: "POST", url: `/api/wallets/${wallet}/track` })).statusCode).toBe(401); expect((await app.inject({ method: "GET", url: "/api/stream" })).statusCode).toBe(401); });
  it("uses HttpOnly Strict Secure cookies and CSRF", async () => {
    const { store, auth } = await fixture();
    app = await buildApp({ store, auth, executionMode: "SHADOW", network: "mainnet-beta" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery" } });
    const loginBody = login.json<{ csrfToken: string }>();
    const cookie = login.headers["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    const noCsrf = await app.inject({ method: "POST", url: `/api/wallets/${wallet}/track`, headers: { cookie: String(cookie) } });
    expect(noCsrf.statusCode).toBe(403);
    const allowed = await app.inject({ method: "POST", url: `/api/wallets/${wallet}/track`, headers: { cookie: String(cookie), "x-csrf-token": loginBody.csrfToken } });
    expect(allowed.statusCode).toBe(200);
  });
  it("revokes logout", async () => {
    const { store, auth } = await fixture();
    app = await buildApp({ store, auth, executionMode: "SHADOW", network: "mainnet-beta" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "correct horse battery" } });
    const loginBody = login.json<{ csrfToken: string }>();
    const headers = { cookie: String(login.headers["set-cookie"]), "x-csrf-token": loginBody.csrfToken };
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers })).statusCode).toBe(401);
  });
});
