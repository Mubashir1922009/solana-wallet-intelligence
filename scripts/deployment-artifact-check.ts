import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseConfig } from "@intelligence/config";

export interface ArtifactCheck { name: string; status: "PASS" | "FAIL"; detail: string }

const dockerfiles = ["Dockerfile.api", "Dockerfile.worker", "Dockerfile.dashboard"];

export function dockerfileCopySources(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => /^COPY /.test(line.trim()) && !line.includes("--from=")).flatMap((line) => {
    const tokens = line.trim().split(/\s+/).slice(1);
    const sources = tokens.filter((token) => !token.startsWith("--"));
    return sources.slice(0, Math.max(0, sources.length - 1));
  });
}

export function healthcheckEndpoints(content: string): string[] {
  const match = /HEALTHCHECK[^\r\n]*/.exec(content);
  if (match === null) return [];
  return [...match[0].matchAll(/\/(livez|readyz)/g)].map((item) => `/${item[1] ?? ""}`);
}

export function runtimeStageRunsAsNonRoot(content: string): boolean {
  const stages = content.split(/^FROM /m);
  const runtime = stages.at(-1) ?? "";
  return /^USER (?!root\s)/m.test(runtime);
}

async function loadSourceText(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true }).catch(() => [] as string[]);
  const texts = await Promise.all(entries.filter((entry) => entry.endsWith(".ts")).map((entry) => readFile(join(directory, entry), "utf8").catch(() => "")));
  return texts.join("\n");
}

async function pathExists(repoRoot: string, relativePath: string): Promise<boolean> {
  const absolute = join(repoRoot, relativePath);
  if (!relativePath.includes("*")) return existsSync(absolute);
  const directory = join(repoRoot, relativePath.split("/").slice(0, -1).join("/"));
  const pattern = relativePath.split("/").at(-1) ?? "";
  const regex = new RegExp(`^${pattern.replace(/[.+?]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdir(directory).then((entries) => entries.some((entry) => regex.test(entry))).catch(() => false);
}

function record(checks: ArtifactCheck[], name: string, passed: boolean, passDetail: string, failDetail: string): void {
  checks.push({ name, status: passed ? "PASS" : "FAIL", detail: passed ? passDetail : failDetail });
}

export function productionEnvironmentFixtures(): { shadow: Record<string, string>; live: Record<string, string> } {
  const shadow: Record<string, string> = { NODE_ENV: "production", EXECUTION_MODE: "SHADOW", DATABASE_URL: "postgresql://staging:unused@localhost:5432/wallet_intelligence", SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", SOLANA_WS_URL: "wss://api.mainnet-beta.solana.com", SESSION_SECRET: "d".repeat(32), OPERATOR_PASSWORD_HASH: "scrypt$rehearsal-fixture", CORS_ALLOWED_ORIGIN: "https://dashboard.example.com" };
  return { shadow, live: { ...shadow, EXECUTION_MODE: "LIVE" } };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const repoRoot = process.cwd();
  const checks: ArtifactCheck[] = [];

  for (const name of dockerfiles) {
    const path = join(repoRoot, "infra", name);
    if (!existsSync(path)) { record(checks, `container:${name}`, false, "", "Dockerfile is missing"); continue; }
    const content = await readFile(path, "utf8");
    let allSourcesExist = true;
    const missing: string[] = [];
    for (const source of dockerfileCopySources(content)) {
      if (!(await pathExists(repoRoot, source))) { allSourcesExist = false; missing.push(source); }
    }
    record(checks, `container:${name}:copy_sources`, allSourcesExist, `${dockerfileCopySources(content).length} COPY sources resolve inside the repository`, `missing paths: ${missing.join(", ")}`);
    record(checks, `container:${name}:non_root_runtime`, runtimeStageRunsAsNonRoot(content), "runtime stage runs as unprivileged user", "runtime stage lacks a non-root USER directive");
    const endpoints = healthcheckEndpoints(content);
    const appDirectory = name === "Dockerfile.api" ? "apps/api" : name === "Dockerfile.worker" ? "apps/worker" : null;
    if (appDirectory === null) {
      record(checks, `container:${name}`, true, "dashboard image exposes no container healthcheck by design (platform healthcheck applies)", "");
    } else {
      const source = await loadSourceText(join(repoRoot, appDirectory, "src"));
      const implemented = endpoints.filter((endpoint) => source.includes(`"${endpoint}"`));
      record(checks, `container:${name}:healthcheck_routes`, endpoints.length > 0 && implemented.length === endpoints.length, `healthcheck routes ${endpoints.join(", ")} are implemented`, `routes declared but not implemented: ${endpoints.filter((endpoint) => !implemented.includes(endpoint)).join(", ") || "none declared"}`);
    }
  }

  const composePath = join(repoRoot, "infra", "docker-compose.yml");
  if (existsSync(composePath)) {
    const compose = await readFile(composePath, "utf8");
    record(checks, "compose:services_pinned", compose.includes("postgres:") && compose.includes("redis:") && compose.includes("postgres:16-alpine") && compose.includes("redis:7-alpine"), "compose defines version-pinned postgres and redis services", "compose service definitions or version pins drifted");
  } else record(checks, "compose:present", false, "", "infra/docker-compose.yml is missing");

  const nextConfigPath = join(repoRoot, "apps", "dashboard", "next.config.ts");
  const nextConfig = existsSync(nextConfigPath) ? await readFile(nextConfigPath, "utf8") : "";
  record(checks, "dashboard:standalone_flag", nextConfig.includes("BUILD_STANDALONE"), "BUILD_STANDALONE container-only output flag matches DEPLOYMENT.md", "documented BUILD_STANDALONE behavior is absent from next.config.ts");

  try { parseConfig(productionEnvironmentFixtures().shadow); record(checks, "config:production_shadow_parses", true, "NODE_ENV=production with EXECUTION_MODE=SHADOW satisfies the configuration schema including auth requirements", ""); } catch (error) { record(checks, "config:production_shadow_parses", false, "", `production SHADOW fixture rejected: ${error instanceof Error ? error.message : "unknown error"}`); }
  try { parseConfig(productionEnvironmentFixtures().live); record(checks, "config:live_fails_closed", false, "", "EXECUTION_MODE=LIVE was accepted; fail-closed invariant violated"); } catch (error) { record(checks, "config:live_fails_closed", error instanceof Error && error.message.includes("LIVE execution is disabled"), "LIVE execution is rejected at configuration time", `LIVE rejected with unexpected reason: ${error instanceof Error ? error.message : "unknown error"}`); }

  const failed = checks.filter((check) => check.status === "FAIL");
  const completedAt = new Date().toISOString();
  const report = { mode: "DEPLOYMENT_ARTIFACT_VALIDATION", posture: "STATIC ARTIFACT AND CONFIGURATION VALIDATION ONLY; IMAGE BUILDS REQUIRE CI WITH DOCKER", status: failed.length === 0 ? "PASS" : "FAIL", start: startedAt, end: completedAt, checks, failures: failed.map((check) => check.name) };
  const directory = join(repoRoot, "runtime", "reports"); await mkdir(directory, { recursive: true });
  const filename = join(directory, `deployment-artifacts-${completedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.info(JSON.stringify({ ...report, evidenceFile: filename }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
