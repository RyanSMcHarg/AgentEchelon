# Performance optimization (reducing latency)

AgentEchelon ships with **cost-lean defaults**, not latency-optimized ones. Out of the box every
request path is serverless and scales to zero: Lambdas are on-demand (no provisioned concurrency),
Aurora runs at a low minimum capacity, RDS Proxy is off, and the intent classifier is a live model
call. That reduces cost for idle and low-traffic deployments, but it means the first request after
a quiet period pays full cold-start cost, and the inbound path carries a model round-trip.

A production deployment with real, sustained traffic should trade some of that cost back for latency.
This doc lists the concrete levers, roughly in order of impact, with the AgentEchelon knob for each.
Measure before and after on the admin **Latency tab** (see [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md)
for what each metric means); the **Inbound** and **TTFF** numbers are where cold-start and classifier
cost show up.

## Where the latency goes

A turn's user-perceived wait (the **E2E** metric) breaks into two parts:

1. **Inbound** (user message to async-worker entry): the Amazon Chime SDK ingest, the Lex/router
   fulfillment Lambda, the intent-classification call, and the invoke of the async-worker Lambda. On
   an idle deployment this is dominated by **two VPC Lambda cold starts plus a model call**, so it can
   read several seconds. This is usually the single largest and most reducible chunk.
2. **Worker compute** (processor entry to answer posted): history load, the Converse tool loop, the
   guardrail, and posting the reply. Reduced mainly by model choice and retrieval efficiency.

The optimizations below target each in turn.

## 1. Eliminate Lambda cold starts (biggest inbound win)

On a low-traffic deployment the router and async-worker Lambdas scale to zero, so most invocations
cold-start, and both run in a VPC. The inbound path crosses **two** of them, so cold starts stack.

- **Provisioned concurrency** on the router and per-classification async-worker Lambdas keeps warm
  execution environments ready so invocations skip init entirely. This is the highest-impact change
  for a deployment with steady traffic. It is not enabled by default (it bills per provisioned
  environment-hour whether or not it is used); add it in the CDK on the router and worker functions
  and size it to your concurrent-turn volume.
- **Right-size Lambda memory.** More memory also means more CPU, which shortens both init and the
  tool loop. Under-provisioned memory is a common, invisible latency tax.
- **Use ARM/Graviton** for the Lambdas where the runtime and dependencies support it: lower cost per
  ms and generally faster cold init.
- **Shrink the deployment bundle.** Init time scales with how much code and how many SDK clients load
  before the handler runs. Import only the AWS SDK v3 clients each function needs, and keep heavy
  work out of module top-level so it does not run during init.
- **Keep functions warm.** If provisioned concurrency is more than you need, a low-frequency warmer
  (a scheduled ping) holds a single environment open, which is enough to remove the cold penalty from
  a demo or low-traffic instance.

VPC-attached Lambdas no longer pay the old multi-second ENI attachment penalty, but the runtime init
(module load plus first-call client setup) still counts, which is why bundle size and provisioned
concurrency matter.

## 2. Take the classifier off the inbound critical path

On the default path the router runs `classifyIntent()`, which for the default **LLM classifier** is a
**synchronous Bedrock call** in the inbound window, before the async worker is even invoked. That is
often a second or more added to every turn's Inbound and TTFF.

- **Use the keyword classifier** for classifications that do not need model-grade routing: set the
  profile's `classifierMode: 'keyword'`. This removes the model call from the inbound path entirely.
- **Cache classifications** for repeat or obvious intents so a warm path skips the model call.
- **Choose a fast, cheap model** for the classifier when you do keep it model-based; classification
  does not need the same model as the answer.

## 3. Database: RDS Proxy and Aurora capacity

The analytics and admin read paths query Aurora. Cold database connections and low capacity add
latency to those paths.

- **RDS Proxy** pools and reuses database connections, so a Lambda does not pay full connection
  setup on a cold or bursty invocation, and connection storms do not exhaust the cluster. It is
  **opt-in and off by default** (`enableRdsProxy`) because it carries a fixed monthly floor (it bills
  per vCPU of provisioned Aurora capacity, roughly tens of dollars a month even when idle). Turn it on
  for a production deployment with real query volume; leave it off for a cost-sensitive or demo one.
- **Raise the Aurora minimum capacity (ACU).** Serverless v2 scales down to a low floor by default,
  which is cheap but slow to absorb a sudden query burst. A higher minimum keeps capacity ready.
- **Reuse connections within a warm Lambda.** Hold the client across invocations (module scope) so a
  warm environment reuses an open connection rather than reconnecting per call.

## 4. Model inference (worker compute)

The Converse tool loop is usually the largest share of worker compute. It scales with the model and
the output.

- **Match the model to the classification.** A faster model on a lower tier cuts worker compute
  directly. The tiered model strategy already does this; review it against your latency targets.
- **Bedrock latency-optimized inference**, where available for your model and region, reduces
  per-call inference time.
- **Keep the region close** to Bedrock and to your users to cut network round-trip.
- **Trim retrieval.** A RAG-heavy turn shows up as **Tool** time, not model time. Return only the
  context the turn needs; oversized context reads slow the loop and inflate token cost.

## 5. Delivery and frontend

- The chat and admin frontends are already served through CloudFront. Keep cache behaviors sensible
  so static assets are edge-cached and only API calls reach the origin.
- The placeholder-then-update delivery pattern means **TTFF** (time to the placeholder), not the full
  answer, is the responsiveness a user feels. Optimizing inbound (sections 1 and 2) improves TTFF the
  most, because the placeholder is posted right after the async worker starts.

## Measuring impact

Every lever here is visible on the admin **Latency tab**:

- **Inbound** falls when you remove cold starts (section 1) and the classifier call (section 2).
- **TTFF** falls with Inbound, since the placeholder lands just after worker entry.
- **Worker compute** / **Model** / **Tool** fall with model and retrieval changes (section 4).
- **E2E** is the end-to-end result and the number a user-facing SLA should track.

See [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md) for the precise definition of each metric and the
target bands.

## A note on cost

None of this is free. Provisioned concurrency, RDS Proxy, a higher Aurora floor, and latency-optimized
inference all raise the baseline bill in exchange for lower latency. That is the deliberate trade the
defaults leave to the operator: AgentEchelon defaults to low cost, and a production deployment decides
how much of that to spend back on speed. Size each change to your actual traffic and targets rather
than enabling everything.
