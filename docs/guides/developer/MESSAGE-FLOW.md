# Message flow - how a message travels, who touches it, and why

> **The interaction-layer / harness reference.** This traces a message from the moment a user sends it to the moment an assistant reply lands back in the channel - through the **channel flow**, **Lex**, the **fulfillment handler**, and the **async processor** - and says *why* each hop exists and *where each enforcement layer sits*. For how the reply is *sized/chunked* onto Amazon Chime SDK, see [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md); for the security layers named here, see [`IDENTITY-AND-ACCESS-MODEL.md`](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md) §6b; for the model-selection detail, [`SPEC-CONTEXT-AWARE-MODEL-ROUTING.md`](../../specs/interaction/assistant-config/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md).

AgentEchelon is a **multiparty** substrate: humans and assistants share Amazon Chime SDK channels. The flow below is what lets a channel be a plain human-to-human room, a 1:1 human↔assistant chat, or a mixed room where the assistant answers only when addressed - all with the same primitives, differing only in **bot configuration** and **who is addressed**.

---

## 1. The three configuration layers (why an assistant "hears" a channel)

An assistant is not a special channel feature - it is an `AppInstanceBot` that is a *member* of the channel, wired to Lex. Three layers must all be in place:

| Layer | What it is | Why it exists |
|---|---|---|
| **1. Lex bot** | A Lex V2 bot with two intents - `WelcomeIntent` (fires when the bot joins) and `FallbackIntent` (the catch-all that carries every real user turn) - both with a **fulfillment code hook** pointing at the tier's handler Lambda | Lex is the **entry trigger + session**. AgentEchelon does *not* use Lex for NLU beyond "something was said"; the real request classification happens downstream (see §4). Lex gives us the managed Amazon Chime SDK→Lambda bridge and per-turn session. |
| **2. Amazon Chime SDK `AppInstanceBot` `InvokedBy`** | `StandardMessages: AUTO \| NONE` and `TargetedMessages: ALL` on the bot | This is the **routing policy** - it decides which messages Amazon Chime SDK forwards to Lex (see §3). It is the single switch between "answer everything in this room" and "answer only when addressed." |
| **3. Channel membership** | The bot is added to the channel (`CreateChannelMembership`) as the tier-matched bot | A bot only receives messages for channels it belongs to. **Order matters:** the `InvokedBy` config must be set *before* the bot joins, or Amazon Chime SDK may not route standard messages for that channel until the membership is re-created. |

**Per-tier bots.** AgentEchelon runs one bot per tier (Basic/Standard/Premium), each with its own Lex bot, model, guardrail, and `context/{tier}/` scope. Channel creation binds the **tier-matched** bot to the channel (`create-conversation`), so "which assistant is in this room" is fixed to the room's `classification`.

---

## 2. Channel Flow first, then Lex

When a message is sent, the **Channel Flow Processor** runs **first**: it is Amazon Chime SDK's synchronous message interceptor, and **every** message passes through it *before* delivery. Only once the flow **releases** a message (`callbackAllow`) is it delivered to the channel's members - and only then is the assistant's **Lex** bot invoked (per its `InvokedBy` config) on the messages addressed to it. A denied message never reaches the members or the bot.

```
        User sends a message
                │
                ▼
    ┌────────────────────────────┐
    │  Channel Flow Processor      │  runs FIRST, synchronously, on EVERY
    │  (channel-flow-processor.ts) │  message (human-to-human included),
    │                              │  BEFORE delivery:
    └──────────────┬───────────────┘  callbackAllow (release) / callbackDeny (drop)
                   │ released
                   ▼
    ┌────────────────────────────┐
    │  Amazon Chime SDK Channel   │  (message delivered, tagged classification)
    └──────────────┬───────────────┘
                   │ delivered to members (the bot is a member)
                   ▼
    ┌────────────────────────────┐
    │  Lex bot (per InvokedBy)     │  routes to fulfillment ONLY when this
    │                              │  message is "for the assistant" (see §3 + §4)
    └────────────────────────────┘
```

**The two components, in order:**

- **Channel Flow Processor** (`channel-flow-processor.ts`) is the **gate**. It runs on **every** message - human-to-human included - *before* it is delivered, and it **must call `ChannelFlowCallback`** to release each message (`callbackAllow`) or hold/deny it (`callbackDeny`). This is the conversation-level layer that exists **whether or not an assistant is involved** (see [IDENTITY-AND-ACCESS-MODEL §6b](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md#6b-defense-in-depth--guardrails-are-one-layer-not-the-boundary)). In AgentEchelon it does: `@all` fan-out (see §3), `/battle` orchestration, notify directives, and idempotency for at-least-once delivery - and it is the natural home for any future conversation-level content rule.
- **Lex** is the assistant's entry trigger, invoked on the **released** message. It only produces an assistant turn when `InvokedBy` says this message is for the bot.

Because the flow is a synchronous gate, Lex never sees a message the flow denied; and `@all` is handled entirely inside the flow - it invokes the async processor directly, bypassing Lex (see §3).

---

## 3. Which messages reach the assistant (routing)

Three cases, decided by `InvokedBy` + how the message is addressed:

| Case | Config | What happens | Why |
|---|---|---|---|
| **1:1 human↔assistant** | `StandardMessages: AUTO` | Amazon Chime SDK routes **every** message to Lex → fulfillment | In a private assistant chat every turn is for the assistant; no addressing needed. |
| **Multi-user, `@assistant`** | `TargetedMessages: ALL` + the frontend stamps `CHIME.mentions` with the bot ARN on `@assistant` | Amazon Chime SDK routes only the **addressed** message to Lex → a **targeted** reply back to the sender | In a shared room the assistant must stay silent unless spoken to. `@assistant` is a real Amazon Chime SDK mention, so **AUTO + native routing** handles it - no processor code. |
| **Multi-user, `@all`** | processor-side bypass | Channel Flow **detects `@all`**, releases the original message to everyone, strips `@all`, and **invokes the async processor DIRECTLY - bypassing Lex** - then broadcasts the reply | `@all` is *not* an Amazon Chime SDK `CHIME.mentions` value, so AUTO/Lex would not route it. The processor invokes the assistant itself and broadcasts. This is the **only** processor-side routing bypass. |
| **Multi-user, no mention** | - | The message is released to members; **no assistant turn** | Silence by default in shared rooms - the assistant does not answer un-addressed chatter. |

So the `@all` path and the Lex path both end at the **same per-tier async processor**; they differ only in *how they got there* (direct invoke vs. Lex fulfillment) and *how the reply is addressed* (broadcast vs. targeted).

---

## 4. Fulfillment: from Lex to the model (the "why Lex isn't the brain")

When Lex routes a turn, its **dialog code hook** invokes the tier's fulfillment handler (`router-agent-handler.ts`, deployed as a per-tier Lambda). This handler - not Lex - is where the real work is decided:

```
Lex dialog code hook ──► Fulfillment handler (tier-pinned)
   │
   ├─ WelcomeIntent (bot just joined)     → compose welcome + inject context, done
   │                                        (opt-in: if an onboarding intake is configured AND this
   │                                         user has not onboarded before, start the once-per-user
   │                                         intake instead; see GUIDE-ASSISTANT-CONTEXT.md)
   └─ FallbackIntent (a real user turn):
        1. Resolve tier   = min(userTier, channelTier)   ← downgrade enforcement
        2. Classify intent (separate Haiku classifier; configurable)
        3. Resolve model  (tier default → intent → A/B experiment override)
        4. (Aurora mode) Retrieval + drift: invoke the data-plane Lambda (skips trivial intents)
        5. Select delivery mode (see §5)
        6. Dispatch to the tier's ASYNC PROCESSOR (ARN from SSM), passing any retrieved context
```

**Retrieval and drift run off-handler (project decision 018).** In Aurora mode, step 4 does not run in the handler's own process: the handler is non-VPC, so it invokes a VPC-attached **data-plane Lambda** that does the embedding + pgvector work (RAG retrieval and drift detection) and returns results. This keeps the Lex-facing handler off the VPC path. See [RAG.md](RAG.md) and [INFRASTRUCTURE-COST.md](../admin/INFRASTRUCTURE-COST.md).

**Why Lex is only the trigger:** Lex's own NLU (its "intents") is used only as the "someone said something" signal. AgentEchelon classifies the *request category* itself downstream with its own classifier, so it can evolve the taxonomy without retraining Lex. ("Intent" in AgentEchelon = this request category, **not** the Lex intent - see [ARCHITECTURE.md](../../overview/ARCHITECTURE.md) terminology note.)

---

## 5. Delivery modes (why some replies are inline and some are async)

The fulfillment handler picks how the reply is produced, trading latency for the managed Lex round-trip:

| Mode | What it does | Used for |
|---|---|---|
| **`DIRECT`** | Return the reply inline in the Lex fulfillment response | Fast, canned turns (greetings, `WelcomeIntent`) - often no model call |
| **`PLACEHOLDER_UPDATE`** | Send a "One moment…" placeholder, invoke the **async processor**, then UPDATE the placeholder in place with the real answer | Normal model turns (5 - 30s) - Lex can't wait that long |
| **`TASK` / multi-step** | Placeholder + a longer orchestration (e.g. `/battle`) that streams step updates | `/battle`, long multi-step work |

The **async processor** (`assistant-async-processor.ts` → `async-processor-core.ts`) is where the model actually runs: it builds the Converse messages, runs the **self-hosted tool loop** (reason → `load_company_context` → observe → answer), applies the **guardrails**, and sends the reply via `handleLongResponse` (chunked to the Amazon Chime SDK size caps - see MESSAGE-DELIVERY-GUIDE).

---

## 6. Control *and* measurement along the flow

The same path is both **enforced** and **instrumented** at every hop - control decides what may happen; measurement records what did. That pairing *is* the "harness": not a chat pipe but a governed, observable one. The two tables below are twins - read them together.

### 6.1 Control - where each enforcement layer acts

Mapping the flow onto the defense-in-depth layers ([IDENTITY-AND-ACCESS-MODEL §6b](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md#6b-defense-in-depth--guardrails-are-one-layer-not-the-boundary)):

| Point in the flow | Layer that acts | What it enforces |
|---|---|---|
| User's `SendChannelMessage` | **IAM + `classification` tag** (on the user's exchange-vended, bearer-pinned creds) | The user can only send in a channel of their tier-and-below; fail-closed |
| Channel Flow Processor (every message) | **Channel flow** | Conversation-level handling/idempotency; runs even with no assistant |
| Fulfillment handler | **`min(userTier, channelTier)`** | A lower-tier user in a higher-tier room is downgraded (+ security-event log) |
| Async processor - **before** the model call | **Guardrail `source:'INPUT'`** | Prompt-injection (`PROMPT_ATTACK`) + input content filters; blocks before tokens spent |
| Async processor - model + context read | **Per-tier S3 IAM** (`context/{tier}/`) | The assistant reads only its tier's context (and the sender's own attachment) |
| Async processor - **after** the model call | **Guardrail `source:'OUTPUT'`** | PII anonymize/block, content filters, metadata-marker masking |
| Assistant's `SendChannelMessage` | **IAM + `classification` tag** (bot bearer) | The bot can only post into its own-tier-and-below channel |
| Kinesis archive (async, all events) | **Archival + proactive analysis** | Catches tier mismatches / drift / violations after the fact |

The guardrails act **only on the assistant's turn**; every other row runs regardless of whether an assistant is involved.

### 6.2 Measurement - what each hop emits

Every hop leaves a trace. The join across them (intent × model × experiment × tokens × cost × outcome) is what makes A/B tests, per-tier cost, and quality *measurable* rather than anecdotal.

| Point in the flow | What is measured | Where it lands |
|---|---|---|
| User's send (surface) | client events - optimistic render, UI actions, timing | `client_events` table (Aurora mode) |
| Channel flow / Lex entry | routed? mention type, selected **delivery mode** | archive event + message metadata |
| Fulfillment handler | resolved tier `min(userTier,channelTier)`, classified **intent**, chosen **model**, **experiment assignment** (variant vs `deterministic`) | coded message metadata + analytics record |
| `min(tier)` downgrade | `[SecurityEvent]` when a lower-tier user is in a higher-tier room | logs / security-event trail |
| Async processor - **per Converse step** | one `ConverseStep` per tool-loop iteration: model, tokens in/out, step latency, **estimated cost** (`estCostUsd`), and structured per-tool outcomes `tools[]` (name, ok, bounded `errorClass`, no payloads/PII) | out-of-band analytics, keyed by message id |
| Async processor - reply | totals: input/output tokens, Bedrock time, guardrail action, config fingerprint | `MESSAGE_ANALYTICS_TABLE` (out-of-band, keyed by message id, 7-day TTL) |
| Every channel event | full event stream (message/redact/membership/channel) | Kinesis → conversation archive (Athena/Aurora) |
| Drift / proactive analysis | conversation drift, tier/violation flags | archive-backed analysis (Aurora mode) |

**Two rules keep the measurement trustworthy:**
- **Decoupled from delivery.** The heavy analytics (tokens, latencies, per-step cost, config fingerprint, experiment join) do **not** ride the size-capped Amazon Chime SDK `Metadata`. The processor writes the full blob to `MESSAGE_ANALYTICS_TABLE` keyed by message id; only the small fields the surface renders (`pickFrontendMetadata`) go on the message. So an over-budget reply never drops its analytics or the experiment join (ADR-016; see MESSAGE-DELIVERY-GUIDE + SPEC-MESSAGE-METADATA-CODEBOOK).
- **Fails open.** The analytics writes are env-gated (`MESSAGE_ANALYTICS_TABLE`) and never block or fail a reply - **measurement is best-effort; delivery is not.** The deliberate inverse of the guardrail rule.

The admin dashboard (Overview / Quality / Models / Experiments) reads this telemetry. Because control and measurement ride the **same** path, every enforced decision (tier downgrade, guardrail intervention, model choice) is also a recorded, queryable event - you can *prove* what the harness did, not just assert it.

### 6.3 Where messages and events are recorded (and why several stores)

A single message or event is deliberately written to more than one place. This is not duplication: each store answers a different question, at a different latency and query shape, and none can cheaply reconstruct another. The pattern is **one authoritative event record plus purpose-built read models, joined by a transport.**

| Store | What it holds | Its role | Why it is separate |
|---|---|---|---|
| **Amazon Chime SDK channel** | the live message and current membership | the operational messaging plane: delivery, ordering, membership enforcement | real-time, but Amazon Chime SDK has no cross-channel history API and no single identity sees every channel, so it cannot answer "show me any conversation's full history" |
| **Kinesis stream** | every channel event, in flight | transport and fan-out to independent consumers | decouples the producer from consumers so the archive, the membership audit, and analytics each read the same stream without coupling to each other (at-least-once) |
| **Conversation event archive** (append-only log; S3 + Glue read via an Athena workgroup, in every analytics mode) | the raw event stream: messages (create/update/redact/delete), membership, moderator, and channel events | the **system of record** for history and the audit trail; the retention and erasure-to-archive endpoint | durable, cheap, complete, and immutable, so it is the one faithful history the admin console reads for cross-conversation review and that Legal and HR audit |
| **Aurora Postgres** (Aurora analytics mode) | derived tables: messages and exchanges, evaluations, conversation summaries, cross-conversation context, drift and embeddings, per-turn steps, current membership, client events | the analytics and **live-context** read model | relational joins and pgvector search that S3 and Athena cannot do interactively; it powers the dashboards and the context the assistant is actually given (summary, cross-conversation retrieval, drift) |
| **Per-message analytics** (`MESSAGE_ANALYTICS_TABLE`, DynamoDB, TTL) | the full per-turn analytics blob keyed by message id | measurement decoupled from delivery | it cannot ride the size-capped Amazon Chime SDK metadata (§6.2), and a fast point write means an over-budget reply never drops its analytics or experiment join |
| **Operational stores** (DynamoDB: user feedback, battle outcomes, membership-audit findings and enforce toggle) | per-feature current state | fast key-value state for one feature | point read and write of "what is true now", which is neither history nor analytics |

**The organizing rule.** The event archive is authoritative and immutable; every other store is a **projection optimized for one consumer** - audit (archive), analytics and assistant context (Aurora), per-turn measurement (the analytics table), and operational feature state (DynamoDB). They answer different questions: *what happened* (archive), *what did the assistant know and how good was the answer* (Aurora), *what did this turn cost* (analytics table), *what is the current state of this feature* (operational). Rebuilding any one from another would be slow or impossible, which is exactly why the record fans out.

**The archive does not depend on the analytics mode.** The conversation event archive (Kinesis to Firehose to S3 to Glue to an Athena workgroup) is always-on in **both** Athena and Aurora modes: in the default mode it is part of the Athena analytics stack, and in Aurora mode it is stood up by the shared, always-on `ConversationArchive` construct (`lib/constructs/conversation-archive.ts`). Choosing Aurora mode selects the analytics *query engine* (Athena SQL over the archive, or Aurora Postgres over its own projection); it does not change whether events are archived. The Aurora projection is intentionally lossy (it collapses membership to current state and does not capture moderator events), which is why the archive, not the projection, is the system of record.

**Data-protection consequence.** This shape also gives erasure and retention a defined home: the archive is the controlled retention endpoint, and an erasure removes the live and projected copies while the archive enforces the retention policy (the "erasure-to-archive" calibration in [`SPEC-ADMIN-IDENTITY.md`](../../specs/interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md)).

**Admin-console consequence.** It is why one conversation view draws on two sources: the **event archive** for a faithful, complete history and audit trail (what the Legal, HR, and moderation use cases need), overlaid with the **Aurora projection** for the derived context - summary, cross-conversation context, evaluations, drift, and per-turn steps - that the AI Engineer and Platform use cases need. See [`SPEC-ADMIN-CONSOLE.md`](../../specs/interface/admin/SPEC-ADMIN-CONSOLE.md).

---

## 7. Multi-use-case: the same flow, different bot configs

The `InvokedBy` switch is what makes one substrate serve many use cases. Examples (the last two mirror a sibling deployment this pattern generalizes):

| Use case | `StandardMessages` | Effect |
|---|---|---|
| Private AI assistant (1:1) | `AUTO` | Assistant answers every turn |
| Shared team room | `AUTO` + `@assistant` mentions | Assistant answers only when addressed; humans talk freely |
| Announcement / comment thread (read-mostly) | `NONE` | Assistant stays silent unless a user explicitly `@mentions` it (Amazon Chime SDK `TargetedMessages: ALL` still routes a mention) |

Nothing else in the flow changes - the channel flow, fulfillment, async processor, and enforcement layers are identical.

---

## 8. Key files (AgentEchelon)

| File | Role in the flow |
|---|---|
| `backend/lambda/src/channel-flow-processor.ts` | Channel flow: runs first on every message; `@all` direct-invoke bypass, `/battle`, notify, idempotency |
| `backend/lambda/src/router-agent-handler.ts` | Lex fulfillment / shared router: `min(tier)`, intent classification, model resolution, delivery selection, dispatch |
| `backend/lambda/src/assistant-async-processor.ts` | The shared model-turn processor (one instance per profile, profile-pinned via env) |
| `backend/lambda/src/lib/async-processor-core.ts` | The Converse tool loop, `applyInputGuardrail`/`applyOutputGuardrail`, `handleLongResponse` |
| `backend/lambda/src/lib/intent-classifier.ts` | The separate request-category classifier |
| Bot/Lex CDK wiring | `{tier}-classification-stack.ts` (Lex bot, `AppInstanceBot` `InvokedBy`, channel-flow association) |

## 9. Related

- [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md) - sizing/chunking the reply onto Amazon Chime SDK.
- [`SPEC-INTERACTION-LAYER.md`](../../specs/interaction/SPEC-INTERACTION-LAYER.md) - the interaction-layer feature set this flow powers.
- [`SPEC-PER-PROFILE-OWNERSHIP.md`](../../specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md) - per-tier bots/processors.
- [`IDENTITY-AND-ACCESS-MODEL.md`](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md) §6b - the enforcement layers referenced in §6.
