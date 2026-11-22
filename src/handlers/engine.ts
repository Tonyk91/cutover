import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { Resource } from "sst";
import { DynamoPriceStore, metrics, PowertoolsLog, PowertoolsMetrics } from "../adapters/aws.js";
import { processChange, type EngineConfig } from "../core/process.js";
import { PriceChange } from "../core/types.js";

const store = new DynamoPriceStore(Resource.Prices.name);
const deps = { store, metrics: new PowertoolsMetrics(), log: new PowertoolsLog() };

/** Read per invocation so a rollout change is a config change, not a deploy. */
function config(): EngineConfig {
  return {
    rolloutPct: Number(process.env.ROLLOUT_PCT ?? "0"),
    rules: { northFreightPct: Number(process.env.NORTH_FREIGHT_PCT ?? "0") || undefined },
  };
}

/**
 * SQS consumer with partial batch responses: one bad message is retried
 * (and after 3 tries lands in the DLQ) without re-running the other nine.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const cfg = config();
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const msg of event.Records) {
    try {
      const change = PriceChange.parse(JSON.parse(msg.body));
      await processChange(change, cfg, deps);
    } catch (err) {
      deps.log.warn("price change failed", { messageId: msg.messageId, err: String(err) });
      batchItemFailures.push({ itemIdentifier: msg.messageId });
    }
  }

  metrics.publishStoredMetrics();
  return { batchItemFailures };
}
