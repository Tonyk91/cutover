import { isAccepted } from "./parity.js";
import type { DiffClass, Source } from "./types.js";

/**
 * Strangler-fig cutover by store. Each store hashes to a stable bucket 0..99.
 * A store is served by the new engine when its bucket is below the current
 * rollout percent. Stable hashing means a store never flaps between engines
 * while the percent stays the same, and the 10 % cohort is a subset of 50 %.
 */
export const STAGES = [0, 10, 50, 100] as const;
export type Stage = (typeof STAGES)[number];

export function bucket(storeId: string): number {
  // FNV-1a 32-bit. Deterministic across runtimes, no crypto needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < storeId.length; i++) {
    h ^= storeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

export function sourceFor(storeId: string, rolloutPct: number): Source {
  return bucket(storeId) < rolloutPct ? "new" : "legacy";
}

export interface ParityStats {
  total: number;
  byClass: Partial<Record<DiffClass, number>>;
}

export interface GateDecision {
  current: Stage;
  next: Stage;
  advance: boolean;
  reasons: string[];
}

/**
 * The gate that decides whether the rollout may move to the next stage.
 * Deliberately boring: no thresholds on "mostly matching". One unexplained
 * diff blocks, because one unexplained diff is a rule nobody wrote down.
 */
export function gate(current: Stage, stats: ParityStats, minSample = 1000): GateDecision {
  const idx = STAGES.indexOf(current);
  const next = STAGES[Math.min(idx + 1, STAGES.length - 1)]!;
  const reasons: string[] = [];

  if (current === 100) reasons.push("already at 100 %; decommission legacy instead");
  if (stats.total < minSample) reasons.push(`sample ${stats.total} < ${minSample}`);

  for (const [cls, n] of Object.entries(stats.byClass) as [DiffClass, number][]) {
    if (n > 0 && !isAccepted(cls)) reasons.push(`${n} × ${cls}`);
  }

  return { current, next, advance: reasons.length === 0, reasons };
}
