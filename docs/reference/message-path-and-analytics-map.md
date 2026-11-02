# Reference: the message path and the analytics that measure it

Two questions come up constantly and their answers are spread across three directories: **what happens to a message**, and **where the numbers about it come from**. This page is the index for both. It holds no rules of its own, so where it disagrees with a document it points at, that document is right.

Both tracks are ordered the same way: the one document to read first, then what binds it, then what reads it.

---

## Part 1. The message path

### Read this first

| Document | What it settles |
|---|---|
| [`../guides/developer/MESSAGE-FLOW.md`](../guides/developer/MESSAGE-FLOW.md) | The end-to-end account. Section 2 draws the whole path and lists every flow a message can take; sections 3 to 11 document each numbered step: the client, the channel flow, Amazon Chime SDK routing, the agent handler, the async processor, delivery and correlation, the Kinesis stream, post-processing and archival. Section 12 is what each step controls and measures. |
| [`../guides/developer/MESSAGE-DELIVERY-GUIDE.md`](../guides/developer/MESSAGE-DELIVERY-GUIDE.md) | How assistant output actually reaches Amazon Chime SDK, including size limits and chunking. |
| [`../guides/developer/CHIME_SDK_INTEGRATION.md`](../guides/developer/CHIME_SDK_INTEGRATION.md) | The service integration everything above sits on. |
| [`../specs/interaction/SPEC-INTERACTION-LAYER.md`](../specs/interaction/SPEC-INTERACTION-LAYER.md) | The layer the message path belongs to, and how it composes. |

### The decisions that bind it

| ADR | What it decides |
|---|---|
| [`022`](../design/decisions/022-message-identity-is-established-at-the-channel-flow.md) | Message identity is established at the channel flow, not at Lex. Carries the measured request-attribute set. |
| [`025`](../design/decisions/025-who-posts-the-placeholder.md) | Who posts the placeholder, per entry shape. |
| [`029`](../design/decisions/029-clarification-is-public-and-answers-get-their-own-placeholder.md) | A clarifying question is public, and its answer gets its own placeholder. |
| [`030`](../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md) | Routing follows the task, never the target. |
| [`033`](../design/decisions/033-a-conversation-answers-one-turn-at-a-time.md) | One turn at a time: the queue, readings, amendment folds, `/stop`. |
| [`011`](../design/decisions/011-agent-routing-mechanism.md) | How a turn reaches an assistant at all. |
| [`016`](../design/decisions/016-message-metadata-encoding.md) | Compact metadata, and the out-of-band analytics record. |
| [`027`](../design/decisions/027-speaker-attributed-transcript.md) | A transcript carries who said it, and whether they are a person. |
| [`032`](../design/decisions/032-where-a-rule-runs.md) | Whether a rule belongs on the critical path or after it. |

### Where a turn stalls, branches or waits

- [`../specs/interaction/conversation/SPEC-TURN-QUEUE.md`](../specs/interaction/conversation/SPEC-TURN-QUEUE.md) and [`../specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md`](../specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md) - queueing, the drain, the reading turn, the amendment fold.
- [`../specs/interaction/quality/DESIGN-BATTLE.md`](../specs/interaction/quality/DESIGN-BATTLE.md) and [`../specs/interaction/quality/SPEC-BATTLE.md`](../specs/interaction/quality/SPEC-BATTLE.md), with [`ADR-023`](../design/decisions/023-battle-round-coordination.md) and [`ADR-026`](../design/decisions/026-task-shaped-battle-rounds.md) - a duel is two turns on one message.
- [`../specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md`](../specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md) with [`ADR-013`](../design/decisions/013-drift-retrieval-vs-decision.md) - the turn that answers with a suggestion instead of an answer, and the subject decision a compared turn carries on its analytics record.
- [`../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md`](../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md) with [`ADR-024`](../design/decisions/024-task-ownership.md) - work that outlives the turn that started it.

### What rides on a message

- [`../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md`](../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md) - the coded metadata and its out-of-band lookup.
- [`../guides/developer/METADATA-AND-TAGS.md`](../guides/developer/METADATA-AND-TAGS.md) - what belongs in metadata and what belongs in a tag.
- [`../specs/communication/SPEC-NOTIFICATION-BRIDGE.md`](../specs/communication/SPEC-NOTIFICATION-BRIDGE.md) - reaching somebody who is not watching.
- [`../specs/interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS.md`](../specs/interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS.md) and [`SPEC-WELCOME-AND-CONTEXT.md`](../specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md) - what the reply is composed from.

---

## Part 2. Analytics, and what the numbers mean

### Read this first

| Document | What it settles |
|---|---|
| [`../guides/developer/LATENCY-TARGETS.md`](../guides/developer/LATENCY-TARGETS.md) | Every latency metric's definition and target, and the end-to-end gap. The authority for time to first frame, end-to-end time, and when a turn counts as finished. |
| [`../specs/interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md`](../specs/interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md) | What the effectiveness surface measures, and the intent-anchored drill behind each figure. |
| [`../guides/developer/PERFORMANCE-OPTIMIZATION.md`](../guides/developer/PERFORMANCE-OPTIMIZATION.md) | What the numbers are for, and which lever moves which one. |

### Which store answers which question

Read [`../overview/TENETS.md`](../overview/TENETS.md) tenet D7 before any of the rest. Treating one store as a cache of another is the single most common way to produce numbers that disagree.

| Document | What it settles |
|---|---|
| [`../overview/ARCHITECTURE.md`](../overview/ARCHITECTURE.md) | The three stores and why their roles cannot collapse into one. |
| [`../specs/foundations/SPEC-AURORA-VPC-MODE.md`](../specs/foundations/SPEC-AURORA-VPC-MODE.md) | The Aurora projection, and **how an exchange is paired** - which is the join most analytics rest on. |
| [`../guides/admin/AURORA-MODE-GUIDE.md`](../guides/admin/AURORA-MODE-GUIDE.md) | Operating that mode. |
| [`ADR-017`](../design/decisions/017-conversation-archive-mechanism.md) | The archive, and why it is the system of record. |
| [`ADR-020`](../design/decisions/020-versioned-rows-hold-provenance-not-current-state.md) | Why a versioned row is provenance rather than current state. |
| [`ADR-019`](../design/decisions/019-conversation-summary-seeded-on-first-turn.md) | Where a conversation summary comes from. |
| [`ADR-004`](../design/decisions/004-pgvector-revival-timing.md) and [`ADR-028`](../design/decisions/028-vector-store-classification-boundary.md) | The vector store, and the boundary it must not cross. |
| [`../specs/interaction/assistants/SPEC-CONTEXT-SOURCES-AND-STORES.md`](../specs/interaction/assistants/SPEC-CONTEXT-SOURCES-AND-STORES.md) | Every context source, and what restricts each one. |

### What counts as an answer

A message is in the answer population when it answers a message; who posted it does not decide that. A notice the router says as an assistant, a join recap, and a duel side each declare what they are, and [`SPEC-MESSAGE-METADATA-CODEBOOK.md`](../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md) ("Turn shapes in analytics") is the table of what each declares and how archival records it. Exchange pairing honors those declarations ([`SPEC-AURORA-VPC-MODE.md`](../specs/foundations/SPEC-AURORA-VPC-MODE.md)), and the response-time measures read the declared interaction kind ([`LATENCY-TARGETS.md`](../guides/developer/LATENCY-TARGETS.md)).

### Who a row is about

A row that names a person carries the person key, `person_id`: their AppInstanceUser id, the same id the sender ARN carries, whichever identity provider signed them in. The DynamoDB tables name it `personId`. [`../guides/admin/AURORA-MODE-GUIDE.md`](../guides/admin/AURORA-MODE-GUIDE.md) ("The person key") says how a row is attributed, the admin-plane identity included.

### The surfaces that read it

- [`../specs/interface/SPEC-ADMIN-CONSOLE.md`](../specs/interface/SPEC-ADMIN-CONSOLE.md) and [`DESIGN-ADMIN-CONSOLE.md`](../specs/interface/DESIGN-ADMIN-CONSOLE.md).
- [`../guides/admin/ADMIN-GUIDE.md`](../guides/admin/ADMIN-GUIDE.md) - the operator's view of the same figures.
- [`../specs/interface/SPEC-FRONTEND-OBSERVABILITY.md`](../specs/interface/SPEC-FRONTEND-OBSERVABILITY.md) - the client half, which is the only place the person's own wait is visible.
- [`../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md`](../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) - measurement used to decide something.

### Cost, and the controls that bound it

[`../guides/admin/INFRASTRUCTURE-COST.md`](../guides/admin/INFRASTRUCTURE-COST.md) · [`../specs/interaction/governance/SPEC-ABUSE-CONTROLS.md`](../specs/interaction/governance/SPEC-ABUSE-CONTROLS.md) · [`../specs/foundations/SPEC-COST-SLEEP-MODE.md`](../specs/foundations/SPEC-COST-SLEEP-MODE.md)

---

## Where exchange pairing lives

**Exchange pairing is documented under a deployment-mode title.** How an exchange is formed - the join almost every analytic rests on - lives in `SPEC-AURORA-VPC-MODE.md`, which nobody reads when asking how a reply is matched to the message it answered. The rules are correct where they are; this page is how you find them.
