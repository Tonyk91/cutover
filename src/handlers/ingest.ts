import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { S3Event } from "aws-lambda";
import { Resource } from "sst";
import { logger, metrics } from "../adapters/aws.js";
import { MetricUnit } from "@aws-lambda-powertools/metrics";
import { parseExport } from "../core/csv.js";

const s3 = new S3Client({});
const sqs = new SQSClient({});

/**
 * Triggered when the legacy system drops an export in s3://<bucket>/exports/.
 * Valid rows go to the queue in batches of 10 (the SQS maximum, and 10× fewer
 * requests than one-by-one). Invalid rows go to rejects/ with line number and
 * reason, so the file owner can fix them without reading our logs.
 */
export async function handler(event: S3Event): Promise<void> {
  for (const rec of event.Records) {
    const bucket = rec.s3.bucket.name;
    const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, " "));

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const { ok, rejected } = parseExport(await obj.Body!.transformToString("utf-8"));

    for (let i = 0; i < ok.length; i += 10) {
      const chunk = ok.slice(i, i + 10);
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: Resource.PriceQueue.url,
          Entries: chunk.map((c, j) => ({ Id: String(j), MessageBody: JSON.stringify(c) })),
        }),
      );
      if (res.Failed?.length) {
        // Fail the invocation: S3 retries it, and idempotency makes the replay safe.
        throw new Error(`SQS rejected ${res.Failed.length} messages from ${key}`);
      }
    }

    if (rejected.length) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key.replace(/^exports\//, "rejects/") + ".json",
          Body: JSON.stringify(rejected, null, 2),
          ContentType: "application/json",
        }),
      );
    }

    metrics.addMetric("RowsAccepted", MetricUnit.Count, ok.length);
    metrics.addMetric("RowsRejected", MetricUnit.Count, rejected.length);
    logger.info("export ingested", { key, accepted: ok.length, rejected: rejected.length });
  }
  metrics.publishStoredMetrics();
}
