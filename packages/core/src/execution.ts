import { newId } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { EntryMarketSnapshot, PaperPosition, PositionEvent, Signal, TradeDecision, UserAction } from "./domain.js";
import { assertTradeLimit, divideDecimalToRawTokenAmount, parseUsdCents } from "./money.js";
import type { IntelligenceStore } from "./store.js";

export interface BuyQuoteRequest {
  tokenMint: string;
  usdAmount: string;
}

export interface SellQuoteRequest {
  tokenMint: string;
  rawTokenAmount: bigint;
  tokenDecimals: number;
}

export interface ExecutionProvider {
  readonly mode: "PAPER" | "SHADOW" | "LIVE";
  quoteBuy(request: BuyQuoteRequest): Promise<EntryMarketSnapshot>;
  buildBuy(request: BuyQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue>;
  executeBuy(request: BuyQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue>;
  quoteSell(request: SellQuoteRequest): Promise<EntryMarketSnapshot>;
  buildSell(request: SellQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue>;
  executeSell(request: SellQuoteRequest, quote: EntryMarketSnapshot): Promise<JsonValue>;
}

export interface PaperFillInput {
  market: EntryMarketSnapshot;
  tokenDecimals: number;
}

export class PaperExecutionService {
  constructor(
    private readonly store: IntelligenceStore,
    private readonly paperTradeUsd: string,
    private readonly maximumTradeUsd: string,
    private readonly maximumQuoteAgeMs = 2_000
  ) {}

  async openApprovedSignal(signal: Signal, decision: TradeDecision, fill: PaperFillInput): Promise<PaperPosition | null> {
    if (decision.decision !== "BUY" || signal.decision !== "BUY") return null;
    assertTradeLimit(this.paperTradeUsd, this.maximumTradeUsd);
    const quoteBased = fill.market.fillBasis === "JUPITER_QUOTE";
    if (!quoteBased && (!fill.market.executablePriceVerified || fill.market.priceUsd === null)) {
      throw new Error("Paper fill requires a verified market observation or a valid Jupiter quote; unavailable prices are never fabricated");
    }
    const existing = await this.store.getPositionBySignal(signal.id);
    if (existing !== null) return existing;
    const now = new Date().toISOString();
    const quoteAgeAtDecisionMs = fill.market.quoteReceivedAt === null ? null : Date.parse(now) - Date.parse(fill.market.quoteReceivedAt);
    if (quoteBased && (quoteAgeAtDecisionMs === null || quoteAgeAtDecisionMs < 0 || quoteAgeAtDecisionMs > this.maximumQuoteAgeMs)) {
      throw new Error("Paper quote is stale; request a fresh quote before opening the position");
    }
    if (quoteBased && (fill.market.expectedOutputRaw === null || fill.market.expectedOutputRaw <= 0n)) {
      throw new Error("Paper quote has no usable expected output amount");
    }
    if (quoteBased && (fill.market.quotedInputUsdValue === null || parseUsdCents(fill.market.quotedInputUsdValue) !== parseUsdCents(this.paperTradeUsd))) {
      throw new Error("Paper quote input value does not match the configured simulated USD amount");
    }
    let tokenRawAmount: bigint;
    if (quoteBased) {
      if (fill.market.expectedOutputRaw === null) throw new Error("Paper quote has no usable expected output amount");
      tokenRawAmount = fill.market.expectedOutputRaw;
    } else {
      if (fill.market.priceUsd === null) throw new Error("Paper fill requires a verified market price");
      tokenRawAmount = divideDecimalToRawTokenAmount(this.paperTradeUsd, fill.market.priceUsd, fill.tokenDecimals);
    }
    const position: PaperPosition = {
      id: newId(), tokenMint: signal.tokenMint, triggerWallet: signal.sourceWallet, signalId: signal.id,
      simulatedEntryAt: now, simulatedEntryPriceUsd: fill.market.priceUsd,
      simulatedUsdAmount: this.paperTradeUsd,
      tokenRawAmount,
      tokenDecimals: fill.tokenDecimals, feesEstimateUsd: fill.market.estimatedFeeUsd,
      slippageEstimateBps: fill.market.estimatedSlippageBps, entryMarketSnapshot: fill.market, quoteAgeAtDecisionMs,
      state: "open", markPriceUsd: fill.market.priceUsd, unrealizedPnlUsd: fill.market.priceUsd === null ? null : "0", realizedPnlUsd: null,
      exitRecommendation: null, openedAt: now, updatedAt: now, closedAt: null
    };
    const inserted = await this.store.createPosition(position);
    if (inserted === "duplicate") return await this.store.getPositionBySignal(signal.id);
    await this.store.appendPositionEvent({
      id: newId(), positionId: position.id, type: "opened", createdAt: now,
      details: { signalId: signal.id, usdAmount: this.paperTradeUsd, priceSource: fill.market.source },
      idempotencyKey: `position-opened:${position.id}`
    });
    return position;
  }
}

export class PaperPositionService {
  constructor(private readonly store: IntelligenceStore) {}

  async wait(positionId: string): Promise<PaperPosition> {
    const position = await this.requireOpen(positionId);
    const now = new Date().toISOString();
    await this.audit(positionId, "user_wait", "wait", {}, `wait:${positionId}:${now}`, now);
    return position;
  }

  async recommendExit(positionId: string, recommendation: string): Promise<PaperPosition> {
    const position = await this.requireOpen(positionId);
    const updated = { ...position, state: "sell_recommended" as const, exitRecommendation: recommendation, updatedAt: new Date().toISOString() };
    await this.store.updatePosition(updated);
    return updated;
  }

  async recalculate(positionId: string): Promise<PaperPosition> {
    const position = await this.requireOpen(positionId);
    const now = new Date().toISOString();
    await this.store.appendUserAction({ id: newId(), positionId, action: "recalculate_exit", details: {}, createdAt: now });
    return position;
  }

  async authorizePaperSell(positionId: string, exitPriceUsd: string | null = null): Promise<PaperPosition> {
    const position = await this.requireOpen(positionId);
    const now = new Date().toISOString();
    const closed: PaperPosition = {
      ...position, state: "closed", markPriceUsd: exitPriceUsd ?? position.markPriceUsd,
      realizedPnlUsd: null, unrealizedPnlUsd: null, updatedAt: now, closedAt: now
    };
    await this.store.updatePosition(closed);
    await this.audit(positionId, "user_sell_authorized", "sell_authorized", { paper: true }, `paper-sell:${positionId}`, now);
    await this.store.appendPositionEvent({ id: newId(), positionId, type: "closed", createdAt: now, details: { paper: true }, idempotencyKey: `closed:${positionId}` });
    return closed;
  }

  private async requireOpen(positionId: string): Promise<PaperPosition> {
    const position = await this.store.getPosition(positionId);
    if (position === null) throw new Error("Position not found");
    if (position.state === "closed") throw new Error("Invalid position transition: position is already closed");
    return position;
  }

  private async audit(positionId: string, eventType: PositionEvent["type"], action: UserAction["action"], details: JsonValue, idempotencyKey: string, now: string): Promise<void> {
    await this.store.appendUserAction({ id: newId(), positionId, action, details, createdAt: now });
    await this.store.appendPositionEvent({ id: newId(), positionId, type: eventType, createdAt: now, details, idempotencyKey });
  }
}
