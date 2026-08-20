import { describe, expect, it } from "vitest";
import { JupiterMarketError, JupiterSwapV2MarketDataProvider } from "./jupiter.js";

const inputMint = "So11111111111111111111111111111111111111112";
const outputMint = "Token11111111111111111111111111111111111111";

describe("Jupiter Swap V2 market observations", () => {
  it("uses quote-only order requests without a taker or transaction", async () => {
    let requestedUrl = "";
    const provider = new JupiterSwapV2MarketDataProvider({ apiKey: "test-key", fetchImplementation: async (input) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ inputMint, outputMint, inAmount: "1000000", outAmount: "250000000", otherAmountThreshold: "247500000", priceImpact: -0.4, inUsdValue: 100, outUsdValue: 99.6, router: "metis", transaction: null }), { status: 200 });
    } });
    const result = await provider.getQuote({ inputMint, outputMint, inputRawAmount: 1_000_000n, inputDecimals: 6, outputDecimals: 6 });
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/swap/v2/order");
    expect(url.searchParams.has("taker")).toBe(false);
    expect(result.observation).toMatchObject({ provenance: "MARKET_QUOTE", outputRawAmount: 250_000_000n, inputUsdValue: "100", outputUsdValue: "99.6", priceImpactPct: "-0.4", transactionIncluded: false, routeAvailable: true });
  });

  it("records no-route distinctly from provider failure", async () => {
    const provider = new JupiterSwapV2MarketDataProvider({ apiKey: "test-key", fetchImplementation: async () => new Response("{}", { status: 404 }) });
    const result = await provider.getQuote({ inputMint, outputMint, inputRawAmount: 1n });
    expect(result.errorCode).toBe("NO_ROUTE");
    expect(result.observation.routeAvailable).toBe(false);
  });

  it("rejects transaction-bearing responses and disables cleanly without a key", async () => {
    const unsafe = new JupiterSwapV2MarketDataProvider({ apiKey: "test-key", fetchImplementation: async () => new Response(JSON.stringify({ inputMint, outputMint, inAmount: "1", outAmount: "2", transaction: "unsigned-payload" }), { status: 200 }) });
    await expect(unsafe.getQuote({ inputMint, outputMint, inputRawAmount: 1n })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" } satisfies Partial<JupiterMarketError>);
    const disabled = new JupiterSwapV2MarketDataProvider({});
    await expect(disabled.getQuote({ inputMint, outputMint, inputRawAmount: 1n })).rejects.toMatchObject({ code: "DISABLED_NO_API_KEY" } satisfies Partial<JupiterMarketError>);
  });
});
