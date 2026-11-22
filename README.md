# cutover

**Replacing a legacy price system with serverless, without the stores noticing.**

[![ci](https://github.com/Tonyk91/cutover/actions/workflows/ci.yml/badge.svg)](https://github.com/Tonyk91/cutover/actions/workflows/ci.yml)
TypeScript · SST · Lambda · SQS + DLQ · DynamoDB · S3 · CloudWatch (EMF) · Powertools for TypeScript

Building a price integration on Lambda is the easy part. The hard part of moving off a large
standard system is the question nobody can answer up front:

> *How do we know the new system prices exactly like the old one, and where it doesn't, who decided that's correct?*

This repo answers it with **shadow mode**. Every price change from the legacy export runs through
the new engine as well. Both answers are compared to the öre. Every difference has to be
explained by a named hypothesis, or it blocks the rollout. Stores move to the new engine in
stages (0 → 10 → 50 → 100 %), and a gate decides each step.

```
legacy export (CSV) ─► S3 exports/ ─► ingest λ ─► SQS ─► engine λ ─► DynamoDB (price history)
                                       │                  │
                                       ▼                  ├─ new price AND legacy price, compared
                                  S3 rejects/             ├─ publish one of them, per store, by rollout %
                                  (line + reason)         ├─ DLQ after 3 tries
                                                          └─ EMF metrics ─► alarm on UNEXPLAINED > 0
```

## What the replay found

`npm run simulate` replays 20 000 price changes from the four weeks around the food-VAT cut on
**2026-04-01** (12 % → 6 %) across 60 stores. Seeded, so every run and every CI job sees the same rows.

**Pass 1: the new engine with only the documented rules.**

| Class | Rows | Share |
|---|---:|---:|
| MATCH | 14 945 | 74.7 % |
| LEGACY_FLOAT_ROUNDING | 22 | 0.1 % |
| LEGACY_VAT_EXPORT_DATE | 1 646 | 8.2 % |
| **UNEXPLAINED** | **3 387** | **16.9 %** |

**Gate 0 → 10 %: BLOCKED.** Every unexplained row is in one of the 10 stores whose id starts with
`N`, and the new price is always about 2 % lower. That is a rule: the legacy system adds a freight
surcharge for northern stores, and nobody had written it down.

**Pass 2: the rule is written down** (`northFreightPct: 2`, an explicit, named, tested rule):
0 unexplained, gate **ADVANCE**. At 10 %, 8.7 % of changes are published by the new engine and the
rest still by legacy.

The two accepted classes are the interesting part, because in both **the new engine is right and legacy is wrong**:

- **LEGACY_VAT_EXPORT_DATE**: legacy picks the VAT rate by the date a row was *exported*, not
  the date it takes *effect*. A price exported on 28 March that takes effect on 2 April gets
  12 % VAT when it should get 6 %. Around the VAT cut that is 1 in 10 changes.
- **LEGACY_FLOAT_ROUNDING**: legacy rounds a binary float, so a price at exactly x.x5 kr
  sometimes rounds down. The new engine uses exact integer arithmetic (BigInt, one rounding step).

**Forecast:** the same replay for December 2027 shows the export-date bug comes back on
**2028-01-01**, when food VAT returns to 12 %. In this model 13.9 % of the changes exported in
the last two weeks of 2027 would carry the wrong VAT. The best time to cut over is before that date.

> **The data is synthetic and the legacy system is a model.** The quirks above are the kind a
> real migration finds; they are not claims about any real company's systems. The point is the
> mechanism: a difference only counts as explained when a hypothesis reproduces the legacy price
> **exactly, to the öre**. Close is not explained.

## Design decisions

**One unexplained diff blocks.** The gate has no "99.5 % match is fine" threshold. A stable
pattern of unexplained diffs is almost always an undocumented business rule (as pass 1 shows),
and a threshold would let it through silently.

**Accepted differences are a decision, not a tolerance.** `HYPOTHESES` in
[`src/core/parity.ts`](src/core/parity.ts) lists each known reason with `accepted: true|false`
and a one-line why. In a real cutover, the price owner in the business signs off on that list,
because stores in the new cohort will see the corrected price.

**Cutover by store, stable hashing.** FNV-1a buckets each store into 0–99. The 10 % cohort is a
subset of the 50 % cohort, so no store flips back. `ROLLOUT_PCT` is a config value, not a deploy.

**Idempotency without a transaction.** SQS standard delivers at least once (the replay re-sends 2 %
of messages; none are stored twice). The price item's key is `PRICE#store#sku` /
`effectiveFrom#eventId`, so one conditional put is both the write and the duplicate check. The
first version used `TransactWriteItems` with a separate marker item. Same guarantee, 4× the
write cost (see below).

**Never "claim, then write".** If a function marks an event as processed and then dies before
writing the price, the retry skips it and the change is lost without a trace. The write and the
check are one operation ([`src/core/ports.ts`](src/core/ports.ts)).

**Late messages cannot overwrite newer prices.** History is kept per effective date (sort key),
so an older change that arrives late is stored as history instead of replacing the current price.

**One bad row does not stop the file.** Invalid rows go to `rejects/<file>.json` with a line
number and a reason, so the file's owner can fix them without reading our logs. The other
40 000 price changes still reach the stores.

**Partial batch responses.** One failing message is retried alone and lands in the DLQ after
3 attempts, without re-running the other nine in its batch. A DLQ that is not empty is an alarm.

## Observability

- **Metrics via Embedded Metric Format** (Powertools for TypeScript): `Parity{class}`,
  `Published{source}`, `DuplicateEvent`, `RowsAccepted`, `RowsRejected`. They are written as
  log lines, so there are no `PutMetricData` calls and no extra API cost per metric.
- **Alarms:** `Parity{class=UNEXPLAINED} > 0` in 5 minutes, and DLQ not empty → SNS.
- **Every unexplained row is logged at WARN with its full input.** That log is the input to the
  next rule fix: pass 1's sample rows were enough to see the `N` pattern.

## FinOps: what 1 000 000 price changes cost

From [`src/finops/cost.ts`](src/finops/cost.ts), USD, on-demand list prices, free tier ignored on
purpose (it hides the shape of the bill). Assumptions are parameters in the file.

| Item | **Chosen:** batch 10, conditional put | Batch 1 | Transaction + marker item |
|---|---:|---:|---:|
| Lambda compute | 0.04 | 0.16 | 0.04 |
| Lambda requests | 0.02 | 0.20 | 0.02 |
| SQS requests | 0.12 | 0.84 | 0.12 |
| DynamoDB writes | 0.63 | 0.63 | 2.50 |
| CloudWatch Logs | 0.07 | 0.70 | 0.07 |
| **Total** | **0.88** | **2.53** | **2.75** |

Two decisions account for almost all of it: batching the queue (2.9× cheaper than one message per
invocation) and dropping the transaction (3.1× cheaper). At these volumes the bill is small
either way. The habit that matters is pricing each design choice before it ships, because the same
choices decide the bill at 100× the volume. Every resource is tagged `costCenter=price-integration`
for cost allocation.

## Run it

```bash
npm ci
npm run check        # typecheck + 21 tests + replay with asserted gate decisions
npm run simulate     # print the report, write reports/replay.md
```

Deploy (needs AWS credentials; region eu-north-1):

```bash
npm run deploy                       # sst deploy --stage dev
ROLLOUT_PCT=10 npm run deploy        # move the cohort, only after the gate says ADVANCE
```

CI runs in GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) and the same
pipeline is in [`bitbucket-pipelines.yml`](bitbucket-pipelines.yml), with a manual, OIDC-based
deploy step: no long-lived AWS keys in the pipeline.

## What's tested and what isn't

- **Tested (21 tests + the replay gate in CI):** VAT boundaries on both dates, exact half-up
  rounding against the float formula, campaign before rounding, the freight rule only on `N`
  stores, every parity class, "close is not explained", stable cohorts, the gate (one unexplained
  diff, small samples, 100 %), idempotency on redelivery, CSV rejects with line numbers, and the
  cost model.
- **Not yet verified by a deploy:** `sst.config.ts` is written against the SST v3/v4 component
  docs (Queue with DLQ + partial responses, Bucket notifications, Dynamo with TTL), but SST's
  global types only resolve after a first `sst deploy`, so it is not typechecked in CI. The
  Lambda handlers are thin adapters around the tested core and are typechecked against the
  AWS SDK v3 and Powertools types.
- **Not modelled:** reading the current price for a store (a query on `PRICE#store#sku`, latest
  sort key with `effectiveFrom <= today`), multi-buy campaigns, and comparison prices (jämförpris).

## Layout

```
src/core/        pricing, VAT, parity, rollout, CSV: pure TypeScript, no AWS
src/adapters/    DynamoDB + Powertools (aws.ts), in-memory (memory.ts) for tests and the replay
src/handlers/    ingest (S3 → SQS) and engine (SQS → DynamoDB) Lambdas
src/sim/         seeded replay data + the legacy model
src/finops/      the cost model
scripts/         simulate.ts (replay + gate), the CI entry point
sst.config.ts    infrastructure
```

MIT licensed.
