import type { JsonValue } from "@intelligence/shared";

export type MarketObservationProvenance = "MARKET_QUOTE" | "SIMULATED_FILL" | "REAL_FILL";

export interface MarketObservation {
  id: string;
  provider: string;
  provenance: MarketObservationProvenance;
  inputMint: string;
  outputMint: string;
  inputRawAmount: bigint;
  outputRawAmount: bigint | null;
  otherAmountThresholdRaw: bigint | null;
  inputDecimals: number | null;
  outputDecimals: number | null;
  priceImpactPct: string | null;
  inputUsdValue: string | null;
  outputUsdValue: string | null;
  router: JsonValue | null;
  feeInformation: JsonValue | null;
  routeAvailable: boolean;
  requestedAt: string;
  receivedAt: string;
  providerLatencyMs: number;
  transactionIncluded: false;
}

export interface MarketQuoteRequest {
  inputMint: string;
  outputMint: string;
  inputRawAmount: bigint;
  inputDecimals?: number;
  outputDecimals?: number;
}

export interface MarketQuoteResult {
  observation: MarketObservation;
  errorCode: "NO_ROUTE" | null;
}

function decimalRational(value: string): { numerator: bigint; denominator: bigint } | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return null;
  const fraction = match[2] ?? "";
  return { numerator: BigInt(`${match[1] ?? "0"}${fraction}`), denominator: 10n ** BigInt(fraction.length) };
}

function ratioToDecimal(numerator: bigint, denominator: bigint, precision = 12): string | null {
  if (denominator <= 0n) return null;
  const whole = numerator / denominator;
  const fraction = ((numerator % denominator) * 10n ** BigInt(precision) / denominator).toString().padStart(precision, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function marketQuoteToEntrySnapshot(observation: MarketObservation): import("./domain.js").EntryMarketSnapshot {
  const usd = observation.outputUsdValue === null ? null : decimalRational(observation.outputUsdValue);
  const priceUsd = usd === null || observation.outputRawAmount === null || observation.outputDecimals === null
    ? null : ratioToDecimal(usd.numerator * 10n ** BigInt(observation.outputDecimals), usd.denominator * observation.outputRawAmount);
  return {
    observedAt: observation.receivedAt, priceUsd, executablePriceVerified: false,
    provenance: "MARKET_QUOTE", fillBasis: "JUPITER_QUOTE", quoteRequestedAt: observation.requestedAt,
    quoteReceivedAt: observation.receivedAt, quoteLatencyMs: observation.providerLatencyMs,
    expectedOutputRaw: observation.outputRawAmount, quotedInputUsdValue: observation.inputUsdValue, inputMint: observation.inputMint, outputMint: observation.outputMint,
    liquidityUsd: null, estimatedFeeUsd: null, estimatedSlippageBps: null, source: observation.provider
  };
}
