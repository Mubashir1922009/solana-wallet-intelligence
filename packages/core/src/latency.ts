import type { PipelineLatency, PipelineTimestamps } from "./domain.js";

function difference(later: string | null, earlier: string | null): number | null {
  if (later === null || earlier === null) return null;
  const value = Date.parse(later) - Date.parse(earlier);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function calculatePipelineLatency(timestamps: PipelineTimestamps): PipelineLatency {
  return {
    observableIngestionMs: difference(timestamps.providerReceivedAt, timestamps.chainEventAt),
    normalizationMs: difference(timestamps.normalizationCompletedAt, timestamps.providerReceivedAt),
    signalDecisionMs: difference(timestamps.decisionCompletedAt, timestamps.signalCreatedAt),
    decisionExecutionMs: difference(timestamps.simulatedExecutionAt, timestamps.decisionCompletedAt),
    totalObservableMs: difference(timestamps.simulatedExecutionAt, timestamps.providerReceivedAt)
  };
}
