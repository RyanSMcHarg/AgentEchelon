# Latency metrics and targets

The admin console's Latency tab reports several latency numbers, and its targets (`frontend/packages/admin/src/components/admin/metricTargets.ts` and `LatencyTab.latencyColor`) are set to published industry standards, not a self-imposed limit. This doc (a) defines each metric precisely - what it measures, where it is stamped, and why it matters - (b) records the targets and their basis, (c) states where the dashboard's framing misleads, and (d) records the measurement gaps that remain.

## Time to first feedback (TTFF)

AgentEchelon delivers a reply in two phases (see [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 8): a placeholder ("One moment...") is sent within about a second, then the real answer updates that message in place. There is **no token streaming**: between placeholder and final answer the user sees nothing new. So the latency a user perceives up front is **TTFF** (time to the placeholder), not the total time to the finished answer. TTFF is the primary latency SLO; total time is a secondary throughput and cost signal.

This is why a 2-second total-latency target is the wrong lens for the console: an agentic turn runs a self-hosted tool loop (reason, call `load_company_context`, answer) with input and output guardrails, which is two or more Bedrock calls plus a retrieval. Completion in seconds is expected; the user is not waiting on it blind because the placeholder already landed.

## The message path

Every metric below is one span of this path. Read this first: most confusion about these numbers comes from treating a bound as a step, or a sub-step as a sibling.

```
user message                                                          final answer
     |                                                                      |
     |<---------------------------- e2e_ms -------------------------------->|
     |<-------- ttff_ms -------->|                                          |
     |                           | placeholder                              |
     |                           |<------- total_ms (worker) ------->| post |
     |                                                                      |
     |  ingest + flow + Lex  |   router_ms   |  guard | resolve |  latency_ms  | tail |
     |  (no column; bounded  |  classifier_ms|        |  poll_ms|  model + tool|      |
     |   by inbound_ms)      |  + other      |        | (if any)|              |      |
```

The `post` sliver - the analytics write and the final `UpdateChannelMessage` - is inside `e2e_ms` but outside `total_ms`, because `total_ms` is written into the metadata that update carries (see Worker compute below).

- **Nesting, not addition.** `classifier_ms` is inside `router_ms`. `poll_ms` is inside `placeholder_resolve_ms`. `model_ms` and `tool_ms` are inside `latency_ms`. Adding a parent to its own child double-counts.
- **Two legs.** The worker leg closes exactly: `total_ms = guard_ms + placeholder_resolve_ms + latency_ms + tail`, all on one clock. The front leg does not, because its start is an Amazon Chime SDK timestamp and its steps are server wall-clock; `inbound_ms` bounds it rather than dividing it.
- **`inbound_ms` is a bound.** It spans everything before the processor and therefore overlaps `router_ms` entirely. It is not a component to add alongside the others.
- **Conditional steps.** Some steps are conditional, and null means "did not happen". `poll_ms` is null when no scan ran; `classifier_ms` is null when no model was asked. Averages over these are costs *when they occur*, and each has a count beside it for how often that is.

## Metric definitions

Source of truth: the processor stamps deltas via `buildAnalyticsMetadata` (`async-processor-core.ts`) - in Aurora mode they ride the out-of-band `MESSAGE_ANALYTICS_TABLE` record, in Athena mode the Amazon Chime SDK message Metadata (see "Where it rides" below); the archival Lambda (`kinesis-archival.ts`) writes them to `messages.*`, writes the turn ledger's instants to `turn_events`, and derives `exchanges.response_latency_ms` from message timestamps; `getLatencyMetrics` (`analytics-query.ts`) aggregates them for the tab. There are two clock domains: **server wall-clock** (`Date.now()` inside one Lambda - exact deltas, no skew: `latency_ms`, `total_ms`, `poll_ms`) and **Amazon Chime SDK message timestamps** (one shared clock across messages: `ttff_ms`, `e2e_ms`, `response_latency_ms`).

**Two sources.** The Latency tab's TTFF and E2E come from the turn ledger (`v_turn_latency`, derived at read from recorded instants); every server-clock stamp on the tab comes from `messages.*`. `exchanges.response_latency_ms` and `exchanges.e2e_ms` compute the same two figures at archival and are the second opinion the shadow diff checks the ledger against. See "The shadow diff" below for how the two are kept comparable.

### TTFF (`ttff_ms`)
- **Column and console:** `v_turn_latency.ttff_ms`; the "TTFF" card.
- **Definition:** time from the user's message to the assistant's **placeholder** appearing. The **user-triggered subset of `ack_ms`** (next section), which is the same subtraction over every turn rather than only the ones a person sent.
- **Measures:** the full inbound path - Amazon Chime SDK ingest, ChannelFlow, Lex, router classify, async invoke, placeholder post - **including cold start**. Stops at the placeholder, not the answer.
- **Stamp:** derived at read, the `placeholder_posted` instant less the turn's user instant, both recorded in `turn_events`. Single Amazon Chime SDK clock, skew-free. `NULL` on a turn the ledger cannot anchor, and `NULL` by declaration on a turn nobody was waiting for (see below). On a `DIRECT` turn the first feedback IS the answer, so this equals `e2e_ms` for that row rather than being absent.
- **Anchor (G11):** `anchor_source = 'ledger'` means the ledger held the user's own message instant. `anchor_source = 'exchange'` means it fell back to the exchange pairing's `user_message_at`, which is the one door a reconstructed pairing can still reach this figure through, so `getLatencyMetrics` holds those rows out of the average unless the pairing was measured (`ttff_reconstructed_count` counts them). Which rows carry which pairing label is settled in "Measured and reconstructed pairings" below.
- **Nobody waiting:** a turn nobody waited for has no TTFF, and `NULL` is the answer. The view gates this column on the turn's DECLARED interaction kind (`user`, `handover`, `repair`, `recovery`), so a battle round-2 rebuttal - which answers a rival's answer rather than a user message - and a join recap - which catches up a person who was added and asked nothing - are excluded from the distribution rather than entering it as a zero. A join recap also answers no message, so it is never paired into an exchange and has no end to end (`answersNoMessage`). `ack_ms` is the figure that covers it, on the anchor the producer declared; the next section states what that anchor is and what its own `NULL` means.
- **Cold start (G9):** measured, not inferred. `messages.cold_start` is a module-scope flag true only on a container's first invocation, and the console shows the cold-start rate plus `avg_ttff_warm_ms`, the same TTFF over warm turns only. On a quiet window a high rate explains a slow TTFF; on a busy one it is a concurrency finding.
- **Second opinion:** `exchanges.response_latency_ms`, `EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000` (`am` = the assistant's first message for the turn, `um` = the user message), derived at archival and `NULL` on an unpaired row.
- **Moved answers:** when the answer lands in a new message, the exchange is against the ACKNOWLEDGMENT, and that is correct. A broadcast answer, a private answer and an answer displaced by the queue notice all leave the acknowledgment behind as the earlier assistant message, so both pairers take it - and its instant is the person's first feedback, which is what this figure measures. Re-pointing the exchange at the message the answer landed in would trade the turn's TTFF for its E2E, which `e2e_ms` already reports. The close-out carries the declaration and the attribution (`closeOutAttribution`: the message answered, the intent and confidence, the delivery option, the task id), so the row is attributable rather than landing in the `unknown` buckets. It carries no compute, because the turn has two message rows and every token and cost figure is summed per row.
- **Why it matters:** with no streaming, this acknowledgment is the only "the system is alive" signal before the answer, so it is the **perceived-responsiveness** SLO (target <= 1s). A regression means the UI feels dead on send.
- **What it does NOT tell you:** how long until a real answer. It is time-to-spinner, not time-to-content.

### Trigger to first signal (`ack_ms`)
- **Column and console:** `v_turn_latency.ack_ms`; the "Latency by interaction" panel and the `Ack` column of the Turn Latency Audit.
- **Definition (G13):** time from whatever caused the turn to the assistant's first signal on it. It is the GENERAL metric and `ttff_ms` is its user-triggered subset: on a turn a person sent, the two subtract the same pair of instants and read identically, which the e2e asserts.
- **Measures:** the same span TTFF measures whenever a person is waiting, plus the equivalent span on a turn nobody sent - a battle round-2 rebuttal, a repaired turn - where `ttff_ms` is `NULL` by declaration. Both end on the same `placeholder_posted` instant; only the start differs.
- **Stamp:** derived at read, `t2_placeholder_at` less `trigger_at`. `trigger_at` is the producer's DECLARED instant (`messages.trigger_at`, archived from the `triggerAtMs` the dispatcher sent) where there is one, the turn's own user instant otherwise, and the bounded reconstruction last. Amazon Chime SDK clock on both ends of a user turn; a declared instant is the producer's own reading of when the cause happened.
- **Anchor states:** `ack_source = 'declared'` covers both a producer's own instant and a real user message, because in both the anchor was OBSERVED. `ack_source = 'derived'` marks the migration-033 fallback - the most recent `final_response` by another responder in the same channel, before the placeholder and within ten minutes - which is a reconstruction and must never read as an observation. `NULL` means nothing anchored the turn at all.
- **`NULL` means unknown:** the cause is unknown, never that the reaction was instant. A producer that cannot honestly supply `triggerAt` supplies nothing and the metric stays absent (`lib/interaction-kinds.ts`). A fabricated instant would report the fastest possible reaction for exactly the turns nobody understands.
- **Interaction kinds:** `INTERACTION_KINDS` holds six kinds (`user`, `rebuttal`, `handover`, `repair`, `recovery`, `join_recap`), each with a producer; a guard fails if a name has no emitter or an emitter no name. Four of the six are kinds a person is waiting on, which is the set `ttff_ms` gates on; `rebuttal` and `join_recap` are not. A welcome, a drift offer and a briefing are deliberately absent: none is a model turn with compute to attribute.
- **Who declares an instant:** `battle-orchestrator.ts` declares one on a round-2 rebuttal and `lib/task-answer-repair.ts` declares the person's original send on a repair; the router carries a declared instant across the Lex hop as the `AE.trigger.at` request attribute so a bypass entry keeps it. A handover declares its kind and no instant on purpose: it answers a real message that pairs to an exchange, so the anchor it needs already exists on the shared Amazon Chime SDK clock and a server-clock instant would replace the better reading with a worse one.
- **Rebuttal anchor:** a rebuttal is anchored on the instant round two was triggered rather than the `/battle` message. Round two is triggered by the duel's last round-1 terminal transition: the side whose write makes every row terminal fires the orchestrator (`recordBattleTerminalAndFireOrchestrator`), so the trigger is the latest `enteredStateAt` across the duel's rows (`roundTwoTriggeredAtMs` in `battle-orchestrator.ts`), and every side of one duel declares the same instant. Anchoring on the `/battle` message would fold the whole of round 1 into round 2's figures. Anchoring on the rival's completion would fold the second-finishing side's own round-1 generation into its round 2. When any row lacks a readable stamp the orchestrator declares nothing and the round-2 figures are `NULL` for that duel. The figure is `declared` rather than derived. A rebuttal archived before this instant was declared carries its rival's round-1 completion instead: identical for the side that finished round 1 first, and earlier by the gap between the two completions for the side that finished second.
- **Why it matters:** it is the metric that covers every response, so a turn nobody sent is measured rather than missing. On a duel-heavy day the proactive share of assistant output is large, and a figure that skips it describes a minority of what the platform produced.
- **What it does NOT tell you:** whether anybody was waiting. The interaction kind says that, which is why `ack_ms` is not held against the Nielsen 1s band - `ttff_ms` carries the SLO precisely because its population is the people waiting.
- **Not `v_queue_acknowledgement.ack_ms`:** that one measures a queued message's own send to its deferral acknowledgment (migration 039, see "Deferral notices" below). Same name, different view, different population: a queued turn posts no placeholder, so it has no row here to anchor.

### Worker compute (`total_ms`)
- **Column and console:** `total_ms`; the "Worker compute" and "P95 worker compute" cards.
- **Definition:** server-side wall-clock to produce and post the answer, inside one processor invocation.
- **Measures:** admission + placeholder resolution + history/context load + prompt assembly + the Converse tool loop + the output guardrail. Starts at process-fn **entry**; ends when the answer content is assembled.
- **Excludes posting:** the stamp is taken well before the final `UpdateChannelMessage`, because the value is written into the metadata that message carries - a number cannot include the cost of its own delivery. The out-of-band analytics write sits in that gap too. So the delivery step is unmeasured on the server clock; `e2e_ms` (Amazon Chime SDK clock) is the only figure that contains it.
- **Stamp:** `totalTime = Date.now() - startTime`, stamped `totalMs` -> `messages.total_ms`.
- **Tail figure:** a traffic-weighted MEAN of per-group p95s, not the window's p95. `p95_total_ms` is computed per group inside the query, and both readers that judge it against a band combine those groups by `assistant_turn_count` through one shared averager, `weightedMetric` in `frontend/packages/admin/src/components/admin/latencyAggregate.ts` - the card in `LatencyTab.tsx` and the `lat-p95` entry in `alerts.ts`. A true overall p95 is not recoverable from per-group p95 values, so this is a per-group tail SUMMARY - stable against one small slow group, and deliberately not the single worst one. It is what the 15s/30s band in the targets table is applied to, and the number an operator should have in mind when reading that row. `p95_total_sample_count` is part of the reading (G9): each percentile carries its own sample count, the card shows it, and under roughly 20 turns the 95th percentile is close to the single slowest turn.
- **Why it matters:** the **cost/efficiency of the turn** - the number to watch for slow turns, RAG-heavy turns, and model regressions. The closest existing proxy for answer latency.
- **What it does NOT tell you (the trap):** it is NOT the user's wall-clock wait. It EXCLUDES the inbound hop, the processor's own cold-start init (before handler entry), and browser delivery. So it **understates** perceived wait, and it is stamped server-side, not tied to when the message updated in Amazon Chime SDK Messaging.

### Bedrock (`latency_ms`)
- **Column and console:** `latency_ms`; the "Model loop" marker on the worker compute distribution and the "Avg model loop" column (`avg_bedrock_ms`).
- **Definition:** duration of the self-hosted Converse tool loop.
- **Measures:** ALL Converse iterations + in-loop **tool execution** (RAG, S3 company context) + the **output guardrail**. Excludes placeholder resolution, history load, and delivery.
- **Stamp:** `bedrockTime = Date.now() - bedrockStart`, stamped `latencyMs` -> `messages.latency_ms`.
- **Why it matters:** the **dominant component of Worker compute** on most turns and the lever for model comparison - where the turn's time goes.
- **Split:** `latency_ms` alone conflates model and tool time (a RAG-heavy turn inflates "Bedrock" without the model being slow), so the dashboard also shows it split into **`model_ms`** (Model time) and **`tool_ms`** (Tool time) - see below. `latency_ms` remains the combined loop time.

### Placeholder lookup (`placeholder_resolve_ms`)
- **Column and console:** `placeholder_resolve_ms`; the "Answer target check" card.
- **Definition:** what it cost the processor to work out which message to answer on.
- **Measures:** the correlation-mapping read, plus the fallback scan when one is needed. A **sub-interval of Worker compute**. Timed from the start of resolution, so it excludes the admission work before it (see `guard_ms`).
- **Stamp:** `placeholderResolveMs` -> `messages.placeholder_resolve_ms`.
- **Why it matters:** it is the cost of the placeholder handshake, and it is the number a handshake regression moves.

### Placeholder scan (`poll_ms`)
- **Column and console:** `poll_ms` and `poll_fallback_count`; the "Placeholder scan rate" card.
- **Definition:** the **fallback scan only**, on turns where the channel flow's placeholder id did not resolve the target.
- **Measures:** Amazon Chime SDK message scanning with retries. `NULL` (not `0`) when no scan runs, which is the common case.
- **Stamp:** `pollMs` -> `messages.poll_ms`, written only when a scan runs.
- **Read it as a rate:** `poll_fallback_count` is how often a scan was needed; `AVG(poll_ms)` is what a scan costs **when it happens** (`AVG` skips the nulls). A single mean over both populations would sit between a common zero and a rare few thousand and describe no turn on the system.
- **Why it matters:** the count sits on a hard floor of zero, so a handshake regression is a step off that floor rather than a drift inside noise. That is what makes it alertable.

### Admission (`guard_ms`)
- **Column and console:** `guard_ms`; the "Turn claim" card.
- **Definition:** the processor's work before it starts looking for anything: the duplicate-delivery claim and the task-status write.
- **Measures:** `claimCorrelation` plus `updateTaskStatus` (the latter only on task turns, which is why task turns read higher here).
- **Stamp:** `guardMs` -> `messages.guard_ms`.
- **Why it matters:** it is unavoidable per-turn cost, and naming it is what lets the processor leg reconcile.

### Processor tail (`avg_processor_tail_ms`)
- **Column:** `avg_processor_tail_ms`, derived, not stamped.
- **Definition:** `total_ms - guard_ms - placeholder_resolve_ms - latency_ms`, computed only over rows that carry all four: the conversation-history load (a billed `ListChannelMessages`), prompt assembly, and long-response handling.
- **Not the update or the archival write.** Both happen after `total_ms` is stamped, so neither can be in a residual derived from it. Reading this number as "posting cost" sends optimization at the wrong code: the weight here is the history read.
- **Why it matters:** it closes the processor leg. Every millisecond of Worker compute is in a named bucket, so an unexplained residual is visible rather than absorbed.
- **Negative values:** a negative value is a finding, not a display bug. It means compute was attributed to the wrong turn, the same class `v_turn_latency.unattributed_ms` exists to expose. It is deliberately not clamped.

### Router leg (`router_ms`, `avg_router_other_ms`)
- **Column and console:** `router_ms` and `avg_router_other_ms`; the "Router" card.
- **Definition:** the router handler's own compute, from its entry to the moment it hands the turn off.
- **Measures:** intent classification, task lookups, SSM reads, the classification tag read and delivery selection. Server wall-clock, one Lambda, no skew. It stops at the hand-off, so it excludes formatting the Lex envelope.
- **Stamp:** `routerMs` -> `messages.router_ms`, carried on the dispatch because the router finishes after the payload leaves.
- **Why it matters:** the part of this span before the router posts the acknowledgment is **in front of the placeholder**, so it is inside TTFF, and it is the part of TTFF this codebase controls. The span does not end at the placeholder: the router posts the acknowledgment itself partway through and then carries on with the hand-off, so the whole span is not always inside TTFF (see "Not clamped" under Outside the router).
- `avg_router_other_ms` is `router_ms - COALESCE(classifier_ms, 0)`: the router's work other than classifying. The COALESCE is on the classifier only, so a turn that took a fast path counts its whole router span as "other", while a NULL `router_ms` stays NULL rather than having a number invented for it.

### Outside the router (`ttff_outside_router_ms`)
- **Column and console:** `ttff_outside_router_ms`, returned as `avg_ttff_outside_router_ms` with `ttff_router_paired_count` as its population; the "Reaching the router + placeholder returning" row.
- **Definition:** what of TTFF was NOT spent inside the router handler. Two hops: the message reaching the router, and the placeholder traveling back to the Amazon Chime SDK.
- **Measures:** `AVG(ttff_ms - router_ms)` taken **per row**, over the turns carrying both, with `ttff_router_paired_count` as that population. Not a difference of the two group averages, which describes no turn that ever ran (see "Same population" under Reducing TTFF).
- **Clocks:** `ttff_ms` is on the Amazon Chime SDK clock at both ends and `router_ms` is on the server clock at both ends, so each operand is a valid duration and the difference carries no offset - only relative drift, which over a span of seconds is below the millisecond this rounds to. An interval spanning two clocks carries their offset; a difference of two single-clock durations does not.
- **Not clamped:** a negative value is a finding. The router leg is not always inside TTFF: the router posts the acknowledgment ITSELF, partway through its own span, then carries on with the hand-off and the dispatch - so the span CONTAINS the placeholder rather than ending at it, and on a slow tail it exceeds TTFF outright. The console reports the overlap instead of drawing a decomposition that does not hold; clamping would file a structural finding as a fast turn.
- **What it does not divide:** the two hops inside it, on its own. On the standard path the channel flow's receipt instant splits them; see "Outside the router, split" below (G14).
- *Verified by:* `tests/e2e/ttff-decomposition.spec.ts`, which reconciles router + outside against TTFF exactly on every row where the three share a population.

### Outside the router, split (`to_flow_ms`, `flow_to_router_ms`, `placeholder_return_ms`)
- **Column and console:** `avg_to_flow_ms`, `avg_flow_to_router_ms` and `avg_placeholder_return_ms`, with `flow_split_count` as their one population; a note under the "Reaching the router + placeholder returning" row in the TTFF detail.
- **Definition:** the time outside the router in three parts, on standard-path turns. `to_flow_ms` is the message reaching the channel flow, `flow_to_router_ms` is the flow handing the turn to the router, and `placeholder_return_ms` is what is left: the placeholder travelling back to the Amazon Chime SDK.
- **Measures:** the channel flow records when it received the message (`turn_events.kind = 'flow_received'`, server clock, migration 090), and the router records its `entry` step. Per row, over the turns carrying both instants, the user message time, `ttff_ms` and `router_ms`: `to_flow_ms` = flow receipt less the user message time; `flow_to_router_ms` = router entry less flow receipt; `placeholder_return_ms` = `ttff_ms` less `router_ms` less (router entry less the user message time). The three add up to that population's time outside the router.
- **Clocks:** `to_flow_ms` spans the Amazon Chime SDK clock and the server clock, so it is approximate and the console says so. `flow_to_router_ms` is two server-clock instants from two Lambda functions.
- **Not clamped:** a negative value is a finding, as for the figure it divides.
- **Population:** standard path only. A turn entered through Amazon Lex never crosses the channel flow and carries no receipt.
- *Verified by:* `backend/test/analytics-aurora/the-hop-in-front-of-the-router-divides.test.ts` and `LatencyTab.routerSteps.test.tsx` ("splits the remainder where the channel flow recorded its receipt").

### Router steps (`v_router_steps`)
- **View and console:** `v_router_steps`; the "Router leg - where the pre-placeholder time goes" section.
- **Definition:** what each boundary of the router's pre-placeholder path cost, one row per (response, step).
- **Measures:** the boundaries `lambda/src/lib/router-steps.ts` declares - the conversation lookup, the assistant and intent pack, classification, the live-task lookup, the drift check, the ADR-033 turn claim, task creation, and the hand-off.
- **Stamp:** the router records an INSTANT per boundary and carries them on the dispatch as `routerSteps`; the archival Lambda writes one `turn_events` row per boundary (`kind='router_step'`, `step_name`, `clock='server'`, `auditable=false`) and `v_router_steps` derives `step_ms` by subtracting consecutive instants (migration 041).
- **Instants, not durations.** A stamped duration can only be believed; two instants can disagree with each other and with `router_ms`, and a disagreement is a finding. The steps of one response sum to that response's `router_ms` by construction - the first and last marks come from the same two readings of the clock the span does - so a residual that will not close is a measurement bug rather than a rounding matter.
- **Per-step denominators:** each step has its own denominator, so read the count beside the average. The router branches: a fast-path turn never classifies, a triage turn never claims, and only a task-shaped turn prepares a task. An **absent** step means the branch did not run it, never that it was free - the same rule `classifier_ms` and `poll_ms` follow.
- **Why it matters:** `avg_router_other_ms` alone is a single residual covering six subsystems, so a movement inside it has no address. This view makes the largest undivided span inside TTFF divisible: a fix measured against a number that cannot be decomposed cannot be shown to have worked.
- **Not covered:** a turn that QUEUES rather than dispatching. The log travels on the dispatch payload, and a queued turn posts a deferral notice instead of handing off, so its steps are not recorded. Its first feedback is measured (`ack_ms` via the notice), but the router leg behind it is not divided.

### Intent classification (`classifier_ms`)
- **Column and console:** `classifier_ms` and `classified_by_model_count`; the "Classifier" card.
- **Definition:** what the intent classification cost, measured by the router.
- **Measures:** the classifier model call. A **sub-step of `router_ms`, not a sibling of it.**
- **Stamp:** `classifierLatencyMs` in `intent-classifier.ts` -> carried on the dispatch as `classifierMs` -> `messages.classifier_ms`.
- **`NULL` means no model was asked**, not that nothing was measured. The pre-LLM fast paths (exact greetings and acknowledgments) and orchestrator-dispatched rebuttals classify without a model call.
- **Cost plus frequency:** `AVG` is the cost when a model is asked; `classified_by_model_count` is how often that happens. Folding the fast paths in as zeroes would make the classifier look **cheaper** the more often it is skipped, rather than **rarer**.
- **Why it matters:** it is the largest controllable step inside TTFF, and it runs before the placeholder. Whether to hold the placeholder for it is the main TTFF design question.

### Model and tool (`model_ms`, `tool_ms`)
- **Columns and console:** `model_ms` / `tool_ms`; the "Model time" and "Tool time" cards.
- **Definition:** the Bedrock tool-loop time split into model inference vs in-loop tool execution.
- **Measures:** `model_ms` = the sum of the Converse (Bedrock) call durations across the loop; `tool_ms` = the time executing in-loop tools (RAG / S3 company context). `model_ms + tool_ms` is a **lower bound** on `latency_ms` - the remainder is the input/output guardrails plus loop setup/glue not attributed to either - and it reconciles only **within the successful attempt** (on a retry/fallback only the final attempt's timings are reported, the same property `latency_ms` has).
- **Stamp:** accumulated in `invokeBedrock` (model = each `iterStart -> iterEnd`; tool = the tool-execution block), emitted out-of-band, folded onto `messages.model_ms` / `messages.tool_ms`.
- **Why it matters:** separates model time from tool time - a RAG-heavy turn shows in Tool, not as a slow model.

### E2E (`e2e_ms`)
- **Column and console:** `v_turn_latency.e2e_ms`; the "E2E" card.
- **Definition:** time from the user's message to the **final answer** replacing the placeholder.
- **Measures:** the whole journey the user experiences - inbound hop + cold start + the full turn - up to the final answer. Excludes only browser delivery (sub-ms on an established socket).
- **Stamp:** derived at read, the ledger's `final_response` instant less the turn's user instant, both on the Amazon Chime SDK message clock, so it is **skew-free**. **Finality is declared.** Only a `final_response` row closes a turn: an `error_response` and a `cancelled_response` deliberately do not, because a wait that ended without an answer must not be folded into time-to-answer. `MIN` freezes the first completion so a later moderation edit cannot move it.
- **Battle round 2:** a rebuttal's end to end is its own round's: from the instant round two was triggered (the declared `trigger_at`, see "Rebuttal anchor" above) to the rebuttal's `final_response`. `v_turn_latency` computes it for any row whose `battle_round` is past the first (migration 071), never from the person's message, and leaves it `NULL` when the turn declares no trigger. `trigger_at` is the orchestrator's server clock, so this figure crosses clocks exactly as the rebuttal's `ack_ms` does. Nobody waits on a rebuttal, so the "E2E" card filters round 2 out of `avg_e2e_ms` and `p95_e2e_ms`, and the figure is read as the "Battle round 2 (rebuttal)" row of the "Latency by interaction" panel instead, which holds every row whose `battle_round` is past the first, whatever kind it declared. *Verified by:* `backend/test/analytics-aurora/round-two-is-measured-from-its-own-trigger.test.ts` and the round-two trigger cases in `backend/test/battle-orchestrator.test.ts`.
- **Second opinion:** `exchanges.e2e_ms = agent_final_at - user_message_at`, where `agent_final_at` is derived at archival and gated on the producer's declared `respPhase`, so an interim update is harmless by construction rather than by happening to carry no telemetry. The battle round-1 clarification update, for example, carries telemetry and declares `interim`. For messages written before `respPhase` existed, the older `total_ms`-present proxy applies. COALESCE freezes the first completion there for the same reason `MIN` does in the ledger. A turn that declares itself final on its CREATE has no update to fold and takes its own `created_at`. On a later duel round it is `agent_final_at - trigger_at` instead, `NULL` without a declared trigger, and `inbound_ms` and `response_latency_ms` are `NULL`, since both are spans from the person's message. There the update fold recomputes all three rather than freezing a stored value, so a later fold converges a row an earlier writer stored by another rule. The in-batch pairer, the exchange sweep and the update fold all write it through one expression, `exchangeE2eSql` in `kinesis-archival.ts`, and migration 071 recomputes existing round-2 exchange rows that carry a `battle_id` by the same rule, in bounded batches.
- **Not partitioned by pairing:** TTFF is, and E2E is not. `avg_e2e_ms` and `p95_e2e_ms` carry no `FILTER (WHERE mp.measured)`, so a reconstructed pairing votes in them and there is no reconstructed count beside them. The anchor exposure is the same as TTFF's, and the omission is deliberate rather than overlooked - see G15.
- **No population count.** See G16: the tab's other percentiles carry a sample count and this one does not.
- **Why it matters:** **the number operators want** - the real answer wait an SLA or a UX complaint is about. The only metric that spans the whole user journey.

### Turn span (`turn_ms`)
- **Column and console:** `avg_turn_ms` and `p95_turn_ms` on every `latency_metrics` row, over `turn_measured_count` turns; each round's `avg_turn_ms` in `battle_results` (`contenders[].rounds`).
- **Definition:** time from the instant that started a turn to that turn's final post. Every assistant turn has one, including the turns no person's message anchors, so every row of the Latency grid reports a time. The one exception is a `receipt`, whose wait is its moved answer's span (see "A moved answer" below). On an ordinary turn the start is the person's message and the figure equals `e2e_ms`. `e2e_ms` stays a person's wait; this figure is every turn's own span.
- **Start, by kind of turn.** `getLatencyMetrics` picks the start from what the turn is, never from which column happens to be present, and counts each source separately (`turn_span_person_count`, `turn_span_trigger_count`, `turn_span_ack_count`, `turn_span_processor_count`, `turn_span_membership_count`, `turn_span_queue_release_count`, which partition `turn_measured_count`). A turn is timed from what actually triggered it:

| Turn | Start | End | Source |
|---|---|---|---|
| Ordinary turn, battle round 1, handover, repair, recovery | the person's message | the final answer (`v_turn_latency.e2e_ms`) | `person_message` |
| Receipt (a placeholder whose answer moved to a message of its own) | not timed: the moved answer carries the person's wait | none (`turn_ms` is `NULL`), counted in `turn_carried_by_answer_count` | `carried_by_answer` |
| Battle round 2 (rebuttal) | the orchestrator's declared round-two instant (`trigger_at`) | the rebuttal's final answer (`v_turn_latency.e2e_ms`, migration 071) | `declared_trigger` |
| Queue acknowledgment, including one written into a running answer's placeholder | the queued message the notice names (`acknowledges`, on its post or on the update that wrote it into the placeholder) | the moment the acknowledgment reached the person: its own post, or that update (the ledger's first `notice_posted`) | `acknowledged_message` |
| Join recap | the membership event of the member it is targeted at (the latest join to the conversation at or before it) | the final answer (the ledger's `final_response`, else `agent_final_at`) | `membership_event` |
| Reading (queue drain), every pass | the queue release: the instant the drain first dispatches the reading and hands it the queued work (`dispatchTriageTurn`, declared as the reading's `trigger_at`). On a handover that is the moment the holder's turn ended. A later pass carries the first pass's instant (`queueReleasedAtMs`), so a reading that posts on a later pass is still timed from the first release | the delivered message: the final answer (the ledger's `final_response`, else `agent_final_at`), else the ledger's first update of the message, which is when an interim proposal was delivered | `queue_release` |
| Any other kind whose producer declared `trigger_at`, or a join recap with no membership event on record | the declared dispatch instant | the final answer (the ledger's `final_response`, else `agent_final_at`) | `declared_trigger` |
| Drift-spawned welcome, a reading archived before it declared a trigger, and any other processor turn with no other start on record | processor entry | the moment the final post is issued (`total_ms`) | `processor_entry` |

- **Clocks.** `person_message` and `acknowledged_message` are both Amazon Chime SDK instants and skew-free. `declared_trigger` and `queue_release` run from a server-clock instant to an Amazon Chime SDK one, exactly as a rebuttal's `ack_ms` does. `processor_entry` is server clock throughout and ends before the post lands (see "Worker compute"), so it understates the span by the one update call.
- **A moved answer.** A turn that delivers its answer as a message of its own (a private answer targeted at the person, a broadcast duel answer, or an answer posted at the end because its placeholder became the queue notice) is two rows. The placeholder declares `receipt` or `queue_ack` and pairs with nothing; the answer pairs `declared` through its own `answersMessageId` and is timed as an ordinary turn from the person's message to its final answer. That is one wait, so it has one span: a `receipt` is named and listed under its own label, and its `turn_ms` is `NULL` rather than a second `person_message` span from the same message. `turn_carried_by_answer_count` counts those receipts apart from the six sources, which still partition `turn_measured_count`. A `queue_ack` placeholder is timed, because it acknowledges a different message, the queued one it names. Archival leaves an open placeholder unpaired until its first update says which of the two it became, whether it named its target in its content (a channel flow turn) or not (an Amazon Lex turn).
- **The moved answer keeps its first feedback.** `v_turn_latency` anchors a `receipt` or `queue_ack` placeholder with no exchange of its own on the exchange of the person's message it declared it answers (`anchor_source = declared_target`, migration 080), never through a swept pairing. The turn's TTFF is the placeholder's post, on that row, and `getLatencyMetrics` counts it as measured.
- **An answer written into the notice.** When posting the answer at the end fails, the answer is written into the placeholder that became the notice and declares `answeredInNotice` on its final. A `queue_ack` message that reached a final answer is the answer: archival pairs it through that final, the row is labeled as an answer, and nothing writes notice text over it: the turn takes the notice pointer off the turn-state record (conditioned on the pointer still naming that message), so the next queued message posts a fresh notice, and the settle, a drain stage, a queued message's count and a reading's note each refuse a message that reads back final. *Verified by:* `backend/test/lib/an-answer-that-moved-is-the-one-that-pairs.test.ts`.
- **NULL:** a turn whose start is known and whose end is not, such as an answer that never posted or an older rebuttal that declared no trigger. It is counted in `assistant_turn_count` and not in `turn_measured_count`, so the gap is the difference between the two, less `turn_carried_by_answer_count`, rather than a zero in the average.
- **The row label.** A row is grouped under its delivery option, else the turn's declared kind: `battle_round_N`, a declared kind (`reading`, `welcome`, `join_recap`, `drift`, `notification`, `notice`, `battle-notice`, `receipt`, `queue_ack`), `queue_ack` for a notice that declared no kind, `handover`, or a declared trigger (`rebuttal`, `repair`, `recovery`). Upper case is a delivery option and lower case is a turn kind. A turn that declared none of these on any carrier is labeled `undeclared_turn`, a named data defect that `tests/e2e/analytics-accuracy.spec.ts` fails on; no row is labeled `unknown`. The drill (`latency_exchanges`) filters on the same label.
- **Spend beside it.** Each row also carries `tokens_in`, `tokens_out`, the classifier's tokens, `token_measured_count`, and `cost_usd` over `cost_priced_turns`, priced per model by the rate table. These cover every turn in the row, paired or not, which the exchange-based cost panels do not.
- **Battle rounds.** `battle_results` reads every round from the bot messages carrying the duel's id and a round, so a round counts whether or not it paired. Each round is credited to the side it declared (`messages.variant_id`, else its exchange's), with its turn count, span, tokens and cost; a round that named no side is counted as `unattributed_round_turns`. *Verified by:* `backend/test/analytics-aurora/every-turn-is-named-and-measured.test.ts`.
- **Why it matters:** every turn spends tokens and time. A turn with no time on record is a cost nobody can see, and a duel's round two is watched by the person even though nobody is waiting on it.

### Inbound (`inbound_ms`)
- **Column and console:** `inbound_ms`; the "Inbound" card.
- **Definition:** user message -> async processor entry. `inbound_ms = processor_entry - user_message_at`.
- **Measures:** everything in front of the processor, as ONE figure: Amazon Chime SDK ingest, the channel flow, Lex, the whole router (classification included) and the dispatch, plus the processor's own cold start.
- **Stamp:** the processor emits its entry `Date.now()` out-of-band; archival computes the delta on the exchange, clamped `>= 0`.
- **A bound, not a step.** Because the processor is dispatched at roughly the instant the placeholder is returned, `inbound_ms` tracks TTFF almost exactly rather than decomposing it. It cannot tell you which of the three hops to fix. Use `router_ms` and `classifier_ms` for that; what those two do not account for is the pre-router hop (Amazon Chime SDK ingest, the channel flow and Lex) plus the placeholder's trip back.
- **Not skew-free.** It is the one metric that is not: a server-clock entry against an Amazon Chime SDK start, so it carries NTP skew and is approximate by design. That is also why the pre-router hop is left as prose here rather than published as a column: a residual taken across a clock boundary is an estimate, not a measurement.

### Residuals (`answer_ms`, `unattributed_ms`, `overhead_ms`)
- **Columns:** `answer_ms`, `unattributed_ms`, `overhead_ms`, in the Turn Latency Audit.
- **Definition:** three per-response figures the audit shows beside the instants they are derived from. `answer_ms` is the final answer less the placeholder, so it is the half of E2E the person spends watching a placeholder. `unattributed_ms` is E2E less `inbound_ms` less `total_ms`: the part of the wait no bracket claimed. `overhead_ms` is `total_ms` less `latency_ms` less `poll_ms`: the part of worker compute the model loop and the scan do not explain.
- **Stamp:** all three derived at read in `v_turn_latency`, never stamped, so none can drift from the figures it is defined against. A missing component counts as zero in the two subtractions and the parent stays `NULL` when it has none, so an absent measurement narrows a residual rather than voiding it.
- **Negative values:** a negative residual is a finding, not a display bug. It means compute was attributed to the wrong turn, which is the bug class the ledger exists to expose, so neither is clamped.
- **Why they matter:** they are the audit's reconciliation, per response. The aggregate form of the same idea is `avg_processor_tail_ms` on the Latency tab; these say it for one turn an operator is looking at.
- **Not SLO metrics.** Nothing in `metricTargets.ts` or `alerts.ts` reads them, and no band applies: a residual is judged against zero, not against a response-time limit.

### Browser timing
The browser measures its own time-to-placeholder, and `client_server_latency` (`getClientServerLatency` in `analytics-query.ts`) pairs it with the server's figure for ONE turn (G5): the client reads the correlation marker off the placeholder it just rendered and sends it with the timing. `delivery_gap_ms` is what the browser waited minus what the server measured - the WebSocket hop plus render that no server bracket can see. A negative gap is returned rather than clamped: the two clocks disagree, or the client timed from a send the server paired to a different turn, and either is a finding.

The frontend also emits web-vitals (TTFB, FCP, LCP, INP, CLS) via `/events` -> `client_events` (Firehose -> S3). Those land in a different store than the `messages` latency query and are not joined to it. See [`SPEC-FRONTEND-OBSERVABILITY.md`](../../specs/interface/SPEC-FRONTEND-OBSERVABILITY.md).

## Where the time goes

Each latency metric maps onto a hop in the message journey (see [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md)).

| Phase (MESSAGE-FLOW) | What happens | Contributes to |
|---|---|---|
| Send + Channel Flow (sections 3 and 4) | The user message is received and released; conversation-level handling | negligible (ms) |
| Agent handler (section 6) | Resolve the channel's classification, classify intent (a fast Haiku call), resolve the model, pick a delivery mode, and RETURN THE PLACEHOLDER | **TTFF**, and `ack_ms` with it: on a user turn both end here and both start at the same message |
| Battle round 2 (section 6.1, fired by `battle-orchestrator.ts`) | The orchestrator sees both sides finish round 1 and dispatches each rebuttal with the instant round two was triggered | **`ack_ms` and its own `e2e_ms`**, both from that instant. No user message, so `ttff_ms` is `NULL` by declaration and the rebuttal leaves the perceived-latency population, including the headline E2E |
| Task-answer repair (section 10.2) | Post-processing notices a task answer nobody routed and re-drives it, declaring the person's original send | **`ack_ms` and `ttff_ms`**, both anchored on that send, so the stream hop and the detection delay stay inside the figure rather than being skipped |
| Async processor tool loop (section 7.8) | Input guardrail, then the self-hosted loop: Bedrock call (reason), `load_company_context` retrieval, Bedrock call (answer), output guardrail | **avg / p95 total** and **avg Bedrock** |
| Delivery (section 7.12) | `UpdateChannelMessage` swaps the placeholder for the answer | `e2e_ms` only - `total_ms` is stamped before this step |

**Ack vs TTFF.** The two middle rows are where `ack_ms` and `ttff_ms` part company. A repair is a person who is still waiting and has been since before the turn that failed to route, so it keeps the perceived-latency SLO and lands in both figures; a rebuttal answers another assistant, so it is measured by `ack_ms` and held out of the SLO population. Which of the two a turn is comes from the interaction kind its dispatcher DECLARED, never from whether an exchange happened to pair.

**Why total is seconds.** The answer runs an **agentic tool loop**: two or more Bedrock calls plus a retrieval plus two guardrail passes. That is inherently seconds, and Bedrock generation dominates it. So a 2s total target is not reachable for an answer that reasons and calls a tool; the realistic target is the Nielsen 10s attention limit, held acceptable by the placeholder.

**No fast path.** TTFF is not a fast path, and that is the finding. The fulfillment handler returns the placeholder as its Lex response, so the placeholder cannot exist until the handler is finished. Everything the handler does is therefore in front of the first frame: the classification tag read, the SSM reads, the intent classification (a Bedrock call), the live-task lookup, the drift check and the ADR-033 turn claim. `router_ms` measures that whole span, and it is the largest thing inside TTFF.

## Reducing TTFF

Read this with "The message path" above: everything here is inside `ttff_ms`, and `v_router_steps` (migration 041) is what says how much each item costs on a given deployment. The list below is the SHAPE of the problem and carries no sizes on purpose; a deployment reads its own from the Latency tab's "Router leg" section before deciding what to change. Like the rest of this surface it is Aurora-only (see G8), so an Athena-mode deployment has `router_ms` and no breakdown of it.

**Fixed point.** The placeholder is the fulfillment return. On the Amazon Lex path the Amazon Chime SDK materializes the placeholder from what the handler returns, so the placeholder cannot exist until the handler is finished. On the bypass path `postAsAssistant` sends it with `SendChannelMessage` after the turn completes. The mechanisms differ; the ordering does not, and the ordering is deliberate rather than incidental (see "Placeholder-first (rejected)" below).

So TTFF is reduced by making the handler do LESS before it returns, not by returning earlier. Two inputs to the answer run in the processor rather than the router, and four steps stay in front of the return because the return depends on them:

| # | Step | Why it matters | Where it runs |
|---|---|---|---|
| 1 | **Retrieval and the conversation summary** | The router holds the classification and the channel, so it could fetch them and hand them over on the dispatch | **The processor** (`lib/turn-grounding.ts`). They are inputs to the ANSWER, and the processor has the same channel, classification, intent and message. Started at the top of that handler, so it overlaps the placeholder wait: the same end-to-end time, off the metric the SLO is about |
| 2 | **`rememberHolderMessage` and the `ListChannelMessages` behind it** | A queue drain needs a description of the work in flight, and Lex is not given the inbound MessageId, so it is recovered by matching message content | **The processor.** The router hands over the DECISION - this turn claimed, so it owes the record - plus the id when it already has one. The drain reads the value seconds later, so the write does not belong on the turn's critical path |
| 3 | **The channel classification tag read**, made once by the flow and again by the router | Governance: every live classification decision reads the immutable tag, and it fails closed. It selects the processor, the assistant identity and the model allow-list | **The router; it cannot be shared by plumbing.** Lex forwards three request attributes and the tag is not among them, so neither entry can see the other's read. A per-container cache is the only lever, and it is a security change rather than a latency one: a stale value is a cross-classification leak, not a slow turn |
| 4 | **Intent classification** (a Bedrock call) | It picks the delivery option, which picks both the dispatch branch and the placeholder's own wording - `getTaskPlaceholder` (`lib/delivery-options.ts`) returns "Drafting outline...", "Analyzing...", and so on. Those strings are fixed English, so the placeholder wording does not follow the conversation's language (tenet D11) | **The router.** The return depends on it. The lever is the classifier MODEL, not the ordering: the prompt is fixed-size with `maxTokens: 20`, so the cost is model round-trip |
| 5 | **The live task lookup** and **the live drift check** | A turn continuing a task must not open a second one; a drift result can answer the turn itself and return without dispatching | **The router.** Both change what the return is |
| 6 | **The ADR-033 turn claim** | It decides run-now versus queue, and a queued turn returns a deferral notice instead of a placeholder | **The router.** The return depends on the outcome |

**Queue-flag gate.** The hand-off for item 2 is gated on the queue flag, not on the claim. `claimTurn` returns `claimed: true` when the queue is off, so a hand-off gated on the claim alone would have a queue-off deployment pay a channel read in the processor for a write that then no-ops on its own flag check. Rows 1 and 2 are held in place by `test/lib/what-waits-for-the-first-frame.test.ts`: re-adding either call to the router is a two-line change that breaks no build and shows up only as TTFF drifting back up.

**Effect.** Running rows 1 and 2 in the processor removes data-plane and Amazon Chime SDK round trips from the pre-return path. It does not remove the Bedrock classification, which stays in front of the placeholder for as long as the placeholder's wording is chosen from the classification. A deployment that needs TTFF below the classifier's own latency is asking a target question, not an implementation one.

### Placeholder-first (rejected)

The obvious large win is to post a generic placeholder immediately and upgrade it in place once classification lands, which would take the whole router leg out of TTFF. It is **rejected**, and recorded here so it is not re-proposed:

- **The placeholder is the Lex return.** Posting early means the router sends the message itself and returns silence, so the return stops being the placeholder. That is a change to the fulfillment contract, not an optimization within it.
- **It loses the specific copy** for every delivery option that has one, unless the upgrade-in-place half also ships - which costs a second `UpdateChannelMessage`, a re-invocation of the channel flow, and the duplicate-placeholder guard seeing the same correlation twice.
- **The error paths.** With a message already on screen, every exit that does not dispatch - the catch-all, the abuse gate, an unwired processor - has to UPDATE that message rather than post a new one or fall silent. Posting first strands a "One moment..." that never resolves whenever the dispatch fails.

**Same population.** Measure before and after on the same population. `avg_router_ms` is over `router_measured_count` turns and `avg_ttff_ms` over `ttff_measured_count`, and those are different populations on different clocks, so subtracting one group average from the other does not produce the time spent outside the handler. Compare `v_router_steps` against itself across a change, and read `router_ms` against `ttff_ms` per row rather than per group.

**TTL caches.** The TTL caches flatter a busy deployment. The profile lookup is cached per container for 30s and the experiment list for 60s, so on steady traffic those steps are hits and cost nothing. On a quiet deployment the TTLs expire between turns and every turn pays an SSM `GetParameter` plus a DynamoDB `Scan`. The step averages therefore look best exactly when nobody is complaining, which is the same reading trap the cold-start rate carries.

## Reading the dashboard

The Latency tab renders the full set as distinct cards, each with a tooltip stating exactly what it brackets, so no card is left to be misread:

- **TTFF** - "time to placeholder" (acknowledgment latency), not the answer.
- **E2E** - the full user wait to the final answer (the real perceived latency); includes the inbound hop and cold start that Worker compute omits.
- **Worker compute** - the async processor's server compute only (processor entry -> answer content ready; posting it is outside the stamp); always less than E2E, NOT the user's wall-clock time.
- **Model time** / **Tool time** - the model-loop time split into model inference vs in-loop tool execution, so a RAG-heavy turn reads as tool time rather than a slow model.
- **Inbound** - the front-of-turn routing / cold-start hop (approximate, cross-clock).
- **Answer target check** / **Placeholder scan rate**, **P95 worker compute** - the placeholder handshake and the tail.

Below the cards, three panels say which turns are IN those numbers, because a figure whose population nobody can name is a figure nobody can check. **Latency by interaction** splits the window by what triggered each turn (a person waiting, a rebuttal, a repaired turn) and reports `ack_ms` per kind beside the `ttff_ms` it generalizes, so a kind with no TTFF shows a measured figure rather than an empty row. **Queue health** separates a deliberate wait from a latency regression. **Turn kinds** separates answers from the turns that declare they are not answers - a reading of a queued burst, a drift suggestion - and reports the reply time of each measured from the message it named, so a fast non-answer is visible without being averaged into the figures above.

The header prose and the distribution rail describe the same framing, so an operator is not left to infer that Worker compute is server-only or that the model-loop number bundles tool time.

## Response-time standards

### Nielsen Norman Group limits

The foundational UX thresholds (Jakob Nielsen, *Usability Engineering*, 1993) are the standard:

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

## Configured targets

| Console metric | Good | Warn | Basis |
|---|---|---|---|
| `ttff_ms` (time to first feedback) | <= 1s | <= 2s | Nielsen 1s focus limit. The primary UX SLO. |
| `avg_e2e_ms` (user -> final answer) | <= 10s | <= 30s | Nielsen 10s attention limit / 30s abandon. The true perceived wait (includes inbound + cold start). |
| `avg_total_ms` (server compute) | <= 10s | <= 30s | Nielsen 10s attention limit / 30s abandon. Server compute only; a lower bound on the wait. |
| `p95_total_ms` (tail) | <= 15s | <= 30s | Tail kept under the 30s abandon threshold. **The band is applied to a traffic-weighted mean of per-group p95s, not to the window's p95** - see the tail figure under Worker compute for why the two differ. |
| `avg_bedrock_ms` (combined model loop) | <= 6s | <= 12s | Dominant share of the completion budget. The inference-only split lives in `model_ms` / `tool_ms` (the Model time / Tool time cards). |
| `LatencyTab.latencyColor` (table cells) | <= 10s | <= 30s | Same Nielsen time-to-complete bands. |

**Per-tier bands (G10).** The Latency tab has a tier scope, and narrowing to one tier applies that tier's band via `targetFor()` in `metricTargets.ts`. COMPUTE metrics (worker compute, its P95, the model loop) are engineering budgets and vary by tier; PERCEIVED metrics (TTFF, E2E) are UX limits and do NOT - a person waiting does not know which model answered them. No tier band may exceed the ~30s abandon threshold, so tiering only tightens expectations for cheaper work. Pinned by `metricTargets.tiers.test.ts`.

**Tuning.** Tune from observed data, within the standard. Once traffic flows, set the target near a p50 you are happy with and the warn near p90, but keep both inside the Nielsen 10s / 30s envelope. The standard is the limit of acceptability, not the goal.

## Remaining gaps

These are built and described in the metric definitions and "Capture" below: the user-to-final-answer metric (G1), the model/tool split (G2), the worker-compute relabel (G3), the inbound hop (G4), the per-turn browser and server pairing (G5), counting DIRECT turns rather than excluding them (G6), keeping latency off the capped Metadata field in Aurora mode (G7), percentile sample counts and measured cold start (G9), per-tier bands (G10), ledger anchoring (G11) and interaction kinds with `ack_ms` (G13). What remains:

| # | Gap | Why it matters | How to fill |
|-----|-----|----------------|-------------|
| **G8** | **OPEN: Athena mode has no latency query**, so this whole surface is Aurora-only, and the Latency tab says so in a banner. The archival drop rate is a published metric (`AgentEchelon/Archival` - `RecordsArchived` and `RecordErrors`, emitted by `archival-health.ts`, dimensionless so an alarm over it can fire). A dropped record does not make a latency number WRONG, it makes it silently narrower, and an average over 90% of the traffic reads exactly like an average over all of it. | Coverage differs by deployment mode. | Alarm on `RecordErrors`. For Athena mode, serve the query there. |
| **G12** | **OPEN for the worker leg.** The ROUTER leg is recorded as instants: the router records a boundary instant per step, archival writes them as `turn_events` rows (`kind='router_step'`, `clock='server'`, `auditable=false`), and `v_router_steps` derives the durations at read, so that half can be recomputed from the rows beneath it and checked against `router_ms`. The WORKER leg is not: `guard_ms`, `placeholder_resolve_ms`, `poll_ms`, `model_ms` and `tool_ms` are stamped durations. The 1024-byte Metadata cap is not the issue in Aurora mode: `async-processor-core.ts` projects the blob through `pickFrontendMetadata` before it touches the message, so no latency field reaches the Metadata. It is a constraint only in **Athena mode**, where there is no out-of-band store and the full blob is spread onto the message. | Auditability: a duration is a claim nobody can re-check; an instant can be compared against its neighbors and its parent. | For the worker, the router's shape: record its step boundaries as `turn_events` rows and derive at read. |
| **G14** | **OPEN: TTFF outside the router is one figure.** `avg_ttff_outside_router_ms` measures it per row (this turn's `ttff_ms` less this turn's `router_ms`) over the turns carrying both, with `ttff_router_paired_count` beside it; see "Outside the router" for why the clocks do not spoil the difference and why it can be negative. It contains the message reaching the router and the placeholder traveling back, and nothing separates them. | The largest single component of the perceived-latency target is one undivided number. | Stamp the placeholder post as a server-clock instant on the router's own step log. `dispatched` less that instant is the return leg on one clock; the remainder is then the inbound hop alone, and both are addressable. The same instant settles the overlap case, by saying whether the placeholder preceded the hand-off. *Verified by* (the current three-way reconciliation): `tests/e2e/ttff-decomposition.spec.ts`. |
| **G15** | **OPEN: E2E is not partitioned by measured pairing, and TTFF is.** `avg_ttff_ms` and `p95_ttff_ms` carry `FILTER (WHERE mp.measured)`, so a reconstructed pairing is held out and counted as `ttff_reconstructed_count`. `avg_e2e_ms` and `p95_e2e_ms` carry no such filter: in `getLatencyMetrics` (`backend/lambda/src/analytics-aurora/analytics-query.ts`) the two E2E aggregates are filtered on the battle round only, `FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)`, so a duel's round two is held out and reported as the rebuttal row of `latency_by_interaction`, and the measured-pairing partition the TTFF pair beside them carries is not applied. The exposure is the same one the partition exists for: `vl.e2e_ms` is anchored on the same possibly-reconstructed user instant. The query says the omission is deliberate - one reviewable decision rather than two, in the `E2E IS NOT PARTITIONED HERE` note on the measured-pairing comment block - and `backend/test/analytics-aurora/ttff-counts-only-measured-pairings.test.ts` pins it open as a scope guard, so a later partition changes that test rather than slipping past it. | The two headline perceived-latency figures answer to different populations, and only one of them says so. An operator comparing TTFF against E2E is comparing a measured subset with the whole. | Either partition `e2e_ms` on `mp.measured` and publish its own measured and reconstructed counts, or state on the console which of the two figures is filtered. The test named above is where the decision is recorded when it changes. |
| **G16** | **OPEN: the E2E averages publish no population count.** `avg_e2e_ms` and `p95_e2e_ms` come back with no denominator, where `p95_total_ms` and `p95_bedrock_ms` carry `p95_total_sample_count` / `p95_bedrock_sample_count` and TTFF carries `ttff_measured_count`, all three returned by `getLatencyMetrics` (`backend/lambda/src/analytics-aurora/analytics-query.ts`). The Populations table gives the step averages their counts and has no row for E2E. `avg_ttff_warm_ms` is in the same position: the cold-start comparison it exists for has no count of the warm turns it was taken over. | It is the rule this whole surface is built on - an average whose denominator is unstated is not a measurement - unmet on the metric the console calls the one operators want. A ten-turn E2E and a five-hundred-turn E2E render identically. | Add `e2e_measured_count` (and `p95_e2e_sample_count` if the two populations can differ) and `ttff_warm_count` to the SELECT and the columns contract, and give each a row in the Populations table. No new capture: every one of them is a `COUNT(*) FILTER` over columns already read. |

## The turn ledger

**`turn_events` (migration 019), written live by `analytics-aurora/turn-events-live.ts` from the archival batch,** records every event a latency number is derived from, so the derivation is stated where a reader can check it.

**One row per fact.** One row per observed, timestamped fact. Append-only, never updated. Two keys, because a turn can have more than one responder: `turn_id` (the correlation id, one per user turn) and `response_id` (the placeholder's Amazon Chime SDK MessageId, one per assistant response within it). A normal turn is 1 + 1; a `/battle` is 1 turn_id + 2 response_ids.

**Duel rounds.** A duel side's round is recorded, so a battle turn is separable from production traffic. `turn_events.battle_round` carries 1 or 2 on a duel side's `placeholder_posted` row and NULL on every ordinary turn. The value is read off the placeholder's own `<!--battle:...round=N...-->` marker by `kinesis-archival.ts` and written by `turn-events-live.ts`, with the matching expression in `turn-events-backfill.ts` for history. `v_turn_latency` selects it and `turn_latency_audit` returns it. It is the field a population query filters duel turns out by, and it is on the console. The Turn Latency Audit renders it as the **Duel** column (the `battle_round` column in `frontend/packages/admin/src/components/admin/TurnLatencyAudit.tsx`), where `NULL` reads as a dash because an ordinary turn is not an unmeasured duel. The Latency tab's filter bar offers it as the **Duel** axis (`frontend/packages/admin/src/components/admin/PerformanceFilters.tsx`, matched by `matchesDuel` and applied through the shared `rowMatches`), which `latencyPopulation` in `frontend/packages/admin/src/components/admin/latencyAggregate.ts` cuts every card, chart, table row and latency alert by. `none` is one of the options and is the one the filter exists for: a duel fans out, so being able to select rounds without being able to EXCLUDE them would leave the production population unaskable. See [DESIGN-BATTLE](../../specs/interaction/quality/DESIGN-BATTLE.md) section 5c for what remains pooled.

**Declared finality.** Finality is DECLARED, not inferred. The producer stamps `respPhase` on every update it posts (`ResponsePhase` in `lib/analytics-metadata.ts`, a required parameter of `updateMessage`), and only `final` closes a turn. The mapping (`kindForPhase` in `turn-events-live.ts`) fails closed: an unrecognized phase becomes `progress_update`, so a phase invented later by a component that has not been taught about latency cannot close a turn early.

| Phase | Ledger kind | Closes the turn? |
|---|---|---|
| `placeholder` | `placeholder_posted` | no - sets TTFF |
| `interim` | `progress_update` | no |
| `final` | `final_response` | **yes - the only one** |
| `cancelled` | `cancelled_response` | **no** - the person stopped the work while it ran: a third outcome, neither an answer nor a fault (ADR-033) |
| `error` | `error_response` | **no** - the wait ended, no answer was produced |
| `notice` | `notice_posted` | no - assistant-initiated, no user message to measure from |
| anything else | `progress_update` | no |

**No message content.** Ids, timestamps, kinds and provenance only. The `turn_id` is *derived from* content (the `<!--corr:-->` marker) but only the id is kept. A redaction or deletion therefore needs no ledger mutation, so the erasure path does not grow a second place to get wrong. Enforced by `turn-events-live.test.ts`.

**Audit boundary.** The outer bracket - user message -> placeholder -> final answer - is on the Amazon Chime SDK message clock and is auditable against the message stream. The inner breakdown (`processor_entry`, `model_ms`, `tool_ms`) is server-clock and is not in the S3 line; it is attested, not auditable, and rows carrying it are marked `auditable = false` so no dashboard implies otherwise.

**Reading it.** `POST { queryType: 'turn_latency_audit', channelArn }` returns the calculation for one channel, one row per response (the response's turn id is lifted across its own ledger rows, so a live final-answer row - whose content carries no corr marker to declare a turn from - still lands in its placeholder's row; migration 027), including the reconciliation residuals. A NEGATIVE `unattributed_ms` means compute was attributed to the wrong turn - the bug class this exists to expose.

**Audit population.** The audit applies no pairing filter and the tab's headline does, so the two are over different populations. `getTurnLatencyAudit` reads `v_turn_latency` alone, so it returns a reconstructed pairing beside a measured one with nothing on the row saying which, while `getLatencyMetrics` excludes `swept` by name. The audit is the wider population rather than a per-row view of the headline, and it is exactly the surface an analyst reaches for when the headline looks wrong. **OPEN:** the audit does not carry `paired_by`; the split for a window is `latency_metrics`'s `ttff_measured_count` against `ttff_reconstructed_count`.

## The shadow diff

**Authoritative side.** Every TTFF and E2E figure the Latency tab shows comes from the ledger: `v_turn_latency.ttff_ms` and `v_turn_latency.e2e_ms`, aggregated by `getLatencyMetrics`. `exchanges.response_latency_ms` and `exchanges.e2e_ms` compute the same two figures at archival and are the second opinion. `turn_latency_shadow_diff` compares them per turn. It changes no figure on the tab, and the panel that renders it names the authoritative side in its own text.

**Why it stays.** Agreement over one window is not a property that holds forever: an archival change, a re-pairing or a second final stamp separates the two paths again, and a per-turn diff is the only thing that shows it.

**Round two.** A battle round-2 rebuttal answers no user message. The ledger gates `ttff_ms` on the declared interaction kind and on the round, and both sides measure the rebuttal's end to end from its declared `trigger_at`: the ledger in `v_turn_latency` (migration 071), and every archival writer of `exchanges.e2e_ms` through `exchangeE2eSql` in `kinesis-archival.ts`. Neither side reports a reply time for it, and the exchange's `inbound_ms` is `NULL`. So a round-2 turn agrees on both figures when its trigger was declared, and is `NULL` on both when it was not.

`POST { queryType: 'turn_latency_shadow_diff', dateRange }` (Aurora only, the `view-analytics` capability, window capped at 90 days) compares every turn at least one path measured in the window.

**Pairing.** A ledger response is the placeholder whose MessageId and channel it carries, and that placeholder's derived figures are on the exchange whose `agent_message_id` is its row. The exchange is taken through an ordered `LATERAL ... LIMIT 1`, so an agent message sitting in several exchange rows contributes one row to the comparison. Both sides are windowed on the placeholder instant, which is the same Amazon Chime SDK timestamp on each side, so a turn at the edge of the window is in both or in neither.

**Like for like.** Both laterals carry the same `queued_as IS NULL` predicate (migration 052), and that is what makes a disagreement mean something. A folded answer carries one exchange per queued message it rolled in, all on that same message, and a queued row's `response_latency_ms` is the person's whole wait with the queue inside it. If only the view held the predicate, the derived side could pair to a `queued_as = 'folded'` exchange while the ledger anchored on the turn's own one, and every folded turn would class `disagree` for a reason that is not a defect. A known and explained disagreement class still drowns the signal this panel exists to carry, so the two sides pair like for like instead. A folded answer that has no unlabeled exchange at all falls out of the derived side rather than pairing to a queued row, and classes `ledger_only`: the derived path never paired the turn itself.

**What matching gives up.** An unmatched predicate would have been the only thing surfacing a MIS-LABELED `queued_as`, since the two sides would then disagree about the row. That question is real and is deliberately not watched here, because it belongs to the queued-exchange surface rather than to a latency comparison: one source per question. Where it would be checked is `v_queued_exchange` against `messages.answered_queued`, the label being folded at archival from the turn's own declaration, so the two must agree row for row.

**`compareLatencyDerivations` is coarser.** It is not the same pairing (`lambda/src/analytics-aurora/turn-events-backfill.ts`). It joins `exchanges` plainly, with no ordering, no `LIMIT 1` and no `queued_as` predicate, so an agent message sitting in several exchange rows is compared once per row and a queued exchange is compared as though it were the turn's own. It compares `e2e_ms` alone. It is the backfill's go/no-go reading over a window, and a figure it produces is not evidence about the per-turn pairing above.

**Each turn gets exactly one class:**

| Class | Meaning | What the tab does with it |
|---|---|---|
| `agree` | Both paths measured the turn; every figure present on one side is present on the other and within the tolerance | Nothing |
| `disagree` | Both measured it, and a figure differs or exists on one side only (`disagreed_on` names `ttff`, `e2e` or both) | Its figure changes |
| `derived_only` | Only the derived path has a figure: the ledger did not record the turn or could not anchor it | The tab reports no TTFF for it, and `latency_metrics.ttff_ledger_unmeasured_count` counts it in the response |
| `ledger_only` | Only the ledger has a figure: the derived path never paired the turn | The tab reports it |

A turn neither path produced a figure for is not a measurement on either side and is not counted.

**Tolerance.** `SHADOW_DIFF_TOLERANCE_MS = 1`. Both paths subtract the same instants: the ledger's `placeholder_posted` is the placeholder's CreatedTimestamp (`messages.created_at`) and its `final_response` is the update's LastUpdatedTimestamp (the source of `agent_final_at`). Both store the difference as an integer, one by an implicit assignment cast and one by `::integer`, so the only legitimate difference is one millisecond of rounding. Anything wider means the two paths used a different instant, such as a user message the ledger bound to another turn or a second final stamp, and that is the defect class the diff exists to find. A presence mismatch is a disagreement rather than a pass.

**Response.** The response carries a `summary` beside `data`: `compared_count`, one count per class, and for TTFF and E2E separately the p50, p95 and maximum absolute difference with the number of turns both sides measured (`*_diff_sample_count`). An empty distribution is `null`, not `0`, because "no turn had both figures" and "every difference was zero" are different findings. `data` lists only the rows that need a look (every class but `agree`), disagreements first and largest difference first, capped at `limit` (default 200, maximum 500); the counts always cover the whole window.

**Two columns qualify an agreement:**

- `anchor_source = 'exchange'` means the ledger held no `user_message` for the turn, so `v_turn_latency` starts its TTFF from the exchange's user instant. Such a turn shares its start with the derived path and only the placeholder instant is independent, so its agreement is weaker evidence. `exchange_anchored_count` counts these among the turns both sides measured. It is one of the two doors a reconstructed pairing can reach the tab's TTFF through, which is why `getLatencyMetrics` asks `anchor_source` before it trusts a ledger figure. The other door is `anchor_source = 'ledger'` with `turn_id_source = 'paired'`, described under "Measured and reconstructed pairings" below.
- `paired_by = 'swept'` marks a reconstructed pairing. The tab's TTFF average excludes it, so a difference on that row is not in the headline. "Measured and reconstructed pairings" below states which rows earn that label and how a late declaration corrects one that does not.

**Reading it.** The two paths agree when `disagree_count` is zero or every disagreement is explained, the TTFF and E2E difference distributions sit at the tolerance, and the `derived_only` and `ledger_only` populations are understood, since they are the turns the tab drops and keeps. The Latency tab renders this as the "Ledger vs derived path" panel (`LatencyShadowDiff`), withheld in Athena mode.

## Measured and reconstructed pairings

`exchanges.paired_by` (migration 042) records how each pairing was made, and the TTFF average is taken over the measured side of that partition only. `declared` is the turn's own statement of which message it answered. `in_batch` is an inference bounded to seconds by the Amazon Chime SDK Kinesis batch it was made in. `swept` is the cross-batch reconciliation pass reconstructing a pair by searching for the earliest correlation-marked assistant message after the user message, bounded only by the reply window. That pass defers an assistant message whose answer update has not landed (migration 053), so `swept` marks a pairing it reconstructed rather than one whose declaration arrives late.

**Sweeps stay excluded.** A genuine sweep stays excluded, and that is deliberate. Its `response_latency_ms` is the gap to whatever reply a bounded search chose, not a time to a placeholder, so it is not a measurement of anything a person experienced. `getLatencyMetrics` holds it out by name (`e.paired_by IS DISTINCT FROM 'swept'`) and counts it as `ttff_reconstructed_count` rather than hiding it. Admitting reconstructions to raise coverage would trade a narrow average for a fabricated one.

**Ledger anchors.** A ledger anchor is measured only when the ledger also bound the turn itself. `v_turn_latency.anchor_source = 'ledger'` says the view subtracted its own observed `user_message` instant. The instant is observed either way; what the ledger may not have observed is which user message is this turn's anchor, and `turn_id_source` is the column that says so. `declared` means the binding came from the turn through the correlation marker it posted. `paired` means the binding was derived from an exchange: `turn-events-backfill.ts` reads the exchanges table with no `paired_by` filter and writes `turn_id` onto the `user_message` row, so the anchor inherits that exchange's provenance, a swept one included. The measured predicate therefore asks both columns (`vl.anchor_source = 'ledger' AND vl.turn_id_source IS DISTINCT FROM 'paired'`), and where the binding was `paired` the decision falls through to the exchange clauses beside it. That is the correct reading rather than a cautious one, because the exchange is where the binding came from: a declared or in-batch pairing passes there on its own merits and a swept one is excluded there by name. Without the `turn_id_source` clause, a backfill over a window would readmit every swept pairing to the headline average, in the direction that flatters the number.

**Label evidence.** The label has to describe the evidence the pairer had, and the failure mode is a schedule rather than a carrier. Archival batches with a five second `maxBatchingWindow` (`archive-stack-aurora.ts`), so a turn whose time to first feedback exceeds five seconds cannot have its user message and its placeholder in one batch. The in-batch pairer never sees that turn, and the sweep reaches it first. The message a turn answers is not knowable when the placeholder is posted and is knowable by the time the answer update is written, so a sweep that minted from the placeholder alone would decide on evidence that has not arrived yet and write `swept` over a turn that is about to declare. The turns exposed to that are the slow ones, which is to say the ones the SLO exists to catch. The deferral below handles this by changing when the sweep decides rather than by adding another carrier.

**Label repair.** Three mechanisms keep a pairing label accurate:

- **Deferral.** `createExchangesFromDatabase` defers an assistant message that has no answer update yet, until either the update exists, or the turn already declared what it answers, or the turn declared itself finished on its create, or the placeholder is older than any live turn can be. Tenet D6 applies: a reconciliation sweep behind an event path is correct design, and a sweep acting as the primary writer of a pairing is not. The staleness bound is `UPDATE_DEFER_SECONDS`, derived rather than picked: the longest profile timeout the deployment's own topology declares, read live, times the six invocations one turn may consume (Lambda async invoke retries twice by default, and `turn-lock-release-on-failure.ts` re-dispatches up to `TURN_MAX_ATTEMPTS`, which defaults to 2), plus two minutes for the retry backoff and the archival batching window the update itself waits in. On the default topology that is 11 minutes. It expires deliberately: a deferral with no expiry would drop an abandoned or failed turn out of analytics altogether, and a missing row is indistinguishable from a turn that never happened, while a mislabeled one is at least counted in `ttff_reconstructed_count`. The sweep runs over every channel a batch touched, not only the ones carrying a create, so a deferred turn is reconsidered on the batch that carries its answer. It runs before the update fold: the update row is already in `messages` by then, so the deferral can see it, and the fold is what derives `e2e_ms` and `inbound_ms` onto the exchange, so the pairing has to exist before it runs.
- **Placeholder declaration.** The placeholder names what it answers, when the turn already knows. `router-agent-handler.ts` appends the declaration to the placeholder content through `withTurnDeclaration`, which archival folds to `messages.answers_message_id`. It declares only from the id the turn already holds and never buys a channel read to get one, so this fires for a bypass turn (the caller hands the id over as the `AE.message.id` request attribute) and for a turn whose task row, queue or stop path already paid for it. Both pairers read the update row first and the create row second, so the create-side value is consulted exactly when there is no update row yet, which is the moment the sweep runs.
- **Promotion.** `backfillFromUpdateEvents` promotes `paired_by` from `swept` to `declared` when the folded update names that exchange's own user message, inside the `UPDATE exchanges` it already performs. It promotes only, only from `swept`, and only on exact equality against the user message id read through the primary key. A declaration naming a different message is evidence the pairing is wrong rather than a confirmation, and nothing is promoted from it. This is not a second pairing rule: it records that the declaration arrived late. The deferral makes it rare rather than redundant: the deferral is required to expire, so a turn that runs longer than the bound still pairs as `swept` and still has its declaration arrive afterward, and without this promotion the bound would become a hard censoring boundary of its own.

### Reading a TTFF step

**Coverage or slowdown.** A change that alters how turns are LABELED, not how long they take, moves `avg_ttff_ms` because `getLatencyMetrics` excludes `swept` by name. A turn that pairs `declared` or `in_batch` instead of `swept` is the same turn, at the same latency, with the same instants on both ends; it enters the average rather than being dropped from it.

**Direction.** Readmitted turns are the slow ones, by construction, so readmission moves the average up. Archival batches with a five second `maxBatchingWindow`, so the only turns the in-batch pairer can miss are the ones whose first feedback took longer than that. The censoring boundary of `swept` therefore sits at the slow end of the distribution, and a surviving average describes the fast part of the traffic. A round-1 duel side runs two model calls, so its time to first feedback routinely exceeds the batching window and it is the most exposed. Round-2 rebuttals carry no `ttff_ms` at all, by declaration, and are measured by `ack_ms` and their own round's `e2e_ms` instead.

**Which figures move.** `avg_ttff_ms`, `p95_ttff_ms` and `avg_ttff_warm_ms` move, because those three are the aggregates gated on the measured predicate. On readmission `ttff_measured_count` rises and `ttff_reconstructed_count` falls by about the same turns, and that pair is the evidence: a real regression moves the average with the counts flat. `avg_e2e_ms` and `p95_e2e_ms` do NOT move, because no measured predicate gates them. `ack_ms` does not move either, since it anchors on the instant a producer declared rather than on how a pairing was made. Every server-clock stamp on the tab is a `messages.*` value and is untouched.

**Sizing a step.** The two populations differ in membership rather than in timing, so subtracting one average from the other does not size a step. Read `ttff_measured_count` and `ttff_reconstructed_count` across the change and see how many turns crossed.

**Targets stay.** `ttff_ms` in `metricTargets.ts` comes from the Nielsen Norman Group 1 second focus limit, which is a statement about people rather than about this deployment's traffic, so a wider population is measured against the same band. A TTFF outside the band because slow turns were readmitted is a real finding about those turns, not a threshold to re-baseline.

### Turn queue and declarations

**Queue-gated declaration.** Which turns declare a pairing depends on a feature flag that is off by default, so an operator has to know this before reading the split. The processor-side declaration is the one that covers the closing update: `async-processor-core.ts` stamps `answersMessageId` from `event.answersMessageId` or `event.userMessageId`. `userMessageId` reaches the processor through exactly two writers, `holderRecordFields` in `router-agent-handler.ts` and `recordWhatThisTurnIsAnswering` in `assistant-async-processor.ts`, and both are gated on `owesHolderRecord`, which begins with `turnQueueEnabled()`. `TURN_QUEUE_ENABLED` is `0` unless the deployment passes `-c turnQueue=true` (`lib/stacks/agent-classification-common.ts`). `answersMessageId` is set on the dispatch only from an id the router already holds (`declaredAnswerId` in `router-agent-handler.ts`: a handover's message id or an inbound id it already knew). So on a default deployment the closing update of an ordinary Amazon Lex turn declares nothing.

**Queue-off carriers.** Two carriers work with the queue off, and they are the reason the split is not empty there. The placeholder declares whenever the router already holds the inbound message id, and a bypass caller always hands one over as the `AE.message.id` request attribute, so an `@all` turn, a battle side, an alt's turn and a handover all declare on their placeholder content. Separately, the handler-answered `DIRECT` reply (the greeting and acknowledgment quick responses) declares unconditionally: it is the one path that does pay for the id, through a memoized channel read, and it writes `answers` plus `phase: 'final'` into its own content.

**Ordinary Lex turns.** What is left over is the ordinary Amazon Lex turn on a queue-off deployment, and it declares nothing at all. The Amazon Chime SDK does not send Lex the message id, and the router deliberately refuses to buy a `ListChannelMessages` in front of the person's first frame to find one. Such a turn pairs `in_batch` when its user message and its placeholder land in the same five-second archival batch, and `swept` when they do not, which is to say whenever first feedback takes longer than five seconds. `swept` is excluded from the headline TTFF, so on a queue-off deployment the ordinary-turn population contributing to `avg_ttff_ms` is biased toward the fast turns, and `ttff_reconstructed_count` beside it is the size of what is being held out. Turning the turn queue on removes that bias by giving every turn a declaration; it is not what the flag is for, but it is a consequence worth knowing when the two numbers are read.

**Entry comparisons.** The exclusion is not neutral by entry, so the headline TTFF cannot compare one entry with the other. A flow-dispatched turn always declares the message it answers, so it pairs `declared` whatever its latency. An ordinary Amazon Lex turn on a queue-off deployment declares nothing, so it pairs `swept` and leaves the average whenever its first feedback exceeds the five second batching window. The turns held out are therefore the slow Amazon Lex turns and almost no flow turns, which is a censoring that differs by the very variable an entry comparison is about, and it differs in the direction that flatters the flow. **An entry comparison is read per row with the pairing label carried alongside, never off `avg_ttff_ms`.**

**Carried and reconstructed figures ([ADR-043](../../design/decisions/043-a-turn-carries-what-it-answers.md)).** Two populations with different guarantees sit under every latency figure, and `turn_entry` says which a turn belongs to:

| | Carried (`turn_entry = 'flow'`) | Reconstructed (`turn_entry = 'lex'`) |
|---|---|---|
| What the turn answers | Known at dispatch: the flow hands over the message id (`userMessageId`, `AE.message.id`) | Found by matching the turn's text in the channel (`findInboundMessage`), bounded by ADR-038's `notAfter` |
| `paired_by` | `declared`, always | `declared`, `in_batch` or `swept` |
| Time to first feedback | Measured by construction | Measured, or reconstructed and held out of the headline |
| The sweep and the deferral bound | Do not apply | Apply |

A turn no message entered records `turn_entry = 'platform'`: a rebuttal, a welcome, an event workflow's step and a task taken up are started by the platform, so neither door's work is in front of their first frame (`turnEntryOf`, `lib/turn-declaration.ts`). A receipt, the placeholder of a turn whose answer moved to a message of its own, records its turn's entry and is named `receipt` before any duel round, so the flow counts the turn once, as its answer.

The per-turn drill (`latency_exchanges`) returns `turn_entry` and `paired_by` on each row, so a reader can see which guarantee a row's timing carries. `messages.person_id` and `exchanges.person_id` (migrations 074 and 079) key the person who asked by id rather than by display name.

**Content carrier.** The carrier on the placeholder is content, not `Metadata`, and the 1024-byte cap is not reached. The Amazon Chime SDK materializes the placeholder from the Lex fulfillment return, and a fulfillment return carries messages and session attributes with no message metadata at all, so there is no metadata field to add to or to crowd. The declaration travels the way a `DIRECT` answer's does: a `<!--turn:-->` marker bounded to 512 characters by `turn-declaration.ts`, on a placeholder whose content is well under the 4096-byte `Content` cap, stripped from everything a person or a judge reads. On a bypass the router posts the same composed content itself (`postAsAssistant`), so both entry points carry it from one composition.

**No phase on the placeholder.** The placeholder declares only what it answers. An assistant message carrying a correlation marker is read by the ledger as a response something else will close, so declaring `final` here would close the response the instant it opened.

**No bought reads.** A turn that does not know its message id declares nothing, and buys no read to find out. The Amazon Chime SDK sends Lex neither the message id nor the mentions, so an ordinary Lex turn resolves it with a `ListChannelMessages` that `recordWhatThisTurnIsAnswering` runs in the processor rather than the router, because in the router it would sit in front of the person's first frame and inside the figure this document is about. The placeholder therefore declares only the id a bypass caller handed over or a task row, a queue or the stop path already paid for. Every other turn is repaired by the update fold instead, one batch later, which costs nothing on the turn path.

**No relabeling migration.** Promotion runs when an update event folds, so it corrects a turn whose update folds after the promotion code is deployed, including one whose exchange already exists. No migration rewrites labels on rows whose update has already been consumed: re-deriving a label in bulk over those rows is a separate decision, and admitting a row to the measured population on anything less than the turn's own exact declaration is the fabrication this partition exists to prevent. Migration 053 records the two column contracts (`exchanges.paired_by` and `turn_events.turn_id_source`) and carries no data step.

## Ledger read contract

**Columns.** `getLatencyMetrics` returns the columns `LatencyTab.tsx`, `alerts.ts` and `metricTargets.ts` read by name, including `ttff_ledger_unmeasured_count`, the turns the derived path has a TTFF for that the ledger does not, so the population difference is a number rather than a silence.

**Not on the console.** Nothing under `frontend/packages/` reads `ttff_ledger_unmeasured_count`; the Latency tab renders no card, cell or tooltip for it, so an operator reading the tab cannot see the count. The operator-visible form of the same population is the shadow diff panel's `derived_only` card, which counts the turns only the derived path measured. A reader who wants the number itself asks `latency_metrics` directly.

**Targets.** `ttff_ms`, `avg_e2e_ms` and `p95_total_ms` in `metricTargets.ts` come from the Nielsen Norman Group response-time limits rather than from observed traffic, so which of the two paths serves the figure does not bear on them.

**Unclosed split.** The unclosed split stays on the derived path. `closed_count`, `unclosed_count` and the buckets that partition it answer whether the EXCHANGE closed and why not, which is a question about the pairing rather than about latency. One of those buckets is `disagreed`, which exists to catch the ledger declaring a final answer the exchange has not recorded, so repointing it would have it compare the ledger with itself.

**Deferral notices.** A deferral notice is not a turn (migration 051). A `notice_posted` ledger row carries the notice message's own `response_id` and a NULL `turn_id`, because the notice acknowledges somebody whose message is waiting on work that is not theirs and so answers no turn. A response whose ledger rows are all notices is dropped from `v_turn_latency`; a notice recorded alongside a real placeholder keeps every instant it has. Without that rule the view grains a response with no placeholder, no final answer and `status = 'unresolved'`, so every queue episode reads in the Turn Latency Audit as a turn that was promised and never answered. A queued message's own first feedback is `v_queue_acknowledgement`, which keys on the acknowledged message because several queued sends share one notice.

## Task resolution

`POST { queryType: 'task_resolution' }`, over `v_task_resolution`. `resolve_ms` decomposes into `agent_ms` (the part the system is accountable for) and the human think time that makes up the rest. **A task open for four hours with twenty seconds of assistant time is healthy**, and this table says so on its face. It never enters `getLatencyMetrics` or the alert computation: one number would either flatter the turn latency or damn the workflow.

A task's ending is recorded by the writer that ends it - a terminal entry appended to `stateHistory` with its outcome (`success` / `failure` / `handoff`) - rather than by a separate timestamp column that could disagree with the log beside it.

## Queued exchanges

`v_queued_exchange` is queried directly against the cluster. **There is no analytics `queryType` for this population**: the POST dispatch table in `analytics-query.ts` has no `queued_exchange` entry, so the admin console and the signed analytics API cannot reach it and an analyst reads the view itself. It holds every exchange whose user message waited in a queue, one row per queued message that was answered, naming the answer that addressed it.

**Why separate.** A queued message's wait includes a delay the platform chose to impose. Averaged beside a 1:1 turn, the first conversation on a deployment that queues anything moves the headline further than a real regression would - which is the failure ADR-033's latency section exists to prevent. So the rows carry `exchanges.queued_as`, and every figure below is read through it.

| Column | What it is |
|---|---|
| `waited_ms` | the person's whole wait: their send to the answer that addressed it, queue included. **Not a time to first feedback**, and not comparable to `ttff_ms` |
| `ack_ms` | their first feedback, joined from `v_queue_acknowledgement` rather than recomputed. See the warning below |
| `drained_ms` | the send to the moment the queue finished draining, also from `v_queue_acknowledgement` |
| `e2e_ms` | the exchange's own end-to-end figure where the answer declared its completion |
| `answered_together` | how many queued messages this one answer addressed. One is a person who wrote twice; three is a reply carrying three follow-ups, and they are different things to read |

**Two `ack_ms` columns.** `ack_ms` here is `v_queue_acknowledgement.ack_ms`, which is NOT `v_turn_latency.ack_ms`. Same name, different view, different population, and the distinction is the one this surface is most likely to lose: the queued one measures a queued message's own send to its deferral acknowledgment, while the turn one measures whatever caused a turn to that turn's first signal. A queued message posts no placeholder, so it has no row in `v_turn_latency` to anchor.

**Population.** A queued message the reading marked as amending the work in flight is folded into the running answer, and that answer declares which ids it folded - so each of them gets a row here, `queued_as = 'folded'`. A queued message the reading marked `new` or `unclear` becomes a task and is measured as **task resolution** instead, which is the handoff the section above describes: its wait is mostly a person deciding, and a figure spanning both would flatter the turn or damn the workflow.

**Anchoring.** `v_turn_latency` skips a labeled exchange when it anchors a turn. A folded answer carries several exchanges on one message, so taking one as the anchor would measure that turn from a message it was not answering. The turn's own exchange is minted against the acknowledgment it closed out and carries no label. The shadow diff's derived side carries the same predicate, so the two paths pair on the same exchange and a folded turn is not a standing disagreement.

## Populations

Counts accompany every `latency_metrics` row, because an average whose denominator is unstated is not a measurement:

| Column | What it counts |
|---|---|
| `assistant_turn_count` | Assistant turns: an assistant message (not one of its update rows) that paired to a user message, ran a model, or carries a correlation marker. Not a count of exchanges: a round-2 rebuttal has an exchange against the original user message (migration 064), minted with no reply time and an end to end measured from the instant round two was triggered (migration 071), and notices, welcomes and drift suggestions are outside it. The exchange count is `conversation_volumes.paired_exchange_count`. This is the traffic weight the console combines groups by |
| `unpaired_turn_count` | turns in the group with no exchange row. Its total over a window equals the total of `unpaired_bot_messages.unpaired_count`, because both queries read one definition of an assistant turn. The `unknown` delivery-option groups hold these turns AND paired turns whose exchange recorded no delivery option, so an `unknown` total is larger than the unpaired total and is a classification gap rather than a pairing gap |
| `compute_count` / `direct_count` | with / without measurable compute |
| `closed_count` / `unclosed_count` | turns that closed, and turns whose answer never landed |
| `router_measured_count` | turns that stamped `router_ms`: the population of `avg_router_ms` and `avg_router_other_ms` |
| `classified_by_model_count` | turns that asked a model for a label: the population of `avg_classifier_ms` |
| `guard_measured_count` | turns that stamped `guard_ms`: the population of `avg_guard_ms` |
| `placeholder_measured_count` | turns that stamped `placeholder_resolve_ms`: the population of `avg_placeholder_resolve_ms` |
| `ttff_measured_count` | turns with a measured pairing: the population of `avg_ttff_ms` |

Each step average is over its own subset of `assistant_turn_count`, and the subsets differ. The console weights a step average by that step's count when it combines groups, and nothing on the row subtracts one step's average from another's.

**Uncounted averages.** Three averages on this row have no count beside them, and the table says so rather than leaving the omission to be noticed. `avg_e2e_ms`, `p95_e2e_ms` and `avg_ttff_warm_ms` publish no population, so the rule this table states is unmet for exactly the figure the tab calls the one operators want. That is G16 in the gap register above, and until it closes the nearest available denominators are `assistant_turn_count` for the window and `ttff_measured_count` for the TTFF population that `avg_ttff_warm_ms` is a subset of.

**`unclosed_count`.** It keeps the declared-finality rule visible: an errored or canceled turn does not close, so it leaves the closed population, and this counter shows by how much instead of letting the shrink pass silently.

## Capture

The complete set is captured, so the console is stable and no deployment migrates late. Two properties keep it contained:

- **Full schema up front.** All columns are in the base schema (`lambda/src/analytics-aurora/schema/013-latency.sql`), applied in order on a fresh Aurora Create: `messages.agent_final_at / model_ms / tool_ms` and `exchanges.e2e_ms / inbound_ms`, all nullable. Every deployment gets the whole set on stand-up; there is no follow-up migration.

  **Existing clusters.** `schema-init` (the Custom Resource) bootstraps on Create only and can never reconnect - `IamAuthSetup` grants `rds_iam`, which disables the password auth it uses. `db-client.ensureSchema` applies any unapplied `schema/*.sql` at RUNTIME over the IAM connection, under an advisory lock, so a new migration lands on an existing cluster with no manual step. That only happens in Lambdas that CALL `ensureSchema`, so all eight Lambdas that bundle the schema files call it, pinned by `db-lambdas-apply-migrations.test.ts`. Runtime-applied migrations must be idempotent and transaction-safe (no `CREATE INDEX CONCURRENTLY`).
- **Off the response path, but NOT off the message.** Every metric here is a `Date.now()` delta on work the turn was doing anyway, so none of it adds user-perceived latency: measure on-path, emit off-path.

  **Where it rides.** It depends on the analytics mode, and only one of the two costs Metadata budget.

  In **Aurora mode** the rule from [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 7.11 (and the carrier table in section 12.3) and ADR-016 holds exactly: the full blob goes to `MESSAGE_ANALYTICS_TABLE` out of band, and the Amazon Chime SDK Metadata carries only `FRONTEND_METADATA_KEYS` (`lib/analytics-metadata.ts`) - `bedrockModel`, `intent`, `experimentId`, `variantId`, `assignmentMode`, `battleId`, `battleRound`, `activeTask`, `imageCount` and `classification` (the S3 archive partitions on it, and Firehose cannot follow the out-of-band hop) - plus the delivery and declaration fields the processor inlines beside them (`attachment`, `targetedSender`, `trigger`, `entry`, `answersMessageId`, the queue fields and `respPhase`). **No latency field reaches the message.** Adding one costs nothing against the 1024-byte cap.

  In **Athena mode**, where `MESSAGE_ANALYTICS_TABLE` is unset, there is no out-of-band store and `fullAnalytics` is spread onto the message verbatim. Every latency field then competes with product data for the cap, and `METADATA_SHED_ORDER` is the backstop that decides what survives.

  **Shed order.** The shed order encodes a rule: a GROUPING KEY sheds last among the analytics fields. Losing an ordinary field costs that field; losing `delivery_option` costs the whole ROW its grouping, and on the Latency grid it groups under its turn kind or, with none declared, under the `undeclared_turn` defect (see "Turn span" above). Step-latency detail therefore sheds FIRST, and anything a person would notice missing (an attachment, a work-item chip) still sheds last of all. Guarded by `safe-metadata-string.test.ts`.

  **Pairer identity.** `delivery_option` does not identify the pairer. `ttff_reconstructed_count` holds the cross-batch pairer's reconstructions out of the TTFF average, and the test for them is `exchanges.paired_by = 'swept'`, a fact the pairer records about itself. A shed `delivery_option` therefore costs attribution and nothing else. For rows written before `paired_by` existed, the older proxy (a missing delivery option) applies.

  **Ledger and fields.** `turn_events` (migration 019) records INSTANTS with their clock and their auditability, and `v_turn_latency` derives durations from them at read. The Latency tab's TTFF and E2E come from there; the worker-leg per-message fields remain stamped durations, so in Athena mode telemetry competes with the product for a budget that belongs to the product. See G12.

### How each is derived

| Column | Derivation | Skew |
|---|---|---|
| `v_turn_latency.ttff_ms` (the tab's TTFF) | derived at READ: the ledger's `placeholder_posted` instant less the turn's user instant. `NULL` where the ledger cannot anchor the turn, and `NULL` by declaration where the trigger is not a person waiting. | **skew-free** (both Amazon Chime SDK) |
| `v_turn_latency.e2e_ms` (the tab's E2E) | derived at READ: the ledger's first `final_response` instant less the turn's user instant. Only `final_response` closes a turn, so an errored or canceled turn stays open rather than reading as a fast one. | **skew-free** (both Amazon Chime SDK) |
| `exchanges.e2e_ms` (`= agent_final_at - user_message_at`), the second opinion | `agent_final_at` is derived at ARCHIVAL, gated on the producer's DECLARED `respPhase` rather than on any proxy for it. On a turn delivered as a placeholder it comes from the Amazon Chime SDK UPDATE event's `LastUpdatedTimestamp` (the final-answer post), frozen by COALESCE so a later moderation or battle update cannot move it. A turn that declares itself final on its CREATE has no update to fold, so its own `created_at` is the answer time, and both pairers derive `e2e_ms` from it at insert. No processor emit or re-fetch. | **skew-free** (both Amazon Chime SDK) |
| `messages.model_ms` | `invokeBedrock` sums each Converse call's `iterStart -> iterEnd`. | single-invocation server clock |
| `messages.tool_ms` | `invokeBedrock` times the in-loop tool-execution block. `model_ms + tool_ms + guardrails` reconciles to `latency_ms`. | single-invocation server clock |
| `exchanges.inbound_ms` | the processor emits its entry `Date.now()`; archival computes `entry - user_message_at` on the exchange, clamped `>= 0`. | **cross-clock** (server vs Amazon Chime SDK; approximate) |

### Inbound skew

`inbound_ms` brackets an Amazon Chime SDK-stamped start against a server-clock entry with no shared clock between them, so it carries NTP skew and could compute slightly negative; archival clamps it to `>= 0` and it is approximate by design. Everything else in the set is a single clock and exact.

### Capture path

1. **Schema** `013-latency.sql` - the five nullable columns above.
2. **Emit** - `finalizePlaceholderResponse` writes `modelMs`, `toolMs`, and `processorEntryMs` (the handler-entry `Date.now()`) to the out-of-band analytics record. `agent_final_at` needs no emit: archival reads it from the UPDATE event itself.
3. **Archival** (`kinesis-archival.ts` `backfillFromUpdateEvents`) - folds `model_ms` / `tool_ms` onto the message row and derives `agent_final_at`, `e2e_ms`, and `inbound_ms` on the exchange, all COALESCE-idempotent.
4. **Query** (`getLatencyMetrics`) - adds `avg_e2e_ms` / `p95_e2e_ms` (from `vl.e2e_ms`, the turn ledger's own figure, not the exchange's), `avg_model_ms` / `avg_tool_ms` (from `m`), and `avg_inbound_ms` (from `e.inbound_ms`) to the SELECT and the columns contract. `m.total_ms > 0` is NOT a WHERE predicate: it sits in `FILTER` clauses on the compute aggregates, so a response that ran no measurable compute is counted and attributed rather than vanishing, and `compute_count` / `direct_count` state the split (G6). The averages are unaffected - a null contributes nothing to `AVG` either way - but they can be read against a population somebody can name.
5. **Frontend** (`LatencyTab`) - E2E, Model time, Tool time, and Inbound cards, the worker-compute / model-loop labels + tooltips, and the `avg_e2e_ms` target in `metricTargets.ts`. The Alerts tab reads the same `METRIC_TARGETS` registry, so a new target key only fires an alert once a matching `metricAlert` call is added in `alerts.ts` (TTFF, E2E, and P95 worker-compute are wired; all exclude task-delivery rows).

### Correctness

`e2e_ms` and the model/tool split are skew-free (a single clock each); `inbound_ms` is the sole cross-clock metric (handled above). New columns are nullable, so absent values are skipped by AVG/PERCENTILE and never wrong-valued during first traffic. No backfill. Aurora-only. Because the whole set is in the base schema, a fresh deploy gets it on Create and no operator or downstream deployer migrates later.

### Testing

**Automated (contract, mock-level).** `test/analytics-aurora/kinesis-archival-backfill.test.ts` pins the archival derivation against a MOCKED `query`: it asserts the SQL and the param positions - `agent_final_at` gated on the producer's DECLARED `respPhase`, where only `final` closes the turn and the older `total_ms`-present proxy survives solely as the fallback for rows written before the phase was declared, and frozen by COALESCE; the `e2e_ms` and clamped `inbound_ms` expressions; and the `model_ms` / `tool_ms` fold. It does NOT execute SQL, so the computed VALUES and the `model_ms + tool_ms` reconciliation are not value-tested here. **OPEN:** the loop-timing accumulation in `invokeBedrock` has no unit test.

**Live validation.** `tests/e2e/latency.spec.ts` (the optional `latency` phase of `backend/scripts/validate.mjs`, gated by `LATENCY_E2E=1`) drives one tool-using premium turn, reads `latency_metrics` through the SigV4-signed analytics query, and asserts `avg_e2e_ms`, `avg_total_ms` and `avg_model_ms` are each `> 0` on the premium row, and `ttff_ms > 0` per turn from the channel-scoped `turn_latency_audit`. It logs `tool_ms` without asserting it, because `tool_ms` is legitimately 0 on a turn the model answers from pre-fetched retrieval without calling a tool. **NOT VERIFIED:** that `e2e_ms > total_ms` on the same turn; no assertion compares the two.

## References

1. Nielsen Norman Group, [Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/) - foundational UX research on human perception of delay.
2. [Acceptable AI response time (2025)](https://agentiveaiq.com/blog/what-is-an-acceptable-response-time-in-2025) - industry benchmarks for AI customer service.
3. [The Need for Speed in AI](https://www.uxtigers.com/post/ai-response-time) - AI-specific response-time research.
4. AWS, [Amazon Bedrock latency-optimized inference](https://aws.amazon.com/blogs/machine-learning/optimizing-ai-responsiveness-a-practical-guide-to-amazon-bedrock-latency-optimized-inference/) - Bedrock performance guidance.

## Related

- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 8 - the placeholder/update delivery pattern that makes TTFF the perceived metric.
- [`SPEC-ADMIN-CONSOLE.md`](../../specs/interface/SPEC-ADMIN-CONSOLE.md) - the Latency tab and the metric-target registry.
- [`SPEC-FRONTEND-OBSERVABILITY.md`](../../specs/interface/SPEC-FRONTEND-OBSERVABILITY.md) - client-side web-vitals, the browser-perceived timing.
- [`SPEC-MESSAGE-METADATA-CODEBOOK.md`](../../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md) - the Metadata field the latency deltas ride.
