import type { SolanaRpcTransaction } from "@intelligence/core";
import type { ChainDataProvider, WalletHistoryPage, WalletHistoryRequest, WalletHistoryResult } from "./interfaces.js";

export interface FallbackNotice { from: string; to: string; operation: string; reason: string }

export class FallbackChainDataProvider implements ChainDataProvider {
  readonly name: string;
  readonly historyMode;

  constructor(
    private readonly primary: ChainDataProvider,
    private readonly fallback: ChainDataProvider,
    private readonly onFallback: (notice: FallbackNotice) => void
  ) {
    this.name = `${primary.name}-with-${fallback.name}-fallback`;
    this.historyMode = primary.historyMode;
  }

  async fetchWalletSignatures(request: WalletHistoryRequest): Promise<WalletHistoryPage> {
    try { return await this.primary.fetchWalletSignatures(request); }
    catch (error) {
      this.notice("fetchWalletSignatures", error);
      return await this.fallback.fetchWalletSignatures(request);
    }
  }

  async fetchWalletHistory(request: WalletHistoryRequest): Promise<WalletHistoryResult> {
    let result: WalletHistoryResult;
    try {
      result = await this.primary.fetchWalletHistory(request);
    }
    catch (error) {
      this.notice("fetchWalletHistory", error);
      return await this.fallback.fetchWalletHistory(request);
    }
    if (result.diagnostics.complete) return result;
    this.notice("fetchWalletHistory", new Error(`incomplete history: ${result.diagnostics.transactionsMissing} missing, ${result.diagnostics.failures.length} failed`));
    return await this.fallback.fetchWalletHistory(request);
  }

  async fetchTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    try { return await this.primary.fetchTransaction(signature); }
    catch (error) {
      this.notice("fetchTransaction", error);
      return await this.fallback.fetchTransaction(signature);
    }
  }

  parseWebhook(payload: unknown, receivedAt: string) {
    if (this.primary.parseWebhook === undefined) throw new Error("Primary provider does not support webhook parsing");
    return this.primary.parseWebhook(payload, receivedAt);
  }

  private notice(operation: string, error: unknown): void {
    this.onFallback({ from: this.primary.name, to: this.fallback.name, operation, reason: error instanceof Error ? error.message : "unknown provider error" });
  }
}
