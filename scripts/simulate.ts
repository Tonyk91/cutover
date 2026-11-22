/**
 * Replay a legacy export history through the new engine in shadow mode.
 *
 *   npm run simulate            # print the report, write reports/replay.md
 *   npm run simulate -- --ci    # also assert the expected gate decisions (used in CI)
 *
 * Pass 1 runs the engine with only the documented rules.
 * Pass 2 adds the rule that pass 1 surfaced. The gate decides each time.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { MemoryLog, MemoryMetrics, MemoryStore } from "../src/adapters/memory.js";
import { HYPOTHESES } from "../src/core/parity.js";
import { processChange } from "../src/core/process.js";
import { gate, type ParityStats, type Stage } from "../src/core/rollout.js";
import type { DiffClass, PriceChange, PricingRules } from "../src/core/types.js";
import { DEFAULTS, estimate } from "../src/finops/cost.js";
import { generate } from "../src/sim/generate.js";

const CI = process.argv.includes("--ci");
const CLASSES: DiffClass[] = ["MATCH", "LEGACY_FLOAT_ROUNDING", "LEGACY_VAT_EXPORT_DATE", "UNEXPLAINED"];

interface PassResult {
  name: string;
  stats: ParityStats;
  unexplainedStores: Map<string, number>;
  sampleUnexplained: { change: PriceChange; deltaOre: number }[];
  duplicates: number;
  stored: number;
  publishedNew: number;
}

async function runPass(name: string, rows: PriceChange[], rules: PricingRules, rolloutPct: Stage): Promise<PassResult> {
  const store = new MemoryStore();
  const metrics = new MemoryMetrics();
  const log = new MemoryLog();

  // SQS standard is at-least-once: replay ~2 % of messages a second time.
  const deliveries = [...rows, ...rows.filter((_, i) => i % 50 === 0)];
  for (const c of deliveries) await processChange(c, { rules, rolloutPct }, { store, metrics, log });

  const byClass: ParityStats["byClass"] = {};
  for (const k of CLASSES) {
    const n = metrics.get("Parity", { class: k });
    if (n) byClass[k] = n;
  }
  const unexplainedStores = new Map<string, number>();
  const sampleUnexplained: PassResult["sampleUnexplained"] = [];
  for (const w of log.warnings) {
    const change = w.extra!.change as PriceChange;
    const delta = (w.extra!.parity as { deltaOre: number }).deltaOre;
    unexplainedStores.set(change.storeId, (unexplainedStores.get(change.storeId) ?? 0) + 1);
    if (sampleUnexplained.length < 3) sampleUnexplained.push({ change, deltaOre: delta });
  }
  return {
    name,
    stats: { total: store.records.size, byClass },
    unexplainedStores,
    sampleUnexplained,
    duplicates: metrics.get("DuplicateEvent"),
    stored: store.records.size,
    publishedNew: metrics.get("Published", { source: "new" }),
  };
}

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(2)} %`;

function section(r: PassResult, stage: Stage): string {
  const g = gate(stage, r.stats);
  const t = r.stats.total;
  const out: string[] = [];
  out.push(`### ${r.name}`, "");
  out.push("| Class | Rows | Share | Accepted |", "|---|---:|---:|---|");
  for (const k of CLASSES) {
    const n = r.stats.byClass[k] ?? 0;
    const acc = k === "MATCH" ? "–" : k === "UNEXPLAINED" ? "**no**" : "yes";
    out.push(`| ${k} | ${n.toLocaleString("en")} | ${pct(n, t)} | ${acc} |`);
  }
  out.push("");
  out.push(`Stored ${r.stored.toLocaleString("en")} changes; ${r.duplicates} duplicate deliveries absorbed by idempotency (none stored twice).`);
  if (r.unexplainedStores.size) {
    const stores = [...r.unexplainedStores.keys()].sort();
    const allNorth = stores.every((s) => s.startsWith("N"));
    out.push("", `Unexplained diffs sit in ${stores.length} stores: ${stores.join(", ")}${allNorth ? " — **every one is an N store**." : "."}`);
    for (const s of r.sampleUnexplained) {
      const c = s.change;
      out.push(`- ${c.storeId} ${c.sku}: net ${c.netOre} öre, legacy ${c.legacyShelfOre}, new ${c.legacyShelfOre + s.deltaOre} (Δ ${s.deltaOre} öre)`);
    }
  }
  out.push("", `**Gate ${g.current} % → ${g.next} %: ${g.advance ? "ADVANCE" : "BLOCKED"}**${g.reasons.length ? ` (${g.reasons.join("; ")})` : ""}`, "");
  return out.join("\n");
}

async function main() {
  // Replay: exports from the two weeks around the food VAT cut on 2026-04-01.
  const replay = generate({ rows: 20_000, seed: 42, from: "2026-03-18", days: 28 });
  // Forecast: the same legacy behaviour around 2028-01-01, when food VAT goes back to 12 %.
  const forecast = generate({ rows: 5_000, seed: 7, from: "2027-12-18", days: 21 });

  const p1 = await runPass("Pass 1 — documented rules only", replay, {}, 0);
  const p2 = await runPass("Pass 2 — with the north freight rule (+2 % on N stores)", replay, { northFreightPct: 2 }, 0);
  const p3 = await runPass("Pass 3 — rollout at 10 %", replay, { northFreightPct: 2 }, 10);
  const fc = await runPass("Forecast — Dec 2027 exports, VAT back to 12 %", forecast, { northFreightPct: 2 }, 10);

  const cost10 = estimate();
  const cost1 = estimate({ ...DEFAULTS, batchSize: 1 });
  const costTx = estimate({ ...DEFAULTS, write: "transaction" });

  const md: string[] = [];
  md.push("# Replay report", "");
  md.push(`Generated by \`npm run simulate\`. Seeded: identical on every run. ${replay.length.toLocaleString("en")} replayed price changes, 60 stores.`, "");
  md.push("## Hypotheses (named reasons legacy and new may differ)", "");
  const seen = new Set<string>();
  for (const h of HYPOTHESES) {
    if (seen.has(h.code)) continue;
    seen.add(h.code);
    md.push(`- **${h.code}** — ${h.why}`);
  }
  md.push("", "A diff is explained only if a hypothesis reproduces the legacy price exactly, to the öre.", "");
  md.push("## Results", "");
  md.push(section(p1, 0), section(p2, 0));
  md.push(`### ${p3.name}`, "", `${p3.publishedNew.toLocaleString("en")} of ${p3.stored.toLocaleString("en")} changes (${pct(p3.publishedNew, p3.stored)}) were published from the new engine; the rest still from legacy. ${section(p3, 10).split("\n").filter((l) => l.startsWith("**Gate")).join("")}`, "");
  md.push(section(fc, 10));
  md.push("## Cost per 1 000 000 price changes (USD, list prices, see src/finops/cost.ts)", "");
  md.push("| Item | Chosen: batch 10, conditional put | Batch 1 | Transaction + marker item |", "|---|---:|---:|---:|");
  cost10.lines.forEach((l, i) => md.push(`| ${l.item} | ${l.usd.toFixed(2)} | ${cost1.lines[i]!.usd.toFixed(2)} | ${costTx.lines[i]!.usd.toFixed(2)} |`));
  md.push(`| **Total** | **${cost10.total.toFixed(2)}** | **${cost1.total.toFixed(2)}** | **${costTx.total.toFixed(2)}** |`, "");

  const report = md.join("\n");
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/replay.md", report);
  console.log(report);

  if (CI) {
    const checks: [string, boolean][] = [
      ["pass 1 is blocked by unexplained diffs", !gate(0, p1.stats).advance && (p1.stats.byClass.UNEXPLAINED ?? 0) > 0],
      ["every unexplained diff in pass 1 is an N store", [...p1.unexplainedStores.keys()].every((s) => s.startsWith("N"))],
      ["pass 2 has zero unexplained diffs", (p2.stats.byClass.UNEXPLAINED ?? 0) === 0],
      ["pass 2 gate advances 0 → 10", gate(0, p2.stats).advance],
      ["duplicates are never stored twice", p2.stored === replay.length],
      ["forecast finds VAT export-date diffs around 2028-01-01", (fc.stats.byClass.LEGACY_VAT_EXPORT_DATE ?? 0) > 0],
    ];
    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
      if (!ok) failed++;
    }
    if (failed) process.exit(1);
  }
}

await main();
