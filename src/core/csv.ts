import { PriceChange } from "./types.js";

export const CSV_HEADER = [
  "eventId",
  "sku",
  "storeId",
  "category",
  "netOre",
  "campaignPct",
  "effectiveFrom",
  "exportedAt",
  "legacyShelfOre",
] as const;

export interface Rejected {
  line: number;
  reason: string;
}

/**
 * Parse a legacy export. Bad rows are rejected with a line number and a
 * reason instead of failing the whole file: one broken row must not stop
 * 40 000 good price changes from reaching the stores.
 */
export function parseExport(text: string): { ok: PriceChange[]; rejected: Rejected[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const ok: PriceChange[] = [];
  const rejected: Rejected[] = [];
  if (lines.length === 0) return { ok, rejected };

  const header = lines[0]!.split(";").map((s) => s.trim());
  if (header.join(";") !== CSV_HEADER.join(";")) {
    return { ok, rejected: [{ line: 1, reason: `unexpected header: ${lines[0]}` }] };
  }

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(";").map((s) => s.trim());
    if (cells.length !== CSV_HEADER.length) {
      rejected.push({ line: i + 1, reason: `expected ${CSV_HEADER.length} fields, got ${cells.length}` });
      continue;
    }
    const raw = Object.fromEntries(CSV_HEADER.map((k, j) => [k, cells[j]]));
    const parsed = PriceChange.safeParse(raw);
    if (parsed.success) ok.push(parsed.data);
    else
      rejected.push({
        line: i + 1,
        reason: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
      });
  }
  return { ok, rejected };
}

export function toCsv(rows: PriceChange[]): string {
  return [CSV_HEADER.join(";"), ...rows.map((r) => CSV_HEADER.map((k) => r[k]).join(";"))].join("\n") + "\n";
}
