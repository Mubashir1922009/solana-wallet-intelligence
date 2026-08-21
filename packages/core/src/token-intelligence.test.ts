import { describe, expect, it } from "vitest";
import { calculateTokenConcentration, percentageOfSupply } from "./token-intelligence.js";

const account = (tokenAccount: string, rawBalance: bigint, owner: string | null) => ({ tokenAccount, rawBalance, decimals: 0, percentageOfSupply: percentageOfSupply(rawBalance, 1_000n), resolvedOwner: owner, ownerClassification: "UNKNOWN" as const, slot: 1n, observedAt: "2026-01-01T00:00:00.000Z", provenance: "SOLANA_GET_TOKEN_LARGEST_ACCOUNTS" as const });

describe("token concentration", () => {
  it("uses exact bigint arithmetic for supply percentages", () => {
    expect(percentageOfSupply(1n, 3n)).toBe("33.333333333333");
    expect(percentageOfSupply(1n, 0n)).toBeNull();
  });

  it("keeps token-account and resolved-owner concentration distinct", () => {
    const result = calculateTokenConcentration([account("a", 200n, "owner-a"), account("b", 150n, "owner-a"), account("c", 100n, null)], 1_000n);
    expect(result.largestAccountPct).toBe("20");
    expect(result.largestKnownOwnerPct).toBe("35");
    expect(result.unresolvedAccountPct).toBe("10");
    expect(result.observationCoverage).toBe("0.45");
    expect(result.resolvedAccountCount).toBe(2);
  });

  it("reports unknown percentages when supply is unavailable", () => {
    const result = calculateTokenConcentration([account("a", 10n, null)], null);
    expect(result.top10AccountsPct).toBeNull();
    expect(result.observationCoverage).toBeNull();
  });
});
