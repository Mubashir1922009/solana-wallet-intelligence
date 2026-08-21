import type { ProviderBudgetSnapshot } from "@intelligence/core";

export interface ProviderBudgetOptions {
  provider: string;
  concurrency: number;
  maximumAttempts?: number;
  baseBackoffMs?: number;
  maximumBackoffMs?: number;
  jitterRatio?: number;
  cacheTtlMs?: number;
  random?: () => number;
  now?: () => number;
}

interface CacheEntry { value: unknown; expiresAt: number }

export class ProviderBudgetManager {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly deduplicated = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, CacheEntry>();
  private calls = 0;
  private successes = 0;
  private rateLimited = 0;
  private timeouts = 0;
  private retries = 0;
  private totalQueueWaitMs = 0;
  private totalLatencyMs = 0;

  constructor(private readonly options: ProviderBudgetOptions) {}

  run<T>(key: string, operation: (attempt: number) => Promise<T>, cacheTtlMs = this.options.cacheTtlMs ?? 0): Promise<T> {
    const cached = this.cache.get(key);
    const now = (this.options.now ?? Date.now)();
    if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.value as T);
    const existing = this.deduplicated.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = this.execute(operation).then((value) => {
      if (cacheTtlMs > 0) this.cache.set(key, { value, expiresAt: (this.options.now ?? Date.now)() + cacheTtlMs });
      return value;
    }).finally(() => this.deduplicated.delete(key));
    this.deduplicated.set(key, promise);
    return promise;
  }

  snapshot(): ProviderBudgetSnapshot {
    return {
      provider: this.options.provider, calls: this.calls, successfulCalls: this.successes, rateLimited: this.rateLimited,
      timeouts: this.timeouts, retries: this.retries, queueWaitMs: this.totalQueueWaitMs,
      averageLatencyMs: this.calls === 0 ? null : this.totalLatencyMs / this.calls,
      inFlight: this.inFlight, queued: this.waiters.length, degraded: this.rateLimited > 0 || this.timeouts > 0
    };
  }

  private async execute<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
    const queuedAt = (this.options.now ?? Date.now)();
    await this.acquire();
    this.totalQueueWaitMs += Math.max(0, (this.options.now ?? Date.now)() - queuedAt);
    try {
      const maximumAttempts = Math.min(5, Math.max(1, this.options.maximumAttempts ?? 3));
      let lastError: unknown;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        this.calls += 1;
        const started = (this.options.now ?? Date.now)();
        try {
          const value = await operation(attempt);
          this.successes += 1;
          this.totalLatencyMs += Math.max(0, (this.options.now ?? Date.now)() - started);
          return value;
        } catch (error) {
          lastError = error;
          this.totalLatencyMs += Math.max(0, (this.options.now ?? Date.now)() - started);
          const code = errorCode(error);
          if (code === "RATE_LIMITED" || code === "429") this.rateLimited += 1;
          if (code === "TIMEOUT") this.timeouts += 1;
          if (!retryable(error) || attempt === maximumAttempts) throw error;
          this.retries += 1;
          await new Promise((resolve) => setTimeout(resolve, this.backoff(attempt)));
        }
      }
      throw lastError;
    } finally { this.release(); }
  }

  private acquire(): Promise<void> {
    const limit = Math.max(1, this.options.concurrency);
    if (this.inFlight < limit) { this.inFlight += 1; return Promise.resolve(); }
    return new Promise((resolve) => this.waiters.push(() => { this.inFlight += 1; resolve(); }));
  }

  private release(): void {
    this.inFlight -= 1;
    this.waiters.shift()?.();
  }

  private backoff(attempt: number): number {
    const base = this.options.baseBackoffMs ?? 100;
    const cap = this.options.maximumBackoffMs ?? 5_000;
    const jitter = this.options.jitterRatio ?? 0.2;
    const raw = Math.min(cap, base * 2 ** (attempt - 1));
    const random = this.options.random ?? Math.random;
    return Math.max(0, Math.round(raw * (1 - jitter + 2 * jitter * random())));
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return String(error.code);
}

function retryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("retryable" in error && typeof error.retryable === "boolean") return error.retryable;
  const code = errorCode(error);
  return code === "RATE_LIMITED" || code === "429" || code === "TIMEOUT";
}
