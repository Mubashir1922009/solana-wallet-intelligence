import type { SolanaRpcTransaction } from "@intelligence/core";
import type { ChainDataProvider, HistoryMode, WalletHistoryPage, WalletHistoryRequest, WalletHistoryResult } from "./interfaces.js";

export interface FallbackNotice { from: string; to: string; operation: string; reason: string }
export interface FallbackProviderSnapshot { primaryProvider: string; fallbackProvider: string; activeProvider: string; primaryDegradedUntil: string | null }
export interface FallbackProviderOptions { cooldownMs?: number; now?: () => number }

export class FallbackChainDataProvider implements ChainDataProvider {
  readonly name: string;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private degradedUntilMs = 0;
  private activeProvider: string;

  constructor(
    private readonly primary: ChainDataProvider,
    private readonly fallback: ChainDataProvider,
    private readonly onFallback: (notice: FallbackNotice) => void,
    options: FallbackProviderOptions = {}
  ) {
    this.name = `${primary.name}-with-${fallback.name}-fallback`;
    this.cooldownMs = Math.min(300_000, Math.max(1_000, options.cooldownMs ?? 30_000));
    this.now = options.now ?? Date.now;
    this.activeProvider = primary.name;
  }

  get historyMode(): HistoryMode { return this.inCooldown() ? this.fallback.historyMode : this.primary.historyMode; }

  snapshot(): FallbackProviderSnapshot {
    return {
      primaryProvider: this.primary.name,
      fallbackProvider: this.fallback.name,
      activeProvider: this.inCooldown() ? this.fallback.name : this.activeProvider,
      primaryDegradedUntil: this.inCooldown() ? new Date(this.degradedUntilMs).toISOString() : null
    };
  }

  async fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage> {
    return this.run("fetchWalletSignatures", () => this.primary.fetchWalletSignatures(request), () => this.fallback.fetchWalletSignatures(request));
  }

  async fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult> {
    if (this.inCooldown()) return this.useFallback(() => this.fallback.fetchWalletHistory(request));
    let result: WalletHistoryResult;
    try { result = await this.primary.fetchWalletHistory(request); }
    catch (error) { return this.degradeAndFallback("fetchWalletHistory", error, () => this.fallback.fetchWalletHistory(request)); }
    if (result.diagnostics.complete) return result;
    return this.degradeAndFallback("fetchWalletHistory", new Error(`incomplete history: ${result.diagnostics.transactionsMissing} missing, ${result.diagnostics.failures.length} failed`), () => this.fallback.fetchWalletHistory(request));
  }

  async fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    return this.run("fetchTransaction", () => this.primary.fetchTransaction(signature), () => this.fallback.fetchTransaction(signature));
  }

  parseWebhook(payload: unknown, receivedAt: string) {
    if (this.primary.parseWebhook !== undefined) return this.primary.parseWebhook(payload, receivedAt);
    if (this.fallback.parseWebhook !== undefined) return this.fallback.parseWebhook(payload, receivedAt);
    throw new Error("Configured providers do not support webhook parsing");
  }

  private inCooldown(): boolean { return this.now() < this.degradedUntilMs; }
  private async run<T>(operation: string, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.inCooldown()) return this.useFallback(fallback);
    try { const result = await primary(); this.activeProvider = this.primary.name; return result; }
    catch (error) { return this.degradeAndFallback(operation, error, fallback); }
  }
  private async degradeAndFallback<T>(operation: string, error: unknown, fallback: () => Promise<T>): Promise<T> {
    this.degradedUntilMs = this.now() + this.cooldownMs;
    this.notice(operation, error);
    return this.useFallback(fallback);
  }
  private async useFallback<T>(fallback: () => Promise<T>): Promise<T> { this.activeProvider = this.fallback.name; return fallback(); }
  private notice(operation: string, error: unknown): void {
    this.onFallback({ from: this.primary.name, to: this.fallback.name, operation, reason: sanitizeProviderReason(error instanceof Error ? error.message : "unknown provider error") });
  }
}

function sanitizeProviderReason(reason: string): string {
  return reason.replace(/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, "$1[REDACTED]");
}
