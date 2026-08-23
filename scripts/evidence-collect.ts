import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function argument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function durationMs(value: string): number {
  const match = /^(\d+)(m|h)$/.exec(value);
  if (match === null) throw new Error("--duration must use whole minutes or hours, for example 30m or 6h");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("--duration must be greater than zero");
  return amount * (match[2] === "h" ? 3_600_000 : 60_000);
}

async function runTsx(tsxCli: string, script: string, environment: NodeJS.ProcessEnv, stdio: "inherit" | "ignore" = "inherit"): Promise<number> {
  const child = spawn(process.execPath, [tsxCli, script], { cwd: process.cwd(), stdio, env: environment, windowsHide: true });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 0)));
  });
}

async function main(): Promise<void> {
  const duration = argument("duration", "6h");
  const maximumWallets = Number(argument("max-wallets", "10"));
  const requestedDurationMs = durationMs(duration);
  if (!Number.isInteger(maximumWallets) || maximumWallets < 1 || maximumWallets > 10) throw new Error("--max-wallets must be an integer from 1 through 10");
  if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required; PostgreSQL is authoritative");
  if (process.env.STAGING_DATABASE_ACK !== "wallet-intelligence-shadow") throw new Error("STAGING_DATABASE_ACK must equal wallet-intelligence-shadow");
  if (process.env.HELIUS_API_KEY === undefined) throw new Error("HELIUS_API_KEY is required for evidence collection");

  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) throw new Error("Local tsx runtime is missing. Run the project's existing pnpm install before evidence collection.");

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    SOLANA_WS_URL: process.env.SOLANA_WS_URL ?? "wss://api.mainnet-beta.solana.com",
    EXECUTION_MODE: "SHADOW",
    PAPER_TRADE_USD: "1",
    MAX_TRADE_USD: "5",
    MAX_LIVE_SUBSCRIPTIONS: String(maximumWallets)
  };

  console.info(JSON.stringify({
    event: "evidence_collection_started",
    posture: "FULL READ-ONLY SHADOW / NO LIVE EXECUTION",
    duration,
    maximumWallets,
    postgresAuthoritative: true,
    heliusConfigured: true
  }));

  const worker = spawn(process.execPath, [tsxCli, "apps/worker/src/main.ts"], {
    cwd: process.cwd(), stdio: "inherit", env: environment, windowsHide: true
  });

  let timedOut = false;
  let operatorStopped = false;
  const stop = (reason: "timer" | "operator"): void => {
    if (reason === "timer") timedOut = true; else operatorStopped = true;
    if (!worker.killed) worker.kill("SIGTERM");
  };
  const timer = setTimeout(() => stop("timer"), requestedDurationMs);
  const onSigint = (): void => stop("operator");
  const onSigterm = (): void => stop("operator");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);

  const expectedStop = timedOut || operatorStopped;
  if (!expectedStop && exit.code !== 0) throw new Error(`Evidence collector worker exited unexpectedly with code ${exit.code ?? "null"} signal ${exit.signal ?? "none"}`);

  console.info(JSON.stringify({
    event: "evidence_collection_stopped",
    reason: timedOut ? "DURATION_COMPLETE" : operatorStopped ? "OPERATOR_STOP" : "WORKER_EXIT",
    workerExitCode: exit.code,
    workerSignal: exit.signal
  }));

  // Produce a durable snapshot after the worker releases the database connection/lease.
  const reportCode = await runTsx(tsxCli, "scripts/research-report.ts", environment);
  if (reportCode !== 0) console.warn("Evidence collection completed, but research:report did not complete successfully. Re-run `corepack pnpm@10.15.1 research:report`.");
}

void main();
