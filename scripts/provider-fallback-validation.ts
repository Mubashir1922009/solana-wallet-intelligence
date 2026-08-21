import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChainDataProvider, WalletHistoryResult } from "@intelligence/providers";
import { FallbackChainDataProvider, type FallbackNotice } from "@intelligence/providers";

function fixtureProvider(name: string, behavior: { failure: string | null }): ChainDataProvider & { calls: number } {
  return {
    name,
    historyMode: "STANDARD_RPC",
    calls: 0,
    async fetchWalletSignatures() {
      this.calls += 1;
      if (behavior.failure !== null) throw new Error(behavior.failure);
      return { items: [], nextBefore: null };
    },
    async fetchWalletHistory(): Promise<WalletHistoryResult> {
      this.calls += 1;
      if (behavior.failure !== null) throw new Error(behavior.failure);
      return { signatures: [], transactions: [], diagnostics: { mode: "STANDARD_RPC", signaturesFetched: 0, transactionsFetched: 0, transactionsMissing: 0, failures: [], totalDurationMs: 1, totalRpcLatencyMs: 1, complete: true, completenessState: "COMPLETE_WITHIN_REQUESTED_WINDOW", pagesFetched: 1, continuationCursor: null } };
    },
    async fetchTransaction() {
      this.calls += 1;
      if (behavior.failure !== null) throw new Error(behavior.failure);
      return null;
    }
  };
}

async function main(): Promise<void> {
  let now = 1_000;
  const primaryBehavior = { failure: null as string | null };
  const primary = fixtureProvider("helius", primaryBehavior);
  const fallback = fixtureProvider("standard-solana-rpc", { failure: null });
  const notices: FallbackNotice[] = [];
  const chain = new FallbackChainDataProvider(primary, fallback, (notice) => notices.push(notice), { cooldownMs: 5_000, now: () => now });
  const request = { address: "Vote111111111111111111111111111111111111111" };

  await chain.fetchWalletSignatures(request);
  const healthy = chain.snapshot();
  primaryBehavior.failure = "HTTP 429 from https://rpc.invalid?api-key=fixture-secret";
  await chain.fetchWalletSignatures(request);
  const degraded = chain.snapshot();
  const primaryCallsAfterFailure = primary.calls;
  await chain.fetchWalletSignatures(request);
  const cooldownHeld = primary.calls === primaryCallsAfterFailure;
  now = 6_001;
  primaryBehavior.failure = null;
  await chain.fetchWalletSignatures(request);
  const recovered = chain.snapshot();
  const artifact = {
    generatedAt: new Date().toISOString(),
    posture: "DETERMINISTIC PROVIDER CONTROL-PLANE VALIDATION; NO NETWORK OR BLOCKCHAIN WRITES",
    checks: {
      healthyPrimaryPreferred: healthy.activeProvider === "helius",
      transientFailureUsesFallback: degraded.activeProvider === "standard-solana-rpc",
      rateLimitUsesFallback: notices.some((notice) => notice.reason.includes("429")),
      cooldownPreventsFlapping: cooldownHeld,
      recoveredPrimaryRestored: recovered.activeProvider === "helius",
      credentialRedacted: notices.every((notice) => !notice.reason.includes("fixture-secret"))
    },
    activeProvider: recovered.activeProvider,
    fallbackEvents: notices.map((notice) => ({ from: notice.from, to: notice.to, operation: notice.operation, reason: notice.reason }))
  };
  if (Object.values(artifact.checks).some((passed) => !passed)) throw new Error("Provider fallback validation failed");
  const directory = join(process.cwd(), "runtime", "reports");
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `provider-fallback-${artifact.generatedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(filename, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ ...artifact, evidenceFile: filename }, null, 2));
}

void main();
