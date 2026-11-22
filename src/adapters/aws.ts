import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import type { Log, MetricsSink, PriceStore } from "../core/ports.js";
import type { PriceRecord } from "../core/types.js";

/**
 * Table layout:
 *   pk = PRICE#<storeId>#<sku>      sk = <effectiveFrom>#<eventId>
 *
 * The eventId is part of the key, so ONE conditional put is both the write
 * and the idempotency check: a redelivered message hits the same key and the
 * condition fails. No separate marker item, no transaction.
 *
 * (First version used TransactWriteItems with a marker item: 4 WRU per change.
 * This is 1 WRU, same guarantee. See README › FinOps.)
 *
 * Price history is kept per effective date, so a late-arriving older change
 * (SQS standard queues do not guarantee order) cannot overwrite a newer one.
 * The current price is the latest sk with effectiveFrom <= today.
 */
export class DynamoPriceStore implements PriceStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async commit(r: PriceRecord): Promise<"stored" | "duplicate"> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `PRICE#${r.storeId}#${r.sku}`, sk: `${r.effectiveFrom}#${r.eventId}`, ...r },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return "stored";
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException) return "duplicate";
      throw e;
    }
  }
}

export const logger = new Logger({ serviceName: "cutover" });
export const metrics = new Metrics({ namespace: "Cutover", serviceName: "cutover" });

/** CloudWatch metrics via Embedded Metric Format: written as log lines, no PutMetricData calls. */
export class PowertoolsMetrics implements MetricsSink {
  count(name: string, dims: Record<string, string> = {}) {
    if (Object.keys(dims).length === 0) {
      metrics.addMetric(name, MetricUnit.Count, 1);
      return;
    }
    const single = metrics.singleMetric();
    for (const [k, v] of Object.entries(dims)) single.addDimension(k, v);
    single.addMetric(name, MetricUnit.Count, 1);
  }
}

export class PowertoolsLog implements Log {
  info(msg: string, extra: Record<string, unknown> = {}) {
    logger.info(msg, extra);
  }
  warn(msg: string, extra: Record<string, unknown> = {}) {
    logger.warn(msg, extra);
  }
}
