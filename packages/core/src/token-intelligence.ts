import type { LargestTokenAccountObservation, OwnerConcentrationObservation, TokenConcentrationObservation } from "./runtime-domain.js";

function ratioDecimal(numerator: bigint, denominator: bigint, scale: bigint, precision: number): string | null {
  if (denominator <= 0n) return null;
  const scaled = numerator * scale * 10n ** BigInt(precision) / denominator;
  const whole = scaled / 10n ** BigInt(precision);
  const fraction = (scaled % 10n ** BigInt(precision)).toString().padStart(precision, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function percentageOfSupply(rawAmount: bigint, rawSupply: bigint): string | null {
  return ratioDecimal(rawAmount, rawSupply, 100n, 12);
}

export function fractionOfSupply(rawAmount: bigint, rawSupply: bigint): string | null {
  return ratioDecimal(rawAmount, rawSupply, 1n, 12);
}

function sumTop(values: bigint[], count: number): bigint {
  return values.slice(0, count).reduce((sum, value) => sum + value, 0n);
}

export function calculateTokenConcentration(accounts: LargestTokenAccountObservation[], rawSupply: bigint | null): TokenConcentrationObservation {
  const ordered = [...accounts].sort((a, b) => a.rawBalance === b.rawBalance ? 0 : a.rawBalance > b.rawBalance ? -1 : 1);
  const balances = ordered.map((account) => account.rawBalance);
  const ownerMap = new Map<string, { rawBalance: bigint; accountCount: number }>();
  let unresolvedRaw = 0n;
  for (const account of ordered) {
    if (account.resolvedOwner === null) { unresolvedRaw += account.rawBalance; continue; }
    const current = ownerMap.get(account.resolvedOwner) ?? { rawBalance: 0n, accountCount: 0 };
    ownerMap.set(account.resolvedOwner, { rawBalance: current.rawBalance + account.rawBalance, accountCount: current.accountCount + 1 });
  }
  const knownOwners: OwnerConcentrationObservation[] = [...ownerMap.entries()].map(([owner, value]) => ({
    owner, rawBalance: value.rawBalance, percentageOfSupply: rawSupply === null ? null : percentageOfSupply(value.rawBalance, rawSupply), accountCount: value.accountCount
  })).sort((a, b) => a.rawBalance === b.rawBalance ? 0 : a.rawBalance > b.rawBalance ? -1 : 1);
  const ownerBalances = knownOwners.map((owner) => owner.rawBalance);
  const pct = (value: bigint): string | null => rawSupply === null ? null : percentageOfSupply(value, rawSupply);
  const fraction = (value: bigint): string | null => rawSupply === null ? null : fractionOfSupply(value, rawSupply);
  return {
    largestAccountPct: pct(balances[0] ?? 0n), top5AccountsPct: pct(sumTop(balances, 5)), top10AccountsPct: pct(sumTop(balances, 10)),
    largestKnownOwnerPct: knownOwners.length === 0 ? null : pct(ownerBalances[0] ?? 0n),
    top5KnownOwnersPct: knownOwners.length === 0 ? null : pct(sumTop(ownerBalances, 5)),
    top10KnownOwnersPct: knownOwners.length === 0 ? null : pct(sumTop(ownerBalances, 10)),
    unresolvedAccountPct: pct(unresolvedRaw), observationCoverage: fraction(sumTop(balances, balances.length)), knownOwners,
    observedAccountCount: ordered.length, resolvedAccountCount: ordered.length - ordered.filter((account) => account.resolvedOwner === null).length
  };
}
