import { describe, expect, it } from "vitest";
import type { SolanaRpcTransaction, SolanaTokenBalance } from "./solana.js";
import { NATIVE_SOL_MINT, USDC_MINT, classifyWalletAction, normalizeWalletTransaction } from "./solana.js";

const wallet = "Wallet1111111111111111111111111111111111111";
const other = "Other11111111111111111111111111111111111111";
const meme = "Meme111111111111111111111111111111111111111";
const tokenAccountA = "TokenA111111111111111111111111111111111111";
const tokenAccountB = "TokenB111111111111111111111111111111111111";
const observedAt = "2026-08-20T12:00:02.000Z";

function balance(accountIndex: number, mint: string, amount: string, decimals: number, owner: string | null = wallet): SolanaTokenBalance {
  return { accountIndex, mint, owner, rawAmount: amount, decimals };
}

function transaction(overrides: Partial<SolanaRpcTransaction> = {}): SolanaRpcTransaction {
  return {
    signature: "5".repeat(64), slot: 100n, blockTime: "2026-08-20T12:00:00.000Z", version: 0,
    accountKeys: [
      { pubkey: wallet, signer: true, writable: true, source: "transaction" },
      { pubkey: other, signer: false, writable: true, source: "transaction" },
      { pubkey: tokenAccountA, signer: false, writable: true, source: "transaction" },
      { pubkey: tokenAccountB, signer: false, writable: true, source: "transaction" }
    ],
    feeLamports: 5_000n, error: null, preBalances: [1_000_000_000n, 0n, 0n, 0n], postBalances: [999_995_000n, 0n, 0n, 0n],
    preTokenBalances: [], postTokenBalances: [], raw: {}, ...overrides
  };
}

describe("wallet balance normalization", () => {
  it("derives gained and lost token base units and decimal strings", () => {
    const normalized = normalizeWalletTransaction(transaction({
      preTokenBalances: [balance(2, USDC_MINT, "2500000", 6), balance(3, meme, "0", 9)],
      postTokenBalances: [balance(2, USDC_MINT, "1500000", 6), balance(3, meme, "1250000000", 9)]
    }), wallet, observedAt);
    expect(normalized.tokenChanges.find((change) => change.mint === USDC_MINT)?.rawDelta).toBe(-1_000_000n);
    expect(normalized.tokenChanges.find((change) => change.mint === meme)?.decimalDelta).toBe("1.25");
  });

  it("groups multiple token accounts for the same owner and mint", () => {
    const normalized = normalizeWalletTransaction(transaction({
      preTokenBalances: [balance(2, meme, "100", 2), balance(3, meme, "200", 2)],
      postTokenBalances: [balance(2, meme, "150", 2), balance(3, meme, "275", 2)]
    }), wallet, observedAt);
    expect(normalized.tokenChanges).toHaveLength(1);
    expect(normalized.tokenChanges[0]?.rawDelta).toBe(125n);
    expect(normalized.tokenChanges[0]?.accountDeltas).toHaveLength(2);
  });

  it("keeps raw SOL delta separate from fee-adjusted economic delta", () => {
    const normalized = normalizeWalletTransaction(transaction({ postBalances: [899_995_000n, 0n, 0n, 0n] }), wallet, observedAt);
    expect(normalized.native).toMatchObject({ rawDeltaLamports: -100_005_000n, transactionFeeLamports: 5_000n, walletIsFeePayer: true, feeAdjustedEconomicDeltaLamports: -100_000_000n });
  });

  it("preserves exact amounts above JavaScript safe integer range", () => {
    const large = "900719925474099312345";
    const normalized = normalizeWalletTransaction(transaction({ preTokenBalances: [balance(2, meme, "0", 9)], postTokenBalances: [balance(2, meme, large, 9)] }), wallet, observedAt);
    expect(normalized.tokenChanges[0]?.rawDelta).toBe(BigInt(large));
  });

  it("marks missing owner, missing token arrays, and failed transactions", () => {
    const missingOwner = normalizeWalletTransaction(transaction({ preTokenBalances: [balance(2, meme, "0", 9, null)], postTokenBalances: [balance(2, meme, "1", 9, null)] }), wallet, observedAt);
    expect(missingOwner.ambiguityReasons).toContain("OWNER_MISSING");
    const missingBalances = normalizeWalletTransaction(transaction({ preTokenBalances: null, postTokenBalances: null }), wallet, observedAt);
    expect(missingBalances.ambiguityReasons).toContain("TOKEN_BALANCE_DATA_MISSING");
    const failed = normalizeWalletTransaction(transaction({ error: { InstructionError: [0, "Custom"] } }), wallet, observedAt);
    expect(failed.status).toBe("failed");
    expect(failed.ambiguityReasons).toContain("FAILED_TRANSACTION");
  });
});

describe("conservative wallet action classification", () => {
  it("classifies SOL to token as a strong candidate buy", () => {
    const normalized = normalizeWalletTransaction(transaction({
      postBalances: [899_995_000n, 0n, 0n, 0n], preTokenBalances: [balance(2, meme, "0", 6)], postTokenBalances: [balance(2, meme, "500000", 6)]
    }), wallet, observedAt);
    const action = classifyWalletAction(normalized);
    expect(action).toMatchObject({ classification: "SWAP_BUY", inputMint: NATIVE_SOL_MINT, inputRawAmount: 100_000_000n, outputMint: meme, outputRawAmount: 500_000n, confidence: "HIGH" });
  });

  it("classifies stablecoin to token as a candidate buy", () => {
    const normalized = normalizeWalletTransaction(transaction({
      preTokenBalances: [balance(2, USDC_MINT, "2000000", 6), balance(3, meme, "0", 6)],
      postTokenBalances: [balance(2, USDC_MINT, "1000000", 6), balance(3, meme, "500000", 6)]
    }), wallet, observedAt);
    expect(classifyWalletAction(normalized).classification).toBe("SWAP_BUY");
  });

  it("classifies token to SOL as a candidate sell", () => {
    const normalized = normalizeWalletTransaction(transaction({
      postBalances: [1_099_995_000n, 0n, 0n, 0n], preTokenBalances: [balance(2, meme, "500000", 6)], postTokenBalances: [balance(2, meme, "0", 6)]
    }), wallet, observedAt);
    expect(classifyWalletAction(normalized).classification).toBe("SWAP_SELL");
  });

  it("does not classify simple transfers or airdrops as buys", () => {
    const receipt = normalizeWalletTransaction(transaction({ preTokenBalances: [balance(2, meme, "0", 6)], postTokenBalances: [balance(2, meme, "100", 6)] }), wallet, observedAt);
    expect(classifyWalletAction(receipt).classification).toBe("TRANSFER_IN");
    const solTransfer = normalizeWalletTransaction(transaction({ postBalances: [899_995_000n, 100_000_000n, 0n, 0n] }), wallet, observedAt);
    expect(classifyWalletAction(solTransfer).classification).toBe("TRANSFER_OUT");
  });

  it("returns COMPLEX_SWAP for multiple input assets", () => {
    const secondMint = "Second1111111111111111111111111111111111111";
    const normalized = normalizeWalletTransaction(transaction({
      preTokenBalances: [balance(2, USDC_MINT, "100", 6), balance(3, meme, "0", 6), balance(4, secondMint, "100", 6)],
      postTokenBalances: [balance(2, USDC_MINT, "50", 6), balance(3, meme, "100", 6), balance(4, secondMint, "50", 6)],
      accountKeys: [...transaction().accountKeys, { pubkey: "TokenC111111111111111111111111111111111111", signer: false, writable: true, source: "transaction" }],
      preBalances: [1_000_000_000n, 0n, 0n, 0n, 0n], postBalances: [899_995_000n, 0n, 0n, 0n, 0n]
    }), wallet, observedAt);
    const action = classifyWalletAction(normalized);
    expect(action.classification).toBe("COMPLEX_SWAP");
    expect(action.ambiguityReasons).toContain("MULTIPLE_INPUT_ASSETS");
  });
});
