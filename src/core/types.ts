import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * One row of the nightly price export from the legacy price system.
 * `legacyShelfOre` is what the legacy system itself sent to the stores,
 * which is what makes shadow mode possible: we know its answer for every row.
 */
export const PriceChange = z.object({
  eventId: z.string().min(1),
  sku: z.string().regex(/^\d{8,14}$/, "expected an EAN/GTIN"),
  storeId: z.string().regex(/^[A-Z]\d{3,5}$/, "expected e.g. S1042"),
  category: z.enum(["food", "nonfood"]),
  netOre: z.coerce.number().int().positive().max(10_000_000),
  campaignPct: z.coerce.number().int().min(0).max(90),
  effectiveFrom: isoDate,
  exportedAt: isoDate,
  legacyShelfOre: z.coerce.number().int().positive(),
});
export type PriceChange = z.infer<typeof PriceChange>;

/** Business rules the new engine knows about. Every rule is explicit and named. */
export interface PricingRules {
  /** Surcharge in percent on the net price for stores whose id starts with "N". */
  northFreightPct?: number;
}

export type DiffClass =
  | "MATCH"
  | "LEGACY_FLOAT_ROUNDING"
  | "LEGACY_VAT_EXPORT_DATE"
  | "UNEXPLAINED";

export interface ParityResult {
  newShelfOre: number;
  legacyShelfOre: number;
  diffClass: DiffClass;
  /** Signed difference new minus legacy, in öre. */
  deltaOre: number;
}

export type Source = "legacy" | "new";

/** What gets stored per processed price change. */
export interface PriceRecord {
  eventId: string;
  storeId: string;
  sku: string;
  effectiveFrom: string;
  publishedOre: number;
  source: Source;
  parity: ParityResult;
}
