import { newId } from "@intelligence/shared";
import type { ClassifiedWalletAction, ClassificationConfidence } from "./solana.js";

export interface CrowdingConfiguration { windowsMs: readonly number[] }
export const PROVISIONAL_CROWDING_CONFIG: CrowdingConfiguration = { windowsMs: [5_000, 30_000, 60_000] };

export interface CrowdingWindowObservation { windowMs: number; followerWalletCount: number; followerActionCount: number; delayMs: number[] }

export interface CrowdingObservation {
  id: string;
  sourceWallet: string;
  sourceTransactionSignature: string;
  tokenMint: string;
  observedAt: string;
  windows: CrowdingWindowObservation[];
  observedInputVolumeRaw: bigint | null;
  observedInputMint: string | null;
  monitoredWalletCount: number | null;
  expectedCoverageWalletCount: number | null;
  coverageRatio: number | null;
  confidence: ClassificationConfidence;
  status: "OBSERVED" | "UNKNOWN";
  reasons: string[];
}

export interface CrowdingCoverage { monitoredWalletCount: number | null; expectedCoverageWalletCount: number | null }

export function evaluateCrowding(source: ClassifiedWalletAction, observedActions: ClassifiedWalletAction[], coverage: CrowdingCoverage, observedAt: string, config: CrowdingConfiguration = PROVISIONAL_CROWDING_CONFIG): CrowdingObservation {
  const reasons: string[] = [];
  const sourceTime = source.blockTime === null ? null : Date.parse(source.blockTime);
  if (sourceTime === null || !Number.isFinite(sourceTime)) reasons.push("SOURCE_TIME_UNKNOWN");
  if (coverage.monitoredWalletCount === null || coverage.expectedCoverageWalletCount === null || coverage.expectedCoverageWalletCount <= 0) reasons.push("COVERAGE_UNKNOWN");
  const coverageRatio = coverage.monitoredWalletCount === null || coverage.expectedCoverageWalletCount === null || coverage.expectedCoverageWalletCount <= 0
    ? null : Math.min(1, coverage.monitoredWalletCount / coverage.expectedCoverageWalletCount);
  if (coverageRatio !== null && coverageRatio < 0.5) reasons.push("LOW_OBSERVATION_COVERAGE");

  const candidates = sourceTime === null ? [] : observedActions.flatMap((action) => {
    if (action.wallet === source.wallet || action.classification !== "SWAP_BUY" || action.outputMint !== source.outputMint || action.blockTime === null) return [];
    const delay = Date.parse(action.blockTime) - sourceTime;
    return delay >= 0 && delay <= Math.max(...config.windowsMs) ? [{ action, delay }] : [];
  });
  const windows = [...config.windowsMs].sort((a, b) => a - b).map((windowMs) => {
    const actions = candidates.filter((candidate) => candidate.delay <= windowMs);
    return { windowMs, followerWalletCount: new Set(actions.map(({ action }) => action.wallet)).size, followerActionCount: actions.length, delayMs: actions.map(({ delay }) => delay) };
  });
  const sameInputMint = candidates.length > 0 && candidates.every(({ action }) => action.inputMint === candidates[0]?.action.inputMint && action.inputRawAmount !== null);
  const observedInputVolumeRaw = sameInputMint ? candidates.reduce((sum, { action }) => sum + (action.inputRawAmount ?? 0n), 0n) : null;
  if (candidates.length > 0 && !sameInputMint) reasons.push("VOLUME_ASSETS_INCOMPATIBLE");
  const status = sourceTime === null || coverageRatio === null ? "UNKNOWN" : "OBSERVED";
  const confidence: ClassificationConfidence = coverageRatio === null || status === "UNKNOWN" ? "UNKNOWN" : coverageRatio >= 0.8 ? "HIGH" : coverageRatio >= 0.5 ? "MEDIUM" : "LOW";
  return {
    id: newId(), sourceWallet: source.wallet, sourceTransactionSignature: source.transactionSignature, tokenMint: source.outputMint ?? "UNKNOWN", observedAt,
    windows, observedInputVolumeRaw, observedInputMint: sameInputMint ? candidates[0]?.action.inputMint ?? null : null,
    monitoredWalletCount: coverage.monitoredWalletCount, expectedCoverageWalletCount: coverage.expectedCoverageWalletCount,
    coverageRatio, confidence, status, reasons
  };
}
