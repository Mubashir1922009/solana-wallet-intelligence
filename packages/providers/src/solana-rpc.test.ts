import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { classifyWalletAction, normalizeWalletTransaction } from "@intelligence/core";
import { RpcProviderError, StandardSolanaRpcProvider } from "./solana-rpc.js";

const wallet = "Wallet1111111111111111111111111111111111111";
const signature = "5".repeat(64);

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("standard Solana RPC provider", () => {
  it("paginates signatures with bounded limits", async () => {
    let body: Record<string, unknown> = {};
    const provider = new StandardSolanaRpcProvider({ rpcUrl: "https://rpc.invalid", fetchImplementation: async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return response({ jsonrpc: "2.0", result: [{ signature, slot: 42, err: null, memo: null, blockTime: 1_700_000_000, confirmationStatus: "confirmed" }] });
    } });
    const page = await provider.fetchWalletSignatures({ address: wallet, limit: 5, before: "before-signature" });
    expect(page.nextBefore).toBe(signature);
    expect(body).toMatchObject({ method: "getSignaturesForAddress", params: [wallet, { limit: 5, before: "before-signature", commitment: "confirmed" }] });
  });

  it("requests jsonParsed version-zero transactions and preserves exact amounts", async () => {
    let body: Record<string, unknown> = {};
    const provider = new StandardSolanaRpcProvider({ rpcUrl: "https://rpc.invalid", fetchImplementation: async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return response({ jsonrpc: "2.0", result: {
        slot: 42, blockTime: 1_700_000_000, version: 0,
        transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: wallet, signer: true, writable: true, source: "transaction" }] } },
        meta: { err: null, fee: 5000, preBalances: [9007199254740991], postBalances: [9007199254735991], preTokenBalances: [], postTokenBalances: [] }
      } });
    } });
    const transaction = await provider.fetchTransaction(signature);
    expect(transaction?.feeLamports).toBe(5_000n);
    expect(body).toMatchObject({ method: "getTransaction", params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }] });
  });

  it("handles null results and retries a rate limit once", async () => {
    let calls = 0;
    const provider = new StandardSolanaRpcProvider({ rpcUrl: "https://rpc.invalid", maximumAttempts: 2, retryDelayMs: 0, fetchImplementation: async () => {
      calls += 1;
      return calls === 1 ? response({ error: "limited" }, 429) : response({ jsonrpc: "2.0", result: null });
    } });
    expect(await provider.fetchTransaction(signature)).toBeNull();
    expect(calls).toBe(2);
  });

  it("rejects unsupported transaction versions explicitly", async () => {
    const provider = new StandardSolanaRpcProvider({ rpcUrl: "https://rpc.invalid", fetchImplementation: async () => response({ jsonrpc: "2.0", error: { code: -32015, message: "Transaction version (1) is not supported" } }) });
    await expect(provider.fetchTransaction(signature)).rejects.toMatchObject({ code: "UNSUPPORTED_TRANSACTION_VERSION", retryable: false } satisfies Partial<RpcProviderError>);
  });

  it("parses and classifies a captured real mainnet Jupiter transaction", async () => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/real-mainnet-jupiter-sell.json", import.meta.url), "utf8")) as { rpcResponse: unknown };
    const provider = new StandardSolanaRpcProvider({ rpcUrl: "fixture://mainnet", fetchImplementation: async () => response(fixture.rpcResponse) });
    const parsed = await provider.fetchTransaction("yRFQqLjGEVK9zHxghf9AYisRYQiT9y7oNaJxcYgjvPncZarZPUBTEC5o7ygj8YvhtG19rgzg8guG16r6HkHxbZ9");
    if (parsed === null) throw new Error("Expected captured mainnet transaction");
    const normalized = normalizeWalletTransaction(parsed, "GmyfrAhK5dexSp6gQ5F9y1JC4ZYyG6iJfgrX8BWPCJNz", "2026-08-20T16:50:02.000Z");
    expect(normalized.native?.feeAdjustedEconomicDeltaLamports).toBe(12_849n);
    expect(normalized.tokenChanges[0]?.rawDelta).toBe(-561_423n);
    expect(classifyWalletAction(normalized)).toMatchObject({ classification: "SWAP_SELL", confidence: "HIGH", outputMint: "SOL", outputRawAmount: 12_849n });
  });
});
