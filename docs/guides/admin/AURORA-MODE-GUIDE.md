# Aurora Mode Guide

AgentEchelon ships with two analytics backends. **Athena mode** (default) is serverless and cheap at low volume. **Aurora mode** adds a VPC with Aurora PostgreSQL Serverless v2 for sub-second dashboard queries, multi-turn evaluation, drift detection, and cross-conversation context search.

This guide covers when to choose Aurora mode, how to deploy it, and what to expect.

## Testing focus

Athena mode is provided as a lower-cost way to run the platform, without the VPC and Aurora cluster floor. Testing is focused primarily on Aurora mode: the end-to-end suite and `validate` are run against an Aurora-mode deployment (`validate` drops its Aurora-only phases on an Athena deployment), and several specs (evaluation verdicts, the Aurora-only admin views) apply only there. Athena mode gets less end-to-end coverage, so exercise it in your own environment before relying on it.

---

## When to use Aurora mode

> **Athena/S3 is the system of record; Aurora is a fast projection of it.** Both modes write the same append-only S3 conversation archive (the Kinesis stream fans out to S3 in either mode), and that archive is the **complete, durable Amazon Chime SDK Messaging event stream** partitioned by classification. Aurora mode adds a Postgres/pgvector copy for sub-second queries and features Athena cannot serve (evaluation, drift, cross-conversation search), but that copy is a **lossy real-time projection** (it collapses membership to current state and drops some events). The mode does not change what is retained; it changes what is queryable and how fast. So "not available in Athena" below means *the query path or derived table is not built for Athena mode*, never that the underlying events are missing from the archive.

| Consideration | Athena (default) | Aurora |
|---------------|-----------------|--------|
| Conversation / event archive (system of record) | **Yes** - S3, always on, the durable source | Same S3 archive **plus** a Postgres projection |
| Raw event log ("Show all events") | Data is in the S3 archive (system of record); the analytics API's `channel_events` query is **NOT BUILT** for Athena mode, so the console view is Aurora-only (a handler gap, not a data gap) | Served (`channel_events` -> `adminListEvents`) |
| Membership / moderation history | Queried straight from the S3 archive (`admin-conversations.ts`) | Queried from Aurora (fast) + the `moderation_actions` attribution table (Aurora-only) |
| User activity / signup + signin funnels | Available (Athena queries the archive + `client_events`) | Available (fast) |
| Dashboard query latency | Seconds (pay-per-query) | Sub-second (persistent DB) |
| Multi-turn evaluation scoring | Basic (flat Athena queries) | Per-exchange relevance plus multi-turn flow scoring, every 30 minutes |
| Drift detection | Not available (needs pgvector) | pgvector cosine similarity over Titan v2 embeddings |
| Cross-conversation context | Not available (needs pgvector) | Per-user context search (keyword + pgvector) |
| Monthly cost at rest (rough estimate) | ~$32 (Kinesis-dominated) | ~$76 importing a VPC, ~$120 on a stack-created VPC, Kinesis included, RDS Proxy off; see [INFRASTRUCTURE-COST.md](INFRASTRUCTURE-COST.md) |
| VPC required | No | Yes (auto-provisioned) |
| Schema migrations | None | Every schema file on stack Create; every later migration applies at runtime on cold start |

**Use Athena** when cost matters more than query speed and you don't need evaluation, drift detection, or cross-conversation features. You still have the full, durable event archive - it is the system of record in both modes.

**Use Aurora** when you need real-time admin dashboards, automated evaluation pipelines, drift detection, or cross-conversation context.

> **IAM enforcement.** Admin IAM enforcement is always on (`ADMIN_IAM_ENFORCEMENT` is set to `true` in both analytics modes, on the `AdminServices` stack's `Analytics` nested stack), and the analytics API in either mode gives each admin capability its own gateway resource, so a persona role can be denied a capability (say `view-user-activity`) at the gateway. Aurora mode serves each capability as its own route; Athena mode serves them as sub-routes below `POST /query` (`ANALYTICS_CAPABILITY_SUBPATHS` in `backend/lambda/src/lib/admin-capability-map.ts`). The Athena handler implements only the `view-analytics` query types, so a finer capability's query type answers unsupported there. See [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../../specs/interaction/governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md).

---

## Architecture

Aurora mode provisions:

- **VPC** with 2 AZs, `PRIVATE_ISOLATED` subnets, 0 NAT gateways
- **VPC Endpoints**: Kinesis (interface), S3 (gateway), DynamoDB (gateway), Secrets Manager (interface), Bedrock Runtime (interface)
- **Aurora PostgreSQL Serverless v2**: 0.5-4 ACU, IAM auth, encrypted at rest, Performance Insights
- **RDS Proxy** (opt-in, OFF by default): connection pooling + IAM auth in front of Aurora, enabled with `enableRdsProxy=true`. Off by default because on Serverless v2 it bills a fixed ~8-ACU floor (~$88/month) regardless of load; the default path is direct writer-endpoint IAM auth (see [Connection pooling](#connection-pooling))
- **Schema Init**: Custom resource Lambda applies every schema file on stack Create; the classification boundary and later migrations apply at runtime (see [Schema migrations](#schema-migrations))
- **IAM Auth Setup**: Custom resource grants `rds_iam` role to DB user
- **Kinesis Stream**: consumed, not provisioned: the stream belongs to the `<prefix>Messaging` stack in either mode (2 shards, 24h retention, `lib/stacks/messaging-stack.ts`)
- **Firehose delivery stream**: delivers the Kinesis stream to the S3 conversation archive (`lib/constructs/conversation-archive.ts`)
- **Archival Lambda**: VPC-attached, consumes Kinesis, writes to Aurora only
- **Evaluation Runner**: VPC-attached, runs every 30 minutes, judges with the utility model (Claude Haiku 4.5) via Bedrock by default
- **Analytics Query Lambda + API Gateway**: VPC-attached, serves admin dashboard queries
- **Retrieval Data-Plane Lambda**: VPC-attached, runs RAG retrieval + drift detection (embed + pgvector) so the non-VPC agent handler can invoke it (ADR-013)
- **S3 Archive Bucket**: Same layout as Athena mode. **Expires at 90 days as shipped** - see [Archive retention](#archive-retention), which you should read before the deployment is that old

By default the Lambdas connect DIRECTLY to the Aurora writer endpoint using IAM database authentication (no hardcoded passwords). RDS Proxy is opt-in (`enableRdsProxy`, off by default); when enabled, the Lambdas connect through the proxy instead. See [Connection pooling](#connection-pooling).

---

## Deploying

### Prerequisites

1. AWS credentials configured with admin access
2. Bedrock model access enabled (Haiku + Sonnet, and Titan Text Embeddings v2 for drift and retrieval, in us-east-1)
3. CDK bootstrapped in target account/region

### Deploy command

Set the mode in the gitignored `backend/deploy.config.json` (copy `backend/deploy.config.example.json` if you have none), so every later deploy carries it:

```json
{
  "analyticsMode": "aurora",
  "senderEmail": "you@yourdomain.com"
}
```

Then run the supported deploy, which builds, deploys every stack with the live app URLs, syncs context, generates the frontend env files and ships the frontend:

```bash
cd backend && npm run deploy
```

This deploys the full stack set, with the Aurora variant of the `<prefix>Archive` stack (`archive-stack-aurora.ts`) in place of the Athena one (`archive-stack.ts`); both modes deploy under the same stack name. Throughout this guide `<instance>` is the instance name `AE_INSTANCE_NAME` (default `agent-echelon`), which starts each resource name, and `<prefix>` is that name in PascalCase (default `AgentEchelon`, so `AgentEchelonArchive`), which starts each stack name; `npx cdk list` under the deploy context prints the exact stack names. Keep `analyticsMode` in the config file rather than passing it once on the command line: an absent `analyticsMode` means `athena`, and `npm run deploy` refuses that on an Aurora deployment (see [Switching modes](#switching-modes)). `npm run deploy` resolves `appUrl` when `chat` is a declared capability, and `adminAppUrl` when `admin` is, from the live CloudFront distributions. A single-stack deploy, `cd backend && npm run deploy:stack -- <prefix><Stack>` (`--diff-only` to look first), does not resolve them: it applies every key from `deploy.config.json` and refuses to run when the file lacks a key whose absence deletes grants (`DESTRUCTIVE_IF_ABSENT` in `backend/lib/config/deploy-context.ts`), or lacks `appUrl`, or lacks `adminAppUrl` with `admin` declared, because an absent `adminAppUrl` resets the admin APIs' CORS allowlist to the chat origin (`backend/scripts/deploy-stack.mjs`). It also refuses a stack name that `cdk list` does not print under that context. A raw `npx cdk deploy` is not a supported deploy path.

### Importing a VPC

To share a VPC the account already has, set `analyticsVpcId` (and `analyticsVpcSubnetType`, default `isolated`) in `deploy.config.json`. Set `createVpcEndpoints` to `false` only when the VPC already provides the endpoints the handlers need; the stack then creates none. Synth cannot see an imported VPC's endpoints, so `npm run deploy` and `npm run deploy:stack` read them first and refuse a deploy whose route tables, interface endpoints or endpoint policies do not reach what the in-VPC handlers call: S3 (the registry bucket `<instance>-registry-<account>-<region>` and the archive bucket), DynamoDB, Secrets Manager and Amazon Bedrock Runtime. The refusal names the bucket or service and the fix. Run the same read-only check alone with:

```bash
cd backend && npm run check:vpc
```

The full list of calls and how each is decided is [SPEC-AURORA-VPC-MODE, Appendix G](../../specs/foundations/SPEC-AURORA-VPC-MODE.md#appendix-g---imported-vpc).

### First deploy

On first deploy, the stack automatically:

1. Creates the VPC and Aurora cluster
2. Applies every schema file, via the `schema-init` custom resource
3. Sets up IAM authentication on the database user
4. Wires all Lambdas to the Aurora writer endpoint with IAM auth (RDS Proxy is opt-in and OFF by default; enable `enableRdsProxy=true` only for high Lambda-concurrency workloads that need pooling)
5. Establishes the classification boundary (ADR-028) on the first Lambda cold start, in `applyPendingMigrations` (`db-client.ts`)

No manual steps required. Every migration added after the cluster exists applies at runtime on the next Lambda cold start rather than during the deploy - see [Schema migrations](#schema-migrations), which is the section to read if a deploy succeeds and the new column still is not there.

### Switching modes

The analytics mode is chosen at first deploy and stays fixed for the life of the deployment. Switching an existing deployment between Athena and Aurora, in either direction, is not supported.

**Why.** Both modes deploy as the one `Archive` stack, and each creates resources with the same fixed names:

| Resource | Name | Athena mode | Aurora mode |
|---|---|---|---|
| Conversation archive bucket (`RemovalPolicy.RETAIN`) | `<instance>-conversation-archive-<account>-<region>` | `archive-stack.ts` | `constructs/conversation-archive.ts` |
| Firehose delivery stream | `<instance>-message-archive` | `archive-stack.ts` | `constructs/conversation-archive.ts` |
| Glue database | `ANALYTICS_DB_NAME` | `archive-stack.ts` | `constructs/conversation-archive.ts` |
| Athena workgroup | `ATHENA_WORKGROUP_NAME` | `archive-stack.ts` | `constructs/conversation-archive.ts` |
| Firehose log group | `/aws/kinesisfirehose/<instance>-message-archive` | `archive-stack.ts` | `constructs/conversation-archive.ts` |
| Archive KMS key alias | `alias/<instance>-archive` | `archive-stack.ts` | `archive-stack-aurora.ts` |

A deploy with the other mode updates the `Archive` stack in place: it removes the first mode's resources and creates the other's, and the archive bucket is `RETAIN`, so it outlives its removal and the other mode's create collides with it. The message stream and the app instance's streaming configuration are the `Messaging` stack's and do not change with the mode.

**Enforcement.** `npm run deploy` and `npm run deploy:stack` both refuse a deploy whose `analyticsMode` differs from the mode the deployment runs (`checkAnalyticsModeLock` in `backend/scripts/lib/deploy-guards.cjs`). Each compares against two records: `_analyticsModeChosenAtFirstDeploy`, which `npm run deploy` writes into `deploy.config.json` after the first successful backend deploy, and the deployed `<prefix>Archive` stack, which names its mode in its `AnalyticsMode` output in both modes. An absent `analyticsMode` means `athena`, so leaving it out of a deploy to an Aurora deployment is refused as well. Only a raw `npx cdk deploy` skips the check, and a raw `cdk deploy` is not a supported deploy path (the repository's assistant hook `.claude/hooks/deploy-through-the-guard.js` refuses it).

**Changing modes.** Tear the deployment down and deploy a fresh one:

1. Copy out anything to keep from the conversation archive bucket, `<instance>-conversation-archive-<account>-<region>`, and on an Aurora deployment from the Aurora stack's archive bucket too, `<instance>-aurora-archive-<account>-<region>` (also `RETAIN`). On `environment=production`, also export what you need from the Aurora database, which step 5 deletes.
2. Destroy every `<prefix>*` stack (see [Teardown](../../overview/STACKS.md#teardown)).
3. Delete the retained archive buckets. The fresh deploy cannot create a fixed-name resource whose name is still taken.
4. Delete the retained assistant SSM parameters, `/<instance>/assistant/<classification>/assistant-system-prompt` and `/<instance>/assistant/<classification>/assistant-intent-pack`, for each classification that has one, where `<instance>` is `AE_INSTANCE_NAME` (default `agent-echelon`): `aws ssm delete-parameters --names <name> <name>`. A deploy that sets `assistantSystemPrompt` or `assistantIntentPack` without `assistantParamWriter` creates each as a `RETAIN` parameter with a fixed name, which outlives the stack and makes the fresh deploy fail to create it; one written through `assistantParamWriter` also outlives the stack but does not block (`assistant-profile-stack.ts`).
5. On `environment=production`, an Aurora deployment also retains its database cluster, `<instance>-analytics`, with deletion protection on, and the archive KMS key that encrypts it and the Aurora archive bucket (`archive-stack-aurora.ts`). The cluster bills until it is deleted, and its fixed identifier blocks a fresh Aurora deploy: turn off deletion protection, delete the cluster, then schedule the key for deletion. The Athena stack's archive KMS key (`archive-stack.ts`) is `RETAIN` in every environment; its alias is deleted with the stack, so it does not block a fresh deploy, but it bills until it is scheduled for deletion.
6. Remove `_analyticsModeChosenAtFirstDeploy` from `deploy.config.json`, set `analyticsMode` to the new mode, and run `npm run deploy`.

**What it loses.** The fresh deployment starts empty: a new user pool and a new Amazon Chime SDK app instance, so no users and no conversations from the old deployment, an empty archive and an empty analytics store. The teardown retains the old user pool and the attachments bucket (`RemovalPolicy.RETAIN`), with the intent-pack and document-template bodies stored in it (`classification-packs/`, `templates/`), and the new deployment does not reattach them: put the templates again with `npm run template`. No tool loads one mode's data into the other.

**Rebuilding the projection.** Because the archive is the system of record and Aurora is a projection of it, a fresh Aurora deployment loses nothing the archive holds only if the projection can be rebuilt from a retained archive. **NOT BUILT:** no rebuild-from-archive job exists. Today Aurora is filled only from the live message stream, so a fresh Aurora deployment starts with an empty projection even when the old archive is kept.

**Messages updated more than once.** A projection written before migration 084 kept one update row per message, the first, and dropped every later update of the same message; the archive holds them all. 084 adds `base_message_id` and `last_updated_at`, derives the base id for existing rows, and from then on keeps every update as its own row ([MESSAGE-FLOW.md §11.3](../developer/MESSAGE-FLOW.md#113-telemetry-rows-and-pairing)). It cannot recover the dropped updates without the rebuild job above, so the older rows keep their first update and the readers name them as they did before 084 (a queue notice closed out as a receipt is still read as a receipt). A teardown and fresh deploy starts a projection that keeps every update from its first event.

### Frontend env

`npm run deploy` writes the admin API URL, on which the analytics routes are mounted at `/query`, the admin API's capabilities, the console events API's two endpoints (the AppSync Event API `ConsoleEvents` that pushes to the console when a run ends) and the analytics mode from the stack outputs into the admin package's env file, `frontend/packages/admin/.env`, only (`ADMIN_ONLY` in `backend/scripts/gen-frontend-env.mjs`); the chat package does not receive them. To regenerate the env files on their own, run `node scripts/gen-frontend-env.mjs` from `backend/`. Each package has its own file, `frontend/packages/chat/.env` and `frontend/packages/admin/.env`; there is no root `frontend/.env`.

```
VITE_ADMIN_API_URL=<<prefix>AdminApi.AdminApiUrl output>
VITE_ADMIN_API_CAPABILITIES=<<prefix>AdminApi.AdminApiCapabilities output>
VITE_CONSOLE_EVENTS_HTTP=<<prefix>AdminServices.ConsoleEventsHttpDns output>
VITE_CONSOLE_EVENTS_REALTIME=<<prefix>AdminServices.ConsoleEventsRealtimeDns output>
VITE_ANALYTICS_MODE=<<prefix>Archive.AnalyticsMode output>
```

---

## Schema migrations

SQL migrations live in `backend/lambda/src/analytics-aurora/schema/` and run in filename order. **That directory is the authority on what exists** - this guide does not reproduce the list, because a hand-copied list is wrong the moment someone adds a file. `ls backend/lambda/src/analytics-aurora/schema/` answers "what is there"; each file's header comment answers "why".

**Two mechanisms.** The difference matters when you are waiting for a change to take effect:

| | Stack Create | Every later migration |
|---|---|---|
| What | every `schema/*.sql` file present when the stack is created | every `NNN-*.sql` file added after the cluster exists, plus the classification-boundary bootstrap (ADR-028), which the first cold start establishes and later cold starts re-assert |
| When | the `schema-init` custom resource, on stack **Create** | at **runtime**, on the next Lambda **cold start** |
| Where | `analytics-aurora/schema-init.ts` | `db-client.ts` `applyPendingMigrations`, recorded in the `_migrations` table |

So a new migration file does **not** need the stack to create anything: deploying new Lambda code is enough, and the first cold start after that applies whatever `_migrations` has not seen, under a Postgres advisory lock so two cold starts cannot double-apply. On an EXISTING cluster this is the only path a migration takes.

That is also why the constraints are what they are: a runtime-applied migration runs inside one transaction, so it MUST be idempotent (`CREATE TABLE IF NOT EXISTS`) **and transaction-safe** - no `CREATE INDEX CONCURRENTLY`, no `VACUUM`, nothing that demands its own transaction.

Adding a migration:

1. Create the next numbered SQL file in the schema directory - the same `NNN-name` shape as its siblings, numbered one above the highest one there.
2. Deploy the backend. The next cold start applies it and inserts the filename into `_migrations`.
3. Confirm with `SELECT filename, applied_at FROM _migrations ORDER BY id DESC LIMIT 5;` - an unapplied migration is invisible in every other way until something queries what it added.

#### Bounded data migrations

Every pending file, plus the classification-boundary bootstrap, shares **one transaction inside one Lambda invocation**, and nothing commits unless all of it does. DDL is fixed work; a data step whose cost scales with how much data the deployment already holds is not. A statement that outruns the invocation records nothing, so the next cold start begins the identical work from zero and the upgrade never converges - while the schema it was carrying stays unapplied.

So a data backfill does a **bounded batch** and reports how much it has left in `_migration_progress`. `applyPendingMigrations` records the file in `_migrations` only when that count is zero; a non-zero count leaves the file pending, and the next cold start runs the next batch. Files after it still apply, so a long backfill never blocks the schema - which also means nothing may depend on its data step having finished. `schema/029-embeddings-classification-key-backfill.sql` is the worked example, and `migration-data-steps-are-bounded.test.ts` fails the build on an unbounded one.

Check progress with:

```sql
SELECT filename, remaining, updated_at FROM _migration_progress ORDER BY updated_at DESC;
```

A row stuck at the same `remaining` across cold starts means the batches are not running - look for the Lambda that should be cold-starting, not for a stuck lock.

### Shared cluster cost

The Aurora baseline (see [INFRASTRUCTURE-COST.md](INFRASTRUCTURE-COST.md)) is shared across **four** workloads, which all need the same pgvector and cluster footprint:

- **Drift detection** - summary embeddings (`summary_embeddings`) + cosine NN over Titan v2 (1024-dim) for the live-suggestion path; per-stage EMF metrics + UUIDv7 correlation IDs
- **Cross-conversation context** - which other conversations a person has, so a pivot can offer to continue an existing one rather than open a duplicate. The `cross_conversation_context` TABLE holds a reference per conversation (its classification and the id of the message that last touched it) and no message text; the text a lookup matches on is joined live from `conversation_summaries`. It is classification-bounded under ADR-028, so the read runs as the classification's reader role
- **RAG proof-point** - document chunks embedded into the same `embeddings` table; retrieval at inference time fuses the same cosine-NN + HNSW index used by drift with a lexical match over a generated `content_tsv` GIN index. See [../developer/RAG.md](../developer/RAG.md).
- **Advanced evaluation** - per-exchange relevance and multi-turn flow scoring + ground-truth calibration tables

**The person key.** Every Aurora table that names a person keys them by their AppInstanceUser id, the bare id after `/user/` in their ARN, whichever identity provider signed them in; it is the same id the message's sender ARN carries, so a person's turns join to their other records without an ARN parse or a display name. An admin-plane identity is attributed to its owner through the owner tag the credential exchange puts on it, never by parsing a suffix. The column is `person_id` (migration `079-a-person-key-says-it-is-a-person.sql` names it in every table that carries it). **NOT BUILT:** archival files an admin-plane turn under its owner's id read from the twin's own id (`<personId>-admin`) rather than from its `owner` tag, because the archival path cannot reach the Amazon Chime SDK.

---

## Verifying deployment

In the commands below, `<instance>` is `AE_INSTANCE_NAME` (default `agent-echelon`), which names the database cluster, the proxy and the APIs, and `<prefix>` is that name in PascalCase (default `AgentEchelon`), which starts every stack name.

### Check RDS Proxy health (only if you enabled it)

The proxy is **off by default** (`enableRdsProxy`), so on a default deployment this command returns an empty table and that is not a fault - see [Connection pooling](#connection-pooling). Run it only when you deployed with `enableRdsProxy=true`.

```bash
aws rds describe-db-proxies \
  --query 'DBProxies[?starts_with(DBProxyName, `<instance>`)].{Name:DBProxyName,Status:Status,Endpoint:Endpoint}' \
  --output table
```

Status should be `available`.

### Check Aurora cluster

```bash
aws rds describe-db-clusters \
  --query 'DBClusters[?starts_with(DBClusterIdentifier, `<instance>`)].{Id:DBClusterIdentifier,Status:Status,Engine:Engine,Capacity:ServerlessV2ScalingConfiguration}' \
  --output table
```

### Check schema init succeeded

Look at the custom resource Lambda logs. `filter-log-events` takes an exact log group name with no wildcard, so resolve the generated name first (the function has no fixed name; CDK derives it from the stack name and the `SchemaInitLambda` construct id):

```bash
G=$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/<prefix>Archive-SchemaInitLambda" \
  --query 'logGroups[0].logGroupName' --output text)
aws logs filter-log-events \
  --log-group-name "$G" \
  --filter-pattern "Migration complete" \
  --limit 10
```

### Test analytics API

Every analytics route on `AdminApi` is `AWS_IAM`-authorized, so an unsigned `curl` is refused with 403. Sign the request with SigV4, for example with `awscurl`, using credentials that hold `execute-api:Invoke` on the route (an admin persona role), or open the admin console, which signs for you:

```bash
URL="$(aws cloudformation describe-stacks \
  --stack-name <prefix>AdminApi \
  --query 'Stacks[0].Outputs[?OutputKey==`AdminApiUrl`].OutputValue' \
  --output text)"
awscurl --service execute-api --region "$AWS_REGION" "${URL}/query/analytics/evaluation" | jq .
```

---

## Analytics API endpoints

The full, generated route inventory, with each route's authorizer and integration, is [`docs/reference/api-contract.md`](../../reference/api-contract.md) (the `/query` routes of `<instance>-admin-api`). In summary:

- **`POST /query`** is the primary query route: the body's `queryType` selects the query (for example `latency_metrics`, `turn_latency_audit`, `experiment_results`, `experiment_recommendation`).
- **`GET /query/analytics/*`** serves evaluation summaries, exchanges and flows, conversations, drift, cross-conversation context, model effectiveness and queue health.
- **Per-capability `POST` routes** (`/query/triage`, `/query/ground-truth`, `/query/events-log`, `/query/moderation-audit`, `/query/user-activity` and others) let IAM refuse a capability at the gateway.
- Every analytics route is `AWS_IAM` (SigV4). The client-events route `POST /events` is on `PersonApi` behind the edge authorizer, and, when `sleepMode` is set, `GET /deployment/state` is on `PersonApi` with no authorizer.

---

## Evaluation runner

The evaluation Lambda runs every 30 minutes via EventBridge (the rule's construct id is `DailyEvaluationSchedule` despite the 30-minute rate; `archive-stack-aurora.ts`). Each run:

1. Selects unscored exchanges, up to `EVAL_MAX_PER_RUN` (default 200). Human-flagged and low-confidence exchanges are always taken; the rest are sampled at `EVAL_SAMPLE_PERCENT` (default 100).
2. Scores each exchange's relevance from 0 to 100 with the evaluator model. An image-generation turn is judged on the generated image by a vision-capable judge, and left unscored when none is available.
3. Scores multi-turn intent flows against a weighted rubric.
4. Writes the results to the `evaluation_results` and `intent_flows` tables.

The evaluator model is the `EVALUATOR_MODEL` environment variable on the Lambda, which the stack sets to `UTILITY_MODEL_ID` (Claude Haiku 4.5, `backend/lib/config/model-strategy.ts`); `evaluation-runner.ts` falls back to the same value when the variable is unset.

---

## Drift detection (Aurora-only)

Drift detection is **exclusively an Aurora-mode capability.** It depends on pgvector cosine similarity over Titan v2 embeddings stored in Aurora; there is no Athena-mode equivalent. Deploying with the default Athena mode disables the feature without an error - there are no live drift suggestions.

**Design summary** (full detail in `docs/specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md`):

1. **Summaries are written on three paths** ([ADR-019](../../design/decisions/019-conversation-summary-seeded-on-first-turn.md)):
   - **First-turn seed.** A conversation's summary is created on its FIRST turn, at `version = 1`, from the opening exchange the reply path already holds in memory (no message store is read). This gives drift a comparison anchor immediately; without it a new conversation cannot drift until a later summary is written, which is the window where a user is most likely to change topic. The seed writes the summary and its subjects, so turn two is compared against both. It runs as a `seedSummary` op on the data-plane Lambda and is idempotent.
   - **After an assistant reply is archived.** Once the Kinesis archival Lambda commits a batch, it calls `summarizeChannelsNow` (`summary-updater.ts`) in-process for each conversation in which an assistant message was archived: the same per-channel update the scheduled scan runs, reading the archived transcript, bounded by `SUMMARY_ON_ARCHIVE_MAX` conversations per batch (default 3), skipping a conversation whose summary is already current, and never failing archival. The archival role holds `bedrock:InvokeModel` on the utility model and Claude 3.5 Haiku for it.
   - **Scheduled updater.** An EventBridge rule runs the summary updater every 30 minutes (fixed in `archive-stack-aurora.ts`; the `SUMMARY_UPDATER_INTERVAL_MIN` named in comments is read by nothing). It handles INCREMENTAL updates - channels with messages newer than their newest summary - with the utility model at temperature 0, and it is the reconciliation backstop for a failed seed and for any conversation the archival refresh deferred or failed on.

   Summary freshness therefore follows the archival refresh, and the schedule bounds it only for a conversation that refresh missed. `drift_skipped_no_summary` is expected once per new conversation (its first compared turn, before the seed is written); a rate well above the rate of new conversations means seeds are failing, and is alertable.
2. **Embedding writer** (inline in the summary updater) generates a Titan v2 1024-dim embedding of the new summary and UPSERTs into `summary_embeddings` with a version guard.
3. **`detectDrift()`** runs on the live user-message path (when `enableLiveDrift` CDK context is `true`), executing inside the retrieval **data-plane Lambda** that the non-VPC router invokes (ADR-013):
   - Embeds the user message via Titan v2 (500ms hard timeout)
   - Computes the cosine distance against the channel's summary embedding and against each of its subject embeddings (`conversation_topic_embeddings`), and takes the nearest
   - If that distance > threshold (`DRIFT_DISTANCE_THRESHOLD`, default 0.84, measured against the curated cases by `backend/scripts/score-drift-fixture.mjs`), drift fires; within it, the turn is the same subject
   - Returns whether drift fired and the nearest distance; the live drift flow (`live-drift-flow.ts`) turns that into the turn's subject decision (`same`, `new` or `skipped`, with the distance), which the router carries to the turn's analytics record and so to Aurora `messages.metadata`
   - Optionally upgrades `confirm` → `redirect` via cosine-NN against the user's other channels (scoped by multi-member intersection)
4. **On embedding failure**, drift skips for the turn - there is no string-matching fallback (intentional, per the spec).
5. **`drift_events`** table records every fire by reference (originating message id only; never the message body). Outcomes: `accepted`, `declined`, `rejected_in_new_channel`, `abandoned`, each with `outcome_at`, the time it was decided (migration `077`). A decline is final when it is written. An acceptance leaves the move unsettled (`engagement_settled` false) until the scheduled detector Lambda, `abandonment-detector.ts`, checks it five minutes after the offer: no person-sent message in the destination settles it `abandoned`, any settles it `accepted`. A new subject flagged live in the destination before that check settles it `rejected_in_new_channel`, in the same statement as the flag. The detector also closes an offer nobody answered within `UNANSWERED_OFFER_WINDOW_HOURS` (default 24) as `abandoned`. It counts only `CREATE_CHANNEL_MESSAGE` rows: the service admin that creates the conversation leaves channel and membership rows with `is_bot` false, which would otherwise count as a person engaging.
6. **Declined topic adopted:** declining a drift offer makes its subject a topic of the conversation. When an offer fires, the data plane stores the message embedding it compared as an `offered` row in `conversation_topic_embeddings`; a decline promotes it to `adopted` (`adoptOfferedTopic` in `drift-detection.ts`, migration `044-a-declined-topic-belongs-to-the-conversation.sql`). A later message within the drift threshold of an adopted topic does not fire drift. The summarizer's subjects (`status = 'established'`) are compared the same way.
7. **Explicit-routing fast-path:** the one string match on the drift path - "let's start a new conversation about X" patterns route immediately without the embedding round-trip (`detectExplicitRoutingRequest`, `lib/explicit-routing.ts`). The patterns are English only. In any other language the fast path does not match and fails safe: the message goes through the cosine path like any other.

**Feature flag:** set `"enableLiveDrift": true` beside `"analyticsMode": "aurora"` in `backend/deploy.config.json` and run `cd backend && npm run deploy` to turn on the live-suggestion path. Default `false` ships the analytics-only post-hoc path: the archival Lambda scores drift on archived user messages (`processDriftDetection` in `kinesis-archival.ts`) and records fires in `drift_events`, with no user-facing suggestion. The archival pass runs in Aurora mode whatever the flag says.

Both settings are required for live drift. `enableLiveDrift=true` without `analyticsMode=aurora` prints a warning at synth time (`bin/backend.ts`) and the flag is forced off, so nothing is wired.

**How `enableLiveDrift` wires the path (ADR-013).** It does **not** VPC-attach the agent handler. The handler stays non-VPC; retrieval and drift run in a dedicated VPC-attached **data-plane Lambda** (in the Aurora stack), and `enableLiveDrift` grants the handler `lambda:InvokeFunction` on that Lambda plus its ARN. This avoids the failure where a VPC-attached handler cannot reach SSM, Cognito, or Lambda-invoke from the isolated subnets. The data-plane Lambda reuses the existing Bedrock and Secrets endpoints, so it adds no new VPC endpoints. Per-piece costs are in `docs/guides/admin/INFRASTRUCTURE-COST.md`.

---

## Cost breakdown

The full per-component cost model lives in the single source of truth, [INFRASTRUCTURE-COST.md](INFRASTRUCTURE-COST.md). In summary: Aurora mode's at-rest baseline is roughly ~$76/month when importing a VPC that provides egress or ~$120/month on a stack-created VPC (which adds the interface endpoints). Both figures include the Kinesis stream, which Athena mode pays too; the Aurora cluster at its 0.5 ACU floor is the incremental line, and it scales to 4 ACU under load. The RDS Proxy is off by default (+~$88/month when enabled; see [Connection pooling](#connection-pooling) below).

---

## Archive retention

**The archive expires at 90 days as shipped.** Objects transition to Infrequent Access at 30 days and are **deleted at 90**. This is a deliberate default for a demonstration deployment and it is almost certainly wrong for a production one, because the archive is described throughout this documentation as the append-only system of record and the audit trail. At 90 days it is neither. Nothing fails when the objects go: queries stop returning older rows, and anything built on the archive inherits the bound without being told - a regression set, an external evaluation tool, a Legal or HR audit.

**Audience.** A demonstration or throwaway deployment can leave the default alone: it is a sensible bound for a stack nobody intends to keep, and that is why it is the default. **The deployment it matters to is yours** - one standing up AgentEchelon as an integration, where the archive is the audit trail and the only durable record of what was said, what it cost, and what a guardrail decided. There the default disagrees with how this documentation describes the archive, and it disagrees quietly: nothing errors and no metric moves.

**Deadline.** Settle it before the deployment is 90 days old. Lengthening retention stops future deletions and applies to objects already in the bucket, but **it cannot bring back what has already expired**. A deployment that has been running longer than that has permanently lost everything older, and no later change recovers it.

### Buckets

Aurora mode creates **two** archive buckets in the `<prefix>Archive` stack, and both carry the same rule. Athena mode creates one.

| Bucket | Purpose | Defined in | Mode |
|---|---|---|---|
| `<instance>-conversation-archive-<account>-<region>` | Conversation event archive: the audit trail read by the admin Conversations tab and by Legal/HR | `backend/lib/constructs/conversation-archive.ts` | Aurora (instantiated in `archive-stack-aurora.ts`) |
| `<instance>-conversation-archive-<account>-<region>` | Same bucket, defined inline for the Athena path | `backend/lib/stacks/archive-stack.ts` | Athena |
| `<instance>-aurora-archive-<account>-<region>` | Analytics archive behind the Aurora projection | `backend/lib/stacks/archive-stack-aurora.ts` | Aurora |

Each carries a `lifecycleRules` block of the same shape. **Change all of the ones your mode deploys, or the two halves of the record diverge** and a conversation outlives its analytics or the reverse.

### How to change it

1. Edit the `lifecycleRules` block in each file above. To keep the archive indefinitely, delete the `expiration` line; to extend it, raise the number of days.
2. To keep long retention cheap, add a colder transition rather than deleting. **Use `GLACIER_INSTANT_RETRIEVAL` and nothing colder.** Athena has to read these objects in place, and `GLACIER` (Flexible) and `DEEP_ARCHIVE` require an explicit restore first, so a query touching an old partition fails rather than answering slowly. Instant Retrieval is queryable in place and costs roughly a third of Infrequent Access.
3. Redeploy with `cd backend && npm run deploy`. A single-stack deploy of the stack that owns the bucket, `<prefix>Archive` in either mode, works too: `cd backend && npm run deploy:stack -- <prefix>Archive`, which applies every key from `deploy.config.json`. A lifecycle change is a bucket property update, so there is no data movement and no downtime.
4. Confirm against the live bucket rather than the template: `aws s3api get-bucket-lifecycle-configuration --bucket <name>`.

An indefinite archive with the Glacier Instant Retrieval tier above is the configuration that matches how the rest of this documentation describes the archive.

### Unaffected by retention

**Read-time erasure.** A redaction or deletion is recorded as a later event (the `-RED`/`-DEL` sibling rows in Aurora, the latest event per message in the S3 archive), and the console read paths show the redacted state. The original content stays in the raw archive objects and the original Aurora row until they expire, so a longer retention keeps pre-redaction content readable to a direct reader of the bucket for longer. **OPEN:** no path purges redacted content from the archive.

**No derived controls.** No query, retention claim or compliance control is derived from the 90 days, so changing it has no effect beyond how far back the archive reaches.

**Attachments bucket.** It has its own rule, and the rule is not scoped to attachments: `conversations-stack.ts` declares `DeleteOldAttachments` with a 90-day expiration and no prefix, so it expires every object in the attachments bucket at 90 days, not only member uploads: anything else the platform writes to that bucket goes with them. Changing the archive rules above does not touch it.

---

## Connection pooling

By default AgentEchelon runs **without** an RDS Proxy. The analytics Lambdas connect directly to the Aurora writer endpoint using IAM database authentication. This is the right default for the low-to-moderate concurrency these Lambdas run at, and it avoids a large fixed cost.

**Why it is off by default.** On Aurora Serverless v2, RDS Proxy bills a fixed minimum of **8 ACUs** (`8 x $0.015/hr x ~730 hr = ~$88/month`) regardless of database load. A cluster that idles at 0.5 ACU therefore pays more for the proxy than for the database it fronts. For a low-traffic deployment the proxy is the single largest line item, for no benefit.

**When to enable it.** Turn the proxy on when you run enough concurrent Lambda invocations to risk exhausting Aurora's `max_connections`, which scales with ACU and is low at small sizes. Connection pooling multiplexes many Lambda connections onto a small shared pool, protecting the cluster under bursty, high-concurrency load. Signs you need it: `too many clients already` or `remaining connection slots are reserved` errors, or a high steady-state invocation rate on the archival, evaluation, drift, or data-plane Lambdas.

To enable it, set `"enableRdsProxy": true` in `backend/deploy.config.json` and run `cd backend && npm run deploy`.

Enabling the proxy adds ~$88/month (the 8-ACU floor) and re-points the Lambdas' `DB_HOST` at the proxy endpoint. Nothing else changes: IAM auth, the DB user, and the schema are identical on both paths, so it is a safe toggle in either direction.

| | Default (no proxy) | `enableRdsProxy=true` |
|---|---|---|
| Lambda connection target | Aurora writer endpoint (direct) | RDS Proxy endpoint |
| Auth | IAM database auth | IAM database auth (via proxy) |
| Connection pooling | per-Lambda pool (max 5) | shared proxy pool |
| Added cost | $0 | ~$88/month (8-ACU minimum) |
| Best for | low-to-moderate concurrency | bursty / high Lambda concurrency |

---

## Troubleshooting

### Lambda can't connect to Aurora

- Verify the Lambda's security group has an ingress rule to the DB security group on port 5432
- Only if you enabled `enableRdsProxy`: check that the RDS Proxy status is `available`
- Verify IAM auth setup succeeded: check the logs of the log group whose name starts with `/aws/lambda/<prefix>Archive-IamAuthSetupLambda` (resolve the exact name with `aws logs describe-log-groups --log-group-name-prefix`, as in [Check schema init succeeded](#check-schema-init-succeeded))

### Every in-VPC handler times out on an imported VPC

With `createVpcEndpoints=false`, a handler whose call has no route (an S3 gateway endpoint whose policy leaves out the registry bucket, a route table without the gateway, an interface endpoint whose security group does not admit HTTPS) hangs until the function times out, with nothing in its log after the start line. Run `cd backend && npm run check:vpc`: it names the subnet, endpoint, bucket or service and the fix ([Importing a VPC](#importing-a-vpc)).

### Schema migrations fail

- Check the schema init Lambda logs for SQL errors
- Verify the database is reachable from the Lambda's VPC subnet
- If pgvector extension fails, confirm Aurora PostgreSQL 15.x supports it (it does from 15.3+)

### Analytics API returns empty results

- The database starts empty - data accumulates as users chat
- The dashboards query the base tables live, so an empty result means no matching rows in the base tables
- Check the archival Lambda logs to confirm Kinesis events are being processed
