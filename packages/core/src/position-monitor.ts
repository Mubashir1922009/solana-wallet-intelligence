import { newId } from "@intelligence/shared";
import type { MarketObservation, MarketQuoteRequest } from "./market.js";
import type { PaperPosition } from "./domain.js";
import type { PositionMark } from "./runtime-domain.js";

export interface PositionMonitorStore {
  listPositions(): Promise<PaperPosition[]>;
  insertMarketObservation(observation: MarketObservation): Promise<void>;
  insertPositionMark(mark: PositionMark): Promise<"inserted" | "duplicate">;
  listPositionMarks(positionId: string, limit: number): Promise<PositionMark[]>;
  updatePosition(position: PaperPosition): Promise<void>;
}
export interface PositionQuoteProvider { getQuote(request: MarketQuoteRequest): Promise<{ observation: MarketObservation; errorCode: "NO_ROUTE" | null }> }

export class PositionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private readonly store: PositionMonitorStore, private readonly quotes: PositionQuoteProvider, private readonly options: { intervalMs: number; maximumQuoteAgeMs: number; stableMint: string; stableDecimals: number; onMark?: (position: PaperPosition, mark: PositionMark) => Promise<void> | void; onError?: (error: unknown, position: PaperPosition | null) => Promise<void> | void }) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => { void this.runOnce().catch((error: unknown) => this.options.onError?.(error, null)); }, Math.max(5_000, this.options.intervalMs));
  }
  stop(): void { if (this.timer !== null) clearInterval(this.timer); this.timer = null; }

  async runOnce(now = new Date().toISOString()): Promise<PositionMark[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const positions = (await this.store.listPositions()).filter((position) => position.state !== "closed");
      const marks: PositionMark[] = [];
      for (const position of positions) {
        const mark = await this.runPosition(position.id, now); if (mark !== null) marks.push(mark);
      }
      return marks;
    } finally { this.running = false; }
  }
  async runPosition(positionId: string, now = new Date().toISOString(), markId?: string): Promise<PositionMark | null> {
    const position = (await this.store.listPositions()).find((item) => item.id === positionId) ?? null; if (position === null || position.state === "closed") return null;
    try { const result = await this.quotes.getQuote({ inputMint: position.tokenMint, outputMint: this.options.stableMint, inputRawAmount: position.tokenRawAmount, inputDecimals: position.tokenDecimals, outputDecimals: this.options.stableDecimals }); await this.store.insertMarketObservation(result.observation); const previous = await this.store.listPositionMarks(position.id, 1_000); const calculated = calculatePositionMark(position, result.observation, previous, now, this.options.maximumQuoteAgeMs); const mark = markId === undefined ? calculated : { ...calculated, id: markId }; if (await this.store.insertPositionMark(mark) === "duplicate") return null; const updated = { ...position, markPriceUsd: mark.estimatedValueUsd === null ? position.markPriceUsd : divideDecimal(mark.estimatedValueUsd, rawToDecimal(position.tokenRawAmount, position.tokenDecimals), 12), unrealizedPnlUsd: mark.grossUnrealizedPnlUsd, updatedAt: now }; await this.store.updatePosition(updated); await this.options.onMark?.(updated, mark); return mark; } catch (error) { await this.options.onError?.(error, position); throw error; }
  }
}

export function calculatePositionMark(position: PaperPosition, market: MarketObservation, previous: PositionMark[], now: string, maximumQuoteAgeMs: number): PositionMark {
  const quoteAgeMs = Math.max(0, Date.parse(now) - Date.parse(market.receivedAt));
  const stale = quoteAgeMs > maximumQuoteAgeMs;
  const valueUsd = !market.routeAvailable ? null : market.outputUsdValue ?? (market.outputRawAmount !== null && market.outputDecimals !== null ? rawToDecimal(market.outputRawAmount, market.outputDecimals) : null);
  const gross = valueUsd === null ? null : subtractDecimal(valueUsd, position.simulatedUsdAmount, 6);
  const estimatedFees = market.feeInformation === null ? null : extractFeeUsd(market.feeInformation);
  const net = gross === null || estimatedFees === null ? null : subtractDecimal(gross, estimatedFees, 6);
  const priorGross = previous.flatMap((mark) => mark.grossUnrealizedPnlUsd === null ? [] : [mark.grossUnrealizedPnlUsd]);
  const all = gross === null ? priorGross : [...priorGross, gross];
  return {
    id: newId(), positionId: position.id, marketObservationId: market.id, observedAt: now, estimatedValueUsd: valueUsd,
    grossUnrealizedPnlUsd: gross, netUnrealizedPnlUsd: net, estimatedFeesUsd: estimatedFees,
    maxFavorableExcursionUsd: all.length === 0 ? null : all.reduce((best, value) => compareDecimal(value, best) > 0 ? value : best),
    maxAdverseExcursionUsd: all.length === 0 ? null : all.reduce((worst, value) => compareDecimal(value, worst) < 0 ? value : worst),
    timeHeldMs: Math.max(0, Date.parse(now) - Date.parse(position.openedAt)), quoteAgeMs, routeAvailable: market.routeAvailable,
    confidence: !market.routeAvailable || valueUsd === null ? "LOW" : stale ? "MEDIUM" : "HIGH", provenance: "JUPITER_QUOTE"
  };
}

function decimalUnits(value: string, precision: number): bigint {
  const negative = value.startsWith("-");
  const normalized = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const units = BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, "0").slice(0, precision));
  return negative ? -units : units;
}
function unitsDecimal(value: bigint, precision: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10n ** BigInt(precision);
  const fraction = (absolute % 10n ** BigInt(precision)).toString().padStart(precision, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length === 0 ? "" : `.${fraction}`}`;
}
function subtractDecimal(left: string, right: string, precision: number): string { return unitsDecimal(decimalUnits(left, precision) - decimalUnits(right, precision), precision); }
function compareDecimal(left: string, right: string): number { const difference = decimalUnits(left, 6) - decimalUnits(right, 6); return difference === 0n ? 0 : difference > 0n ? 1 : -1; }
function rawToDecimal(raw: bigint, decimals: number): string { return unitsDecimal(raw, decimals); }
function divideDecimal(left: string, right: string, precision: number): string | null { const denominator = decimalUnits(right, precision); if (denominator === 0n) return null; return unitsDecimal(decimalUnits(left, precision) * 10n ** BigInt(precision) / denominator, precision); }
function extractFeeUsd(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("feeUsd" in value)) return null;
  const fee = value.feeUsd;
  return typeof fee === "string" && /^\d+(?:\.\d+)?$/.test(fee) ? fee : null;
}
