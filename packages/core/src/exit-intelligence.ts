import { newId, stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import { z } from "zod";
import type { AIAnalysis, PaperPosition, PositionEvent, WalletAction } from "./domain.js";
import type { ExitRecommendation, PositionMark, ShadowPositionRecord, TokenRiskEvaluation } from "./runtime-domain.js";

export interface ExitRules { strongLossUsd: string; considerLossUsd: string; maximumPositionAgeMs: number; strongRisk: number; considerRisk: number }
export const PROVISIONAL_EXIT_RULES: ExitRules = { strongLossUsd: "-0.30", considerLossUsd: "-0.15", maximumPositionAgeMs: 3_600_000, strongRisk: 0.8, considerRisk: 0.6 };

export const aiExitResponseSchema = z.object({
  summary: z.string().min(1).max(500), supportingFactors: z.array(z.string().max(200)).max(10), contradictingFactors: z.array(z.string().max(200)).max(10),
  suggestedAction: z.enum(["HOLD", "CONSIDER_SELL", "SELL"]), confidence: z.number().min(0).max(1)
});
export type AIExitResponse = z.infer<typeof aiExitResponseSchema>;
export interface ExitAIProvider {
  readonly enabled: boolean;
  analyze(request: { purpose: string; systemPrompt: string; userPrompt: string; responseSchema: typeof aiExitResponseSchema }): Promise<{ modelRequested: string; modelReturned: string | null; value: AIExitResponse | null; latencyMs: number; cached: boolean; errorCode: string | null }>;
}
export interface AIExitStore { insertAIAnalysis(analysis: AIAnalysis): Promise<void> }

export class OptionalAIExitAnalyzer {
  constructor(private readonly store: AIExitStore, private readonly provider: ExitAIProvider) {}
  async analyze(position: PaperPosition, recommendation: ExitRecommendation): Promise<AIExitResponse | null> {
    if (!this.provider.enabled || recommendation.recommendation === "HOLD" || recommendation.recommendation === "INSUFFICIENT_DATA") return null;
    const input = { positionId: position.id, tokenMint: position.tokenMint, deterministicRecommendation: recommendation.recommendation, reasonCodes: recommendation.reasonCodes, estimatedPnlUsd: position.unrealizedPnlUsd, manualControl: position.state === "manual_control" };
    const result = await this.provider.analyze({ purpose: "secondary_exit_analysis", systemPrompt: "Return concise structured secondary analysis. You cannot authorize a trade, override deterministic controls, or claim certainty. Use only supplied facts.", userPrompt: JSON.stringify(input), responseSchema: aiExitResponseSchema });
    const analysis: AIAnalysis = { id: newId(), purpose: "secondary_exit_analysis", modelRequested: result.modelRequested, modelReturned: result.modelReturned, promptHash: stableHash(input as unknown as JsonValue), structuredResponse: result.value as JsonValue | null, latencyMs: result.latencyMs, errorCode: result.errorCode, requestMetadata: { positionId: position.id, recommendationId: recommendation.id, cached: result.cached }, createdAt: new Date().toISOString() };
    await this.store.insertAIAnalysis(analysis);
    return result.value;
  }
}

export function recommendExit(position: PaperPosition, mark: PositionMark | null, tokenRisk: TokenRiskEvaluation | null, sourceEvents: PositionEvent[], now: string, rules: ExitRules = PROVISIONAL_EXIT_RULES): ExitRecommendation {
  const reasons: string[] = [];
  let recommendation: ExitRecommendation["recommendation"] = "HOLD";
  if (mark === null || mark.grossUnrealizedPnlUsd === null) { recommendation = "INSUFFICIENT_DATA"; reasons.push("MARK_UNKNOWN"); }
  if (mark !== null && !mark.routeAvailable) { recommendation = "STRONG_SELL_SIGNAL"; reasons.push("MARKET_ROUTE_DISAPPEARED"); }
  if (mark?.grossUnrealizedPnlUsd !== null && mark?.grossUnrealizedPnlUsd !== undefined) {
    if (Number(mark.grossUnrealizedPnlUsd) <= Number(rules.strongLossUsd)) { recommendation = "STRONG_SELL_SIGNAL"; reasons.push("SEVERE_ADVERSE_MOVEMENT"); }
    else if (Number(mark.grossUnrealizedPnlUsd) <= Number(rules.considerLossUsd) && recommendation !== "STRONG_SELL_SIGNAL") { recommendation = "CONSIDER_SELL"; reasons.push("ADVERSE_MOVEMENT"); }
  }
  if (sourceEvents.some((event) => event.type === "source_wallet_full_sell")) { recommendation = "STRONG_SELL_SIGNAL"; reasons.push("SOURCE_WALLET_FULL_SELL"); }
  else if (sourceEvents.some((event) => event.type === "source_wallet_partial_sell") && recommendation !== "STRONG_SELL_SIGNAL") { recommendation = "CONSIDER_SELL"; reasons.push("SOURCE_WALLET_PARTIAL_SELL"); }
  if (tokenRisk !== null && tokenRisk.totalRisk >= rules.strongRisk) { recommendation = "STRONG_SELL_SIGNAL"; reasons.push("TOKEN_RISK_SEVERE"); }
  else if (tokenRisk !== null && tokenRisk.totalRisk >= rules.considerRisk && recommendation === "HOLD") { recommendation = "CONSIDER_SELL"; reasons.push("TOKEN_RISK_DETERIORATED"); }
  if (Date.parse(now) - Date.parse(position.openedAt) >= rules.maximumPositionAgeMs && recommendation === "HOLD") { recommendation = "CONSIDER_SELL"; reasons.push("POSITION_AGE_LIMIT"); }
  if (reasons.length === 0) reasons.push("NO_EXIT_TRIGGER");
  const confidence = mark === null ? "LOW" : tokenRisk === null ? "MEDIUM" : "HIGH";
  const inputSnapshot = { markId: mark?.id ?? null, tokenRiskId: tokenRisk?.id ?? null, sourceEventIds: sourceEvents.map((event) => event.id), manualControl: position.state === "manual_control" };
  return { id: newId(), positionId: position.id, recommendation, reasonCodes: reasons, confidence, inputSnapshot, createdAt: now, rulesetHash: stableHash(rules as unknown as JsonValue) };
}

export interface SourceMonitorStore { listPositions(): Promise<PaperPosition[]>; getShadowPositionRecord(positionId: string): Promise<ShadowPositionRecord | null>; listPositionEvents(positionId: string, limit: number): Promise<PositionEvent[]>; appendPositionEvent(event: PositionEvent): Promise<"inserted" | "duplicate"> }
export class SourceWalletPositionMonitor {
  constructor(private readonly store: SourceMonitorStore) {}
  async observe(action: WalletAction): Promise<PositionEvent[]> {
    const positions = (await this.store.listPositions()).filter((position) => position.state !== "closed" && position.triggerWallet === action.wallet && position.tokenMint === action.tokenMint);
    const events: PositionEvent[] = [];
    for (const position of positions) {
      const context = await this.store.getShadowPositionRecord(position.id);
      const knownSourceAmount = context?.context.sourceOutputRawAmount ?? null;
      const history = await this.store.listPositionEvents(position.id, 1_000);
      const priorReduction = history.reduce((sum, event) => { const details = event.details as { reductionRaw?: string; completeness?: number }; return sum + (details.completeness === 1 && /^\d+$/.test(details.reductionRaw ?? "") ? BigInt(details.reductionRaw ?? "0") : 0n); }, 0n);
      const current = knownSourceAmount === null ? null : knownSourceAmount > priorReduction ? knownSourceAmount - priorReduction : 0n;
      const reduction = action.inputRawAmount;
      const complete = current !== null && reduction !== null && action.classificationConfidence !== "UNKNOWN";
      const fullSell = action.classification === "SWAP_SELL" && complete && reduction >= current;
      const type: PositionEvent["type"] = fullSell ? "source_wallet_full_sell" : action.classification === "SWAP_SELL" && complete ? "source_wallet_partial_sell" : action.classification === "TRANSFER_OUT" ? "source_wallet_transfer_out" : "source_activity_ambiguous";
      const remaining = complete && current !== null && reduction !== null ? current > reduction ? current - reduction : 0n : null;
      const event = { id: newId(), positionId: position.id, type, createdAt: action.observedAt, details: { transactionSignature: action.transactionSignature, balanceAfterTriggerRaw: knownSourceAmount?.toString() ?? null, balanceBeforeRaw: current?.toString() ?? null, reductionRaw: reduction?.toString() ?? null, reconstructedBalanceRaw: remaining?.toString() ?? null, completeness: complete ? 1 : 0, confidence: complete ? "MEDIUM" : "UNKNOWN", classification: type === "source_wallet_full_sell" ? "FULL_OBSERVED_EXIT" : type === "source_wallet_partial_sell" ? "PARTIAL_SELL" : type === "source_wallet_transfer_out" ? "TRANSFER_OUT" : "UNKNOWN_REDUCTION" }, idempotencyKey: `source:${position.id}:${action.transactionSignature}:${type}` } satisfies PositionEvent;
      if (await this.store.appendPositionEvent(event) === "inserted") events.push(event);
    }
    return events;
  }
}
