import type { PriceChange } from "./types.js";
import { vatPct } from "./vat.js";

/**
 * A model of how the legacy system computes a shelf price, reconstructed
 * from its output. Two knobs, one per suspected quirk, so each quirk can be
 * tested on its own as a hypothesis:
 *
 * - `floats`: computes in kronor with IEEE-754 doubles and rounds with
 *   Math.round(x * 10) / 10. Values that should round up at exactly x.x5
 *   sometimes come out as x.x4999… and round down.
 * - `vatDate`: looks up VAT by the date the row was exported instead of the
 *   date it takes effect. Wrong only for rows that straddle a VAT change.
 *
 * Used by the classifier (to explain diffs) and by the simulator (to stand in
 * for the real legacy system when generating replay data).
 */
export interface LegacyQuirks {
  floats: boolean;
  vatDate: "effectiveFrom" | "exportedAt";
  /** Undocumented surcharge the legacy system applies to "N" stores. */
  northFreightPct: number;
}

export function legacyShelfOre(
  c: Pick<PriceChange, "storeId" | "category" | "netOre" | "campaignPct" | "effectiveFrom" | "exportedAt">,
  q: LegacyQuirks,
): number {
  const date = q.vatDate === "exportedAt" ? c.exportedAt : c.effectiveFrom;
  const vat = vatPct(c.category, date);
  const freight = q.northFreightPct && c.storeId.startsWith("N") ? q.northFreightPct : 0;

  if (q.floats) {
    const kr =
      (c.netOre / 100) * (1 + freight / 100) * (1 + vat / 100) * (1 - c.campaignPct / 100);
    return Math.round(Math.round(kr * 10) / 10 * 100);
  }

  // Exact path, identical to the new engine's arithmetic.
  const num =
    BigInt(c.netOre) * BigInt(100 + freight) * BigInt(100 + vat) * BigInt(100 - c.campaignPct);
  const step = 10_000_000n;
  return Number(((num * 2n + step) / (step * 2n)) * 10n);
}
