import { describe, expect, it } from "vitest";
import { ProviderBudgetManager } from "./rate-budget.js";

class RetryableError extends Error { readonly code = "RATE_LIMITED"; readonly retryable = true; }

describe("provider rate budget", () => {
  it("deduplicates concurrent requests and caches completed values", async () => {
    const budget = new ProviderBudgetManager({ provider: "test", concurrency: 1, cacheTtlMs: 1_000 });
    let calls = 0;
    const operation = async (): Promise<number> => { calls += 1; await Promise.resolve(); return 42; };
    const [first, second] = await Promise.all([budget.run("same", operation), budget.run("same", operation)]);
    const cached = await budget.run("same", operation);
    expect([first, second, cached]).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it("retries retryable rate limits and exposes counters", async () => {
    const budget = new ProviderBudgetManager({ provider: "test", concurrency: 1, maximumAttempts: 2, baseBackoffMs: 0, jitterRatio: 0 });
    const value = await budget.run("retry", async (attempt) => { if (attempt === 1) throw new RetryableError("limited"); return "ok"; });
    expect(value).toBe("ok");
    expect(budget.snapshot()).toMatchObject({ calls: 2, successfulCalls: 1, rateLimited: 1, retries: 1, degraded: true });
  });

  it("enforces its concurrency ceiling", async () => {
    const budget = new ProviderBudgetManager({ provider: "test", concurrency: 1 });
    let active = 0;
    let maximum = 0;
    const operation = async (): Promise<void> => { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; };
    await Promise.all([budget.run("a", operation), budget.run("b", operation)]);
    expect(maximum).toBe(1);
  });
});
