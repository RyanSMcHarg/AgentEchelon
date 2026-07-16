# Infrastructure and cost model

**Audience:** deployers and operators sizing an AgentEchelon instance, and anyone reviewing what each
piece of infrastructure is for and what it costs to run.

**How to read the numbers.** Every figure below is an **estimate** at us-east-1 on-demand rates, expressed
as a rate basis (the published unit price) times a stated usage assumption. Actual cost depends on traffic,
retention, and the capacity floors you configure. Validate against the [AWS Pricing Calculator](https://calculator.aws)
for your region and volume before budgeting. Where a line is highly usage-driven (Bedrock inference) or
rate-uncertain (RDS Proxy floors), it is flagged as such rather than presented as precise.

Two deployment modes have very different cost shapes:

- **Athena mode (default):** almost nothing runs at rest. Analytics is pay-per-query (Athena scans S3). There
  is no Aurora cluster, no RDS Proxy, no VPC interface endpoints. Retrieval (RAG), live drift, and the
  conversation summary are **not available** in this mode.
- **Aurora mode:** an Aurora Serverless v2 cluster (with pgvector) backs RAG, drift, the summary store, and
  evaluation. This adds an hourly baseline (cluster, proxy, endpoints) in exchange for the retrieval and
  drift capabilities. See [`AURORA-MODE-GUIDE.md`](AURORA-MODE-GUIDE.md) and
  [`SPEC-AURORA-VPC-MODE.md`](../../specs/analytics-eval/SPEC-AURORA-VPC-MODE.md).

---

## Per-piece inventory

### Shared (both modes)

| Infra | What it is / how it is used | Rate basis | Est. monthly |
|---|---|---|---|
| **Lambda (agent handlers, async processors, APIs)** | The request path: router/agent handler classifies + routes; per-tier async processor runs the Bedrock Converse loop; Cognito-auth APIs (credential exchange, feedback, admin). Billed per request + GB-second. | $0.20 / M requests + $0.0000166667 / GB-s | **$5 to 40**, usage-driven |
| **DynamoDB (tasks, experiments, battle state)** | On-demand tables for agent tasks, A/B experiments, battle config/outcomes. Reached via a free gateway endpoint in Aurora mode. | $1.25 / M writes, $0.25 / M reads (on-demand) + $0.25 / GB-mo | **$1 to 10**, usage-driven |
| **S3 (attachments, context, SPA, archive)** | Tier context documents (`context/{tier}/`), the RAG corpus (`rag/`), user attachments, the built frontend, and the message archive. | $0.023 / GB-mo Standard + request tiers | **$1 to 10** |
| **Cognito** | User pool, tier groups, hosted sign-in. Free below 50k MAU on the standard tier. | Free tier, then per-MAU | **$0** at demo scale |
| **CloudFront + API Gateway** | SPA delivery + REST APIs (credential exchange, admin, analytics query). | CloudFront $0.085/GB out; API GW $1.00 / M requests (REST) | **$1 to 15**, usage-driven |
| **Chime SDK messaging** | The messaging backbone: channels, memberships, app-instance bots, channel flows. Billed per active user and per message. | Per-message + per-active-user | **usage-driven**; low at demo scale |
| **Bedrock model inference** | The dominant variable cost. Per-tier models: basic Haiku, standard Sonnet, premium Opus (see [`MODEL_STRATEGY.md`](../developer/MODEL_STRATEGY.md)). | Per M input/output tokens (confirm current Bedrock pricing) | **usage-driven** (see below) |

**Bedrock inference, per-turn order of magnitude** (representative token sizes; confirm current per-model
rates on the Bedrock pricing page, they change):

| Tier / model | Typical turn (in / out tokens) | Rough per-turn cost |
|---|---|---|
| basic / Haiku | ~2k / ~300 | ~$0.005 |
| standard / Sonnet | ~3k / ~400 | ~$0.02 |
| premium / Opus | ~4k / ~500 | ~$0.08 to 0.12 |

Trivial turns (greeting, acknowledgment) route to Haiku and skip retrieval, so they cost a fraction of the
above. This is why the tier-floor routing and the retrieval skip on trivial intents matter for cost, not just
latency.

### Aurora mode only (the RAG / drift / summary baseline)

| Infra | What it is / how it is used | Rate basis | Est. monthly |
|---|---|---|---|
| **Aurora Serverless v2 (PostgreSQL + pgvector)** | The vector store for RAG, the drift embedding thread, the conversation summary store, and the evaluation store. This is the core of Aurora mode. Cost scales with the min/max ACU you configure and actual load. | $0.12 / ACU-hour + $0.10 / GB-mo storage | **$44** at 0.5 ACU floor, **$88** at 1 ACU floor, more under load |
| **RDS Proxy (optional, off by default)** | Connection pooling + IAM database auth in front of Aurora. **Off by default** (opt in with `enableRdsProxy=true`): on Serverless v2 the proxy bills a fixed **8-ACU minimum** regardless of load, so on an idle cluster it costs more than the database it fronts. By default the analytics Lambdas connect directly to the cluster writer endpoint with IAM auth. Enable only for high Lambda-concurrency workloads that need pooling. | 8 ACU x $0.015 / ACU-hour (fixed floor) | **$0** (default) / **~$86** when enabled |
| **VPC interface endpoints (Bedrock, Secrets Manager, Kinesis)** | Private egress from the isolated subnets to those AWS services, so VPC-attached Lambdas reach them without a NAT gateway. Two ENIs each (one per AZ). **$0 when you import a VPC that already provides egress** (`createVpcEndpoints=false`); the stack creates them only for a new NAT-free VPC. | $0.01 / endpoint-AZ-hour + $0.01 / GB | **$0** (imported VPC) / **~$44** (stack-created, 3 services x 2 AZ) |
| **VPC gateway endpoints (S3, DynamoDB)** | Private egress to S3 and DynamoDB. Gateway endpoints are free. | Free | **$0** |
| **Kinesis Data Stream** | Ingests Chime message events for archival + analytics. | 1 shard $0.015/hr, or on-demand $0.04/hr + payload units | **$11 to 30** |
| **Kinesis Firehose** | Batches stream records to the S3 archive. | $0.029 / GB ingested (first 500 TB) | **< $5** at demo volume |
| **KMS (archive CMK)** | Customer-managed key encrypting the message archive. | $1 / key-mo + $0.03 / 10k requests | **~$1 to 3** |
| **Analytics / drift / summary / ingestion Lambdas** | VPC-attached Lambdas doing embedding + Aurora reads/writes: document ingestion, evaluation, summary updater, abandonment, archival, and the retrieval data-plane (below). | $0.20 / M requests + GB-s | **$1 to 5**, usage-driven |
| **Titan Text Embeddings v2** | Embeds documents at ingestion and each retrieval/drift query (1024-dim). | $0.00002 / 1k tokens | **< $1**; negligible per query |

**Aurora-mode baseline at rest** (no traffic, capacity floors only, RDS Proxy off which is the default):
roughly **$50 / month** when importing a VPC that provides egress (no interface endpoints), or **~$95 /
month** on a stack-created NAT-free VPC (with the ~$44 interface endpoints). Both are dominated by the
Aurora cluster at its ACU floor. Two things raise it: enabling the optional RDS Proxy adds **~$86 / month**
(the 8-ACU floor), and sustained load raises the Aurora ACU line. Sleep mode (see
[`SPEC-COST-SLEEP-MODE.md`](../../specs/analytics-eval/SPEC-COST-SLEEP-MODE.md)) can reduce the idle cluster
cost for non-production instances.

---

## The retrieval data-plane Lambda (Aurora mode)

RAG retrieval and live drift both need to reach Aurora (pgvector) and Bedrock (embeddings). Rather than
VPC-attaching the synchronous, Lex-facing agent handler (which also calls SSM, Cognito, and Lambda-invoke,
none of which have endpoints in the isolated subnets, so attaching it there makes it hang), a single
**data-plane Lambda** owns the Aurora + Bedrock work and the agent handler invokes it. See the design in
[`RAG.md`](../developer/RAG.md) and the decision record (project decision 018).

**Cost impact: effectively zero new infrastructure.**

| Item | Effect | Est. monthly |
|---|---|---|
| New endpoints required | None. The data-plane Lambda uses the **existing** Bedrock + Secrets Manager interface endpoints and the in-VPC Aurora proxy. | **$0** |
| Data-plane Lambda invocations | One synchronous invoke per non-trivial turn (retrieve, and drift when enabled). | **< $1**, usage-driven |
| Added latency | One warm Lambda-to-Lambda hop (~10 to 50 ms) per non-trivial turn. | n/a |

The alternative (adding SSM, Cognito, and Lambda interface endpoints so the handler itself could be
VPC-attached) would have added roughly **$44 / month** (3 services x 2 AZ) and kept the Lex-facing handler on
the VPC path. The data-plane split avoids both.

---

## Athena vs Aurora, cost summary

| | Athena mode (default) | Aurora mode |
|---|---|---|
| At-rest baseline | ~$0 (no cluster/proxy/endpoints) | ~$50 to 95 / mo (cluster + Lambda; +$44 if the stack creates VPC endpoints; RDS Proxy off by default, +$86 if enabled) |
| Analytics | Pay-per-query (Athena scans S3, $5 / TB) | Included in the Aurora hourly cost (SQL over the cluster) |
| RAG retrieval | Not available | Included (pgvector; ~$0 marginal per query) |
| Live drift + summary | Not available | Included |
| Best for | Low-traffic or cost-sensitive instances that do not need retrieval | Any instance whose assistants must answer from a non-trivial or growing document corpus |

**Recommendation.** Deploy Aurora mode for production instances that rely on retrieval; the incremental cost of
RAG, drift, and summary is small once the cluster is running, and retrieval is what keeps answers accurate and
bounded as a corpus grows. For low-traffic or purely conversational instances, Athena mode avoids the hourly
baseline. This mirrors the capability guidance in [`GUIDE-ASSISTANT-CONTEXT.md`](../developer/GUIDE-ASSISTANT-CONTEXT.md).

---

## Related

- [`AURORA-MODE-GUIDE.md`](AURORA-MODE-GUIDE.md) - deploying and operating Aurora mode.
- [`SPEC-AURORA-VPC-MODE.md`](../../specs/analytics-eval/SPEC-AURORA-VPC-MODE.md) - the VPC, subnets, and endpoint model.
- [`SPEC-COST-SLEEP-MODE.md`](../../specs/analytics-eval/SPEC-COST-SLEEP-MODE.md) - reducing idle cost on non-production instances.
- [`RAG.md`](../developer/RAG.md) - the retrieval path and the data-plane Lambda.
- [`ARCHITECTURE.md`](../../overview/ARCHITECTURE.md) - the full component map.
- [`MODEL_STRATEGY.md`](../developer/MODEL_STRATEGY.md) - per-tier model selection (the main variable cost).
