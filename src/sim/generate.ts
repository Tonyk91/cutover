import { legacyShelfOre, type LegacyQuirks } from "../core/legacyModel.js";
import type { PriceChange } from "../core/types.js";

/** The legacy system as reconstructed: float maths, export-date VAT, and a freight rule nobody documented. */
export const LEGACY_TRUTH: LegacyQuirks = { floats: true, vatDate: "exportedAt", northFreightPct: 2 };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(iso: string, d: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

export interface GenOptions {
  rows: number;
  seed: number;
  /** First export day. Exports run for `days` days; prices take effect 0–7 days after export. */
  from: string;
  days: number;
}

/**
 * Synthetic replay data. 60 stores, 10 of them "N" stores in the north.
 * Everything is seeded, so every run and every CI job sees identical rows.
 */
export function generate(o: GenOptions): PriceChange[] {
  const rnd = mulberry32(o.seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const stores = [
    ...Array.from({ length: 50 }, (_, i) => `S${1001 + i}`),
    ...Array.from({ length: 10 }, (_, i) => `N${2001 + i}`),
  ];
  const campaigns = [10, 15, 20, 25, 30, 33, 50] as const;

  const rows: PriceChange[] = [];
  for (let i = 0; i < o.rows; i++) {
    const exportedAt = addDays(o.from, Math.floor(rnd() * o.days));
    const base = {
      eventId: `${o.seed}-${i}`,
      sku: String(7310000000000 + Math.floor(rnd() * 99999)),
      storeId: pick(stores),
      category: rnd() < 0.8 ? ("food" as const) : ("nonfood" as const),
      netOre: 500 + Math.floor(rnd() * 29_500),
      campaignPct: rnd() < 0.7 ? 0 : pick(campaigns),
      effectiveFrom: addDays(exportedAt, Math.floor(rnd() * 8)),
      exportedAt,
    };
    rows.push({ ...base, legacyShelfOre: legacyShelfOre(base, LEGACY_TRUTH) });
  }
  return rows;
}
