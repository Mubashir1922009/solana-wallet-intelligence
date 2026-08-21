import { describe, expect, it } from "vitest";
import { evaluateMigrationReadiness, EXPECTED_SCHEMA_REVISION } from "./postgres-store.js";

describe("exact schema readiness", () => {
  it("is ready only at the authoritative project revision", () => expect(evaluateMigrationReadiness(EXPECTED_SCHEMA_REVISION)).toEqual({ expected: EXPECTED_SCHEMA_REVISION, current: EXPECTED_SCHEMA_REVISION, ready: true }));
  it("rejects a wrong revision", () => expect(evaluateMigrationReadiness("runtime-schema-0003").ready).toBe(false));
  it("rejects a missing revision record", () => expect(evaluateMigrationReadiness(null)).toEqual({ expected: EXPECTED_SCHEMA_REVISION, current: null, ready: false }));
});
