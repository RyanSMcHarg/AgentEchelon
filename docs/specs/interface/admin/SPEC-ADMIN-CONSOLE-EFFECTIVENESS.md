# SPEC: Admin console effectiveness, the intent-anchored drill

**Status:** Implemented. The Effectiveness section is one intent-anchored drill (`frontend/packages/admin/src/components/admin/EffectivenessTab.tsx`) served by the `intent_effectiveness`, `intent_exchanges`, `task_details`, and `task_timeline` queries. Both data prerequisites ship: evaluation join keys are stamped at Pass A write time, and `ConverseStep` carries per-tool outcome. Aurora-served; in Athena mode the drill is withheld with the standard mode note rather than rendered empty.

**Coverage:** `e2e/admin-dashboard.spec.ts`, `e2e/admin-dashboard-render.spec.ts`, `e2e/admin-nav.spec.ts`, `e2e/agent-intents.spec.ts`

**Verified by:** `frontend/packages/admin/src/components/admin/EffectivenessTab.test.tsx` (L0 ranks worst-first, placing a badly classified intent above a healthy high-volume one; the L0 to L3 drill reaches the turn timeline with its steps; the tool lens aggregates per-tool calls and errors), `backend/test/converse-step-tools.test.ts` (per-tool outcome persists name, success and a bounded error class, and never a payload), `backend/test/analytics-aurora/analytics-query.test.ts` (the `intent_effectiveness` rollup, and a cost per reply stamped on every row), and `frontend/packages/admin/src/components/admin/AdminDashboard.tabs.test.tsx` (the drill is Aurora-only, and the Effectiveness section still has a reachable tab in both modes).

**Problem and who it's for:** An operator wants to ask how well the assistant handles a particular kind of question, and get an answer that separates routing the request to the wrong place from routing it correctly and then failing to do the work. Organizing the same pipeline by storage artifact, one tab per table, requires the operator to know the platform's internals and still leaves that question unanswerable, because the joins live in the data and the interface keeps them in separate rooms. This is for the operator triaging quality and the AI developer deciding what to fix. It makes the intent the spine, and puts quality, latency, cost and tool use on it together.

**Site section:** Admin Console, Effectiveness section.

**Related:** [`SPEC-ADMIN-CONSOLE.md`](SPEC-ADMIN-CONSOLE.md) (the console this section belongs to), [`DESIGN-ADMIN-CONSOLE.md`](DESIGN-ADMIN-CONSOLE.md) (the console's internals, including this drill's components), [`SPEC-TASK-STATE-TRANSITIONS.md`](../../interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md) (the declared state graph and the append-only transition log the turn timeline renders), [`SPEC-CAPABILITY-PROFILES.md`](../../interaction/assistant-config/SPEC-CAPABILITY-PROFILES.md).

---

## 1. The problem this structure solves

Quality analytics used to be organized **by artifact type**, and each type mapped one to one onto a storage table and an evaluator pass: one exchange, one task and all its turns, task outcomes, and the tool loop inside a turn. Those are four windows onto **one pipeline**: intent classification, then a delivery class, then either a single exchange or a task, then tool use per turn, then an outcome.

Four gaps follow from never expressing that spine.

1. **No end-to-end question.** Nothing answered how effective a given capability is across classification, the tasks it spawns, each task's turns, and the tool loop inside a turn.
2. **Classification failure and execution failure are smeared together.** When an intent underperforms, "we routed the wrong traffic here" and "we routed correctly and the work failed" are different fixes, and one score cannot distinguish them.
3. **Quality, latency and cost live apart.** A good but slow intent, or a good but expensive one, reads as fine when the three sit on separate tabs.
4. **Tool use is the mechanism and was only half-recorded.** A step persisted tokens, latency and cost but encoded the tool in a free-text label and dropped success and failure, so tool analytics was greppable rather than queryable.

## 2. Design principles

**The intent is the spine. Single-turn and multi-turn are two delivery classes of one pipeline, measured together and drilled for detail.**

- **Quality and efficiency are distinct axes.** Quality ranks the section worst-first. Latency and cost sit beside it as independently sortable decision columns and are never folded into one effectiveness number: a cheap but wrong intent and an expensive but excellent one are different problems, and one number hides the tradeoff.
- **Tool use is the causal layer.** Quality, latency and cost are what the console measures. The tool loop is what caused them, so it is a first-class dimension rather than a debug leaf.
- **Surface before drill.** The section landing ranks issues without a drill. The drill is for detail once the landing has pointed somewhere.

## 3. The join spine

`exchanges` is the hub. It carries `intent`, `task_id`, `delivery_option`, `intent_confidence`, `original_intent` and `was_rerouted`, plus foreign keys to both the user and agent messages. The spine is a chain of keys that already exist:

```
intent / delivery_option        (exchanges)
  -> task_id IS NULL             single-turn exchange
  -> task_id NOT NULL            task = a sequence of exchanges, one intent_flows row
       -> agent_message_id       (messages: total_ms, latency_ms, poll_ms, tokens)
            -> metadata.steps    (the Converse tool loop)
```

`task_id IS NULL` marks a single-turn exchange. `delivery_option` (`DIRECT`, `PLACEHOLDER_UPDATE`, `TASK_MULTI_STEP`) is the parallel signal, stamped from the intent pack's declared delivery class.

## 4. The two data prerequisites

Neither is interface work. Both are the foundation the queries stand on, and both ship.

**Evaluation join keys are stamped at Pass A write time.** An `evaluation_results` row for a task exchange carries its `task_id`, and its `flow_id` once the flow exists, so a per-exchange score joins to its flow directly instead of round-tripping through `exchanges`.

**A step records per-tool outcome.** `ConverseStep` carries `tools?: Array<{ name, ok, errorClass? }>` rather than one boolean for the iteration, because a single Converse iteration can invoke several tools and a tool-error rate has to attribute to the right one. `errorClass` is a **bounded classification** and never raw error text, so no tool input, output or personal data is persisted on the step. The display label is retained for rendering.

**Tool payloads are deliberately not stored.** Drilling from a turn into what was actually said deep-links to the Conversations view, which re-checks the operator's admin permission and vends its own scoped credential. The link is a navigation hint, so it never confers content access on its own, and the analytics store keeps derived signal rather than transcripts.

## 5. One section, five depth levels

```
Effectiveness (section landing = the L0 dashboard)
|
+- L0  DASHBOARD ......... intents ranked worst-first; issue tiles. No drill needed.
+- L1  INTENT ............ one intent: delivery class, the two quality scores, latency, cost, tools
+- L2  EXCHANGES | TASKS . a DIRECT intent drills to exchanges; a task intent drills to tasks
+- L3  TURN TIMELINE ..... one task: its transition timeline; each turn shows score, latency,
|                          tokens and the tools it invoked
+- L4  STEPS ............. one turn: the tool loop (model, tokens, cost, duration, tool, ok)
```

The former Evaluations, Flows, Tasks and Steps surfaces are depths of this path rather than sibling tabs, and are retired from the navigation with their components still backing the drill. **Only the two human-action views stay standalone** (below). The drill position is lifted to the console container so it survives a tab switch, the console's global Back walks L3 to L0 before it walks tab history, and every level renders an honest empty state rather than an error.

### The intent row: two quality axes, plus decision columns

| Column | Means | Built from |
|---|---|---|
| Classification | Did we route it right | average `intent_confidence` and reroute rate (`was_rerouted`, `original_intent <> intent`) |
| Execution | Given routing, did the work succeed | DIRECT: Pass A relevance. Task: completion rate times the flow composite |
| Latency | User-experience cost | average and p95 `total_ms` over the intent's agent messages |
| Cost | Money cost | average tokens per reply resolved to a currency amount per reply |
| Tools | Which tools the intent leans on, and its tool-error rate | per-tool step outcomes, aggregated |

**Ranking is worst-first by distance past target of the WORSE of the two quality axes**, not a blend, so the axis that surfaces an intent is the one that reads red. Latency, cost and tool-error rate are independently sortable, so an operator can re-sort to hunt a latency regression or a cost outlier without losing the quality ordering.

**Reading the two axes together is the point.** A red Classification cell beside a green Execution cell is a taxonomy or router problem. The reverse is a prompt, model or task-graph problem. A red tool cell is a tool-dependency problem. One composite score would have made all three look identical.

Status colors reuse the existing bands, and the registry carries `task_completion_rate`, `intent_reroute_rate`, `cost_per_reply` and `tool_error_rate` alongside the relevance and latency targets it already held. Values are defaults and are tunable through the same registry convention.

### The axes carry down and reconcile at the step

```
L0/L1 INTENT ...... quality | latency(avg,p95) | cost per reply | tools     per intent
L2 TASKS/EXCH ..... the same, per task or exchange
L3 TURN TIMELINE .. each turn row: score, latency, tokens, and the tools it invoked
L4 STEPS .......... per step: model, tokens in and out, cost, duration, tool, ok
```

L4 is the attribution point: one turn's step list simultaneously explains its score (what the loop did), its latency (which iteration was slow) and its cost (which step burned tokens). Three questions that used to need three tabs are answered by one turn.

## 6. Tool use as a first-class dimension

Tool use appears at three depths, not only at the leaf.

- **A lens at L0 and L1.** Which tools an intent depends on, and its tool-error rate as an issue signal beside misclassification and weak execution.
- **The mechanism at L3.** Task state advances through tool calls, so the tool-call stream and the state timeline are two projections of the same events, joined by the message that carried the transition. A turn row can therefore distinguish the step that advanced state from the step that did work.
- **Aggregation at L4.** Per-tool call frequency, average tokens and latency, and error rate, all keyed by tool name.

Transition history and step tool telemetry inherit the analytics store's existing retention and archival policy. This section adds no new retention surface.

## 7. The human-action views stay separate

Flagged and Ground Truth are not read surfaces, they are the human-action layer: Flagged is a triage queue, Ground Truth is a calibration form. Humans need a clear, filterable list to work down, so each keeps its own sub-tab and its own pending count.

**They link both ways.** A flag or a ground-truth submission originates from an exchange detail inside the drill, and each row deep-links back to its exchange in the drill, so an operator triaging a flagged response sees the context that produced it and a calibration sample carries its provenance.

## 8. Aurora and Athena

The drill is Aurora-served, because it needs relational joins across exchanges, flows, evaluation results, messages and the step JSON. This follows the console's strict-superset principle: the deep evaluation surfaces were already Aurora-only, so the drill introduces no Athena regression.

**The section is never fully hidden, and that is the invariant worth stating.** The rich drill is Aurora-only, and the simpler per-exchange evaluations view is reachable in Athena precisely where the drill is not, so each mode keeps an evaluation surface and neither renders a silently empty table. In Aurora the drill supersedes that view, so the two are alternatives rather than duplicates.

## 9. Non-goals

Alerting on these targets, which is a separate concern from displaying them; editing the intent taxonomy or delivery classes from the console, which is intent-pack configuration rather than analytics; changing either evaluator pass beyond the join-key write; real-time streaming of the dashboard; and any change to task creation or routing.

Two deliberate deferrals. **A category rollup above intent**, collapsing related intents into one row with the same columns, is a natural grouping but needs a per-deployment intent grouping the intent pack does not declare, so the per-intent spine ships first. **Reconciling cost against real billing** is roadmap: the cost column stays derived from average tokens times the model rate, which is what the per-step estimate already is.
