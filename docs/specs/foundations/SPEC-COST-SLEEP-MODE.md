# SPEC: Cost Sleep Mode (auto-sleep / wake)

**Status:** Partial. The opt-in mode, the idle checker, the manual transitions and the failure alert are in place; the requirements table states what is delivered, what is partial and what each is validated by.

**Coverage:** `e2e/cost-sleep-mode.spec.ts`, `e2e/cost-sleep-failure-alert.spec.ts` (the manual failure alert; described below) - driving an actual sleep/wake still needs a deployment with `sleepMode=true` and an idle window, so the spec asserts the thing that must hold in EITHER configuration: the `SleepModeEnabled` stack output, the presence of `GET /deployment/state` on the person API, and whether the deployed chat SPA probes that route all agree. Route presence is read from API Gateway rather than probed over HTTP, because a 403 from a missing route and a 403 from an authorizer are indistinguishable to a client, which is how this drifts unnoticed.

**Verified by:** `backend/test/lib/sleep-mode.test.ts` (the idle decision: threshold parsing across unit spellings, a bare integer read as minutes, garbage and non-positive values returning null for the caller to default, sleeping only when awake and idle beyond the threshold, never sleeping an already-asleep deployment, and a missing or future activity stamp never triggering sleep) and `backend/test/deployment-sleep-manual-alert.test.ts` (a failed manual transition answers 500 and publishes its FAILED notice naming the transition, the state is recorded only after Aurora moves, a successful transition raises no alert, an alerting failure never replaces the failure it reports, and a non-admin caller is refused without alerting anyone).

**Related:** [SPEC-AURORA-VPC-MODE.md](./SPEC-AURORA-VPC-MODE.md) - the deployment mode whose idle cost this sheds. [INFRASTRUCTURE-COST.md](../../guides/admin/INFRASTRUCTURE-COST.md) - the single source of truth for the cost model both modes bill against. [SPEC-ABUSE-CONTROLS.md](../interaction/governance/SPEC-ABUSE-CONTROLS.md) - the other cost control, which bounds request volume rather than idle spend.

**Site section:** Foundations layer.

---

## Overview

**This mode pauses one resource, and naming which one is the whole design.** The idle cost of an Aurora-mode deployment is concentrated in Aurora Serverless v2, which bills its minimum capacity continuously whether anyone is using the deployment or not. Sleep sets that minimum to 0 and leaves everything else exactly where it is, so a transition is a fast, reversible runtime action with no CloudFormation churn.

**A paused cluster is one that will not bill for idle capacity, not one that refuses connections.** The maximum cannot be zeroed - RDS rejects a Serverless v2 maximum below 1.0 outright - so the transition moves the minimum and re-asserts the configured maximum. Anything that connects scales the cluster back up, which is what makes the platform's own schedules the limit on what this saves (Appendix B).

**Aurora moves before the flag flips, and that order is the safety property.** A transition drives the capacity change first and records the new state only once it succeeded, so a failure leaves the record unchanged rather than reporting "asleep" while the database is still billing. Both the scheduled path and the manual one publish a FAILED notice, because the moment somebody drives sleep or wake by hand is a cost incident nobody else can see.

**The paused state doubles as a maintenance flag, which is why the read is public.** `GET /deployment/state` is unauthenticated, and the chat SPA reads it when the app loads and whenever a person returns to it (the tab becomes visible, the window takes focus, the network returns) so it can render a "paused" banner rather than letting people meet raw database timeouts. It is not read on a timer: no event reaches the client when the state changes, and the deployment sleeps only after nobody has used it for the idle window, so the moment the answer matters is a person arriving or coming back (tenet D6). The route exists only when the mode is deployed, which is a foot-gun worth stating: a frontend built with the flag on against a deployment with the flag off reads a route that does not exist and takes API Gateway's 403 on each read.

**The mode is Aurora-mode only, and inert rather than broken elsewhere.** Athena mode has near-zero idle cost, so there is nothing to shed; asking for sleep mode there warns and provisions nothing.

## Business Problem

A deployment nobody is using should not bill around the clock, and on a shared account running several instances of a platform that spend is attributable and visible. The dominant line is a database cluster holding a capacity floor for traffic that is not arriving. Reclaiming it otherwise means building idle detection, a pause-and-wake control, an audit of who paused what and a way for the application to say "paused" instead of timing out - and then keeping all of that correct as the deployment grows. The operator wants one flag, a notice when the deployment changes state, and confidence that a failed pause is loud rather than silent.

## Personas

Personas are defined in [PERSONAS.md](../../overview/PERSONAS.md) and are not redefined here. Three of them meet this mode: one chooses it and lives with the bill, one meets the paused state on a screen, and one answers for the schedules that decide how much the pause is worth.

### Admin / operator

**How this relates to them:** they own what the deployment costs and whether it is available. This mode is theirs end to end: they turn it on, set the idle threshold, receive the notices, and wake the deployment by hand when they need it now rather than after the next turn.

| What they need | Requirement |
|---|---|
| One deploy-time flag, with nothing provisioned until it is set | FR1 |
| A deployment that pauses itself after a configurable idle period | FR2, FR9 |
| A manual wake that does not wait for a schedule, refused for anyone who is not an administrator | FR4 |
| A failed transition that is loud and leaves the recorded state honest | FR6 |
| Email notice on every transition, which still arrives while the deployment is asleep | FR10 |
| A transition that touches no infrastructure, so nothing is at risk in a pause | FR11, FR12 |
| A repeated sleep or wake that is a no-op rather than an error | FR7 |

### End user

**How this relates to them:** they never ask for this and only meet it as an interface that is honest about being paused rather than one that hangs.

| What they need | Requirement |
|---|---|
| A clear "paused to save cost" state instead of a database timeout | FR5 |
| Nothing at all when the mode is not deployed, rather than a broken probe | FR13 |
| Activity to bring the deployment back without anyone being called | FR3, FR8 |

### Platform developer

**How this relates to them:** they own the platform's own scheduled work, which is what connects to the cluster and scales it back up. The honest reading of what sleep saves is theirs to keep current.

| What they need | Requirement |
|---|---|
| The pause expressed as a capacity change rather than as a connection refusal, so nothing has to handle a new failure mode | FR3 |
| An activity signal on a path that already runs, fire-and-forget, never blocking a reply | FR8 |
| The schedules that defeat the pause named and measured rather than assumed | Appendix B |
| A checker that never joins the VPC or connects to the database it is pausing | FR12 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

**Mode** is the mode the requirement is expected in. Every row reads `Aurora only`: the cost this mode sheds exists only there, and nothing in it is provisioned in the default mode.

| # | Requirement | Priority | Mode | Delivered | Validated by |
|---|---|---|---|---|---|
| FR1 | A single deploy-time flag turns the mode on, nothing is provisioned until it is, and asking for it in the default analytics mode warns and provisions nothing | Table stakes | Aurora only | Yes | `cost-sleep-mode` (e2e, behavior - the stack output, the route and the SPA agree; the default-mode warning is not asserted) |
| FR2 | A scheduled checker sleeps the deployment when it has been idle longer than the configured threshold and is currently awake | Differentiator | Aurora only | Yes | `sleep-mode` (unit, behavior) |
| FR3 | Sleep sets the cluster's minimum capacity to 0 and keeps its configured maximum, and wake restores the configured floor, so a pause is a capacity change rather than a refusal of connections | Table stakes | Aurora only | Yes | none |
| FR4 | An administrator can sleep or wake the deployment on demand: the route is IAM-authorized by the `manage-deployment` capability, and the handler checks the caller again itself (`callerIsAdmin`) rather than trusting the gateway to have done it | Table stakes | Aurora only | Yes | `deployment-sleep-manual-alert` (unit, behavior) |
| FR5 | The paused state is readable without authentication so the application can render a paused state instead of a database timeout | Table stakes | Aurora only | Partly - the chat SPA renders the banner from it; no write path consults the flag before attempting work | `cost-sleep-mode` (e2e, behavior) |
| FR6 | A transition that fails leaves the recorded state unchanged and publishes a FAILED notice, on the scheduled path and the manual one alike | Differentiator | Aurora only | Yes | `deployment-sleep-manual-alert` (unit, behavior), `cost-sleep-failure-alert` (e2e, behavior) |
| FR7 | Sleeping an already-asleep deployment, or waking an awake one, is a no-op that reports no change rather than an error | Table stakes | Aurora only | Yes | `sleep-mode` (unit, behavior - the checker never sleeps an already-asleep deployment; the manual transition's no-op is asserted by nothing) |
| FR8 | Activity is recorded on a path that already runs on every message, fire-and-forget, so recording it can never block a reply | Table stakes | Aurora only | Partly - it is stamped by the archival Lambda on every archived batch of channel events, which includes messages the platform itself wrote, and the browser client-events pipeline is not a source | none |
| FR9 | The idle threshold and the checker cadence are deployment configuration, and an unparseable threshold falls back to the default rather than to "never idle" or "always idle" | Enabler | Aurora only | Yes | `sleep-mode` (unit, behavior) |
| FR10 | Every transition publishes a notice to a topic operators subscribe to by email, chosen because email still delivers while the deployment is asleep | Table stakes | Aurora only | Yes | `cost-sleep-failure-alert` (e2e, behavior, opt-in - runs only under `SLEEP_FAILURE_E2E=1` and skips when nothing fails) |
| FR11 | A transition never changes infrastructure: the VPC endpoints, the optional connection proxy and Lambda concurrency are untouched, so there is no CloudFormation churn at runtime | Enabler | Aurora only | Yes | none |
| FR12 | The checker and admin Lambda sits outside the VPC and never connects to the database it pauses, making only control-plane calls | Enabler | Aurora only | Yes | none |
| FR13 | With the mode off, the state route does not exist and the deployed application does not probe it, so a mismatched build cannot poll a route that answers 403 forever | Table stakes | Aurora only | Yes | `cost-sleep-mode` (e2e, behavior) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/` (this mode's decision logic under `backend/test/lib/`); end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Known limits on the delivered rows.** No synthesis test asserts this stack's shape, so the presence of the table, the rule, the routes and the topic rests on the end-to-end check of the deployed output and the route list. FR3's capacity values are asserted by nothing: the tests that cover a transition assert the ordering and the failure behavior, not the numbers sent to RDS. FR6's failure can only be induced with a real transition, which pauses the cluster, so its end-to-end half runs behind an explicit opt-in, always restores the deployment to awake, and skips rather than passes when no transition fails.

**OPEN:** whether the write paths should consult the maintenance flag before attempting work, which is what FR5 is written against and what "doubles as a maintenance flag" promises. Only the chat banner reads it.

**OPEN:** whether the activity signal should distinguish a person's message from a message the platform wrote. The threshold is described as an idle period, and the stamp is taken on any archived batch of channel events, so a scheduled briefing or a drift suggestion counts as activity.

**OPEN:** whether the browser client-events pipeline should be a second activity source. It is named as a candidate and is not wired.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Tearing down the VPC interface endpoints or the optional connection proxy while asleep | Those are stack resources, so removing them is a deployment rather than a runtime toggle, and a runtime action that churns CloudFormation is not reversible in seconds | Their residual idle cost is documented in [INFRASTRUCTURE-COST.md](../../guides/admin/INFRASTRUCTURE-COST.md); FR11 keeps them untouched |
| Zeroing Lambda concurrency | An idle Lambda is free, so pausing it saves nothing and only adds a way to be unavailable | FR11 |
| Pausing the platform's own schedules | It changes behavior rather than cost - a briefing that does not fire is a message somebody did not get - and a later deploy silently re-enables them | Appendix B names the schedules and what they cost the pause; disabling one is a deliberate operator action |
| A billing-threshold trigger that sleeps the deployment on spend | Cost data arrives hours late, so it cannot decide a transition in time to matter. The same entrypoint can be called by one later | [SPEC-ABUSE-CONTROLS](../interaction/governance/SPEC-ABUSE-CONTROLS.md) bounds spend at request time, which is the half that has to be immediate |
| Sleep in the default analytics mode | Near-zero idle cost, so the mechanism would carry a standing failure mode for no saving | FR1 warns and provisions nothing |
| Storing the state in SSM rather than a table | The activity stamp is written far more often than SSM's write throughput and parameter history are meant for | Appendix A, the single-item record |
| Refusing connections while asleep | The pause is a capacity floor, and a cluster that refused connections would need every caller to handle a new failure mode | FR3, and FR5 for the surface that says "paused" |

## User Experience Description and Mocks

This mode has no interface of its own beyond one banner. It is chosen at deploy time, driven by a schedule, and read as a state.

### The admin / operator's journey

1. **Turn it on at deploy, in Aurora mode** (FR1). Nothing exists until the flag is set, so the decision has no standing cost.
2. **Set the idle threshold and the checker cadence** (FR9), and subscribe the people who should hear about a transition (FR10).
3. **Let the deployment pause itself** (FR2, FR3). The checker compares the activity stamp against the threshold and, if the deployment is awake and idle, drives the capacity change and records the new state.
4. **Read the email** (FR10). A transition names what changed it - the schedule, or the administrator who asked.
5. **Wake it by hand when it is needed now** (FR4). The endpoint is IAM-authorized by the `manage-deployment` capability and checked again in the handler (`callerIsAdmin`), so a merely authenticated caller cannot pause the data plane.
6. **Trust the record, because it follows the cluster** (FR6). A failed transition answers with an error, leaves the state unchanged and publishes a FAILED notice naming which direction failed, so the thing to check is the cluster's capacity rather than the record.
7. **Repeat an action safely** (FR7). A second sleep reports no change.
8. **Read Appendix B before expecting a large saving**, because the platform's own scheduled work connects to the cluster and scales it back up.

### The end user's journey

1. **Nothing changes while the deployment is awake** (FR13). With the mode off the state route does not exist and the application does not look for it.
2. **A paused deployment says so** (FR5). The banner explains that the deployment paused to save cost, that an administrator can wake it, and that it resumes shortly after activity returns.
3. **Using it brings it back** (FR3, FR8). A connection scales the cluster up, and the activity stamp moves the idle window forward.

## Related Documents

- [SPEC-AURORA-VPC-MODE.md](./SPEC-AURORA-VPC-MODE.md) - the deployment mode this shuts down the idle floor of, and the endpoint and subnet architecture it leaves in place
- [INFRASTRUCTURE-COST.md](../../guides/admin/INFRASTRUCTURE-COST.md) - the single source of truth for the cost model of both modes, carrying the estimates-only disclaimer
- [SPEC-ABUSE-CONTROLS.md](../interaction/governance/SPEC-ABUSE-CONTROLS.md) - the cost control that bounds request volume and model spend at request time
- [TAGGING.md](../../guides/admin/TAGGING.md) - the per-instance cost attribution that makes an idle deployment's spend visible
- [TENETS.md](../../overview/TENETS.md) - tenet D6, which is why idle detection is one of the few things legitimately on a timer: the absence of an event cannot be event-sourced

## Appendix A - What a transition does

1. **Drive the cluster.** Sleep sets the Serverless v2 minimum capacity to 0; wake sets it to the configured floor. Both calls also carry the configured maximum, which is re-asserted rather than changed, because a Serverless v2 scaling configuration is set as a pair and RDS refuses a maximum below 1.0.
2. **Record the state**, but only after the cluster moved.
3. **Publish the notice** to the sleep topic, which delivers by email.

Wake is the same three steps in the other direction. A transition whose target equals the current state stops at step 1 and reports no change.

**The state record.** A single-item DynamoDB table, one row keyed `deployment-state`:

```
{ id: 'deployment-state', state: 'awake' | 'asleep', lastActivityAt: <epoch ms>, changedAt: <epoch ms>, changedBy: 'auto-idle' | 'admin:<personId>' }
```

It is a table rather than an SSM parameter because `lastActivityAt` is written by the archival consumer once per Kinesis batch of channel events, at archival time rather than on the message path, and still far more often than SSM's write throughput and parameter history allow. The activity write touches `lastActivityAt` alone and never contends on the state field, and it is fire-and-forget: a table hiccup can never block archival, and nothing on the reply path waits on it.

**The idle decision is pure and defensive.** The threshold accepts `30m`, `2h`, `1d` and a bare integer read as minutes; anything unparseable returns nothing so the caller applies its default rather than treating the deployment as permanently idle. A missing or future activity stamp reads as active now, so the deployment does not sleep, and an already-asleep deployment is never slept again.

## Appendix B - What keeps the cluster awake

**Measured on the reference deployment.** Sleep pauses Aurora; it does not stop anything that connects to Aurora. Three scheduled jobs do, on these cadences:

| Rule | Cadence | Touches Aurora |
|---|---|---|
| Abandonment detector | every 5 minutes | yes |
| Summary updater | every 30 minutes | yes |
| Evaluation runner (construct name `DailyEvaluationSchedule`) | every 30 minutes | yes |
| Membership audit | every 6 hours | no - Amazon Chime SDK |
| Proactive briefing | daily | no - it may invoke the model |

**Not measured; read from the stack definitions.** Two event-driven jobs also run while the deployment sleeps. Neither touches Aurora.

| Rule | Trigger | Touches Aurora |
|---|---|---|
| Admin conversation sync | on an admin-group change or a user deleted, disabled or re-enabled, plus a daily backstop (`adminSyncRate`) | no - Amazon Chime SDK and Cognito |
| Group-membership reconcile (per classification with a group-sourced type) | on a group change or a user deleted, disabled or re-enabled, plus a daily backstop | no - Amazon Chime SDK and Cognito |

**The platform trail is an idle cost.** With `trailDataEvents` on (the default), CloudTrail charges per data event. The Kinesis consumers poll every shard about once a second whether or not anyone is talking, and an Athena query produces one S3 data event per object it reads. Sleep pauses neither. `-c trailDataEvents=false` keeps management events only.

A connection scales the cluster back up, so on a deployment with these schedules enabled the minimum returns to 0 between runs but never stays there for long. **The five-minute detector alone is enough to keep the cluster effectively warm**, which makes the saving far smaller than "paused" suggests.

This is a gap in the design rather than a defect in the implementation. The idle decision is made from the activity stamp, so auto-sleep still fires correctly; it simply cannot keep the cluster down against the platform's own schedules. Disabling a schedule is a deliberate operator action and deliberately not part of sleep, because it changes behavior rather than cost and a later deploy silently re-enables it.

## Appendix C - What the mode provisions, and how it is configured

Everything below is created inside the Aurora analytics stack, and only when the flag is set.

| Resource | What it does |
|---|---|
| `deployment-state` DynamoDB table | the single-item state record, and the activity stamp |
| Checker and admin Lambda (`backend/lambda/src/deployment-sleep.ts`) | both entrypoints in one function, routed on event shape: a scheduled event runs the idle check, an API Gateway event serves the HTTP surface. Outside the VPC on purpose - it makes only control-plane calls and never connects to the database |
| EventBridge rule | fires the idle check on the configured cadence; a scheduled event carries no `httpMethod`, which is what selects the checker path over the HTTP surface |
| `GET /deployment/state` | public, read by the chat SPA on load and when a person returns to the tab, for the paused banner; no cache header is set on it |
| `POST /deployment/sleep`, `POST /deployment/wake` | on `AdminApi`, IAM-authorized by the `manage-deployment` capability, and checked again in the handler (`callerIsAdmin`) |
| SNS topic and email subscriptions | the transition and failure notices |
| IAM | `rds:ModifyDBCluster` scoped to the cluster ARN, plus an `rds:DescribeDBClusters` grant nothing in the handler calls, read/write on the state table, publish on the topic |
| Stack outputs | whether the mode is deployed, and the state table's name |

The archival Lambda also receives the state table name and write access, and stamps activity as it processes each batch of channel events.

| CDK context | Default | Notes |
|---|---|---|
| `sleepMode` | `false` | the master opt-in. Aurora mode only; warns and provisions nothing in the default mode |
| `sleepAfterIdle` | `2h` | idle threshold before auto-sleep. Accepts `30m`, `2h`, `1d`, or a bare integer read as minutes |
| `sleepCheckRate` | `rate(15 minutes)` | EventBridge cadence for the checker |
| `sleepRecipients` | `[]` | JSON `[{email,name}]` for the transition and failure notices. Each address is subscribed to the SNS topic, receives a confirmation email, and is delivered nothing until the recipient confirms |

The wake floor and the maximum the transition re-asserts are Lambda environment values rather than context keys, stamped by the stack at the cluster's own scaling range (`0.5` and `4`) rather than derived from it, so a deployment that widens the cluster's maximum changes both places or the first transition narrows it back.
