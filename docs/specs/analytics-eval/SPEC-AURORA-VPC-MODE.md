# SPEC: Optional Aurora PostgreSQL + VPC Deployment Mode

**Status:** Implemented (opt-in deployment mode)

Aurora mode is an **optional deployment mode** (opt-in via `--context analyticsMode=aurora`), feature-flagged and additive; the default Athena mode is unchanged. This document is the design and reference for that mode.

---

## Problem

`AgentEchelon` ships with a serverless analytics pipeline by default: **Kinesis → Firehose → S3 → Glue Catalog → Athena**. This works well for simple analytics, is cheap at low volume (pay-per-query), and requires no VPC. It is the right choice for most consumers of the library.

It has real limits for advanced conversational AI workloads:

1. **Query complexity.** Athena can execute SQL, but complex multi-table JOINs, window functions, and CTEs at interactive latency (<100ms) are not its strong suit. Dashboard queries that drive real-time admin views and evaluation feedback loops need sub-second response.
2. **Multi-turn evaluation.** Intent flow evaluation groups exchanges by `task_id`, reconstructs multi-turn conversations, and scores them holistically across weighted dimensions. This requires stateful, transactional queries that Athena is awkward for.
3. **Cross-conversation context search and drift detection.** Looking up "related conversations for this user" or detecting topic drift requires pgvector-style similarity queries or complex SQL with regex and window functions.
4. **Real-time updates.** Conversation summaries that update incrementally as the agent responds need UPSERT semantics, which Athena does not provide.
5. **Materialized views.** Pre-computed daily metrics for dashboards are a PostgreSQL feature, not an Athena one.

A reference production deployment runs the advanced workload on Aurora PostgreSQL Serverless v2 in a private VPC with RDS Proxy, VPC endpoints, and pgvector. This configuration supports two-pass evaluation, intent flow scoring, drift detection, adversarial-aware classification, and a real-time admin dashboard. It's the architecture teams should reach for when the base Athena mode is no longer enough.

Consumers of `AgentEchelon` should be able to opt into the Aurora mode at deploy time with a single CDK flag, without replacing the rest of the library.

## What the mode does

Aurora mode is an **optional deployment mode** selectable via CDK context. When enabled, the library provisions a full Aurora cluster, RDS Proxy, VPC with endpoints, schema migrations, IAM auth setup, and rewires the analytics/evaluation Lambdas to use Aurora instead of Athena. When disabled (the default), behavior is unchanged - the library ships serverless Athena-based analytics.

## Properties

- **Feature flag:** one CDK context key (`analyticsMode: 'athena' | 'aurora'`) switches between modes.
- **Single command deploy:** `npx cdk deploy --all --context analyticsMode=aurora` spins up the full Aurora + VPC stack on a fresh AWS account with no manual steps.
- **Zero changes to default path:** consumers not opting in see no new cost, no VPC, no schema migrations, no IAM setup.
- **Schema migrations automated:** first deploy runs schema creation and pgvector extension setup via a custom resource Lambda; subsequent deploys apply additive migrations idempotently.
- **E2E parity in both modes:** the Playwright suite plus Aurora-mode tests validate parity on core flows.
- **Documentation:** a "When to use Aurora mode" page in the README, cost comparison, tradeoffs, and migration path from Athena mode.

## Non-Goals

- **Not** a migration path from existing Athena data to Aurora (consumers who switch modes start fresh; historical Athena data remains in S3)
- **Not** a hybrid mode where both Athena and Aurora run simultaneously (deploy-time choice, not runtime)
- **Not** Aurora Provisioned clusters (Serverless v2 only; provisioned is a further extension)
- **Not** multi-region Aurora (single region; multi-region is a future extension)
- **Not** pgvector RAG integration at the application layer (schema supports it, application code for RAG retrieval is Phase 2)

---

## Architecture

### Current Default Mode (Athena)

```
Chime SDK → Kinesis Data Stream → Firehose → S3 → Glue Catalog → Athena
                                                        ↓
                                              AnalyticsQueryLambda (non-VPC)
                                                        ↓
                                              Admin Dashboard (frontend)
```

**Characteristics:**
- No VPC
- Pay-per-query Athena cost
- ~$5-15/month at low volume
- Lambda cold starts: fast (no VPC)
- Query latency: 3-10 seconds for complex queries
- No UPSERTs, no transactions, no materialized views

### Aurora Mode (Opt-In)

```
Chime SDK → Kinesis Data Stream → ArchivalLambda (VPC) → Aurora PostgreSQL Serverless v2
                                           ↓                      ↑
                                    (via RDS Proxy)       (via RDS Proxy, IAM auth)
                                                                  ↑
                                                    EvaluationLambda (VPC)
                                                    AnalyticsQueryLambda (VPC)
                                                    SummaryUpdaterLambda (VPC)
                                                    ClientEventsLambda (VPC)
                                                                  ↓
                                                         Admin Dashboard (frontend)
```

**Characteristics:**
- Private VPC with 2 AZs, PRIVATE_ISOLATED subnets only (no NAT)
- 4 VPC endpoints: Kinesis (interface), S3 (gateway), Secrets Manager (interface), Bedrock (interface)
- Aurora Serverless v2, min 0.5 ACU, max 4 ACU, engine PostgreSQL 15.10
- RDS Proxy with IAM authentication (primary) and Secrets Manager (admin fallback)
- pgvector + uuid-ossp extensions
- Schema auto-initialized on first deploy via custom resource Lambda
- ~$50-95/month baseline cost (Aurora Serverless v2 0.5 ACU + Lambda; the 3 interface VPC endpoints add ~$44 on a stack-created VPC or $0 on an imported one; Kinesis is shared with Athena mode; RDS Proxy is optional and off by default; full model in [`INFRASTRUCTURE-COST.md`](../../guides/admin/INFRASTRUCTURE-COST.md))
- Lambda cold starts: slower (VPC ENI attachment)
- Query latency: <100ms for complex queries
- Full PostgreSQL: UPSERTs, transactions, materialized views, window functions, CTEs

### New CDK Stack: `AnalyticsStackAurora`

Replaces (via conditional instantiation) the existing `AnalyticsStack` when `analyticsMode: 'aurora'`.

```typescript
// backend/bin/backend.ts (abbreviated)
const analyticsMode = app.node.tryGetContext('analyticsMode') ?? 'athena';

const analytics = analyticsMode === 'aurora'
  ? new AnalyticsStackAurora(app, 'Analytics', { chime, cognito })
  : new AnalyticsStack(app, 'Analytics', { chime, cognito });

// Downstream stacks (e.g. the per-tier AgentEchelonTier-* stacks) take the
// analytics stack as a dependency and use its exported interface
// (kinesisStreamArn, summaryUpdaterLambdaArn, etc.). The interface is the same
// for both modes; the implementation differs.
const tierStack = new StandardTierStack(app, 'AgentEchelonTier-Standard', { chime, cognito, analytics });
```

Both stacks implement a common `IAnalyticsStack` interface so downstream stacks (the per-tier assistant stacks, NotificationStack) don't need to know which mode is active.

### Interface Abstraction

```typescript
// backend/lib/interfaces/analytics-stack.ts
export interface IAnalyticsStack {
  readonly kinesisStream: IStream;
  readonly summaryUpdaterLambda: IFunction;
  readonly analyticsQueryLambda: IFunction;
  readonly archiveBucketArn?: string;  // Athena mode only
  readonly dbProxyEndpoint?: string;   // Aurora mode only
  readonly vpc?: IVpc;                 // Aurora mode only
}
```

Consuming stacks read `kinesisStream` and `summaryUpdaterLambda` - both modes provide them. Mode-specific fields are optional.

---

## Aurora Components

### 1. VPC Configuration

Source: the reference Aurora evaluation stack

New: `AgentEchelon/backend/lib/stacks/analytics-stack-aurora.ts`

> **VPC import support.** The stack supports BOTH creating a dedicated VPC (default) and importing an existing one. `-c analyticsVpcId=<id>` imports via `ec2.Vpc.fromLookup` so an Aurora deploy can SHARE a VPC already in the account (e.g. a sibling project's) and avoid a second VPC + endpoint footprint; `-c analyticsVpcSubnetType=isolated|private|public` (default `isolated`) picks which subnet tier of the imported VPC hosts the data plane; `-c createVpcEndpoints=false` skips the interface/gateway endpoints when the imported VPC already provides AWS-API egress (a newly created VPC is NAT-free and always builds them - `false` there is rejected at synth). A single shared `dbSubnets` selection drives Aurora, the RDS Proxy, and every in-VPC Lambda. The code below is the create-only design; the import path wraps it.

> **Teardown with an imported VPC.** Because `fromLookup` makes the VPC an imported reference (it is never in this stack's template - the `cdk-synth` test asserts `AWS::EC2::VPC` count is 0 in the import case), `cdk destroy AgentEchelonAnalyticsAurora` (pass the same `analyticsMode=aurora` + `analyticsVpcId` context used at deploy) removes only AE-created resources - Aurora, RDS Proxy, DB subnet group, AE security groups, and the endpoints AE created - and leaves the borrowed VPC, its subnets, and route tables intact. AE only ADDS resources into a borrowed VPC and never mutates the host's own subnets/SGs; the only host resource it touches is the S3 gateway endpoint's route-table entries (created only when `createVpcEndpoints=true`, removed on destroy - use `createVpcEndpoints=false` for zero host-VPC mutation). Caveats: `environment=prod` sets `RemovalPolicy.RETAIN` + `deletionProtection`, so a prod destroy ORPHANS the cluster (delete it manually); and with `enableLiveDrift=true` the per-tier stacks reference AE's DB-client SG cross-stack, so redeploy with `enableLiveDrift=false` (or destroy the tier consumers) before the Aurora stack. See the README "Teardown" subsection for the full command + verification recipe.

```typescript
const vpc = new ec2.Vpc(this, 'AnalyticsVpc', {
  maxAzs: 2,
  natGateways: 0,  // Cost optimization: VPC endpoints instead
  subnetConfiguration: [
    {
      name: 'Private',
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      cidrMask: 24,
    },
  ],
});

// Interface endpoints
new ec2.InterfaceVpcEndpoint(this, 'KinesisEndpoint', {
  vpc,
  service: ec2.InterfaceVpcEndpointAwsService.KINESIS_STREAMS,
});
new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
  vpc,
  service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
});
new ec2.InterfaceVpcEndpoint(this, 'BedrockEndpoint', {
  vpc,
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
});

// Gateway endpoint (free)
vpc.addGatewayEndpoint('S3Endpoint', {
  service: ec2.GatewayVpcEndpointAwsService.S3,
});
```

### 2. Aurora Cluster + RDS Proxy

```typescript
const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
  secretName: `${stackPrefix}/analytics-db/master`,
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: 'analyticsadmin' }),
    generateStringKey: 'password',
    excludeCharacters: '"@/\\',
    passwordLength: 32,
  },
});

const cluster = new rds.DatabaseCluster(this, 'AnalyticsDb', {
  engine: rds.DatabaseClusterEngine.auroraPostgres({
    version: rds.AuroraPostgresEngineVersion.VER_15_10,
  }),
  serverlessV2MinCapacity: 0.5,
  serverlessV2MaxCapacity: 4,
  writer: rds.ClusterInstance.serverlessV2('writer', {
    enablePerformanceInsights: true,
  }),
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  credentials: rds.Credentials.fromSecret(dbSecret),
  defaultDatabaseName: 'evaluation',
  storageEncrypted: true,
  backupRetention: Duration.days(7),
  iamAuthentication: true,
  deletionProtection: props.environment === 'prod',
});

const proxy = new rds.DatabaseProxy(this, 'AnalyticsProxy', {
  proxyTarget: rds.ProxyTarget.fromCluster(cluster),
  secrets: [dbSecret],
  vpc,
  iamAuth: true,
  dbProxyName: `${stackPrefix}-analytics-proxy`.toLowerCase(),
});
```

### 3. Schema and Migration System

Source: the reference Aurora evaluation schema (24KB, full schema)

New location: `AgentEchelon/backend/lambda/src/analytics-aurora/schema/001-initial.sql`, `002-pgvector.sql`, etc.

**Schema contents to extract:**
- `conversations` table (channel_arn, created_at, summary, status)
- `messages` table (message_id, channel_arn, content, sender_arn, metadata JSONB, created_at, is_bot)
- `exchanges` table (id, conversation_id, user_message_id, agent_message_id, latency_ms, intent, task_id, delivery_option)
- `evaluation_results` table (exchange_id, run_id, relevance_score, classification, flags, compliance)
- `intent_flows` table (task_id, agent_type, outcome_score, efficiency_score, context_retention_score)
- `agent_scores` table (agent_type, date, composite_score, violation_count)
- `conversation_summaries` table (channel_arn, purpose, name, topics, version)
- `ground_truth_scores` table (exchange_id, human_score, reasoning, scorer_id)
- `client_events` table (event_type, session_id, user_sub, event_data JSONB, created_at)
- `embeddings` table with pgvector column (`embedding vector(1024)`) and HNSW index
- Materialized views for daily metrics, agent performance, conversion funnels
- Triggers for conversation stats updates on message insert

**Migration runner Lambda:**

A new `analytics-schema-init` Lambda runs as a CDK custom resource on first deploy. It:
1. Enables `uuid-ossp` and `pgvector` extensions (requires master user)
2. Creates `rds_iam` grant for IAM authentication
3. Runs all `.sql` files in `schema/` directory in order
4. Tracks applied migrations in a `_migrations` table
5. Idempotent: re-running on subsequent deploys only applies new migrations

**Note on pgvector:** Must be pre-installed on Aurora cluster via parameter group or AWS console before migration runs. Document this as a manual prerequisite step, or wrap in CDK custom resource that calls `CREATE EXTENSION IF NOT EXISTS vector`.

### 4. IAM Auth Setup Lambda

Source: the reference IAM-auth setup Lambda

Runs once during CDK deploy as a custom resource. Grants `rds_iam` role to the application user so Lambdas can connect via IAM tokens instead of passwords.

### 5. Database Client Library

Source: the reference Aurora DB client library

Provides a shared `pg` client with:
- IAM token generation via AWS SDK
- Token caching (10 min TTL)
- Connection pooling per Lambda instance (max 5 connections)
- Automatic reconnect on 28P01 auth errors
- Query helpers for common patterns

New location: `AgentEchelon/backend/lambda/src/analytics-aurora/db-client.ts`

### 6. Archival Lambda (Kinesis → Aurora)

Source: the reference Kinesis-to-Aurora archival Lambda

Rewritten version of `AgentEchelon/backend/lambda/src/archival/*` that writes to Aurora instead of S3 via Firehose.

**Responsibilities:**
- Consume Kinesis records
- Parse Chime SDK events (CREATE_CHANNEL_MESSAGE, UPDATE_CHANNEL_MESSAGE)
- Insert into `messages` table
- In-batch exchange pairing: match user messages with bot responses
- DB-side exchange pairing: LEFT JOIN for messages that arrived in different Kinesis batches
- Extract metadata (intent, task_id, delivery_option) from Chime message metadata
- Update conversation stats via trigger

### 7. Evaluation Runner Lambda

Source: `backend/lambda/src/analytics-aurora/evaluation-runner.ts`. Scheduled
Lambda (daily 2am UTC), also directly invokable (empty payload) to re-score a
backlog on demand.

**Pass A - per-exchange relevance scoring (built).**
1. Queries unscored exchanges (`evaluation_results` LEFT JOIN, `IS NULL`), up to
   `EVAL_MAX_PER_RUN` (default 200) per run.
2. **Context-aware.** For each exchange it fetches the preceding turns of the same
   conversation (`getPriorTurns`, default 4 exchanges, oldest first) and passes
   them - plus a task marker when the exchange has a `task_id` - to the judge. The
   rubric scores the turn *in context*: a short reply ("yes"/"no"/a pronoun) that
   correctly answers the agent's own prior question is fully relevant, and a
   mid-task step is judged by its contribution to the task, not in isolation.
   This removes the isolated-exchange under-scoring bias.
3. **Deterministic marker stripping.** Both the user message and agent response
   are passed through `lib/message-markers.ts` `stripMessageMarkers` - the single
   backend source of truth mirroring the SPA parser (`frontend/utils/messageParser`):
   all `<!--...-->` control markers plus the inline `NAVIGATE_CHANNEL:<arn>|<label>`
   marker. Without it the judge scored raw markers as irrelevant. The same stripper
   runs on the analytics read paths (`evaluation_exchanges`, conversation browser),
   so the console and the judge always see exactly what the human saw.
4. Calls Bedrock (Haiku, `EVALUATOR_MODEL`) and writes one `evaluation_results`
   row per exchange (`evaluation_type = 'exchange'`): relevance score,
   classification, reasoning, agent_type, intent.

**Pass B - multi-turn flow scoring (the flow-eval runner).** Runs after Pass A in
the same invocation.
5. **Selects task flows to score.** Groups exchanges whose `task_id` is set (a
   multi-step task - e.g. a `TASK_*` report/document flow or a drift
   create/redirect confirmation) by `task_id`. To stay idempotent and
   cost-bounded it scores only flows that have **no `intent_flows` row yet, or
   whose `exchange_count` has grown** since the last score (a task gained turns),
   capped at `EVAL_MAX_FLOWS_PER_RUN` (default 100) per run. Each selected flow's
   exchanges are reconstructed in chronological order (marker-stripped, as Pass A).
6. Scores each task flow **holistically** with one Bedrock (Haiku) call across
   five weighted dimensions, and **upserts** one `intent_flows` row keyed on
   `task_id`:
   - **outcome (30%)** - did the task reach its goal
   - **information (25%)** - was the information correct and sufficient
   - **efficiency (15%)** - achieved without needless turns
   - **context retention (15%)** - did the agent carry context across turns
   - **ux (15%)** - clarity and interaction quality

   The composite is the weighted sum. It also records: `outcome` (a short judge
   label) and `outcome_details`; `status` (one of `completed`, `in_progress`,
   `abandoned`, `failed` - the same set the Flows-tab status color map uses);
   `exchange_count` (user->agent pairs), `turn_count` (individual messages,
   about twice the exchange count), `first`/`last_exchange_at`,
   `duration_seconds`, and the `exchanges` JSON summary. The Flows tab
   (`SPEC-ADMIN-CONSOLE.md` Quality > Flows) reads these rows via
   `evaluation_flows`; it renders its empty state until the flow pass has
   populated `intent_flows`.

**Not yet built (design, honest status):**
7. Daily `agent_scores` rollup with window functions.
8. Regression alerts posted to an admin channel.

Optional features (design, disabled): two-pass Haiku/Sonnet screening, error
pre-detection regexes, adversarial-aware classification, ground-truth calibration
queries.

### 8. Analytics Query Lambda

Source: the reference Aurora analytics-query Lambda

HTTP API Lambda that serves the admin dashboard. Endpoints:
- `GET /analytics/evaluation` - daily metrics materialized view
- `GET /analytics/evaluation/exchanges` - detailed exchange list with scores
- `GET /analytics/evaluation/flows` - multi-turn flow summaries
- `GET /analytics/admin-reviews` - flagged responses queue
- `GET /analytics/funnel-counts` - conversion funnel metrics
- `GET /analytics/conversations` - conversation list with summaries

### 9. Summary Updater Lambda

Source: the reference summary-updater Lambda (may need to be extracted from the reference auth-async-processor)

Called by fulfillment Lambdas after agent responses. UPSERTs `conversation_summaries` with incrementally generated purpose, name, and topics via a lightweight Bedrock call.

### 10. Client Events Lambda

Source: the reference client-events Lambda

HTTP API Lambda that ingests frontend analytics events (page views, clicks, conversion milestones) into the `client_events` table.

---

## What Aurora mode adds

### Files

```
AgentEchelon/
├── backend/
│   ├── bin/
│   │   └── backend.ts                           # analyticsMode context flag
│   ├── lib/
│   │   ├── stacks/
│   │   │   └── analytics-stack-aurora.ts        # CDK stack (VPC + Aurora + RDS Proxy)
│   │   └── interfaces/
│   │       └── analytics-stack-interface.ts     # Common interface
│   └── lambda/src/
│       └── analytics-aurora/
│           ├── db-client.ts                     # pg client with IAM auth + caching
│           ├── kinesis-archival.ts              # Kinesis consumer → Aurora
│           ├── drift-detection.ts               # Topic drift detection
│           ├── cross-conversation-context.ts    # Related conversation search
│           ├── analytics-query.ts               # HTTP API for dashboard
│           ├── schema-init.ts                   # Migration runner custom resource
│           └── schema/
│               ├── 001-initial.sql              # Core tables + indexes
│               ├── 002-pgvector.sql             # Embeddings table + HNSW index
│               └── 003-materialized-views.sql   # Daily metrics + agent performance
├── frontend/src/components/admin/
│   ├── AdminDashboard.tsx                       # Aurora mode tabs
│   ├── FlowsTab.tsx                             # Multi-turn flow evaluation
│   ├── FlaggedResponsesTab.tsx                  # Review queue + approve/reject
│   ├── GroundTruthTab.tsx                       # Human scoring + calibration
│   ├── TasksTab.tsx                             # Task metrics + detail list
│   └── ConversationsTab.tsx                     # Summaries + drift detection
└── frontend/src/types/analytics.ts             # Full type system
```

### README Additions

A new section: "Choosing an Analytics Mode"

> **Athena mode (default)** - Serverless Kinesis → Firehose → S3 → Athena pipeline. ~$5-15/month. No VPC. Slower query latency for complex analytics (3-10s). Best for: MVPs, low-volume deployments, workloads that don't need multi-turn evaluation.
>
> **Aurora mode (opt-in)** - Full Aurora PostgreSQL Serverless v2 with VPC, RDS Proxy, pgvector, materialized views. ~$50-95/month baseline. Sub-100ms query latency for complex SQL. Best for: production deployments, multi-turn evaluation, drift detection, RAG, sophisticated admin dashboards.
>
> Enable Aurora mode at deploy time:
> ```bash
> npx cdk deploy --all --context analyticsMode=aurora
> ```
>
> **Note:** Mode is chosen at deploy time. To switch modes, tear down the existing analytics stack and redeploy with the new mode. Historical Athena data in S3 is not migrated automatically.

---

## Cost Comparison

The full per-component cost model for both modes lives in the single source of truth,
[INFRASTRUCTURE-COST.md](../../guides/admin/INFRASTRUCTURE-COST.md). In summary: Athena mode has a ~$0
at-rest baseline (analytics is pay-per-query); Aurora mode adds roughly ~$50/month when importing a VPC (no
interface endpoints) to ~$95/month on a stack-created VPC, dominated by the Aurora cluster at its ACU
floor, with the optional RDS Proxy adding ~$86/month when enabled. This spec covers the VPC, subnet, and
endpoint architecture that shapes those numbers.

**When the cost is worth it:**
- You're running daily multi-turn evaluation and need interactive dashboard queries
- You need pgvector for RAG or drift detection
- You have >5,000 exchanges per month and query performance matters
- You're building toward enterprise scale and the Aurora pattern will be needed eventually

**When to stay on Athena:**
- MVP or prototype
- Low-volume deployment (<1,000 exchanges/month)
- Batch analytics acceptable (overnight queries fine)
- Cost-sensitive self-hosted deployments

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|:----------:|:------:|------------|
| VPC endpoint list incomplete, Lambda fails to reach a service | Medium | High | Deploy to fresh account and exercise every code path. Document endpoint list explicitly. |
| Lambda cold starts too slow in VPC for dashboard responsiveness | Medium | Medium | Size Lambda RAM higher (cold start scales with RAM), consider provisioned concurrency for query Lambdas, use Lambda SnapStart when available |
| pgvector prerequisite missed by consumer | High | Medium | README documents it clearly, migration runner fails fast with a clear error if extension is missing |
| Schema migration conflicts when consumer customizes | Medium | Medium | `_migrations` table tracks applied migrations by hash; custom additions go in consumer-specific migration files |
| Aurora cost surprises consumer | Medium | High | Document cost comparison prominently in README. Default stays Athena. Aurora mode requires explicit opt-in. |
| Cross-account deployment (dev/prod isolation) complicated by VPC | Low | Medium | Document pattern. VPC peering or separate VPCs per account are both viable. |
| Consumer's other Lambdas need VPC access too, triggering sprawl | Medium | Medium | Document "what Lambdas need to be in the VPC" list. Only analytics Lambdas are in-VPC; bot handlers stay out. |
| pgvector version mismatch between Aurora engine and extension | Low | Medium | Pin Aurora engine to PG 15.10 and pgvector to known compatible version |
| Historical Athena data orphaned when switching modes | High | Low | Accept: document that switching modes is a fresh start; historical data remains queryable in S3 |
| Secrets Manager cost per secret ($0.40/month) | Low | Low | Single secret for DB credentials |

---

## Rollback Plan

If Aurora mode proves problematic after launch:
1. Consumers can redeploy with `analyticsMode=athena` context, tearing down the Aurora stack and creating the Athena stack
2. Historical Aurora data is lost unless manually exported to S3 first
3. Frontend admin dashboard queries are routed to the Athena query Lambda automatically (same interface)

If a specific consumer hits a blocker but can't switch:
1. Issue a patch release that fixes the specific issue
2. The feature flag ensures other consumers aren't affected
3. CDK drift detection catches any manual fixes before the next deploy

---

## References

- Aurora Serverless v2 docs: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html
- pgvector on RDS/Aurora: https://aws.amazon.com/blogs/database/leverage-pgvector-and-amazon-aurora-postgresql-for-natural-language-processing-chatbots-and-sentiment-analysis/
