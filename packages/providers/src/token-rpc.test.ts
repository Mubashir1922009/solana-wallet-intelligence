import { describe, expect, it } from "vitest";
import { StandardSolanaTokenIntelligenceProvider, TokenIntelligenceRpcError } from "./token-rpc.js";

const mint = "So11111111111111111111111111111111111111112";
const accountA = "Vote111111111111111111111111111111111111111";
const accountB = "Stake11111111111111111111111111111111111111";
const owner = "11111111111111111111111111111111";
const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function rpcFetch(token2022 = false, extensions?: Array<{ extension: string }>): typeof fetch {
  return (async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    const body = JSON.parse(init.body) as { method: string };
    const result = body.method === "getTokenSupply" ? { context: { slot: 10 }, value: { amount: "1000", decimals: 6 } }
      : body.method === "getTokenLargestAccounts" ? { context: { slot: 11 }, value: [{ address: accountA, amount: "200", decimals: 6 }, { address: accountB, amount: "100", decimals: 6 }] }
      : body.method === "getAccountInfo" ? { context: { slot: 12 }, value: { owner: token2022 ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : tokenProgram, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6, isInitialized: true, mintAuthority: null, freezeAuthority: null, supply: "1000", ...(extensions === undefined ? {} : { extensions }) } } } } }
      : { context: { slot: 13 }, value: [accountA, accountB].map(() => ({ owner: tokenProgram, data: { program: "spl-token", parsed: { type: "account", info: { owner, mint, tokenAmount: { amount: "1", decimals: 6 } } } } })) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", result }), { status: 200 });
  }) as typeof fetch;
}

describe("standard token RPC intelligence", () => {
  it("observes exact supply and aggregates multiple token accounts by owner", async () => {
    const provider = new StandardSolanaTokenIntelligenceProvider({ rpcUrl: "https://rpc.test", fetchImplementation: rpcFetch() });
    const result = await provider.observeToken(mint);
    expect(result.supply?.rawSupply).toBe(1_000n);
    expect(result.concentration.largestAccountPct).toBe("20");
    expect(result.concentration.largestKnownOwnerPct).toBe("30");
    expect(result.concentration.knownOwners[0]).toMatchObject({ owner, rawBalance: 300n, accountCount: 2 });
    expect(result.confidence).toBe("HIGH");
  });

  it("marks Token-2022 extension parsing as explicitly unsupported", async () => {
    const provider = new StandardSolanaTokenIntelligenceProvider({ rpcUrl: "https://rpc.test", fetchImplementation: rpcFetch(true) });
    const result = await provider.getMint(mint);
    expect(result).toMatchObject({ tokenProgram: "TOKEN_2022", extensionsStatus: "UNKNOWN_UNSUPPORTED" });
    expect(result.reasons).toContain("TOKEN_2022_EXTENSIONS_UNKNOWN");
  });

  it("records detected Token-2022 extensions and keeps unsupported semantics unknown", async () => { const provider = new StandardSolanaTokenIntelligenceProvider({ rpcUrl: "https://rpc.test", fetchImplementation: rpcFetch(true, [{ extension: "transferFeeConfig" }]) }); expect(await provider.getMint(mint)).toMatchObject({ tokenProgram: "TOKEN_2022", extensions: ["transferFeeConfig"], unsupportedExtensionPresent: true, extensionsStatus: "UNKNOWN_UNSUPPORTED", reasons: ["TOKEN_2022_UNSUPPORTED_EXTENSION_PRESENT"] }); });

  it("rejects malformed RPC envelopes", async () => {
    const provider = new StandardSolanaTokenIntelligenceProvider({ rpcUrl: "https://rpc.test", fetchImplementation: async () => new Response("{}", { status: 200 }) });
    await expect(provider.getSupply(mint)).rejects.toMatchObject({ code: "MALFORMED_RESPONSE", retryable: false } satisfies Partial<TokenIntelligenceRpcError>);
  });
});
