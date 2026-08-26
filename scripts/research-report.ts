import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPostgresStore } from "@intelligence/database";
import { PROVISIONAL_CANDIDATE_RULES, walkForwardReport, type CandidateEvaluation, type ResearchObservation } from "@intelligence/core";

export const SYNTHETIC_FIXTURE_WALLET_PREFIX = "SYNTHPROOF";

function latestEvaluationsByWallet(items: CandidateEvaluation[]): CandidateEvaluation[] {
  const latest = new Map<string, CandidateEvaluation>();
  for (const item of items) {
    const current = latest.get(item.wallet);
    if (current === undefined || item.evaluatedAt > current.evaluatedAt) latest.set(item.wallet, item);
  }
  return [...latest.values()].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
}

async function main(): Promise<void> {
  if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required; no database was modified");
  const database = createPostgresStore(process.env.DATABASE_URL);
  await database.schemaReady();
  try {
    const signals = await database.store.listSignals();
    const copyability = await database.store.listRecentCopyability(10_000);
    const allCandidates = latestEvaluationsByWallet(await database.store.listCandidateEvaluations(10_000));
    const syntheticFixturesExcluded = allCandidates.filter((item) => item.wallet.startsWith(SYNTHETIC_FIXTURE_WALLET_PREFIX)).length;
    const candidates = allCandidates.filter((item) => !item.wallet.startsWith(SYNTHETIC_FIXTURE_WALLET_PREFIX));
    const byTransaction = new Map(copyability.map((item) => [item.sourceTransactionSignature, item]));
    const byWallet = new Map(candidates.map((item) => [item.wallet, item]));
    const observations: ResearchObservation[] = [];

    for (const wallet of await database.store.listWallets()) {
      if (wallet.publicKey.startsWith(SYNTHETIC_FIXTURE_WALLET_PREFIX)) continue;
      for (const outcome of await database.store.listForwardReturnObservations(wallet.publicKey)) {
        const signal = signals.find((item) => item.sourceTransactionSignature === outcome.transactionSignature);
        if (signal === undefined) continue;
        const copy = byTransaction.get(outcome.transactionSignature);
        const candidate = byWallet.get(signal.sourceWallet);
        observations.push({
          signalAt: signal.detectedAt,
          informationCutoffAt: signal.walletScore.calculatedAt,
          decisionAt: signal.detectedAt,
          outcomeObservedAt: outcome.observedAt,
          discoveryEvidenceFrozen: candidate === undefined ? null : candidate.evaluatedAt <= signal.detectedAt,
          decision: signal.decision,
          walletScore: signal.walletScore.total,
          tokenRisk: signal.tokenRiskSnapshot?.riskScore ?? null,
          crowding: signal.antiCrowdingScore,
          copyabilityKnown: copy?.status === "KNOWN",
          routeAvailable: outcome.status === "NO_ROUTE" ? false : outcome.status === "VALID_OBSERVATION" ? true : null,
          followerReturn: outcome.followerReturn,
          sourceReturn: null,
          deteriorationBps: copy?.entryPriceDeteriorationBps ?? null,
          outcomeStatus: outcome.status,
        });
      }
    }

    const report = walkForwardReport(observations, {
      trainingMs: 30 * 86_400_000,
      evaluationMs: 7 * 86_400_000,
      stepMs: 7 * 86_400_000,
    }) as Record<string, unknown>;

    const jobs = await database.store.listRuntimeJobs(10_000);
    const candidateProgress = [];
    let followerSourceEventCount = 0;
    let historicalUnusableSourceEvents = 0;

    for (const candidate of candidates) {
      const outcomes = await database.store.listForwardReturnObservations(candidate.wallet);
      const sources = await database.store.listFollowerSourceEvents(candidate.wallet);
      const history = await database.store.getLatestBackfillRun(candidate.wallet);
      const pending = jobs.filter((job) =>
        job.type === "FORWARD_RETURN" &&
        job.status === "PENDING" &&
        typeof job.payload === "object" &&
        job.payload !== null &&
        !Array.isArray(job.payload) &&
        job.payload.wallet === candidate.wallet
      );
      const reputation = await database.store.getWalletReputation(candidate.wallet);
      const validOutcomes = outcomes.filter((item) => item.status === "VALID_OBSERVATION");
      const validIndependentTokens = new Set(validOutcomes.map((item) => item.tokenMint)).size;
      followerSourceEventCount += sources.length;
      historicalUnusableSourceEvents += sources.filter((item) => item.status === "HISTORICAL_UNUSABLE").length;

      candidateProgress.push({
        wallet: candidate.wallet,
        state: candidate.state,
        validFollowerSamples: validOutcomes.length,
        requiredFollowerSamples: PROVISIONAL_CANDIDATE_RULES.minimumSampleSize,
        independentTokens: reputation?.independentTokenSampleSize ?? validIndependentTokens,
        requiredIndependentTokens: PROVISIONAL_CANDIDATE_RULES.minimumIndependentTokens,
        score: reputation?.provisionalScore ?? candidate.provisionalScore,
        crowding: reputation?.crowdingFrequency ?? null,
        historyCompleteness: history?.completenessState ?? "UNKNOWN",
        nextPendingOutcome: pending.map((item) => item.runAt).sort()[0] ?? null,
        latestSourceObservation: sources[0]?.sourceObservedAt ?? null,
        noRoute: outcomes.filter((item) => item.status === "NO_ROUTE").length,
        missing: outcomes.filter((item) => item.status === "MISSING_OBSERVATION").length,
        pendingOutcomes: pending.length,
      });
    }

    const generatedAt = new Date().toISOString();
    const followerEvidenceSampleSize = candidateProgress.reduce((sum, item) => sum + item.validFollowerSamples, 0);
    const pendingOutcomes = candidateProgress.reduce((sum, item) => sum + item.pendingOutcomes, 0);
    const artifact = {
      ...report,
      generatedAt,
      posture: "SHADOW / QUOTE-BASED - NOT REAL EXECUTION RESULTS",
      // This N contains only outcomes attached to actual deterministic signals.
      sampleSize: observations.length,
      deterministicDecisionOutcomeSampleSize: observations.length,
      // This N also exposes research-watch evidence accumulated before eligibility.
      followerEvidenceSampleSize,
      followerSourceEventCount,
      historicalUnusableSourceEvents,
      candidateCount: candidates.length,
      syntheticFixturesExcluded,
      researchWatchCount: candidates.filter((item) => item.state === "RESEARCH_WATCH").length,
      trackEligibleCount: candidates.filter((item) => item.state === "TRACK_ELIGIBLE" || item.state === "TRACKING").length,
      validFollowerSamples: followerEvidenceSampleSize,
      pendingOutcomes,
      candidateProgress,
    };

    const directory = join(process.cwd(), "runtime", "reports");
    await mkdir(directory, { recursive: true });
    const filename = join(directory, `research-${generatedAt.replace(/[:.]/g, "-")}.json`);
    await writeFile(filename, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.info(artifact.posture);
    console.info(`Deterministic decision outcomes: ${observations.length}`);
    console.info(`Follower evidence observations: ${followerEvidenceSampleSize}`);
    if (followerEvidenceSampleSize < 30) console.info("SAMPLE TOO SMALL FOR STRATEGY CONCLUSION");
    console.info(JSON.stringify({ ...artifact, evidenceFile: filename }, null, 2));
  } finally {
    await database.close();
  }
}

void main();
