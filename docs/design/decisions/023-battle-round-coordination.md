---
title: "ADR-023: How a battle round ends, and what fires the next one"
status: Accepted - option A (orchestrator claims the fire once all sides are terminal). Option B is not implementable on this platform, established by measurement. Open question - whether to simplify to A-prime.
date: 2026-08-09
related:
  - "../../specs/capabilities/DESIGN-BATTLE.md"
  - "../../specs/capabilities/SPEC-BATTLE.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../../backend/lambda/src/lib/battle-state.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/battle-orchestrator.ts"
tracking: |
  OPEN, NOTHING BUILT. Option B (peer rendezvous) is DISPROVEN: Amazon Chime SDK does not route a
  message authored by an AppInstanceBot to another AppInstanceBot's Lex, so the nudge can never
  arrive. Measured directly, with a control (see Status). No replacement is chosen; A-prime is the
  leading candidate, with no recorded objection standing against it.
  Raised by the owner decision that battle state is not task state
  (DESIGN-BATTLE 2a): removing the task-terminality gate from round-1 completion forces the question
  of what "a side has finished its round" means on its own terms, and what fires round 2 once both
  have. The battle turn ENTRY exists (router-agent-handler TurnRequest.battleContext, lib/battle-turn.ts,
  commit 3798a62) and nothing calls it; this ADR decides the coordination layer that will.
---

# ADR-023: How a battle round ends, and what fires the next one

## Status

**Round 2 fires on option A: the orchestrator claims the fire by conditional write once every side is
terminal.** That is what ships and what the tests cover. The open question is whether to simplify to
A-prime, which removes the orchestrator Lambda and has the claiming worker fan out itself.

**Option B is not available, and the reason is a platform fact rather than a judgement: Amazon Chime
SDK does not deliver a message authored by an `AppInstanceBot` to another `AppInstanceBot`'s Lex.** A
peer nudge therefore cannot arrive, and no care on the sending side changes that. Measured against a
live deployment in a three-member channel, with the target bot in `MENTIONS` mode so a targeted send
was the only thing that could invoke it:

| Send | Sender | Target | Handler invocations |
|---|---|---|---|
| targeted message | an `AppInstanceBot` | the assistant's bot | **0** |
| identical targeted message | an `AppInstanceUser` | the same bot | **1** |

The bot-sent message was read back and carried a valid `Target` naming the assistant, `Status: SENT`,
and the channel flow was invoked for it, so it was well-formed and delivered. It simply triggered
nothing. The human-sent control is what makes this evidence: without it, zero invocations would
equally well have meant a malformed `Target`.

This is undocumented. The `InvokedBy` reference defines `TargetedMessages: ALL` as *"The bot processes
all `TargetedMessages` sent to it"*, with no sender-type qualifier, so the documentation reads as
though a bot-sent targeted message would be processed.

**What that costs B specifically.** The property that decided B was that *"the resume arrives as an
ordinary inbound message, so it re-enters the flow and reaches the handler like any other turn"*. The
message does persist and does reach the flow, so B's audit benefit survives intact - but it is a
durable record of a turn that never happens. **The bounded-wait fallback does not rescue it:** that
fallback exists to cover a crash between marking done and sending. Here the send always succeeds and
never delivers a trigger, so every duel falls through to the timeout and runs degraded, paying `X`
seconds of billed wall-clock per side for a rendezvous that cannot occur.

**Nothing is broken while this stays open, and that was not clear from the previous wording.** Option A
is the STATUS QUO and it is what ships: `tryClaimOrchestratorFire` (`battle-state.ts`) claims the fire by
conditional write when `allBotsTerminal`, and `battle-orchestrator.ts` dispatches round 2. Round 2 fires
today. Option B was a proposed REPLACEMENT for that mechanism, and its disproof simply leaves the
existing one in place; it did not leave a hole. The open question is therefore an optimisation (drop the
orchestrator Lambda), not a defect, and it blocks no other work.

**A replacement is not chosen here.** A-prime is the leading candidate: it was already judged the
smallest correct change with no availability gap. Its one recorded demerit against B - coordination
staying in a table with a 600s TTL instead of reaching the archive - is answerable without changing
transport, by posting a non-triggering marker message alongside the invoke. C and D remain live if
that durability is worth new infrastructure.

**Assistant-to-assistant messaging has a chosen route (owner decision, 2026-08-18): the Kinesis
stream, consumed by post-processing (ADR-032).** The sender posts a real Amazon Chime SDK message -
bot-authored, which the service persists and mirrors to the stream but routes to no handler (the
measurement above) - and the post-processing consumer either delivers it or dispatches a turn,
depending on the use case. Where logic and a back-and-forth exchange between assistants is required,
that logic lives in post-processing rules, one rule module per exchange shape beside task-answer
repair. This keeps every hop in the system of record by construction and adds no second identity.

B-proxy (a proxy `AppInstanceUser` per assistant under `sts:AssumeRole`) remains recorded as
reachable but NOT chosen: it buys direct routing at the cost of a second identity per assistant and
of owning loop safety that Amazon Chime SDK currently provides for free.

The options were not narrowed unilaterally, and the reason is worth keeping: every option below still
answers the user correctly, so a wrong choice is invisible in normal operation and surfaces only as a
duel that stalls, rebuts too early, or rebuts twice - under load, intermittently.

## Context

A `/battle` is a two-round duel. Round 1 fans out one turn per participating assistant; round 2 asks
each side to rebut, build on, or concede to its rival. Something has to notice that **both sides have
finished round 1** and fire round 2 exactly once.

Two things changed the question.

**1. Battle state is not task state** (DESIGN-BATTLE §2a, owner). Today a side's terminal transition
is gated on `isBattleRound1Complete(...)` in `async-processor-core.ts`, so **task terminality decides
when a battle round is done**. A duel whose intent happened to be task-shaped therefore had a
different completion rule from one whose intent was not. Removing that gate is settled; it leaves an
open question in its place, which is what this ADR is for: *what does "this side has finished its
round" mean, measured only in battle terms?*

**2. The turn moved.** Under the per-side handoff (DESIGN-BATTLE §5a) each side is an ordinary turn
run by the handler. Whatever fires round 2 must therefore **dispatch through the handler**, not
re-implement a turn. That constraint is common to every option here and is not a differentiator.

### What must be true of any answer

- **Exactly once.** Round 2 fires once per duel, not once per side and not twice under redelivery.
- **No hang, WHILE AT LEAST ONE SIDE SURVIVES.** A side that crashes or times out must not leave the
  duel waiting forever. Scoped deliberately: **if every side dies there is no actor left to notice**,
  in this option and in every other one below, including what ships today. The placeholders then
  strand until the 600s row TTL and nothing tells the user. That is a real uncovered case, not a
  detail - it is called out here so "no hang" is not read as full coverage.
- **Precisely on the TTL:** `allBotsTerminal` (`battle-state.ts:623-627`) returns **false** when no
  bot rows remain, so full reaping means round 2 never fires at all. A partially reaped partition
  lets the survivors' rows carry the check. "A missing row reads as FAILED" is only true while at
  least one row remains.
- **No premature rebuttal.** A side must not rebut a rival that has not yet answered.
- **Degraded duels still finish.** If one side never completes, the survivor still rebuts, and the
  degradation is visible rather than silent.
- **Nothing in the channel that the user should not see.** Coordination must not put control chatter
  into the conversation.

## Options

### A. Last finisher claims the fire, an orchestrator dispatches (status quo, minus the task gate)

Each worker writes its own `(battleId, botArn)` row on finishing, reads the partition, and if every
row is terminal claims `__orchestrator__` by conditional write. The winner invokes
`battle-orchestrator`, which dispatches round 2 for both sides.

- **Exactly once:** yes, by the conditional write.
- **Hang:** the row TTL reaps a dead side and a missing row reads as `FAILED`, so the survivor
  proceeds.
- **Cost of the change:** smallest of all options - delete the task gate, leave the rest. The
  orchestrator stops being a turn-runner and becomes a dispatcher into the handler.
- **Against it:** a separate Lambda exists purely to fan out round 2, and the "read the partition
  after writing" step is a read-modify-write that only the conditional claim makes safe.

### B. Peer rendezvous: the last finisher nudges its rival (owner's proposal) - **DISPROVEN**

> **This option cannot be built.** A bot-authored targeted message does not reach the target bot's
> Lex (see Status). Everything below was written before that was measured and is kept because the
> reasoning about auditability and about exactly-once still applies to whatever replaces it - not
> because the option is available.

At the end of its turn each assistant checks battle state. If the rival is not done, it marks itself
done and stops. If the rival **is** done, it marks itself done and sends a targeted message to the
rival to resume, so both sides run round 2.

- **Attraction:** no orchestrator. The resume arrives as an ordinary inbound message, so it re-enters
  the flow and reaches the handler like any other turn - the most faithful reading of "one turn path"
  of any option here.
- **THE COORDINATION BECOMES AUDITABLE, and this is the strongest argument for B.** A `Target`-ed
  message is only visible to the listed members, set by the sender on its own `SendChannelMessage`
  (see the correction below: the channel flow does not do targeting), so no user sees
  it - but it is a real Amazon Chime SDK message, so it persists in the authoritative record and reaches the S3
  archive. Every other option coordinates through the battle state table, which carries
  `STATE_TTL_SECONDS = 600` and never reaches S3: ten minutes later there is no record of when either
  side finished or what triggered round 2. For a feature whose entire purpose is to be an experiment,
  having the coordination recorded in the same stream as the results is a durable benefit, and it is
  the same property the latency ledger work depends on (a marker on the message is auditable; the
  out-of-band store is not).
- **The rival holding it in context is correct, not pollution.** Knowing its rival has answered is
  information a duellist legitimately has; it is how the rebuttal knows what it is responding to.
- **Exactly once:** needs care. Two sides can observe "the other is done" concurrently unless the
  self-mark and the check are ONE conditional operation; otherwise both nudge and round 2 runs twice.
  This is the same conditional claim every other option needs, so it is not a differentiator - but it
  must not be split into a read followed by a write.
- **Hang - the one real cost.** The duel depends on the last finisher surviving long enough to send
  the nudge. If it dies between marking itself done and sending, **every row is terminal and nothing
  is coming**, and no TTL rescues it because the state looks complete. Needs either a reconciler or an
  ordering that makes the send the same act as the claim.
- **Trust edge, separate from visibility.** A message that CAUSES a turn is content-triggered control
  flow, so the receiving side must authenticate the sender as a bot and confirm it is the same battle.
  That is a requirement, not an objection.
- **Note:** this is the same "last one out switches off the lights" shape as A and A'. The difference
  is the transport - an Amazon Chime SDK message rather than a Lambda invoke - and therefore the durability and
  failure properties, not the coordination logic.

### A'. The claiming worker fans out round 2 itself (no orchestrator Lambda) - **LEADING CANDIDATE**

> Recommended replacement for option B, which the platform rules out (see Status). Listed among the others rather than
> promoted out of order, so the comparison stays readable - but a reader landing here should know this
> is the one being proposed.

Identical to A up to the claim; the winner then dispatches both sides through the handler inline
instead of invoking `battle-orchestrator`.

- **Attraction:** removes the orchestrator Lambda - B's main structural appeal - while keeping the
  deterministic conditional claim. Nothing has to be delivered after the claim, so B's pre-send crash
  window does not exist.
- **Against it:** the fan-out runs inside a worker that has just finished its own turn, so a duel's
  round-2 dispatch inherits that invocation's remaining timeout. It also keeps coordination in the
  TTL'd state table, so it has none of B's audit benefit.

### B-proxy. Give the orchestrator an `AppInstanceUser` identity, as a second principal alongside the assistant

**Explored 2026-08-10, and it WORKS. Deferred rather than rejected**, and recorded in full because
the reasoning arrived at the right answer only on the second pass. It is not the choice for this ADR
(see the disposition at the end); it is the shape any future assistant-to-assistant messaging takes.

**Why it is the natural next thought.** The disproof above is specifically about the SENDER being an
`AppInstanceBot`. A message from an `AppInstanceUser` to a bot DOES invoke that bot: it is the control
in the Status table, and it is the ordinary `@assistant` path. So give each assistant a second,
proxy `AppInstanceUser` principal and have coordination messages be sent BY that principal, addressed
to the peer's bot. Every hop becomes user-to-bot, which routes.

**The objection this has to answer.** A proxy appears to deliver only one direction: an assistant can
be reached, but cannot reach back, because an `AppInstanceUser` has no Lex binding and a message
addressed to one triggers nothing. That is true and irrelevant. **Nothing requires the return leg to be
a reply to the proxy.** The peer answers by sending its OWN fresh
message, as its OWN proxy principal, addressed to the first assistant's bot. Both legs are
user-to-bot. The asymmetry was an artefact of assuming the return leg had to be the Lex-materialised
reply, whose `Sender` is fixed at creation and cannot be changed.

**Sending as a principal is a shipped primitive, not a new privilege.** Credential exchange already
vends short-lived, scoped, bearer-pinned credentials by `sts:AssumeRole`, and **every human message in
the product is sent this way** (MESSAGE-FLOW 6.1). The Status table's control message was itself sent
by assuming a role and setting `ChimeBearer` to a user principal, so the mechanism is demonstrated by
the same experiment that disproved B.

**No channel-flow rewriting is required, and that matters.** The flow cannot re-target a message or
change its author in any case: `ChannelMessageCallback` carries only `MessageId`, `Content`,
`Metadata`, `MessageAttributes`, `PushNotification` and `SubChannelId`. This design needs none of
those. The proxy addresses the peer's bot directly at send time, so the flow keeps deciding only who
responds.

**One loose end: the Lex envelope.** When the peer's handler runs, its fulfillment return still
materialises a message, and Amazon Chime SDK materialises one even for an empty `messages` array. That envelope
is authored by the bot and targeted back at the proxy, so it triggers nothing and no human can see it,
but it is persisted. Three dispositions, in preference order: leave it as harmless archive clutter
(keeps the flow uninvolved); make it carry the coordination content so it is at least meaningful; or
have the flow drop it, which works but puts the flow back in the business of inspecting coordination
traffic and is the reason it is listed last.

**What it costs, stated plainly because none of it is a blocker and all of it is real:**

- **Loop safety becomes ours.** Amazon Chime SDK blocks bot-to-bot precisely so assistants cannot volley. This
  routes around that deliberately and in both directions at once, so the platform's protection no
  longer applies and a bounded-exchange guard becomes load-bearing rather than defence in depth.
- **Two identities per assistant**, with their own lifecycle and IAM - **and an erasure path that has
  to be built, not assumed.** A proxy principal outlives every conversation it coordinated, so its
  deletion must be tied to offboarding (`federated-remove-member`, `AdminDeleteUser` /
  `DeleteAppInstanceUser`), exactly as centralizing any durable identity does. Do not adopt B-proxy
  without that path; a per-assistant principal with no deletion story is a data-retention obligation
  acquired by accident.
- **The loop guard this needs already exists** and is not new work: `lib/bot-coordination.ts` bounds a
  bot-to-bot exchange to two hops and default-denies anything unmarked. It is defence in depth today
  because the platform blocks bot-to-bot outright; under B-proxy it becomes the primary control, which
  is the honest way to read its cost rather than treating loop safety as unpriced.
- **The history rebuild needs the mapping.** `loadChannelHistory` decides "is this my own turn" by
  sender; unless it knows proxy-user-B is bot-B, an assistant reads its own prior turns as a human's.
  Silent context corruption, not an error.
- **Each hop is a full message, flow invocation, Lex invocation and handler turn**, against a single
  async invoke for the alternatives.

**What it buys.** The one thing the out-of-band options cannot: the coordination is a real, persisted,
human-invisible message in the authoritative record and the S3 archive. It is also the only option
under which assistants coordinate AS participants in the conversation rather than through a side
channel, which is the model
[DESIGN-MULTI-ASSISTANT-TURN-ENGINE](../../specs/capabilities/DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md)
phase 5 would need for genuine multi-turn exchange.

**Disposition: not for this ADR.** Round 2 needs one component to fire another once, after a
conditional claim. An async invoke does that in one hop; this does it in four, and adds a second
identity per assistant plus ownership of loop safety, to buy an audit property obtainable directly by
posting a non-triggering marker alongside the invoke. **It is deferred to its own ADR**, because a
platform-wide change to how assistants address each other should not arrive as battle plumbing.

### B-stream. The message IS delivered and persisted, so trigger the peer off the message stream (owner, 2026-08-14)

**Status: the premise is MEASURED. The option is not built.**

**The probe, 2026-08-14 20:00Z (mcharg-dev).** One `Target`-ed message from `Assistant-premium` to
`AltSlot0`, carrying `<!--aecoord:kind=nudge,hop=1,ref=bstream-probe-1-->`, message
`0b769a6ca7f0d9cf...`:

| Property | Result |
|---|---|
| The flow ALLOWS a marked bot-to-bot message | Invoked, no deny, message reached `SENT` |
| It persists, with its addressing intact | Read back as the SENDER: `Status: SENT`, `Target` naming AltSlot0, marker intact |
| It stays private to non-targets | The app-instance admin bearer is refused outright (`ForbiddenException`), so targeting hides it even from the admin plane |
| **It reaches the Kinesis stream** | Record found on `chime-messaging-agent-echelon-aurora`, matching message id, marker intact. **This was the whole unmeasured premise** |
| It still triggers no assistant | AltSlot0's Lex handler: ZERO invocations, reconfirming the finding that disproved option B |

Read together, those five say the thing that makes this option exist: **the message survives everything
except the trigger, and the stream is a trigger.**

**Who can read it, measured the same way:**

| Reader | `GetChannelMessage` | In channel history |
|---|---|---|
| The SENDER bot | full content | - |
| The TARGET bot | full content | present |
| Another member of the channel (human) | `ForbiddenException` | absent |
| The app-instance admin | `ForbiddenException` | - |

Two consequences, and the second is a design constraint rather than a benefit.

**The target reads it through ordinary history**, so a turn dispatched as the target picks the
coordination up via `loadChannelHistory` with no special plumbing. That is precisely the cost B-proxy
carries and this avoids: B-proxy needs a proxy-to-bot mapping there, or an assistant reads its own
coordination as a human's.

**And that cut runs both ways.** Coordination lands in the target's PROMPT CONTEXT as ordinary
conversation. `message-markers.ts` strips the `aecoord` marker as an injection defence, so the model
never sees the control syntax - but it sees the prose around it. Coordination traffic therefore needs
either deliberate content design (the body IS what the peer should read) or explicit filtering in the
history load. Left unhandled it is assistants talking past each other inside each other's context
windows, which degrades answers without ever erroring.

**THE STREAM SEES `Target`, AND THE CHANNEL FLOW DOES NOT.** Measured on a second probe carrying both a
`Target` and `Metadata`, the record is:

```
Payload: { Content, Persistence, Redacted, LastUpdatedTimestamp, Sender{Name,Arn}, Target[{MemberArn}],
           Type, MessageId, CreatedTimestamp, ChannelArn, Metadata, MessageAttributes }
EventType: CREATE_CHANNEL_MESSAGE
```

Tracker row 94's blindness is a property of the FLOW CALLBACK, not of the platform: the same message
that reaches the flow with no `Target` at all reaches the stream with its `Target` and its `Metadata`
intact. Anything that needs to reason about how a message was ADDRESSED can do so after the fact, and
only after the fact. This is load-bearing well beyond coordination - see
[ADR-032](./032-where-a-rule-runs.md).

**The observation that opens it.** The measurement that disproved option B says the bot-to-bot message
carried a valid `Target`, was `SENT`, and reached the channel flow. It was DELIVERED. What it did not
do was invoke the target's Lex. Option B was retired as "assistants cannot coordinate by talking to
each other", and the accurate statement is narrower: **Amazon Chime SDK will not TRIGGER an assistant
from a bot-authored message, but it will carry one.** A message that is persisted is mirrored to the
Kinesis stream, and a consumer there can dispatch the turn Amazon Chime SDK declined to.

So the missing half of option B is not the delivery. It is the trigger, and the stream already is one.

**The chain, with the two links that were checked (2026-08-14):**

1. Bot A sends a `Target`-ed message to Bot B carrying an `aecoord` marker.
2. The flow's loop guard (`evaluateBotToBot`) ALLOWS it. Default-deny applies to UNMARKED bot-to-bot
   traffic; a correctly marked message at a legal hop passes and is persisted. The dormant sender half
   of `bot-coordination.ts` finally has a caller.
3. Amazon Chime SDK mirrors it: `StreamingConfigurations: [{ DataType: 'ChannelMessage', ... }]` is unfiltered by
   sender, so a bot-authored message reaches the stream like any other.
4. A stream consumer resolves the target and dispatches a turn AS that assistant through the handler
   bypass, which is the same entry `@all`, `/battle` and the handover already use.

**What it costs less than B-proxy, which is the reason to explore it.** No second `AppInstanceUser` per
assistant, no `sts:AssumeRole` on the send path, no erasure path tied to `federated-remove-member`, and
no proxy-to-bot mapping in `loadChannelHistory` - which was B-proxy's sharpest cost, since without it
an assistant reads its own turns as a human's. It also buys B-proxy's stated benefit for free:
coordination lands IN THE ARCHIVE, because being persisted is precisely what puts it on the stream.

**PRECONDITIONS. None of these is an open question; they are the price of admission, and the option may
not be built without them.** What makes an unbounded assistant-to-assistant exchange impossible today
is that Amazon Chime SDK declines to route bot-to-bot at all. Both this option and B-proxy deliberately
remove that, so the loop safety AWS provides for free becomes ours to provide, and every hop of a
runaway exchange is a model call somebody pays for.

| Precondition | Why it is not optional |
|---|---|
| A spend ceiling that is actually ARMED | `BEDROCK_GLOBAL_HOURLY_BUDGET` and `BEDROCK_USER_HOURLY_BUDGET` read `0` on mcharg-dev, and the code treats `<= 0` as OFF, so the gate returns allowed on every turn and no circuit is wired |
| The ceiling must be the GLOBAL one | Budgets key on `userSub`, and a bot-to-bot turn has no user. A fully-armed per-user budget cannot see this exchange at all |
| A STATEFUL `ref`+hop claim | Tracker row 66: the hop cap in `bot-coordination.ts` is stateless and self-declared, so each side re-declares its own count and an `ack,hop=2` volley is unbounded. It constrains a cycle's SHAPE, never its cost. `claimCorrelation` is the mechanism the codebase already uses for this |
| A per-`ref` dispatch ceiling | The bound has to live on the exchange, which is the thing that can run away, rather than on a principal |
| A counter on every stream-triggered dispatch | [ADR-032](./032-where-a-rule-runs.md) tenet 6. An uncounted mechanism is indistinguishable from one that is not running, in either direction |

**Open, and to be settled before it is chosen:**

- **Which consumer, and in which mode.** The stream and its archival consumer are provisioned by the
  Aurora analytics stack. If coordination hangs off that consumer it inherits Aurora mode as a
  dependency, which a platform-wide messaging primitive should not have.
- **Latency.** Stream delivery is seconds, not milliseconds. That is the right trade for coordination
  under [ADR-032](./032-where-a-rule-runs.md) tenet 5 - it is not a person waiting on a keystroke - but
  it is a real difference from an async invoke, which is one hop.
- **It is a general primitive, not battle plumbing.** Same disposition as B-proxy: if it is taken, it
  belongs in its own ADR alongside it, not here.

### B-reject. The first finisher waits, then ASKS its rival for status

Considered and rejected. Worth recording, because it is the natural next thought after B and it fails
for a reason that is not obvious until stated.

**An assistant cannot introspect its own in-flight turn.** A status question arrives as a NEW inbound
message, so it runs a NEW turn: flow → handler → worker, a different Lambda invocation with no
visibility into the one still running. To answer "have you finished?", the responder would have to
read the same battle state table the asker can read directly. **The message round trip therefore
returns strictly less than a direct read**, and costs a model call and a second concurrent turn for
that bot - whose output would interleave with the answer it is still producing.

**Waiting is also billed.** The worker's timeout is the profile's `timeoutSeconds` (basic 30s,
standard 60s, premium 90s). A side that finishes at 20s and waits for a rival 60s behind burns its
remaining budget, holds a concurrency slot, and may time out before the rival ever finishes.

**This is exactly why B works and this does not.** A nudge is sent by the side that ALREADY knows both
are done: it carries a decision and needs no introspection from the receiver. A status query needs the
receiver to introspect, which it cannot do. Strip the message from "wait, then ask" and what remains
is "wait, then read" - which is option C, without the round trip.

### C. Delayed re-check (SQS delay queue / EventBridge scheduler)

On finishing, a side marks itself done. If the rival is not done, it enqueues a delayed re-check.
The re-check evaluates the partition and fires round 2 if both are terminal.

- **Hang:** best of the options - the trigger does not depend on any worker still being alive.
- **Against it:** new infrastructure, added latency equal to the delay, and a polling loop to bound
  (how many re-checks before giving up). It solves a failure that A already handles via TTL.

### D. DynamoDB Streams on the battle state table

The table is already the coordination point. A stream handler sees each row transition, evaluates
"all terminal", and fires round 2.

- **Attraction:** no worker does coordination work; the trigger is a property of the data, so a
  worker that dies after writing its row still causes the fire. Removes the read-modify-write from
  the hot path.
- **Exactly once:** streams are at-least-once and can re-deliver, so the `__orchestrator__` claim is
  still needed - the claim is doing the real work in every option, and the trigger is what varies.
- **Against it:** another component and another IAM surface; stream lag adds latency; a table that
  currently serves point reads and conditional writes grows an event-driven consumer.

### E. Step Functions: model the duel as a state machine

A parallel state per side for round 1, a native join, then a parallel state for round 2.

- **Attraction:** the join is native and exactly-once, retries and timeouts are declarative, and the
  execution history is a readable record of a duel - genuinely useful for something whose whole
  purpose is to be an experiment.
- **Against it:** the largest change here. Sides are currently async Lambda invocations dispatched by
  the handler, not Step Functions tasks, so this re-architects the duel's control flow and adds
  per-transition cost. It also puts duel orchestration somewhere structurally different from every
  other flow in the platform, which is a real consistency cost for one feature.

## What the options actually differ on

**Every option needs the same conditional claim** to fire round 2 exactly once, and **every option
must dispatch round 2 through the handler**. Neither is a differentiator. What varies is only:

| | Trigger source | Coordination is auditable? | Survives the last finisher dying? | New component |
|---|---|---|---|---|
| A | finishing worker | no (TTL'd table, never in S3) | yes | none (orchestrator already exists) |
| A' | finishing worker | no | yes | none - removes one |
| ~~B~~ | ~~finishing worker, via a targeted message~~ | ~~yes - in the system of record~~ | ~~no~~ | **NOT BUILDABLE - the message triggers nothing** |
| B-proxy | a per-assistant proxy `AppInstanceUser`, sending under `sts:AssumeRole` | **yes - in the system of record** | yes | none new - credential exchange already vends this. **Deferred: buys the audit property at the cost of owning loop safety** |
| C | delayed re-check | no | yes | queue/scheduler |
| D | state-table stream | no | yes | stream consumer |
| E | state machine join | partly (execution history) | yes | Step Functions |

**The auditability column is what B was bought for, and only B-proxy still delivers it.** Every other
surviving option coordinates out of band and leaves no record of the coordination in the archive. So
the choice is between paying B-proxy's price for it (a second principal per assistant, and owning
loop safety that the platform currently provides) or adding it deliberately and cheaply: a
coordination event, or a non-triggering marker message, written by whichever worker fires the round.
The second is what makes A-prime sufficient; the first is what makes B-proxy worth its own ADR later.

**The finding underneath the whole table, worth stating once:** a `Target` is an ADDRESSING mechanism
before it is a visibility one. It is what makes `TargetedMessages: ALL` route a message at all.
Reading it primarily as a privacy device is what made assistant-to-assistant coordination look like a
solved problem in the first place, and reading it correctly is what shows B-proxy the way through.

## Decision direction (owner, 2026-08-09): B, with a bounded wait as the fallback - **SUPERSEDED**

> **This direction is void.** B's nudge cannot be delivered (see Status), so the section below
> describes a mechanism that does not exist. It is kept because three of its requirements are
> transport-independent and survive into whatever replaces it: the per-`(battleId, botArn, round)`
> claim, the wait fitting the worker's `timeoutSeconds` budget, and a timed-out rebuttal staying
> separable from a genuine no-response. The nudge half does not survive.
>
> Note also that **without a nudge there is no second trigger**, so the double-fire this section
> guards against cannot arise from a late nudge arriving after an expiry. The per-side claim is still
> wanted, because a redelivered async invocation can still fire a side twice.

**The nudge stays the primary trigger; a bounded wait is the safety net.** The first completer waits
up to `X` seconds for its rival. If the rival completes, the ordinary path runs (the last completer
nudges). If `X` elapses with nothing, the waiting side proceeds anyway - it rebuts what exists, or
says plainly that there is nothing to rebut.

**This closes B's only real objection.** The pre-send crash window no longer stalls the duel: worst
case it completes degraded, which the system already knows how to express (`rivalDidNotFinish`, and
the "didn't finish in time" turn at `battle-orchestrator.ts:417-434`). No reconciler, no new
component, and B keeps the property that decided it - coordination recorded in the system of record
rather than a table that is gone in ten minutes.

**The wait is a POLL of the battle state table**, not a message the waiting side receives. It cannot
be a message: a worker mid-turn has no way to take delivery of one (see B-reject).

**`X` needs a home and a value.** It belongs with the profile's other per-turn budget rather than as
a constant, because the arithmetic that bounds it is per-profile: `answer + X + rebuttal <=
timeoutSeconds` (30 / 60 / 90). A starting point of `X = 20s` leaves a premium duel roughly 40s of
answer and 30s of rebuttal; basic cannot afford the same number. **Do not ship it as a bare constant** -
the first implementer will pick one and it will silently be wrong on two profiles out of three.

**Who tells the user when a side does not finish.** Today `battle-orchestrator.ts:266-269` posts
`postDidNotFinish` for every stalled side, and `:271-282` closes a duel where nobody finished. Under
this direction the orchestrator becomes a dispatcher and may eventually be removed, so those duties
need an owner or a stalled placeholder is left sitting there with nothing to explain it:

- **One side dies:** the waiting side owns it. On expiry it posts its rival's "didn't finish" turn as
  well as its own rebuttal. This is strictly better than today, where the notice depends on a worker
  having claimed the fire.
- **Both sides die:** nobody owns it, here or today. The duel strands until the TTL. Closing that
  needs a reconciler, which is out of scope for this ADR - but it must not be assumed away.

Three more things this needs to get right, and the third is the one that matters most for a duel:

1. **The wait has to fit the worker's budget.** The processor timeout is the profile's
   `timeoutSeconds` (basic 30s, standard 60s, premium 90s) and the wait is billed wall-clock inside
   it. The arithmetic is `answer + X + rebuttal <= timeout`, so `X` is not free and is not the same
   number on every profile. A wait that overruns leaves a side that neither rebutted nor reported
   why.
2. **Round 2 needs a PER-SIDE claim, not a per-battle one.** With both a timeout path and a nudge
   path, a side can be told to rebut twice - once by its own expiry, once by the rival's nudge
   arriving just after. The conditional claim therefore keys on `(battleId, botArn, round)`.
3. **A slow rival must not be scored as an absent one.** `X` too short converts a healthy but slower
   variant into "did not respond", and that is not a UX wrinkle - it is **measurement bias in the
   experiment**, biased against exactly the variant the duel exists to evaluate. Whatever `X` is, a
   timed-out rebuttal must be recorded as *degraded by timeout* and be separable in the results from
   a genuine no-response, or the slower arm silently loses rebuttals and the comparison is unsound.

**On the handler checking task state.** Being able to see task state and queue depth is a reasonable
future capability and does not conflict with DESIGN-BATTLE §2a: the separation forbids battle
COMPLETION being defined by task terminality, not the handler being aware tasks exist. A duel's round
ends when the side has produced its response; if that side also left a task running, the rebuttal may
legitimately say so.

<details><summary>the options as reviewed, before the direction was set</summary>

Two candidates survived review, and they traded against each other cleanly:

- **A'** is the smallest correct change with no availability gap. It removes the orchestrator Lambda
  and keeps a deterministic claim, but coordination stays in a table that is gone in ten minutes.
- **B** is the only option that leaves a durable, auditable record of how the duel was coordinated,
  in the same stream as the duel itself, and the only one where the resume is an ordinary turn. Its
  cost is a real availability gap: a crash between marking done and sending the nudge stalls the duel
  in a state that looks complete.

**The deciding question was whether B's crash window can be closed.** It can - see the direction
above. A bounded wait with a degraded fallback answers it without a reconciler.
</details>

### Corrections made during review, recorded so they are not re-argued

- **B does NOT put a control message in the conversation.** A `Target`-ed message is visible only to
  the listed members. An earlier draft treated "persists" as "user-visible"; they are different
  things. **Correction 2026-08-10:** this previously cited `channel-flow-processor.ts:705`, the
  channel flow's own `sendBotMessage`. The statement is true but the citation names the wrong
  component and made the ADR read as though the flow sends the nudge. **The channel flow does not do
  targeting** (MESSAGE-FLOW 3.1); a sender sets its own `Target` on its own `SendChannelMessage`.
- **A targeted message is an ADDRESSING mechanism first, and a visibility one second.** The `Target`
  is what makes `TargetedMessages: ALL` route the message at all. Reading it as primarily a privacy
  device is what made bot-to-bot coordination look like a solved problem.
- **Persisting is a BENEFIT, not a cost.** See B: it is the only option whose coordination reaches
  the S3 archive.
- **B's trust edge is real but is a requirement, not an objection**: authenticate the sender as a bot
  and confirm the same battle.
- **Coordination must never ASK an assistant for its status** (see B-reject). A message can carry a
  decision to a peer; it cannot interrogate a turn that is still running, because the answer would be
  produced by a second turn reading the same state the asker already has.

## How each option gets proven

These invariants are concurrency properties, so none is provable by an ordinary unit test. Whichever
option is chosen ships with these.

The invariants are stated in transport-independent terms, so they hold whichever option ships: a test
exercises the property, not the mechanism that triggers it.

| Invariant | The test that can fail |
|---|---|
| Exactly once | Two sides reach terminal concurrently; assert round 2 is dispatched once. Split the claim into a read-then-write and it must go red - that split is the actual bug being guarded |
| No hang | Kill a side after it marks itself done and before the trigger; assert the duel still reaches round 2 or is reported degraded. **Restated:** whatever the replacement's trigger is, the test asserts the SURVIVOR still rebuts and the degradation is visible - not merely that nothing crashed |
| A slow rival is not scored as absent | A rival that completes just after the deadline; assert its side is recorded as **degraded by timeout**, separable in results from a genuine no-response. Collapse the two and it must go red - a duel that cannot tell "slow" from "silent" is biased against the slower variant. **Applies to any deadline the replacement uses**, not only to B's in-worker wait |
| No double rebuttal | Deliver the round-2 dispatch twice for one side and assert it runs ONCE. **Restated:** the original wording ("expire the wait and deliver the rival's nudge") is unrunnable - no nudge can arrive. The property is not: a redelivered async invoke can still fire a side twice, so the claim must key on `(battleId, botArn, round)`; key it per battle and it must go red |
| A stalled side is explained to the user | Kill one side; assert its placeholder is resolved with a "didn't finish" turn AND the survivor rebuts. **The duty does NOT move.** It was going to pass to the waiting side under B; with B gone there is no waiting side, so `postDidNotFinish` (`battle-orchestrator.ts:266-269`) and the nobody-finished close (`:271-282`) stay with the orchestrator - which is an argument for keeping it as a dispatcher rather than deleting it |
| Both sides dying is a KNOWN gap | Kill both; assert the duel strands until TTL and record that as expected. A test that asserts the current limit stops it being mistaken for a regression later, and marks the spot a reconciler would fill |
| No premature rebuttal | One side terminal, the other not; assert nothing fires. **Partly covered already** by `battle-orchestrator.test.ts` ("defers when not all bots are terminal") |
| Degraded duels finish | One side never completes; assert the survivor still rebuts and the degradation is visible (`battle-orchestrator.ts:265` filters `completedBots`). **Partly covered already** by the same suite's degraded-round-2 case |
| Coordination is auditable (**B-proxy only**) | Read the duel's coordination back from the channel record after the state table's 600s TTL would have expired. **Retargeted:** B cannot deliver this - its message persists but triggers nothing - so B-proxy is the only option that buys it, and the other options must add a marker message deliberately if it is wanted |

**Round-2 worker routing is already covered** and does not need a row here:
`battle-orchestrator.test.ts` pins that a duel runs on its own classification's worker, that an absent
classification degrades to standard, that premium may degrade down, and that **basic never resolves
upward**. Mutation-proven against restoring the premium hardcode.

## Consequences

- Removing the task gate is a prerequisite for all of them. It does NOT mean a rebuttal may answer a
  side that is still working: [ADR-026](./026-task-shaped-battle-rounds.md) (owner, 2026-08-10) settles
  that a task-shaped side sits in `WAITING_FOR_USER` between the legs of its chain, which is non-terminal
  and so suspends round 2 without any predicate asking task state a battle question. What the gate's
  removal actually bought is that a duel's completion rule no longer varies with whether its intent
  happened to be task-shaped. An earlier draft of this bullet read the removal as licence to rebut
  mid-chain and pushed the judgement into the rebuttal prompt; that was rejected, because no prompt can
  recover an answer the other side has not produced yet.
- Whatever is chosen, round 2 carries `trigger: 'orchestrator'`: it has no user message, so its TTFF
  is undefined and must be null rather than zero, and its rows stay out of the TTFF average
  (LATENCY-TARGETS).
- The `taskId` field on the battle state row goes away with the gate, and the continuation
  (clarification) path needs an answer that does not read task state to decide a battle question.
  **That answer is [ADR-024](./024-task-ownership.md), which is ACCEPTED and built** (`4695e87`): the
  lookup is "the active task owned by this actor in this channel", an ownership question rather than a
  battle one, so the battle row carries nothing about tasks.
  `planBattleResume` itself remains in `battle-state.ts`; what the separation changes is its input -
  the caller feeds it from the owner lookup rather than from a `taskId` read off the battle row.
- **A resumed side currently loses its variant, and that is a live defect rather than a consequence of
  this ADR.** The continuation invokes the processor directly with no `experimentId`, `variantId`,
  `variantModelKey`, `variantProfile` or `selfDisplayName`, so it answers on the profile default
  instead of its assigned arm and archives with `experiment_id` NULL. It is the third instance of one
  bug - round 1 was fixed, then round 2 - and the fix is the same as this ADR's: route the
  continuation through the handler entry, where the variant resolves on the turn path.
