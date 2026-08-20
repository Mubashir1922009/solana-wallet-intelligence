import { newId } from "@intelligence/shared";
import { z } from "zod";
import type { JsonValue, MarketObservation, MarketQuoteRequest, MarketQuoteResult } from "@intelligence/core";
import type { QuoteMarketDataProvider } from "./interfaces.js";

export type JupiterMarketErrorCode = "DISABLED_NO_API_KEY" | "HTTP_ERROR" | "RATE_LIMITED" | "TIMEOUT" | "MALFORMED_RESPONSE";

export class JupiterMarketError extends Error {
  constructor(readonly code: JupiterMarketErrorCode, message: string, readonly retryable: boolean) { super(message); }
}

const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const decimalValue = z.union([decimalString, z.number()]);
const amountString = z.string().regex(/^\d+$/);
const quoteSchema = z.looseObject({
  inputMint: z.string().min(32), outputMint: z.string().min(32), inAmount: amountString, outAmount: amountString,
  otherAmountThreshold: amountString.optional(), priceImpact: decimalValue.optional(), priceImpactPct: decimalValue.optional(),
  inUsdValue: decimalValue.optional(), outUsdValue: decimalValue.optional(), router: z.unknown().optional(),
  transaction: z.null().optional()
});

export interface JupiterMarketOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maximumAttempts?: number;
  retryDelayMs?: number;
  fetchImplementation?: typeof fetch;
}

export class JupiterSwapV2MarketDataProvider implements QuoteMarketDataProvider {
  readonly name = "jupiter-swap-v2";
  readonly enabled: boolean;
  private readonly request: typeof fetch;

  constructor(private readonly options: JupiterMarketOptions) {
    this.enabled = options.apiKey !== undefined;
    this.request = options.fetchImplementation ?? fetch;
  }

  async getQuote(request: MarketQuoteRequest): Promise<MarketQuoteResult> {
    if (!this.enabled) throw new JupiterMarketError("DISABLED_NO_API_KEY", "Jupiter quote provider is disabled because JUPITER_API_KEY is not configured", false);
    if (request.inputRawAmount <= 0n) throw new JupiterMarketError("MALFORMED_RESPONSE", "Quote amount must be greater than zero", false);
    const requestedAt = new Date().toISOString();
    const attempts = Math.min(3, Math.max(1, this.options.maximumAttempts ?? 2));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        const url = new URL(`${this.options.baseUrl ?? "https://api.jup.ag/swap/v2"}/order`);
        url.searchParams.set("inputMint", request.inputMint);
        url.searchParams.set("outputMint", request.outputMint);
        url.searchParams.set("amount", request.inputRawAmount.toString());
        const response = await this.request(url, {
          method: "GET", headers: { "x-api-key": this.options.apiKey ?? "", accept: "application/json" },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000)
        });
        const receivedAt = new Date().toISOString();
        const latencyMs = Date.now() - started;
        if (response.status === 404) return { observation: this.noRoute(request, requestedAt, receivedAt, latencyMs), errorCode: "NO_ROUTE" };
        if (!response.ok) {
          const code = response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR";
          throw new JupiterMarketError(code, `Jupiter Swap V2 order request failed with HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        }
        const parsed = quoteSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.inputMint !== request.inputMint || parsed.data.outputMint !== request.outputMint || BigInt(parsed.data.inAmount) !== request.inputRawAmount) {
          throw new JupiterMarketError("MALFORMED_RESPONSE", "Jupiter Swap V2 returned an invalid or mismatched quote", false);
        }
        const feeInformation: Record<string, JsonValue> = {};
        for (const key of ["feeBps", "feeAmount", "platformFee"] as const) {
          const value = parsed.data[key];
          if (value !== undefined && isJsonValue(value)) feeInformation[key] = value;
        }
        const observation: MarketObservation = {
          id: newId(), provider: this.name, provenance: "MARKET_QUOTE", inputMint: parsed.data.inputMint, outputMint: parsed.data.outputMint,
          inputRawAmount: BigInt(parsed.data.inAmount), outputRawAmount: BigInt(parsed.data.outAmount),
          otherAmountThresholdRaw: parsed.data.otherAmountThreshold === undefined ? null : BigInt(parsed.data.otherAmountThreshold),
          inputDecimals: request.inputDecimals ?? null, outputDecimals: request.outputDecimals ?? null,
          priceImpactPct: decimalText(parsed.data.priceImpactPct ?? parsed.data.priceImpact),
          inputUsdValue: decimalText(parsed.data.inUsdValue), outputUsdValue: decimalText(parsed.data.outUsdValue),
          router: parsed.data.router !== undefined && isJsonValue(parsed.data.router) ? parsed.data.router : null,
          feeInformation: Object.keys(feeInformation).length === 0 ? null : feeInformation,
          routeAvailable: true, requestedAt, receivedAt, providerLatencyMs: latencyMs, transactionIncluded: false
        };
        return { observation, errorCode: null };
      } catch (error) {
        const normalized = error instanceof JupiterMarketError ? error : error instanceof DOMException && error.name === "TimeoutError"
          ? new JupiterMarketError("TIMEOUT", "Jupiter Swap V2 order request timed out", true)
          : new JupiterMarketError("HTTP_ERROR", "Jupiter Swap V2 order request failed", true);
        if (!normalized.retryable || attempt === attempts) throw normalized;
        const delay = this.options.retryDelayMs ?? 100;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay * attempt));
      }
    }
    throw new JupiterMarketError("HTTP_ERROR", "Jupiter Swap V2 order request failed", false);
  }

  private noRoute(request: MarketQuoteRequest, requestedAt: string, receivedAt: string, latencyMs: number): MarketObservation {
    return {
      id: newId(), provider: this.name, provenance: "MARKET_QUOTE", inputMint: request.inputMint, outputMint: request.outputMint,
      inputRawAmount: request.inputRawAmount, outputRawAmount: null, otherAmountThresholdRaw: null,
      inputDecimals: request.inputDecimals ?? null, outputDecimals: request.outputDecimals ?? null,
      priceImpactPct: null, inputUsdValue: null, outputUsdValue: null, router: null, feeInformation: null,
      routeAvailable: false, requestedAt, receivedAt, providerLatencyMs: latencyMs, transactionIncluded: false
    };
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function decimalText(value: string | number | undefined): string | null {
  return value === undefined ? null : String(value);
}
