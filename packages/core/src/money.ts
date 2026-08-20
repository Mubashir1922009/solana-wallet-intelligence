const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export function decimalToBaseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be an integer between 0 and 255");
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error("Amount must be a non-negative decimal string");
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error("Amount has more precision than token decimals");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

export function baseUnitsToDecimal(value: bigint, decimals: number): string {
  if (value < 0n) throw new Error("Base-unit amount cannot be negative");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be an integer between 0 and 255");
  }
  if (decimals === 0) return value.toString();
  const padded = value.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

export function parseUsdCents(value: string): bigint {
  const cents = decimalToBaseUnits(value, 2);
  if (cents <= 0n) throw new Error("USD amount must be greater than zero");
  return cents;
}

export function assertTradeLimit(amountUsd: string, maximumUsd: string): void {
  if (parseUsdCents(amountUsd) > parseUsdCents(maximumUsd)) {
    throw new Error(`Trade amount exceeds the configured ${maximumUsd} USD limit`);
  }
}

export function divideDecimalToRawTokenAmount(amountUsd: string, tokenPriceUsd: string, tokenDecimals: number): bigint {
  const scale = 12;
  const usd = decimalToBaseUnits(amountUsd, scale);
  const price = decimalToBaseUnits(tokenPriceUsd, scale);
  if (price === 0n) throw new Error("Token price must be greater than zero");
  return (usd * 10n ** BigInt(tokenDecimals)) / price;
}
