import type { PriceRecord } from "./types.js";

/**
 * Stores a processed price change and marks its eventId as done, atomically.
 *
 * Why one call and not "claim the id, then write the price": if the function
 * dies between the two, the retry sees the id as claimed and skips it, and
 * that price change is silently lost. A single conditional write cannot half-happen.
 */
export interface PriceStore {
  commit(record: PriceRecord): Promise<"stored" | "duplicate">;
}

export interface MetricsSink {
  count(name: string, dims?: Record<string, string>): void;
}

export interface Log {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
}
