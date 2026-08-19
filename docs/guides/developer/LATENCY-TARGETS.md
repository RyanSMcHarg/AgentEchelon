# Latency: metric definitions, targets, and the end-to-end gap

The admin console's Latency tab reports several latency numbers, and its targets (`frontend/packages/admin/src/components/admin/metricTargets.ts` and `LatencyTab.latencyColor`) are set to published industry standards, not a self-imposed ceiling. This doc (a) defines each metric precisely - what it measures, where it is stamped, and why it matters - (b) records the targets and their basis, (c) states where the dashboard's framing misleads, and (d) specifies the missing user-to-final-answer metric.

## The metric that matters: time to first feedback (TTFF)

AgentEchelon delivers a reply in two phases (see [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 5): a placeholder ("One moment...") is sent within about a second, then the real answer updates that message in place. There is **no token streaming**: between placeholder and final answer the user sees nothing new. So the latency a user actually perceives up front is **TTFF** (time to the placeholder), not the total time to the finished answer. TTFF is the primary latency SLO; total time is a secondary throughput and cost signal.

This is why a 2-second total-latency target is the wrong lens for the console: an agentic turn runs a self-hosted tool loop (reason, call `load_company_context`, answer) with input and output guardrails, which is two or more Bedrock calls plus a retrieval. Completion in seconds is expected; the user is not waiting on it blind because the placeholder already landed.

## Metric definitions (what each number means and why it matters)

Source of truth: the processor stamps deltas into the Amazon Chime SDK message Metadata field via `buildAnalyticsMetadata` (`async-processor-core.ts`); the archival Lambda (`kinesis-archival.ts`) writes them to `messages.*` and derives `exchanges.response_latency_ms` from message timestamps; `getLatencyMetrics` (`analytics-query.ts`) aggregates them for the tab. There are two clock domains: **server wall-clock** (`Date.now()` inside one Lambda - exact deltas, no skew: `latency_ms`, `total_ms`, `poll_ms`) and **Amazon Chime SDK message timestamps** (one shared clock across messages: `response_latency_ms`).

### TTFF - `response_latency_ms` (dashboard card: "TTFF")
- **Definition:** time from the user's message to the assistant's **placeholder** appearing.
- **Measures:** the full inbound path - Amazon Chime SDK ingest, ChannelFlow, Lex, router classify, async invoke, placeholder post - **including cold start**. Stops at the placeholder, not the answer.
- **Stamp:** derived at archival, `EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000` (`am` = placeholder message, `um` = user message). Single Amazon Chime SDK clock, skew-free. `NULL` on DIRECT/unpaired rows.
- **Why it matters:** with no streaming, this acknowledgment is the only "the system is alive" signal before the answer, so it is the **perceived-responsiveness** SLO (target <= 1s). A regression means the UI feels dead on send.
- **What it does NOT tell you:** how long until a real answer. It is time-to-spinner, not time-to-content.

### Worker compute - `total_ms` (dashboard cards: "Worker compute", "P95 worker compute")
- **Definition:** server-side wall-clock to produce and post the answer, inside one processor invocation.
- **Measures:** placeholder resolution + history/context load + the Converse tool loop + the output guardrail + posting the reply. Starts at process-fn **entry**; ends right after the final `UpdateChannelMessage` returns.
- **Stamp:** `totalTime = Date.now() - startTime`, stamped `totalMs` -> `messages.total_ms`.
- **Why it matters:** the **cost/efficiency of the turn** - the number to watch for slow turns, RAG-heavy turns, and model regressions. The closest existing proxy for answer latency.
- **What it does NOT tell you (the trap):** it is NOT the user's wall-clock wait. It EXCLUDES the inbound hop, the processor's own cold-start init (before handler entry), and browser delivery. So it **understates** perceived wait, and it is stamped server-side, not tied to when the message actually updated in Amazon Chime SDK Messaging.

### Bedrock - `latency_ms` (dashboard card: "Avg Bedrock")
- **Definition:** duration of the self-hosted Converse tool loop.
- **Measures:** ALL Converse iterations + in-loop **tool execution** (RAG, S3 company context) + the **output guardrail**. Excludes placeholder resolution, history load, and delivery.
- **Stamp:** `bedrockTime = Date.now() - bedrockStart`, stamped `latencyMs` -> `messages.latency_ms`.
- **Why it matters:** the **dominant component of Worker compute** on most turns and the lever for model comparison - where the turn's time actually goes.
- **Now split:** `latency_ms` alone conflated model and tool time (a RAG-heavy turn inflated "Bedrock" without the model being slow). The dashboard now shows it split into **`model_ms`** (Avg Model) and **`tool_ms`** (Avg Tool) - see below. `latency_ms` remains the combined loop time.

### Polling - `poll_ms` (dashboard card: "Avg Polling")
- **Definition:** time spent at the start locating/confirming the placeholder message the router just created.
- **Measures:** Amazon Chime SDK polling with retries until the placeholder id resolves. A **sub-interval of Worker compute**. `0` when the placeholder id is passed directly (e.g. /battle resume).
- **Stamp:** `pollTime = Date.now() - startTime`, stamped `pollMs` -> `messages.poll_ms`.
- **Why it matters:** a **handshake artifact, not compute**. Near-zero normally; a spike points at Amazon Chime SDK message-propagation trouble, not a slow model.

### Model / Tool - `model_ms` / `tool_ms` (dashboard cards: "Avg Model", "Avg Tool")
- **Definition:** the Bedrock tool-loop time split into model inference vs in-loop tool execution.
- **Measures:** `model_ms` = the sum of the Converse (Bedrock) call durations across the loop; `tool_ms` = the time executing in-loop tools (RAG / S3 company context). `model_ms + tool_ms` is a **lower bound** on `latency_ms` - the remainder is the input/output guardrails plus loop setup/glue not attributed to either - and it reconciles only **within the successful attempt** (on a retry/fallback only the final attempt's timings are reported, the same property `latency_ms` already has).
- **Stamp:** accumulated in `invokeBedrock` (model = each `iterStart -> iterEnd`; tool = the tool-execution block), emitted out-of-band, folded onto `messages.model_ms` / `messages.tool_ms`.
- **Why it matters:** separates model time from tool time - a RAG-heavy turn shows in Tool, not as a slow model.

### E2E - `e2e_ms` (dashboard card: "E2E")
- **Definition:** time from the user's message to the **final answer** replacing the placeholder. `e2e_ms = agent_final_at - user_message_at`.
- **Measures:** the whole journey the user experiences - inbound hop + cold start + the full turn - up to the final answer. Excludes only browser delivery (sub-ms on an established socket).
- **Stamp:** `agent_final_at` is derived at archival from the Amazon Chime SDK UPDATE event's `LastUpdatedTimestamp` (same clock as the user message, so **skew-free**). Two guards keep it on the final-answer update: the `total_ms`-present gate excludes PRE-completion updates (the battle round-1 waiting-state update carries no `total_ms`), and COALESCE freezes the first completion so a LATER edit cannot move it (a moderation content-edit re-reads the same record and passes the gate, so COALESCE is what protects it). `e2e_ms` is computed on the exchange.
- **Why it matters:** **the number operators actually want** - the real answer wait an SLA or a UX complaint is about. The only metric that spans the whole user journey.

### Inbound - `inbound_ms` (dashboard card: "Inbound")
- **Definition:** user message -> async processor entry (routing / queue / cold start). `inbound_ms = processor_entry - user_message_at`.
- **Measures:** the front-of-turn hop that `total_ms` omits.
- **Stamp:** the processor emits its entry `Date.now()` out-of-band; archival computes the delta on the exchange, clamped `>= 0`.
- **Why it matters:** surfaces the routing / cold-start portion that was previously invisible. **The one metric that is not skew-free** - a server-clock entry vs an Amazon Chime SDK start, so it carries NTP skew and is approximate by design.

### Off this surface: client web-vitals
The frontend emits web-vitals (TTFB, FCP, LCP, INP, CLS) via `/events` -> `client_events` (Firehose -> S3), the only **browser-perceived** timing. It lands in a different store than the `messages` latency query and is not joined to it (gap G5). See [`SPEC-FRONTEND-OBSERVABILITY.md`](../../specs/ops/SPEC-FRONTEND-OBSERVABILITY.md).

## Where the time goes: the numbers explained by the message flow

Each latency metric maps onto a hop in the message journey (see [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md)).

| Phase (MESSAGE-FLOW) | What happens | Contributes to |
|---|---|---|
| Send + Channel Flow (section 2) | The user message is received and released; conversation-level handling | negligible (ms) |
| Fulfillment handler (section 4) | Resolve `min(callerClearance, channelClassification)`, classify intent (a fast Haiku call), resolve the model, pick a delivery mode, and RETURN THE PLACEHOLDER | **TTFF** |
| Async processor tool loop (section 6.1) | Input guardrail, then the self-hosted loop: Bedrock call (reason), `load_company_context` retrieval, Bedrock call (answer), output guardrail | **avg / p95 total** and **avg Bedrock** |
| Delivery (section 5) | `UpdateChannelMessage` swaps the placeholder for the answer | tail of total |

**Why TTFF is small and total is seconds.** The fulfillment handler returns the placeholder before any answer-generation work, so TTFF is a fast path: a tier and intent resolve plus one lightweight classification. The answer runs an **agentic tool loop**: two or more Bedrock calls plus a retrieval plus two guardrail passes. That is inherently seconds, and Bedrock generation dominates it. So a 2s total target is not reachable for an answer that reasons and calls a tool; the honest target is the Nielsen 10s attention limit, held acceptable by the placeholder.

## Reading the dashboard

The Latency tab renders the full set as distinct cards, each with a tooltip stating exactly what it brackets, so no card is left to be misread:

- **TTFF** - "time to placeholder" (acknowledgment latency), not the answer.
- **E2E** - the full user wait to the final answer (the real perceived latency); includes the inbound hop and cold start that Worker compute omits.
- **Worker compute** - the async processor's server compute only (processor entry -> answer posted); always less than E2E, NOT the user's wall-clock time.
- **Avg Model** / **Avg Tool** - the model-loop time split into model inference vs in-loop tool execution, so a RAG-heavy turn no longer reads as a slow model.
- **Inbound** - the front-of-turn routing / cold-start hop (approximate, cross-clock).
- **Avg Polling**, **P95 worker compute** - the placeholder handshake and the tail.

The header prose and the distribution rail describe the same framing, so an operator is not left to infer that Worker compute is server-only or that the model-loop number bundled tool time.

## Response-time standards

### Nielsen Norman Group response-time limits

The foundational UX thresholds (Jakob Nielsen, *Usability Engineering*, 1993) are still the standard:

| Threshold | User perception | Implication |
|---|---|---|
| 0.1s (100ms) | Instantaneous | Direct manipulation feels immediate |
| 1.0s | Noticeable delay | User stays focused; no feedback needed |
| 10s | Attention limit | Flow breaks; users may abandon |

Rule: past 1s, show a progress indicator; past 10s, show percent-done. AgentEchelon's placeholder is that progress indicator, which is what keeps a multi-second completion acceptable.

### Research-based targets

| Metric | Good | Warn | Source |
|---|---|---|---|
| Time to first feedback (TTFF) | < 1s | < 2s | Nielsen NNG |
| Time to complete response | < 10s | < 30s | Nielsen NNG (10s attention limit, ~30s abandon) |
| Placeholder display | < 500ms | < 1s | UX best practice |
| AI chatbot TTFR | < 1s excellent, < 2s good, < 5s acceptable | | 2025 AI-chatbot benchmarks |
| Bedrock time-to-first-token | 200 to 800ms typical | | AWS Bedrock |

## AgentEchelon targets (as configured)

| Console metric | Good | Warn | Basis |
|---|---|---|---|
| `ttff_ms` (time to first feedback) | <= 1s | <= 2s | Nielsen 1s focus limit. The primary UX SLO. |
| `avg_e2e_ms` (user -> final answer) | <= 10s | <= 30s | Nielsen 10s attention limit / 30s abandon. The true perceived wait (includes inbound + cold start). |
| `avg_total_ms` (server compute) | <= 10s | <= 30s | Nielsen 10s attention limit / 30s abandon. Server compute only; a lower bound on the wait. |
| `p95_total_ms` (tail) | <= 15s | <= 30s | Tail kept under the 30s abandon threshold. |
| `avg_bedrock_ms` (combined model loop) | <= 6s | <= 12s | Dominant share of the completion budget. The inference-only split lives in `model_ms` / `tool_ms` (the Avg Model / Avg Tool cards). |
| `LatencyTab.latencyColor` (table cells) | <= 10s | <= 30s | Same Nielsen time-to-complete bands. |

Note: **tune from observed data, within the standard.** Once traffic flows, set the target near a p50 you are happy with and the warn near p90, but keep both inside the Nielsen 10s / 30s envelope. The standard is the ceiling of acceptability, not the goal.

## Remaining gaps

The user->final-answer metric (former G1), the model/tool split (G2), the worker-compute relabel (G3), the inbound hop (G4), and the metadata-cap concern (G7 - latency rides the out-of-band store, not the capped field) are BUILT; see the metric definitions and "How the full set is captured." What remains:

| # | Gap | Why it matters | How to fill |
|---|-----|----------------|-------------|
| **G5** | **Server and client latency are not joined** - `messages.*_ms` vs `client_events` web-vitals live in separate stores. | No single view of server compute vs what the browser saw. | Correlate by `message_id` / `correlationId`; surface client TTFR beside server metrics. |
| ~~**G6**~~ | ~~**DIRECT fast-path excluded**~~ - **CLOSED.** `total_ms > 0` sits in `FILTER` clauses on the compute aggregates rather than the `WHERE`, so a response that ran no measurable compute is counted and attributed rather than vanishing. `compute_count` and `direct_count` state the split. | The averages are unaffected - a null contributes nothing to `AVG` either way - but they can be read against a population somebody can name. | Done. The exclusion is reported rather than performed. |
| **G8** | **Aurora-only** - no latency query in Athena mode; dropped archival events are not counted. | Coverage differs by deployment mode. | Document the mode difference; monitor archival drop rate. |
| **G9** | **P95 noise at low volume**; cold start shows in TTFF but not `total_ms`. | Early numbers unstable; TTFF/Total legitimately diverge. | Show sample counts next to P95; annotate the divergence as cold-start, not error. |
| **G10** | **Per-tier targets and metrics** - latency is targeted globally, so a premium turn (larger model, more context) is held to the same band as basic. | A basic and a premium turn have different budgets. | The `latency_metrics` query already carries `agent_type`; add per-tier bands in `metricTargets.ts` and aggregate per tier. |

## The ledger: one record of every event a latency number is derived from

**`turn_events` (migration 019), written live by `analytics-aurora/turn-events-live.ts` from the
archival batch.** Before this, latency was derived from `messages` and `exchanges` by inference, and
the inference was not stated anywhere a reader could check.

**One row per observed, timestamped fact.** Append-only, never updated. Two keys, because a turn can
have more than one responder: `turn_id` (the correlation id, one per user turn) and `response_id` (the
placeholder's Amazon Chime SDK MessageId, one per assistant response within it). A normal turn is 1 + 1; a
`/battle` is 1 turn_id + 2 response_ids.

**Finality is DECLARED, not inferred.** The producer stamps `respPhase` on every update it posts
(`ResponsePhase` in `lib/analytics-metadata.ts`, a required parameter of `updateMessage`), and only
`final` closes a turn. The mapping fails closed: an unrecognised phase becomes `progress_update`, so a
phase invented later by a component that has not been taught about latency cannot close a turn early.

| Phase | Ledger kind | Closes the turn? |
|---|---|---|
| `placeholder` | `placeholder_posted` | no - sets TTFF |
| `interim` | `progress_update` | no |
| `final` | `final_response` | **yes - the only one** |
| `error` | `error_response` | **no** - the wait ended, no answer was produced |
| `notice` | `notice_posted` | no - assistant-initiated, no user message to measure from |
| anything else | `progress_update` | no |

**What it does NOT store: message content.** Ids, timestamps, kinds and provenance only. The `turn_id`
is *derived from* content (the `<!--corr:-->` marker) but only the id is kept. The payoff is concrete:
a redaction or deletion needs no ledger mutation, so the erasure path does not grow a second place to
get wrong. Enforced by `turn-events-live.test.ts`, not merely intended.

**The audit boundary, stated rather than implied.** The outer bracket - user message -> placeholder ->
final answer - is on the Amazon Chime SDK message clock and is auditable against the message stream. The inner breakdown
(`processor_entry`, `model_ms`, `tool_ms`) is server-clock and was never in the S3 line; it is attested,
not auditable, and rows carrying it are marked `auditable = false` so no dashboard implies otherwise.

**Reading it:** `POST { queryType: 'turn_latency_audit', channelArn }` returns the calculation for one
channel, one row per response (the response's turn id is lifted across its own ledger rows, so a
live final-answer row - whose content carries no corr marker to declare a turn from - still lands
in its placeholder's row; migration 027), including the reconciliation residuals. A NEGATIVE
`unattributed_ms` means compute was attributed to the wrong turn - the bug class this exists to expose.

## Task resolution is measured separately, and never mixed in

`POST { queryType: 'task_resolution' }`, over `v_task_resolution`. `resolve_ms` decomposes into
`agent_ms` (the part the system is accountable for) and the human think time that makes up the rest.
**A task open for four hours with twenty seconds of assistant time is healthy**, and this table says so
on its face. It never enters `getLatencyMetrics` or the alert computation: one number would either
flatter the turn latency or damn the workflow.

A task's ending is recorded by the writer that ends it - a terminal entry appended to `stateHistory`
with its outcome (`success` / `failure` / `handoff`) - rather than by a separate timestamp column that
could disagree with the log beside it.

## Populations, and why the counts sit beside the averages

Three counts accompany every `latency_metrics` row, because an average whose denominator is unstated
is not a measurement:

| Column | What it counts |
|---|---|
| `exchange_count` | **Misnamed and kept for the column contract.** Bot message rows in the window - it has never counted exchanges, and there is a separate `exchanges` table it does not read |
| `compute_count` / `direct_count` | with / without measurable compute - the split the old `WHERE` performed silently |
| `closed_count` / `unclosed_count` | turns that closed, and turns whose answer never landed |

`unclosed_count` matters more since finality became declared: an errored turn correctly does NOT close,
where the old `total_ms` proxy counted it as a completion. Correct semantics shrink the population, and
this is the counter that keeps the shrink visible instead of silent.

## How the full set is captured (as built)

The complete set is captured, so the console is stable and no deployment migrates late. Two properties keep it contained:

- **Full schema up front.** All columns are in the base schema (`lambda/src/analytics-aurora/schema/013-latency.sql`), applied in order on a fresh Aurora Create: `messages.agent_final_at / model_ms / tool_ms` and `exchanges.e2e_ms / inbound_ms`, all nullable. Every deployment gets the whole set on stand-up; there is no follow-up migration.

  **How a migration reaches an existing cluster.** `schema-init` (the Custom Resource) bootstraps on Create only and can never reconnect - `IamAuthSetup` grants `rds_iam`, which disables the password auth it used. But `db-client.ensureSchema` applies any unapplied `schema/*.sql` at RUNTIME over the IAM connection, under an advisory lock, so a new migration lands on an existing cluster with no manual step. The catch: that only happens in Lambdas that CALL `ensureSchema`, so all eight Lambdas that bundle the schema files call it, pinned by `db-lambdas-apply-migrations.test.ts`. Runtime-applied migrations must be idempotent and transaction-safe (no `CREATE INDEX CONCURRENTLY`).
- **Out-of-band, off the response path.** Latency telemetry rides the out-of-band DynamoDB analytics store (`message-analytics.ts`; `async-processor-core.ts` writes it, `kinesis-archival.ts` joins it onto Aurora rows), NOT the size-capped Amazon Chime SDK messaging Metadata. Added fields cost nothing against the 1024B budget and add no user-perceived latency (measure on-path with `Date.now()`, emit off-path).

### How each is derived

| Column | Derivation | Skew |
|---|---|---|
| `exchanges.e2e_ms` (`= agent_final_at - user_message_at`) | `agent_final_at` is derived at ARCHIVAL from the Amazon Chime SDK UPDATE event's `LastUpdatedTimestamp` (the final-answer post), gated to the completion update (`total_ms` present) and frozen by COALESCE so a later moderation/battle update cannot move it. No processor emit or re-fetch. | **skew-free** (both Amazon Chime SDK) |
| `messages.model_ms` | `invokeBedrock` sums each Converse call's `iterStart -> iterEnd`. | single-invocation server clock |
| `messages.tool_ms` | `invokeBedrock` times the in-loop tool-execution block. `model_ms + tool_ms + guardrails` reconciles to `latency_ms`. | single-invocation server clock |
| `exchanges.inbound_ms` | the processor emits its entry `Date.now()`; archival computes `entry - user_message_at` on the exchange, clamped `>= 0`. | **cross-clock** (server vs Amazon Chime SDK; approximate) |

### `inbound_ms` is the one metric that is not skew-free

It brackets an Amazon Chime SDK-stamped start against a server-clock entry with no shared clock between them, so it carries NTP skew and could compute slightly negative; archival clamps it to `>= 0` and it is approximate by design. Everything else in the set is a single clock and exact.

### Capture path (as built)

1. **Schema** `013-latency.sql` - the five nullable columns above.
2. **Emit** - `finalizePlaceholderResponse` writes `modelMs`, `toolMs`, and `processorEntryMs` (the handler-entry `Date.now()`) to the out-of-band analytics record. `agent_final_at` needs no emit: archival reads it from the UPDATE event itself.
3. **Archival** (`kinesis-archival.ts` `backfillFromUpdateEvents`) - folds `model_ms` / `tool_ms` onto the message row and derives `agent_final_at`, `e2e_ms`, and `inbound_ms` on the exchange, all COALESCE-idempotent.
4. **Query** (`getLatencyMetrics`) - adds `avg_e2e_ms` / `p95_e2e_ms` (from `e.e2e_ms`), `avg_model_ms` / `avg_tool_ms` (from `m`), and `avg_inbound_ms` (from `e.inbound_ms`) to the SELECT and the columns contract, keeping `AND m.total_ms > 0`.
5. **Frontend** (`LatencyTab`) - E2E, Avg Model, Avg Tool, and Inbound cards, the worker-compute / model-loop relabels + tooltips, and the `avg_e2e_ms` target in `metricTargets.ts`. The Alerts tab reads the same `METRIC_TARGETS` registry, so a new target key only fires an alert once a matching `metricAlert` call is added in `alerts.ts` (TTFF, E2E, and P95 worker-compute are wired; all exclude task-delivery rows).

### Correctness and rollout

`e2e_ms` and the model/tool split are skew-free (a single clock each); `inbound_ms` is the sole cross-clock metric (handled above). New columns are nullable, so absent values are skipped by AVG/PERCENTILE and never wrong-valued during first traffic. No backfill. Aurora-only. Because the whole set is in the base schema, a fresh deploy gets it on Create and no operator or downstream deployer migrates later.

### Testing

**Automated (contract, mock-level).** `test/analytics-aurora/kinesis-archival-backfill.test.ts` pins the archival derivation against a MOCKED `query`: it asserts the SQL and the param positions - `agent_final_at` gated on the completion update (`total_ms` present) and frozen by COALESCE, the `e2e_ms` and clamped `inbound_ms` expressions, and the `model_ms` / `tool_ms` fold. It does NOT execute SQL, so the computed VALUES and the `model_ms + tool_ms` reconciliation are not value-tested here, and the loop-timing accumulation in `invokeBedrock` is not yet unit-covered.

**Not yet automated (pre-deploy validation).** On a live deployment, drive one slow, tool-using turn and confirm in `/analytics/latency` that `e2e_ms > total_ms > 0`, `ttff_ms > 0`, and `model_ms` / `tool_ms` are both `> 0` - the brackets distinct on real traffic. Run this as a validation step until an automated end-to-end assertion is added.

## References

1. Nielsen Norman Group, [Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/) - foundational UX research on human perception of delay.
2. [Acceptable AI response time (2025)](https://agentiveaiq.com/blog/what-is-an-acceptable-response-time-in-2025) - industry benchmarks for AI customer service.
3. [The Need for Speed in AI](https://www.uxtigers.com/post/ai-response-time) - AI-specific response-time research.
4. AWS, [Amazon Bedrock latency-optimized inference](https://aws.amazon.com/blogs/machine-learning/optimizing-ai-responsiveness-a-practical-guide-to-amazon-bedrock-latency-optimized-inference/) - Bedrock performance guidance.

## Related

- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 5 - the placeholder/update delivery pattern that makes TTFF the perceived metric.
- [`SPEC-ADMIN-CONSOLE.md`](../../specs/interface/admin/SPEC-ADMIN-CONSOLE.md) - the Latency tab and the metric-target registry.
- [`SPEC-FRONTEND-OBSERVABILITY.md`](../../specs/ops/SPEC-FRONTEND-OBSERVABILITY.md) - client-side web-vitals (the browser-perceived timing, gap G5).
- [`SPEC-MESSAGE-METADATA-CODEBOOK.md`](../../specs/interaction/conversation/SPEC-MESSAGE-METADATA-CODEBOOK.md) - the Metadata field the latency deltas ride.
