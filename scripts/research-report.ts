import process from "node:process";
import { createPostgresStore } from "@intelligence/database";
import { walkForwardReport, type ResearchObservation } from "@intelligence/core";
async function main(): Promise<void> {
if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required; no database was modified");
const database = createPostgresStore(process.env.DATABASE_URL); await database.schemaReady();
try {
  const signals = await database.store.listSignals(); const copyability = await database.store.listRecentCopyability(10_000); const byTransaction = new Map(copyability.map((item) => [item.sourceTransactionSignature, item])); const observations: ResearchObservation[] = [];
  for (const wallet of await database.store.listWallets()) for (const outcome of await database.store.listForwardReturnObservations(wallet.publicKey)) { const signal = signals.find((item) => item.sourceTransactionSignature === outcome.transactionSignature); if (signal === undefined) continue; const copy = byTransaction.get(outcome.transactionSignature); observations.push({ signalAt: signal.detectedAt, decision: signal.decision, walletScore: signal.walletScore.total, tokenRisk: signal.tokenRiskSnapshot?.riskScore ?? null, crowding: signal.antiCrowdingScore, copyabilityKnown: copy?.status === "KNOWN", routeAvailable: outcome.status === "NO_ROUTE" ? false : outcome.status === "VALID_OBSERVATION" ? true : null, followerReturn: outcome.followerReturn, sourceReturn: null, deteriorationBps: copy?.entryPriceDeteriorationBps ?? null, outcomeStatus: outcome.status }); }
  const report = walkForwardReport(observations, { trainingMs: 30 * 86_400_000, evaluationMs: 7 * 86_400_000, stepMs: 7 * 86_400_000 }); console.info("SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS"); console.info(`Signals/outcomes: ${observations.length}`); console.info(JSON.stringify(report, null, 2));
} finally { await database.close(); }
}
void main();
