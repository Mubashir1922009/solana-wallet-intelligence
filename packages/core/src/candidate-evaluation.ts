import type { JsonValue } from "@intelligence/shared";
import type { CandidateEvaluation, CandidateEvaluationState, WalletReputationSnapshot } from "./runtime-domain.js";

export interface CandidatePromotionRules { minimumSampleSize: number; minimumIndependentTokens: number; minimumProvisionalScore: number; maximumCrowdingFrequency: number }
export const PROVISIONAL_CANDIDATE_RULES: CandidatePromotionRules = { minimumSampleSize: 8, minimumIndependentTokens: 3, minimumProvisionalScore: 62, maximumCrowdingFrequency: 0.45 };

export function evaluateCandidate(wallet: string, reputation: WalletReputationSnapshot | null, independentTokenCount: number, evidenceKnownAtEvaluation: JsonValue, evaluatedAt: string, rules: CandidatePromotionRules = PROVISIONAL_CANDIDATE_RULES): CandidateEvaluation {
  if (containsFutureTimestamp(evidenceKnownAtEvaluation, Date.parse(evaluatedAt))) throw new Error("Candidate evidence contains information timestamp after evaluation time");
  const reasons: string[] = [];
  let state: CandidateEvaluationState = "EVALUATING";
  if (reputation === null || reputation.sampleSize < rules.minimumSampleSize || independentTokenCount < rules.minimumIndependentTokens) {
    state = "INSUFFICIENT_DATA"; reasons.push("MINIMUM_SAMPLE_NOT_MET");
  } else if (reputation.crowdingFrequency !== null && reputation.crowdingFrequency > rules.maximumCrowdingFrequency) {
    state = "REJECTED"; reasons.push("CROWDING_TOO_HIGH");
  } else if (reputation.provisionalScore >= rules.minimumProvisionalScore) {
    state = "TRACK_ELIGIBLE"; reasons.push("PROVISIONAL_THRESHOLDS_MET");
  } else { state = "REJECTED"; reasons.push("FOLLOWER_EXPECTANCY_THRESHOLD_NOT_MET"); }
  return { wallet, state, sampleSize: reputation?.sampleSize ?? 0, independentTokenCount, provisionalScore: reputation?.provisionalScore ?? null, evidenceAtEvaluation: evidenceKnownAtEvaluation, reasonCodes: reasons, evaluatedAt, rulesetHash: JSON.stringify(rules) };
}

function containsFutureTimestamp(value: JsonValue, cutoff: number): boolean {
  if (Array.isArray(value)) return value.some((item) => containsFutureTimestamp(item, cutoff));
  if (value !== null && typeof value === "object") return Object.values(value).some((item) => containsFutureTimestamp(item, cutoff));
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > cutoff;
}
