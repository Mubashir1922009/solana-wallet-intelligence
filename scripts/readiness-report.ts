import process from "node:process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectResources, type ResourceStatus } from "./resources-check.js";

export type ReadinessState = "READY" | "PARTIAL" | "BLOCKED";
export type ReadinessArea = "CODE" | "DATABASE" | "PROVIDER" | "SHADOW_PIPELINE" | "RESEARCH" | "OPERATIONS" | "SECURITY" | "DEPLOYMENT";
export interface AreaReadiness { status: ReadinessState; reasons: string[] }
export interface ReadinessEvidence {
  resources: ResourceStatus;
  migrationCount: number;
  expectedMigrationCount: number;
  expectedSchemaRevision: string;
  postgresArtifact: boolean;
  heliusArtifact: boolean;
  providerFallbackArtifact: boolean;
  e2eArtifact: boolean;
  e2eTransactionsNormalized: number | null;
  e2eCandidateEvaluations: number | null;
  e2eDeterministicDecisions: number | null;
  soakArtifact: boolean;
  researchArtifact: boolean;
  researchSampleSize: number | null;
  researchTemporalIntegrityPassed: boolean;
  resourceSetupDocumented: boolean;
  deploymentDocumented: boolean;
  containerDefinitionsPresent: boolean;
  prohibitedProductionSymbols: number;
  liveFailsClosed: boolean;
}
export interface ReadinessReport {
  generatedAt: string;
  posture: string;
  areas: Record<ReadinessArea, AreaReadiness>;
  gapMatrix: Record<"PROVEN" | "IMPLEMENTED_NOT_PROVEN" | "BLOCKED" | "NOT_STARTED", string[]>;
  evidence: { migrationCount: number; expectedMigrationCount: number; expectedSchemaRevision: string; artifacts: Record<string, boolean>; prohibitedProductionSymbols: number };
}

export function evaluateReadiness(evidence: ReadinessEvidence, generatedAt = new Date().toISOString()): ReadinessReport {
  const postgresConfigured = evidence.resources.resourcePath === "FULL" || evidence.resources.resourcePath === "POSTGRES_ONLY";
  const heliusConfigured = evidence.resources.resourcePath === "FULL" || evidence.resources.resourcePath === "HELIUS_ONLY";
  const codeReady = evidence.migrationCount === evidence.expectedMigrationCount;
  const securityReady = evidence.prohibitedProductionSymbols === 0 && evidence.liveFailsClosed;
  const areas: Record<ReadinessArea, AreaReadiness> = {
    CODE: { status: codeReady ? "READY" : "PARTIAL", reasons: codeReady ? ["expected migration chain and core implementation are present"] : ["migration chain differs from expected baseline"] },
    DATABASE: evidence.postgresArtifact ? { status: "READY", reasons: ["sanitized live PostgreSQL durability artifact is present"] } : postgresConfigured ? { status: "PARTIAL", reasons: ["PostgreSQL is configured but durability artifact is absent"] } : { status: "BLOCKED", reasons: ["acknowledged DATABASE_URL is absent"] },
    PROVIDER: evidence.heliusArtifact && evidence.providerFallbackArtifact ? { status: "READY", reasons: ["sanitized Helius HTTP/WSS and controlled fallback artifacts passed"] } : heliusConfigured ? { status: "PARTIAL", reasons: ["Helius is configured but live validation or fallback proof is absent"] } : { status: "PARTIAL", reasons: ["standard RPC and Helius fallback are implemented; Helius credentials are absent"] },
    SHADOW_PIPELINE: evidence.e2eArtifact && (evidence.e2eTransactionsNormalized ?? 0) > 0 && (evidence.e2eCandidateEvaluations ?? 0) > 0 && (evidence.e2eDeterministicDecisions ?? 0) > 0 ? { status: "READY", reasons: ["bounded shadow E2E reached a deterministic decision"] } : evidence.e2eArtifact ? { status: "PARTIAL", reasons: ["bounded PostgreSQL shadow E2E reached candidate evaluation but not a deterministic decision"] } : { status: "PARTIAL", reasons: ["shadow pipeline is implemented but no local E2E artifact is available"] },
    RESEARCH: evidence.researchArtifact && (evidence.researchSampleSize ?? 0) >= 30 && evidence.researchTemporalIntegrityPassed ? { status: "READY", reasons: ["research artifact has temporal-integrity pass and nontrivial sample"] } : { status: "PARTIAL", reasons: ["research tooling is implemented; statistically sufficient evidence is absent"] },
    OPERATIONS: evidence.resourceSetupDocumented && evidence.soakArtifact ? { status: "PARTIAL", reasons: ["resource/staging tooling and short soak evidence exist; a long soak is outstanding"] } : { status: "PARTIAL", reasons: ["resource/staging tooling exists; operational live evidence is incomplete"] },
    SECURITY: { status: securityReady ? "READY" : "BLOCKED", reasons: securityReady ? ["prohibited execution scan is clean and LIVE fails closed"] : ["financial safety invariant failed"] },
    DEPLOYMENT: evidence.deploymentDocumented && evidence.containerDefinitionsPresent ? { status: "PARTIAL", reasons: ["deployment checklist and container definitions exist; no staging deployment evidence"] } : { status: "BLOCKED", reasons: ["deployment documentation or container definitions are incomplete"] }
  };
  return {
    generatedAt,
    posture: "OBJECTIVE ENGINEERING READINESS; NOT AN OVERALL PROJECT COMPLETION PERCENTAGE",
    areas,
    gapMatrix: {
      PROVEN: ["static migration model", "resource-value redaction", "LIVE fail-closed configuration", "no production signing/broadcast symbols", ...(evidence.postgresArtifact ? ["live PostgreSQL durability and recovery"] : []), ...(evidence.heliusArtifact && evidence.providerFallbackArtifact ? ["Helius read-only HTTP/WSS and provider fallback"] : [])],
      IMPLEMENTED_NOT_PROVEN: ["complete candidate-to-decision shadow pipeline", "early-participant protocol adapter", "staging containers"],
      BLOCKED: [presentOrBlocked(evidence.postgresArtifact, "real PostgreSQL durability"), presentOrBlocked(evidence.heliusArtifact, "Helius live read validation")].filter((item): item is string => item !== null),
      NOT_STARTED: ["long-term staging reliability soak", "destructive restore rehearsal on a disposable clone", "real-money execution (intentionally prohibited)"]
    },
    evidence: { migrationCount: evidence.migrationCount, expectedMigrationCount: evidence.expectedMigrationCount, expectedSchemaRevision: evidence.expectedSchemaRevision, artifacts: { postgres: evidence.postgresArtifact, helius: evidence.heliusArtifact, providerFallback: evidence.providerFallbackArtifact, shadowE2e: evidence.e2eArtifact, shadowSoak: evidence.soakArtifact, research: evidence.researchArtifact }, prohibitedProductionSymbols: evidence.prohibitedProductionSymbols }
  };
}

async function collectEvidence(): Promise<ReadinessEvidence> {
  const reports = join(process.cwd(), "runtime", "reports"); const names = await readdir(reports).catch(() => [] as string[]);
  const latest = (prefix: RegExp): string | null => names.filter((name) => prefix.test(name)).sort().at(-1) ?? null;
  const postgres = await safeJson(reports, latest(/^postgres-durability-.*\.json$/)); const helius = await safeJson(reports, latest(/^helius-validation-.*\.json$/)); const fallback = await safeJson(reports, latest(/^provider-fallback-.*\.json$/)); const e2e = await safeJson(reports, latest(/^shadow-e2e-.*\.json$/)); const research = await safeJson(reports, latest(/^research-.*\.json$/));
  const journal = JSON.parse(await readFile(join(process.cwd(), "packages", "database", "drizzle", "meta", "_journal.json"), "utf8")) as { entries?: unknown[] };
  const productionFiles = await listProductionSource(); let prohibitedProductionSymbols = 0; const prohibited = /Keypair\.fromSecretKey|\bfromSeed\b|signTransaction|signAllTransactions|sendTransaction|sendRawTransaction|\/execute\b|\/submit\b/;
  for (const file of productionFiles) if (prohibited.test(await readFile(file, "utf8"))) prohibitedProductionSymbols += 1;
  const configSource = await readFile(join(process.cwd(), "packages", "config", "src", "index.ts"), "utf8");
  return {
    resources: inspectResources(process.env), migrationCount: journal.entries?.length ?? 0, expectedMigrationCount: 5, expectedSchemaRevision: "runtime-schema-0004",
    postgresArtifact: postgres?.status === "PASS" && Array.isArray(postgres.failures) && postgres.failures.length === 0,
    heliusArtifact: heliusTotalsPassed(helius) && nestedBoolean(helius, "websocket", "ok") === true,
    providerFallbackArtifact: fallbackChecksPassed(fallback),
    e2eArtifact: e2e?.storeMode === "POSTGRESQL" && Array.isArray(e2e.errors) && e2e.errors.length === 0, e2eTransactionsNormalized: numberField(e2e, "transactionsNormalized"), e2eCandidateEvaluations: numberField(e2e, "candidateEvaluations"), e2eDeterministicDecisions: sumFields(e2e, ["BUY", "OBSERVE", "REJECT"]),
    soakArtifact: latest(/^shadow-soak-.*\.json$/) !== null || names.includes("shadow-soak-latest.json"), researchArtifact: research !== null, researchSampleSize: numberField(research, "sampleSize"), researchTemporalIntegrityPassed: nestedString(research, "temporalIntegrity", "status") === "PASS",
    resourceSetupDocumented: existsSync(join(process.cwd(), "docs", "RESOURCE_SETUP.md")), deploymentDocumented: existsSync(join(process.cwd(), "docs", "STAGING_DEPLOYMENT_CHECKLIST.md")) || existsSync(join(process.cwd(), "docs", "DEPLOYMENT.md")),
    containerDefinitionsPresent: ["Dockerfile.api", "Dockerfile.worker", "Dockerfile.dashboard"].every((name) => existsSync(join(process.cwd(), "infra", name))), prohibitedProductionSymbols,
    liveFailsClosed: configSource.includes('parsed.EXECUTION_MODE === "LIVE"') && configSource.includes("LIVE execution is disabled")
  };
}

async function listProductionSource(): Promise<string[]> { const roots = ["apps/api/src", "apps/worker/src", "apps/dashboard/app", "packages/config/src", "packages/core/src", "packages/database/src", "packages/providers/src"]; const files: string[] = []; for (const root of roots) await walk(join(process.cwd(), root), files); return files.filter((file) => /\.(?:ts|tsx)$/.test(file) && !/\.test\.(?:ts|tsx)$/.test(file)); }
async function walk(directory: string, files: string[]): Promise<void> { for (const item of await readdir(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) await walk(path, files); else files.push(path); } }
async function safeJson(directory: string, filename: string | null): Promise<Record<string, unknown> | null> { if (filename === null) return null; try { return JSON.parse(await readFile(join(directory, filename), "utf8")) as Record<string, unknown>; } catch { return null; } }
function numberField(value: Record<string, unknown> | null, key: string): number | null { return typeof value?.[key] === "number" ? value[key] : null; }
function nestedString(value: Record<string, unknown> | null, parent: string, key: string): string | null { const nested = value?.[parent]; return nested !== null && typeof nested === "object" && typeof (nested as Record<string, unknown>)[key] === "string" ? (nested as Record<string, string>)[key] ?? null : null; }
function nestedBoolean(value: Record<string, unknown> | null, parent: string, key: string): boolean | null { const nested = value?.[parent]; return nested !== null && typeof nested === "object" && typeof (nested as Record<string, unknown>)[key] === "boolean" ? (nested as Record<string, boolean>)[key] ?? null : null; }
function heliusTotalsPassed(value: Record<string, unknown> | null): boolean { const totals = value?.totals; return totals !== null && typeof totals === "object" && typeof (totals as Record<string, unknown>).attempted === "number" && (totals as Record<string, unknown>).attempted === (totals as Record<string, unknown>).succeeded; }
function fallbackChecksPassed(value: Record<string, unknown> | null): boolean { const checks = value?.checks; return checks !== null && typeof checks === "object" && Object.values(checks as Record<string, unknown>).length > 0 && Object.values(checks as Record<string, unknown>).every((item) => item === true); }
function sumFields(value: Record<string, unknown> | null, keys: string[]): number | null { if (value === null || keys.some((key) => typeof value[key] !== "number")) return null; return keys.reduce((sum, key) => sum + (value[key] as number), 0); }
function presentOrBlocked(present: boolean, label: string): string | null { return present ? null : label; }

async function main(): Promise<void> { const report = evaluateReadiness(await collectEvidence()); const directory = join(process.cwd(), "runtime", "reports"); await mkdir(directory, { recursive: true }); const filename = join(directory, `readiness-${report.generatedAt.replace(/[:.]/g, "-")}.json`); await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.info(JSON.stringify({ ...report, evidenceFile: filename }, null, 2)); }
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
