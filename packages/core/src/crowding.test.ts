import { describe, expect, it } from "vitest";
import type { ClassifiedWalletAction } from "./solana.js";
import { evaluateCrowding } from "./crowding.js";

function buy(wallet: string, seconds: number, amount = 100n): ClassifiedWalletAction {
  return { classification: "SWAP_BUY", confidence: "HIGH", evidence: [], ambiguityReasons: [], inputMint: "SOL", inputRawAmount: amount, inputDecimals: 9, outputMint: "TOKEN", outputRawAmount: 10n, outputDecimals: 6, transactionSignature: `${wallet}-${seconds}`, wallet, slot: 1n, blockTime: new Date(Date.parse("2026-08-20T12:00:00.000Z") + seconds * 1000).toISOString(), observedAt: "2026-08-20T12:01:00.000Z" };
}

describe("anti-crowding observations", () => {
  it("counts distinct followers in provisional time windows", () => {
    const source = buy("source", 0);
    const result = evaluateCrowding(source, [buy("one", 3, 10n), buy("two", 10, 20n), buy("one", 40, 30n)], { monitoredWalletCount: 8, expectedCoverageWalletCount: 10 }, "2026-08-20T12:02:00.000Z");
    expect(result.windows).toEqual([
      { windowMs: 5000, followerWalletCount: 1, followerActionCount: 1, delayMs: [3000] },
      { windowMs: 30000, followerWalletCount: 2, followerActionCount: 2, delayMs: [3000, 10000] },
      { windowMs: 60000, followerWalletCount: 2, followerActionCount: 3, delayMs: [3000, 10000, 40000] }
    ]);
    expect(result.observedInputVolumeRaw).toBe(60n);
    expect(result.confidence).toBe("HIGH");
  });

  it("does not turn unknown coverage into an observed zero", () => {
    const result = evaluateCrowding({ ...buy("source", 0), blockTime: null }, [], { monitoredWalletCount: null, expectedCoverageWalletCount: null }, "2026-08-20T12:02:00.000Z");
    expect(result.status).toBe("UNKNOWN");
    expect(result.coverageRatio).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining(["SOURCE_TIME_UNKNOWN", "COVERAGE_UNKNOWN"]));
  });
});
