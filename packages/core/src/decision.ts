import { stableHash, newId } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { DecisionKind, Signal, TradeDecision } from "./domain.js";

export interface DecisionRules {
  minimumWalletScore: number;
  maximumCrowdingScore: number;
  maximumTokenRiskScore: number;
  minimumSignalConfidence: number;
}

export const PROVISIONAL_DECISION_RULES: DecisionRules = {
  minimumWalletScore: 60,
  maximumCrowdingScore: 0.7,
  maximumTokenRiskScore: 0.4,
  minimumSignalConfidence: 0.5
};

export function decideSignal(signal: Omit<Signal, "decision" | "rejectionReasons">, rules: DecisionRules = PROVISIONAL_DECISION_RULES): TradeDecision {
  const reasons: string[] = [];
  let decision: DecisionKind = "BUY";
  if (signal.walletScore.total < rules.minimumWalletScore) reasons.push("WALLET_SCORE_BELOW_THRESHOLD");
  if (signal.antiCrowdingScore === null) reasons.push("CROWDING_UNKNOWN");
  else if (signal.antiCrowdingScore > rules.maximumCrowdingScore) reasons.push("CROWDING_TOO_HIGH");
  if (signal.tokenRiskSnapshot === null || signal.tokenRiskSnapshot.riskScore === null) reasons.push("TOKEN_RISK_UNKNOWN");
  else if (signal.tokenRiskSnapshot.riskScore > rules.maximumTokenRiskScore) reasons.push("TOKEN_RISK_TOO_HIGH");
  if (signal.confidence === null || signal.confidence < rules.minimumSignalConfidence) reasons.push("SIGNAL_CONFIDENCE_TOO_LOW");
  if (reasons.includes("TOKEN_RISK_TOO_HIGH") || reasons.includes("CROWDING_TOO_HIGH")) decision = "REJECT";
  else if (reasons.length > 0) decision = "OBSERVE";
  const now = new Date().toISOString();
  return {
    id: newId(), signalId: signal.id, decision, reasonCodes: reasons,
    parameters: rules as unknown as JsonValue,
    rulesetHash: stableHash(rules as unknown as JsonValue), createdAt: now
  };
}
