# Infrastructure and cost model

**Audience:** deployers and operators sizing an AgentEchelon instance, and anyone reviewing what each piece of infrastructure is for and what it costs to run.

> **Estimates only - validate your own costs.** Every figure in this project's docs is a rough **estimate** at us-east-1 on-demand rates (a published unit price times a stated usage assumption, with a 730-hour month), provided for orientation, not budgeting. AWS pricing changes, and your actual cost depends on your region, traffic, retention, and the capacity floors you configure. **Do not rely on these numbers** - validate against the [AWS Pricing Calculator](https://calculator.aws) and your own bills before you commit to any spend. Where a line is highly usage-driven (Bedrock inference) or rate-uncertain (RDS Proxy floors), it is flagged as such rather than presented as precise.

Two deployment modes have different cost shapes:

- **Athena mode (default):** analytics is pay-per-query (Athena scans S3). There is no Aurora cluster, no RDS Proxy, no VPC interface endpoints. The always-on floor is the message pipeline (a 2-shard Kinesis stream and a KMS key) plus the WAF, roughly **$32 / month** at rest. Retrieval (RAG), live drift, and the conversation summary are **not available** in this mode. Athena mode is the lower-cost option, but testing is focused primarily on Aurora mode (see [Testing focus](AURORA-MODE-GUIDE.md#testing-focus)).
- **Aurora mode:** an Aurora Serverless v2 cluster (with pgvector) backs RAG, drift, the summary store, and evaluation. This adds the cluster's hourly floor (and VPC endpoints and the RDS Proxy when enabled) in exchange for the retrieval and drift capabilities. See [`AURORA-MODE-GUIDE.md`](AURORA-MODE-GUIDE.md) and [`SPEC-AURORA-VPC-MODE.md`](../../specs/foundations/SPEC-AURORA-VPC-MODE.md).

---

## Per-piece inventory

### Shared (both modes)

| Infra | What it is / how it is used | Rate basis | Est. monthly |
|---|---|---|---|
| **Lambda (agent handlers, async processors, APIs)** | The request path: the router/agent handler classifies and routes; the per-classification async processor runs the Bedrock Converse loop; the APIs: the credential exchanges and feedback behind the edge authorizer, which verifies a token from any issuer in the registry, and the admin routes, which are `AWS_IAM` (SigV4). Billed per request + GB-second. | $0.20 / M requests + $0.0000166667 / GB-s | **$5 to 40**, usage-driven |
| **DynamoDB (tasks, experiments, battle state, channel context)** | On-demand tables for agent tasks, A/B experiments, battle config/outcomes and the server-only channel context. Reached via a free gateway endpoint in Aurora mode. | $1.25 / M writes, $0.25 / M reads (on-demand) + $0.25 / GB-mo | **$1 to 10**, usage-driven |
| **S3 (attachments, context, SPA, archive)** | The attachments bucket holds classification context documents (`context/{classification}/`), user attachments and assistant deliverables (`generated-docs/`); the archive bucket holds the message archive and, in Aurora mode, the RAG corpus (`rag/`); a separate bucket holds the built frontend. | $0.023 / GB-mo Standard + request tiers | **$1 to 10** |
| **Kinesis Data Stream** | Ingests Amazon Chime SDK message events for archival + analytics. Provisioned at 2 shards in both modes, by the Messaging stack (`backend/lib/stacks/messaging-stack.ts`). | $0.015 / shard-hour + $0.014 / M PUT payload units | **~$22** floor (2 x $0.015 x 730), more with traffic |
| **KMS (archive CMK)** | Customer-managed key encrypting the archive plane, in both modes. | $1 / key-mo + $0.03 / 10k requests | **~$1 to 3** |
| **AWS WAF (CloudFront)** | Managed-rules Web ACL on the CloudFront distribution, **on by default** (`enableManagedWaf` in `frontend-distribution.ts`): three AWS managed rule groups (Common, Known-Bad-Inputs, Amazon IP Reputation) plus a per-IP rate limit, and a fifth rule when `wafAllowedIps` is set. The optional admin frontend stack gets its own Web ACL. | $5 / Web ACL-mo + $1 / rule-mo + $0.60 / M requests | **~$9** per Web ACL (4 rules), plus requests |
| **Cognito** | User pool, clearance groups, hosted sign-in. Free below 50k MAU on the standard tier. | Free tier, then per-MAU | **$0** at demo scale |
| **CloudFront + API Gateway** | SPA delivery + the HTTP APIs (`PersonApi`, `AdminApi`). | CloudFront $0.085/GB out; API GW $1.00 / M requests (HTTP API) | **$1 to 15**, usage-driven |
| **Amazon Chime SDK messaging** | The messaging backbone: channels, memberships, AppInstanceBots, channel flows. Billed per active user and per message. | Per-message + per-active-user | **usage-driven**; low at demo scale |
| **Bedrock model inference** | The dominant variable cost. Default model per classification: basic Haiku, standard Sonnet, premium Opus (see [`MODEL_STRATEGY.md`](../developer/MODEL_STRATEGY.md)). | Per M input/output tokens (confirm current Bedrock pricing) | **usage-driven** (see below) |

**Attachment lifecycle.** The attachments bucket's `DeleteOldAttachments` rule (`conversations-stack.ts`) expires objects after 90 days and carries no prefix filter, so it applies to every key in that bucket, including the seeded `context/` documents and `generated-docs/` deliverables, not only user uploads. **OPEN:** re-seeding resets the clock on `context/`; a deployment that does not re-seed loses its company context after 90 days. [Tenet D15](../../overview/TENETS.md) requires a lifecycle rule to be scoped to the prefix it is named for; this one is not.

**Bedrock inference, per-turn order of magnitude** (representative token sizes; confirm current per-model rates on the Bedrock pricing page, they change):

| Classification / model | Typical turn (in / out tokens) | Rough per-turn cost |
|---|---|---|
| basic / Haiku | ~2k / ~300 | ~$0.005 |
| standard / Sonnet | ~3k / ~400 | ~$0.02 |
| premium / Opus | ~4k / ~500 | ~$0.08 to 0.12 |

Standalone trivial turns (greeting, acknowledgment) are answered through the routes the seeds give them (Haiku) and skip retrieval, so they cost a fraction of the above. This is why the per-intent routes and the retrieval skip on trivial intents matter for cost, not just latency. A trivial-looking message that continues an open task is answered through the general route, on its classification's model, because the reply carries the task's work.

### Athena mode only

| Infra | What it is / how it is used | Rate basis | Est. monthly |
|---|---|---|---|
| **Kinesis Firehose (two streams)** | `MessageArchiveDelivery` batches stream records to the S3 archive; `ClientEventsDelivery` delivers client events (`archive-stack.ts`). | $0.029 / GB ingested (first 500 TB) | **< $5** at demo volume |
| **Athena** | Analytics queries over the S3 archive. | $5 / TB scanned | usage-driven |

### Aurora mode only (the RAG / drift / summary baseline)

| Infra | What it is / how it is used | Rate basis | Est. monthly |
|---|---|---|---|
| **Aurora Serverless v2 (PostgreSQL + pgvector)** | The vector store for RAG, the drift embedding thread, the conversation summary store, and the evaluation store. This is the core of Aurora mode. The stack sets a 0.5 ACU minimum and 4 ACU maximum (`serverlessV2MinCapacity` / `serverlessV2MaxCapacity` in `archive-stack-aurora.ts`, an operator change in CDK, not a context flag). | $0.12 / ACU-hour + $0.10 / GB-mo storage | **~$44** at the 0.5 ACU floor, more under load |
| **RDS Proxy (optional, off by default)** | Connection pooling + IAM database auth in front of Aurora. **Off by default** (opt in with `enableRdsProxy=true`): on Serverless v2 the proxy bills a fixed **8-ACU minimum** regardless of load, so on an idle cluster it costs more than the database it fronts. By default the analytics Lambdas connect directly to the cluster writer endpoint with IAM auth. Enable only for high Lambda-concurrency workloads that need pooling. | 8 ACU x $0.015 / ACU-hour (fixed floor) | **$0** (default) / **~$88** when enabled |
| **VPC interface endpoints (Bedrock, Secrets Manager, Kinesis)** | Private egress from the isolated subnets to those AWS services, so VPC-attached Lambdas reach them without a NAT gateway. Two ENIs each (one per AZ). **$0 when you import a VPC that already provides egress** (`createVpcEndpoints=false`); the stack creates them only for a new NAT-free VPC. | $0.01 / endpoint-AZ-hour + $0.01 / GB | **$0** (imported VPC) / **~$44** (stack-created, 3 services x 2 AZ) |
| **VPC gateway endpoints (S3, DynamoDB)** | Private egress to S3 and DynamoDB. Gateway endpoints are free. VPC-attached Lambdas read the classification registry from its S3 copy over the S3 endpoint, so the VPC needs no SSM endpoint. | Free | **$0** |
| **Analytics / drift / summary / ingestion Lambdas** | VPC-attached Lambdas doing embedding + Aurora reads/writes: document ingestion, evaluation, summary updater, abandonment, archival, and the retrieval data-plane (below). | $0.20 / M requests + GB-s | **$1 to 5**, usage-driven |
| **Titan Text Embeddings v2** | Embeds documents at ingestion and each retrieval/drift query (1024-dim). | $0.00002 / 1k tokens | **< $1**; negligible per query |

**Aurora-mode baseline at rest** (no traffic, capacity floors only, RDS Proxy off which is the default): roughly **$76 / month** when importing a VPC that provides egress (cluster ~$44, Kinesis ~$22, WAF ~$9, KMS ~$1), or **~$120 / month** on a stack-created NAT-free VPC (adding the ~$44 interface endpoints). Enabling the optional RDS Proxy adds **~$88 / month** (the 8-ACU floor), and sustained load raises the Aurora ACU line. Sleep mode (see [`SPEC-COST-SLEEP-MODE.md`](../../specs/foundations/SPEC-COST-SLEEP-MODE.md)) can reduce the idle cluster cost for non-production instances.

---

## The retrieval data-plane Lambda (Aurora mode)

RAG retrieval and live drift both need to reach Aurora (pgvector) and Bedrock (embeddings). The synchronous, Lex-facing agent handler is not VPC-attached (it also calls SSM, Cognito, and Lambda-invoke, none of which have endpoints in the isolated subnets, so attaching it there makes it hang). The **data-plane Lambda** owns the Aurora + Bedrock work: the async processor (also not VPC-attached) invokes it for retrieval and the conversation summary (`backend/lambda/src/lib/turn-grounding.ts`), and the agent handler invokes it for the live drift check (`backend/lambda/src/lib/live-drift-flow.ts`). A turn's calls go to its classification's own **turn data plane**, one per conversational classification: the same code, pinned to that classification, serving only a turn routed to it (the function `<prefix>Assistants-<classification>-TurnDataPlane`, built by `ClassificationArchiveFunctions` in `backend/lib/constructs/classification-archive-functions.ts` inside that classification's Assistants stack; the binding check is `backend/lambda/src/analytics-aurora/turn-data-plane-binding.ts`). The shared function serves the admin plane, client events and backfills. See the design in [`RAG.md`](../developer/RAG.md) and [ADR-013](../../design/decisions/013-drift-retrieval-vs-decision.md).

**Cost impact.** No new infrastructure.

| Item | Effect | Est. monthly |
|---|---|---|
| New endpoints required | None. The data-plane Lambda uses the **existing** Bedrock + Secrets Manager interface endpoints and the in-VPC Aurora writer endpoint (or proxy when enabled). | **$0** |
| Data-plane Lambda invocations | One synchronous invoke per non-trivial turn (retrieve, and drift when enabled). | **< $1**, usage-driven |
| One turn data plane per classification | Idle Lambdas cost nothing; each keeps its own warm containers, so a quiet classification pays its own cold starts. One DynamoDB read of the turn's routing record per call, through the existing gateway endpoint. | **$0** idle, usage-driven |
| Added latency | One warm Lambda-to-Lambda hop (~10 to 50 ms) per non-trivial turn. | n/a |

The alternative (adding SSM, Cognito, and Lambda interface endpoints so the handler itself could be VPC-attached) would add roughly **$44 / month** (3 services x 2 AZ) and put the Lex-facing handler on the VPC path. The data-plane split avoids both.

---

## Athena vs Aurora, cost summary

| | Athena mode (default) | Aurora mode |
|---|---|---|
| At-rest baseline | ~$32 / mo (Kinesis 2 shards ~$22, WAF ~$9, KMS ~$1) | ~$76 / mo (adds the cluster at 0.5 ACU); +$44 if the stack creates VPC endpoints; RDS Proxy off by default, +$88 if enabled |
| Analytics | Pay-per-query (Athena scans S3, $5 / TB) | Included in the Aurora hourly cost (SQL over the cluster) |
| RAG retrieval | Not available | Included (pgvector; ~$0 marginal per query) |
| Live drift + summary | Not available | Included |
| Best for | Low-traffic or cost-sensitive instances that do not need retrieval | Any instance whose assistants must answer from a non-trivial or growing document corpus |

The optional admin frontend stack adds a second WAF Web ACL (~$9 / mo) in either mode.

**Recommendation.** Deploy Aurora mode for production instances that rely on retrieval; the incremental cost of RAG, drift, and summary is small once the cluster is running, and retrieval is what keeps answers accurate and bounded as a corpus grows. For low-traffic or purely conversational instances, Athena mode avoids the cluster's hourly floor. Make the choice before the first deploy: switching an existing deployment between the modes is not supported, and changing modes means a teardown and a fresh, empty deployment (see [Switching modes](AURORA-MODE-GUIDE.md#switching-modes)). This mirrors the capability guidance in [`GUIDE-ASSISTANT-CONTEXT.md`](../developer/GUIDE-ASSISTANT-CONTEXT.md).

---

## Related

- [`AURORA-MODE-GUIDE.md`](AURORA-MODE-GUIDE.md) - deploying and operating Aurora mode.
- [`SPEC-AURORA-VPC-MODE.md`](../../specs/foundations/SPEC-AURORA-VPC-MODE.md) - the VPC, subnets, and endpoint model.
- [`SPEC-COST-SLEEP-MODE.md`](../../specs/foundations/SPEC-COST-SLEEP-MODE.md) - reducing idle cost on non-production instances.
- [`RAG.md`](../developer/RAG.md) - the retrieval path and the data-plane Lambda.
- [`ARCHITECTURE.md`](../../overview/ARCHITECTURE.md) - the full component map.
- [`MODEL_STRATEGY.md`](../developer/MODEL_STRATEGY.md) - per-classification model selection (the main variable cost).
