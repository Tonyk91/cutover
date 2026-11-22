/**
 * What one million price changes cost on this architecture.
 *
 * Prices are AWS on-demand list prices as published for us-east-1
 * (Lambda arm64, SQS standard, DynamoDB on-demand after the Nov 2024 cut).
 * eu-north-1 is within a few percent of these; check the pricing pages before
 * quoting a number to anyone. Free tier is ignored on purpose: it hides the
 * shape of the bill.
 */
export const PRICES_USD = {
  lambdaGbSecondArm: 0.0000133334,
  lambdaRequest: 0.2 / 1e6,
  sqsRequest: 0.4 / 1e6,
  dynamoWriteRequestUnit: 0.625 / 1e6,
  cloudwatchLogsIngestGb: 0.5,
  cloudwatchCustomMetricMonth: 0.3,
} as const;

export interface CostAssumptions {
  changes: number;
  batchSize: number;
  engineMemoryMb: number;
  /** Fixed cost of one engine invocation (init amortised, SDK setup, metric flush). */
  invocationOverheadMs: number;
  /** Per change: one DynamoDB write round trip. */
  perChangeMs: number;
  /**
   * How a change is written. "conditional-put": one item, 1 WRU.
   * "transaction": marker item + price item in TransactWriteItems, 2 items × 2 WRU.
   */
  write: "conditional-put" | "transaction";
  /** Bytes of log per invocation (EMF metric lines + one info line). */
  logBytesPerInvocation: number;
}

export const DEFAULTS: CostAssumptions = {
  changes: 1_000_000,
  batchSize: 10,
  engineMemoryMb: 256,
  invocationOverheadMs: 40,
  perChangeMs: 9,
  write: "conditional-put",
  logBytesPerInvocation: 1500,
};

export interface CostLine {
  item: string;
  usd: number;
  note: string;
}

export function estimate(a: CostAssumptions = DEFAULTS): { lines: CostLine[]; total: number } {
  const p = PRICES_USD;
  const invocations = Math.ceil(a.changes / a.batchSize);
  const durationS = (a.invocationOverheadMs + a.perChangeMs * a.batchSize) / 1000;
  const gbS = invocations * durationS * (a.engineMemoryMb / 1024);

  // Send in batches of 10 from ingest; Lambda receives and deletes one batch per invocation.
  const sqsRequests = Math.ceil(a.changes / 10) + invocations * 2;

  // Items ≤ 1 KB. Transactional writes cost 2 WRU per item instead of 1.
  const wru = a.changes * (a.write === "transaction" ? 4 : 1);

  const logGb = (invocations * a.logBytesPerInvocation) / 1024 ** 3;

  const lines: CostLine[] = [
    { item: "Lambda compute", usd: gbS * p.lambdaGbSecondArm, note: `${invocations.toLocaleString("en")} invocations × ${(durationS * 1000).toFixed(0)} ms @ ${a.engineMemoryMb} MB arm64` },
    { item: "Lambda requests", usd: invocations * p.lambdaRequest, note: `batch size ${a.batchSize}` },
    { item: "SQS requests", usd: sqsRequests * p.sqsRequest, note: `${sqsRequests.toLocaleString("en")} send/receive/delete` },
    { item: "DynamoDB writes", usd: wru * p.dynamoWriteRequestUnit, note: `${wru.toLocaleString("en")} WRU (${a.write})` },
    { item: "CloudWatch Logs", usd: logGb * p.cloudwatchLogsIngestGb, note: `${(logGb * 1024).toFixed(1)} MB ingested` },
  ];
  return { lines, total: lines.reduce((s, l) => s + l.usd, 0) };
}
