/**
 * Swedish VAT, effective-dated.
 *
 * Food VAT was cut from 12 % to 6 % for the period 2026-04-01 .. 2027-12-31
 * (temporary law). It goes back to 12 % on 2028-01-01 unless extended.
 * Non-food is 25 %.
 *
 * The rate is a function of the date the price TAKES EFFECT, never of the
 * date the price was exported or processed. Getting that wrong is one of the
 * legacy behaviours this repo detects.
 */
const FOOD_PERIODS: ReadonlyArray<{ from: string; to: string; pct: number }> = [
  { from: "2026-04-01", to: "2027-12-31", pct: 6 },
];

export function vatPct(category: "food" | "nonfood", isoDate: string): number {
  if (category === "nonfood") return 25;
  for (const p of FOOD_PERIODS) {
    // ISO dates compare correctly as strings.
    if (isoDate >= p.from && isoDate <= p.to) return p.pct;
  }
  return 12;
}

/** Dates where the food VAT rate changes. Used to build boundary test data. */
export const VAT_BOUNDARIES = ["2026-04-01", "2028-01-01"] as const;
