import { describe, expect, it } from "vitest";
import { formatResourceStatus, inspectResources, STAGING_DATABASE_ACKNOWLEDGEMENT } from "./resources-check.js";

describe("resource readiness check", () => {
  it("reports a blocked path without making absent resources look configured", () => {
    const status = inspectResources({});

    expect(status.resourcePath).toBe("BLOCKED");
    expect(status.fullStagingRehearsal).toBe("BLOCKED");
    expect(status.databaseAcknowledgement).toBe("ABSENT");
    expect(status.telegram).toBe("DISABLED");
  });

  it("requires the exact database acknowledgement for the full path", () => {
    const invalid = inspectResources({ DATABASE_URL: "secret-database-url", STAGING_DATABASE_ACK: "wrong", HELIUS_API_KEY: "secret-helius-key" });
    const valid = inspectResources({ DATABASE_URL: "secret-database-url", STAGING_DATABASE_ACK: STAGING_DATABASE_ACKNOWLEDGEMENT, HELIUS_API_KEY: "secret-helius-key" });

    expect(invalid.databaseAcknowledgement).toBe("INVALID");
    expect(invalid.resourcePath).toBe("HELIUS_ONLY");
    expect(valid.databaseAcknowledgement).toBe("VALID");
    expect(valid.resourcePath).toBe("FULL");
    expect(valid.fullStagingRehearsal).toBe("READY");
  });

  it("prints presence and readiness without printing resource values", () => {
    const databaseUrl = "postgresql://operator:private-password@staging.example/project";
    const heliusKey = "private-helius-key";
    const output = formatResourceStatus(inspectResources({ DATABASE_URL: databaseUrl, STAGING_DATABASE_ACK: STAGING_DATABASE_ACKNOWLEDGEMENT, HELIUS_API_KEY: heliusKey }));

    expect(output).toContain("DATABASE_URL: PRESENT");
    expect(output).toContain("DATABASE_ACK: VALID");
    expect(output).toContain("FULL_STAGING_REHEARSAL: READY");
    expect(output).not.toContain(databaseUrl);
    expect(output).not.toContain(heliusKey);
    expect(output).not.toContain("private-password");
  });
});
