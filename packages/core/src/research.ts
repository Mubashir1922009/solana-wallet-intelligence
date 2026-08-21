import type { JsonValue } from "@intelligence/shared";

export interface ResearchObservation {
  signalAt: string; decision: "BUY" | "OBSERVE" | "REJECT"; walletScore: number; tokenRisk: number | null; crowding: number | null;
  copyabilityKnown: boolean; routeAvailable: boolean | null; followerReturn: number | null; sourceReturn: number | null; deteriorationBps: number | null;
  outcomeStatus: "VALID_OBSERVATION" | "NO_ROUTE" | "MISSING_OBSERVATION";
}
export interface WalkForwardOptions { trainingMs: number; evaluationMs: number; stepMs: number }

export function walkForwardReport(input: ResearchObservation[], options: WalkForwardOptions): JsonValue {
  const ordered = [...input].sort((a, b) => a.signalAt.localeCompare(b.signalAt));
  if (ordered.length === 0) return { posture: "SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS", sampleSize: 0, windows: [] };
  const first = Date.parse(ordered[0]?.signalAt ?? ""); const last = Date.parse(ordered.at(-1)?.signalAt ?? ""); const windows: JsonValue[] = [];
  for (let start = first; start + options.trainingMs < last; start += options.stepMs) {
    const cutoff = start + options.trainingMs; const end = cutoff + options.evaluationMs;
    const training = ordered.filter((item) => Date.parse(item.signalAt) >= start && Date.parse(item.signalAt) < cutoff);
    const evaluation = ordered.filter((item) => Date.parse(item.signalAt) >= cutoff && Date.parse(item.signalAt) < end);
    if (evaluation.length === 0) continue;
    windows.push({ trainingStart: new Date(start).toISOString(), evaluationStart: new Date(cutoff).toISOString(), evaluationEnd: new Date(end).toISOString(), trainingSampleSize: training.length, evaluation: summarize(evaluation) });
  }
  return { posture: "SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS", sampleSize: ordered.length, options, windows, aggregate: summarize(ordered) } as unknown as JsonValue;
}

function summarize(items: ResearchObservation[]): JsonValue {
  const valid = items.filter((item) => item.outcomeStatus === "VALID_OBSERVATION" && item.followerReturn !== null);
  const returns = valid.map((item) => item.followerReturn as number); const sorted = [...returns].sort((a, b) => a - b);
  const sourcePairs = valid.filter((item): item is ResearchObservation & { followerReturn: number; sourceReturn: number } => item.sourceReturn !== null);
  return { sampleSize: items.length, decisions: { BUY: count(items, "BUY"), OBSERVE: count(items, "OBSERVE"), REJECT: count(items, "REJECT") }, copyableRate: ratio(items.filter((item) => item.copyabilityKnown).length, items.length), routeAvailability: ratio(items.filter((item) => item.routeAvailable === true).length, items.filter((item) => item.routeAvailable !== null).length), validOutcomeSample: valid.length, noRouteSample: items.filter((item) => item.outcomeStatus === "NO_ROUTE").length, missingSample: items.filter((item) => item.outcomeStatus === "MISSING_OBSERVATION").length, medianFollowerReturn: median(sorted), meanFollowerReturn: mean(returns), downsideMedian: median(sorted.filter((value) => value < 0)), winRate: ratio(returns.filter((value) => value > 0).length, returns.length), approximateMaxDrawdown: maxDrawdown(returns), medianDeteriorationBps: median(items.map((item) => item.deteriorationBps).filter((value): value is number => value !== null)), sourceComparison: { sampleSize: sourcePairs.length, medianSourceReturn: median(sourcePairs.map((item) => item.sourceReturn)), medianFollowerDeterioration: median(sourcePairs.map((item) => item.sourceReturn - item.followerReturn)) }, tokenRiskRejections: items.filter((item) => item.decision === "REJECT" && item.tokenRisk !== null).length, crowdingBuckets: numericBuckets(valid, "crowding", [["unknown", null, null], ["0-.2", 0, 0.2], [".2-.5", 0.2, 0.5], [".5-1", 0.5, 1.01]]), scoreBuckets: scoreBuckets(valid) } as JsonValue;
}
function count(items: ResearchObservation[], decision: ResearchObservation["decision"]): number { return items.filter((item) => item.decision === decision).length; }
function ratio(a: number, b: number): number | null { return b === 0 ? null : a / b; }
function mean(values: number[]): number | null { return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length; }
function median(values: number[]): number | null { if (values.length === 0) return null; const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 === 1 ? s[m] ?? null : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2; }
function maxDrawdown(values: number[]): number | null { if (values.length === 0) return null; let equity = 1; let peak = 1; let worst = 0; for (const value of values) { equity *= 1 + value; peak = Math.max(peak, equity); worst = Math.min(worst, equity / peak - 1); } return worst; }
function scoreBuckets(items: ResearchObservation[]): JsonValue { const result: Record<string, JsonValue> = {}; for (const [name, min, max] of [["0-39", 0, 40], ["40-59", 40, 60], ["60-79", 60, 80], ["80-100", 80, 101]] as const) { const rows = items.filter((item) => item.walletScore >= min && item.walletScore < max); result[name] = { sampleSize: rows.length, medianFollowerReturn: median(rows.map((item) => item.followerReturn).filter((v): v is number => v !== null)) }; } return result; }
function numericBuckets(items: ResearchObservation[], field: "crowding", buckets: ReadonlyArray<readonly [string, number | null, number | null]>): JsonValue { const result: Record<string, JsonValue> = {}; for (const [name, min, max] of buckets) { const rows = items.filter((item) => min === null ? item[field] === null : item[field] !== null && item[field] >= min && item[field] < (max ?? Number.POSITIVE_INFINITY)); result[name] = { sampleSize: rows.length, medianFollowerReturn: median(rows.map((item) => item.followerReturn).filter((value): value is number => value !== null)) }; } return result; }
