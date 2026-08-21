import { describe, expect, it } from "vitest";
import { rawPayloadRetentionMode } from "./retention.js";

describe("raw-payload retention safety", () => { it("defaults to dry run and requires an explicit apply flag", () => { expect(rawPayloadRetentionMode([])).toBe("DRY_RUN"); expect(rawPayloadRetentionMode(["--days=14"])).toBe("DRY_RUN"); expect(rawPayloadRetentionMode(["--apply"])).toBe("APPLIED"); }); });
