# Message flow - how a message travels, who touches it, and why

> **The interaction-layer / harness reference.** This traces a message from the moment a user sends it to the moment an assistant reply lands back in the channel - through the **channel flow**, **Lex**, the **fulfillment handler**, and the **async processor** - and says *why* each hop exists and *where each enforcement layer sits*. For how the reply is *sized/chunked* onto Amazon Chime SDK, see [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md); for the security layers named here, see [`IDENTITY-AND-ACCESS-MODEL.md`](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md) §6b; for the model-selection detail, [`SPEC-CONTEXT-AWARE-MODEL-ROUTING.md`](../../specs/interaction/assistant-config/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md).

AgentEchelon is a **multiparty** substrate: humans and assistants share Amazon Chime SDK channels. The flow below is what lets a channel be a plain human-to-human room, a 1:1 human↔assistant chat, or a mixed room where the assistant answers only when addressed - all with the same primitives, differing only in **bot configuration** and **who is addressed**.

---

## 1. What this document assumes

An assistant is not a special channel feature. Assistants are first-party members of the channel, using
the `AppInstanceBot` feature of Amazon Chime SDK. AgentEchelon uses that service to trigger assistant
responses, and adds custom flows that bypass the standard path (where Lex is a passthrough) and reach
the AgentEchelon turn directly.

**Everything below assumes an assistant configured the default way:**

- `StandardMessages: AUTO` and `TargetedMessages: ALL` on the bot, so Amazon Chime SDK decides which
  messages become a turn (§2). `NONE` is a supported variation and changes only which messages arrive.
- One classification-matched bot per channel, bound at channel creation, so "which assistant is in this
  room" is fixed to the room's `classification`.
- The bot's Lex has a `WelcomeIntent` (fires on join) and a `FallbackIntent` (carries every real user
  turn), both with a fulfillment code hook pointing at that classification's handler.

**How assistants are configured is out of scope here**, and lives in
[`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](HOW-TO-ADD-OR-MANAGE-A-PROFILE.md): the three wiring layers, the
`InvokedBy` switch and what each setting is for, the ordering rule when adding a bot to a channel, and
per-use-case configurations. This document is only about what happens to a message once it is sent.

---

## 2. Channel Flow first, then Lex

When a message is sent, the **Channel Flow Processor** runs **first**: it is Amazon Chime SDK's synchronous message interceptor, and **every** message passes through it *before* delivery. Only once the flow **releases** a message (`callbackAllow`) is it delivered to the channel's members - and only then is the assistant's **Lex** bot invoked (per its `InvokedBy` config) on the messages addressed to it. A denied message never reaches the members or the bot.

```
        A message is sent (by a human, or by an assistant)
                │
                ▼
    ┌──────────────────────────────┐
    │  Channel Flow Processor      │  runs FIRST, synchronously, on EVERY
    │  (channel-flow-processor.ts) │  message (human-to-human included),
    │                              │  BEFORE delivery:
    └──────────────┬───────────────┘  callbackAllow (release) / callbackDeny (drop)
                   │ released
                   ▼
    ┌──────────────────────────────┐
    │  Amazon Chime SDK Channel    │  (message delivered, tagged classification)
    └──────────────┬───────────────┘
                   │ delivered to members (the bot is a member)
                   ▼
    ┌──────────────────────────────┐
    │  The service decides whether │  THREE tests, in the service, not in AE:
    │  invokes the assistant's Lex │
    │                              │  1. Was it sent by an AppInstanceBot?
    │                              │     If so it invokes NOTHING. Always.
    │                              │  2. Is it Target-ed at this bot?
    │                              │     TargetedMessages: ALL -> invoke.
    │                              │  3. StandardMessages: AUTO ->
    │                              │     ONE other non-hidden member: invoke
    │                              │       on every message;
    │                              │     MORE than one: invoke only on a
    │                              │       CHIME.mentions naming this bot.
    └──────────────┬───────────────┘
                   │ invoked
                   ▼
    ┌──────────────────────────────┐
    │  Fulfillment handler          │  the turn (see §4)
    └──────────────────────────────┘
```

**Two properties of that middle box are load-bearing and neither is in the AWS documentation.**

**A message authored by an `AppInstanceBot` never invokes another `AppInstanceBot`.** Verified against
a live deployment with a control: a targeted message from a bot to a bot produced zero handler
invocations, while the identical message from a user principal produced one; the bot-sent message
carried a valid `Target`, was `SENT`, and reached the channel flow, so it was delivered and simply
triggered nothing. This is platform-level loop prevention, and it means **assistants cannot coordinate
by talking to each other** - see [ADR-023](../../design/decisions/023-battle-round-coordination.md).

**`AUTO` counts OTHER NON-HIDDEN MEMBERS, and bots count.** The rule is not "1:1 versus group"; it is
one other member versus more than one, from this bot's perspective. So **adding a second bot to a 1:1
flips the first bot from answering everything to answering only mentions**, silently. A hidden
membership does not avoid it, because a hidden member cannot send messages and an assistant has to.

**The two components, in order:**

- **Channel Flow Processor** (`channel-flow-processor.ts`) is the **gate**. It runs on **every** message - human-to-human included - *before* it is delivered, and it **must call `ChannelFlowCallback`** to release each message (`callbackAllow`) or hold/deny it (`callbackDeny`). This is the conversation-level layer that exists **whether or not an assistant is involved** (see [IDENTITY-AND-ACCESS-MODEL §6b](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md#6b-defense-in-depth--guardrails-are-one-layer-not-the-boundary)). In AgentEchelon it does: `@all` fan-out (see §3), `/battle` orchestration, notify directives, and idempotency for at-least-once delivery - and it is the natural home for any future conversation-level content rule.

The flow is also where **message identity** is established. It is the only component that sees a stable Amazon Chime SDK `MessageId` for every message: Lex fulfillment does not receive one (the request attributes are `CHIME.channel.arn`, `CHIME.sender.arn` and `x-amz-lex:channels:platform`), and the async processor runs after the router has already returned. Anything that needs to answer *"which message is this?"* - deduplicating an at-least-once delivery, or resolving which placeholder to update - anchors here. See [ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md).
- **Lex** is the assistant's entry trigger, invoked on the **released** message. It only produces an assistant turn when `InvokedBy` says this message is for the bot.

Because the flow is a synchronous gate, Lex never sees a message the flow denied. Two cases are handled inside the flow rather than through Lex: `@all` and `/battle` (see §3 and §3.1).

---

## 3. Which messages reach the assistant (routing)

Three cases, decided by `InvokedBy` + how the message is addressed:

| Case                                                                                                                                         | Config                                                                                          | What happens                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1:1 human↔assistant**                                                                                                                      | `StandardMessages: AUTO`                                                                        | Amazon Chime SDK routes **every** message to Lex → fulfillment                                                                                                                                                                                                                                                                                                   | In a private assistant chat every turn is for the assistant; no addressing needed.                                                                                                           |
| **Multi-user, `@<assistant>`** - any assistant in the conversation, by its member name | `TargetedMessages: ALL` + the frontend stamps `CHIME.mentions` with that bot's ARN. `parseMentions` matches `@<name>` against **every non-self member of the channel**, human or assistant, so the token is whatever that assistant is called here; `@assistant` is only the default name. At most one assistant and one human per message (`multiple_bots` / `multiple_humans` block the send) | Amazon Chime SDK routes only the **addressed** message to Lex → a **targeted** reply back to the sender                                                                                                                                                                                                                                                          | In a shared room the assistant must stay silent unless spoken to. `@assistant` is a real Amazon Chime SDK mention, so **AUTO + native routing** handles it - no processor code.              |
| **Multi-user, `@all`**                                                                                                                       | Lex bypass                                                                                      | Channel Flow **detects `@all`**, releases the original message to everyone, strips `@all`, and invokes the classification's handler with the turn; the handler acknowledges as the assistant itself (§5.1) and the reply is broadcast. This bypasses the Lex flow so that a specific assistant can be invoked, but replies back to all members of the conversation | `@all` is *not* an Amazon Chime SDK `CHIME.mentions` value, so AUTO/Lex would not route it. **In a group only:** the composer offers `@all` only when the channel has two or more humans (`MessageInput.tsx`), so a 1:1 `@all` is reachable only by typing it, and the flow stands aside for it (§3.1) rather than answering twice. |
| **Multi-user, `/battle`**                                                                                                                    | Lex bypass                                                                                      | Channel Flow **detects `/battle`** at the start of a message and hands the same prompt to the handler once per participating assistant (see [DESIGN-BATTLE](../../specs/capabilities/DESIGN-BATTLE.md)). This bypasses the Lex flow to enable a custom workflow and response pattern.                                                                            | A slash command is not an Amazon Chime SDK mention either, and one user message has to produce two responses. Gated on the channel's classification (premium by default).                    |
| **Multi-user, no mention**                                                                                                                   | -                                                                                               | The message is released to members; **no assistant turn**                                                                                                                                                                                                                                                                                                        | Silence by default in shared rooms - the assistant does not answer un-addressed chatter.                                                                                                     |
| **Multi-user, an ANSWER to a work item** | the composer addresses it: `Target` = the assistant that asked, `Metadata.task.id` = the item it answers (`MessageInput.tsx`) | Amazon Chime SDK routes it to that bot's Lex like any other addressed message, and the turn resolves the chain from the TASK ([ADR-030](../../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md)). If the address is missing, **post-processing** dispatches the turn after delivery from the task reference, and COUNTS it ([ADR-032](../../design/decisions/032-where-a-rule-runs.md), `lambda/src/lib/task-answer-repair.ts`) | Silence by default is right, and it is exactly what strands a person answering a question they were asked. The client knows what is being answered - it rendered the item - so it addresses the message; the count says how often it failed to, so the repair cannot quietly become the primary path. |
| **Answering a waiting side**                                                                                                                 | none - an ORDINARY turn                                                                          | The reply reaches the addressed bot's Lex like any other message and the turn resolves what it answers from the TASK ([ADR-030](../../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md)). The side leaves `WAITING_FOR_USER`, the answer is broadcast and the person gets a targeted receipt                                                                                                              | Targeting is a DELIVERY concern the client settles at send; what a message is ABOUT comes from the chain, which names the assistant whose work it is. The flow still carries a `Target`-gated deny branch for this case, and it cannot fire: the flow callback delivers no `Target` at all (tracker row 94), so `extractTargetedBotArns` is always empty. It is superseded by ADR-030, not repaired. |
| **Any message sent by an assistant**                                                                                                         | -                                                                                               | Never invokes any assistant, whatever its `Target` or mentions. The route that WOULD work is [ADR-023 B-proxy](../../design/decisions/023-battle-round-coordination.md): give each assistant a second `AppInstanceUser` principal and send coordination as that principal, so every hop is user-to-bot and routes both ways. Explored, it works, and it is DEFERRED - it buys coordination-in-the-archive at the cost of a second identity per assistant and of owning loop safety that Amazon Chime SDK currently provides for free | Platform-level loop prevention, measured (§2). It is why assistants cannot coordinate by messaging each other **as bots**.                                                                               |

**There are six bypasses, not two:** `@all`, `/battle`, the battle continuation, and - none of them a
channel message - the round-2 dispatch, which the orchestrator fires by invoking a Lambda, the
handover, which one handler fires at another, and the post-processing dispatch, which the message
stream fires for a task answer that reached nobody. The first three are decided by the channel flow.
Every one of them ends at the **same handler and the same per-classification async processor** as an
ordinary turn.

**The handover is the one bypass an assistant decides for itself.** Routing follows the TASK: a chain
names the `assistantId` whose work it is, and an assistant that receives an answer to a chain it does
not own invokes the owning assistant's turn rather than answering work that is not its own or dropping
the message. Whether the person addressed nobody or addressed the wrong assistant is the same case,
because targeting is a delivery concern the client settled at send. It is a Lambda invoke and not a
message for the reason in §2: a bot-authored message never invokes another bot, so a handover sent as a
message would reach nobody. The identity it answers as is validated by `isSanctionedBattleBot`, the
same gate that guards a caller-supplied identity, and only a turn that did NOT arrive by handover may
create one, so the hop is bounded at one structurally rather than by a self-declared counter.

**Who posts the first visible message, per shape.** This is the one thing that genuinely differs, and
it decides reply visibility for everything downstream. The words are the assistant's on every shape,
resolved from the profile version the turn loaded; what differs is which component performs the send.
§5.1 states the rule, the timing, and the identifier that ties the message back to the turn.

```
  ENTRY SHAPE             DECIDES A TURN       POSTS THE FIRST BUBBLE          ITS Target
  ──────────────────────  ───────────────────  ──────────────────────────────  ───────────────
  ordinary Lex turn       Chime routing        Amazon Chime SDK, from the      the inbound's
   1:1, or @<assistant>    (InvokedBy)          fulfillment return              SENDER

  drift-spawned welcome   Lex WelcomeIntent    Amazon Chime SDK; the welcome   none, broadcast
   only when spawned                            IS the placeholder

  @all                    the channel flow     the TURN, as the assistant      none, broadcast
   not a service mention   (hands off)

  /battle round 1         the channel flow     the TURN, one per side,         none, broadcast
   one turn per side       (hands off)          each as its own bot

  answering a waiting     service routing      the TURN: a NEW placeholder,    the answer: none
   side                    (an ordinary turn)    like any other turn             the receipt: the
                                                                                 SENDER

  round 2                 the orchestrator     the orchestrator                none, broadcast
   not a channel message   (Lambda invoke)      (until ADR-023 A-prime)

  handover                the receiving        the RECEIVING assistant, a      the SENDER
   not a channel message   assistant            receipt naming where the        (the receipt)
   (Lambda invoke)         (routing follows     work went; then the owning      + none, broadcast
                            the task)           assistant's own turn            (the answer)
```

**A resumed chain always delivers the same two messages** (`planResumedChainDelivery`): the ANSWER
untargeted, because a duel is a comparison and a task step's result belongs to the conversation, and a
RECEIPT targeted at the person who spoke, because it is a confirmation for them and not news for
everyone else. Neither rides Amazon Chime SDK's inheritance. A Lex reply inherits the inbound's
targeting, which inverts the pair with how the person happened to send: a targeted inbound yields a
private placeholder, so the answer would be buried where only its sender can read it; an untargeted one
yields a public placeholder, so the receipt would be broadcast and the channel would get the answer AND
a note saying the answer is elsewhere. The processor reads the placeholder's real `Target` and posts
whichever of the two is missing. On a handover the receiving assistant has already given the receipt,
so the owning assistant's turn posts only the answer.

**The channel flow sets a `Target` on nothing it posts for a turn.** Its only targeted sends are its
own rejection notices to the asking user (not battle-eligible, not enabled, already in flight, over
budget, unwired router). Reply visibility is never passed as a parameter: the processor reads it back
off the placeholder with `GetChannelMessage`, both for continuation chunks and for the sticky-mention
signal, so whoever posts the placeholder decides what everything after it inherits.

---

## 3.1 The bypass differs from the Lex path in ONE thing

**The rule: bypassing Lex is the only sanctioned difference.** The channel flow decides *who
responds* - that is its job, and it is the only component positioned to decide it, because it is the
only one that sees every message with a stable `MessageId` (§2). Everything after that decision is the
ordinary turn: intent classification, profile resolution, experiment-variant resolution, model
selection and the tool loop all belong to the **handler** (`router-agent-handler.ts`), which is the
same code Lex fulfills into.

So a bypass hands the turn to the handler. It does not re-implement the turn.

| | Ordinary turn | Lex bypass (`@all`, `/battle`) |
|---|---|---|
| Who decides a turn happens | Amazon Chime SDK routing + `InvokedBy` | the channel flow |
| Who classifies, resolves the profile and the variant | the handler | **the handler** |
| Who posts the placeholder | Amazon Chime SDK materialises the fulfillment response | **the handler**, posting as the assistant ([ADR-025](../../design/decisions/025-who-posts-the-placeholder.md)); the flow posts only if the turn hands the message back (§5.1) |
| Who generates the answer | the async processor | the async processor |

**What the flow's job reduces to, stated as a rule.** The flow exists on the turn path to do ONE
thing: notice that Amazon Chime SDK's routing cannot express this addressing, and hand the turn to the
handler anyway. It does not target, does not classify, does not choose a delivery option and does not
decide what a turn IS. The one power that is genuinely exclusive to it is **denial** - it is the only
component that can stop a message being delivered at all.

**Nothing on the turn path needs that power today.** Answering a waiting side was the case that did,
and it is an ordinary turn now ([ADR-030](../../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md)):
a reply is DELIVERED, and keeping it is what makes the exchange reconstructable afterwards. Denial
survives for the duplicate-placeholder guard and the empty-envelope drop, neither of which is a user's
message.

That boundary is not cosmetic. `@assistant` needs no flow code whatsoever, because it is expressed in
a vocabulary Amazon Chime SDK's router already understands; `@all` needs the flow only because it is
not. The same user intent, routed natively in one case and by AE in the other, and the difference is
the vocabulary rather than the semantics.

**Why the placeholder is the one legitimate difference.** Lex materialises a message from the
fulfillment return; a bypass has no Lex return to materialise, so somebody has to call
`SendChannelMessage`. That difference is unavoidable and it is also harmless to measurement: TTFF is
`placeholder timestamp - user message timestamp` on the Amazon Chime SDK clock, which does not care
which component wrote the placeholder (see [LATENCY-TARGETS](LATENCY-TARGETS.md)).

**Why the rest must not differ.** Every decision duplicated on the bypass is a decision that can
diverge from the ordinary path, and divergence here is silent: the turn still answers, so nothing
errors. A profile configured for keyword classification still paying for a model call, a classifier
experiment that never sees `@all` traffic, or a variant resolved twice at two different freshnesses
are all the same defect wearing different clothes.

**Status: every channel-flow path hands off. Round 2 does not yet.**

`@all`, `/battle` round 1 and the battle continuation all resolve the channel's classification and
invoke that classification's handler synchronously with the turn. The handler posts its own
acknowledgment and returns an empty `messages` array; the flow posts only when a turn hands its message
back (§5.1). The flow decides *who responds* and nothing else: the intent, the delivery option, the
profile, the variant and the correlation id are all the handler's, from the same code an ordinary turn
runs.

**Round 2 is the one path still running turn logic outside the handler.** `battle-orchestrator.ts` is a
separate Lambda and a third way into the worker: it hardcodes the intent and the delivery option and
resolves both variants itself. It cannot be fixed by having one assistant message the other, because a
message authored by an `AppInstanceBot` never invokes another one (§2), so the dispatch stays an
out-of-band call; routing it through this same handler entry is
[ADR-023](../../design/decisions/023-battle-round-coordination.md) A-prime.

The distance is measured rather than remembered: `flow-does-not-run-the-turn.test.ts` pins each
turn-path symbol per path, ratchets both ways so the counts only fall, and asserts the path list is
complete, so a new bypass is a new entry rather than a silent omission.

### 3.2 `/battle` is an interactive A/B test, and that raises the bar

A duel exists to predict what a variant would do in production, so the closer a battle turn is to an
ordinary turn, the more a battle result is worth. That is why a duel takes the same handoff as `@all`
rather than running its own turn logic: a battle that resolves its own models on its own path measures
an engine no user ever meets.

What a battle result may and may not claim - round 2 having no production analogue, and a duel
measuring preference under direct comparison rather than production performance - is stated in
[DESIGN-BATTLE](../../specs/capabilities/DESIGN-BATTLE.md) and is not repeated here.

### 3.3 Where `/battle` differs, and what each difference costs

Under the handoff the sanctioned differences are these and no others. Each is listed with its
consequence, because an undocumented difference reads as unexpected behaviour at the moment someone
is debugging something else.

| Difference | Why it is unavoidable | What it costs |
|---|---|---|
| The assistant posts its own placeholder, not Lex | A bypass has no Lex return to materialise, and the words are the assistant's ([ADR-025](../../design/decisions/025-who-posts-the-placeholder.md)) | Nothing to measurement: TTFF is placeholder minus user message on the Amazon Chime SDK clock, which does not care who wrote it. This holds for round 1 and the clarification continuation, which dispatch through the handler. Round 2 still has its placeholder and its degraded-path notices posted by the orchestrator, because it does not yet dispatch through the entry (ADR-023 A-prime) |
| One user message, N responding assistants | That is the feature | **One** rate-limit and spend charge, not N. The flow gates the duel as a whole and the handler skips its gate on any battle context, so a duel refuses or runs together; a rejection landing between the sides would leave one answer with nothing to compare it against, which is measurement bias. Fidelity is deliberately traded for that guarantee (owner, 2026-08-09) |
| Round 2 is fired by the orchestrator, not a user | A rebuttal answers a rival, not a person | No user message to measure from, so **TTFF is undefined and must be null, not zero**; these rows carry a non-user trigger and stay out of TTFF averages |
| Coordination context rides the turn (`battleContext`) | A side cannot derive its own battle id, round, rival or which variant it is | None to resolution - the side still resolves its model, persona and tools on the ordinary path; the context only tells it *which* side it is |
| Each side answers as its own bot identity | The duel must show two authors | The handler is told which identity to answer as rather than resolving its own, so that identity has to be **validated against the alt-slot roster** rather than trusted from the caller |
| Battle work precedes the placeholders | Membership, eligibility and the single-active-battle claim gate the duel | Adds latency ahead of the first visible feedback, on the `/battle` turn only |

Two things the bypass passes that the handler cannot derive, and they are coordination context, not
turn logic:

- **the inbound `MessageId`**, so the turn's correlation id is *declared* rather than derived from a
  time bucket. Only the flow sees a stable id on every message; Amazon Chime SDK does not give Lex
  one. A redelivery therefore still collapses.
- **the attachment**, read from the message Metadata. Lex never sees Metadata, so this is the only
  route by which a file can reach a turn at all.

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

**Retrieval and drift run off-handler (ADR-013).** In Aurora mode, step 4 does not run in the handler's own process: the handler is non-VPC, so it invokes a VPC-attached **data-plane Lambda** that does the embedding + pgvector work (RAG retrieval and drift detection) and returns results. This keeps the Lex-facing handler off the VPC path. See [RAG.md](RAG.md) and [INFRASTRUCTURE-COST.md](../admin/INFRASTRUCTURE-COST.md).

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

### 5.1 Placeholders and correlation: who posts, when, and under which identifier

Six entry shapes reach the same processor, and each has to answer the same three questions: who sends
the first visible message, at what point in the turn, and what identifier ties that message back to the
work that will replace it. This section is the single answer to all three. The decisions behind it are
[ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md) (which
identifier, and where identity comes from) and
[ADR-025](../../design/decisions/025-who-posts-the-placeholder.md) (who performs the send).

```
   USER MESSAGE                                       the MessageId M exists from here on
        │                                             (§3 decides WHICH of the two paths below)
        ▼
  ┌───────────────────────────┐   runs FIRST on every message
  │  Channel Flow Processor   │   callbackAllow (release)  /  callbackDeny (drop)
  └──────┬─────────────┬──────┘
         │ released    │ bypass: @all, /battle, continuation. Invoked SYNCHRONOUSLY, with
         ▼             │ the ids the flow holds: M for @all, a minted battle id per side for
    ┌─────────┐        │ a duel, and for a continuation the waiting message to answer onto
    │   Lex   │        │
    └────┬────┘        │
         └──────┬──────┘
                ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  THE TURN (router-agent-handler.ts)   same code, whichever path arrived       │
  │   1. mint the correlation id:  declared (mention-M, battle-*) if the caller   │
  │      supplied one, else derived (channel + sender + text + 90s bucket)        │
  │   2. claim dedup#fulfil-<id>   a duplicate fulfillment replays, does no work  │
  │   3. DISPATCH the async processor (it claims dedup#<id> of its own)           │
  │   4. only THEN produce the acknowledgment, carrying <!--corr:{id}-->          │
  └──────┬────────────────────────────────────────────────────────┬──────────────┘
         │ Lex path: return the text                              │ bypass: the turn
         ▼                                                        ▼ SENDS it itself
  ┌──────────────────────────┐                            ┌──────────────────────────┐
  │ the service materialises │                            │ SendChannelMessage as    │
  │ into a channel message   │                            │ this assistant's bot     │
  └──────────┬───────────────┘                            └───────────┬──────────────┘
             └──────────────────────┬─────────────────────────────────┘
                                    ▼
              THE PLACEHOLDER IS A MESSAGE, so it re-enters the flow
                                    │
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  Channel Flow, second pass:  claim corr#<id> -> MessageId (WRITE-ONCE)        │
  │   a DIFFERENT message holding the same id is a duplicate placeholder: DENIED  │
  │   written while the message is still in flight, so it lands before the        │
  │   placeholder is visible to ListChannelMessages at all                        │
  └──────────────────────────────────┬───────────────────────────────────────────┘
                                     ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  Async processor: model call, tools, guardrails                              │
  │   at FINALIZE, read corr#<id> -> the message to update  (see the ladder below)│
  │   UpdateChannelMessage IN PLACE                                              │
  └──────────────────────────────────┬───────────────────────────────────────────┘
                                     ▼
        the answer replaces the placeholder text, and with it the marker, so the
        next turn's history load stops counting it as an unanswered placeholder
```

#### The four rules

1. **The component that composed the words performs the send.** The acknowledgment is resolved from
   the profile version the turn loaded (`getQuickResponse` / `getTaskPlaceholder`), so the turn speaks
   it. On the Lex path Amazon Chime SDK performs the send instead, because a fulfillment return is
   materialised into a message whether or not it carries one, and suppressing that would leave a stray
   empty envelope on every ordinary turn (ADR-025 option 2, priced and rejected).
2. **One visible acknowledgment per responding assistant per turn.** Enforced in the channel by the
   flow's write-once `corr#` claim, not by trusting each entry to send once. The claim keys on the
   correlation id, so it collapses a duplicate only where that id is replay-stable (see "Known limits").
3. **Nothing posts before it dispatches, and no component hands over an id it obtained by posting.**
   Holding the id would require reordering every return path in the handler to save one `GetItem`
   (ADR-025). The battle continuation is the one exception and a different case: the id it hands over
   names a message that already existed before this turn began.
4. **The channel flow does not author a turn's acknowledgment.** It sends in exactly two cases: its own
   rejection notices (not battle-eligible, not enabled, already in flight, over budget, unwired router),
   which are the flow speaking for itself; and the hand-back fallback, where a turn that could not post
   returns the text and the caller posts it on the assistant's behalf, so an Amazon Chime SDK hiccup does not become
   a turn that answered and showed nothing.

#### Who posts, and when

| Shape | Who performs the send | When, relative to the worker dispatch |
|---|---|---|
| ordinary Lex turn | Amazon Chime SDK, from the fulfillment return | after: the handler dispatches, returns, and Chime materialises |
| drift-spawned welcome | Amazon Chime SDK; the welcome IS the placeholder, and the answer updates it in place under `messagePrefix` so the orientation copy survives | after |
| `@all` | the turn handler, as the assistant (`postAsAssistant`) | after: `runTurn` dispatches, then the entry wrapper sends |
| `/battle` round 1 | the turn handler, once per side, each as its own bot identity | after |
| battle continuation | the turn, on a NEW placeholder (ADR-029). The message holding its clarifying question stays in the transcript; the turn only clears that message's `<!--battlewaiting-->` marker, which is what ends the frontend's waiting affordance | after, exactly as every other bypass |
| round 2 | the battle orchestrator (`battle-orchestrator.ts`) | before: it posts, discards the returned id, then invokes the processor directly |

Round 2 is the one row that still performs an acknowledgment it did not resolve, because it does not
yet dispatch through the handler entry. Moving it there ([ADR-023](../../design/decisions/023-battle-round-coordination.md)
A-prime) folds it into the round-1 row and leaves exactly two senders on a turn path: Amazon Chime SDK
on the Lex path, and the assistant everywhere else.

#### Which identifier

One `correlationId` per **responding assistant** per turn, so a two-sided duel has two. It does four
jobs at once, which is why there is one of it and not four: it labels the placeholder as
`<!--corr:{id}-->` in message content, keys the fulfillment-dedup and worker-dedup claims, keys the
`corr# -> MessageId` ownership mapping, and joins that turn's task, analytics and archive records.

**The rule: it is derived from evidence a redelivery provably replays.** A random id per delivery gives
each attempt its own label, which is how one user message produced two placeholders and two answers.

| Path | Derivation | Minted by | Replays identically? |
|---|---|---|---|
| ordinary Lex turn | `turnCorrelationId(channelArn, senderArn, transcript, 90s bucket)`, 16 hex | the handler | yes |
| drift-spawned welcome | the same derivation, over the **spawning** message | the handler | yes |
| `@all` | `mention-<inbound MessageId>` | the handler, from the id the flow declares | yes |
| `/battle` round 1 | `battle-r1-<bot>-<timestamp>-<random>` | the channel flow | **no** |
| battle continuation | `battle-r1c-<bot>-<timestamp>-<random>` | the channel flow | **no** |
| round 2 | `battle-r2-<bot>-<timestamp>-<random>` | the orchestrator | **no** |

The Lex path derives rather than declares because it has nothing to declare: Amazon Chime SDK sends Lex
exactly three request attributes (`CHIME.channel.arn`, `CHIME.sender.arn`,
`x-amz-lex:channels:platform`) and a message id is not among them. Every flow entry hands the inbound
`MessageId` over instead, so its id is exact rather than window-derived.

**Do not confuse the correlation id with the battle id.** `deriveBattleId(channelArn, userMessageId)`
identifies the DUEL and is deterministic; the per-side correlation ids above identify each side's turn
within it. The three battle rows do not satisfy the rule, and what covers them instead is described
under "Known limits" below.

#### How the answer finds its placeholder

The flow is the only component that sees a stable `MessageId` for every message, including the ones
Amazon Chime SDK materialises from a Lex return: measured live, a targeted assistant reply invoked the
flow for its own MessageId. So every placeholder gets a second pass through the flow, whoever sent it,
and the flow writes `corr#<id> -> MessageId` write-once while the message is still in flight - before it
is visible to `ListChannelMessages` at all. What no component has is the id *before* the message exists.

An empty `{"Messages":[]}` envelope is **not** part of this path and is not described here: on an
ordinary turn Lex returns exactly one placeholder, and a turn with no Lex in it produces no envelope at
all. See [Appendix A](#appendix-a-the-empty-lex-envelope), which records what still produces one, what
the flow does with it, and why a nonzero count is a signal rather than background noise.

The processor therefore resolves in this order (`resolvePlaceholderTarget`, `async-processor-core.ts`):

1. **The claimed owner of `corr#<id>`**, read from the control table. This is the normal path on every
   shape, and it wins over a handed id deliberately: the flow's guard and the processor's dedup claim
   pick their winners independently, and when they disagreed the answer landed on a message the flow
   had already denied while the user watched the surviving "One moment..." forever.
2. **A handed `placeholderMessageId`** - **no producer since [ADR-029](../../design/decisions/029-clarification-is-public-and-answers-get-their-own-placeholder.md)**. The battle continuation was the only caller; it now posts its own placeholder like every other turn, and names the question message separately as something to un-mark rather than to answer onto. The branch is kept until its removal is done deliberately with tests.
3. **A deferred marker scan** (`scanForPlaceholderMessage`) run once, after the answer is ready. A miss
   at dispatch time is normal rather than a failure: the processor is usually dispatched before the
   placeholder exists, and `ListChannelMessages` is billed, so this runs at answer time or not at all.

**When nothing resolves, the turn is reported failed rather than repaired.** Posting a replacement
would duplicate the answer and strand the original bubble, so the processor logs the condition named in
[TROUBLESHOOTING §19](../user/TROUBLESHOOTING.md) and fails any task the turn opened.

A duplicate fulfillment on the Lex path is stopped upstream, in the handler: a retried fulfillment
derives the same correlation id, fails to claim it, and **replays the same placeholder** - identical
`<!--corr:-->` marker, no work done. It does not go silent, because Amazon Chime SDK materialises one
message per turn from the LAST fulfillment response, so returning nothing would suppress the only
message that reaches the channel. Replaying makes the two attempts interchangeable: whichever
materialises carries the marker the dispatched processor is looking for.

#### What is claimed, and by whom

Three namespaces on the shared control table, three different jobs. Reading one as another is what made
the same guard look present and be absent.

| Key                   | Written by          | Collapses                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedup#fulfil-<corr>` | the handler         | a DUPLICATE fulfillment of one turn. An exception, not the shape of ordinary traffic: one user message is one turn, and a duel is one turn per side. See "How often is there a second fulfillment" below |
| `dedup#<corr>`        | the async processor | two **executions** of one dispatch                                                                                                                                                                                                                                         |
| `corr#<corr>`         | the channel flow    | two **placeholders** for one turn, and it is also how the answer finds its message. Write-once, and read only from a message whose sender is an `AppInstanceBot` (`/bot/` in the ARN), because a user can type a marker                                                    |

The battle paths carry their own claims in the battle state table for the same purpose:
`tryClaimRound1Fanout(battleId)`, `resumeBotFromWaiting` (WAITING_FOR_USER to INVOKED) and
`tryClaimOrchestratorFire`. All three key on the deterministic `battleId`, which is what makes a duel
idempotent even though its correlation ids are not.

#### Why three keys and not one

The placeholder's `MessageId` is what the mapping RETURNS, never what any claim is keyed on, and it
cannot be: two of the three claims have to be taken before a placeholder exists at all.

| Moment | What exists yet | The key, and what it can still prevent |
|---|---|---|
| the handler, before it dispatches | the turn, and nothing else | `dedup#fulfil-<corr>` stops a second fulfillment dispatching a second worker, and it is what lets the losing attempt return the IDENTICAL placeholder rather than a second one |
| the processor, entering execution | usually still no placeholder | `dedup#<corr>` stops a retry of the asynchronous invoke making a second model call |
| the flow, as the placeholder crosses it | the `MessageId`, for the first time | `corr#<corr>` keeps one placeholder per turn, and stores the id the answer lands on |

So this is **one identifier used at three moments, not three identifiers**. The prefix namespaces the
question; the value after it is the same correlation id in all three.

They do not fold into one. Drop the handler's claim and the worker's claim still collapses the
duplicate, but only after both fulfillments have dispatched, and by then the losing one has composed a
response it cannot make identical because it does not know it lost. Drop the processor's claim and a
retry of the asynchronous invoke is unguarded, which the handler cannot see because it has already
returned. Drop the flow's claim and nothing resolves the answer onto a message.

The battle-state claims answer a different question again - has this duel already fanned out, is this
side already resumed, has round 2 already fired - which no correlation-scoped key can answer, because
the correlation id is per side and per round while the duel is one thing.

#### How often is there a second fulfillment

Rare, and rarer since the systematic cause was removed. Two things used to produce a second turn for one
user message, and only one of them remains:

- **Two ENTRIES, now fixed at the root.** `@all` used to take the flow bypass at every channel size
  while Lex also invoked the handler in a 1:1, so one message was handled twice - and because the two
  entries derive the id by different rules, neither claim could see the collision. Measured 2026-08-12:
  two placeholders 558ms apart, one stranded forever. The member-count branch (`lib/channel-size.ts`)
  makes the two decisions exact complements, so exactly ONE entry runs at any size.
- **Two FULFILLMENTS of one entry, which remains.** Measured 2026-08-06: one turn in 52 over 24 hours
  produced two fulfillments 2.6s apart carrying a byte-identical transcript. The cause is not
  established, it is not a response-time retry (a 4222ms turn did not duplicate while a 3055ms one did),
  and nothing in this codebase invokes the handler - Lex does. That shape is what at-least-once delivery
  looks like.

So the `dedup#fulfil-` claim is insurance against a rare platform behaviour, not a control the ordinary
path leans on. Over the 7 days to 2026-08-13 the deployed flow logged **0** duplicate-placeholder
denials across 736 invocations. Separating "Lex asked twice" from "our code ran the turn twice" needs
the Lex conversation logs, which are on for every classification as of 2026-08-13; that measurement is
owed rather than done.

#### Known limits

Stated here because each one reads as settled until someone designs against it.

- **The battle correlation ids are not replay-stable**, so `corr#` cannot collapse two placeholders on
  those paths: two deliveries produce two keys and both placeholders survive the guard. The
  battle-state claims above are what actually prevent it. Deriving those ids from evidence instead
  (`battleId` plus the side, plus the inbound message id for a continuation) would put every path under
  one guard and demote the battle claims to defense in depth.
- **`previousBucket` has no production call site.** `turnCorrelationId` accepts it and only the unit
  test passes it, so a retried Lex fulfillment that straddles a 90 second bucket boundary derives a
  different id and is not collapsed. The affordance exists; the coverage does not.
- **`placeholderMessageId` names two different things**: a message this turn created, and a
  pre-existing message this turn writes onto. Only the second is in use.
- **Six sites compose the `<!--corr:` marker** (the handler in five branches, the flow's continuation
  fallback, the orchestrator). There is no single composer, so a change to the marker format is a
  six-site edit.

### 5.2 What the model is given as conversation history

The processor rebuilds the conversation from the channel on every turn (`loadChannelHistory`), rather than carrying state between invocations. Amazon Chime SDK Messaging is the authoritative record; the async processor is stateless.

Two properties of that rebuild are load-bearing, and both fail silently when they are wrong - the turn still answers, fluently, from a context that is missing something.

**Placeholders are excluded by their marker, never by their wording.** An unanswered *"One moment..."* must not be fed back as an assistant turn. Every placeholder carries `<!--corr:{id}-->`, and the answer arrives as an update whose content has no marker, so the marker identifies exactly the placeholders and stops matching the moment one is resolved. Matching on the copy instead does not work: every placeholder ends in an ellipsis (*"One moment..."*, *"Analyzing..."*, *"Looking into that..."*), and so does ordinary prose, so a substring test on `...` deletes real assistant turns from the next turn's context. That drop is invisible and intermittent, because it depends on whether one reply happened to use an ellipsis.

**Roles are perspective-based.** From the model's own vantage only ITS OWN prior turns are `assistant`; every other participant - the human and any other assistant, such as a battle rival - is the `user` side. This is what lets another assistant's image ride a valid `user` turn, since Bedrock permits image blocks only on user turns.

**A leading run of assistant turns is promoted out of the history** into `priorAgentContext`, which becomes a system-prompt instruction not to repeat itself. The welcome message is the usual occupant. A history that begins with assistant turns and contains no user turn therefore contributes nothing to the message array, which is correct on a first turn and a symptom on any later one - see [TROUBLESHOOTING §20](../user/TROUBLESHOOTING.md).

**The current turn is consolidated WITH the history, not appended after it.** Bedrock requires alternating roles, which is what consolidation exists to guarantee; consolidating the history alone and then appending the user's message re-creates the adjacency whenever the history ends on a user turn. That is a routine state, not an exotic one: it is what remains when the trailing bot message is a placeholder still awaiting its answer.

The history load logs the role shape alongside the count, because the count alone cannot diagnose a context complaint - `aua` and `aa` are both length-adjacent readings of the same conversation, and only one of them is healthy.

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
| Async processor - model + context read | **Per-tier S3 IAM** (`context/{classification}/`) | The assistant reads only its tier's context (and the sender's own attachment) |
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

### 6.3 Where a message ends up

Every message and event is written to more than one place, because each store answers a different
question: the Amazon Chime SDK channel is the operational plane, a Kinesis stream is the transport, the
S3 conversation event archive is the immutable **system of record**, and Aurora, the per-message
analytics table and the operational DynamoDB tables are **projections optimised for one consumer** each.
The archive is always-on in both analytics modes; choosing Aurora selects the query engine, not whether
events are archived.

That storage shape is architecture rather than message flow, and it is described in
[ARCHITECTURE.md](../../overview/ARCHITECTURE.md) with the reasons the roles cannot collapse into one
store. What matters here is only the rule the previous two subsections rest on: **control and
measurement ride the same path**, so every enforced decision is also a recorded, queryable event.

---

## 7. Key files (AgentEchelon)

| File | Role in the flow |
|---|---|
| `backend/lambda/src/channel-flow-processor.ts` | Channel flow: runs first on every message; decides WHO responds - the `@all` and `/battle` Lex bypasses (§3.1) - plus notify directives and idempotency |
| `backend/lambda/src/router-agent-handler.ts` | The turn handler: `min(tier)`, intent classification, model resolution, delivery selection, dispatch. Reached through Lex fulfillment on an ordinary turn, and the intended entry for a bypass too (§3.1) |
| `backend/lambda/src/assistant-async-processor.ts` | The shared model-turn processor (one instance per profile, profile-pinned via env) |
| `backend/lambda/src/lib/async-processor-core.ts` | The Converse tool loop, `applyInputGuardrail`/`applyOutputGuardrail`, `handleLongResponse` |
| `backend/lambda/src/lib/intent-classifier.ts` | The separate request-category classifier |
| Bot/Lex CDK wiring | `{tier}-classification-stack.ts` (Lex bot, `AppInstanceBot` `InvokedBy`, channel-flow association) |

## Appendix A. The empty Lex envelope

Kept out of §5 deliberately. It is not part of the turn path, and describing it there made a
troubleshooting artefact read like a normal step.

**What it is.** A Lex fulfillment that returns `messages: []`. Amazon Chime SDK materialises one message
per turn from the last fulfillment response, so it creates a message even from an empty array, and
without intervention a `{"Messages":[]}` string lands in the channel and in history.

**What the flow does with it.** Denies it (`isEmptyLexEnvelope`, `lib/lex-envelope.ts`), before the
correlation claim and before the notify fan-out, so it never becomes a channel message. Denying a bot
message with no words in it loses nothing; denying the user's own message would not be acceptable, which
is why the two cases are handled differently.

**What still produces one.** Not an ordinary turn: Lex returns exactly one placeholder, and a turn with
no Lex in it has no envelope to return. What is left:

- **The alt-slot handler** (`battle-alt-slot-handler.ts`), which closes its intent with no message. It
  is the alt-slot bot's formal `InvokedBy` handle and fires on `WelcomeIntent` when that bot is added to
  a channel as battle is enabled. Once per enable, never per turn.
- **A Lex entry standing down for the flow** (`router-agent-handler.ts`, the bypass-token branch). It
  requires Lex to be invoked on a message the flow is also bypassing, which the size branch is designed
  to prevent; it is a defensive complement rather than an expected path.

**Measured, 7 days to 2026-08-13, on the deployed flow:** 736 invocations, **0** empty-envelope drops.
The control is 2 `carrying Lex envelope` unwraps in the same window and the same code block, so the
zero means the case did not arise, not that the code was absent.

**So a nonzero count is a signal.** Outside a battle enable, an empty-envelope drop means something
upstream returned nothing when it should have returned a placeholder. It is worth alarming on for that
reason, and worth reading as a defect rather than as noise.

## Appendix A. Where to put a rule: the critical path, or after it

Full reasoning in [ADR-032](../../design/decisions/032-where-a-rule-runs.md). Stated here because this
is the document someone reads before adding to the flow, and the pull to add to it is constant: it is
the one component that sees everything.

**The channel flow is synchronous.** It runs before delivery, on every message, with Amazon Chime SDK
waiting on it. A rule added there is paid for by every conversation, including the ones it will never
apply to.

**1. Its only EXCLUSIVE power is denial.** A released message cannot be un-released, so anything that
must STOP a message has to be here. Everything else the flow does is a latency choice, not a
capability, because the message stream can do it afterwards - including dispatching a turn.

**2. Reserve the critical path for what cannot be done later.** Denial. Direction a later component
could not reconstruct. What the turn genuinely cannot proceed without.

**3. A correction for a state that SHOULD NOT EXIST belongs off the critical path.** If a client is
responsible for something and does not do it, that is a client defect. Repairing it inline makes the
correct path and the broken path indistinguishable, so nobody fixes the client and the repair quietly
becomes the primary path.

**4. Post-processing sees everything, after the fact, without blocking.** Amazon Chime SDK Messaging mirrors every channel
message to Kinesis (`DataType: ChannelMessage`). Repair, detection, measurement and archival belong
there.

**Where that lives:** `AgentEchelonPostProcessing`, one consumer (`lambda/src/message-post-processing.ts`)
carrying the rules that act on a message DELIVERY DID NOT ROUTE. Archival is a separate consumer on the
same stream with a different job, and the two are deliberately not one component that grew to do both.
Today there is one rule - the task answer that addressed nobody. [ADR-023](../../design/decisions/023-battle-round-coordination.md)
B-stream, an assistant-to-assistant message Amazon Chime SDK delivers and persists but routes to no
handler, is the same shape and would be a second rule there rather than a second consumer.

**5. The latency asymmetry is the argument.** A repair on the stream costs time only in the broken
case; the same repair inline costs time on every turn that was already correct.

**6. A repair must be COUNTED, or it becomes the design.** A stream-side fix that silently succeeds is
indistinguishable from the defect not existing. Emit a signal, so the client defect stays measurable
and someone can close it.

### What the flow can and cannot see, which decides where a rule CAN live

Measured 2026-08-14. The asymmetry is not obvious and has been re-derived more than once:

| Field | The channel flow | The Kinesis stream |
|---|---|---|
| `Content`, `Sender`, `MessageId`, `ChannelArn` | yes | yes |
| `Metadata` | yes | yes |
| **`Target`** | **NO - never delivered** (tracker row 94) | **yes** |
| Can SET `Target` | **no** - `ChannelMessageCallback` has no such field | n/a (post hoc) |

So **any rule that reasons about how a message was ADDRESSED can only run after the fact.** The flow
cannot read targeting and cannot write it; the stream sees both `Target` and `Metadata` intact. A
design that wants the flow to notice or repair addressing is not merely expensive, it is unbuildable,
and this table is the reason.

## 8. Related

- [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md) - sizing/chunking the reply onto Amazon Chime SDK.
- [`SPEC-INTERACTION-LAYER.md`](../../specs/interaction/SPEC-INTERACTION-LAYER.md) - the interaction-layer feature set this flow powers.
- [`SPEC-PER-PROFILE-OWNERSHIP.md`](../../specs/interaction/assistant-config/SPEC-PER-PROFILE-OWNERSHIP.md) - per-tier bots/processors.
- [`IDENTITY-AND-ACCESS-MODEL.md`](../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md) §6b - the enforcement layers referenced in §6.
