import type { PriceChange, PricingRules } from "./types.js";
import { vatPct } from "./vat.js";

type PriceInput = Pick<PriceChange, "storeId" | "category" | "netOre" | "campaignPct" | "effectiveFrom">;

/**
 * The new price engine. Exact integer arithmetic (BigInt), one rounding step
 * at the very end: half-up to the nearest 10 öre.
 *
 *   shelf = net × (1 + freight) × (1 + vat) × (1 − campaign)
 *
 * Every factor is a whole percent, so the exact value is
 *   net × (100 + f) × (100 + v) × (100 − c) / 100^3
 * and we round that rational number once. No floats anywhere.
 */
export function shelfPriceOre(input: PriceInput, rules: PricingRules = {}): number {
  const freight = freightPct(input.storeId, rules);
  const vat = vatPct(input.category, input.effectiveFrom);

  const num =
    BigInt(input.netOre) *
    BigInt(100 + freight) *
    BigInt(100 + vat) *
    BigInt(100 - input.campaignPct);
  const den = 1_000_000n; // 100^3

  return roundHalfUpTo10(num, den);
}

export function freightPct(storeId: string, rules: PricingRules): number {
  return rules.northFreightPct && storeId.startsWith("N") ? rules.northFreightPct : 0;
}

/** Round num/den öre half-up to a multiple of 10 öre. */
function roundHalfUpTo10(num: bigint, den: bigint): number {
  const step = den * 10n;
  const tens = (num * 2n + step) / (step * 2n); // floor((x + 5) / 10) in exact form
  return Number(tens * 10n);
}
