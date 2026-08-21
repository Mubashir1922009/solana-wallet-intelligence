import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPostgresStore } from "@intelligence/database";
import { walkForwardReport, type ResearchObservation } from "@intelligence/core";
async function main(): Promise<void> {
if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required; no database was modified");
const database = createPostgresStore(process.env.DATABASE_URL); await database.schemaReady();
try {
  const signals = await database.store.listSignals(); const copyability = await database.store.listRecentCopyability(10_000); const candidates = await database.store.listCandidateEvaluations(10_000); const byTransaction = new Map(copyability.map((item) => [item.sourceTransactionSignature, item])); const byWallet = new Map(candidates.map((item) => [item.wallet, item])); const observations: ResearchObservation[] = [];
  for (const wallet of await database.store.listWallets()) for (const outcome of await database.store.listForwardReturnObservations(wallet.publicKey)) { const signal = signals.find((item) => item.sourceTransactionSignature === outcome.transactionSignature); if (signal === undefined) continue; const copy = byTransaction.get(outcome.transactionSignature); const candidate = byWallet.get(signal.sourceWallet); observations.push({ signalAt: signal.detectedAt, informationCutoffAt: signal.walletScore.calculatedAt, decisionAt: signal.detectedAt, outcomeObservedAt: outcome.observedAt, discoveryEvidenceFrozen: candidate === undefined ? null : candidate.evaluatedAt <= signal.detectedAt, decision: signal.decision, walletScore: signal.walletScore.total, tokenRisk: signal.tokenRiskSnapshot?.riskScore ?? null, crowding: signal.antiCrowdingScore, copyabilityKnown: copy?.status === "KNOWN", routeAvailable: outcome.status === "NO_ROUTE" ? false : outcome.status === "VALID_OBSERVATION" ? true : null, followerReturn: outcome.followerReturn, sourceReturn: null, deteriorationBps: copy?.entryPriceDeteriorationBps ?? null, outcomeStatus: outcome.status }); }
  const report = walkForwardReport(observations, { trainingMs: 30 * 86_400_000, evaluationMs: 7 * 86_400_000, stepMs: 7 * 86_400_000 }) as Record<string, unknown>;
  const generatedAt = new Date().toISOString(); const artifact = { ...report, generatedAt, posture: "SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS", sampleSize: observations.length };
  const directory = join(process.cwd(), "runtime", "reports"); await mkdir(directory, { recursive: true }); const filename = join(directory, `research-${generatedAt.replace(/[:.]/g, "-")}.json`); await writeFile(filename, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.info(artifact.posture); console.info(`Signals/outcomes: ${observations.length}`); if (observations.length < 30) console.info("SAMPLE TOO SMALL FOR STRATEGY CONCLUSION"); console.info(JSON.stringify({ ...artifact, evidenceFile: filename }, null, 2));
} finally { await database.close(); }
}
void main();
