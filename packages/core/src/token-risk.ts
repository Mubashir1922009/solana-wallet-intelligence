import { newId, stableHash } from "@intelligence/shared";
import type { JsonValue } from "@intelligence/shared";
import type { MarketObservation } from "./market.js";
import type { TokenIntelligenceSnapshot, TokenRiskComponent, TokenRiskEvaluation } from "./runtime-domain.js";

export interface TokenRiskRules {
  authorityWeight: number;
  concentrationWeight: number;
  marketRouteWeight: number;
  priceImpactWeight: number;
  dataQualityWeight: number;
  highLargestAccountPct: number;
  extremeTop10AccountsPct: number;
  highPriceImpactPct: number;
  unknownCriticalRisk: number;
}

export const PROVISIONAL_TOKEN_RISK_RULES: TokenRiskRules = {
  authorityWeight: 0.25, concentrationWeight: 0.25, marketRouteWeight: 0.2, priceImpactWeight: 0.15, dataQualityWeight: 0.15,
  highLargestAccountPct: 20, extremeTop10AccountsPct: 75, highPriceImpactPct: 5, unknownCriticalRisk: 0.65
};

function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function component(name: TokenRiskComponent["name"], risk: number, weight: number, reasonCodes: string[], confidence: TokenRiskComponent["confidence"]): TokenRiskComponent {
  return { name, risk, weight, contribution: risk * weight, confidence, reasonCodes };
}

export function evaluateTokenRisk(snapshot: TokenIntelligenceSnapshot, market: MarketObservation | null, evaluatedAt: string, rules: TokenRiskRules = PROVISIONAL_TOKEN_RISK_RULES): TokenRiskEvaluation {
  const authorityReasons: string[] = [];
  let authorityRisk = 0;
  if (!snapshot.mint.mintAuthorityKnown || !snapshot.mint.freezeAuthorityKnown) { authorityRisk = Math.max(authorityRisk, rules.unknownCriticalRisk); authorityReasons.push("TOKEN_AUTHORITY_UNKNOWN"); }
  if (snapshot.mint.mintAuthority !== null) { authorityRisk = Math.max(authorityRisk, 0.85); authorityReasons.push("MINT_AUTHORITY_ACTIVE"); }
  if (snapshot.mint.freezeAuthority !== null) { authorityRisk = Math.max(authorityRisk, 0.8); authorityReasons.push("FREEZE_AUTHORITY_ACTIVE"); }
  if (snapshot.mint.tokenProgram === "UNKNOWN") { authorityRisk = Math.max(authorityRisk, rules.unknownCriticalRisk); authorityReasons.push("TOKEN_PROGRAM_UNKNOWN"); }
  if (snapshot.mint.extensionsStatus === "UNKNOWN_UNSUPPORTED") { authorityRisk = Math.max(authorityRisk, rules.unknownCriticalRisk); authorityReasons.push("TOKEN_2022_EXTENSIONS_UNKNOWN"); }

  const concentrationReasons: string[] = [];
  const largest = numeric(snapshot.concentration.largestAccountPct);
  const top10 = numeric(snapshot.concentration.top10AccountsPct);
  let concentrationRisk = 0;
  if (largest === null || top10 === null) { concentrationRisk = rules.unknownCriticalRisk; concentrationReasons.push("CONCENTRATION_UNKNOWN"); }
  else {
    if (largest >= rules.highLargestAccountPct) { concentrationRisk = Math.max(concentrationRisk, Math.min(1, largest / 50)); concentrationReasons.push("CONCENTRATION_HIGH"); }
    if (top10 >= rules.extremeTop10AccountsPct) { concentrationRisk = Math.max(concentrationRisk, Math.min(1, top10 / 100)); concentrationReasons.push("TOP10_CONCENTRATION_HIGH"); }
  }

  const routeReasons: string[] = [];
  const routeRisk = market === null ? rules.unknownCriticalRisk : market.routeAvailable ? 0 : 1;
  if (market === null) routeReasons.push("MARKET_ROUTE_UNKNOWN"); else if (!market.routeAvailable) routeReasons.push("NO_MARKET_ROUTE");
  const impactReasons: string[] = [];
  const impact = market === null ? null : numeric(market.priceImpactPct);
  let impactRisk = rules.unknownCriticalRisk;
  if (impact === null) impactReasons.push("PRICE_IMPACT_UNKNOWN");
  else {
    impactRisk = Math.min(1, Math.abs(impact) / rules.highPriceImpactPct);
    if (Math.abs(impact) >= rules.highPriceImpactPct) impactReasons.push("PRICE_IMPACT_HIGH");
  }
  const dataQualityRisk = 1 - snapshot.completeness;
  const dataReasons = snapshot.completeness < 0.7 ? ["TOKEN_DATA_INCOMPLETE"] : [];
  const components = [
    component("AUTHORITY", authorityRisk, rules.authorityWeight, authorityReasons, authorityReasons.length === 0 ? "HIGH" : snapshot.mint.mintAuthorityKnown ? "MEDIUM" : "LOW"),
    component("CONCENTRATION", concentrationRisk, rules.concentrationWeight, concentrationReasons, largest === null ? "UNKNOWN" : "MEDIUM"),
    component("MARKET_ROUTE", routeRisk, rules.marketRouteWeight, routeReasons, market === null ? "UNKNOWN" : "HIGH"),
    component("PRICE_IMPACT", impactRisk, rules.priceImpactWeight, impactReasons, impact === null ? "UNKNOWN" : "HIGH"),
    component("DATA_QUALITY", dataQualityRisk, rules.dataQualityWeight, dataReasons, snapshot.confidence)
  ];
  const totalRisk = Math.min(1, components.reduce((sum, item) => sum + item.contribution, 0));
  const dataCompleteness = Math.min(1, (snapshot.completeness * 4 + (market === null ? 0 : 1)) / 5);
  const confidence = dataCompleteness >= 0.85 ? "HIGH" : dataCompleteness >= 0.6 ? "MEDIUM" : dataCompleteness > 0 ? "LOW" : "UNKNOWN";
  return {
    id: newId(), tokenMint: snapshot.tokenMint, totalRisk, components, reasonCodes: components.flatMap((item) => item.reasonCodes), confidence,
    dataCompleteness, evaluatedAt, rulesetHash: stableHash(rules as unknown as JsonValue), intelligenceSnapshotId: snapshot.id, marketObservationId: market?.id ?? null
  };
}
