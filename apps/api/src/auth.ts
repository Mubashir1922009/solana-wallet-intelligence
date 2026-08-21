import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { newId } from "@intelligence/shared";
import type { IntelligenceStore, OperatorSecurityEvent, OperatorSession } from "@intelligence/core";

export interface OperatorAuthOptions {
  passwordHash: string; sessionSecret: string; secureCookies: boolean; sessionTtlMs: number;
  loginMaxAttempts: number; loginWindowMs: number; now?: () => Date;
}
export interface AuthenticatedSession { session: OperatorSession; csrfValid: boolean }

export class OperatorAuthService {
  private readonly loginAttempts = new Map<string, number[]>();
  constructor(private readonly store: IntelligenceStore, private readonly options: OperatorAuthOptions) {}

  async login(password: string, clientLabel: string | null): Promise<{ sessionToken: string; csrfToken: string; session: OperatorSession } | null> {
    const key = clientLabel ?? "unknown"; const nowMs = this.now().getTime(); const cutoff = nowMs - this.options.loginWindowMs;
    const recent = (this.loginAttempts.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.options.loginMaxAttempts) { await this.audit("LOGIN_RATE_LIMITED", null, clientLabel, {}); return null; }
    if (!await verifyPassword(password, this.options.passwordHash)) { recent.push(nowMs); this.loginAttempts.set(key, recent); await this.audit("LOGIN_FAILED", null, clientLabel, {}); return null; }
    this.loginAttempts.delete(key);
    const sessionToken = randomBytes(32).toString("base64url"); const csrfToken = randomBytes(32).toString("base64url"); const now = this.now().toISOString();
    const session: OperatorSession = { id: newId(), tokenHash: this.hash(sessionToken), csrfHash: this.hash(csrfToken), createdAt: now, expiresAt: new Date(nowMs + this.options.sessionTtlMs).toISOString(), revokedAt: null, lastUsedAt: now, clientLabel };
    await this.store.createOperatorSession(session); await this.audit("LOGIN_SUCCEEDED", session.id, clientLabel, {}); return { sessionToken, csrfToken, session };
  }

  async authenticate(sessionToken: string | null, csrfToken: string | null = null): Promise<AuthenticatedSession | null> {
    if (sessionToken === null || sessionToken.length < 20) return null;
    const session = await this.store.getOperatorSessionByTokenHash(this.hash(sessionToken)); const now = this.now().toISOString();
    if (session === null || session.revokedAt !== null || session.expiresAt <= now) return null;
    await this.store.touchOperatorSession(session.id, now);
    return { session, csrfValid: csrfToken !== null && safeEqual(this.hash(csrfToken), session.csrfHash) };
  }
  isRateLimited(clientLabel: string | null): boolean { const cutoff = this.now().getTime() - this.options.loginWindowMs; return (this.loginAttempts.get(clientLabel ?? "unknown") ?? []).filter((at) => at > cutoff).length >= this.options.loginMaxAttempts; }

  async logout(session: OperatorSession): Promise<void> { const now = this.now().toISOString(); await this.store.revokeOperatorSession(session.id, now); await this.audit("LOGOUT", session.id, session.clientLabel, {}); }
  cookie(token: string, maxAgeSeconds?: number): string { const maxAge = maxAgeSeconds ?? Math.floor(this.options.sessionTtlMs / 1_000); return `operator_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.options.secureCookies ? "; Secure" : ""}`; }
  clearCookie(): string { return `operator_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.options.secureCookies ? "; Secure" : ""}`; }
  async audit(type: OperatorSecurityEvent["type"], sessionId: string | null, clientLabel: string | null, details: OperatorSecurityEvent["details"], actor: OperatorSecurityEvent["actor"] = "DASHBOARD"): Promise<void> { await this.store.insertOperatorSecurityEvent({ id: newId(), type, occurredAt: this.now().toISOString(), sessionId, actor, clientLabel, details }); }
  private hash(value: string): string { return createHmac("sha256", this.options.sessionSecret).update(value).digest("hex"); }
  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
}

export async function hashPassword(password: string | Buffer, salt = randomBytes(16), cost = 32_768, blockSize = 8, parallelization = 1): Promise<string> {
  if (password.length < 12) throw new Error("Operator password must contain at least 12 characters");
  const derived = await scrypt(password, salt, 32, { cost, blockSize, parallelization });
  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, blockText, parallelText, saltText, expectedText] = encoded.split("$");
  if (algorithm !== "scrypt" || costText === undefined || blockText === undefined || parallelText === undefined || saltText === undefined || expectedText === undefined) return false;
  try { const expected = Buffer.from(expectedText, "base64url"); const actual = await scrypt(password, Buffer.from(saltText, "base64url"), expected.length, { cost: Number(costText), blockSize: Number(blockText), parallelization: Number(parallelText) }); return expected.length === actual.length && timingSafeEqual(expected, actual); } catch { return false; }
}

export function cookieValue(header: string | undefined, name: string): string | null { if (header === undefined) return null; for (const part of header.split(";")) { const [key, ...value] = part.trim().split("="); if (key === name) return decodeURIComponent(value.join("=")); } return null; }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function scrypt(password: string | Buffer, salt: Buffer, length: number, options: { cost: number; blockSize: number; parallelization: number }): Promise<Buffer> { return new Promise((resolve, reject) => nodeScrypt(password, salt, length, { N: options.cost, r: options.blockSize, p: options.parallelization, maxmem: 128 * 1024 * 1024 }, (error, result) => error === null ? resolve(result) : reject(error))); }
