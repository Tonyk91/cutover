import { describe, expect, it } from "vitest";
import { MemoryLog, MemoryMetrics, MemoryStore } from "../src/adapters/memory.js";
import { parseExport, toCsv } from "../src/core/csv.js";
import { legacyShelfOre } from "../src/core/legacyModel.js";
import { compare } from "../src/core/parity.js";
import { shelfPriceOre } from "../src/core/pricing.js";
import { processChange } from "../src/core/process.js";
import { bucket, gate, sourceFor } from "../src/core/rollout.js";
import type { PriceChange } from "../src/core/types.js";
import { vatPct } from "../src/core/vat.js";
import { DEFAULTS, estimate } from "../src/finops/cost.js";

const base: PriceChange = {
  eventId: "e1",
  sku: "7310000012345",
  storeId: "S1001",
  category: "food",
  netOre: 1000,
  campaignPct: 0,
  effectiveFrom: "2026-05-01",
  exportedAt: "2026-04-28",
  legacyShelfOre: 1060,
};

describe("VAT", () => {
  it("food is 6 % from 2026-04-01 through 2027-12-31 and 12 % outside", () => {
    expect(vatPct("food", "2026-03-31")).toBe(12);
    expect(vatPct("food", "2026-04-01")).toBe(6);
    expect(vatPct("food", "2027-12-31")).toBe(6);
    expect(vatPct("food", "2028-01-01")).toBe(12);
  });
  it("non-food is always 25 %", () => {
    expect(vatPct("nonfood", "2026-04-01")).toBe(25);
  });
});

describe("new engine", () => {
  it("adds VAT by effective date", () => {
    expect(shelfPriceOre(base)).toBe(1060);
    expect(shelfPriceOre({ ...base, effectiveFrom: "2026-03-31" })).toBe(1120);
  });

  it("rounds half-up to 10 öre exactly, where floats get it wrong", () => {
    // Non-food, 25 % VAT: 1324 × 1.25 = 1655 öre exactly, which must round UP to 1660.
    const c = { ...base, category: "nonfood" as const, netOre: 1324 };
    expect(shelfPriceOre(c)).toBe(1660);
  });

  it("finds a real case where the float formula rounds down and the exact one rounds up", () => {
    let found: PriceChange | undefined;
    for (let net = 500; net < 30_000 && !found; net++) {
      for (const pct of [0, 10, 15, 20, 25, 30, 33, 50]) {
        const c = { ...base, netOre: net, campaignPct: pct };
        const exact = shelfPriceOre(c);
        const float = legacyShelfOre(c, { floats: true, vatDate: "effectiveFrom", northFreightPct: 0 });
        if (exact !== float) {
          found = c;
          expect(exact - float).toBe(10); // always the half-up case, never anything else
          break;
        }
      }
    }
    expect(found).toBeDefined();
  });

  it("applies a campaign before rounding, not after", () => {
    // 1000 × 1.06 × 0.67 = 710.2 → 710
    expect(shelfPriceOre({ ...base, campaignPct: 33 })).toBe(710);
  });

  it("applies the north freight rule only to N stores and only when configured", () => {
    const n = { ...base, storeId: "N2001" };
    expect(shelfPriceOre(n)).toBe(1060);
    expect(shelfPriceOre(n, { northFreightPct: 2 })).toBe(1080); // 1000 × 1.02 × 1.06 = 1081.2
    expect(shelfPriceOre(base, { northFreightPct: 2 })).toBe(1060);
  });
});

describe("parity classification", () => {
  it("MATCH when legacy agrees", () => {
    expect(compare(base, {}).diffClass).toBe("MATCH");
  });

  it("explains an export-date VAT diff on a row that straddles the VAT cut", () => {
    const c = { ...base, exportedAt: "2026-03-28", effectiveFrom: "2026-04-02", legacyShelfOre: 1120 };
    const r = compare(c, {});
    expect(r.diffClass).toBe("LEGACY_VAT_EXPORT_DATE");
    expect(r.deltaOre).toBe(-60);
  });

  it("does not explain a diff that is merely close", () => {
    const r = compare({ ...base, legacyShelfOre: 1070 }, {});
    expect(r.diffClass).toBe("UNEXPLAINED");
  });

  it("an undocumented rule shows up as UNEXPLAINED until it is written down", () => {
    const c = { ...base, storeId: "N2001", legacyShelfOre: 1080 };
    expect(compare(c, {}).diffClass).toBe("UNEXPLAINED");
    expect(compare(c, { northFreightPct: 2 }).diffClass).toBe("MATCH");
  });
});

describe("rollout", () => {
  it("buckets are stable and in range", () => {
    expect(bucket("S1001")).toBe(bucket("S1001"));
    for (const s of ["S1001", "N2001", "S9999"]) {
      expect(bucket(s)).toBeGreaterThanOrEqual(0);
      expect(bucket(s)).toBeLessThan(100);
    }
  });

  it("the 10 % cohort is a subset of the 50 % cohort (no store flips back)", () => {
    const stores = Array.from({ length: 500 }, (_, i) => `S${1000 + i}`);
    for (const s of stores) {
      if (sourceFor(s, 10) === "new") expect(sourceFor(s, 50)).toBe("new");
    }
    expect(stores.every((s) => sourceFor(s, 0) === "legacy")).toBe(true);
    expect(stores.every((s) => sourceFor(s, 100) === "new")).toBe(true);
  });

  it("gate blocks on a single unexplained diff, small samples, and at 100 %", () => {
    expect(gate(0, { total: 5000, byClass: { MATCH: 4999, UNEXPLAINED: 1 } }).advance).toBe(false);
    expect(gate(0, { total: 10, byClass: { MATCH: 10 } }).advance).toBe(false);
    expect(gate(100, { total: 5000, byClass: { MATCH: 5000 } }).advance).toBe(false);
    const ok = gate(10, { total: 5000, byClass: { MATCH: 4900, LEGACY_VAT_EXPORT_DATE: 100 } });
    expect(ok).toMatchObject({ advance: true, next: 50 });
  });
});

describe("processing", () => {
  const deps = () => ({ store: new MemoryStore(), metrics: new MemoryMetrics(), log: new MemoryLog() });

  it("publishes legacy at 0 % and new at 100 %, and always records parity", async () => {
    const c = { ...base, exportedAt: "2026-03-28", effectiveFrom: "2026-04-02", legacyShelfOre: 1120 };
    const d0 = deps();
    expect((await processChange(c, { rules: {}, rolloutPct: 0 }, d0)).publishedOre).toBe(1120);
    const d100 = deps();
    const r = await processChange(c, { rules: {}, rolloutPct: 100 }, d100);
    expect(r).toMatchObject({ publishedOre: 1060, source: "new" });
    expect(d100.metrics.get("Parity", { class: "LEGACY_VAT_EXPORT_DATE" })).toBe(1);
  });

  it("is idempotent: a redelivered message is not stored or counted twice", async () => {
    const d = deps();
    await processChange(base, { rules: {}, rolloutPct: 0 }, d);
    const again = await processChange(base, { rules: {}, rolloutPct: 0 }, d);
    expect(again.outcome).toBe("duplicate");
    expect(d.store.records.size).toBe(1);
    expect(d.metrics.get("Parity", { class: "MATCH" })).toBe(1);
    expect(d.metrics.get("DuplicateEvent")).toBe(1);
  });

  it("logs every unexplained row with the full input", async () => {
    const d = deps();
    await processChange({ ...base, legacyShelfOre: 999 }, { rules: {}, rolloutPct: 0 }, d);
    expect(d.log.warnings).toHaveLength(1);
    expect(d.log.warnings[0]!.extra!.change).toMatchObject({ eventId: "e1" });
  });
});

describe("CSV", () => {
  it("round-trips and rejects bad rows with a line number instead of failing the file", () => {
    const csv = toCsv([base, { ...base, eventId: "e2" }]) + "e3;notanean;S1001;food;1000;0;2026-05-01;2026-04-28;1060\n";
    const { ok, rejected } = parseExport(csv);
    expect(ok).toHaveLength(2);
    expect(rejected).toEqual([{ line: 4, reason: expect.stringContaining("sku") }]);
  });

  it("refuses a file with an unexpected header", () => {
    const { ok, rejected } = parseExport("a;b;c\n1;2;3\n");
    expect(ok).toHaveLength(0);
    expect(rejected[0]!.line).toBe(1);
  });
});

describe("FinOps", () => {
  it("batching 10 is cheaper than batching 1", () => {
    expect(estimate().total).toBeLessThan(estimate({ ...DEFAULTS, batchSize: 1 }).total);
  });

  it("a transaction with a marker item costs 4× the WRU of one conditional put", () => {
    const dyn = (w: "transaction" | "conditional-put") =>
      estimate({ ...DEFAULTS, write: w }).lines.find((l) => l.item === "DynamoDB writes")!.usd;
    expect(dyn("transaction")).toBeCloseTo(4 * dyn("conditional-put"), 10);
  });
});
