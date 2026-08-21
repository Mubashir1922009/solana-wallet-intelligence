import { newId, stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import { evaluateCopyability } from "./copyability.js";
import { evaluateCrowding } from "./crowding.js";
import type { PaperPosition, Signal, TokenRiskSnapshot, TradeDecision, WalletAction, WalletMetrics } from "./domain.js";
import { PaperExecutionService } from "./execution.js";
import { marketQuoteToEntrySnapshot, type MarketQuoteRequest, type MarketQuoteResult } from "./market.js";
import type { ClassifiedWalletAction } from "./solana.js";
import { scoreWallet } from "./scoring.js";
import type { ShadowPositionRecord, TokenIntelligenceSnapshot, TokenRiskEvaluation } from "./runtime-domain.js";
import { evaluateTokenRisk, type TokenRiskRules, PROVISIONAL_TOKEN_RISK_RULES } from "./token-risk.js";
import type { IntelligenceStore } from "./store.js";

export interface ShadowRuntimeStore extends IntelligenceStore {
  listRecentWalletActions(limit: number): Promise<WalletAction[]>;
  insertTokenIntelligenceSnapshot(snapshot: TokenIntelligenceSnapshot): Promise<void>;
  insertTokenRiskEvaluation(evaluation: TokenRiskEvaluation): Promise<void>;
  insertShadowPositionRecord(record: ShadowPositionRecord): Promise<void>;
}
export interface ShadowTokenProvider { observeToken(mint: string): Promise<TokenIntelligenceSnapshot> }
export interface ShadowQuoteProvider { readonly enabled: boolean; getQuote(request: MarketQuoteRequest): Promise<MarketQuoteResult> }

export interface ShadowDecisionRules {
  minimumWalletScore: number;
  minimumWalletConfidence: number;
  maximumTokenRisk: number;
  maximumCrowdingRatio: number;
  minimumCopyabilityConfidence: "LOW" | "MEDIUM" | "HIGH";
}
export const PROVISIONAL_SHADOW_DECISION_RULES: ShadowDecisionRules = { minimumWalletScore: 60, minimumWalletConfidence: 0.5, maximumTokenRisk: 0.55, maximumCrowdingRatio: 0.5, minimumCopyabilityConfidence: "MEDIUM" };

export class ShadowRuntimeControl {
  private watcherPaused = false;
  private killed = false;
  pauseWatcher(): void { this.watcherPaused = true; }
  resumeWatcher(): void { this.watcherPaused = false; }
  killShadowEngine(): void { this.killed = true; }
  restoreShadowEngine(): void { this.killed = false; }
  snapshot(): { botState: "RUNNING" | "PAUSED" | "KILLED"; watcherPaused: boolean; killSwitchActive: boolean } { return { botState: this.killed ? "KILLED" : this.watcherPaused ? "PAUSED" : "RUNNING", watcherPaused: this.watcherPaused, killSwitchActive: this.killed }; }
}

export interface ShadowProcessResult { outcome: "OPENED" | "OBSERVED" | "REJECTED" | "DUPLICATE" | "DISABLED"; signal: Signal | null; decision: TradeDecision | null; position: PaperPosition | null; tokenRisk: TokenRiskEvaluation | null; reasonCodes: string[] }

export class ContinuousShadowRuntime {
  private readonly executor: PaperExecutionService;
  constructor(private readonly store: ShadowRuntimeStore, private readonly tokenProvider: ShadowTokenProvider, private readonly quoteProvider: ShadowQuoteProvider, private readonly control: ShadowRuntimeControl, private readonly options: { executionMode: "PAPER" | "SHADOW"; paperTradeUsd: string; maximumTradeUsd: string; maximumQuoteAgeMs: number; quoteInputMint: string; quoteInputDecimals: number; crowdingCoverageExpected: number; decisionRules?: ShadowDecisionRules; tokenRiskRules?: TokenRiskRules; onOpened?: (position: PaperPosition, signal: Signal) => Promise<void> | void }) {
    this.executor = new PaperExecutionService(store, options.paperTradeUsd, options.maximumTradeUsd, options.maximumQuoteAgeMs);
  }

  async process(action: ClassifiedWalletAction): Promise<ShadowProcessResult> {
    if (action.classification !== "SWAP_BUY" || action.outputMint === null || action.outputDecimals === null) return empty("OBSERVED", ["ACTION_NOT_CANDIDATE_BUY"]);
    if (!this.quoteProvider.enabled) return empty("DISABLED", ["MARKET_QUOTE_PROVIDER_DISABLED"]);
    const wallet = await this.store.getWallet(action.wallet);
    const metrics = wallet?.metrics ?? insufficientMetrics(wallet?.id ?? newId());
    const now = new Date().toISOString();
    const walletScore = scoreWallet(metrics, wallet?.lastObservedAt ?? null, now);
    const tokenIntelligence = await this.tokenProvider.observeToken(action.outputMint);
    await this.store.insertTokenIntelligenceSnapshot(tokenIntelligence);
    const inputRawAmount = usdToRaw(this.options.paperTradeUsd, this.options.quoteInputDecimals);
    const quoteResult = await this.quoteProvider.getQuote({ inputMint: this.options.quoteInputMint, outputMint: action.outputMint, inputRawAmount, inputDecimals: this.options.quoteInputDecimals, outputDecimals: action.outputDecimals });
    const market = quoteResult.observation;
    await this.store.insertMarketObservation(market);
    const tokenRisk = evaluateTokenRisk(tokenIntelligence, market, now, this.options.tokenRiskRules ?? PROVISIONAL_TOKEN_RISK_RULES);
    await this.store.insertTokenRiskEvaluation(tokenRisk);
    const recent = await this.store.listRecentWalletActions(1_000);
    const classifiedRecent = recent.map(toClassified);
    const trackingCount = (await this.store.listWallets()).filter((item) => item.status === "tracking").length;
    const crowding = evaluateCrowding(action, classifiedRecent, { monitoredWalletCount: trackingCount, expectedCoverageWalletCount: this.options.crowdingCoverageExpected }, now);
    await this.store.insertCrowdingObservation(crowding);
    const copyability = evaluateCopyability(action, market, { transactionObservedAt: action.observedAt, normalizationCompletedAt: now, signalGeneratedAt: now, decisionAt: now }, now);
    await this.store.insertCopyabilityEvaluation(copyability);
    const crowdingRatio = crowding.monitoredWalletCount === null || crowding.monitoredWalletCount <= 0 ? null : (crowding.windows.at(-1)?.followerWalletCount ?? 0) / crowding.monitoredWalletCount;
    const signalId = newId();
    const decisionData = decideShadow(walletScore.total, walletScore.confidence, tokenRisk, market.routeAvailable, crowdingRatio, copyability.confidence, this.control.snapshot().killSwitchActive, this.options.decisionRules ?? PROVISIONAL_SHADOW_DECISION_RULES);
    const legacyRisk = legacyRiskSnapshot(action.outputMint, tokenRisk, tokenIntelligence, market);
    const signal: Signal = { id: signalId, sourceWallet: action.wallet, tokenMint: action.outputMint, sourceTransactionSignature: action.transactionSignature, detectedAt: now, chainEventAt: action.blockTime, chainSlot: action.slot, walletScore, antiCrowdingScore: crowdingRatio, tokenRiskSnapshot: legacyRisk, decision: decisionData.decision, rejectionReasons: decisionData.reasons, confidence: Math.min(walletScore.confidence, tokenRisk.dataCompleteness) };
    if (await this.store.insertSignal(signal) === "duplicate") return { outcome: "DUPLICATE", signal: null, decision: null, position: null, tokenRisk, reasonCodes: ["DUPLICATE_SIGNAL"] };
    const decision: TradeDecision = { id: newId(), signalId, decision: decisionData.decision, reasonCodes: decisionData.reasons, parameters: (this.options.decisionRules ?? PROVISIONAL_SHADOW_DECISION_RULES) as unknown as JsonValue, rulesetHash: stableHash((this.options.decisionRules ?? PROVISIONAL_SHADOW_DECISION_RULES) as unknown as JsonValue), createdAt: now };
    await this.store.insertDecision(decision);
    if (decision.decision !== "BUY") return { outcome: decision.decision === "REJECT" ? "REJECTED" : "OBSERVED", signal, decision, position: null, tokenRisk, reasonCodes: decision.reasonCodes };
    const position = await this.executor.openApprovedSignal(signal, decision, { market: marketQuoteToEntrySnapshot(market), tokenDecimals: action.outputDecimals });
    if (position === null) return { outcome: "OBSERVED", signal, decision, position: null, tokenRisk, reasonCodes: ["POSITION_NOT_OPENED"] };
    await this.store.insertShadowPositionRecord({ positionId: position.id, createdAt: now, context: { mode: this.options.executionMode, sourceTransactionSignature: action.transactionSignature, signalTimestamp: signal.detectedAt, quoteTimestamp: market.receivedAt, walletScore, tokenRisk, crowding, copyability, sourceOutputRawAmount: action.outputRawAmount, simulatedOutputRawAmount: position.tokenRawAmount, quoteProvenance: market.provenance, latencies: { detectionMs: copyability.detectionLatencyMs, quoteMs: copyability.quoteLatencyMs, totalFollowerMs: copyability.totalFollowerLatencyMs } } });
    await this.options.onOpened?.(position, signal);
    return { outcome: "OPENED", signal, decision, position, tokenRisk, reasonCodes: decision.reasonCodes };
  }
}

function decideShadow(walletScore: number, walletConfidence: number, risk: TokenRiskEvaluation, route: boolean, crowdingRatio: number | null, copyConfidence: string, killed: boolean, rules: ShadowDecisionRules): { decision: "BUY" | "OBSERVE" | "REJECT"; reasons: string[] } {
  const reasons: string[] = [];
  if (killed) reasons.push("REJECT_KILL_SWITCH");
  if (!route) reasons.push("REJECT_NO_MARKET_ROUTE");
  if (risk.totalRisk > rules.maximumTokenRisk) reasons.push(risk.reasonCodes.includes("MINT_AUTHORITY_ACTIVE") || risk.reasonCodes.includes("FREEZE_AUTHORITY_ACTIVE") ? "REJECT_TOKEN_AUTHORITY_RISK" : risk.reasonCodes.includes("CONCENTRATION_HIGH") || risk.reasonCodes.includes("TOP10_CONCENTRATION_HIGH") ? "REJECT_EXTREME_CONCENTRATION" : "REJECT_TOKEN_RISK");
  if (crowdingRatio !== null && crowdingRatio > rules.maximumCrowdingRatio) reasons.push("REJECT_CROWDING");
  if (reasons.some((reason) => reason.startsWith("REJECT_"))) return { decision: "REJECT", reasons };
  if (walletScore < rules.minimumWalletScore || walletConfidence < rules.minimumWalletConfidence) reasons.push("OBSERVE_INSUFFICIENT_WALLET_EVIDENCE");
  if (risk.confidence === "LOW" || risk.confidence === "UNKNOWN") reasons.push("OBSERVE_INSUFFICIENT_TOKEN_DATA");
  const ranks: Record<string, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  if ((ranks[copyConfidence] ?? 0) < (ranks[rules.minimumCopyabilityConfidence] ?? 0)) reasons.push("OBSERVE_LOW_COPYABILITY_CONFIDENCE");
  return reasons.length > 0 ? { decision: "OBSERVE", reasons } : { decision: "BUY", reasons: ["BUY_RULES_PASSED"] };
}

function legacyRiskSnapshot(tokenMint: string, risk: TokenRiskEvaluation, intelligence: TokenIntelligenceSnapshot, market: MarketQuoteResult["observation"]): TokenRiskSnapshot {
  return { id: risk.id, tokenMint, timestamp: risk.evaluatedAt, liquidityUsd: null, holderConcentration: intelligence.concentration.top10AccountsPct === null ? null : Number(intelligence.concentration.top10AccountsPct) / 100, mintAuthorityActive: intelligence.mint.mintAuthorityKnown ? intelligence.mint.mintAuthority !== null : null, freezeAuthorityActive: intelligence.mint.freezeAuthorityKnown ? intelligence.mint.freezeAuthority !== null : null, creator: null, funder: null, priceImpactBps: market.priceImpactPct === null ? null : Math.round(Math.abs(Number(market.priceImpactPct)) * 100), routeAvailable: market.routeAvailable, warningFlags: risk.reasonCodes, riskScore: risk.totalRisk, dataConfidence: risk.dataCompleteness };
}
function usdToRaw(usd: string, decimals: number): bigint { const [whole = "0", fraction = ""] = usd.split("."); return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals)); }
function insufficientMetrics(walletId: string): WalletMetrics { return { walletId, sampleSize: 0, observedTrades: 0, realizedWins: 0, realizedLosses: 0, realizedPnLUsd: null, medianReturn: null, averageReturn: null, hitRate: null, earlyEntryScore: null, consistencyScore: null, copyabilityScore: null, crowdingScore: null, followerSlippageEstimate: null, suspiciousCoordinationScore: null, dataConfidence: null, scoreCalculatedAt: new Date().toISOString() }; }
function toClassified(action: WalletAction): ClassifiedWalletAction { return { classification: action.classification, confidence: action.classificationConfidence, evidence: action.evidence, ambiguityReasons: action.ambiguityReasons, inputMint: action.inputMint, inputRawAmount: action.inputRawAmount, inputDecimals: action.inputDecimals, outputMint: action.outputMint, outputRawAmount: action.outputRawAmount, outputDecimals: action.outputDecimals, transactionSignature: action.transactionSignature, wallet: action.wallet, slot: action.slot, blockTime: action.chainTime, observedAt: action.observedAt }; }
function empty(outcome: ShadowProcessResult["outcome"], reasonCodes: string[]): ShadowProcessResult { return { outcome, signal: null, decision: null, position: null, tokenRisk: null, reasonCodes }; }
