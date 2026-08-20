import { newId } from "@intelligence/shared";
import type { ClassifiedWalletAction, ClassificationConfidence } from "./solana.js";
import type { MarketObservation } from "./market.js";

export type CopyabilityReason = "INCOMPATIBLE_ASSETS" | "SOURCE_AMOUNTS_MISSING" | "QUOTE_AMOUNTS_MISSING" | "DECIMALS_MISSING" | "SOURCE_NOT_BUY" | "MISSING_BLOCK_TIME" | "MISSING_PIPELINE_TIMESTAMP" | "NO_ROUTE";

export interface CopyabilityTimestamps {
  transactionObservedAt: string;
  normalizationCompletedAt: string | null;
  signalGeneratedAt: string | null;
  decisionAt: string | null;
}

export interface CopyabilityEvaluation {
  id: string;
  sourceWallet: string;
  sourceTransactionSignature: string;
  tokenMint: string;
  marketObservationId: string | null;
  status: "KNOWN" | "PARTIAL" | "UNKNOWN";
  sourceEffectivePrice: string | null;
  followerQuotedPrice: string | null;
  entryPriceDeteriorationBps: number | null;
  entryPriceImprovementBps: number | null;
  detectionLatencyMs: number | null;
  normalizationLatencyMs: number | null;
  decisionLatencyMs: number | null;
  quoteLatencyMs: number | null;
  totalFollowerLatencyMs: number | null;
  confidence: ClassificationConfidence;
  reasons: CopyabilityReason[];
  evaluatedAt: string;
}

function duration(later: string | null, earlier: string | null): number | null {
  if (later === null || earlier === null) return null;
  const result = Date.parse(later) - Date.parse(earlier);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

interface Rational { numerator: bigint; denominator: bigint }

function effectivePrice(input: bigint, inputDecimals: number, output: bigint, outputDecimals: number): Rational {
  return { numerator: input * 10n ** BigInt(outputDecimals), denominator: output * 10n ** BigInt(inputDecimals) };
}

function rationalDecimal(value: Rational, precision = 12): string {
  if (value.denominator <= 0n) throw new Error("Ratio denominator must be positive");
  const whole = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  if (remainder === 0n) return whole.toString();
  const fractional = ((remainder * 10n ** BigInt(precision)) / value.denominator).toString().padStart(precision, "0").replace(/0+$/, "");
  return `${whole}.${fractional}`;
}

function roundedBps(numerator: bigint, denominator: bigint): number {
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute * 10_000n + denominator / 2n) / denominator;
  const signed = numerator < 0n ? -rounded : rounded;
  const value = Number(signed);
  if (!Number.isSafeInteger(value)) throw new Error("Copyability deterioration exceeds supported reporting range");
  return value;
}

export function evaluateCopyability(action: ClassifiedWalletAction, quote: MarketObservation | null, timestamps: CopyabilityTimestamps, evaluatedAt: string): CopyabilityEvaluation {
  const reasons: CopyabilityReason[] = [];
  if (action.classification !== "SWAP_BUY") reasons.push("SOURCE_NOT_BUY");
  if (action.inputRawAmount === null || action.outputRawAmount === null) reasons.push("SOURCE_AMOUNTS_MISSING");
  if (action.inputDecimals === null || action.outputDecimals === null) reasons.push("DECIMALS_MISSING");
  if (quote === null || !quote.routeAvailable) reasons.push("NO_ROUTE");
  if (quote !== null && quote.outputRawAmount === null) reasons.push("QUOTE_AMOUNTS_MISSING");
  if (quote !== null && (quote.inputDecimals === null || quote.outputDecimals === null)) reasons.push("DECIMALS_MISSING");
  if (quote !== null && (quote.inputMint !== action.inputMint || quote.outputMint !== action.outputMint)) reasons.push("INCOMPATIBLE_ASSETS");
  if (action.blockTime === null) reasons.push("MISSING_BLOCK_TIME");
  if (timestamps.normalizationCompletedAt === null || timestamps.signalGeneratedAt === null || timestamps.decisionAt === null) reasons.push("MISSING_PIPELINE_TIMESTAMP");

  let sourcePrice: Rational | null = null;
  let followerPrice: Rational | null = null;
  let deteriorationBps: number | null = null;
  const sourcePricing = action.inputRawAmount !== null && action.inputDecimals !== null && action.outputRawAmount !== null && action.outputDecimals !== null
    ? { input: action.inputRawAmount, inputDecimals: action.inputDecimals, output: action.outputRawAmount, outputDecimals: action.outputDecimals }
    : null;
  const quotePricing = quote !== null && quote.routeAvailable && quote.inputDecimals !== null && quote.outputRawAmount !== null && quote.outputDecimals !== null
    ? { input: quote.inputRawAmount, inputDecimals: quote.inputDecimals, output: quote.outputRawAmount, outputDecimals: quote.outputDecimals }
    : null;
  const compatibleBuy = action.classification === "SWAP_BUY" && quote !== null && quote.inputMint === action.inputMint && quote.outputMint === action.outputMint;
  if (sourcePricing !== null && quotePricing !== null && compatibleBuy) {
    sourcePrice = effectivePrice(sourcePricing.input, sourcePricing.inputDecimals, sourcePricing.output, sourcePricing.outputDecimals);
    followerPrice = effectivePrice(quotePricing.input, quotePricing.inputDecimals, quotePricing.output, quotePricing.outputDecimals);
    const difference = followerPrice.numerator * sourcePrice.denominator - sourcePrice.numerator * followerPrice.denominator;
    const baseline = sourcePrice.numerator * followerPrice.denominator;
    deteriorationBps = roundedBps(difference, baseline);
  }

  const detectionLatencyMs = duration(timestamps.transactionObservedAt, action.blockTime);
  const normalizationLatencyMs = duration(timestamps.normalizationCompletedAt, timestamps.transactionObservedAt);
  const decisionLatencyMs = duration(timestamps.decisionAt, timestamps.signalGeneratedAt);
  const quoteLatencyMs = quote?.providerLatencyMs ?? null;
  const totalFollowerLatencyMs = duration(quote?.receivedAt ?? null, action.blockTime);
  const priceUnknown = sourcePrice === null || followerPrice === null;
  const status = priceUnknown ? "UNKNOWN" : reasons.some((reason) => reason.startsWith("MISSING_")) ? "PARTIAL" : "KNOWN";
  const confidence: ClassificationConfidence = status === "UNKNOWN" ? "UNKNOWN" : status === "PARTIAL" || action.confidence !== "HIGH" ? "MEDIUM" : "HIGH";
  return {
    id: newId(), sourceWallet: action.wallet, sourceTransactionSignature: action.transactionSignature,
    tokenMint: action.outputMint ?? quote?.outputMint ?? "UNKNOWN", marketObservationId: quote?.id ?? null,
    status, sourceEffectivePrice: sourcePrice === null ? null : rationalDecimal(sourcePrice),
    followerQuotedPrice: followerPrice === null ? null : rationalDecimal(followerPrice),
    entryPriceDeteriorationBps: deteriorationBps === null ? null : Math.max(0, deteriorationBps),
    entryPriceImprovementBps: deteriorationBps === null ? null : Math.max(0, -deteriorationBps),
    detectionLatencyMs, normalizationLatencyMs, decisionLatencyMs, quoteLatencyMs, totalFollowerLatencyMs,
    confidence, reasons: [...new Set(reasons)], evaluatedAt
  };
}
