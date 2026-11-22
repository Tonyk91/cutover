import type { Log, MetricsSink, PriceStore } from "../core/ports.js";
import type { PriceRecord } from "../core/types.js";

export class MemoryStore implements PriceStore {
  readonly records = new Map<string, PriceRecord>();
  async commit(r: PriceRecord) {
    if (this.records.has(r.eventId)) return "duplicate" as const;
    this.records.set(r.eventId, r);
    return "stored" as const;
  }
}

export class MemoryMetrics implements MetricsSink {
  readonly counts = new Map<string, number>();
  count(name: string, dims: Record<string, string> = {}) {
    const key = [name, ...Object.entries(dims).map(([k, v]) => `${k}=${v}`)].join("|");
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  get(name: string, dims: Record<string, string> = {}) {
    const key = [name, ...Object.entries(dims).map(([k, v]) => `${k}=${v}`)].join("|");
    return this.counts.get(key) ?? 0;
  }
}

export class MemoryLog implements Log {
  readonly warnings: { msg: string; extra?: Record<string, unknown> }[] = [];
  info() {}
  warn(msg: string, extra?: Record<string, unknown>) {
    this.warnings.push({ msg, extra });
  }
}
