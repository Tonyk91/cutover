/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Legacy export (CSV) ──► S3 exports/ ──► ingest λ ──► SQS ──► engine λ ──► DynamoDB
 *                                          │                │ (shadow: compute both,
 *                                          ▼                │  publish one per store)
 *                                    S3 rejects/            ├─► DLQ after 3 tries
 *                                                           └─► EMF metrics ──► alarm on UNEXPLAINED
 */
export default $config({
  app(input) {
    return {
      name: "cutover",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      providers: { aws: { region: "eu-north-1" } },
    };
  },
  async run() {
    const stage = $app.stage;
    const tags = { app: "cutover", stage, costCenter: "price-integration" };

    const prices = new sst.aws.Dynamo("Prices", {
      fields: { pk: "string", sk: "string" },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      ttl: "ttl",
    });

    const dlq = new sst.aws.Queue("PriceDlq");
    const queue = new sst.aws.Queue("PriceQueue", {
      dlq: { queue: dlq.arn, retry: 3 },
      visibilityTimeout: "60 seconds",
    });

    queue.subscribe(
      {
        handler: "src/handlers/engine.handler",
        runtime: "nodejs22.x",
        architecture: "arm64",
        memory: "256 MB",
        timeout: "30 seconds",
        logging: { retention: "1 month" },
        // Explicit permissions instead of `link`: link grants dynamodb:* on the table.
        // The engine only ever needs one action. (SST adds the SQS receive/delete
        // permissions for the subscription itself.)
        permissions: [{ actions: ["dynamodb:PutItem"], resources: [prices.arn] }],
        environment: {
          TABLE_NAME: prices.name,
          // The rollout is a config value. Move it 0 → 10 → 50 → 100 only when
          // `npm run simulate` / the dashboard gate says ADVANCE.
          ROLLOUT_PCT: process.env.ROLLOUT_PCT ?? "0",
          NORTH_FREIGHT_PCT: "2",
          POWERTOOLS_LOG_LEVEL: "INFO",
        },
      },
      { batch: { size: 10, window: "5 seconds", partialResponses: true } },
    );

    const incoming = new sst.aws.Bucket("Incoming");
    incoming.notify({
      notifications: [
        {
          name: "Ingest",
          function: {
            handler: "src/handlers/ingest.handler",
            runtime: "nodejs22.x",
            architecture: "arm64",
            memory: "512 MB",
            timeout: "5 minutes",
            logging: { retention: "1 month" },
            // Read only exports/, write only rejects/, send only to this queue.
            permissions: [
              { actions: ["s3:GetObject"], resources: [$interpolate`${incoming.arn}/exports/*`] },
              { actions: ["s3:PutObject"], resources: [$interpolate`${incoming.arn}/rejects/*`] },
              { actions: ["sqs:SendMessage"], resources: [queue.arn] },
            ],
            environment: { QUEUE_URL: queue.url },
          },
          events: ["s3:ObjectCreated:*"],
          filterPrefix: "exports/",
        },
      ],
    });

    // One unexplained diff in production is a pricing rule nobody wrote down.
    const alerts = new sst.aws.SnsTopic("ParityAlerts");
    new aws.cloudwatch.MetricAlarm("UnexplainedDiffs", {
      namespace: "Cutover",
      metricName: "Parity",
      dimensions: { service: "cutover", class: "UNEXPLAINED" },
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: [alerts.arn],
      tags,
    });

    new aws.cloudwatch.MetricAlarm("DlqNotEmpty", {
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: { QueueName: dlq.nodes.queue.name },
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      alarmActions: [alerts.arn],
      tags,
    });

    return { bucket: incoming.name, queue: queue.url, table: prices.name };
  },
});
