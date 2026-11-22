import { compare } from "./parity.js";
import type { Log, MetricsSink, PriceStore } from "./ports.js";
import { sourceFor } from "./rollout.js";
import type { PriceChange, PricingRules, PriceRecord } from "./types.js";

export interface EngineConfig {
  rules: PricingRules;
  rolloutPct: number;
}

export interface Deps {
  store: PriceStore;
  metrics: MetricsSink;
  log: Log;
}

/**
 * Process one price change in shadow mode:
 * always compute the new price and compare it with legacy, then publish
 * whichever engine owns this store at the current rollout stage.
 */
export async function processChange(
  change: PriceChange,
  cfg: EngineConfig,
  deps: Deps,
): Promise<PriceRecord & { outcome: "stored" | "duplicate" }> {
  const parity = compare(change, cfg.rules);
  const source = sourceFor(change.storeId, cfg.rolloutPct);

  const record: PriceRecord = {
    eventId: change.eventId,
    storeId: change.storeId,
    sku: change.sku,
    effectiveFrom: change.effectiveFrom,
    publishedOre: source === "new" ? parity.newShelfOre : parity.legacyShelfOre,
    source,
    parity,
  };

  const outcome = await deps.store.commit(record);
  if (outcome === "duplicate") {
    deps.metrics.count("DuplicateEvent");
    return { ...record, outcome };
  }

  deps.metrics.count("Parity", { class: parity.diffClass });
  deps.metrics.count("Published", { source });

  if (parity.diffClass === "UNEXPLAINED") {
    // Full detail at warn level: this row is the input to the next rule fix.
    deps.log.warn("unexplained parity diff", { change, parity });
  }
  return { ...record, outcome };
}
