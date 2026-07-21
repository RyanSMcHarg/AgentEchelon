# SPEC - Admin Console (design)

**Status:** Design (the admin-console design; for using it, see the admin guide)

> The design behind the admin dashboard. For *using* it, see `docs/guides/admin/ADMIN-GUIDE.md`;
> for the admin identity model, `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md` and
> `docs/specs/identity-access/SPEC-MODERATION.md`; for the analytics data sources, `docs/specs/identity-access/SPEC-ACCESS-AND-CONTROLS-AUDITING.md`.

## Personas

- **Platform Administrator** - Administers an Agent Echelon instance. Owns platform
  configuration, troubleshooting, monitoring, conversation administration, and user management.
- **Platform Engineer** - Builds and maintains the AgentEchelon implementation for their
  organization. Uses the console to debug the runtime and read raw records.
- **AI Engineer** - Builds assistants inside the AgentEchelon project for their organization.
  Uses the console to evaluate assistant quality and compare models.
- **Legal Team Member** - Works for an organization that has deployed AgentEchelon. Uses the
  console for conversation review, redaction, and access auditing on a legal matter.
- **HR** - Works for an organization that has deployed AgentEchelon. Uses the console for
  conversation review and access auditing on a workplace matter.

## Use Cases

Each row maps a persona to a capability the console provides and the surface that serves it.
The identity an operator acts under, and the auditing of admin reads, are defined in
`docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md`; Legal and HR reads in particular are subject to the
accountability-logging calibration noted there.

| Persona | Use case | Served by |
|---|---|---|
| Platform Administrator | View overall platform health at a glance (traffic volume, active users, error rate) | Overview > Overview |
| Platform Administrator | See what is wrong right now - runtime errors, missed latency SLOs, and intent/model quality regressions - in one place, each linking to its drill | Overview > Alerts panel (see Alerts model) |
| Platform Administrator | Track response-latency SLOs, page web-vitals, and WebSocket connection health | Overview > Latency |
| Platform Administrator | Administer any conversation across tiers: view history, add or remove members, redact, delete | Conversations |
| Platform Administrator | Detect cross-tier membership leaks and revoke over-tier access | Security > Membership Audit |
| Platform Administrator | Manage users: approve, set tier, disable, delete | Users > Manage Users |
| Platform Administrator | Understand acquisition and engagement (DAU, messaging DAU, sign-up and sign-in funnels) | Users > Users |
| Platform Administrator | Monitor model usage, cost, latency, and human feedback | Models > Models |
| Platform Administrator | Configure and run A/B experiments and `/battle` match-ups, then read results | Experiments |
| Platform Engineer | Trace an assistant turn step by step (tool loop, tokens, cost, per-step latency) to debug it | Effectiveness drill L4 (a turn's tool-loop steps, inline) |
| Platform Engineer | Inspect the full raw stored message payload and metadata for troubleshooting | Conversations > Inspect drawer |
| Platform Engineer | Read a full conversation with its history and the context the assistant had (running summary, cross-conversation context) to debug a turn | Conversations; Models > Steps |
| Platform Engineer | Watch error rate, web vitals, and reconnect spikes as early-warning signals | Overview > Latency |
| Platform Engineer | See the documented model-routing strategy and capability catalog | Models > Model Strategy |
| AI Engineer | Review automated evaluation scores (relevance, compliance) by agent and intent | Effectiveness drill L2 (per-exchange judge verdict) |
| AI Engineer | Analyze multi-turn conversation flow quality across weighted dimensions | Effectiveness drill L3 (flow score panel) |
| AI Engineer | Triage flagged low-quality responses and approve or reject them | Effectiveness > Flagged |
| AI Engineer | Submit human ground-truth scores to calibrate the automated evaluator | Effectiveness > Ground Truth |
| AI Engineer | Compare two models head-to-head and read a ship recommendation | Experiments; Models > Models (effectiveness) |
| AI Engineer | See the full conversation context and history behind an evaluated turn (preceding turns, running summary, cross-conversation context) | Conversations; Effectiveness drill (L2 exchanges, L3 timeline + steps) |
| Legal Team Member | Review a conversation's message history and redact or delete specific messages | Conversations |
| Legal Team Member | Establish who accessed a conversation and when (membership and moderator timeline) | Conversations > Membership history; Security |
| Legal Team Member | Confirm cross-tier isolation is enforced | Security > Membership Audit |
| HR | Review a specific user's conversations for a workplace matter | Conversations |
| HR | Confirm who had access to a conversation and when | Conversations > Membership history |

## Design principles

1. **Own-bearer administration, archive-backed viewing.** The console *views* conversations
   from the **archive** (the system of record for history) and *acts* through the operator's
   **own `${sub}-admin` identity**. Each live admin action vends a per-channel,
   short-lived, audited credential from the Credential-Exchange (`identity:'admin'`) and calls
   Amazon Chime SDK directly from the browser. No server-side component holds or swaps a bearer. The
   dedicated **service** app-instance-admin exists only for no-human automation (the
   membership-audit auto-revoke path). This is the model defined in `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md`.
2. **Fewer, clearer tabs.** Navigation is **7 sections** with sub-tabs rather than a flat tab row.
3. **Dual-mode, Aurora is a strict superset.** AE runs Athena (default, cheaper) or Aurora
   (opt-in, more expensive). Aurora must **only enhance, never degrade**: every capability
   available in Athena is available in Aurora at least as well, and Aurora adds the advanced
   views (the intent-anchored Effectiveness dashboard + its drill, per-exchange evaluation, flows,
   ground truth, tasks, per-task turn timeline, execution steps, drift, model
   effectiveness, experiments, cross-conversation context). **No capability is Athena-only.**
   Aurora-added views are hidden in Athena mode with an honest "requires Aurora" note rather
   than a silently empty table.

## Navigation - 7 sections (`AdminDashboard.tsx`)

A **section rail** plus **sub-tabs** (a segmented control when a section has more than one
view). `activeTab` (a `TabId`) is the source of truth for content and data loading; `SECTIONS`
just groups the sub-views. Aurora-only sub-views are filtered out in Athena mode.

| Section | Sub-views |
|---|---|
| Overview | Overview, Latency |
| Conversations | Conversations (administration surface) |
| Effectiveness | Dashboard (the L0 intent-anchored drill) + Flagged, Ground Truth in Aurora. Evaluations, Flows, Tasks, and Steps are RETIRED as standalone sub-tabs - their detail now lives inside the Dashboard drill (L2 exchanges carry the per-exchange judge verdict = Evaluations; L2 tasks + L3 timeline = Tasks; L3 flow score = Flows; L4 inline steps = Steps). Only the two human-ACTION views (Flagged, Ground Truth) remain their own sub-tabs. |
| Models | Models, Model Strategy |
| Experiments | Experiments |
| Users | Users, Manage Users |
| Security | Membership Audit |

## Global controls

- **Date-range preset** (`7d` / `30d` / `90d`) in the dashboard header is shared by every
  analytics tab. `getDateRange(preset)` yields `{start, end}` (end = today, start = today
  minus N days); the Aurora POST shim converts the span to a `days` integer. The backend
  validates ISO dates, requires `start <= end`, and caps the window at 365 days.
- **Analytics mode badge** appears in Aurora mode. Aurora-only sub-tabs
  (`effectiveness`, `flagged`, `ground_truth`) are hidden in Athena mode.
- **Targets and alerts.** Measurement surfaces show a documented target from `metricTargets.ts`
  (see "Targets" below). `MetricCard` renders good/warn/bad; `LineChart` draws target reference
  lines. A metric sitting in **bad** status is not just coloured red: it is an **alert** (see the
  Alerts model below), surfaced in a consolidated health view rather than left for the operator to
  find tab by tab.
- **Row-level drill and mobile.** `DataTable` supports whole-ROW click (`onRowClick`), so a drill is a
  tap on the row, not on a small inline link - essential on touch. On narrow screens (<=640px) the
  table renders as a stacked card per row (label:value pairs) instead of a wide horizontally-scrolling
  grid, and the whole card is the tap target.

## Alerts (what "error" means)

"Error" in the console is broader than a thrown exception. An operator asking "what is wrong right now"
needs three kinds of condition surfaced together, and all three are the same thing underneath: **a
measured value in `bad` status against its `metricTargets.ts` threshold**, plus literal error rows.

| Alert category | What it is | Source (all already loaded client-side) |
|---|---|---|
| **Runtime error** | A sent/thrown error, failed delivery, `error_response`-classified reply, or tool-call failure | `flagged_responses` (`classification = 'error_response'`); intent rows with `tool_error_rate` in `bad`; `error_rate_daily` over target |
| **Latency SLA breach** | The perceived-latency SLO is missed | TTFF over its target; P95 / avg total over target (`latency_metrics`) |
| **Quality breach** | An intent's or a model's evaluated quality dropped below threshold | `intent_effectiveness` rows where Execution (relevance / completion) or Classification confidence is `bad`; `model_effectiveness` rows below the score band |

An **alert** is therefore any metric the target registry marks `bad` (an error) or `warn` (a lower-
severity "approaching threshold" tier), assembled by scanning the results the dashboard already holds -
no new backend query. The pure assembler is `alerts.ts` `computeAlerts(sources)` (unit-tested in
`alerts.test.ts`).

The surface is the **Alerts sub-tab** in the Overview section (`AlertsTab.tsx`): errors first then
warnings, each row stating the value vs its target and **linking to its drill** - a quality alert opens
the Effectiveness tab, a latency alert the Latency tab, a runtime error-response alert the Flagged tab,
the error-rate alert the Overview. It loads `intent_effectiveness`, `latency_metrics`,
`model_effectiveness`, `flagged_responses`, and `error_rate_daily` and reads them entirely client-side.
This supersedes the earlier posture where targets were display-only and alerting was "a separate, later
concern"; the target colours (bad/warn) on each surface remain the inline signal. (A compact "N active
issues" count on the Overview landing that links here is a natural follow-on.)

---

## Per-tab reference

Each tab lists the **data shown** (what it is for and how it is calculated) and its
**configuration and controls**. "Mode" states where the calculation is served: `both`
(Aurora is a strict superset, so every metric is served in both modes) or `Aurora only`
(a view Aurora adds, which needs relational joins or pgvector Athena cannot serve). No
metric is Athena-only. Athena reads the S3 conversation archive through Glue
tables; Aurora reads the Postgres per-message store. Client-event bands
(`active_users_daily`, `error_rate_daily`, page-load, connection-health) read the
`client_events` Glue table populated by the `/events` ingestion path and are Athena-served.

### Overview section

#### Overview tab (`OverviewTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Total messages, active conversations, active days, avg messages/day (+ volume sparkline and by-date table) | Headline traffic volume | `conversation_volumes`. Aurora: from `messages`, `COUNT(*)` filtered to message-create events and `COUNT(DISTINCT channel_arn)`, grouped by day. Athena: `COUNT(*)` over `conversations` grouped by partition (partition-only, so conversation count degrades to 0). | both (Aurora full) |
| Intent distribution (intent, count, percentage) | Traffic split by intent type | `intent_distribution`. Aurora groups real exchange `intent` (`COUNT(*)` over `exchanges`); Athena groups `conversations` by `user_type` (a coarser proxy). | both |
| Signed-in users per day, latest and peak | Session DAU (anyone who authenticated) | `active_users_daily`: `COUNT(DISTINCT user_id)` from `client_events` where `event_type='session_started'`, grouped by day and tier; frontend collapses per-tier rows to a daily total. | both |
| Messaging users per day (with percent of signed-in) | Engaged DAU (users who actually messaged) | `active_messaging_users_daily`: `COUNT(DISTINCT user_id)` where `event_type` is a messaging event (websocket-connected, message-sent, messages-listed). | both |
| Error rate trailing (+ error count and error percent) | Platform health | `error_rate_daily`: `SUM(error events) / COUNT(all events)` from `client_events`, per day. | both |

Configuration: shared date preset. Error percent card carries the `error_rate` target
(lower is better, target 1 percent, warn 5 percent). No other per-tab controls.

#### Latency tab (`LatencyTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Avg total, avg Bedrock, avg polling, p95 total (+ distribution rail and per-row table) | Response-latency breakdown across the message journey, for PERCEIVED single-reply latency | `latency_metrics`. Aurora: over `messages` joined to `exchanges` where bot and `total_ms>0`, grouped by day, agent, delivery: `AVG(total_ms)`, `AVG(latency_ms)` (Bedrock), `AVG(poll_ms)`, `PERCENTILE_CONT(0.95)` on `total_ms`, `COUNT(*)`. Athena: count-only. The headline cards **exclude multi-step TASK deliveries** (a task's `total_ms`/`poll_ms` spans the whole task, seconds to minutes, so mixing it in made Avg Polling and P95 read absurdly high) and are **traffic-weighted by `exchange_count`** (the old P95 was `Math.max` over per-group rows, so one low-traffic slow group defined "the" P95). Task end-to-end time is measured per intent under Effectiveness. | both (Aurora full) |
| Page-load web vitals (p50/p95/p99/avg per metric) | Real-user web-vital percentiles | `page_load_metrics`: over `client_events` where `record_type='performance'`, `APPROX_PERCENTILE(perf_value, ...)` grouped by metric. | both |
| WebSocket connects, disconnects, reconnects (+ per-day table) | Amazon Chime SDK/WebSocket stability; reconnect spikes as early warning | `connection_health_daily`: `SUM(CASE ...)` over `client_events` connection events, per day. | both |

Configuration: shared date preset. Card targets from `metricTargets.ts` - avg total
(target 10000ms, warn 30000ms), avg Bedrock (target 6000ms, warn 12000ms), p95 total
(target 15000ms, warn 30000ms), all lower-is-better. The trend chart draws p95 and avg
target reference lines. Latency table cells and web-vital badges use in-tab band
thresholds (latency good within the Nielsen 10s attention limit, warn to the ~30s abandon
threshold; web vitals per `WEB_VITAL_META`). See [`LATENCY-TARGETS.md`](../../guides/developer/LATENCY-TARGETS.md).

### Conversations section

#### Conversations tab (`ConversationsTab.tsx`, `MembershipTimeline.tsx`, `MessageInspectDrawer.tsx`)

The conversation administration surface. It has a **Browser** view (conversation list, messages, live members,
membership history) and a **Drift Detection** view. Viewing reads the archive through
`admin-conversations.ts` (Athena over the `conversations` Glue table); that handler holds
**no Amazon Chime SDK bearer**. Live members and every mutation run client-side under the operator's own
`${sub}-admin` identity (see below).

The full conversation view combines two sources by design: the **event archive** for a
faithful history and audit trail (messages, membership, moderator, redaction events), and the
**analytics projection** for derived context (running summary, cross-conversation context,
evaluations, drift, per-turn steps). Why the record is split across stores, and which store
answers which question, is the multi-store rationale in
[`MESSAGE-FLOW.md`](../../guides/developer/MESSAGE-FLOW.md) section 6.3.

| Data element | What it is for | How it is derived | Mode |
|---|---|---|---|
| Conversation list (name, tier, last activity) | Pick a channel to administer | `admin-conversations.ts` `listConversations`: latest name per `ChannelArn`, `MAX(CreatedTimestamp)` as last activity, tier from the archive partition, ordered by recency. | Browser |
| Messages (time, sender, intent, model, body, redacted flag) | Read a conversation | `listMessages`: per `MessageId` keep the latest row; body is decoded and unwrapped from the Lex envelope so raw Lex JSON is never shown; redacted rows render as redacted. | Browser |
| Live members (name, type, is-bot) | Current membership before an action | Amazon Chime SDK `ListChannelMemberships` called client-side as the `${sub}-admin` identity, not the archive. | Browser (live) |
| Membership history timeline | Audit who joined, left, or held moderator, and when | `membershipHistory`: archive events (create/delete membership, create/delete moderator) mapped to joined / left / granted-moderator / revoked-moderator, with `invitedBy`. Amazon Chime SDK has no history API, so the archive is the system of record. | Browser (audit) |
| Inspect drawer (content, sender ARN, timestamps, metadata, full raw payload) | Faithful per-message record for troubleshooting | Renders every stored field plus the raw archived `Payload`. | Inspect drawer |
| Drift events (detected-at, topics, drift score, suggested action, resolved) | Review topic drift in a conversation | `drift_events` from the pgvector drift store. Drift score is the cosine distance between the latest user-message embedding and the running conversation-summary embedding (Titan v2, 1024-dim); a distance over the threshold (default 0.35) is drift. An explicit routing request scores 1.0. Suggested action is continue, confirm, or redirect. | Aurora only |

**Admin actions and identity.** Every action vends a fresh, single-channel-scoped,
short-lived credential via the Credential-Exchange (`identity:'admin'`, plus the requested
`capabilities`), which returns the operator's `${sub}-admin` ARN as the `ChimeBearer`.
Authorization resolves against the operator's own standing app-instance-admin identity; there
is no server-side bearer swap. Each action emits a telemetry event.

| Action | What it does | Capability requested |
|---|---|---|
| List members | `ListChannelMemberships` (live) | `view` |
| Join visibly / invisibly | `CreateChannelMembership` (DEFAULT or HIDDEN), optional self-moderator | `manage-membership` |
| Add member | `CreateChannelMembership` for a given ARN | `manage-membership` |
| Remove member | `DeleteChannelMembership` | `manage-membership` |
| Redact | `RedactChannelMessage` (soft; body cleared, message remains) | `redact` |
| Delete | `DeleteChannelMessage` (hard, irreversible) | `delete` |

### Effectiveness section

The section landing is the **Effectiveness dashboard** (`EffectivenessTab.tsx`, Aurora-only): one row
per intent, ranked worst-first on two quality axes kept separate - Classification (`intent_effectiveness`
average confidence + reroute rate) and Execution (DIRECT intents by Pass A relevance, task intents by
completion rate) - with Latency (avg / p95), Cost per reply (tokens times the model rate, null-honest),
and Tool-error rate (from the per-step `tools[]` outcomes) as independently sortable decision columns,
all coloured against `metricTargets.ts`. A row is drillable by clicking anywhere on it (the whole row,
not just the intent link - see "Row-level drill and mobile"): L1 (its metric cards) -> L2 (its exchange
list via `intent_exchanges`, or its task list via `task_details?intent`) -> L3 (a task's turn-by-turn
state timeline via `task_timeline`) -> L4 (that turn's tool-loop steps, inline).

The Dashboard is now the **completed** consolidation surface: the detail from Evaluations, Flows, Tasks,
and Steps lives entirely inside its drill (L2 exchanges carry the per-exchange judge verdict = Evaluations;
L2 tasks + L3 timeline = Tasks; L3 `FlowScorePanel` = Flows; L4 inline steps = Steps), so those four
standalone sub-tabs are **retired from the nav** - no information is lost, it moved into the drill. Only
the two human-ACTION views, Flagged and Ground Truth, remain their own sub-tabs (§7). The per-tab
reference below still documents each folded-in detail (Evaluations / Flows / Tasks / Steps) because it
describes data now reached through the drill, and their components still back that drill. (The backing SQL
is unit-tested at the query-dispatch layer.)

#### Evaluations detail (`EvaluationsTab.tsx`) - folded into the drill (L2)

> Retired as a standalone sub-tab; the per-exchange judge verdict now renders in the Effectiveness drill
> L2 exchange list. This documents that folded-in detail; the component still backs it.

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Avg relevance (headline card) | Overall evaluation quality vs the relevance target | Count-weighted mean of per-group `avg_relevance_score`. | both |
| Per (date, agent, intent) rows: avg relevance score, count | Quality by agent and intent | `evaluation_scores`. Athena: `AVG(relevanceScore)` over `evaluation_results` grouped by day/agent/intent. Aurora: same over `exchanges` left-joined to `evaluation_results` (null when the day's exchanges are not yet evaluated, rendered as a dash). | both |
| Per-exchange detail (message, response, score, classification, reasoning, compliance, flags) | Drill into individual evaluated exchanges | `evaluation_exchanges` (Aurora): `exchanges` joined to user/agent messages and `evaluation_results`, newest first, paged. | Aurora only |

Configuration: shared date preset. Score bands via `scoreColor` (at or above 75 good, at or
above 50 warn, else bad); non-finite scores render as a dash to distinguish "not yet
evaluated" from a real zero. Read-only.

The score is **context-aware**: the evaluation runner scores each turn with the preceding
turns of the conversation and, for task turns, the task context, so a correct contextual
reply (a "yes" that answers the agent's own prior question) is not penalised as if it were
isolated. The message and response shown here are **marker-stripped** with the same
deterministic stripper the SPA uses (`stripMessageMarkers`), so the console never shows a raw
`NAVIGATE_CHANNEL`/`<!--...-->` marker and the judge scores exactly what the human saw. See
`SPEC-AURORA-VPC-MODE.md` §7 Pass A.

#### Flows detail (`FlowsTab.tsx`) - folded into the drill (L3)

> Retired as a standalone sub-tab; the multi-turn flow score now renders as the `FlowScorePanel` at
> Effectiveness drill L3. This documents that folded-in detail.

Multi-turn task-flow quality. Rows come from the `intent_flows` table, which the evaluation
runner's flow pass (`SPEC-AURORA-VPC-MODE.md` §7 Pass B) populates by grouping a conversation's
exchanges by `task_id` and scoring each task holistically across five weighted dimensions.
**Status:** the flow runner ships the scoring pass; until it has run against a deployment's
task exchanges, `intent_flows` is empty and this tab renders its empty state (it is never an
error).

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Flow rows (task id, agent, intent, exchange count, status) | Multi-turn conversation flows | `evaluation_flows`: rows from `intent_flows` in the window, newest first. | Aurora only |
| Per-flow dimension scores: outcome (30 percent), information (25 percent), efficiency (15 percent), context retention (15 percent), UX (15 percent) | Weighted multi-turn quality | The five dimension scores are selected from `intent_flows`; the weights are the flow-scoring rubric applied by the runner's flow pass. | Aurora only |

Configuration: shared date preset. Composite and status color bands; a per-row detail panel
opens the dimension breakdown from data already in memory. Read-only.

#### Flagged tab (`FlaggedResponsesTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Flagged responses (flagged-at, agent, intent, relevance score, classification, flags, review status) and expanded context (user message, agent response, reasoning, compliance categories) | Triage low-quality or non-compliant responses | `flagged_responses` (Aurora, `getFlaggedResponses`): evaluated exchanges whose classification is poor / irrelevant / `error_response`, newest first. The tab renders its empty state only when nothing was flagged in the window (a genuinely clean window, not a missing query). | Aurora only |

Configuration: shared date preset. Client-side filter (pending / reviewed / all, default
pending, with a pending count badge); severity and status color maps. **Review action**:
approve or reject with optional notes (`onReview`), which posts a review for the exchange.

#### Ground Truth tab (`GroundTruthTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Human scores count, mean absolute error, agreement rate (within 10 points) | Calibrate the automated evaluator against human labels | Client-side over scored rows: MAE is the mean absolute score delta; agreement is the share within 10 points. Source is the `ground_truth_scores` store, read by `ground_truth` (`getGroundTruth`); the tab renders its empty state only when no human labels exist yet. | Aurora only |
| Per-row: scored-at, exchange, classification, human vs automated score, delta, scorer | Individual calibration samples | As above. | (as above) |

Configuration: shared date preset. Delta and agreement color bands. **Submit-score form**
(`onSubmitScore`): exchange id, score (0-100), classification, and required reasoning; posts a
human ground-truth label for the exchange.

#### Tasks detail (`TasksTab.tsx`) - folded into the drill (L2 tasks + L3 timeline)

> Retired as a standalone sub-tab; a task list renders at Effectiveness drill L2 (`task_details?intent`)
> and a task's turn-by-turn timeline at L3 (`task_timeline`). This documents that folded-in detail.

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Total, completed, failed, completion rate (cards); per (date, type) rollup; per-task detail | Track multi-step task outcomes | Aggregated client-side from `task_metrics` and `task_details` (Aurora). `task_details` returns each task's current `task_state` (the declared-graph machine state, distinct from the `task_status` lifecycle) + `transition_count`, and accepts an optional `intent` filter (the Effectiveness L2 task list). A task's turn-by-turn timeline is served by `task_timeline`. | Aurora only |

Configuration: shared date preset. View toggle (metrics vs task list); status color map;
completion-rate bands. Read-only.

### Models section

#### Models tab (`ModelsTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Model usage (model, message count, avg latency, total tokens) | Volume, latency, and token spend per model | `model_usage`. Aurora: over `messages` where bot, grouped by model: `COUNT(*)`, `AVG(latency_ms)`, `SUM(input+output tokens)`. Athena: partition-only counts (model, latency, tokens unpopulated). | both (Aurora full) |
| Model x intent effectiveness (exchange count, avg score, avg and p95 latency, compliance rate) | Which model does best on which intent | `model_effectiveness` (Aurora): over `exchanges` joined to `messages` and `evaluation_results`, grouped by model and intent. | Aurora only |
| User feedback (thumbs up, thumbs down, feedback count, approval rate) | Human signal per model and intent | Separate call to the User-Feedback API, which aggregates the feedback DynamoDB table over the last 30 days (mode-independent). | both |

Configuration: none (read-only). Usage and effectiveness use the shared date preset;
feedback is fixed to the last 30 days.

#### Model Strategy tab (`ModelStrategyTab.tsx`)

| Data element | What it is for | Source | Mode |
|---|---|---|---|
| Provider posture cards | Provider positioning narrative | Static config (`config/modelStrategy.ts`). | static |
| Intent-routing cards (intent, primary and fallback model, preferred tier, rationale) | Which model each intent routes to and why | Static config. | static |
| Model catalog cards (provider, display name, cost and latency class, deployment notes, allowed tiers, strengths, coding fit) | Capability-first catalog of the models | Static config. | static |

Configuration: none. Presentational reference; nothing is editable here. Reflects
`docs/guides/developer/MODEL_STRATEGY.md`.

#### Steps detail (`StepsTab.tsx`) - folded into the Effectiveness drill (L4)

> Retired as a standalone sub-tab (and no longer under Models); a turn's tool-loop steps render inline at
> Effectiveness drill L4. Documented here as the tool-loop reference; the component still backs the L4 view.

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Turn list (message id, timestamp, intent, model, step count, total latency) | Turns that ran a multi-step tool loop | `execution_steps` (Aurora): over `messages` where bot and metadata has a non-empty `steps` array, newest first. | Aurora only |
| Per-step detail (label, model, tokens in and out, estimated cost, start and end, per-tool outcomes) | Debug a turn's tool loop | Each step object is read from the message metadata; duration is computed from start and end; cost was stamped at write time. Each step also carries `tools: Array<{name, ok, errorClass}>` - structured per-tool success/failure with a bounded `errorClass` (`timeout` / `not_found` / `unauthorized` / `bad_input` / `error`, never raw text or PII) - which feeds the Effectiveness `tool_error_rate`. These steps also render inline at L4 of the Effectiveness `task_timeline`. | Aurora only |

Configuration: shared date preset. A per-row expander reveals the step table from data
already loaded. Read-only.

### Experiments section

#### Experiments tab (`ExperimentsTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Active experiments (id, type, intent, status, tiers, variants, start date) | The configured experiment registry | `listExperiments()` reads the experiment config store. | both (registry) |
| Head-to-head results per variant: sample size, quality (avg score), task completion rate, latency, estimated cost per reply, compliance, fallback rate, user approval, battle wins | Compare control vs treatment | `experiment_results` (Aurora): over `exchanges` joined to `messages` and `evaluation_results` where an experiment id is set, grouped by variant and intent. The frontend re-aggregates per variant weighted by exchange count; cost is derived from average tokens and the model price; user approval and battle wins come from the feedback and battle stores. | Aurora only |
| Objective banner and recommendation (verdict, confidence, rationale) | Progress vs the advisory objective, and a ship recommendation | Objective is evaluated client-side against the experiment's target. The recommendation calls an LLM over the collapsed per-variant rows; it is descriptive only and never reroutes traffic. | Aurora only |

Configuration and actions: **Create experiment** (id, type, intent, control and treatment
models, traffic split, tiers, description, optional end date, advisory objective metric and
target), with an optional **`/battle` config** (display names, prompt addenda, per-variant
image-gen model, alt-bot slot, long-form mode). **Lifecycle**: pause, resume, complete.
**Include battle traffic** toggle re-runs the results query folding in `/battle` picks.
**Get recommendation** per experiment. Results view uses a fixed 30-day window.

### Users section

#### Users tab (`UsersTab.tsx`)

| Data element | What it is for | How it is calculated | Mode |
|---|---|---|---|
| Signed-in DAU (latest, peak, by tier, sparkline) | Session DAU, including signed-in-and-bounced | `active_users_daily` (see Overview). | both |
| Messaging DAU (latest, percent of signed-in) | Engaged cohort; the gap vs session DAU is the bounced cohort | `active_messaging_users_daily`. | both |
| Top senders leaderboard (rank, user, tier, message count) | Per-user message volume | `messages_per_user`: `COUNT(*)` over `client_events` message-sent events grouped by user, ordered descending, top 50. | both |
| Sign-up funnel and conversion | Signup step-through and conversion rate | `signup_funnel_conversion`: event and distinct-session counts per canonical signup step; conversion is confirmed sessions over form-viewed sessions. | both |
| Sign-in funnel and success | Signin step-through and success rate | `signin_funnel_conversion`: same shape over signin steps; success is succeeded over form-viewed. | both |
| Activity by tier (fallback) | Per-tier traffic when no message-sent events exist | `user_activity`: `SUM(message_count)` and active-day count over `conversations` grouped by tier, in both modes. | both |

Configuration: shared date preset. Sign-up conversion target (60 percent, warn 40) and
sign-in success target (95 percent, warn 85) from `metricTargets.ts`; funnel steps highlight
their success and failure terminals. Read-only.

#### Manage Users tab (`UserManagementTab.tsx`)

Backed by `user-management.ts`. Every route is admin-gated by `callerIsAdmin` (honors
`ADMIN_GROUP_NAMES` and service mode) and origin-checked. Users self-register in Cognito;
admins manage them.

| Action | What it does | Endpoint and effect |
|---|---|---|
| List users | Load all Cognito users and derive status (pending / approved / disabled) | `GET /users`, paginated. |
| Approve | Approve a pending user at a chosen tier | `POST /approve`: sets approved and tier, syncs the single tier group, enables the user, and provisions the member Amazon Chime SDK app-instance-user `.../user/${sub}`. |
| Reject / Disable | Reject a pending user or disable an approved one | `POST /reject`: clears approved and disables the user. |
| Re-enable | Reactivate a disabled user | `POST /enable`: enables and marks approved. |
| Change tier | Move a user between basic, standard, premium | `POST /tier`: validates the tier and syncs the single tier group. |
| Delete | Full offboard | `POST /delete`: best-effort channel-membership cleanup (as the service app-instance-admin bearer), then delete the app-instance-user and the Cognito user. Idempotent. |

Notes: this handler manages the three **tier** groups only. Admin status is the Cognito
`admins` group and is not changed here. The per-human `${sub}-admin` admin identity is
provisioned at the identity path defined in `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md`, not by this tab.

### Security section

#### Membership Audit tab (`MembershipAuditTab.tsx`)

Layer 6 of the conversation-security model (`docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md`). An auditor
Lambda consumes the same Amazon Chime SDK-to-Kinesis stream as the archive, filtered to membership
create and update events, and flags cross-tier leaks. Findings and the enforce toggle live in
one DynamoDB table; the admin API (`membership-audit-admin.ts`) is admin-gated by `requireAdmin`.

| Data element | What it is for | How it is derived |
|---|---|---|
| When | Detection time of the violation | Timestamp set when the finding is written. |
| Type | Whether the flagged subject is a human member or an assistant | `member` (a human below the channel tier) or `assistant` (a tier bot above the channel tier). |
| Subject tier | The member's or assistant's authoritative tier | Member: highest Cognito tier group. Assistant: the tier whose per-tier bot ARN matches (`resolveBotTier`). |
| Channel tier | The channel's clearance classification | From the channel's immutable `classification` tag (not the mutable `modelTier` metadata). |
| Member and channel | Which principal and which conversation | ARNs from the Kinesis membership event. |

A **member** violation is a human whose tier ranks below the channel's (they could see content
above their clearance). An **assistant** violation is a tier bot whose tier ranks above the
channel's (it would answer lower-clearance users with a higher-tier model or context, which
Layer 1's IAM tag gate does not stop). A bot ARN that matches no tier (for example a `/battle`
alt-slot) is left alone. On a violation the auditor logs a structured audit event, persists
the finding, and alerts admins (in-app message plus email fan-out).

| Control or action | What it does | Effect |
|---|---|---|
| Enforcement toggle (report only vs auto-revoke) | Runtime switch, no redeploy | `GET` and `POST /membership-audit/enforce` reads and writes the DynamoDB `config/enforce` item; the auditor reads it (short cache) and it overrides the deploy-time default. |
| Per-finding revoke | Remove the flagged membership and close the finding | `POST /membership-audit/revoke`: `DeleteChannelMembership` as the **service** app-instance-admin, then marks the finding revoked with the acting admin's sub. Idempotent. |
| `enableMembershipAudit` (deploy context) | Master on/off for Layer 6 | When unset the construct is not created and the admin API returns 503. Default off. |
| `membershipAuditEnforce` (deploy context) | Deploy-time enforce default | Sets `MEMBERSHIP_AUDIT_ENFORCE`; used only when the runtime toggle is absent. Default off. |

Auto-revoke (when enforcing) runs from the auditor itself as the service app-instance-admin.
There is no separate mark-reviewed control; a finding is closed by revoking it, and the UI
shows only open findings.

## Athena vs Aurora

Aurora is a **strict superset** of Athena (see design principle 3). Everything the Athena
default serves - conversation volumes, intent distribution, active-user and messaging bands,
error rate, latency, page web-vitals, connection health, per-user leaderboards, sign-up and
sign-in funnels, and the conversation event archive - is served in Aurora as well. Aurora then
**adds** the views that need relational joins or pgvector: the intent-anchored Effectiveness
dashboard + its drill (intents, exchanges, per-task turn timeline, steps), per-exchange evaluation,
multi-turn flows, ground truth, tasks, execution steps, drift, model effectiveness, experiment
results, and cross-conversation context. Those Aurora-added views are hidden in Athena mode with an
honest "requires Aurora" note. The conversation event archive (the history and audit source
the Conversations tab reads) exists in **both** modes as the mode-independent system of record
(see [`MESSAGE-FLOW.md`](../../guides/developer/MESSAGE-FLOW.md) section 6.3).

## Visual approach ("Precision Engineering")

Dark chrome plus light content, Geist / Geist Mono, amber accent, 13px dense, mono for IDs,
scores, and metadata. Charts are lightweight custom SVG/CSS primitives (`Sparkline`,
`FunnelChart`, `DistributionBar`, `MetricCard`, and the axis `LineChart` with target
reference lines). The inspect drawer and membership timeline reuse the modal and badge tokens.

### Targets ("what good is")

Every measurement surface shows its target, sourced from the project's documented goals via
a central registry `metricTargets.ts`:
- Latency: time-to-complete bands from Nielsen Norman Group (good within the 10s attention
  limit, warn within the ~30s abandon threshold); TTFF at or under 1s is the primary
  perceived-latency SLO. Full basis and citations in [`LATENCY-TARGETS.md`](../../guides/developer/LATENCY-TARGETS.md).
- Drift at or above 95 percent TPR and at or under 5 percent FPR from the drift-validation goal.
- Relevance at or above 75 from the AE evaluation-score bands. Web vitals from Google CWV.
- Error, reconnect, and conversion from reliability and engagement defaults (tunable).
- Effectiveness dashboard: `intent_confidence` (classification confidence, higher is better),
  `task_completion_rate` (higher), `intent_reroute_rate` (lower), `cost_per_reply` (lower), and
  `tool_error_rate` (lower) - all defaults, tunable via the registry.

`MetricCard` renders the target plus a good/warn/bad status; the reusable `LineChart` draws
target reference lines (the Latency view has an actual-vs-target SLO trend). Applied to
Latency, Overview (error percent), Evaluations (relevance), the Effectiveness dashboard
(classification, execution, cost, and tool-error columns), and Users (signup and signin
conversion).

## Related

- `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md` - who an admin is, the two-plane `${sub}` / `${sub}-admin`
  identity model, and how admin authority is vended and audited. The console's admin
  actions are the client-side realization of that model.
- `docs/specs/identity-access/SPEC-MODERATION.md` - the content-moderation surfaces (admin-action semantics live in `SPEC-ADMIN-IDENTITY.md`).
- `docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md` - the layered access model; the Security tab is Layer 6.
- `docs/specs/identity-access/SPEC-ACCESS-AND-CONTROLS-AUDITING.md` - the analytics data sources and audit events.
- `docs/guides/admin/ADMIN-GUIDE.md` - operator-facing usage.
