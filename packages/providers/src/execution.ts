import type { BuyQuoteRequest, EntryMarketSnapshot, ExecutionProvider, JsonValue, SellQuoteRequest } from "@intelligence/core";
import type { MarketDataProvider } from "./interfaces.js";

export class PaperExecutionProvider implements ExecutionProvider {
  readonly mode = "PAPER" as const;
  constructor(private readonly marketData: MarketDataProvider) {}
  quoteBuy(request: BuyQuoteRequest): Promise<EntryMarketSnapshot> { return this.marketData.getBuyMarketSnapshot(request.tokenMint, request.usdAmount); }
  async buildBuy(request: BuyQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue> { return { kind: "paper_buy", tokenMint: request.tokenMint, usdAmount: request.usdAmount, observedAt: quote.observedAt }; }
  async executeBuy(request: BuyQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue> {
    if (!quote.executablePriceVerified || quote.priceUsd === null) throw new Error("Paper execution unavailable without a verified observed executable price");
    return { kind: "paper_fill", tokenMint: request.tokenMint, usdAmount: request.usdAmount, priceUsd: quote.priceUsd, observedAt: quote.observedAt };
  }
  quoteSell(request: SellQuoteRequest): Promise<EntryMarketSnapshot> { return this.marketData.getSellMarketSnapshot(request.tokenMint, request.rawTokenAmount, request.tokenDecimals); }
  async buildSell(request: SellQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue> { return { kind: "paper_sell", tokenMint: request.tokenMint, rawTokenAmount: request.rawTokenAmount.toString(), observedAt: quote.observedAt }; }
  async executeSell(request: SellQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue> {
    if (!quote.executablePriceVerified || quote.priceUsd === null) throw new Error("Paper execution unavailable without a verified observed executable price");
    return { kind: "paper_exit", tokenMint: request.tokenMint, rawTokenAmount: request.rawTokenAmount.toString(), priceUsd: quote.priceUsd, observedAt: quote.observedAt };
  }
}

export class UnavailableMarketDataProvider implements MarketDataProvider {
  readonly name = "unavailable";
  async getBuyMarketSnapshot(): Promise<EntryMarketSnapshot> { return this.snapshot(); }
  async getSellMarketSnapshot(): Promise<EntryMarketSnapshot> { return this.snapshot(); }
  private snapshot(): EntryMarketSnapshot {
    return { observedAt: new Date().toISOString(), priceUsd: null, executablePriceVerified: false, provenance: "UNKNOWN", fillBasis: "UNAVAILABLE", quoteRequestedAt: null, quoteReceivedAt: null, quoteLatencyMs: null, expectedOutputRaw: null, quotedInputUsdValue: null, inputMint: null, outputMint: null, liquidityUsd: null, estimatedFeeUsd: null, estimatedSlippageBps: null, source: this.name };
  }
}

export class LiveExecutionUnavailableError extends Error {
  constructor() { super("LIVE execution is disabled: a reviewed Jupiter Swap V2 executor and signing architecture are not installed"); }
}
