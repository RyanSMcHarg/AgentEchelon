# DESIGN: Battle Mode (`/battle`) - Technical Design

**Status:** Implemented. Gated by the profile's `battleEligible` flag (`backend/lib/config/profiles.ts`); premium is the only eligible profile out of the box. **Layer:** Core platform (capability - a platform feature, not an interaction pillar; its MECHANISM lives here, its variant CONFIG is assistant-config, pillar 2) **Plane:** core **Product spec:** [SPEC-BATTLE.md](./SPEC-BATTLE.md)

**Coverage:** `e2e/battle.spec.ts`

> **On the turn path.** The handoff described in §5 is the DESIGN: the channel flow decides who
> responds, the handler runs the turn. The flow-side turn logic it replaces is being retired
> (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "Retire duplicated paths").

## 1. Overview

This document describes how Battle Mode is built. For the problem, personas, use cases, and acceptance criteria, see the product spec above.

**Design anchor 1, the turn. A battle turn is a NORMAL turn.** Each side runs the ordinary message
and response flow - the same handler, the same classification, the same profile and variant
resolution, the same delivery selection, the same worker. A battle adds exactly two things and
nothing else:

- **Who is asked.** The flow fans the turn out to two assistants instead of one. That is the flow's
  whole job: it decides WHO responds, and never runs the turn.
- **Battle context, which is extra INSTRUCTION plus coordination.** The instruction is what the side
  is being asked to do differently - in round 2, rebut, build on, or concede to its rival. The
  coordination is what a side cannot derive for itself: the battle id, the round, its rival, and
  which side it is.

**Everything else is the ordinary path, and departures from it are defects rather than design.** A
battle is not a task type, not a second engine, and not a parallel resolution path. When there is one
resolution path, there is nothing to diverge; every battle defect worth the name has been a
divergence - an image duel that silently ran as text, a keyword-classified profile still paying for a
model call. The rule is enforced, not just asserted: `flow-does-not-run-the-turn.test.ts` pins every
turn-path symbol the flow still reaches for, and the list can only shrink.

**Design anchor 2, the variant:** a battle does not introduce a parallel persona infrastructure. The "alternative assistant" is the **treatment variant of an existing A/B experiment**, surfaced as a real Amazon Chime SDK channel member. Routing that used to pick one variant stochastically instead fans out to both, reusing the machinery that already powers A/B testing.

## 2. Architecture

Battle Mode is self-contained within AgentEchelon. The moving parts:

- **`backend/lib/stacks/battle-stack.ts`** - provisions a fixed pool of "alt-bot slots" (`ALT_BOT_SLOT_COUNT`, ships at 2), each a `CfnAppInstanceBot` with no static persona; the `BattleState` and `ChannelBattleConfig` DynamoDB tables; and IAM grants. Each slot ARN is published to SSM (`/agent-echelon/alt-bot-slots/slot-{i}/bot-arn`, where the segment is `slot-0`, `slot-1`, ..., not a bare index), plus a `roster` parameter holding `[{slotId, botArn}, ...]` for a one-call lookup.
- **`backend/lambda/src/channel-battle.ts`** - API handler for the enable / disable / get-config endpoints; calls Amazon Chime SDK `CreateChannelMembership` and `DeleteChannelMembership` for the alt-slot.
- **`backend/lambda/src/channel-flow-processor.ts`** - detects `/battle`, gates on classification and battle-enablement, lists channel members, and hands the turn to the handler once per bot member. It decides WHO responds and passes the coordination context; it does not run the turn.
- **`backend/lambda/src/lib/async-processor-core.ts`** - per-bot generation: assembles the system prompt with battle awareness, writes battle state, and handles the `NO_REBUTTAL` sentinel. The variant it serves is resolved on the ordinary turn path, not on a battle-specific one.
- **`backend/lambda/src/battle-orchestrator.ts`** - fires round 2 once both sides reach round-1 completion.
- **`backend/lambda/src/battle-alt-slot-handler.ts`** - Lex fulfillment for the alt-bot slots. A real turn addressed at an alt slot is handed to the classification's router (resolved at runtime from `/assistant/{classification}/router-arn`) with this slot's own identity attached. The identity comes from the battle state, not the Lex event (every slot shares one Lex bot/alias): the addressed slot is the active duel's single `WAITING_FOR_USER` alt side, and anything ambiguous degrades to silence rather than answering as a guessed identity. The router invoke is aborted at 25s so the degrade stays inside Lex's 30s code-hook window.
- **`backend/lambda/src/lib/battle-state.ts`** - the state and config data layer (see below): `deriveBattleId`, `isBattleEnabled`, per-bot state transitions, the orchestrator claim, and continuation planning.
- **`backend/lambda/src/lib/experiment-manager.ts`** - the A/B experiment schema and cache, extended with battle fields and the slot-to-variant resolvers.
- **Frontend** (`frontend/packages/chat`, `frontend/packages/admin`) - marker parsing, round dividers, variant chips, the scorecard, the live tally, the admin arming form, and the per-step steps view.

## 2a. Battle state is NOT task state (owner decision, 2026-08-09)

**A battle is not a task.** Certain *intents* are tasks; a battle is a state that lives outside the
task concept entirely, and a battle turn completes outside it too. What a battle adds to a turn is
**additional instruction** - rebut, build, concede - not a work item to be tracked.

The two were fused, and the fusion is the defect:

- `async-processor-core.ts` gates a side's terminal transition on `isBattleRound1Complete(...)`, so
  **task terminality decides when a battle round is done**. A duel whose intent happened to be
  task-shaped therefore had a completely different completion rule from one whose intent was not.
- The battle state row carried `taskId`, and the flow's own resume planner read it to decide whether a
  resumed side was a `TASK_*` duel or a placeholder one - battle state reaching into task state to
  answer a battle question. Both are gone; the row no longer carries a task id and the flow no longer
  plans a resume.

**Under the separation:**

| Concern | Owns | Does not own |
|---|---|---|
| Battle state | which duel, which round, which side, whether that side has produced its round-N response | anything about tasks |
| Task state | whether a work item is open, its state machine, its terminality | anything about duels |

A side's round is complete when **it has produced its response for that round**. If the intent also
opened a task, that task proceeds on its own; the duel compares the assistants' answers, and a rival
rebuts the answer. The battle row therefore needs no `taskId`, and the round-completion gate needs no
knowledge of task state.

**The separation does NOT let round 2 fire mid-chain ([ADR-026](../../design/decisions/026-task-shaped-battle-rounds.md), owner
2026-08-10).** An earlier draft of this section said it did, and treated that as an accepted consequence
to be handled in the rebuttal's *prompt*. It is not accepted: a rebuttal of a half-collected report is
not a rebuttal, and no prompt can recover what the other side has not produced yet.

What the separation forbids is battle completion being *defined by* task terminality - the
`isBattleRound1Complete` predicate that asked a task question to answer a battle one, and so gave a
task-shaped duel a different completion rule from every other duel. That still holds: no such predicate
exists and `battle-round1-complete.test.ts` keeps it that way.

Waiting for the chain needs no such predicate, because the state machine already had the word for it.
`WAITING_FOR_USER` is non-terminal and `allBotsTerminal` counts only `COMPLETED` and `FAILED`, so the
machinery that suspends round 2 for a clarifying question suspends it for a task leg too. **A side
mid-chain is BUSY, not incomplete.** A task-shaped side therefore enters `WAITING_FOR_USER` between legs
and reaches `COMPLETED` when its task reaches a terminal state, using the ordinary
`shouldMarkTaskCompleted` rule rather than a battle-specific one.

The handler may still *see* task state; the separation forbids battle COMPLETION being defined by
task terminality, not awareness that tasks exist.

**How a round then ends, and what fires the next one: [ADR-023](../../design/decisions/023-battle-round-coordination.md).**
**Reopened, not built.** A side's round is complete when it has produced its response. What fires the
next round is undecided: the peer-rendezvous design this section previously described is disproven.

**Assistants cannot signal each other by channel message.** Amazon Chime SDK does not deliver a
message authored by an `AppInstanceBot` to another `AppInstanceBot`'s Lex, so a nudge from one side to
the other triggers nothing. Measured with a control - the identical targeted message from a human
invokes the assistant, from a bot it does not - and undocumented, since `TargetedMessages: ALL` reads
as though any targeted message would be processed. **Whatever fires round 2 must therefore be an
out-of-band call** (an async Lambda invoke, a stream, or a scheduled re-check), which is what the
current orchestrator already does and what
[DESIGN-MULTI-AGENT-ORCHESTRATION](DESIGN-MULTI-AGENT-ORCHESTRATION.md) independently chose for
sub-agent fan-out.

Two constraints survive the change of transport and belong to whatever replaces it: the round-2 claim
keys on `(battleId, botArn, round)`, because a redelivered async invocation can still fire a side
twice; and **a rebuttal degraded by a timeout must be recorded as such and stay separable from a
genuine no-response**, or a slower variant silently loses its rebuttals and the comparison is biased
against the arm being evaluated. The third constraint - that a bounded wait be billed inside the
worker's `timeoutSeconds` budget (30/60/90) - applies only if the replacement keeps an in-worker wait.

**What replaced the row's `taskId`: [ADR-024](../../design/decisions/024-task-ownership.md), and it is
built.** The lookup is by OWNER - "the active task owned by this actor in this channel"
(`getActiveTaskForOwner`) - which is the same question for a duelling assistant and for a person holding
a work item, so one owner field and one index serve both and the battle row carries nothing.

**Built.** All three of the fused pieces are gone: `isBattleRound1Complete` survives only in a comment
recording why it went, `battle-state.ts` states "NO `taskId`" at the row definition, and
`planBattleResume` was removed when the continuation moved to the handler entry. ADR-024's replacement
is live rather than proposed - `getActiveTaskForOwner` (`task-tracking.ts`, called from
`router-agent-handler.ts`) is the owner-scoped lookup that made the row's `taskId` unnecessary.

## 2c. How far a duel still diverges from an ordinary turn

A battle is worth what it predicts about production, so every divergence is either paid for or is a
defect. This is the current ledger, and it is short by design: the handoff moved the turn decisions to
the handler, and what remains is either unavoidable or named.

| Divergence | Status | What it costs |
|---|---|---|
| The flow decides the turn happens, not Amazon Chime SDK routing | **Unavoidable** | Nothing. `/battle` is not an Amazon Chime SDK mention value, so nothing else can route it |
| The handler is TOLD which bot identity to answer as | **Unavoidable** | A duel needs two authors. Priced by validating the identity against the alt-slot roster instead of trusting the caller |
| Round 2 has no user message behind it | **Unavoidable** | TTFF is undefined and must be null; those rows stay out of TTFF averages |
| One rate-limit and spend charge for the duel, not one per side | **Deliberate** (owner, 2026-08-09) | Fidelity, traded knowingly: a rejection landing between the sides would leave one answer with nothing to compare against, which is measurement bias rather than a UX wrinkle. Scoped to the flow-DECLARED duel only: a resumed side's turn synthesizes its battle context after the router's metered-upstream check and is metered like an ordinary turn |
| **Round 2 dispatches the worker directly** | **Not aligned** | A rebuttal never classifies, so it cannot honour a profile's `classifierMode`, cannot join a classifier experiment, and carries a hardcoded delivery option. [ADR-023](../../design/decisions/023-battle-round-coordination.md) A-prime moves it to the handler entry |
| **Battle correlation ids are minted, not derived** | **Not aligned** | The flow's duplicate-placeholder guard keys on the id, so it cannot collapse a duplicated battle delivery; the battle-state claims carry that alone ([ADR-022](../../design/decisions/022-message-identity-is-established-at-the-channel-flow.md) §4) |
| **A duel-only way to ask the user something** | **Retiring** | Into task assignment, not repair ([ADR-029](../../design/decisions/029-clarification-is-public-and-answers-get-their-own-placeholder.md)) |

**Two things left the battle side entirely and should not come back.** The round-1 prompt no longer
shapes the answer - length, structure and how many questions to ask are the intent's, resolved on the
ordinary path. And a battle no longer carries its own task category: a duel turn opens an ordinary task
when its intent is task-shaped, owned by the assistant.

**The one gap with no home yet** is FR3's promise that a side will not deflect an explicit request by
proposing a new conversation. It was a battle-side prompt clause and it went with the rest. Deflecting
an explicit request is wrong on any path, so restoring it as a battle rule would re-create the pattern
this section exists to shrink. It belongs wherever "the user asked for this deliberately" is decided,
which today is nowhere.

## 2d. User-assigned tasks are the mechanism, and the mirror is not ready for them

[ADR-029](../../design/decisions/029-clarification-is-public-and-answers-get-their-own-placeholder.md)
sets the direction: a side that needs something from a person opens a **task assigned to that person**,
and the composer renders the current user's assigned tasks, so a duel question and a report chain
waiting on the same person queue together.

**The substrate is already built, and it was built for this.** ADR-024 recorded four hazards that would
bite the first time a task's requester and its owner differed - which is exactly what an assistant
assigning work TO a person is. All four are closed:

1. **One owner field, one writer.** `ownerId`/`ownerType` through `setTaskOwner`, with
   `resolveTaskOwner` reading legacy rows. "Owned by one at a time" is representable and enforced.
2. **The mirror is partitioned by the OWNER at every writer.** `putMirrorRow` is the single creator;
   the old split - created under the requester, updated under the assignee - is gone, and
   `mirrorTaskStatus` now upserts a WHOLE row with `if_not_exists` guards, so the partial row with no
   `ttl` cannot be created even if a mirror write is lost.
3. **`reassignTask` replaces the uncalled `updateTaskAssignee`.** It moves the mirror partition
   (delete-old after put-new, so a mid-way failure leaves the task findable under both owners rather
   than neither) and is deliberately unwired, documented as such, and covered - waiting for exactly
   this caller.
4. **The battle task category is gone.** A duel turn calls `createTask` like any other turn, owned by
   the assistant, so it is in the same index as everything else.

`getActiveTasksForUser(userSub)` is already the cross-channel query a queue needs: one constant-cost
partition read of the tasks a person currently owns, whichever assistant or workflow handed them over.

**So what is missing is the two ends, not the middle:** a caller that hands a task to the user when an
assistant needs something, and a surface that renders what a user owns.

## 2b. End to end: what is configured, what users are told, what runs

A duel is the visible end of a chain that starts in an experiment. Reading the fan-out alone hides
where its decisions come from, which is how a classification-blind dispatch survived in round 2 while
round 1 was fixed - the two ends of this chain were reviewed separately.

```
  ADMIN CONFIGURES AN EXPERIMENT (experiment-manager.ts)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ experimentType   intent │ base_model │ classification │ profile              │
  │ intent           the target intent, when the type is `intent`                │
  │ tiers[]          which classifications this applies to                       │
  │ objective        .statement - the DECISION, in the operator's words          │
  │ variants[2]      control                    │ treatment                      │
  │                  modelKey XOR profileRef    │ modelKey XOR profileRef        │
  │                  + displayName (required)   │ + displayName (required)       │
  │                  + systemPromptAddendum?    │ + systemPromptAddendum?        │
  │                  + imageGenModelKey?  ── both or neither ──┘                 │
  │ battleEnabled    true  ⇒ needs exactly 2 variants + altBotSlotId             │
  │ longFormMode     one-shot │ outline-first                                    │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  │  admin arms it on a conversation
                                  ▼
  BATTLE IS ENABLED HERE (channel-battle.ts)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ ChannelBattleConfig: enabled, experimentId, altBotSlotArn, enabledBy         │
  │                    + briefingStatement, briefingIntent  ← snapshotted        │
  │ the alt-slot bot JOINS the conversation as a real member                     │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  │  broadcast to everyone in the conversation
                                  ▼
  THE BRIEFING - what users are told BEFORE any duel runs
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ "Two assistants will answer the same prompt so you can compare them."        │
  │ "We're deciding: <objective.statement>"        ← the decision, not the models│
  │ "Most useful prompts: <coaching line for the target intent> For example: …"  │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  │  a member types  /battle <prompt>
                                  ▼
  THE CHANNEL FLOW decides WHO answers - and nothing else
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ eligibility (battleEligible on the channel's profile) │ single-active guard  │
  │ abuse gate - ONCE, for the duel as a whole            │ round-1 claim        │
  │ resolves the ROUTER for the channel's classification                         │
  └──────────────┬──────────────────────────────────┬────────────────────────────┘
                 │ one turn per side                │
                 ▼                                  ▼
  THE HANDLER DECIDES - one side per invocation (router-agent-handler.ts)
  ┌──────────────────────────────┐   ┌──────────────────────────────┐
  │ side = CONTROL (default bot) │   │ side = TREATMENT (alt slot)  │
  │ classify (profile-aware)     │   │ classify (profile-aware)     │
  │ resolve variant → model      │   │ resolve variant → model      │
  │   or whole profile version   │   │   or whole profile version   │
  │ delivery option, task if any │   │ delivery option, task if any │
  │ NOT metered again (the flow  │   │ NOT metered again            │
  │   gated the duel as a whole) │   │                              │
  └───────┬──────────────┬───────┘   └───────┬──────────────┬───────┘
          │              │                   │              │
          │ (a) dispatch │ (b) return the    │ (a)          │ (b)
          │  ASYNC, and  │  placeholder TEXT │              │
          │  do not wait │  to its caller    │              │
          ▼              ▼                   ▼              ▼
  ┌──────────────────┐  ┌─────────────────────────────────────────────┐
  │ THE PROCESSOR    │  │ the FLOW posts it as that bot               │
  │ (async, per side)│  │ "One moment… <!--corr:ID--><!--battle:…-->" │
  │                  │  │  ← carries this side's displayName          │
  │ model call       │  └──────────────────────┬──────────────────────┘
  │ tools, RAG,      │                         │
  │ guardrail        │   the two race: the handler dispatched BEFORE
  │                  │   the placeholder existed, so the processor is
  │ finds the        │◄──not handed its id. It resolves the message by
  │ placeholder by   │   the corr# control-table mapping, or scans for
  │ corr# mapping    │   the marker if the mapping has not landed yet.
  │                  │
  │ UPDATES that     │──▶ the placeholder becomes the answer, in place
  │ same message     │    (no second bubble; markers carry the stats)
  │                  │
  │ writes its       │──▶ BattleState row → COMPLETED | FAILED
  │ battle row       │
  └────────┬─────────┘
           │ the LAST side to reach terminal claims the fire, then dispatches round 2
           │
           │   NOT by messaging the rival. A bot-authored message does not invoke
           │   another bot (ADR-023 Status), so a peer nudge reaches nobody.
           ▼
  ROUND 2 - AS BUILT TODAY (battle-orchestrator.ts, a third entry point)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ posts its own round-2 placeholder per side, then invokes the PROCESSOR       │
  │ directly with round=2 + the rival's reply. Resolves the processor from the   │
  │ DUEL'S classification, never a hardwired premium one.                        │
  │ STILL RUNS TURN LOGIC: hardcoded intent + delivery option, resolves both     │
  │ variants itself. That is the remaining distance, counted by the ratchet.     │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  ▼
  ROUND 2 - RECOMMENDED (ADR-023 A-prime; not built)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │ the claiming worker dispatches each side THROUGH THE HANDLER, exactly as     │
  │ round 1 does above: same entry, same classification, same variant            │
  │ resolution, with battleContext.round = 2 and trigger = 'orchestrator'.       │
  │                                                                              │
  │ The handler resolves the turn and returns the placeholder text; whoever      │
  │ dispatched posts it. No hardcoded intent, no second variant resolver, no     │
  │ direct processor invoke - the three things the ratchet still counts here.    │
  │                                                                              │
  │ ARCHIVE: post a NON-TRIGGERING marker message alongside the dispatch, so     │
  │ the coordination is in the system of record. That is the one property the    │
  │ disproven peer-nudge design was bought for, obtained without it.             │
  │                                                                              │
  │ The orchestrator becomes a DISPATCHER, and is kept rather than removed: it   │
  │ still owns the "didn't finish in time" turn and the nobody-finished close.   │
  └───────────────────────────────┬──────────────────────────────────────────────┘
                                  ▼
  THE HUMAN PICKS → BattleOutcome → experiment_results → the recommendation
```

**Why round 2 cannot simply ask its rival to go.** The natural design is a peer handshake: the last
finisher sends the rival a `Target`-ed message and the rival's turn runs. Measured against the
deployment, that message triggers nothing - Amazon Chime SDK does not route a message authored by an
`AppInstanceBot` to another `AppInstanceBot`'s Lex, while the identical message from a user principal
does. So every candidate trigger is an out-of-band call, and the archive property has to be added
deliberately rather than obtained as a side effect of the transport. Full evidence, and the one design
that would restore in-channel coordination (a proxy `AppInstanceUser` per assistant, deferred), are in
[ADR-023](../../design/decisions/023-battle-round-coordination.md).

**Why the handler and the processor are two Lambdas, since the split is the part most often
misread.** The handler is synchronous and must answer fast: it decides what this turn IS and returns
the placeholder text. The processor is asynchronous and slow: it makes the model call and then
**updates the message the placeholder already occupies**, which is why a duel shows one bubble per
side that fills in, not a bubble followed by an answer.

**The handler dispatches the processor BEFORE the placeholder exists**, so it cannot hand over the
message id - the caller posts the placeholder only after the handler returns. The processor therefore
resolves its own target from the `corr#` control-table mapping, falling back to a marker scan when
the mapping has not landed yet. That is one resolution path instead of two, and it is the same on
`@all`; the alternative was passing an id that only one of the callers could ever have.

### Open: should the handler post its own placeholder on a bypass?

**Raised by the owner, 2026-08-09, and not settled.** The caller posts today because Lex materialises
the message from the fulfillment return on the ordinary path, a bypass has no Lex return to
materialise, and keeping one return contract lets an empty `messages` array mean *post nothing*
without the handler behaving differently per caller.

**The argument for moving it is stronger than tidiness.** If the handler posted the placeholder it
would HOLD the message id, so it could hand that id to the processor - and the `corr#` mapping plus
the marker-scan fallback above exist only because it cannot. A whole resolution path and its race
disappear, not just a line of caller code.

**What it costs, and this is the part that decides it: the handler cannot write to a channel at all
today.** Its role holds `DescribeChannel`, `ListChannelMemberships`, `ListChannelMessages`,
`ListTagsForResource` and `SearchChannels`; `chime:SendChannelMessage` is on the PROCESSOR role. So
this is a privilege change to the component that runs on every turn, not a refactor - and "the
handler is read-only on channels" is a property worth naming before giving it up.

It also needs the audience passed in: the handler cannot see the inbound message's `Target`
(`router-agent-handler.ts`), which is why reply visibility is derived downstream from the
placeholder's own `Target` rather than from anything the caller says.

**The flow is NOT deciding targeting today, and on `@all` it sets no `Target` at all.** Both call
sites of the mention path pass `broadcast: true` (`channel-flow-processor.ts`), so the
placeholder is untargeted and the reply's tail stays public - which is the intended behaviour. The
`broadcast: false` branch has no caller. The flow's only targeted sends are its OWN notices (the
single-active-battle message, the unwired-router error), addressed to the sender.

So visibility is carried by the placeholder and read back downstream, not decided by whoever posts.
Any move of the posting has to preserve that rather than replace it with a caller-passed target,
which was explicitly rejected.

**What each configuration axis actually varies, since "run an experiment" says nothing on its own:**

| Axis | Values | What differs between the two sides |
|---|---|---|
| `experimentType` | `intent`, `base_model`, `classification`, `profile` | which population the experiment scopes to; only `intent` has a single target intent, which is why the others brief with a generic prompt line |
| `intent` | one of the shipped intents | the traffic the experiment measures, and the prompt-steering examples users are shown |
| `tiers[]` | any of basic / standard / premium | which classifications the experiment applies to. Distinct from `battleEligible`, which is the per-profile flag deciding whether a classification may run duels at all |
| variant shape | `modelKey` XOR `profileRef` | a bare MODEL against another model, or an entire PROFILE VERSION against another - prompt, pack, tools and guardrail included. Mutually exclusive by validation |
| `systemPromptAddendum` | free text, sanitised | a persona difference on the same model |
| `imageGenModelKey` | set on BOTH variants or neither | the duel produces images rather than text |
| `longFormMode` | `one-shot`, `outline-first` | whether round 1 is the whole deliverable or an approach the user steers between |

**The briefing is semi-blind, and that is a measurement property rather than a courtesy.** It names
the decision and never which alias is which model, so a picker cannot favour a name they already
trust. It is snapshotted onto the channel config at arm time (`briefingStatement`, `briefingIntent`),
so every member sees the same briefing - including people who join later and non-moderators, who
cannot read the experiment itself.

**Prompt steering exists because a duel is only as good as what it is asked.** The target intent
selects a coaching line and two examples; an experiment that spans intents falls back to a generic
line rather than inventing a target it does not have. Without an `objective.statement` there is no
briefing at all and the announcement stays as it was, so an unbriefed battle degrades to the old
behaviour instead of announcing an empty decision.

## 3. Data Model

**`ChannelBattleConfig`** (DynamoDB) - per-channel enablement. PK `channelArn`; attributes `enabled`, `experimentId`, `altBotSlotArn`, `enabledBy`, `enabledAt`. Read at `/battle` time via `isBattleEnabled(channelArn)` (cached), so it is load-bearing at runtime, not admin/UI-only.

**`BattleState`** (DynamoDB, TableName `AgentEchelon-BattleState`) - per-bot round state. PK `battleId`, SK `botArn`. Attributes: `state` in `{INVOKED, WAITING_FOR_USER, COMPLETED, FAILED}`, `round1Reply`, `round1MessageId`, `correlationId`, `enteredStateAt`, `deadlineAt`, `waitingSince`, `waitedMs`, `clarificationCount`, `waitingMessageId`, and a `ttl`. **The TTL follows the DEADLINE, not a fixed window**, and the two clocks differ by an order of magnitude: a generating side is due on the machine deadline (`BATTLE_ROUND1_DEADLINE_MS`, 180s) and expires ten minutes after its last write, while a side blocked on a person is due on the user-wait deadline (`BATTLE_USER_WAIT_MS`, 1h) and its TTL is extended to match, so the row cannot be deleted out from under someone who is still thinking. A sentinel SK (`__orchestrator__`) provides exactly-once round-2 firing.

`battleId` derivation is the single source of truth, computed the same way by the channel-flow-processor and the async-processor (`deriveBattleId` in `battle-state.ts`):

```
sha256(`${channelArn}:${userMessageId}`).hex.slice(0, 16)
```

`userMessageId` is the stable Amazon Chime SDK message id of the `/battle` message, so the id is retry-stable.

**Experiment schema extension** (`experiment-manager.ts`) - the alt-slot to variant binding lives on the experiment row itself; there is no separate binding table (the existing 60-second experiment cache makes the lookup free):

```typescript
interface ExperimentVariant {
  variantId: string;
  modelKey: BackendModelKey;
  weight: number;
  displayName?: string;          // surfaced in UI and rival prompt; required when battleEnabled
  systemPromptAddendum?: string; // sanitized; see APIs
}
interface Experiment {
  // ...existing...
  battleEnabled?: boolean;
  altBotSlotId?: string;         // "slot-0", "slot-1", ...
  altBotSlotArn?: string;        // denormalized for hot-path resolution
  boundBy?: string; boundAt?: string;
}
```

`variants[0]` is control (served by the default bot); `variants[1]` is treatment (served by the alt-slot bot).

**`analyticsMetadata`** gains a top-level `assignmentMode: 'probabilistic' | 'battle'` and, when battle, a `battleContext` carrying `battleId`, `round`, `selfBotArn`, `rivalBotArn`, `optedOutOfRound2?`, and a `steps[]` array. Each step is `{ stepLabel, modelId, startedAt, endedAt, tokensIn?, tokensOut?, imageCount?, estCostUsd? }`. `assignmentMode` is deliberately top-level so variant-comparison rollups can filter out battle traffic *before* per-variant aggregation.

**`battleOutcome`** record (one per battle) - `battleId`, `winner: 'A'|'B'|'tie'`, `chosenByUserSub`, `chosenAt`, plus `experimentId` / `variantId` / `intent` so the pick aggregates per variant. Descriptive only; never read back into selection.

Large `steps[]` arrays persist out of band in the message-analytics record keyed by message id (not on the <=1KB Amazon Chime SDK Metadata), and archival merges them into Aurora's `messages.metadata` JSONB, queryable with no cap.

## 4. APIs, Interfaces, and Markers

**Endpoints** (existing admin/user-management API Gateway, Cognito-scoped, handled by `channel-battle.ts`):
- `POST /channels/battle/enable` - body `{ channelArn, experimentId }`; validates battle-eligibility and classification/intent match, calls `CreateChannelMembership` with the alt-slot ARN, writes `ChannelBattleConfig`, posts an announce message. Battle-eligible classification only (`profile.battleEligible`); channel-moderator only.
- `POST /channels/battle/disable` - body `{ channelArn }`; removes membership, deletes the config row, posts a leave message.
- `GET /channels/battle?channelArn=...` - returns the config or 404.

**Experiment write validation** (`createExperiment` / `updateExperiment`, 4xx on violation): `battleEnabled` requires exactly 2 variants, a defined `altBotSlotId`, and a display name on each variant; a slot bound to another active battle experiment returns 409 with `{ conflictingExperimentId, slotId }`; disabling battle while a `ChannelBattleConfig` references the experiment returns 409 with the affected channel ARNs.

**System-prompt addendum sanitization** (server-side, before storage): cap 500 chars after whitespace normalization; strip ASCII control characters; reject the literal `</persona_addendum>` (the assembly delimiter) case-insensitively; collapse whitespace runs.

**Markers** (in raw message content, stripped before display by the frontend parser and the Bedrock Guardrail metadata filter):
- `<!--corr:{id}-->` - existing correlation marker, unchanged.
- `<!--battle:round={n},total={total},rivalArn={arn},rivalReplyMsgId={msgId?}-->`
 - parsed into a `battle` field `{ round, rivalBotArn, rivalReplyMsgId? }` used for round dividers and rebuttal linking.
- Generation-out carries NO image marker: the image is delivered as a message **attachment** and rendered by `AttachmentDisplay`, which fetches a fresh presigned URL on demand. An inline marker would embed a presigned URL in the content, so it expired with the STS token.

**Variant resolution** (`experiment-manager.ts`): `resolveBattleVariantBySlotArn` (treatment side, from the alt-slot ARN), `resolveBattleControlVariantByAltSlotArn` (control side, keyed by the same alt-slot ARN so the control honors its configured variant), and `resolveBattleImageGenPair`. These read fresh rather than through the 60s experiment cache: they decide what the duel IS, they run once per battle turn rather than per ordinary turn, so the cache buys nothing and costs correctness. They resolve on the turn path with the rest of the variant resolution, not ahead of it in the fan-out.

## 5. Key Flows and Algorithms

**Detection.** `channel-flow-processor.ts` tests `/@all\b/i` and `/\/battle\b/i`; they are mutually exclusive and `/battle` wins. `/battle` is parsed only at message start (a command, not an inline mention). Both are Lex bypasses, not native Amazon Chime SDK mentions.

**Detection is the flow's only decision.** Bypassing Lex is the sole sanctioned difference between a battle turn and an ordinary one ([MESSAGE-FLOW §3.1](../../guides/developer/MESSAGE-FLOW.md)): the flow decides that two assistants respond, and everything after that - classification, profile resolution, variant resolution, model selection - is the ordinary turn, run by the handler once per participating assistant. A decision duplicated on this path is one that can diverge from the ordinary path, and it diverges silently because the duel still answers, which is why the duel resolves nothing for itself.

> **THIS PARAGRAPH IS THE TARGET, NOT THE CURRENT CODE.** `@all` takes the handoff; `/battle` does
> not yet. Today the duel runs its own turn logic in **two** places - the round-1 fan-out
> (`channel-flow-processor.ts`) and the round-2 rebuttal (`battle-orchestrator.ts`, a separate
> Lambda). Both classify with a bare `classifyIntent(content)` that cannot honour a profile's
> `classifierMode` or classifier model and is invisible to classifier experiments, both resolve
> variants ahead of the turn, and both invoke the worker directly. Round 2 additionally hardcodes
> `intent: 'general'` and `deliveryOption: 'PLACEHOLDER_UPDATE'`. `flow-does-not-run-the-turn.test.ts`
> measures the remaining distance but **scans the channel flow only**, so the orchestrator's copy is
> currently unmeasured. See §5a for the design that closes it.

### 5a. The per-side handoff (DESIGN - not built)

**Why this matters more for a duel than for `@all`.** A battle is an interactive A/B test: its result
is only worth something if a battle turn is what a production turn would have been. A duel that
resolves its own models on its own path measures an engine no user meets. **A side classifying
differently from its rival is a RESULT** - classification is part of the flow under test - but it has
to be the real classifier producing that difference, not a second implementation that structurally
cannot honour profile config.

**Shape.** Call the handler once per participating assistant. Each side is then an ordinary turn, and
the handler does what it already does on every Lex turn: classify with the profile's configured mode
and model, select the delivery option, resolve the experiment variant, create any task, and dispatch
the worker. Both rounds use the same entry.

This retires from the fan-out: `classifyIntent`, `planBattleTaskDelivery`, `createBattleTask`, both
variant resolvers, `resolveBattleImageGenPair`, and the direct worker invoke. It retires the same set
from the orchestrator. The two stated obstacles dissolve rather than needing a workaround:

> **The flow never creates task state (owner, 2026-08-09).** A battle turn follows the ordinary
> message and response flow as closely as it can, so the flow decides WHO answers and the handler is
> the only place a task is born. `createBattleTask` and `planBattleTaskDelivery` are pinned in
> `flow-does-not-run-the-turn.test.ts` alongside the other four, so the remaining distance is measured
> rather than remembered and the rule cannot decay back in.

### How a duel is metered: one user action, one gate

Found while wiring the fan-out to the entry, and settled before the switch landed because every
option is user-visible.

The flow gates the duel **once**, before fanning out (`enforceAbuseGate`), and the handler gates every
ordinary turn (`evaluateAbuseGate` in `router-agent-handler.ts`). A battle turn arriving at the handler must therefore
either skip that gate or add a second and third charge to a single user action.

Two coherent answers, and they differ on what a duel *is*:

- **One user action, one gate.** The flow gates the duel as a whole and the handler skips its gate
  when a battle context is present. A duel then costs one unit, as today, and can never half-fail.
  The cost is a battle-shaped exception inside the handler, which is the kind of special case this
  whole thread has been removing.
- **Two turns, two gates.** The flow's gate goes, as it did for `@all`, and each side meters itself.
  Truer to what a duel actually spends, and it removes the exception. **But a rejection between
  sides produces a half-duel**: one side answers, the other posts a rate-limit notice, and the
  comparison the feature exists for is gone. That needs its own handling - reject the duel as a
  whole, or present the missing side as a non-response, which is measurement bias in an experiment.

**Decided: one user action, one gate (owner, 2026-08-09).** The handler skips its gate only for a
**declared** battle context - one that ARRIVED with the turn, meaning the flow already metered the
duel upstream (`meteredUpstream` in `router-agent-handler.ts`) - so the flow's single gate stands for
the duel as a whole and a 2-bot duel consumes **one** rate/spend charge, not one per side. A context
SYNTHESIZED by a resumed side is created after that check: the resumed turn is an ordinary Lex turn
no upstream ever gated, so it is metered here like any other turn. The deciding
argument is the half-duel: a rejection landing between the sides leaves one answer with nothing to
compare it against, and a rejected arm is indistinguishable in the results from an arm that answered
badly, which is measurement bias in an experiment rather than a UX wrinkle. The accepted cost is one
battle-shaped branch in the handler, and the handler states that at the branch.

The `@all` precedent does not settle this on its own: there, one user action is one turn, so moving
the gate changes nothing about what gets charged. Here one user action is two turns.

**Round 2 is measured too, and it was not before.** The ratchet scanned the channel flow only, so the
flow's count read as the whole remaining distance while `battle-orchestrator.ts` - a third way into
the worker - went uncounted. It makes the same kind of decision the fan-out does, and two of its
own: it hardcodes `intent: 'general'` and `PLACEHOLDER_UPDATE` instead of letting the handler classify
and select, which is the pair the `@all` handoff deleted from the flow and the reason a rebuttal
cannot presently be anything but a placeholder update. The orchestrator resolves its processor from
the DUEL'S classification (`getProcessorArnForClassification`, `battle-orchestrator.ts`), and its
role grants `/assistant/*/processor-arn`, so both rounds of one duel resolve their worker by the same
rule; the remaining round-2 divergence is the hardcoded intent and delivery pair above.

- **The delivery option** was needed before dispatch only because the fan-out was choosing it. The
  handler already runs `selectDeliveryOption(intent, hasActiveTask)` and owns task creation.
- **The variant display name** in the placeholder marker (`name=`) was the only reason the fan-out
  resolved variants at all. The handler resolves the variant, so it knows the display name and returns
  a placeholder already carrying it.

**What the caller still supplies**, all of it coordination context a side cannot derive:

| Field | Why the handler cannot derive it |
|---|---|
| `botArn` | The handler resolves one identity from a per-classification SSM parameter; a duel has two sides |
| `correlationId` | The battle state row keys on it, and it must exist before dispatch so the orchestrator can see the side in flight |
| `battleContext` | Battle id, round, rival, which side, and for round 2 the rival's reply. Already a first-class field on the worker event |

**Ordering the flow keeps.** The single-active-battle claim, `setActiveBattle`, membership listing and
`initBotState` stay with the flow and the orchestrator: they are coordination, and keeping the claim
ahead of the invoke is what stops a redelivered duel spending twice.

**Consequence, accepted.** As with `@all`, a side no longer hands the worker a `placeholderMessageId`
(the handler dispatches before the placeholder exists), so the worker resolves through the
control-table mapping or the marker scan like any other turn. One resolution path instead of two.

**Build state: two of the three callers dispatch through the entry; the round-2 orchestrator does not.**

The handler accepts a battle turn (`TurnRequest.botArn` / `correlationId` / `battleContext` /
`trigger`), validates the identity, resolves the side, dispatches the worker and returns the labelled
placeholder. `lib/battle-turn.ts` holds the side resolution. Verified by `battle-turn.test.ts`
(16 tests; the identity guard and the arm assignment are mutation-proven).

- **Round-1 fan-out: through the entry.** `handleBattleMessage` invokes the handler per side
  (`channel-flow-processor.ts:1223`) and no longer classifies, resolves variants, resolves the image
  pair, creates the task or picks a delivery option itself.
- **Answering a waiting side: NOT through the flow at all.** It is an ordinary turn, resolved from the
  task ([ADR-030](../../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md)).
  The side keeps its variant for the same reason every other case does: the turn resolves it.
- **Round 2: NOT through the entry.** `battle-orchestrator.ts` still runs its own turn logic and
  invokes the worker directly. Switching it is
  [ADR-023](../../design/decisions/023-battle-round-coordination.md) A-prime: recommended, not decided.
  Round 2 works, so this is fidelity rather than correctness.

The flow dispatches no worker on any path. `routerArnForClassification` is its only routing table.

**Decisions taken:**

1. **Bot identity is caller-supplied, so it is validated.** `isSanctionedBattleBot` allows the
   classification's own bot or a bot in the published alt-slot roster
   (`ALT_BOT_SLOTS_ROSTER_PARAM`), and nothing else. It **fails closed**: an unreadable roster
   rejects every caller-supplied identity rather than waving it through. An unsanctioned ARN logs a
   security event and falls back to the classification's own bot, so the duel shows the wrong author -
   visible - rather than going silent.
2. **Per-side gate charging: no.** The flow gates the duel once and the handler skips its gate on a
   flow-declared battle context (a context synthesized by a resumed side comes after the
   metered-upstream check and meters itself like an ordinary turn), so a 2-bot duel consumes **one**
   rate/spend charge rather than one per side. Two
   model calls are two turns, so this is a deliberate departure from fidelity: it buys the guarantee
   that a duel refuses or runs as a whole, because a rejection landing between the sides is
   measurement bias. See "How a duel is metered" above for the full argument, and §3.3 of MESSAGE-FLOW
   for the same consequence stated on the flow side.
3. **Round 2 carries an explicit `trigger: 'orchestrator'`.** It is fired with no user message, so
   its TTFF is undefined and must be null rather than zero, and its rows stay out of the TTFF average
   (see §5b).
4. **What fires round 2: UNDECIDED. It cannot be a message from one assistant's bot to another's**
   ([ADR-023](../../design/decisions/023-battle-round-coordination.md), reopened). Peer rendezvous is
   ruled out (see §2a). The candidates are an out-of-band call, which is what the orchestrator already
   does, or a per-assistant proxy `AppInstanceUser` sending under `sts:AssumeRole` so every hop is
   user-to-bot - that one works and keeps the coordination in the archive, but it is deferred to its
   own ADR because it means owning loop safety the platform currently provides. Whatever
   replaces it dispatches THROUGH this entry rather than re-implementing a turn, which turns
   `battle-orchestrator` from a turn-runner into a dispatcher. It can be removed **only once its
   degraded-path duties have a home**: it currently posts the "didn't finish in time" turn for every
   stalled side (`postDidNotFinish`, fanned out over the not-finished sides) and closes a duel where
   nobody finished (the `closed:no-completion` path). The rendezvous
   design gave the first duty to the waiting side; with that design gone **both duties are back with
   the orchestrator**, which is an argument for keeping it as the dispatcher rather than removing it.
   A duel where both sides die has no owner in any option and remains an open gap.

**The prerequisite the round-1 switch waited on is met:** battle-aware task creation (§8). A side
resolving to `TASK_MULTI_STEP` creates its task through `createBattleTask`, assigned to that bot and
carrying the battle id, so a task-shaped duel no longer produces an ordinary task with no battle
binding.

### 5b. What a battle result may and may not claim

Two limits are structural rather than defects, and stating them keeps a duel result from being read
as an online-experiment result:

- **Round 2 has no production analogue.** No ordinary turn is "reply to a rival's answer." A rebuttal
  can be a faithful engine turn, but it is not a sample of production behaviour, so round-2 rows must
  not be pooled with round-1 rows as though they were. It also has no user message to measure from, so
  its TTFF is undefined and must be null rather than zero.
- **A battle cannot be blind.** Both answers are shown side by side and the user picks, which measures
  preference under direct comparison - a different quantity from performance in production, where a
  user sees one answer. A duel is a real test of the engine and the variants, and a real preference
  signal; it is not a substitute for an online A/B's outcome metrics.

**Round 1 (parallel).** After detection: strip the leading `/battle` token; gate on the channel's classification tag (premium by default, per `profile.battleEligible`); gate on `isBattleEnabled` (else post the one-line not-enabled hint and return, no `@all` fallback); list memberships and filter to bot ARNs. If battle is enabled but fewer than 2 bot members exist (internal inconsistency only), fall back to a single default-bot broadcast with no error. Otherwise send a per-bot placeholder as that bot and invoke the async processor per bot in parallel (`Promise.all`) with a `battleContext` `{ round: 1, totalRounds: 2, selfBotArn, rivalBotArn, rivalReply: undefined }`.

**Per-bot generation.** Each side runs an ordinary turn. What the fan-out passes is only the coordination context a side cannot derive for itself: the battle id, the round, its rival, and **which variant it is** - the default bot is the control side, the alt-slot bot the treatment side. Resolving that variant into a model, a persona, tools and an image model is the ordinary experiment resolution the handler already performs, so a battle never resolves anything on a path of its own. That is what keeps one side from resolving successfully while the other falls through, which degrades a duel to a text turn with nothing in any log to say why. Prompt assembly order: classification base prompt, then `<persona_addendum>{sanitized addendum}</persona_addendum>`, then the battle awareness note last so it overrides any contradictory addendum.

**The battle prompt adds AWARENESS and nothing else** (`buildBattleAwareness`): a rival is answering the same prompt right now, and a turn to respond to theirs is coming. It does not shape the answer, and that is the point. Response length and structure come from the intent pack's per-intent `verbosity` and `maxTokens`, resolved on the ordinary turn path and threaded as `responseSettings`; deliverable shaping comes from `isDocumentRequest`; and asking the user a question is what an intent's task machine does when its flow calls for it, which is why `report_generation` and `data_extraction` legitimately ask several. A duel side is an ordinary turn, so it inherits all of that unchanged.

An earlier round-1 constant carried its own copies of those rules - permission for exactly ONE clarifying question, a ~150-word focus clause, a long-form deliverable clause and an outline-first clause. They existed because the pre-handoff fan-out hardcoded `intent: 'general'` and had no intent pack to ask, so the prompt had to shape the answer itself. The handoff removed the reason and the constant went with it. Restoring any of them would re-create the divergence the handoff exists to remove: a duel measuring an engine no user meets.

**Round 2 waits until each side has finished, and "finished" is a BATTLE state rather than an intent rule.** A rebuttal mid-task-chain is nonsensical, so a side that still has work to do with the user holds round 2 back. How that is expressed matters, because an earlier version of this paragraph described the mechanism that [ADR-024](../../design/decisions/024-task-ownership.md) removed: round-1 completion is NOT an intent-keyed table (`DIRECT` on send, `TASK_MULTI_STEP` on a terminal task-graph state, and so on), and no predicate asks task state whether a battle round ended. Instead: a side reaching a terminal state is `COMPLETED`; a side still waiting on the user - for a clarifying question or for the next leg of its task machine - is `WAITING_FOR_USER`, which is non-terminal and therefore suppresses the orchestrator on its own ([ADR-026](../../design/decisions/026-task-shaped-battle-rounds.md), §2a). One state machine, no per-intent completion rules, and a task-shaped duel obeys the same rule as any other.

**A wait is not a stall (ADR-026, the two clocks).** A generating side is due on the machine deadline (`BATTLE_ROUND1_DEADLINE_MS`, 180s); a side blocked on a person is due on the far longer user-wait deadline (`BATTLE_USER_WAIT_MS`, 1h). The state layer writes `deadlineAt` on every transition and the orchestrator reads it, because only the writer knows which clock applies. Without that split, `rowDeadlineMs` fell back to `enteredStateAt + 180s` for a waiting row and reported a user who thought for four minutes as an assistant that failed to finish. Waited time is banked into `waitedMs` so `computeActiveResponseMs` never charges a slow human to the assistant, and the whole-duel bound (`BATTLE_MAX_LIFETIME_MS`) is what the single-active-battle pointer ages out against, rather than one leg's.

> **SUPERSEDED BY §2a (owner, 2026-08-09), not yet implemented.** This rule is the fusion §2a
> removes: it makes task terminality decide when a *battle* round is done, so a duel's completion
> rule changes depending on whether its intent happened to be task-shaped. Under the separation a
> side's round is complete when it has produced its response for that round, and the
> "rebuttal mid-task-chain" judgement moves into the prompt rather than the state machine.

**Exactly-once round 2.** Each async-processor invocation writes its own `(battleId, botArn)` row idempotently (`ConditionExpression` allows the write only if absent or not yet terminal), then reads the full `battleId` partition. When `allBotsTerminal` (every row in `{COMPLETED, FAILED}`), the writer claims the fire via a conditional put on the `__orchestrator__` sentinel (`tryClaimOrchestratorFire` in `battle-state.ts`); exactly one writer wins. The orchestrator (`battle-orchestrator.ts`) then, per bot, sends a round-2 placeholder and invokes the async processor with `round: 2` and the rival's round-1 reply text; the prompt invites rebut / build / concede, or the single token `NO_REBUTTAL` to stay silent. On `NO_REBUTTAL` (trimmed, case-insensitive, optional trailing punctuation), the round-2 placeholder is UPDATED in place to a `No rebuttal.` state (via `UpdateChannelMessage`) rather than deleted - the opt-out is shown honestly, nothing appears-then-vanishes, and it needs no `chime:DeleteChannelMessage` grant (an earlier delete-based approach failed silently for lack of that permission and left the placeholder orphaned as a stale "waiting" bubble). Both opting out is valid.

**Clarification routing.** Clarification is a measured dimension, not forbidden, and how many questions a side asks is its INTENT's business rather than a battle rule (see "Per-bot generation"): a `report_generation` or `data_extraction` flow legitimately asks several. A side blocked on a person transitions `INVOKED -> WAITING_FOR_USER` (`markBotWaitingForUser`), which suppresses the round-2 orchestrator until it later completes and captures `clarificationCount` and `activeResponseMs`; `resumeBotFromWaiting` returns it to `INVOKED`. The user's answer reaches the addressed bot's Lex as an ordinary turn, and that turn resolves what it answers from the TASK rather than from who it was addressed to ([ADR-030](../../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md)); `resumeDuelSideIfWaiting` then returns THAT side, and only that side, to `INVOKED`. A bot that failed to ask never benefits from its rival's clarification, because a chain names the assistant whose work it is and two sides' chains are distinct rows.

**A duel has an owner, and the owner lives on the channel pointer.** The person who ran `/battle` is who a waiting side is waiting on and the only one whose reply resumes it. On the path a duel actually takes the refusal is STRUCTURAL rather than a comparison: a duel side's chain is held by the person it awaits, so the person-owed lookup only ever returns a chain THIS speaker holds, and a member who did not start the duel finds nothing and advances nothing. Their message is not refused, it simply resumes no side and is answered as an ordinary turn. The explicit owner comparison remains on the assistant-held branch, for a chain whose state does not await anyone. The owner is recorded by `setActiveBattle` on the channel's battle pointer (`activeBattleInitiator`), which the continuation path already reads to resolve which duel a reply belongs to, and it is read from there. It is not sourced from the per-bot `BattleState` rows: those are written by several callers across two Lambdas as the duel progresses, and an owner recorded on them is only as durable as the next transition. The rows carry `initiatorUserSub` as corroboration and as the fallback for a duel whose pointer predates the field; a duel with no owner in either place resumes for anyone, because an unanswerable duel is worse than an over-answerable one. A channel's pointer is one row reused by every duel in it, so a fan-out with no known initiator clears the field rather than leaving the previous duel's owner in place.

**What is public and what is not (ADR-029).** The QUESTION is public: it replaces that side's placeholder and stays in the transcript, so the duel reads as a conversation and a round-2 rebuttal can judge whether the question was worth asking. The user's REPLY stays targeted at the asking assistant, which is what preserves the measurement property above - a rival learns what its opponent found ambiguous, never what the user answered. The resumed side then answers on a NEW placeholder, like every other turn, and only clears the question message's `<!--battlewaiting-->` marker so the composer's waiting affordance ends.

**The `NEED_CLARIFICATION` sentinel is unreachable today and retires into task assignment** rather than being repaired. The round-1 prompt is `buildBattleAwareness` alone and never mentions it, and the state layer already treats "blocked on a person" identically whether the cause is a question or a task leg ([ADR-026](../../design/decisions/026-task-shaped-battle-rounds.md), `reason: 'clarification' | 'task-step'`). The destination (owner, 2026-08-13): a side that needs something from a person opens a **task assigned to that person** (`assigneeUserSub`, [ADR-024](../../design/decisions/024-task-ownership.md)), and the composer renders the user's assigned tasks rather than a battle-specific marker - so a duel question and a `report_generation` step waiting on the same person appear in one queue. `WAITING_FOR_USER` stays, narrowed to suppressing round 2, which is a battle concern; `<!--battlewaiting-->` and `clearBattleWaitingMarker` are transitional and retire with the sentinel. See [ADR-029](../../design/decisions/029-clarification-is-public-and-answers-get-their-own-placeholder.md).

**Task isolation.** Two bots can each run a task chain for the same user prompt, so a duel's task is created per-bot (`createBattleTask`, carrying `assignedBotArn` + `battleId`) and continuation messages route per-bot.

> **CORRECTION (2026-08-09): the index and lookup this paragraph used to claim do not exist.** It
> described a `userSub-botArn-taskType-index` GSI and `hasActiveTaskForBot(userSub, botArn)`. There is
> no per-bot lookup anywhere in `task-tracking.ts`, and the indexes are split across the two tables:
> `AgentTasksTable` carries `contextId-index` and `channelArn-updatedAt-index`
> (`foundations-stack.ts:79`, `:93`), `UserTasksTable` carries `userSub-taskType-index` (`:111`).
>
> **The prerequisite this raised is met.** Finishing DESIGN-BATTLE §2a means the battle state row stops
> carrying `taskId`, and `resumeBotFromWaiting` (`lib/battle-state.ts:432`) found a resuming side's task
> through that field. The owner index that replaces it is
> [ADR-024](../../design/decisions/024-task-ownership.md)'s `channelArn-updatedAt-index`, built and live
> on the agent-tasks table, so the resume path answers "the active task owned by this actor in this
> channel" without a per-bot index.
>
> **The fix is NOT a battle-specific index.** A task has ONE owner at a time, which may be a human or
> an assistant and may change at a step boundary (owner, 2026-08-09). Under that model the lookup is
> "the active task owned by this actor in this channel" - the same question for a duelling assistant
> and for a person holding a work item - so one owner index serves both and the battle row needs no
> `taskId`. A `userSub-botArn-taskType-index` would have encoded a battle special case into what is a
> general ownership concept. The task model owes an ADR before this is built.

**Drift interaction.** In a battle-enabled channel the router's live drift- suggestion path is fully suppressed (two competing "compare these" vs "start a new conversation" flows would confuse the user). The post-hoc analytics `detectDrift` still runs but tags rows with `battle_id` so known-divergent battle exchanges are excluded from TPR/FPR rollups by default. A system-prompt clause is defense in depth against a bot emitting drift-flavored text itself.

**Fail modes.** A crashed async processor leaves a state row that the 600s TTL reaps; the orchestrator treats a missing row as `FAILED` for the "all terminal" check, so the surviving bot still rebuts against an implicit empty rival. A single-active-battle-per-channel lock (the state table doubles as the lock) answers a second concurrent `/battle` with "a battle is already in progress."

**Marker survival.** The round-1 placeholder CREATE carries the `battle` marker; the async-processor UPDATE overwrites content with no marker. The frontend `ConversationProvider` update handler does a selective field merge that deliberately excludes `battle` from the override list, so chips, the round-2 divider, and the scorecard keep rendering after the reply lands. The scorecard summary fields (`responseMs`, `estCostUsd`, `steps`) are merged into the existing battle object from the UPDATE.

## 6. Security / IAM

- **Bounded bot growth.** Alt-bot slots are pre-provisioned at deploy time, not created per experiment. Runtime `chime:CreateAppInstanceBot` is avoided; growth is capped by `ALT_BOT_SLOT_COUNT`, and every slot ARN is statically known to Lex and handler resource policies. Raising the count is a CDK deploy, no schema change.
- **Cost gate.** A battle is up to 4 model invocations (2 variants x 2 rounds). `/battle` requires a battle-eligible classification (premium by default), resolved from the immutable `classification` tag, plus the single-active-battle lock. Existing `bedrock-resilience.ts` retry and circuit-breaking apply unchanged.
- **Authorization.** Enable/disable is channel-moderator only and battle-eligible-classification only. Addendum text is sanitized server-side and wrapped in a delimiter so the model treats it as a distinct authorial layer, with battle constraints appended last.
- **Image-output moderation** ships as a basic default guardrail; production-grade tuning is the deployer's documented responsibility (open-source posture), not an internal sign-off gate.

## 7. Testing

Backend unit tests (`backend/test/lib/` and `backend/test/`):
- `battle-state.test.ts` - id derivation, state transitions, `allBotsTerminal`, the orchestrator claim.
- `battle-round1-complete.test.ts` - pins the ABSENCE of task-coupled round completion: the task-terminality gate is gone and recording a side terminal consults no task (§2a).
- `battle-orchestrator.test.ts` - pairs both completions, fires round 2 once.
- `async-processor-battle.test.ts` - prompt assembly, `NO_REBUTTAL`, long-form.
- `experiment-manager.battle.test.ts` - slot/variant resolution, validation.
- `battle-clarification.test.ts` - `NEED_CLARIFICATION` routing and suppression.
- `battle-task.test.ts`, `battle-task-delivery.test.ts` - `TASK_*` battles.
- `battle-vision-plan.test.ts`, `vision-battle-action.test.ts`, `battle-generation-out-plan.test.ts`, `battle-attachment.test.ts` - image modes.
- `battle-outcome.test.ts`, `battle-outcome-api.test.ts`, `analytics-metadata.battle.test.ts` - outcome record and analytics metadata.
- `channel-battle.test.ts` - the enable/disable/get-config API handler.
- `battle-alt-slot-handler.test.ts` - the alt-slot Lex handler: identity resolved from the battle state's single waiting alt side, the router handoff, and silence on ambiguity.

Frontend unit tests (`frontend/packages/`):
- `chat/src/utils/battleTally.test.ts` - `computeBattleTally` aggregation.
- `chat/src/services/channelBattleService.test.ts`, `battleOutcomeService.test.ts` - client calls.
- `admin/src/components/admin/EffectivenessTab.test.tsx` - the per-step admin view (the turn-timeline drill that surfaces `execution_steps`).

End-to-end (`tests/e2e/battle.spec.ts`): the behavioral cases run under `BATTLE_E2E=1` against a battle-enabled deploy (never in the default unit suite) - round-1 chip survival + a working scorecard pick, the round-2 divider, multi-turn duels, server-side outcome persistence, the not-enabled hint, `/battle` start-of-message detection, generation-out (both variants render a decoded image, honest text otherwise), and clarification (an ambiguous `/battle` is answered normally by both sides, with no waiting queue on the composer - because the round-1 prompt no longer asks a model to raise a question, not because the routing was removed). The answer-then-resume round trip IS asserted, by B-E7, against a task-shaped duel: a side parked on the user (`reason: 'task-step'`) is answered by a non-owner and then by the owner, and both halves are asserted together. The pairing is load-bearing rather than thorough - a negative assertion ("the stranger did not resume it") is worth nothing without the positive control beside it ("the owner did"), because a continuation broken for everyone satisfies the negative half perfectly. Both were red at once, for one cause, and only the pair showed it.

## 8. Open Technical Questions

- ~~Battle-aware task creation~~ **DONE.** A side resolving to `TASK_MULTI_STEP` now creates its task
  through `createBattleTask`, assigned to that bot and carrying the battle id, and never continues an
  existing task (each side runs its own chain).

- **Decoupling battle state from task state (owner, 2026-08-09).** See §2a. The ordering problem that
  was recorded here - the battle row's `taskId` versus when `initBotState` must be written - was a
  symptom of the fusion, not a problem to solve. Under the separation the row never carries a task id
  and the question disappears.
- **Per-side abuse-gate charging (owner, 2026-08-09).** Settled as a single charge per duel. See
  "How a duel is metered" and §5a decision 2.
- **Extending `flow-does-not-run-the-turn.test.ts` to `battle-orchestrator.ts`.** The guard measures
  the channel flow only, so the orchestrator's duplicate turn logic is unmeasured. Extending it before
  the handoff lands would make the suite red by design; extending it as part of the handoff keeps the
  ratchet honest.

- `steps[].tokensIn` accounting for vision-in image tokens, and binding a specific attachment to a `/battle` turn when a channel holds several.
- The exact `MODEL_RATE_TABLE` values and image-gen cost granularity (approximate and deployer-tunable by design).
- The generation-out model choice (Titan Image Generator vs Nova Canvas) and the precise default image-output guardrail config to ship.
- Whether Aurora should add a generated column / index for `assignmentMode` or `battle_id` if rollup performance degrades (currently rides the JSON metadata column, no migration).
