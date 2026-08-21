import { describe, expect, it, vi } from "vitest";
import { createAuthoritativeRuntimeDatabase, type AuthoritativeRuntimeDatabase } from "./runtime-database.js";

describe("authoritative runtime database selection", () => {
  it("rejects missing configuration instead of selecting memory", () => {
    const factory = vi.fn();
    expect(() => createAuthoritativeRuntimeDatabase(undefined, factory)).toThrow(/in-memory fallback is prohibited/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("propagates PostgreSQL initialization failure without a fallback", () => {
    const factory = vi.fn(() => { throw new Error("connection refused"); });
    expect(() => createAuthoritativeRuntimeDatabase("postgresql://staging.invalid/project", factory)).toThrow(/PostgreSQL initialization failed/);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("returns only the configured PostgreSQL runtime", () => {
    const runtime = { store: {} } as AuthoritativeRuntimeDatabase;
    expect(createAuthoritativeRuntimeDatabase("postgresql://staging.invalid/project", () => runtime)).toBe(runtime);
  });
});
