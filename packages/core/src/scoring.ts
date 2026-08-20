import { stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { ScoreComponent, WalletMetrics, WalletScore } from "./domain.js";

export interface ScoringConfiguration {
  minimumSampleSize: number;
  weights: {
    performanceQuality: number;
    consistency: number;
    earlyEntry: number;
    copyability: number;
    dataConfidence: number;
  };
  penalties: {
    crowding: number;
    followerSlippage: number;
    suspiciousCoordination: number;
    inadequateSample: number;
    staleActivity: number;
  };
  unknownDefault: number;
  staleAfterDays: number;
}

export const PROVISIONAL_SCORING_CONFIG: ScoringConfiguration = {
  minimumSampleSize: 20,
  weights: { performanceQuality: 0.25, consistency: 0.2, earlyEntry: 0.2, copyability: 0.25, dataConfidence: 0.1 },
  penalties: { crowding: 0.25, followerSlippage: 0.15, suspiciousCoordination: 0.15, inadequateSample: 0.2, staleActivity: 0.1 },
  unknownDefault: 0.35,
  staleAfterDays: 30
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function metric(value: number | null, fallback: number): { value: number; source: ScoreComponent["source"] } {
  return value === null || !Number.isFinite(value)
    ? { value: fallback, source: "unknown_default" }
    : { value: clamp(value), source: "observed" };
}

function returnQuality(metrics: WalletMetrics, unknownDefault: number): { value: number; source: ScoreComponent["source"] } {
  if (metrics.medianReturn === null && metrics.averageReturn === null) return { value: unknownDefault, source: "unknown_default" };
  const median = clamp(((metrics.medianReturn ?? 0) + 0.25) / 1.25);
  const cappedAverage = clamp(((Math.min(metrics.averageReturn ?? 0, 2) + 0.25) / 2.25));
  return { value: clamp(median * 0.75 + cappedAverage * 0.25), source: "derived" };
}

export function scoreWallet(
  metrics: WalletMetrics,
  lastObservedAt: string | null,
  calculatedAt: string,
  config: ScoringConfiguration = PROVISIONAL_SCORING_CONFIG
): WalletScore {
  const sampleFactor = clamp(metrics.sampleSize / config.minimumSampleSize);
  const observedConfidence = metric(metrics.dataConfidence, config.unknownDefault);
  const confidence = clamp(observedConfidence.value * sampleFactor);
  const positiveInputs = {
    performanceQuality: returnQuality(metrics, config.unknownDefault),
    consistency: metric(metrics.consistencyScore, config.unknownDefault),
    earlyEntry: metric(metrics.earlyEntryScore, config.unknownDefault),
    copyability: metric(metrics.copyabilityScore, config.unknownDefault),
    dataConfidence: { value: confidence, source: observedConfidence.source }
  } as const;

  const components: ScoreComponent[] = Object.entries(config.weights).map(([name, weight]) => {
    const item = positiveInputs[name as keyof typeof positiveInputs];
    return { name, value: item.value, weight, contribution: item.value * weight * 100, source: item.source };
  });

  const crowding = metric(metrics.crowdingScore, 0);
  const slippage = metric(metrics.followerSlippageEstimate, 0);
  const coordination = metric(metrics.suspiciousCoordinationScore, 0);
  const staleDays = lastObservedAt === null ? config.staleAfterDays : Math.max(0, (Date.parse(calculatedAt) - Date.parse(lastObservedAt)) / 86_400_000);
  const penalties = {
    crowding: crowding.value,
    followerSlippage: slippage.value,
    suspiciousCoordination: coordination.value,
    inadequateSample: 1 - sampleFactor,
    staleActivity: clamp(staleDays / config.staleAfterDays)
  };
  const penaltySources = {
    crowding: crowding.source,
    followerSlippage: slippage.source,
    suspiciousCoordination: coordination.source,
    inadequateSample: "derived" as const,
    staleActivity: "derived" as const
  };
  for (const [name, weight] of Object.entries(config.penalties)) {
    const value = penalties[name as keyof typeof penalties];
    components.push({ name: `${name}Penalty`, value, weight: -weight, contribution: -value * weight * 100, source: penaltySources[name as keyof typeof penaltySources] });
  }

  const total = clamp(components.reduce((sum, component) => sum + component.contribution, 0), 0, 100);
  const reasonCodes: string[] = [];
  if (sampleFactor < 1) reasonCodes.push("INSUFFICIENT_SAMPLE");
  if (crowding.value >= 0.5) reasonCodes.push("CROWDING_PENALTY");
  if (slippage.value >= 0.5) reasonCodes.push("FOLLOWER_SLIPPAGE_PENALTY");
  if (coordination.value >= 0.5) reasonCodes.push("SUSPICIOUS_COORDINATION_PENALTY");
  if (components.some((component) => component.source === "unknown_default")) reasonCodes.push("UNKNOWN_METRICS_PRESENT");

  const rulesetHash = stableHash(config as unknown as JsonValue);
  return { total: Math.round(total * 100) / 100, confidence: Math.round(confidence * 1000) / 1000, components, reasonCodes, rulesetHash, calculatedAt };
}
