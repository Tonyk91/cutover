import { legacyShelfOre, type LegacyQuirks } from "./legacyModel.js";
import { shelfPriceOre } from "./pricing.js";
import type { DiffClass, ParityResult, PriceChange, PricingRules } from "./types.js";

/**
 * A known, named reason why legacy and new can disagree.
 * A diff counts as "explained" only if the hypothesis reproduces the legacy
 * output EXACTLY, to the öre, for that row. Close is not explained.
 */
export interface Hypothesis {
  code: Exclude<DiffClass, "MATCH" | "UNEXPLAINED">;
  /** Accepted = the new engine is right and legacy is wrong. Safe to cut over. */
  accepted: boolean;
  why: string;
  quirks: Omit<LegacyQuirks, "northFreightPct">;
}

/** Order matters: the most specific explanation is tried first. */
export const HYPOTHESES: readonly Hypothesis[] = [
  {
    code: "LEGACY_FLOAT_ROUNDING",
    accepted: true,
    why: "Legacy rounds a binary float; values at exactly x.x5 kr round down. New engine rounds exactly.",
    quirks: { floats: true, vatDate: "effectiveFrom" },
  },
  {
    code: "LEGACY_VAT_EXPORT_DATE",
    accepted: true,
    why: "Legacy picks the VAT rate by export date, not effective date. Wrong for rows that straddle a VAT change.",
    quirks: { floats: false, vatDate: "exportedAt" },
  },
  {
    code: "LEGACY_VAT_EXPORT_DATE",
    accepted: true,
    why: "Both legacy quirks at once (export-date VAT, float rounding).",
    quirks: { floats: true, vatDate: "exportedAt" },
  },
];

export function compare(change: PriceChange, rules: PricingRules): ParityResult {
  const newShelfOre = shelfPriceOre(change, rules);
  const legacy = change.legacyShelfOre;
  const deltaOre = newShelfOre - legacy;

  if (deltaOre === 0) return { newShelfOre, legacyShelfOre: legacy, diffClass: "MATCH", deltaOre };

  const freight = rules.northFreightPct ?? 0;
  for (const h of HYPOTHESES) {
    if (legacyShelfOre(change, { ...h.quirks, northFreightPct: freight }) === legacy) {
      return { newShelfOre, legacyShelfOre: legacy, diffClass: h.code, deltaOre };
    }
  }
  return { newShelfOre, legacyShelfOre: legacy, diffClass: "UNEXPLAINED", deltaOre };
}

export function isAccepted(c: DiffClass): boolean {
  if (c === "MATCH") return true;
  if (c === "UNEXPLAINED") return false;
  return HYPOTHESES.some((h) => h.code === c && h.accepted);
}
