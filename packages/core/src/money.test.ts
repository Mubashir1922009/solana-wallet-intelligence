import { describe, expect, it } from "vitest";
import { assertTradeLimit, baseUnitsToDecimal, decimalToBaseUnits, divideDecimalToRawTokenAmount, parseUsdCents } from "./money.js";

describe("exact monetary utilities", () => {
  it("enforces the five dollar maximum", () => {
    expect(() => assertTradeLimit("5.01", "5")).toThrow(/exceeds/);
    expect(() => assertTradeLimit("5.00", "5")).not.toThrow();
  });
  it("rejects negative and zero USD values", () => {
    expect(() => parseUsdCents("-1")).toThrow();
    expect(() => parseUsdCents("0")).toThrow(/greater than zero/);
  });
  it("converts token base units without floating point", () => {
    const raw = decimalToBaseUnits("9007199254740993.123456789", 9);
    expect(raw).toBe(9_007_199_254_740_993_123_456_789n);
    expect(baseUnitsToDecimal(raw, 9)).toBe("9007199254740993.123456789");
  });
  it("calculates paper token quantity with integer division", () => {
    expect(divideDecimalToRawTokenAmount("1", "0.000002", 6)).toBe(500_000_000_000n);
  });
});
