# Aurora Mode Guide

AgentEchelon ships with two analytics backends. **Athena mode** (default) is serverless and cheap at low volume. **Aurora mode** adds a VPC with Aurora PostgreSQL Serverless v2 for sub-second dashboard queries, multi-turn evaluation, drift detection, and cross-conversation context search.

This guide covers when to switch, how to deploy, and what to expect.

---

## When to use Aurora mode

> **Athena/S3 is the system of record; Aurora is a fast projection of it.** Both modes write the same append-only S3 conversation archive (the Kinesis stream fans out to S3 in either mode), and that archive is the **complete, durable Amazon Chime SDK Messaging event stream** partitioned by classification. Aurora mode adds a Postgres/pgvector copy for sub-second queries and features Athena cannot serve (evaluation, drift, cross-conversation search), but that copy is a **lossy real-time projection** (it collapses membership to current state and drops some events). Switching modes does not change what is retained; it changes what is queryable and how fast. So "not available in Athena" below means *the query path or derived table is not built for Athena mode*, never that the underlying events are missing from the archive.

| Consideration | Athena (default) | Aurora |
|---------------|-----------------|--------|
| Conversation / event archive (system of record) | **Yes** - S3, always on, the durable source | Same S3 archive **plus** a Postgres projection |
| Raw event log ("Show all events") | Data is in the S3 archive (system of record); the analytics API's `channel_events` query is **not yet wired** for Athena mode, so the console view is Aurora-only today (a handler gap, not a data gap) | Served (`channel_events` -> `adminListEvents`) |
| Membership / moderation history | Queried straight from the S3 archive (`admin-conversations.ts`) | Queried from Aurora (fast) + the `moderation_actions` attribution table (Aurora-only) |
| User activity / signup + signin funnels | Available (Athena queries the archive + `client_events`) | Available (fast) |
| Dashboard query latency | Seconds (pay-per-query) | Sub-second (persistent DB) |
| Multi-turn evaluation scoring | Basic (flat Athena queries) | Full two-pass screening with pgvector |
| Drift detection | Not available (needs pgvector) | pgvector cosine similarity over Titan v2 embeddings |
| Cross-conversation context | Not available (needs pgvector) | Per-user context search (keyword + pgvector) |
| Materialized views | Not available | Pre-computed daily metrics |
| Monthly cost (baseline, rough estimate) | ~$30-50 (Kinesis-dominated) | ~$50-95 (proxy off by default; see INFRASTRUCTURE-COST.md) |
| VPC required | No | Yes (auto-provisioned) |
| Schema migrations | None | Automated via custom resource |

**Use Athena** when cost matters more than query speed and you don't need evaluation, drift detection, or cross-conversation features. You still have the full, durable event archive - it is the system of record in both modes.

**Use Aurora** when you need real-time admin dashboards, automated evaluation pipelines, drift detection, or cross-conversation context.

> **A14 note (IAM enforcement).** Under `-c adminIamEnforcement=true`, Aurora mode splits the analytics API into per-capability resources (so a persona role can be denied, say, `view-user-activity` at the gateway). Athena mode's analytics API is a single `POST /query`, so it enforces at the coarse analytics-read level - a stack gap, not a data one. See `SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md`.

---

## Architecture

Aurora mode provisions:

- **VPC** with 2 AZs, `PRIVATE_ISOLATED` subnets, 0 NAT gateways
- **VPC Endpoints**: Kinesis (interface), S3 (gateway), Secrets Manager (interface), Bedrock Runtime (interface)
- **Aurora PostgreSQL Serverless v2**: 0.5-4 ACU, IAM auth, encrypted at rest, Performance Insights
- **RDS Proxy** (opt-in, OFF by default): connection pooling + IAM auth in front of Aurora, enabled with `enableRdsProxy=true`. Off by default because on Serverless v2 it bills a fixed ~8-ACU floor (~$86/month) regardless of load; the default path is direct writer-endpoint IAM auth (see Connection pooling below)
- **Schema Init**: Custom resource Lambda runs SQL migrations on deploy
- **IAM Auth Setup**: Custom resource grants `rds_iam` role to DB user
- **Kinesis Stream**: 2 shards, 24h retention (same as Athena mode)
- **Archival Lambda**: VPC-attached, consumes Kinesis, writes to Aurora + S3
- **Evaluation Runner**: VPC-attached, daily 2am UTC schedule, uses Haiku/Sonnet via Bedrock
- **Analytics Query Lambda + API Gateway**: VPC-attached, serves admin dashboard queries
- **Retrieval Data-Plane Lambda**: VPC-attached, runs RAG retrieval + drift detection (embed + pgvector) so the non-VPC agent handler can invoke it (project decision 018)
- **S3 Archive Bucket**: Backwards-compatible with Athena mode (90-day lifecycle)

By default the Lambdas connect DIRECTLY to the Aurora writer endpoint using IAM database authentication (no hardcoded passwords). RDS Proxy is opt-in (`enableRdsProxy`, off by default); when enabled, the Lambdas connect through the proxy instead. See Connection pooling below.

---

## Deploying

### Prerequisites

1. AWS credentials configured with admin access
2. Bedrock model access enabled (Haiku + Sonnet in us-east-1)
3. CDK bootstrapped in target account/region

### Deploy command

```bash
cd backend && npx cdk deploy --all \
  --context analyticsMode=aurora \
  --context senderEmail=you@yourdomain.com \
  --context appUrl=https://your-frontend-url
```

This deploys ~14 stacks in Aurora mode with `/battle` default-on (the base feature stacks + `AgentEchelonBattle` + `AgentEchelonAnalyticsAurora` instead of `AgentEchelonAnalytics`).

### First deploy

On first deploy, the stack automatically:

1. Creates the VPC and Aurora cluster
2. Runs every schema migration in `schema/` in order (currently `001-initial` through `012-moderation-actions`)
3. Sets up IAM authentication on the database user
4. Wires all Lambdas to the Aurora writer endpoint with IAM auth (RDS Proxy is opt-in and OFF by default; enable `enableRdsProxy=true` only for high Lambda-concurrency workloads that need pooling)

No manual steps required. The schema init custom resource runs idempotently on each deploy.

### Switching from Athena to Aurora

Athena and Aurora are deploy-time alternatives, not runtime coexistence. To switch:

```bash
# 1. Deploy Aurora mode (creates AgentEchelonAnalyticsAurora stack)
cd backend && npx cdk deploy --all --context analyticsMode=aurora

# 2. Destroy the now-unused Athena stack
cd backend && npx cdk destroy AgentEchelonAnalytics
```

Historical Athena data remains in S3 but is not migrated to Aurora. Aurora starts with a fresh database.

### Update frontend .env

After deploying, update `frontend/.env` with the new analytics API URL:

```
VITE_ANALYTICS_API_URL=<AgentEchelonAnalyticsAurora.AnalyticsApiUrl output>
```

---

## Schema migrations

SQL migrations live in `backend/lambda/src/analytics-aurora/schema/` and run in alphabetical order:

| File | Purpose |
|------|---------|
| `001-initial.sql` | Core tables: `messages`, `exchanges`, `conversation_summaries`, `drift_detection`, `cross_conversation_context` |
| `002-pgvector.sql` | Enables `pgvector` extension, adds `embeddings` table for similarity search |
| `003-materialized-views.sql` | Pre-computed views: daily metrics, model effectiveness, conversation stats |
| `004-experiments.sql` | A/B experiment tracking: `experiments`, `experiment_variants`, `experiment_results` |
| `005-summary-embeddings.sql` | `summary_embeddings` table (Titan v2 @ 1024-dim) for live drift detection |
| `006-drift-events-hardened.sql` | `drift_events` by-reference telemetry table replacing `drift_detection` |
| `007-conversation-creation-tasks.sql` | Pending drift-suggestion durability across Lex session resets |
| `008-document-embeddings.sql` | RAG: embeddings table → 1024-dim + idempotency index + tier-metadata GIN index |
| `009-drift-reasoning-decision.sql` | `drift_events` reasoning-decision columns: LLM verdict + human-auditable rationale; cosine similarity retained only for retrieval |
| `010-task-state-machine.sql` | `task_state` + `task_transition` (JSONB) on `messages` and `exchanges`: the declared-graph machine state per turn (distinct from `task_status`), for the Effectiveness turn timeline |
| `011-eval-task-join-key.sql` | `evaluation_results.task_id`: the flow join key Pass A stamps at write time (paired with the existing `flow_id`) |
| `012-moderation-actions.sql` | `moderation_actions`: who redacted/deleted which message and when, stamped with the server-verified admin identity (the Amazon Chime SDK Messaging redact/delete event keeps the original author, so this table is the source for admin-console attribution) |

Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE EXTENSION IF NOT EXISTS`). Adding a new migration:

1. Create `012-your-feature.sql` in the schema directory
2. Redeploy - the custom resource picks up new files automatically

### Why the cluster amortizes across multiple workloads

The Aurora baseline (~$50-95/mo) is shared across **four** workloads, not one:

- **Drift detection** - summary embeddings (`summary_embeddings`) + cosine NN over Titan v2 (1024-dim) for the live-suggestion path; per-stage EMF metrics + UUIDv7 correlation IDs
- **Cross-conversation context** - keyword + pgvector lookup of related conversations per user (`cross_conversation_context` materialized view + the `embeddings` table)
- **RAG proof-point** - document chunks embedded into the same `embeddings` table; retrieval at inference time via the same cosine-NN + HNSW index used by drift. See [docs/guides/developer/RAG.md](../developer/RAG.md).
- **Advanced evaluation** - two-pass Haiku/Sonnet scoring + ground-truth calibration tables

When the cost is presented as "$50-95/mo for drift detection" the ratio looks bad; the honest ratio is "$50-95/mo for the platform that hosts the four advanced features that all need the same pgvector + materialized-view + cluster footprint." That is the framing behind choosing Aurora pgvector over OpenSearch Serverless ($175-345/mo just for OSS Serverless, before adding the cluster for analytics).

---

## Verifying deployment

### Check RDS Proxy health

```bash
aws rds describe-db-proxies \
  --query 'DBProxies[?starts_with(DBProxyName, `agent-echelon`)].{Name:DBProxyName,Status:Status,Endpoint:Endpoint}' \
  --output table
```

Status should be `available`.

### Check Aurora cluster

```bash
aws rds describe-db-clusters \
  --query 'DBClusters[?starts_with(DBClusterIdentifier, `agent-echelon`)].{Id:DBClusterIdentifier,Status:Status,Engine:Engine,Capacity:ServerlessV2ScalingConfiguration}' \
  --output table
```

### Check schema init succeeded

Look at the custom resource Lambda logs:

```bash
aws logs filter-log-events \
  --log-group-name "/aws/lambda/AgentEchelonAnalyticsAurora-SchemaInitLambda*" \
  --filter-pattern "Migration complete" \
  --limit 10
```

### Test analytics API

```bash
curl -s "$(aws cloudformation describe-stacks \
  --stack-name AgentEchelonAnalyticsAurora \
  --query 'Stacks[0].Outputs[?OutputKey==`AnalyticsApiUrl`].OutputValue' \
  --output text)analytics/evaluation" | jq .
```

---

## Analytics API endpoints

The Aurora analytics API serves the admin dashboard. All endpoints accept `GET` requests:

| Endpoint | Returns |
|----------|---------|
| `/analytics/evaluation` | Evaluation summary metrics |
| `/analytics/evaluation/exchanges` | Individual exchange scores |
| `/analytics/evaluation/flows` | Multi-turn intent flow analysis |
| `/analytics/conversations` | Conversation-level statistics |
| `/analytics/drift` | Drift detection events |
| `/analytics/context` | Cross-conversation context records |
| `/analytics/model-effectiveness` | Model performance comparison |

---

## Evaluation runner

The evaluation Lambda runs daily at 2am UTC via EventBridge. It:

1. Queries recent exchanges (user message + bot response pairs)
2. Sends each exchange to a Bedrock evaluator model (Haiku by default)
3. Scores responses on relevance, helpfulness, accuracy, and safety
4. Stores results in the `exchanges` table with evaluation metadata

The evaluator model is configured via the `EVALUATOR_MODEL` environment variable on the Lambda (default: `anthropic.claude-3-haiku-20240307-v1:0`).

---

## Drift detection (Aurora-only)

Drift detection is **exclusively an Aurora-mode capability.** It depends on pgvector cosine similarity over Titan v2 embeddings stored in Aurora; there is no Athena-mode equivalent. Deploying with the default Athena mode silently disables the feature - no errors, just no live drift suggestions.

**Design summary** (full detail in `docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md`):

1. **Summary updater Lambda** runs every 30 minutes (EventBridge scheduled), finds channels with messages newer than their newest summary, generates a fresh summary via Bedrock Haiku at temperature 0, and stores it in `conversation_summaries`.
2. **Embedding writer** (inline in the summary updater) generates a Titan v2 1024-dim embedding of the new summary and UPSERTs into `summary_embeddings` with a version guard.
3. **`detectDrift()`** runs on the live user-message path (when `enableLiveDrift` CDK context is `true`), executing inside the retrieval **data-plane Lambda** that the non-VPC router invokes (project decision 018):
 - Embeds the user message via Titan v2 (500ms hard timeout)
 - Computes cosine distance against the channel's summary embedding
 - If distance > threshold (default 0.35), drift fires
 - Optionally upgrades `confirm` → `redirect` via cosine-NN against the user's other channels (scoped by multi-member intersection)
4. **On embedding failure**, drift skips for the turn - there is no string-matching fallback (intentional, per the spec).
5. **`drift_events`** table records every fire by reference (originating message id only; never the message body). Outcomes: `accepted`, `declined`, `rejected_in_new_channel`, `abandoned` (last written by a scheduled detector Lambda).
6. **Decline-suppression:** if the user declined a drift at cosine distance `d`, drift won't re-fire within `d ± 0.05` for the next 3 turns.
7. **Explicit-routing fast-path:** the one legitimate string-match - "let's start a new conversation about X" patterns route immediately without the embedding round-trip.

**Feature flag:** deploy with `--context enableLiveDrift=true` to turn on the live-suggestion path. Default `false` ships the analytics-only post-hoc path (archival pipeline tracks drift but no user-facing suggestion).

```bash
npx cdk deploy --all \
  --context analyticsMode=aurora \
  --context enableLiveDrift=true
```

Both flags are required for live drift. `enableLiveDrift=true` without `analyticsMode=aurora` is a misconfiguration - the router has no Aurora to query and drift will silently skip every turn (with a CloudWatch warn log).

**How `enableLiveDrift` wires the path (project decision 018).** It does **not** VPC-attach the agent handler. The handler stays non-VPC; retrieval and drift run in a dedicated VPC-attached **data-plane Lambda** (in the Aurora stack), and `enableLiveDrift` grants the handler `lambda:InvokeFunction` on that Lambda plus its ARN. This avoids the failure where a VPC-attached handler cannot reach SSM, Cognito, or Lambda-invoke from the isolated subnets. The data-plane Lambda reuses the existing Bedrock and Secrets endpoints, so it adds no new VPC endpoints. Per-piece costs are in `docs/guides/admin/INFRASTRUCTURE-COST.md`.

---

## Cost breakdown

The full per-component cost model lives in the single source of truth, [INFRASTRUCTURE-COST.md](INFRASTRUCTURE-COST.md). In summary: Aurora mode's at-rest baseline is roughly ~$50/month when importing a VPC (no interface endpoints) or ~$95/month on a stack-created VPC, dominated by the Aurora cluster at its ACU floor; it scales to 4 ACU under load. Kinesis is shared with Athena mode and is not an incremental Aurora cost. The RDS Proxy is off by default (+~$86/month when enabled; see [Connection pooling](#connection-pooling-rds-proxy-optional-for-scale) below).

---

## Connection pooling: RDS Proxy (optional, for scale)

By default AgentEchelon runs **without** an RDS Proxy. The analytics Lambdas connect directly to the Aurora writer endpoint using IAM database authentication. This is the right default for the low-to-moderate concurrency these Lambdas run at, and it avoids a large fixed cost.

**Why it is off by default.** On Aurora Serverless v2, RDS Proxy bills a fixed minimum of **8 ACUs** (`8 x $0.015/hr x ~730 hr = ~$86/month`) regardless of database load. A cluster that idles at 0.5 ACU therefore pays more for the proxy than for the database it fronts. For a low-traffic deployment the proxy is the single largest line item, for no benefit.

**When to enable it.** Turn the proxy on when you run enough concurrent Lambda invocations to risk exhausting Aurora's `max_connections`, which scales with ACU and is low at small sizes. Connection pooling multiplexes many Lambda connections onto a small shared pool, protecting the cluster under bursty, high-concurrency load. Signs you need it: `too many clients already` or `remaining connection slots are reserved` errors, or a high steady-state invocation rate on the archival, evaluation, drift, or data-plane Lambdas.

```bash
npx cdk deploy --all --context analyticsMode=aurora --context enableRdsProxy=true
```

Enabling the proxy adds ~$86/month (the 8-ACU floor) and re-points the Lambdas' `DB_HOST` at the proxy endpoint. Nothing else changes: IAM auth, the DB user, and the schema are identical on both paths, so it is a safe toggle in either direction.

| | Default (no proxy) | `enableRdsProxy=true` |
|---|---|---|
| Lambda connection target | Aurora writer endpoint (direct) | RDS Proxy endpoint |
| Auth | IAM database auth | IAM database auth (via proxy) |
| Connection pooling | per-Lambda pool (max 5) | shared proxy pool |
| Added cost | $0 | ~$86/month (8-ACU minimum) |
| Best for | low-to-moderate concurrency | bursty / high Lambda concurrency |

---

## Troubleshooting

### Lambda can't connect to Aurora

- Verify the Lambda's security group has an ingress rule to the DB security group on port 5432
- Check that the RDS Proxy status is `available`
- Verify IAM auth setup succeeded (check `/aws/lambda/AgentEchelonAnalyticsAurora-IamAuthSetupLambda*` logs)

### Schema migrations fail

- Check the schema init Lambda logs for SQL errors
- Verify the database is reachable from the Lambda's VPC subnet
- If pgvector extension fails, confirm Aurora PostgreSQL 15.x supports it (it does from 15.3+)

### Analytics API returns empty results

- The database starts empty - data accumulates as users chat
- Materialized views refresh on a schedule; initial results may be stale
- Check the archival Lambda logs to confirm Kinesis events are being processed
