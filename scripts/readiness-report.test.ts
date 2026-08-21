import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessEvidence } from "./readiness-report.js";
import { inspectResources } from "./resources-check.js";

const evidence = (overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence => ({ resources: inspectResources({}), migrationCount: 5, expectedMigrationCount: 5, expectedSchemaRevision: "runtime-schema-0004", postgresArtifact: false, heliusArtifact: false, providerFallbackArtifact: false, e2eArtifact: true, e2eTransactionsNormalized: 0, e2eCandidateEvaluations: 0, e2eDeterministicDecisions: 0, soakArtifact: true, researchArtifact: false, researchSampleSize: null, researchTemporalIntegrityPassed: false, resourceSetupDocumented: true, deploymentDocumented: true, containerDefinitionsPresent: true, prohibitedProductionSymbols: 0, liveFailsClosed: true, ...overrides });

describe("objective readiness report", () => {
  it("does not turn implemented-but-unproven external systems into READY", () => {
    const report = evaluateReadiness(evidence(), "2026-01-01T00:00:00.000Z");
    expect(report.areas.DATABASE.status).toBe("BLOCKED");
    expect(report.areas.PROVIDER.status).toBe("PARTIAL");
    expect(report.areas.SHADOW_PIPELINE.status).toBe("PARTIAL");
    expect(report.areas.SECURITY.status).toBe("READY");
  });

  it("requires proof artifacts before database and provider become READY", () => {
    const resources = inspectResources({ DATABASE_URL: "configured", STAGING_DATABASE_ACK: "wallet-intelligence-shadow", HELIUS_API_KEY: "configured" });
    const configured = evaluateReadiness(evidence({ resources }));
    const proven = evaluateReadiness(evidence({ resources, postgresArtifact: true, heliusArtifact: true, providerFallbackArtifact: true }));
    expect(configured.areas.DATABASE.status).toBe("PARTIAL");
    expect(configured.areas.PROVIDER.status).toBe("PARTIAL");
    expect(proven.areas.DATABASE.status).toBe("READY");
    expect(proven.areas.PROVIDER.status).toBe("READY");
  });

  it("never presents an overall project percentage", () => {
    const output = JSON.stringify(evaluateReadiness(evidence()));
    expect(output).not.toMatch(/overallPercentage|completionPercentage|projectPercent/);
    expect(output).toContain("NOT AN OVERALL PROJECT COMPLETION PERCENTAGE");
  });
});
