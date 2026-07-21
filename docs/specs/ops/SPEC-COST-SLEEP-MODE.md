# SPEC: Cost Sleep Mode (auto-sleep / wake)

**Status:** Implemented (Aurora-mode, opt-in `-c sleepMode=true`).

**Problem and who it's for:** A deployment nobody is using should not keep billing for always-on resources around the clock - chiefly Aurora Serverless v2's minimum ACU - yet reclaiming that spend otherwise means wiring up your own idle-detection and pause-and-wake automation. This is for the admin/operator watching per-instance cost. It auto-pauses the Aurora data plane to 0 ACU after a configurable idle period (with a manual admin wake), and doubles the paused-state record as an app maintenance flag so an asleep deployment shows a clean "paused" state instead of DB timeouts.

**Site section:** Core platform, ops (cross-cutting operations; not a pillar). **Scope:** A deploy-time opt-in that auto-pauses the Aurora data plane after a configurable idle period, and an admin/manual wake, to stop paying for an idle deployment. Aurora-mode only.

## Why

A shared dev account runs several instances of this platform. Cost is attributed per instance via the `Project` tag (see `docs/guides/admin/TAGGING.md`). The idle cost of an Aurora-mode deployment is concentrated in a few always-on resources, and an idle instance keeps paying for them 24/7.

Idle cost drivers, from how this stack actually bills when no one is using it:
- **Aurora Serverless v2** - bills its minimum ACU continuously. The dominant idle cost.
- **RDS Proxy** (only when enabled - `enableRdsProxy`, off by default) - an always-on hourly charge. The default Aurora deployment has no proxy (Lambdas connect direct to the writer endpoint with IAM auth), so this line is zero unless you opted in.
- **VPC interface endpoints** (Kinesis, Secrets Manager, Bedrock) - ~$7/mo each, always-on.
- Kinesis/Firehose - small idle cost.
- Lambda - idle is free (reserved concurrency costs nothing when uninvoked), so pausing Lambda saves nothing and is NOT part of sleep.
- Athena mode - near-zero idle cost, so sleep mode is inert there.

The primary, safe lever is **pausing Aurora Serverless v2 to 0 ACU**. The VPC endpoints (and the optional RDS Proxy, if `enableRdsProxy` was set) are left in place (tearing them down is a stack change, not a runtime toggle); their residual idle cost is documented, not shed here. This keeps sleep/wake a fast, reversible runtime action with no CloudFormation churn.

## What "sleep" does

1. Set the Aurora Serverless v2 cluster to **min = max = 0 ACU** (pause). On engine versions that support 0-ACU auto-pause this is a clean native pause; wake restores the configured ACU range.
2. Flip a `deployment-state` record to `asleep`.
3. Publish a sleep event to the SNS topic (→ email).

Wake reverses 1 - 2 (restore ACU range, state `awake`) and publishes a wake event.

The `deployment-state` record doubles as the **app maintenance flag**: the frontend + write APIs read it so an asleep deployment shows a clean "paused" state instead of raw DB timeouts.

## Triggers

- **Auto-sleep on inactivity (primary).** An EventBridge-scheduled checker Lambda runs on a fixed cadence and sleeps the deployment when `now − lastActivityAt > sleepAfterIdle`, if currently `awake`.
- **Manual admin sleep / wake.** `POST /admin/deployment/sleep` and `POST /admin/deployment/wake` (admin-authed, honoring `adminAuthMode`).
- A CloudWatch **billing-threshold** trigger is explicitly out of scope for v1 - it can call the same sleep entrypoint later.

## Activity signal

`lastActivityAt` is a timestamp in the `deployment-state` record, updated best-effort by the message path (the async processors already run on every user turn). Update is fire-and-forget and never blocks a reply. The client-events pipeline (`session_started` / `message_sent`) is a secondary source if present.

## State store

A single-item DynamoDB record (table `${INSTANCE}-deployment-state`, key `deployment-state`):

```
{ id: 'deployment-state', state: 'awake' | 'asleep', lastActivityAt: <epoch ms>, changedAt: <epoch ms>, changedBy: 'auto-idle' | 'admin:<sub>' }
```

Chosen over an SSM param so the frequent `lastActivityAt` writes don't hit SSM's low write throughput / history limits.

## Configuration (deploy-time)

| CDK context | Default | Notes |
|---|---|---|
| `sleepMode` | `false` | Master opt-in. Aurora-mode only; warns + inert in Athena. |
| `sleepAfterIdle` | `2h` | Idle threshold before auto-sleep. Accepts `30m`, `2h`, `1d`. |
| `sleepCheckRate` | `rate(15 minutes)` | EventBridge cadence for the checker. |
| `sleepRecipients` | `[]` | JSON `[{email,name}]` for SNS→email sleep/wake + billing notices (SES-verified in sandbox). |

## Stacks / wiring

Provisioned inside `AgentEchelonAnalyticsAurora` (Aurora-mode + `sleepMode=true` only):
- `deployment-state` DynamoDB table.
- Checker Lambda + EventBridge rule (`sleepCheckRate`).
- Sleep/Wake admin Lambda + API routes (behind the admin authorizer).
- Public read: `GET /deployment/state` (unauthenticated, cacheable) so the SPA can render the paused banner.
- SNS topic + email subscriptions (`sleepRecipients`).
- IAM: `rds:DescribeDBClusters` + `rds:ModifyDBCluster` scoped to the Aurora cluster ARN; DynamoDB RW on the state table; SNS publish.

The async processors get the state table name via env and update `lastActivityAt` best-effort.

## Safety / non-goals

- Never touches the VPC endpoints or the optional RDS Proxy (no CloudFormation churn at runtime).
- Never zeroes Lambda concurrency (idle Lambda is free).
- Wake is idempotent; sleeping an already-asleep (or Athena) deployment is a no-op that logs and returns 200.
- If the modify-cluster call fails, state is NOT flipped (no false "asleep" while the DB is still billing) and the failure is published to SNS.

## Validation

- `cdk synth` with `-c analyticsMode=aurora -c sleepMode=true` produces the stack; Athena mode + `sleepMode=true` warns and omits it.
- Unit: idle-math (`shouldSleep(lastActivityAt, threshold, now)`), state transitions, no-op guards.
- Live (deployer, at deploy): confirm ACU→0 on sleep (RDS console / `describe-db-clusters`), wake restores ACU, and the SPA shows the paused banner.
