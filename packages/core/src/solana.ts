import type { JsonValue } from "@intelligence/shared";
import { baseUnitsToDecimal } from "./money.js";

export const NATIVE_SOL_MINT = "SOL";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export type AmbiguityReason =
  | "WRAPPED_SOL_FLOW"
  | "RENT_EFFECT"
  | "MULTIPLE_INPUT_ASSETS"
  | "MULTIPLE_OUTPUT_ASSETS"
  | "OWNER_MISSING"
  | "TOKEN_BALANCE_DATA_MISSING"
  | "FAILED_TRANSACTION"
  | "UNSUPPORTED_STRUCTURE";

export interface SolanaAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  source: "transaction" | "lookupTable" | null;
}

export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string | null;
  rawAmount: string;
  decimals: number;
}

export interface SolanaRpcTransaction {
  signature: string;
  slot: bigint;
  blockTime: string | null;
  version: "legacy" | number | null;
  accountKeys: SolanaAccountKey[];
  feeLamports: bigint;
  error: JsonValue | null;
  preBalances: bigint[];
  postBalances: bigint[];
  preTokenBalances: SolanaTokenBalance[] | null;
  postTokenBalances: SolanaTokenBalance[] | null;
  raw: JsonValue;
}

export interface NativeWalletBalanceChange {
  preLamports: bigint;
  postLamports: bigint;
  rawDeltaLamports: bigint;
  transactionFeeLamports: bigint;
  walletIsFeePayer: boolean;
  feeAdjustedEconomicDeltaLamports: bigint | null;
}

export interface TokenAccountBalanceChange {
  accountIndex: number;
  tokenAccount: string | null;
  mint: string;
  owner: string | null;
  decimals: number;
  rawAmountBefore: bigint;
  rawAmountAfter: bigint;
  rawDelta: bigint;
  decimalBefore: string;
  decimalAfter: string;
  decimalDelta: string;
}

export interface AggregatedTokenBalanceChange {
  mint: string;
  owner: string;
  decimals: number;
  rawAmountBefore: bigint;
  rawAmountAfter: bigint;
  rawDelta: bigint;
  decimalBefore: string;
  decimalAfter: string;
  decimalDelta: string;
  accountDeltas: TokenAccountBalanceChange[];
}

export interface NormalizedWalletTransaction {
  signature: string;
  wallet: string;
  slot: bigint;
  blockTime: string | null;
  observedAt: string;
  status: "succeeded" | "failed";
  native: NativeWalletBalanceChange | null;
  tokenChanges: AggregatedTokenBalanceChange[];
  individualTokenAccountChanges: TokenAccountBalanceChange[];
  confidence: ClassificationConfidence;
  ambiguityReasons: AmbiguityReason[];
}

export type WalletActivityClassification = "SWAP_BUY" | "SWAP_SELL" | "TRANSFER_IN" | "TRANSFER_OUT" | "COMPLEX_SWAP" | "UNKNOWN";

export interface ClassifiedWalletAction {
  classification: WalletActivityClassification;
  confidence: ClassificationConfidence;
  evidence: string[];
  ambiguityReasons: AmbiguityReason[];
  inputMint: string | null;
  inputRawAmount: bigint | null;
  inputDecimals: number | null;
  outputMint: string | null;
  outputRawAmount: bigint | null;
  outputDecimals: number | null;
  transactionSignature: string;
  wallet: string;
  slot: bigint;
  blockTime: string | null;
  observedAt: string;
}

function signedDecimal(value: bigint, decimals: number): string {
  return value < 0n ? `-${baseUnitsToDecimal(-value, decimals)}` : baseUnitsToDecimal(value, decimals);
}

function addReason(reasons: AmbiguityReason[], reason: AmbiguityReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function normalizeWalletTransaction(transaction: SolanaRpcTransaction, wallet: string, observedAt: string): NormalizedWalletTransaction {
  const reasons: AmbiguityReason[] = [];
  if (transaction.error !== null) addReason(reasons, "FAILED_TRANSACTION");
  const walletIndex = transaction.accountKeys.findIndex((key) => key.pubkey === wallet);
  let native: NativeWalletBalanceChange | null = null;
  if (walletIndex < 0 || transaction.preBalances[walletIndex] === undefined || transaction.postBalances[walletIndex] === undefined) {
    addReason(reasons, "UNSUPPORTED_STRUCTURE");
  } else {
    const preLamports = transaction.preBalances[walletIndex];
    const postLamports = transaction.postBalances[walletIndex];
    const walletIsFeePayer = walletIndex === 0 && transaction.accountKeys[0]?.signer === true;
    const rawDeltaLamports = postLamports - preLamports;
    native = {
      preLamports,
      postLamports,
      rawDeltaLamports,
      transactionFeeLamports: transaction.feeLamports,
      walletIsFeePayer,
      feeAdjustedEconomicDeltaLamports: walletIsFeePayer ? rawDeltaLamports + transaction.feeLamports : rawDeltaLamports
    };
  }

  if (transaction.preTokenBalances === null || transaction.postTokenBalances === null) addReason(reasons, "TOKEN_BALANCE_DATA_MISSING");
  const pre = transaction.preTokenBalances ?? [];
  const post = transaction.postTokenBalances ?? [];
  const keys = new Set([...pre, ...post].map((balance) => `${balance.accountIndex}:${balance.mint}`));
  const individual: TokenAccountBalanceChange[] = [];
  for (const key of keys) {
    const [indexText, mint = ""] = key.split(":");
    const accountIndex = Number(indexText);
    const before = pre.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const after = post.find((balance) => balance.accountIndex === accountIndex && balance.mint === mint);
    const owner = after?.owner ?? before?.owner ?? null;
    if (owner === null) {
      const beforeRaw = BigInt(before?.rawAmount ?? "0");
      const afterRaw = BigInt(after?.rawAmount ?? "0");
      if (beforeRaw !== afterRaw) addReason(reasons, "OWNER_MISSING");
      continue;
    }
    if (owner !== wallet) continue;
    const decimals = after?.decimals ?? before?.decimals;
    if (decimals === undefined || (before !== undefined && after !== undefined && before.decimals !== after.decimals)) {
      addReason(reasons, "UNSUPPORTED_STRUCTURE");
      continue;
    }
    const rawAmountBefore = BigInt(before?.rawAmount ?? "0");
    const rawAmountAfter = BigInt(after?.rawAmount ?? "0");
    const rawDelta = rawAmountAfter - rawAmountBefore;
    if (rawDelta === 0n) continue;
    individual.push({
      accountIndex,
      tokenAccount: transaction.accountKeys[accountIndex]?.pubkey ?? null,
      mint,
      owner,
      decimals,
      rawAmountBefore,
      rawAmountAfter,
      rawDelta,
      decimalBefore: baseUnitsToDecimal(rawAmountBefore, decimals),
      decimalAfter: baseUnitsToDecimal(rawAmountAfter, decimals),
      decimalDelta: signedDecimal(rawDelta, decimals)
    });
  }

  const grouped = new Map<string, TokenAccountBalanceChange[]>();
  for (const change of individual) {
    const groupKey = `${change.owner}:${change.mint}:${change.decimals}`;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), change]);
  }
  const tokenChanges: AggregatedTokenBalanceChange[] = [...grouped.values()].map((changes) => {
    const first = changes[0];
    if (first === undefined || first.owner === null) throw new Error("Invariant violation while grouping token balances");
    const rawAmountBefore = changes.reduce((sum, change) => sum + change.rawAmountBefore, 0n);
    const rawAmountAfter = changes.reduce((sum, change) => sum + change.rawAmountAfter, 0n);
    const rawDelta = rawAmountAfter - rawAmountBefore;
    return {
      mint: first.mint, owner: first.owner, decimals: first.decimals, rawAmountBefore, rawAmountAfter, rawDelta,
      decimalBefore: baseUnitsToDecimal(rawAmountBefore, first.decimals), decimalAfter: baseUnitsToDecimal(rawAmountAfter, first.decimals),
      decimalDelta: signedDecimal(rawDelta, first.decimals), accountDeltas: changes
    };
  });
  if (tokenChanges.some((change) => change.mint === WRAPPED_SOL_MINT) && native?.rawDeltaLamports !== 0n) addReason(reasons, "WRAPPED_SOL_FLOW");

  const confidence: ClassificationConfidence = transaction.error !== null || reasons.includes("UNSUPPORTED_STRUCTURE") || reasons.includes("TOKEN_BALANCE_DATA_MISSING")
    ? "UNKNOWN"
    : reasons.includes("OWNER_MISSING") ? "LOW" : reasons.length > 0 ? "MEDIUM" : "HIGH";
  return { signature: transaction.signature, wallet, slot: transaction.slot, blockTime: transaction.blockTime, observedAt, status: transaction.error === null ? "succeeded" : "failed", native, tokenChanges, individualTokenAccountChanges: individual, confidence, ambiguityReasons: reasons };
}

export interface WalletActionClassifierConfig {
  recognizedInputMints: ReadonlySet<string>;
}

export const DEFAULT_RECOGNIZED_INPUT_MINTS = new Set([NATIVE_SOL_MINT, WRAPPED_SOL_MINT, USDC_MINT]);

interface AssetFlow { mint: string; amount: bigint; decimals: number }

export function classifyWalletAction(normalized: NormalizedWalletTransaction, config: WalletActionClassifierConfig = { recognizedInputMints: DEFAULT_RECOGNIZED_INPUT_MINTS }): ClassifiedWalletAction {
  const evidence: string[] = [];
  const reasons = [...normalized.ambiguityReasons];
  if (normalized.status === "failed") return action("UNKNOWN", "UNKNOWN", null, null, normalized, evidence, reasons);
  if (normalized.confidence === "UNKNOWN") return action("UNKNOWN", "UNKNOWN", null, null, normalized, evidence, reasons);

  const losses: AssetFlow[] = [];
  const gains: AssetFlow[] = [];
  const economicSolDelta = normalized.native?.feeAdjustedEconomicDeltaLamports;
  if (economicSolDelta !== null && economicSolDelta !== undefined && economicSolDelta !== 0n) {
    (economicSolDelta < 0n ? losses : gains).push({ mint: NATIVE_SOL_MINT, amount: economicSolDelta < 0n ? -economicSolDelta : economicSolDelta, decimals: 9 });
    evidence.push(economicSolDelta < 0n ? "NATIVE_SOL_ECONOMIC_DECREASE" : "NATIVE_SOL_ECONOMIC_INCREASE");
  }
  for (const change of normalized.tokenChanges) {
    if (change.rawDelta < 0n) {
      losses.push({ mint: change.mint, amount: -change.rawDelta, decimals: change.decimals });
      evidence.push(`TOKEN_DECREASE:${change.mint}`);
    } else if (change.rawDelta > 0n) {
      gains.push({ mint: change.mint, amount: change.rawDelta, decimals: change.decimals });
      evidence.push(`TOKEN_INCREASE:${change.mint}`);
    }
  }
  if (losses.length > 1) addReason(reasons, "MULTIPLE_INPUT_ASSETS");
  if (gains.length > 1) addReason(reasons, "MULTIPLE_OUTPUT_ASSETS");
  if (losses.length > 1 || gains.length > 1) return action("COMPLEX_SWAP", normalized.confidence === "HIGH" ? "MEDIUM" : normalized.confidence, losses[0] ?? null, gains[0] ?? null, normalized, evidence, reasons);
  const input = losses[0] ?? null;
  const output = gains[0] ?? null;
  if (input === null && output !== null) return action("TRANSFER_IN", normalized.confidence, null, output, normalized, evidence, reasons);
  if (input !== null && output === null) return action("TRANSFER_OUT", normalized.confidence, input, null, normalized, evidence, reasons);
  if (input === null || output === null) return action("UNKNOWN", normalized.confidence === "HIGH" ? "LOW" : normalized.confidence, input, output, normalized, evidence, reasons);
  if (config.recognizedInputMints.has(input.mint) && !config.recognizedInputMints.has(output.mint)) return action("SWAP_BUY", normalized.confidence, input, output, normalized, evidence, reasons);
  if (!config.recognizedInputMints.has(input.mint) && config.recognizedInputMints.has(output.mint)) return action("SWAP_SELL", normalized.confidence, input, output, normalized, evidence, reasons);
  return action("UNKNOWN", normalized.confidence === "HIGH" ? "LOW" : normalized.confidence, input, output, normalized, evidence, reasons);
}

function action(classification: WalletActivityClassification, confidence: ClassificationConfidence, input: AssetFlow | null, output: AssetFlow | null, normalized: NormalizedWalletTransaction, evidence: string[], ambiguityReasons: AmbiguityReason[]): ClassifiedWalletAction {
  return {
    classification, confidence, evidence, ambiguityReasons,
    inputMint: input?.mint ?? null, inputRawAmount: input?.amount ?? null, inputDecimals: input?.decimals ?? null,
    outputMint: output?.mint ?? null, outputRawAmount: output?.amount ?? null, outputDecimals: output?.decimals ?? null,
    transactionSignature: normalized.signature, wallet: normalized.wallet, slot: normalized.slot,
    blockTime: normalized.blockTime, observedAt: normalized.observedAt
  };
}
