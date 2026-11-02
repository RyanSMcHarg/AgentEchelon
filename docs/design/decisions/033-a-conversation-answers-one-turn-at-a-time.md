---
title: "ADR-033: A conversation answers one turn at a time, and says so when it cannot"
status: Accepted 2026-08-23. Five tenets, the per-entry contract, triage into tasks with a pause for direction, the client behavior, the admin metrics, cancellation, and what all of it does to latency. Built end to end and inert by default behind TURN_QUEUE_ENABLED; /stop suppression is live independently of that switch. Triage runs on message arrival (`lib/triage-on-arrival.ts`).
date: 2026-08-22
related:
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./023-battle-round-coordination.md"
  - "./024-task-ownership.md"
  - "./029-clarification-is-public-and-answers-get-their-own-placeholder.md"
  - "./032-where-a-rule-runs.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../guides/developer/LATENCY-TARGETS.md"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/lib/abuse-controls.ts"
  - "../../../backend/lambda/src/lib/battle-state.ts"
  - "../../../backend/lambda/src/lib/bot-coordination.ts"
  - "../../../backend/lambda/src/lib/interaction-kinds.ts"
tracking: |
  Proposed. The single-active-battle guard is the one entry point where this is built, and it is built
  the way this ADR argues for: a conversation-level fact, a soft lock that falls through when the work
  behind it is provably over, and an explained no-op to the sender. Tasks have a partial guard with a
  known sub-turn window. Ordinary exchanges, @all and the direct-invoke entries have nothing.

  Built. The lock store and its table sit behind TURN_QUEUE_ENABLED (default OFF, off everywhere);
  triage into tasks, the pause, task visibility, the client affordance and the admin metrics all
  exist. What remains is the TRIGGER: triage runs when a turn ends rather than when a message
  arrives, which makes the in-flight question retrospective. Moving it is gated on the lock question
  in DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING section 9.

  Three earlier drafts were wrong and are corrected in place, because the reasoning that produced
  them is the reusable part: releasing the lock and draining the queue atomically; answering the
  whole queue in one turn; and /stop clearing the queue, which discards the person OWN unanswered
  requests.
---

# ADR-033: A conversation answers one turn at a time, and says so when it cannot

## Status

**Accepted (2026-08-23).** Proposed 2026-08-22. Built, and the queue is inert by default. One entry point already implements the shape end to end:

| Entry | State today |
|---|---|
| `/battle` while a duel runs | **BUILT.** Conversation-level pointer, soft lock, explained no-op. `channel-flow-processor.ts` step 3 |
| A task message while that task is mid-turn | **PARTIAL.** The guard reads the task's RECORDED state, so two messages seconds apart can both pass |
| An ordinary message while a turn is in flight | **NOTHING.** Two turns run, both answer |
| `@all` while a turn is in flight | **NOTHING** |
| A direct invoke (rebuttal, handover, repair) | **NOTHING**, and it should stay that way. See the per-entry table |
| Assistant to assistant | **BOUNDED ALREADY**, by a different mechanism, and deliberately not a queue |

| Piece of this ADR | State |
|---|---|
| The lock store, its table, IAM, kill switch | **BUILT + DEPLOYED**: `lib/turn-lock.ts`. `TURN_QUEUE_ENABLED` defaults off and a deployment turns it on with `turnQueue` in `deploy.config.json`; the dev deployment runs with it on |
| The claim, in the router | **BUILT + DEPLOYED**, inert while the switch is off |
| Triage into tasks, prioritisation, the pause for direction | **BUILT**, and it now runs on message ARRIVAL (`lib/triage-on-arrival.ts`) rather than at turn completion, so the in-flight question is asked about work that is genuinely still in flight |
| A task `priority` field | **BUILT** |
| Follow-ups rolled into the answer before it is sent: history bounded at the turn's message, follow-ups kept across reading passes, an answer parked until the reading resumes it | **BUILT + DEPLOYED** to dev on 2026-10-27, where `turnQueue` is on; **NOT VERIFIED** on a deployment. See "Follow-ups are rolled into the answer before it is sent" |
| Task VISIBILITY (a targeted request makes a private task) | **BUILT + DEPLOYED**, and the conversation read passes a viewer so a person still sees their own |
| `/stop` reaching the turn already running | **BUILT + DEPLOYED**, and live independently of the queue switch |
| A canceled turn as its own ledger phase | **BUILT** |
| An operator seeing and stopping a stalled task | **BUILT**: `admin-tasks.ts`, gated on the `tasks-read` and `tasks-manage` capabilities |
| Task access behind one boundary | **BUILT**: the task service role is the ONLY holder of the tables; every turn-path caller goes through the seam |
| The admin METRICS, including lock takeovers and its alarm | **BUILT**: `lib/turn-queue-metrics.ts`, with the stranded-lock alarm watching `LockTakeover` |
| The admin console SURFACE that renders them | **BUILT + DEPLOYED**: `QueueHealth.tsx`, beside the interaction breakdown rather than in the headline cards. Read from CloudWatch by a non-VPC function, because the analytics Lambda cannot reach it |
| The client affordance | **BUILT**, deploy pending. One notice updated in place and settled on drain, queued styling read from the record via `GET /turn-state`, and the client SUBSCRIBES to the notice changing rather than polling |

## Problem, and who has it

A person sends a message, sees no reply yet, and sends another. Or they change their mind mid-answer. Or they answer a question the assistant asked while it is still working on the step before it.

What happens next depends on which entry point they happened to use, and in most of them it is not what anyone would expect. Two assistants answer, sometimes interleaved, sometimes contradicting each other. A delivered report is regenerated because the person asked whether it was finished. Nothing reports an error, because from each turn's own point of view nothing went wrong.

The cost lands on the person: a doubled answer is confusing, a regenerated document wastes their time, and a contradicting pair leaves them unsure which reply to believe. It costs the operator too, since every duplicate turn is a model call nobody wanted.

**Interrupting is legitimate.** This is not about suppressing a person who speaks twice. It is about having ONE expected behavior when they do, and being able to say which.

## Decision

### Tenet 1 - Busy is a fact about the conversation, claimed where a turn is COMMITTED

A turn in flight is a property of the conversation, so the record of it belongs at conversation scope.

**It is claimed in the router, not in the channel flow, and the first draft of this ADR had that wrong.** The flow was the obvious home because it sees every message before delivery and holds the only stable message identity (ADR-022). But seeing a message is not knowing a turn will run: in a group channel an unmentioned message passes through the flow and produces no turn at all, so claiming there would lock conversations on messages nobody was ever going to answer. The claim belongs at the first point past the addressing rules and past the duplicate-fulfilment gate, which is where the assistant is committed to answering. That point is in the router.

Per-message dedup is a different question and already answered. `claimCorrelation` deduplicates a redelivery of the SAME message; it cannot answer "is this conversation already answering something else", because two different messages carry two different correlation ids.

### Tenet 2 - The release is a recorded fact, never a clock

A claim released by timeout has two failure modes and both are worse than the problem. Too short and the lock expires under a legitimately slow turn, so the interrupt starts a second turn anyway. Too long and a turn that dies leaves the conversation unanswerable for the length of the timeout. **A stranded lock is worse than a duplicate answer**, because a duplicate answer is recoverable by the person and an unanswerable conversation is not.

So a lock is released by something that HAPPENED: the turn ended, or the platform reported that the invocation running it did not.

The turn ending covers almost everything. `releaseLock` runs in a `finally`, so it reaches the answer posted, every early return, and every error the processor catches. The one ending it cannot reach is the platform killing the invocation on timeout or out of memory, because no code in that process runs afterwards.

That ending is an event too. The processor is invoked asynchronously, and an asynchronous invocation that fails emits a failure record carrying the payload that started it, which names the channel, the bot and the correlation - the whole lock. `turn-lock-release-on-failure` is wired as the processor's `onFailure` destination and releases exactly that lock, conditional on the correlation still holding it.

**A correction, because the first version of this decision was wrong in a way worth recording.** It said a later turn could observe that the holder's correlation "was already fulfilled" by reading `readPlaceholderMapping`. That record does not mean fulfilment: it is written by the channel flow when the PLACEHOLDER appears, seconds into the turn, which is how the processor later finds the placeholder to write the answer over. So it existed for every RUNNING turn. Every later message judged the live holder dead, displaced it, and started a second turn - no message was ever queued and no deferral notice was ever posted, while the unit tests passed by mocking that read to null for the still-running case. Nothing in the claim path judges holder liveness any more: a holder means BUSY.

A TTL may exist underneath as garbage collection, and it must be long enough that it never arbitrates a live decision. The moment a TTL frees a conversation, this is a clock wearing a different name.

### Tenet 3 - A soft lock, so a stale record cannot silence a conversation

The lock is advisory: it names work that should still be running, and the check confirms the work is still running before honoring it. The battle guard already does this, and its comment says why. A lock with nothing behind it is stale, and stale loses.

**It fails OPEN, in the same direction as every other claim in `abuse-controls.ts`.** An unreadable or unwritable lock means "not busy". Failing closed would let a table hiccup silence a conversation, which is the stranded-lock failure arriving by a second route that tenets 2 and 3 would not otherwise catch. A duplicate answer during an outage is recoverable by the person; silence is not.

### Tenet 4 - Refusing or deferring is a reply, not silence

When a message is not acted on immediately the person is told, on the shape the duel refusal already uses: a reply to the SENDER, broadcasting nothing, saying what is happening and what they can do. A dropped message is indistinguishable from a broken system.

### Tenet 5 - Resolve WHO answers before asking whether they are busy

Busy is a property of a RESPONDER within a conversation, not of the conversation alone. Two people mentioning two different assistants should both get answers; blocking the second because the first is mid-turn would be inventing a queue nobody asked for.

So the lock is keyed on the conversation AND the resolved responder, with one deliberate exception: `/battle` locks the CONVERSATION, because a duel occupies the whole conversation rather than one assistant. That is why the existing guard is channel-scoped, and it stays that way.

**This is the second reason the claim sits in the router.** The responder is only known once the addressing and task-ownership rules have run, and both live there (ADR-030). A check upstream of them would have to guess whose lock it was taking.

**A queued message is re-resolved at triage, which is what makes the handover exemption safe.** The queue holds ids, not routing decisions, so a message queued against the assistant it was addressed to is routed normally when it is finally read - including being handed to whichever assistant owns the work it answers. Queueing never freezes a routing decision that later turns out to be wrong.

## Per entry point

The entries do not want the same answer, and forcing one on all of them is how this stays wrong.

| Entry | While the conversation is busy | Why |
|---|---|---|
| **Ordinary exchange** | **Queue** | Nothing is at stake but ordering. A person adding "and also..." expects both addressed |
| **Task, mid-step** | **Queue, as context for the running step** | The step is the unit of work, and a second message about a task in flight is nearly always more input for the same step. This is what "do not start multiple threads on the same topic" asks for |
| **Task, awaiting the person** | **Answer it. Not an interrupt** | The task is blocked ON them; their message is the awaited input |
| **`@all`** | **Queue as ONE turn, not one per assistant** | `@all` produces exactly one responder at any channel size, but WHICH ENTRY answers depends on size: above 1:1 the flow bypass answers and Lex is never invoked; at 1:1 the bypass stands down and Lex answers, because AUTO routes every message in a 1:1 regardless of mentions. A check placed only in the bypass therefore misses every 1:1 `@all`. Both sides already read `lib/channel-size.ts` to stay exact complements, and the check must do the same |
| **`/battle`, mid-duel** | **Refuse, explained** | A duel compares one question; a second question is a different comparison. Already built |
| **Duel, awaiting the person** | **Answer it, from the initiator only** | ADR-029: a clarifying question is a designed interrupt point, and only the person who started it may answer |
| **Direct invoke** (rebuttal, handover, repair) | **Proceed. Never queue** | These are the system completing work it already owes. Queueing a rebuttal behind a person's new message would strand a duel; queueing a handover or a repair would re-strand the message those paths exist to rescue |
| **Assistant to assistant** | **Out of scope, and must stay out** | Already bounded by `bot-coordination.ts`: a closed set of `nudge` and `ack`, default-deny on an unmarked bot-to-bot message. That guard bounds a handshake by refusing a third kind. A queue here would be the third kind, and turn a bounded handshake into a protocol |

**The two "awaiting the person" rows are the point of the table.** Both surfaces already have a state meaning the assistant is blocked on the person, and in that state their message is not an interruption at all. A busy check that cannot see the difference would break the two flows most dependent on someone replying, and would invert the reported task failure rather than fix it.

**The direct-invoke row is the one most easily got wrong.** Those entries carry no user message of their own and exist precisely because something was owed. A lock that stops them is a lock that strands work.
## What happens to the queue: triage, then ask

The queue is a HOLDING PEN, not a work list. What comes out of it is tasks, and what happens next is a question to the person rather than an execution.

    message arrives while busy  ->  queued        (transient: ids only, cleared at triage)
    the running turn ends       ->  TRIAGE        (each queued message becomes, or amends, a task)
    tasks are prioritized       ->  PROPOSE       (the assistant says what it understood, and asks)
    the person directs          ->  execute       (one task at a time, in the agreed order)

### Why the queue is not simply answered

An earlier draft of this ADR said the queue is read whole and answered in one turn, and defended it with "later messages change what the earlier ones meant" - "draft the report", then "actually make it about Q3". That argument is sound, and it proves the case for exactly ONE of the two things a queue holds:

| What queued | What it is | What it wants |
|---|---|---|
| "Make it one page, not three" | An amendment to work already in progress | To change the running task, not to start one |
| "Also, what was Q3 headcount?" | A new request that happens to have arrived now | Its own task, its own turn |

Concatenating both into one prompt serves neither: the amendment gets buried in a compound request, and the new question gets answered inside a report revision. **They cannot all be addressed at once**, and a design that tries is a faster way to produce the confusion this ADR exists to remove.

### Triage produces tasks, because tasks are what this platform already has

A queued message becomes either an amendment to an existing task or a new task (`task-tracking.ts`, ADR-024). This is deliberately not a second work-list living beside the first:

- **A task is durable.** The queue record can be lost without losing the work, which retires the "queued messages are not durable" caveat an earlier draft accepted - the durable thing is the task, not the holding pen.
- **A task is already visible.** Open work items surface to the person today; queued work should not need a second, parallel surface to be seen.
- **A task already has an owner** and a state machine, so "who acts next" and "what state is this in" are answered rather than reinvented.

**What tasks do NOT have today is a priority**, and this design needs one. Ordering by `createdAt` or `dueBy` would be INFERRING priority from arrival or deadline, which are different things: the most recently sent message is often the most important, and often not. A recorded field is the honest version, and it is a schema addition this design owes rather than a detail it can assume.

**One task per new request, and none for an amendment.** An amendment changes work that already exists, so giving it a task of its own splits one piece of work in two and leaves somebody closing a task that was never separate. The exception is the case that reads identically and is not: an amendment with NOTHING in flight to amend is new work, and dropping it because of its label would lose a message the person sent.

**The tasks are created before the proposal is posted, not after it is answered.** The work exists as open items the moment the person is shown it. A proposal describing work not yet recorded anywhere would be lost entirely if the turn died between posting and being answered, and the person would have been told their messages landed.

Creating them executes nothing. They start in a state that awaits the requester, so what exists is a list of things the person must direct - which is the pause, expressed in the mechanism below rather than as a confirm step built beside it.

**A lost row is not survivable here, and task creation must say so.** Creating a task fails open today: a failed write is logged and swallowed. That is right when the task ACCOMPANIES an answer already delivered, where throwing would fail a turn that succeeded. Under triage the relation inverts - the task IS the answer, and the proposal describes work that exists nowhere else - so the same swallow leaves the person told their messages landed when nothing holds them. Which of the two a call is cannot be decided inside the writer, so the caller declares it, and the default stays exactly what every existing caller already relies on.

### Where the tasks live, and who can see them

**Visibility is already decided, and triage inherits it.** ADR-024: a task is visible to its conversation's current members whatever its owner, through the conversation-keyed index. That covers tasks owned by ASSISTANTS as well as by people, which matters here because triage creates both - a task the assistant will do is as visible as one the person owes.

**A TARGETED request must produce a PRIVATE task, and that has to ship with this rather than after it.** Targeting means the other members cannot see the message. Triaging it into a conversation-visible task tells them it happened.

**What is already safe, and what is not.** `getOpenTasksForConversation` is built field by field precisely so it cannot carry message text - its comment says the one thing this read must never carry is content, and a spread-then-delete would leak every future field by default. So the EXCERPT does not travel. What does travel is the task's existence, type, owner, state and timing, and the line between those was drawn once, drawn too far, and redrawn on evidence:

**Existence is visible; details are not (maintainer decision, 2026-08-23, revising the first version of this section).** The first cut hid a private task's row outright, on the argument that "Alice has a report in progress" is itself a disclosure. Built, that produced two defects worse than the one it prevented: the assistant a private task occupies looked IDLE to every other member, who then read its silence as a broken assistant rather than a busy one - and the requester's own `/stop`, which finds work through this same read, was told there was nothing in progress while their task kept running. An escape hatch that cannot see the work it exists to stop is not private, it is broken.

So the row is returned to every member, with every describing field (`taskType`, `taskState`, `dueBy`) stripped AT READ TIME and `private: true` in their place. The room learns that private work exists and which assistant it occupies - which the lock's own busy signal already implied - and nothing of what it is. The requester and the owning assistant still see the full row. The stripping happens in the store, never in a caller, for the same reason the projection is built field by field: a rule enforced at one read cannot be forgotten at the next call site.

**Why now and not later.** Today a task from a targeted message is an occasional edge. Under this ADR triage creates tasks from queued messages as a matter of course, so the edge becomes the normal path. Shipping the queue first and privacy second would mean shipping the disclosure first.

**The rule: a task inherits the visibility of the request that created it.** Untargeted request, conversation-visible task. Targeted request, private task - readable by the requester and by the assistant that owns it, and absent from every other member's conversation read.

**Absent reads as private (owner, 2026-09-15).** A task with no visibility recorded reads as private: the room sees that it exists, and only its owner, its requester and its assigned assistant read what it is. A task can be written before its targeting is known, so absence can mean "nobody found out", and reading that as conversation-visible publishes a targeted request's existence and label. Every reader applies one rule (`backend/lambda/src/lib/task-visibility.ts`), and every writer that means a task to be shared records `conversation` explicitly.

**What that does to rows already in the table, since the default flipped.** The absent-visibility reading was conversation-visible before this and is private after it, and `createTask` writes the field only when the caller supplied one (`backend/lambda/src/lib/task-tracking.ts`), so every task written before this rule carries no visibility and becomes existence-only to other members on the first deploy that carries it: the row still appears in their conversation read, with `taskType`, `taskState` and `dueBy` stripped and `private: true` in their place. **No backfill is planned and none exists.** A backfill would have to guess the targeting of a request nobody recorded, and guessing `conversation` is the guess that publishes a private request's label while guessing `private` costs a member a description of work they can still see exists and can still ask about. The asymmetry is the same one that decided the default, so applying the default to the existing rows is the consistent answer rather than a separate decision.

**The proposal inherits it too.** The section below makes the proposal public because it creates work others will see - which is only true when the work IS visible to them. A proposal covering a targeted request is targeted, and **a queue mixing targeted and untargeted messages produces a targeted proposal**: under-disclosing costs someone a notification they might have liked, and over-disclosing publishes a private request. Those are not symmetric.

**A task belongs to the PARENT conversation, not to the room it was asked in.** Looking ahead to meetings: a meeting is a child of a conversation, and work agreed in it belongs to the conversation that owns the work, not to the room that happened to be open when it was agreed. The alternative strands a task in a room nobody returns to.

That creates an asymmetry this ADR has to face directly, because it is the sort of thing that reads as a bug:

| | Where it lives |
|---|---|
| The lock and the queue | The conversation the message ARRIVED in (the meeting) |
| The proposal | Posted where the person is (the meeting) |
| The tasks it creates | The PARENT conversation |

So a person confirms a proposal in one room and the work appears in another. **The proposal must say so.** A task that silently relocates is indistinguishable from one that was lost, and the person who agreed to it is the last one who should have to go looking.

The lock stays keyed on the arriving conversation regardless: it exists to stop two turns answering in the same room, and the room is where that collision happens. Keying it on the parent would let one meeting block another.

**The proposal is PUBLIC when the work it creates is, and targeted when it is not.** Tenet 4's deferral notice is always targeted at the sender: it is about their message waiting, which is nobody else's business. The proposal is different because it creates work others will see in their task list, and posting THAT privately would have members watching tasks appear with no account of where they came from - the concealment ADR-029 reversed for clarifications. But that argument only holds while the work is visible to them. A proposal covering a targeted request is targeted, because there is no shared work to account for.

### Triage is a MODEL turn, and that is a cost worth naming

Deciding whether "make it one page" amends the running work or starts new work is a judgment about meaning. No rule over the message text gets it right: the same words amend a report and open a task depending on what was already happening. So triage runs as an ordinary turn with a model, reusing the whole existing path rather than inventing a second one that would need its own prompt assembly, guardrails and delivery.

**What it costs.** One model call per queue, on the busy path only. A conversation nobody interrupts never pays it, and a conversation that is interrupted was already spending a turn. It is not free and it is not on the critical path of an ordinary reply.

**What it must not do is guess when it cannot read.** A triage turn whose model call fails, or whose reply does not account for every queued message, leaves the queue exactly where it is. The messages are then triaged by the next notice, which is late; the alternative is inventing a classification for messages nobody understood, which is wrong. Late is recoverable and wrong is not.

**It runs when the message ARRIVES, not when the turn ends, and it does not claim the lock.** Triage first ran in the processor's `finally`, so it began only once the turn ended and asked whether the work in flight was still wanted about a report that had already finished. An interrupt evaluated after the work completes is not an interrupt.

Moving it looked blocked by tenet 2, and the block dissolved once two questions were separated. The turn lock answers "who may ANSWER", and the turn being triaged behind is still running and still holds it, correctly. Triage answers nothing, so what it needs is exclusion only from ITSELF, so that two notices arriving together do not create the same work twice. That second claim may expire on a timer and safely, because a stranded one silences nothing: answering is unaffected, the queue keeps its messages, and the next notice triages them. **The lock that must never be timed out is not the lock triage needed.**

**And the turn is offered no tools.** Its job is to produce a reading and hand it back. A prompt saying "do not answer any of them yet" is the weakest possible way to say that while the model holds tools that advance a task, fetch context or generate a document, and through the tool surface the execution would arrive *before* the reply exists, where no amount of parsing the reply catches it. The constraint is structural: a triage turn's tool surface is empty and its task loop does not run.

### The pause is the point

**After triage, the assistant stops and asks for direction. It does not execute the queue.**

This is the difference between a system that manages a person's requests and one that guesses at them. Triage produces a reading of what arrived - these amend that, this is new, here is the order I would take them in - and a reading is a proposal. Executing it silently means the first time the person learns how their messages were interpreted is when the wrong work is already done.

So the assistant posts what it understood and waits. The person confirms, reorders, drops something, or corrects the reading.

**THE AMBIGUITY THAT MOST NEEDS ASKING ABOUT IS WHETHER THE WORK IN FLIGHT IS STILL WANTED.** A person who says "make it one page" while a three-page report is being drafted has amended it. A person who says "actually, what was Q3 headcount?" may have amended nothing and may have abandoned the report entirely - and there is no way to tell from the message which they meant. Guessing has two failure modes and both waste their time: finish a report nobody wants, or discard one they were waiting for.

So the proposal names the in-progress task explicitly and asks whether to finish it, and that question is asked whenever the reading is ambiguous rather than only when the person says something obviously contradictory.

### Waiting for that answer is not an interrupt

The pause is a task awaiting the person, which is a state this platform already has and already handles correctly: while a task awaits them, their message is the awaited input rather than an interruption, and the busy check must not treat it as one. The per-entry table above already says this for both surfaces that have such a state, and the pause created here is the same state arriving by a new route. A message whose intent opens a different kind of task is not the awaited input: it opens its own task, and the waiting task stays where it was (`opensOtherWorkThan`, `backend/lambda/src/lib/task-continuity.ts`). A message that names the waiting item, an answer to one of the platform's own machines, and a duel side's exchange remain the awaited input.

**Which is why the pause needs no mechanism of its own.** A triaged request runs on a state machine whose INITIAL state awaits the requester:

| State | Means | Goes to |
|---|---|---|
| `proposed` | Read from the queue, described to the person, awaiting their direction | `accepted`, `dropped` |
| `accepted` | They want it. It runs like any other work | `completed`, `dropped` |
| `completed` | Done | terminal, success |
| `dropped` | They did not want it, or changed their mind later | terminal, handoff |

`dropped` is a terminal state and not a failure, for the same reason a canceled turn is neither a success nor a failure below: a person deciding they do not want something is the system working. And because the initial state awaits them, the task lands in their queue at creation rather than after a transition - which is the specific bug ADR-024 records, where a chain born blocked on somebody appeared in nobody's queue.

**Answering may close a task immediately, and that is an ordinary outcome.** "Drop the second one" is a `proposed` → `dropped` transition, not a special case: the task existed, it was described, and it was directed. Nothing about it needed to wait for confirmation before being recorded.

It is released by their answer, not by a clock. A pause that times out and picks for them is the same guess this section exists to avoid, taken later and with less information.

### Then one task at a time, until the queue is clear

With direction given, the tasks run in the agreed order, one at a time, each taking the lock like any other turn. The loop ends when no task is ready to run - not when a timer expires and not when a batch is exhausted.

Anything that arrives DURING that loop queues behind the running task and is triaged the same way when it ends. The design does not have a special case for "a message that arrives while draining", because draining is just work, and work is what the lock already covers.

### The queue is bounded, and its bound is honest

A conversation holds a small, fixed number of queued messages. On overflow the OLDEST queued message is dropped and the person is told - not the newest, because the newest is their latest intent and the one most likely to supersede the rest.

The bound exists so a person hammering send cannot make one triage arbitrarily expensive. It is stated to them rather than applied silently, per tenet 4.

**Five, and it is a deployment setting rather than a constant.** Five is enough for a person adding detail to a request and small enough that the triage is still a readable proposal. It belongs with the other per-deployment values rather than in the code, for the same reason the latency bands are tunable: the right number depends on how a deployment's people actually write.

### Three lifetimes, and conflating any two is a bug

| | Held while | Released by |
|---|---|---|
| **The lock** | one turn is executing for this responder in this conversation | that turn finishing, or the platform reporting that the invocation running it died |
| **The queue** | messages have arrived and not yet been triaged | triage, which converts them into tasks |
| **A task** | the work exists and is not finished | reaching a terminal state, which is the product's own signal |

An earlier draft of this ADR released the lock and drained the queue as ONE atomic operation, arguing they were one fact. They are not, and the bug is concrete: freeing the lock at the moment a turn ends opens the conversation to a new message that can start running ALONGSIDE the work being dispatched from the drain - which is the exact concurrency the lock exists to prevent, arriving through the mechanism meant to prevent it.

So the lock covers the executing turn INCLUDING its triage and whatever it dispatches next. There is no instant at which the conversation is free and its own follow-up work is still in flight.

### Correction: the lock's lifetime is the DRAIN, not the turn (maintainer, 2026-08-28)

The table above says the lock is held while "one turn is executing" and released by "that turn finishing". That is wrong, and the implementation followed it rather than the design.

**The lock is held until the queued items are addressed, and it does not release between them.** A drain is not one turn. Reading the queue can produce a question - what exactly is being asked for, which of these first, how urgent - and the answer to that question is part of addressing the queue. The conversation stays held for that responder across the whole of it, including the wait for the person's reply. Releasing after the proposal is posted opens the conversation in the middle of a drain that is not finished, which is the concurrency this record exists to prevent, reached by a different route.

The corrected lifetimes:

| | Held while | Released by |
|---|---|---|
| **The lock** | a drain for this responder is unfinished: a turn is executing, OR its queue is not empty, OR it is waiting on an answer it asked for | the drain finishing: nothing queued and nothing outstanding |
| **The queue** | messages have arrived and not yet been triaged | triage, which converts them into tasks |
| **A task** | the work exists and is not finished | reaching a terminal state, which is the product's own signal |

`clarifying` is declared `awaits: { party: 'requester' }` in `QUEUE_DRAIN_MACHINE` precisely because the drain pauses there. That declaration is the contract, and the runtime honors it.

### Correction: waiting on a person is not holding the conversation (maintainer, 2026-08-31)

The correction above is right that a drain is not one turn. It is wrong that the LOCK is what carries the drain across the pause. That makes one mechanism mean two things, a turn is executing and a question is outstanding, and those have different lifetimes, different failure modes and different recoveries. Every stranding found in this area is that conflation.

What it costs, concretely. `awaitingPerson` is removed only when the offer is answered, the record has no expiry, and the takeover clause refuses any record carrying it. So a reply the parse does not recognize leaves the conversation held by a turn that finished, and every OTHER member's messages queue behind it permanently. Only the person who was asked can release it, and nothing tells them that.

Nothing is running during that wait. There is no contended resource, so there is nothing to exclude.

**Three states, and only one of them excludes anybody:**

| | Means | Blocks | Ends when |
|---|---|---|---|
| **Executing** | a turn is running for this responder in this conversation | everybody | the turn finishes, or the platform reports the invocation running it died |
| **Queued** | messages have arrived and have not been read | nobody | they are read, or they are emptied |
| **Awaiting** | this responder asked somebody something and has no answer yet | nobody | it is answered, withdrawn, or superseded |

The race the earlier correction was closing is real, and the claim closes it. A second drain is prevented by the triage CLAIM, which is already what makes one queue read once and already survives a notice updated in place. It is not prevented by the lock. Using the lock for it buys nothing the claim does not already provide, and costs the conversation.

So somebody else speaking during a pause is answered, and the question stays outstanding. That is what a person expects of anyone they are talking to, and it is what the previous correction gave up in order to close a race that was already closed.

### Correction: a drain IS a task, and declining the row cost us what tasks already solve (maintainer, 2026-09-03)

The drain has always been declared as a `TaskStateMachine` - `QUEUE_DRAIN_MACHINE`, validated by the same validator as every other machine in the codebase, with states, declared edges, an `awaits` on `clarifying`, and a terminal. DESIGN 2.6 reused that framework and deliberately declined the task ROW, on two grounds:

> It reuses the FRAMEWORK and not the task ROW. Tasks are work somebody owns, appear in their list, and outlive the turn; a drain is a phase of one turn, and giving each one a row would put an item in a person's open work every time an assistant read a queue.

**Both grounds have since stopped being true, and neither failed loudly.**

A drain is no longer a phase of one turn. The correction two sections above establishes that the lock's lifetime is the DRAIN rather than the turn, and the handover chain lets one drain span up to `TRIAGE_MAX_PASSES` turns. It already outlives a turn, which was the property the objection turned on.

And it would not appear in a person's open work. A drain is the ASSISTANT'S work; `getActiveTasksForUser` reads the owner's partition, so an assistant-owned drain lands in the assistant's. It reaches a person only when it hands over at `clarifying` - which is exactly the moment the proposal IS asking them something, and the moment they most need it in their list.

**What declining the row actually cost.** Every property the drain has been missing is one that tasks already have, and each was found separately, as its own defect:

| The drain needed | Tasks already have it |
|---|---|
| An owner, so state and responsibility cannot disagree | `assigneeId`/`assigneeType`, one writer, handed over at every `awaits` boundary |
| Supervision when it stops moving | `TASK_STALL_TURNS` and `recordNoTransitionTurn` |
| An operator who can see and stop one | The task service's read and stop path |
| Resolution timing separated from human think time | `v_task_resolution`, `resolve_ms` decomposed into `agent_ms` and the rest |
| A legal-move check that is not bespoke | The same declared-edge validation every machine gets |

The queue instead grew a parallel half of each: `queueStatus` on the turn record with its own conditional write, a stage vocabulary only it knows, and a bespoke latency view. That view's first definition reported a read instant EARLIER than the acknowledgement it followed - the kind of error a shared surface does not let you make.

**So the drain becomes a task**, of a declared type, owned by the assistant that is reading, handed to the requester at `clarifying` like any other awaiting step, and terminal at `settled`. Its timing is then task resolution, measured the way every other task is measured.

**What stays on the latency surface is the ACKNOWLEDGEMENT, and only that.** The notice is a real first response to somebody who is waiting, so it answers the same question `ttff_ms` answers and belongs beside it (migration 039). Everything after it is the drain's own resolution, and the queue needs no third measurement surface of its own - which is what `triaged_ms` was, and why it is withdrawn.

**One thing this does NOT change.** A queued message still becomes its own `queued_request` task when the reading turns it into work, and that task is separate from the drain that created it. The drain is the READING; the queued request is the work the reading found.


### The invariants, stated so that a fix can be checked against one

Written down because they were not. Every defect in this area presented as the same symptom, somebody waiting forever, with a different cause each time, and each cause was invisible from the outside. A goal in prose cannot tell you a fix is incomplete; these can.

- **A. A lock is held only while compute is running.** Not across a wait for a person, not across a queue that is merely non-empty, not after the turn that took it has ended. Held too long strands everybody; released too early admits the concurrency the lock exists to prevent, and both are failures of the same rule.
- **B. Every message that enters the queue leaves it.** Read, emptied, or dropped with the sender told. A queue that cannot empty for a reason nobody can see is the reported bug in its original form.
- **C. The assistant never claims something happened that did not.** A settled notice claims the queue was handled. A reply saying subjects were moved claims a split completed. Neither may be said on the strength of having ASKED for it.
- **D. Latency counts only turns a person actually waited for.** A machine-written notice, a placeholder, and a rewrite of either are not answers, and counting them reports a system faster than the one people use.
- **E. A failure is distinguishable from a refusal, in the logs and in the behavior.** A boundary that says no and a boundary that fell over must not produce the same evidence, because the first is correct and the second needs a person.

A finding that maps to one of these is fixed once, at the invariant, with a test that states the rule. A finding that maps to none of them is a new rule, and belongs here before it belongs in code.

### An arriving message checks the state and gets it moving

A held lock whose holder is gone must not make the conversation unanswerable. The recovery for that is NOT a clock and NOT the record's expiry. It is the next message.

When a message arrives and finds the lock held, it is appended to the queue as before, and then the state is CHECKED: if the drain is not actually progressing, the arriving turn takes it over and gets it moving. Appending and going quiet is what leaves somebody talking to a conversation that will never answer.

**"Not progressing" is a fact, not a guess, and the distinction is what an earlier takeover got wrong.** That version inferred liveness from `readPlaceholderMapping`, which the channel flow writes seconds into every healthy turn, so it fired on turns that were running normally. The bound that does hold is the holder's own function timeout: no invocation outlives the timeout configured on the Lambda executing it, so a `holderAt` older than that belongs to an invocation the platform is provably no longer running. That is a property of the platform, not an opinion about the holder.

A holder that is merely waiting on a PERSON is progressing, and is not taken over. The drain records what it is waiting for, so the two are distinguishable without inferring anything.

### There is no expiry on the record (maintainer, 2026-08-28)

The TTL is removed rather than scoped. A drain now spans the time a person takes to answer, so any expiry is a timer that can delete a queue somebody was told was waiting and leave them with nothing done and no explanation. Scoping it to "records holding no work" was considered and rejected: it keeps a deletion path on a record whose whole purpose is to hold work, and the failure it guards against has never been observed on this deployment.

The recovery it used to provide is now the arriving message, which is a better signal in every way that matters. It is caused by the person the failure is hurting, it is observed by code that is running, and it happens when they ask rather than up to two hours later. A takeover is counted as `LockTakeover`, which becomes the health signal this design is judged by.

This retires the reaper. Its entire job was to notice TTL deletions that no longer occur, so it and the stream that feeds it are inert and are removed. **The record holds ids, never content, and that is what keeps it out of the retention story.** A queued message lives in Amazon Chime SDK Messaging like every other message, and the archive already governs how long it is kept and how it is erased. Copying the text into a second store would create a parallel copy of a person's words with its own lifetime and its own erasure path, which is the shape this codebase already refuses for the drift signal (`drift_events` references a message by id and never stores the body). Content is read at triage, so a message edited while it waited is triaged as edited and one deleted while it waited simply disappears.

## What the person sees while their message is queued

Tenet 4 says a deferred message gets a reply. This section decides what that reply IS, and what happens to it afterwards.

### The problem the obvious version does not solve

Queued messages do not map one-to-one onto answers. Three queued messages may be answered by one reply, or by two, depending on whether they are one thought or several. So an affordance that tries to mark each queued message with the answer that addressed it has no correct behavior to implement: the mapping does not exist, and inventing one means claiming an attribution the platform cannot verify.

**Triage is what makes this tractable, and it moves the affordance off the answer entirely.** A queued message stops waiting when it has been TRIAGED - turned into a task, or folded into one - not when some reply happens to address it. That is a fact the platform records rather than an attribution it would have to infer, and it clears for the whole queue at once because triage reads the whole queue at once.

What the person sees afterwards is not "answered". It is the proposal: here is what I understood, here is the order, shall I finish the report first. The tasks that come out of it are visible as work items in their own right, which is a better account of where their message went than a styling change on the message could ever be.

#### Amendment (owner, 2026-09-15): the mapping exists where TRIAGE DECLARES it, and a queued message that was answered is tracked as a response

"Queued responses are still responses. They should be tracked as responses for all messages being answered in the queue but clearly labeled as messages that were in queue so they can be looked at separate from exchanges that are 1 to 1."

The two paragraphs above stay as written, because the objection they make is correct and is the reason this is built the way it is. What they refuse is an INFERRED mapping: reading off adjacency, or transcript ordering, which answer addressed which queued message. That inference has no correct behavior to implement and inventing one would claim an attribution the platform cannot verify.

**It does not bind a mapping the reading DECLARED.** Triage reads the whole queue at once and produces exactly one entry per queued message, labeled `amends`, `new` or `unclear` through a tool whose fields are enums over the ids of this queue - it never merges two messages into one item, and it cannot name a message that was not queued. What happens to each entry is then a recorded fact rather than a reading of the transcript:

| The reading said | What addresses that message | Where it is measured |
|---|---|---|
| `amends`, and the work is still in flight | the running answer, which folds it in before it is sent | an exchange against that answer, labeled queued |
| `new` | its own `queued_request` task, created in `proposed` awaiting the requester | task resolution, which is the handoff this ADR already rules on |
| `unclear` | its own `queued_clarification` task, asking what it would need to know | task resolution, the same way |

So the affordance this section refused is still refused. What is built instead is on the fold, where the mapping becomes true: `dispatchAmendedTurn` names the ids it is rolling in, the answering turn stamps them, and archival mints one exchange per id against that answer. **Where one reply addresses three queued messages, all three get a row pointing at that reply, because the reading said so.** A queued message that became a task gets no such row - it is on the task surface, and two surfaces answering one question is what "Triage MOVES the work onto a different measurement surface" exists to prevent.

**The label is the half the owner's direction turns on.** A queued exchange's `response_latency_ms` includes a wait the platform chose to impose, so averaged beside a 1:1 turn it reports a deliberate decision as a regression - the failure the latency section below is written against. `exchanges.queued_as` carries the label, `v_queued_exchange` publishes that population beside the `ack_ms` it already had from `v_queue_acknowledgement`, and `v_turn_latency` skips a labeled exchange when it anchors a turn, so a folded answer is never measured from a message it was not answering. Migration 052; *verified by* `backend/test/analytics-aurora/a-queued-message-that-was-answered-is-a-response.test.ts`.

**What is still not claimed.** The affordance on the person's own message still says "waiting", not "answered", and still clears for the whole batch at triage. Nothing in the interface promises a per-message reply. This amendment changes what the ANALYTICS record, which is a different audience with a different tolerance for a row that says "this message was answered by that one".

### The shape: the queue is a STORE, the stream carries a notification

The state lives in a per-conversation record, and the message stream only says it changed.

| Concern | Where it lives |
|---|---|
| Which messages are queued, in what order | The conversation's queue record, beside the lock |
| That the queue changed | A `CONTROL` message on the channel |
| How it looks | The client, applying styling to the messages it already renders |

**Why a store rather than a marker.** The first draft of this put the queued message ids in a marker on an assistant message and had the client derive membership from transcript ordering. That fails in the ordinary cases: a client that reloads with partial history, one that joined the conversation late, or one whose window does not reach back to the message that triggered the deferral. Ordering is not a reliable encoding of set membership, and a marker that carries the ids instead grows with the queue and must be rewritten on every send.

A record answers all of it directly, is authoritative, and cannot be forged. It also sits naturally beside the lock itself, which tenets 1 and 2 already require: one record per conversation holding the claim and the queue is ONE write, not two.

**Why `CONTROL` for the notification.** It carries the fact that the queue changed, not the queue. Its payload is a state token - a version or a count - so a very small content limit is ample; the ids are read from the store. A client that sees a version it does not have re-reads.

**The exact limit is TO CONFIRM before building.** `CONTROL` content is understood to be capped at around 30 bytes, and nothing in this codebase sends one, so the number is not verifiable here. The design does not depend on the value, only on it being small enough that ids could never fit - which is what pushes the queue into a store rather than onto the message. Confirm it against the service limits at implementation time; if it turns out to be generous, the store is still the right home for the reasons above.

`CONTROL` is not a synonym for invisible: the message is delivered to clients and the SPA decides how to render it, so the visible affordance and the machine signal can be the same event.

**The deferral notice is still a real, visible message.** Tenet 4 is about the person being told, and a notification the client may or may not surface does not satisfy it. So the assistant posts an ordinary STANDARD message saying what it is working on and that the waiting messages are next.

**ONE notice, updated - never one per message.** It is updated on each further queued send, carrying the current count, and again to its settled wording when the queue drains. Posting a second notice for a second message would be the same doubling this ADR exists to prevent, wearing different clothes; and updating rather than repeating is also what gives each queued message its own acknowledgement instant, which the latency section below depends on.

**The notice lives in the running answer's placeholder, and the answer moves to the end (owner, 2026-09-14).** The first message to queue behind a running answer lands right after that answer's placeholder, so the placeholder is where the person looks for what is happening. The first notice is written into it (`findHolderPlaceholder`, `showQueueNotice`), and every later queued send updates it there. When the answer is ready it reads its placeholder, finds it has become the notice, and posts the answer as a new message, which falls after every follow-up it addresses. A notice is posted as a message of its own only when there is no public placeholder to hold it: the running turn answers a private request (the notice is room-visible), its placeholder is not yet resolvable, or the holder is a reading with no placeholder.

It is never DELETED. A delete emits a delete event into the conversation archive, which is a moderation-shaped fact about a message nobody moderated, and it erases the record that the person waited.

### Marking the person's own message: whose record is whose

The affordance the person actually wants is on THEIR message, and this is where the ADR-029 pattern stops applying rather than extending cleanly:

| | ADR-029 (`battlewaiting`) | Here |
|---|---|---|
| State written to | the assistant's own message | a store |
| Affordance renders on | that same message | the PERSON's messages |

**The system never writes to a person's message, and four separate things say so.** Every `UpdateChannelMessage` in the backend passes `ChimeBearer: botArn` on a message the bot itself sent; there is no precedent for anything else. A marker in a person's content is forgeable, since they can type it, and `message-markers.ts` strips every `<!--...-->` comment from content for exactly that reason. Writing to another member's message needs moderator rights, which would spend a moderation capability on a presentation hint. And it would emit an update into the archive, editing the record of what the person said with an edit they did not make.

So the styling is applied CLIENT-SIDE to messages the client already holds, from state it reads from the store. Nothing is written to the person's message at any point.

### The affordance says "waiting", not "answered"

The cleared state means **these have been triaged**, not that each message received its own reply. Wording that promises the second would be a claim the platform cannot check, and the person would find the one case where it was wrong. What they get instead of that promise is the proposal, which says what became a task and in what order - a better account than a styling change could carry.

### It must not be able to strand either

The stranded lock has an exact analogue here: a queue record that never clears, leaving messages styled as queued forever in a conversation that has moved on. It is the same failure wearing a UI, and it is more visible than the lock because the person stares at it.

So the queue clears on the recorded fact of TRIAGE, and the lock on the recorded fact of the turn finishing - never on a timer. Because the lock and the queue are one record, they cannot disagree: there is no state where the conversation is free and the person's messages still read as waiting.

A client is the second line rather than the first. It reads the record, so it recovers on reload without having to reconstruct anything from the transcript, and a client holding a queued state for a conversation it can see is not busy treats it as ended rather than rendering it indefinitely.

### What the client does

**The composer stays enabled.** Disabling it while the assistant works is the obvious move and it is wrong: queueing exists so a person CAN keep typing, and a blocked composer turns a deferral into a refusal they cannot even attempt. It also removes the only way to send `/stop`.

**Their queued messages are styled as waiting**, from the state the client reads, and the styling is a property of the batch: it appears when the message joins the queue and clears for all of them at once when triage runs. The client never waits for a per-message signal, because there is not one.

**The client reads state, it does not reconstruct it.** On load, reconnect, or conversation switch it reads the conversation record and renders whatever it says. Nothing is derived from transcript ordering, which is what an earlier draft of this ADR got wrong: ordering fails for a client that reloaded with partial history, joined late, or has scrolled a window that does not reach the message that triggered the deferral.

**A client that disagrees with the record believes the record**, and a client holding a queued state for a conversation it can see is not busy treats it as ended. Between the two, the visible failure is a moment of stale styling rather than a message that appears lost.

**Other members see it too, for the messages they can see.** The state is per conversation, so a second person watching the room sees that messages are waiting rather than that the assistant has gone quiet - which is the reading that prompts them to send a duplicate of their own.

**A targeted message is not one of them.** They cannot see the message, so they must not see it queued: a waiting affordance on a message a member cannot read is the same disclosure the private-task rule exists to prevent, arriving through the UI instead of the task list. The queued state a client renders is therefore the intersection of what is queued and what that client can already see, which for the sender is everything and for everyone else is the untargeted messages only.

That leaves a case worth naming rather than hiding: a member can see the assistant is busy without being able to see what it is busy WITH. That is correct - it is what targeting means - and the copy should not pretend otherwise by implying they are missing something they could have seen.

### A room with more than one assistant

Busy is a property of a RESPONDER, so a room with several assistants has several queues, and three questions follow that a one-assistant room never asks.

**Which assistant is busy: the notice says so by being from them.** The deferral notice is posted by the assistant that could not take the turn, so its sender attribution answers the question without any copy having to name anybody. Nothing in the client claims "the conversation is busy" as a single fact, because that would be a claim it cannot honestly make.

**What is waiting: the union, never one of them.** A message is waiting if ANY assistant is holding it. The client reads every assistant in the room and unions the answers, which is one request per assistant on a state change rather than a poll. Reading only the first is indistinguishable from correct in every one-assistant conversation and silently wrong in exactly the rooms this matters for: a message queued behind the second assistant renders as though nothing were happening to it, which is the failure the notice exists to prevent, arriving through the transcript instead.

**Which assistant `/stop` stops: all of the ones this person started here.** The command carries no argument and its own reply says it canceled the work in this conversation, so it means "stop what I asked for here" rather than "stop one assistant". Naming one is a real want in a room with several and it needs a syntax nobody has chosen; until then the honest scope is every turn this person started.

**But not another person's.** The stop marker is keyed per conversation PER PERSON. A conversation-wide marker meant one member typing `/stop` suppressed the answer another was still waiting for - canceling their work with an escape hatch meant for one's own. The task cancellation beside it already took the requester and canceled only their tasks; the two halves of one command disagreed about scope, and the quieter half was the wrong one.

### Editing and canceling a queued message

The queue holds message IDS, and content is read at drain time. So a person who edits a queued message before it is read gets the edited version answered, which is what they would expect. A person who deletes one has it disappear from the batch. Neither needs special handling, and both follow from holding ids rather than copies.

**`/stop` does not touch the queue**, and the distinction is the whole of what the command means. It stops the work that is RUNNING. The queue holds something else: requests the person sent while they waited and never withdrew.

"Stop what you are doing" is not "forget the other things I asked you". Discarding those messages would be the same data loss the overflow drop is treated as, arriving through the one command a person uses to regain control - and it would punish them for having kept typing, which is the behavior queueing exists to permit.

Concretely: a report, then "also, what was Q3 headcount?", then `/stop`. They stopped the report, so the report task is cancelled. The headcount question is still a question, and it is triaged like any other. Work the assistant already FINISHED for them is kept: a stop reaches what is running, never what was delivered.

An earlier draft of this section said the opposite - that `/stop` clears the queue before triage - and it was implemented that way before the error was caught. It is recorded here because the reasoning that produced it is seductive: a stop feels like it should reach everything pending, and it is only wrong once you notice the queue holds the person's OWN unanswered requests rather than the assistant's work.

**Amendment, as built 2026-09-15: the rule above is enforced by what the selection SKIPS, not by where the stop is handled.** `selectStoppableTasks` picked work by requester and assistant, which caught the queue's own rows as well: the `queue_drain` the reading created, and every `queued_request`, `queued_clarification` and `queued_combination` waiting to be read. So the stop cleared the queue after all, through a selection rule rather than a queue-specific one, which is exactly how an error a section was written to prevent gets reintroduced. The selection now skips `queue_drain` in every state, and skips the three queued types while each is still in its own machine's initial state (`proposed` or `asked`). A queued request that has been ACCEPTED is no longer a message waiting to be read: it is work in progress, and a stop cancels it like any other. Verified by `backend/test/lib/a-stop-leaves-the-queue-tasks.test.ts`.

**`work_still_wanted` is cancelled with the run it asks about.** That task exists only to ask whether the work now running is still wanted, so once the stop has ended that work the question has no subject left. Cancelling it is what keeps a stopped conversation from being asked to confirm something that already stopped.

## Cancellation, and what `/stop` means

`/stop` is the explicit form of an interrupt, and it is the one case where deferring is the wrong answer.

**`/stop` is answered immediately, never queued.** Queueing it would deliver the cancellation after the thing it meant to cancel had finished, which is worse than not offering it.

**It stops the work. It does not clear the queue, and the difference is not a detail.**

`/stop` means "stop what you are doing". A message that arrived while the assistant was working is a request the person made and still expects an answer to; discarding it turns an interrupt into data loss they were never told about. So the queue survives, and what waited in it is still triaged.

### `/stop` reaches the assistant it was aimed at

**A stop is targeted, and the target is part of its identity.** A room can hold more than one assistant, each with its own queue and its own turn in flight. "Stop" aimed at the assistant writing a report must not also stop the assistant that is halfway through an unrelated lookup, because the person who sent it was watching one of them.

The stop record is therefore keyed by **conversation, person, AND responder**. Dropping the responder from that key is what makes a stop channel-wide, and a channel-wide stop is not a safer default: it destroys work nobody asked to lose, in a room where the person cannot see what else was running.

Resolution of the target follows tenet 5, which already answers "who is this turn for" before asking whether they are busy: an addressed stop names its assistant, and an unaddressed stop in a room with exactly one assistant means that one. An unaddressed stop in a room with several is ambiguous and is asked about rather than guessed, because guessing here is the failure this rule exists to prevent.

**What actually reaches a multi-assistant room today, stated rather than implied.** Amazon Chime SDK puts assistants in MENTIONS mode the moment a room holds more than one other member, so an UNADDRESSED `/stop` there is not delivered to any assistant at all - the ambiguity is resolved by the transport before this design ever sees it, and what the person experiences is silence. The supported form in such a room is therefore the addressed stop, `@name /stop`, which the parse tolerates precisely because it is the only form Amazon Chime SDK will carry there. The ask-rather-than-guess branch above stays, as the correct behavior for every path that CAN deliver an unaddressed stop to a crowded room (and as the rule any future delivery path must satisfy).

**As built (amendment, 2026-09-15): the channel flow delivers an unaddressed `/stop` in a room.** `/stop` is a flow-owned room command in the `CHAT_COMMANDS` registry (`backend/lambda/src/lib/flow-bypass.ts`: whole-message match, size-branched, dispatched to the conversation's primary assistant, answered even when the roster cannot be read). In a 1:1 the flow stands aside and the Lex entry answers it. So an unaddressed stop in a room reaches the primary assistant, and the ask-rather-than-guess branch above runs when that room holds several assistants. The paragraph above records the transport limit this ADR was written against.

**Parallel work across several assistants is a later phase (maintainer decision, 2026-08-23).** Routing a bare `/stop` through the channel flow so the ambiguity question can actually be asked, coordinating stops across assistants working in parallel, and whatever presence surface makes "which of these is mine to stop" answerable at a glance are one body of design work, deliberately not attempted here. What this ADR guarantees now is the invariant that work must not lose: the marker is keyed by responder, so whenever that phase lands, a stop that names its assistant already reaches exactly one.

### Three effects, and the third is judged

| Effect | Meaning | Path |
|---|---|---|
| **Abandon the in-flight turn** | The running turn's output is suppressed when it lands | Deterministic, immediate, no model call |
| **Cancel the work in progress** | The person's open tasks for the stopped assistant are cancelled; completed tasks are kept | Deterministic, immediate |
| **Evaluate why, and ask how to proceed** | Why the person stopped, and whether they want the work left cancelled or started again | Judged, follows |

The first two are what "stop" has to mean to be worth offering, and neither waits on anything. The third is what turns a cancel into a decision the person makes rather than one the runtime guessed.

### Completed work is kept; work in progress is cancelled; then the assistant asks

**`/stop` means "stop what you are doing", and the open work is what the assistant is doing.** So the stop cancels it, selected by who asked for it and which assistant it belongs to (`selectStoppableTasks`), and cancelled by id through the task service (`cancelStoppedTasks`), which takes the per-user mirror with the row. The selection reads open tasks only, so work already delivered is never in it. A turn still running cannot advance a cancelled task back out of `cancelled`, because a status update never overwrites a terminal status.

**The suppression is written before the cancel.** It is the only part of a stop the person can see working, so nothing the cancel does (a seam call, a refusal) can delay or prevent it.

**The acknowledgment says what happened.** Four outcomes get four lines, each overridable per assistant (`stopped`, `stopCancelledButNotAsked`, `stopCancelFailed`, `stopNothingToStop`): cancelled with a question coming; cancelled with no question, because the evaluation could not be dispatched; not cancelled, because the task service refused or failed, in which case no question is asked about work that has not stopped; and nothing to stop.

**Evaluating why is a reading, not an answer.** The assistant considers what it was doing when the stop arrived and what the person last said, and puts a short account of it to them together with the choice: leave it cancelled, or start it again, as it was or changed. It is the same shape as the triage proposal and is dispatched the same way.

### The question owns its follow-up

**The person's answer is read against the question before anything else routes the message.** The question is recorded for the person who was asked (`rememberStopDecision`, with the task ids and the text of each request), and the router reads it before drift, the declining guard, the quick reply and task routing, each of which would otherwise claim the message for something else. Ordinary routing is not trusted with it: measured live, "Drop it, I do not want that report" was classified `intent: general` and answered conversationally.

**The reading is a model call with a closed set of three answers,** taken on the classifier model because the decision comes from what somebody said and has to survive a conversation held in another language:

| Reading | What happens |
|---|---|
| `leave` | The work stays cancelled. The assistant confirms in its configured words (`stopLeftCancelled`) and the turn ends |
| `again` | The message is routed as the request it restarts: the original request text followed by what the person just said, classified afresh so it opens its task like any request |
| `other` | The message was about something else and is routed exactly as sent |

Every reading closes the question. A failed reading leaves it standing and routes the message as sent, so the next message is read again rather than an answer being invented.

**A private request is restarted only from a private message.** The restarted turn answers with the visibility of the message it is answering, so restoring a privately made request into a reply to a public message would publish what the targeting withheld. When every cancelled request was private and the answer was public, the message is routed as sent.

**The question is spoken by the model, and the fixed lines are the assistant's own.** A stop confirmation is user-facing copy, and fixed English breaks both the persona the deployment configures and the language the conversation is being held in (tenets P5 and D11). The evaluation is a model turn in the persona. The acknowledgment and the `leave` confirmation are deterministic, because no model call may sit in front of them, so each reads the assistant's configured copy and falls back to shipped English only where none is configured.

### What does not change

**The lock is not released by `/stop`.** The turn that holds it is still running, and releasing here would let a new message start answering alongside work that has not yet noticed it was stopped. The turn releases the lock when it ends, which is a recorded fact rather than a second opinion about whether it is still alive (tenet 2).

**Suppression, not termination, and the distinction is load-bearing.** A running Bedrock call cannot be recalled; the tokens are already being paid for. What `/stop` can guarantee is that the answer is not POSTED and the task state is not advanced. Promising termination would be promising something the runtime does not support, and the person would find out by being billed for it.

**A canceled turn is confirmed.** Silence after `/stop` is indistinguishable from `/stop` not working, so the immediate acknowledgment is not deferred until the judged step has finished. The person is told the work is stopped as soon as it is, and asked how to proceed after.

**And the suppression is applied before the turn claim, without a model call.** An escape hatch that queues behind the work it is escaping is not one. `/stop` is handled first in the router, ahead of every branch that could swallow it, including the guard that tells a person to send it. Only the evaluation that follows costs a model call, and nothing the person is waiting on depends on it.

**The evaluation is not given anything said privately.** Its reply is posted to the room, so its history leaves out every targeted message: the task's excerpt was already withheld from its prompt, and history was the remaining channel carrying a private request's words into a room-visible reply (measured on the live turn-queue e2e, 2026-09-14).

**The confirmation carries the visibility of what it canceled.** Stopping a targeted request is confirmed to the sender alone: a public "stopped, discarded the report" announces both that a private request existed and that it was abandoned, which is more disclosure than the request itself would have made. Where the canceled work was visible to the room, so is the confirmation, because the room watched it start.

**As built (amendment, owner 2026-09-15): a private `/stop` in a room is refused, and a stop is confirmed to the room.** A stop halts the assistant for everybody in the conversation, so a stop sent privately in a group stops nothing: the router replies with the configured `stopMustBePublic` copy, delivered only to the sender because the Lex reply inherits the message's `Target` (`router-agent-handler.ts`; the Lex entry answers a targeted command through `lexEntryAnswersCommand` and the flow's dispatched turn stands down through `inboundWasTargeted`, both in `lib/private-command.ts`). A stop in a 1:1, or in a room whose size cannot be read, proceeds. A stop that is carried out was therefore sent to the room, and its acknowledgment is posted to the room; it names no task, only how many were cancelled. The paragraph above records the decision this replaced. Verified by `backend/test/lib/a-private-command-is-answered-by-the-lex-entry.test.ts` and `backend/test/lib/a-stop-cancels-work-in-progress-and-asks.test.ts`, both of which run in the ordinary suite. `tests/e2e/private-stop.spec.ts` covers the same rule end to end but is **opt-in and has not been run**: it skips unless `PRIVATE_STOP_E2E=1` is set, so a plain `npx playwright test` proves nothing about it, and the repository records no passing run. It is run as `node backend/scripts/validate.mjs --only=private-stop`. Until that happens the end-to-end claim rests on the two unit tests.

**A duel is canceled by its initiator only**, consistent with ADR-029 and with the existing rule that only the person who started a duel may end it.

## What this does to the latency metrics

This is the part most easily got wrong, because queueing deliberately makes a person wait and every current metric would report that as a regression.

### A queued turn must not silently inflate time to first feedback

`ttff_ms` is compared against a published human-patience threshold. A queued message whose placeholder appears after the previous turn finished would report a TTFF of many seconds - true as a wall-clock fact, and useless as a signal, because it mixes "the system is slow" with "the system deliberately made them wait because it was busy". Left alone, the first queued conversation on a deployment moves the headline metric more than any real regression would.

**Two decisions follow, and they are not alternatives:**

1. **The deferral acknowledgement IS the first feedback, and it sets TTFF.** Tenet 4 already requires telling the person their message is queued. That reply is a real, fast, visible signal, so time-to-first-feedback stays what it has always been: how quickly the system responded to them at all. The Nielsen comparison survives intact because it is still measuring the same thing.

   **Every queued message gets its own acknowledgement instant, which is why the notice is UPDATED on each send rather than posted once.** A person who sends three messages is waiting three times, and a single notice written at the first one would leave the second and third with no first-feedback of their own - their TTFF would either be undefined or inherit an instant that predates them, and both are worse than the number they replace. The update carries the count, so the same edit that keeps the affordance honest also stamps the instant.

   The cost is one message update per queued send. That is the correct place to spend it: it is bounded by the queue bound, it happens only on the busy path, and it buys both the metric and the thing the person sees.
2. **The wait is named, not hidden.** `queue_ms` - from the person's send to the moment their message actually starts a turn - becomes its own step, reported beside the others. It is the one component of a slow answer the platform chose on purpose, so it is the one that most needs a name.

Without the second, `e2e_ms` absorbs the queue wait into an unexplained residual, and the existing reconciliation rule breaks: a leg is supposed to equal its named children plus a named remainder.

### The metrics that need a decision before this is built

> **What was actually built, measured 2026-09-02.** None of the row below shipped, and the failure was invisible because it produced an ABSENT number rather than a wrong one: a queued turn has no `placeholder_posted`, both `ttff_ms` and `ack_ms` anchor on one, so queued turns left the latency population entirely and the averages stayed healthy while the wait went unrecorded.
>
> The acknowledgement could not simply be added to that anchor either. The notice carries no correlation marker, so it declares no turn to join on, and it is one message updated in place, so a burst shares a single `response_id` and collapses to one instant - which contradicts the rule two paragraphs above, that every queued message gets its own acknowledgement instant.
>
> Now built: the acknowledged message id travels on the notice, is captured to `turn_events.acknowledges`, and `v_queue_acknowledgement` reports `ack_ms` per queued message (migration 039).
>
> **`queue_ms` as described below is not built, and should not be.** Draining the queue does not start the work: a queued message becomes a `queued_request` task created in `proposed`, which awaits the requester, so the span from the send to work beginning is mostly a person deciding. That is the handoff the very next section of this ADR already rules on - triage moves the work onto the task-resolution surface, where human think time is kept out of `agent_ms` precisely so one number cannot flatter the turn or damn the workflow. A `queue_ms` spanning both would undo that.
>
> So the view stops where the platform's sole accountability does: `triaged_ms`, the send to the moment the queue was READ. Beyond it, the task carries `userMessageId` set to the queued message id, which is what joins a deferred message to its own resolution.

| Metric | Effect | Decision |
|---|---|---|
| `ttff_ms` | Would include queue wait | Anchored to the deferral acknowledgement, so it stays comparable to the SLO. **NOT what it does.** It anchors on `t2_placeholder_at`, a queued message never produces a placeholder, and so it returns NULL for every queued turn (corrected 2026-09-02) |
| `ack_ms` | Already generalizes trigger to first signal | ~~Unchanged. It is the metric that already handles this correctly~~ **This was wrong.** `ack_ms` shares `t2_placeholder_at` with `ttff_ms`, so it is NULL for a queued turn too. Nothing handled it (corrected 2026-09-02) |
| `queue_ms` | Does not exist | Add as a named step. Null when the turn was not queued, so an average is the cost WHEN queued and a count is how often, matching how `poll_ms` and `classifier_ms` already behave |
| `e2e_ms` | Grows by the queue wait | Correct and should NOT be adjusted. It is the person's true wait, and `queue_ms` is what explains it |
| Interaction kind | A queued turn is still a person waiting | Stays `user`. Queueing is a property of the turn, not a different kind of interaction |

### The turn's attribution rides the close-out, and its compute does not (owner, 2026-09-15)

A turn that moves delivery to a NEW message leaves the original placeholder behind as a receipt. Three branches do it: a broadcast answer to a privately placed placeholder, a private answer to a public one, and an answer displaced to the end because its placeholder became the queue notice. Both exchange pairers take the earliest bot CREATE after the user message from that sender, and the placeholder is always earlier than the message the answer moved to, so **the receipt wins the exchange and the message carrying the answer keeps nothing.**

Measured through the signed path on 2026-09-15: 220 exchanges, 31 minted against an acknowledgment, 30 of those carrying no intent. One traced case had a person waiting 16.5 seconds on a queued turn with nothing recording it.

**The fix is on the update the turn already performs.** The close-out carries the pairing declaration and the attribution - the message this turn answers, the intent and its confidence, the delivery option, and the task id - so the exchange minted against the acknowledgment is the turn's exchange and knows what the turn was. No new write and no new carrier.

**The compute fields are deliberately excluded, and the next reader needs to know why.** Tokens, cost, model and the latency split are per-MESSAGE facts, and a turn in this shape produces two bot CREATE rows. `model_usage`, the Effectiveness cost estimate and every token sum read `messages` one row at a time with no idea that two of them belong to one turn, so a second stamp would double all of them - and only for turns that were queued or answered privately, which is the population least likely to be reconciled against a bill. A task TRANSITION and a terminal task status are excluded on the same principle in the ledger's terms: they are what `task_opened`, `task_transition` and `task_terminal` are read from, and a second copy would count one task movement twice. The bare task id opens no ledger row.

**The exchange is NOT re-pointed at the answer, and that was considered.** `v_turn_latency` anchors these turns through `anchor_source = 'exchange'`, taking `user_message_at` from the exchange's own row; the receipt is the placeholder, so `response_latency_ms` there IS the turn's time to first feedback. Moving the exchange to the answer would trade the turn's TTFF for its end-to-end time, which `e2e_ms` already reports.

*Verified by* `backend/test/lib/the-close-out-carries-the-turn-not-its-compute.test.ts`.

### Triage MOVES the work onto a different measurement surface

This is the consequence most easily missed, because it is a change of surface rather than a change of number. A queued message that becomes a task stops being a latency question and becomes a **task resolution** one, and those are already measured separately and deliberately never mixed: `v_task_resolution` decomposes `resolve_ms` into `agent_ms` - the part the system is accountable for - and the human think time that makes up the rest. It never enters the latency query or the alert computation, because one number would either flatter the turn latency or damn the workflow.

So the handoff is explicit:

| Span | Measured as | Surface |
|---|---|---|
| Person sends while busy, until triage begins | `queue_ms` | Latency |
| Triage proposes, person is deciding | human think time | Task resolution |
| A task executing | `agent_ms`, plus the ordinary per-turn latency of each turn it runs | Both, at their own grain |
| Task reaches a terminal state | `resolve_ms`, `terminal_kind` | Task resolution |

**A queued message that never becomes a task, and a task that never completes, are different failures.** The first is a triage bug and shows up as queued messages with no task created. The second is a workflow problem and shows up as tasks that never reach a terminal state. Reading either through the latency surface would report both as "slow", which is neither.

**Task completion rate is therefore part of judging this feature, not a separate concern.** If queueing converts messages into tasks that nobody ever completes, the mechanism has turned a confusing double-answer into a quiet backlog - and the latency numbers would look BETTER while the person is served worse. That inversion is the thing to watch for, and only the task surface can see it.

### The pause is NOT latency the system owes

Once triage has proposed and the assistant is waiting for direction, the clock is on the PERSON. That time must not land in any latency metric, for the same reason a task open for four hours with twenty seconds of assistant time is healthy: `v_task_resolution` already separates `agent_ms` from human think time, and this is the same separation arriving by a new route.

Folding it in would produce the worst kind of wrong number - one that gets worse the better the system behaves, since asking rather than guessing is what creates the wait. A deployment would learn to stop asking.

So the boundary is explicit: `queue_ms` ends when triage begins. What follows is the person's, and it is measured as task resolution if it is measured at all.

### The check has its own cost, on the hop least able to afford it

Today an ORDINARY message does no DynamoDB I/O in the channel flow: the only claim there is gated on the message dispatching a turn from the flow, so it runs for `@all`, `/battle`, an addressed assistant and a bare reference, and for nothing else. A conversation-scoped lock adds a round trip to the critical path of every message, synchronously, before delivery - which places it inside `inbound_ms` and inside `ttff_ms`, the two numbers this platform is most sensitive about.

That cost is paid by every turn, including the overwhelming majority that are not queued and gain nothing from the check. It is small, and it is not zero, and an ADR that adds a queue metric while omitting the cost of the mechanism producing it would be measuring only the half that flatters it.

**So it is budgeted and watched, not assumed.** The check is one conditional write against a record the lock needs anyway, and the acceptance bar is that `avg_router_ms` and `avg_inbound_ms` do not move materially on turns that were never queued. That is measurable today, before and after, with metrics that already exist.

## What the admin console shows

The operator's question is not "how long did turns take" - the existing latency surface answers that. It is **"is this mechanism working, and what is it costing people"**, and those need different columns.

| Metric | What it answers | Why it earns a place |
|---|---|---|
| `queue_ms` avg and p95 | What a queued person waited beyond the answer itself | The one delay the platform chose deliberately, so the one that most needs a name |
| Queue rate | How often messages are queued at all | A rate on a hard floor of zero. A deployment where this is high is one where people are routinely waiting on their own earlier message |
| Queue depth at drain | How many messages one turn absorbed | Distinguishes one person double-sending from a conversation nobody is keeping up with |
| Overflow drops | Messages discarded because the bound was hit | **Data loss from the person's point of view.** It must never be inferable only from a log line |
| **Lock takeovers** (`LockTakeover`) | Locks taken over by an arriving message because the holder made no progress for longer than `TURN_STALE_AFTER_MS`, rather than released by a recorded fact | **The health signal for this entire design.** Non-zero means the release-by-fact guarantee failed and something died holding a lock. It is the one number here worth an alarm |
| Cancellations | Turns ended by `/stop` | Separates "the person changed their mind" from failure, and keeps both out of the completion average |
| Tasks created BY triage | How much of the work list this mechanism is producing | The number that says whether queueing is converting messages into work or into a backlog |
| Their completion rate | Whether that work finishes | **The inversion guard.** If queued messages become tasks nobody completes, the latency numbers IMPROVE while the person is served worse. Only the task surface can see that |

**The last two live on the task surface, not this one**, and that separation is deliberate rather than tidy: task resolution already refuses to mix `agent_ms` with human think time, and a queued message that became a task is measured there for the same reason. What belongs here is the count of the handoff; what belongs there is what happened after it.

**A private task still counts here, and the console still shows nothing of it.** Operator visibility and member visibility are different questions: an admin already reads across conversations they are not a member of, so "private" means private from other MEMBERS, not from the platform's own accounting. A private task that vanished from these counts would make the queue look like it was losing work.

What must not follow the count is the CONTENT. These are aggregates - how many, how long, how many completed - and none of them needs the request that produced the task. The conversation read already holds that line by building its result field by field rather than by deleting from the row, and an admin count has even less reason to cross it.

**Lock takeovers are the metric that judges the ADR.** Tenets 2 and 3 claim a lock is released by something that happened; a takeover is the measured admission that nothing did. A build that cannot report this number cannot show that its central claim holds.

**These belong beside the interaction breakdown, not inside the headline cards.** Queueing is a property of some turns, and folding it into the aggregate is how a deliberate wait becomes indistinguishable from a slow one.

### A canceled turn is neither a success nor a failure

The ledger closes a turn only on a declared final phase, and an errored turn deliberately does not close - the wait ended and no answer was produced. **A canceled turn is a third thing** and needs its own phase. Folding it into `final` would count a discarded answer as a completion and flatter the latency average; folding it into `error` would report a system fault where the person simply changed their mind, and would make the abandonment signal unreadable.

It also must not count as a measurement gap. The existing unclosed buckets partition turns that never resolved, and a canceled turn resolved exactly as asked.

## What proves it works

An implementation is judged on these, in this order. The first is the one that decides whether the design is safe at all; the rest are whether it does its job.

| Test | What it proves | Why it is the bar |
|---|---|---|
| **A conversation whose worker died still answers the next message** | The lock releases by fact, not by clock | The whole design rests on tenet 2. A build that stops duplicate turns and strands one conversation has made things worse |
| An unreadable lock store answers the message anyway | It fails open | The second route to the same failure, and the one a table outage takes |
| Two messages seconds apart produce ONE turn | The claim is taken at arrival, not derived from state a turn has not finished writing | This is the sub-turn window the existing task guard cannot close |
| A message addressed to a DIFFERENT assistant is answered while the first is busy | The lock is keyed on the responder | Without it, one assistant's work silences another |
| A duel refuses a second `/battle` AND the first still resolves | The existing behavior survives generalisation | Already asserted by the battle e2e; a general implementation must not regress it |
| A task awaiting the person answers their reply immediately | The awaiting state is not treated as an interrupt | The reported failure, inverted |
| Triage turns queued messages into tasks, and amendments amend rather than duplicate | The queue produces work, not a concatenated prompt | The failure it replaces is answering "make it one page" and "book a review" in one reply that serves neither |
| The assistant PROPOSES and waits rather than executing the queue | Triage is a reading, not a plan | Executing a reading silently means the person learns how their messages were interpreted only once the wrong work is done |
| An ambiguous queue asks whether the in-progress task should still finish | The named ambiguity is asked about, not guessed | Both guesses waste their time: finish a report nobody wants, or discard one they were waiting for |
| A triaged request starts in a state that AWAITS THE REQUESTER | The pause needs no mechanism beside the machine | A confirm step built separately would be a second answer to "who acts next", and the two would drift |
| A message arriving while the assistant awaits direction is treated as the ANSWER | The pause is a task awaiting the person | Treating it as an interrupt would deadlock the conversation against its own question |
| A request for a different kind of work, sent while a task awaits the person, opens its own task | New work is not the awaited answer | Folded into the waiting task, the request is answered and never tracked: it cannot be listed, resumed or measured as its own work |
| A failed task write is REPORTED to triage, while every other caller still fails open | The task is the answer here and a side effect everywhere else | A swallowed write leaves the person told their messages landed when nothing holds them |
| A triage turn missing its visibility is not a triage turn | The context is guarded whole, never half-parsed | A turn holding the message ids but no visibility would create the right work and show it to the wrong people |
| **A targeted request produces a task ANOTHER member cannot see** | Visibility is inherited from the request | The privacy requirement, and the one that must not be deferred: under triage this is the normal path, not an edge |
| **A queue mixing targeted and untargeted messages produces a TARGETED proposal** | It fails toward silence | Over-disclosing publishes a private request; under-disclosing costs a notification. Asserting the direction is what stops a later "simplification" reversing it |
| A task with no visibility reads as private at every reader | Absent fails closed | And the companion assertions: an explicit `conversation` task is still shared, and every writer of a shared task records `conversation` (`task-visibility.test.ts`) |
| `/stop` mid-turn suppresses the answer and confirms | Cancellation does what it says | And that the turn is recorded as canceled rather than as completed or errored |
| **`/stop` leaves the queue alone** | It stops the work, not the requests | Discarding what arrived while the assistant was busy turns an interrupt into data loss the person was never told about |
| A triage turn holds NO tools | The reading cannot execute itself | Through the tool surface it would arrive before the reply exists, where parsing the reply catches nothing |
| Several messages draw ONE notice, updated in place | The acknowledgment does not itself become noise | Three "still working on it" lines leave the conversation worse than saying nothing |

**Where the whole is asserted, not the parts.** Every row above has unit coverage, and unit coverage cannot show that the pieces are wired to each other: the property spans five Lambdas and a client hook, each green in isolation. `tests/e2e/turn-queue.spec.ts` (validate phase `turn-queue`) covers the deferral, the depth, `/stop`, and per-responder busy against a live deployment; `frontend/packages/chat/src/hooks/useTurnState.test.ts` covers the several-assistant union, which needs two assistants answering to be visible in the DOM and so cannot be observed end to end here.

**The metric that reports on it in production is `LockTakeover`.** A test suite shows the release paths work on the cases it thought of; that counter shows whether they hold on the ones it did not.

## What this does not decide

- **Whether a batch may mix two people's messages.** Tenet 5 settles the easy half: a message addressed to a DIFFERENT assistant is not queued at all, so most multi-party traffic never meets this. What is left is two people addressing the SAME assistant, where the batch drain hands both to one turn. That is probably right, since they are talking to the same assistant in the same room, but it means one member's send can be answered in a turn shaped by another's, and it is not decided here.
- **Cross-conversation.** The lock is per conversation. A person may hold several at once and always could.
- **How a meeting names its parent.** The rule that a task belongs to the parent conversation is stated above; the mechanism that resolves one is not, because meetings are not built. The nearest existing precedent is `drift_events.parent_channel_arn`, which records the conversation a split came from, and it is worth checking whether that is the same relationship before inventing a second one.
- **Whether a task can move between conversations.** A task created against the wrong parent is a correction somebody will want, and nothing here says whether that is possible.
- **Whether `/stop` can abandon a turn mid-Bedrock.** Only that it must not claim to.

## Consequences

**A person gets one answer to one question, on every entry point, and hears why when they do not.**

**Duplicate model calls fall.** Every doubled turn today is a paid call whose output confuses the person who paid for it.

**A new failure mode is created and must be designed against: the stranded lock.** Tenets 2 and 3 bound it, and any implementation is judged on them first. The test that matters is not "does it stop a duplicate turn" but **"does a conversation whose worker died still answer the next message"**.

**A second new failure mode: a metric that reports a design decision as a regression.** The latency section exists so that is caught in review rather than in a dashboard.

**The battle entry is the reference.** It is built, live, and its e2e asserts both halves - the second `/battle` is refused AND the first is not lost. An implementation that cannot satisfy that test on the duel surface is not ready for the others.

## The drain is deterministic and the reading is judged, and both always run

**The queue is ALWAYS drained.** Whether the model produced a usable reading decides WHAT the queued messages become, never WHETHER they leave the queue.

The first build made the drain conditional on the reading: the queue was cleared only when a proposal parsed, on the reasoning that a queue cleared with no proposal behind it is a set of requests that silently never happened. That reasoning is sound and the mechanism inverted it. The triage turn is dispatched as an ordinary turn request, so it runs with the profile's persona and answers in prose: measured against the deployment, zero `TRIAGE:` lines, no `PROPOSAL:` marker, and not even the `ANOTHER_PASS:` escape hatch. The reading was never usable, so the queue was never cleared, and the queued question was never answered at all.

So the two halves are separated and both are unconditional:

- **Deterministic.** Every queued message becomes work and the queue is emptied. This cannot depend on a model producing parseable output. When the judged reading is unusable, the drain runs against a reading derived from the queued messages themselves: one piece of work per message, ordinary priority, labeled from the message.
- **Judged.** The assistant derives what it expects the outcome to be - the grouping, the priority, what amends work in flight and what is new - and asks the person to confirm it. What it captured and what it could not read are both said plainly, in its own voice.

A request never ends as a row in a queue nobody drains. A reading that fails degrades the QUALITY of the triage, never its completeness.

---

## The lock stands until the answer is delivered and the queue is empty

Releasing the lock because the WORK finished leaves a window. The answer has just been posted, the lock drops, and anything sent while it was landing is neither queued, since nothing holds the lock any more, nor reviewed, since the reading that would have covered it already ran. It starts a fresh turn alongside the one still arriving.

Triage has the same edge from the other side. It runs on message ARRIVAL, which is the right trigger, and it takes `claimTriage` so two notices cannot create the same work twice. A message that lands while it is already running therefore finds the claim held and returns, and nothing comes back for that message afterwards: it stays queued, is shown to the person as waiting, and waits for as long as the conversation lives. Observed live and in the e2e as three messages held, one of them described in the proposal, and a queue that never drained.

**So the queue is re-read at the end of the turn, and anything still waiting TAKES the lock rather than finding it free.** `handOverLock` moves the holder to the triage turn that will read it in one conditional write, so there is no instant at which the conversation is unheld. A person who keeps typing keeps meeting a held lock, which is the rule rather than a side effect of it.

The end of the turn is the place to catch this because turn completion is an EVENT and the last moment anything holds the conversation. It is not a sweep on a timer, which tenet D6 forbids and which would in any case be asking about work that had already finished.

### The loop this opens, and what bounds it

The turn handed to is itself a triage turn, so its completion arrives back at the same release path, and a person who keeps typing keeps refilling the queue it reads. Holding the conversation for that indefinitely is the stranding tenet 2 forbids, reached by a route that looks like progress.

It is bounded by the budget triage ALREADY carries rather than a second one invented for it: the pass increments and the deadline travels unchanged, because a loop able to renew its own budget by looping is not bounded by a clock at all. When the budget is spent the lock is released normally, and the next message the person sends starts a fresh turn that reads whatever is still queued.

Verified by `backend/test/lib/the-lock-stands-until-the-queue-is-empty.test.ts`.

## Follow-ups are rolled into the answer before it is sent (amendment, owner 2026-09-14)

**A turn answers with the context that came before its question and the follow-ups that arrived while it worked.** The first is its history. The second is the fold: the reading marks a queued message as amending the work in flight, and the answering turn, at the last moment before delivery, re-runs with those messages folded in. What this section adds is the guarantee that the fold sees them, which depended on the reading finishing first and did not always.

**The answer's history ends at its own message.** Messages sent after it are the queue, not the past. A turn that reads them as history answers them out of order while the queue still holds them, and the reading then proposes work that is already done. Measured live 2026-09-14: a turn answering the first of four messages loaded the other three as history, answered them, and two readings then proposed them again. The history is cut at the turn's own message, and ids the turn-state record holds as queued or amending are excluded.

**A reading pass keeps the follow-ups it found, even when it is replaced.** A pass whose queue moved under it is re-read, and the next pass's proposal replaces this one, so one drain still produces one proposal. What this pass found to be follow-ups is recorded before the re-read, so the answering turn can fold them while the next pass reads. A follow-up is recorded only while it is still queued and not already recorded, and a folded message leaves the queue, so a later pass cannot record it twice and one already answered cannot come back.

**An answer that is ready while a reading is still running waits for it.** At the fold checkpoint, when a reading still holds the claim (`triagedBy`) over a queue that is not empty, the finished turn PARKS rather than delivering:

| Step | What happens | Where |
|---|---|---|
| Park | The turn's finalize inputs are stored on the turn-state record and the lock moves to the reader in ONE conditional write: this turn still holds it, the reader still holds the claim, the queue is not empty, nothing else is parked. When any of those is false the reading has finished, and the answer is delivered as before | `parkTurnForReading`, at the fold checkpoint in `finalizePlaceholderResponse` |
| Wait | The reading continues. A parked answer counts as work in flight, so its follow-ups are recorded for it rather than read as new work | the reading turn |
| Resume | Once the reading has recorded its follow-ups, it hands the lock back to the parked turn and invokes the processor with the parked turn's key. Every exit of a reading also resumes whatever is still parked, so a reading that asks instead of proposing, or errors, cannot leave an answer waiting | `resumeParkedTurnIfAny`, in the reading and in `settleTurnLockAtExit` |
| Deliver | The resumed run takes its stored inputs exactly once and runs the same finalize again: it folds what was recorded, or delivers the draft | `resumeParkedTurn` in `assistant-async-processor.ts` |

**The reading never delivers the answer.** It only hands the conversation back and resumes the turn that owns the answer, so there is one delivery path and every rule delivery follows (visibility, chunking, receipts, the stop check, analytics) applies unchanged. No model call is repeated unless there is something to fold.

**It is an event, not a wait on a clock.** The answer resumes because the reading finished (tenet D6). The lock is never unheld across the park or the resume, because each moves the holder in a single conditional write (tenet 2).

**What the person is told matches what happens.** The reading's proposal says that follow-ups changing the work in flight are being included in the answer now, and asks only about new or unclear messages; it never asks the person to confirm a fold or to wait for one. When a reading hands follow-ups to an answer still being written, it leaves the queue notice unsettled, and the answering turn settles it at its exit once the answer is in the conversation, so "caught up" is never shown before the answer it refers to.

**The fold note goes with the notice.** When everything a reading found was a follow-up folded into the running answer, its note says so and asks nothing, so it is written into the notice in the answer's placeholder (`writeProposalIntoNotice`) rather than posted at the end where the answer is about to land. Stage updates and the settle keep the note: the stage moves in the metadata, and settling marks the queue done without writing "caught up" over it. A proposal that asks the person something (new or unclear work, a split offer, work that could not be recorded) still posts at the end, where their reply follows it.

**An emptied queue still ends its drain.** The resumed answer's fold can take every queued message off the queue before the reading clears it. The clear then still removes the reading's claim, its stage and the drain id, so the answering turn's exit is not left looking at a claim held by a reading that has finished, and settles the notice.

**A reading pass posts only when it writes.** The message a reading's proposal or question goes into is posted by the exit that writes into it. A pass that hands off to another pass posts nothing, and its token and model-time usage is carried to the pass that posts and recorded there.

**A fold is not the person speaking.** The router does not apply a fold as the answer to an open task, read it for drift or against a stop question, or run onboarding on it, and the processor does not read a pending split offer on it. The fold keeps its task lookup, so a fold of a task step still continues that task. The turn writes back the id of the message it answers before it can park or fold, so the resumed or folded run's history is cut at that message.

**Bounded.** A run parks at most once (`parkedOnce`), so a person who keeps typing delays an answer by at most one reading per run. A stop evaluation and a duel side never park. An answer whose stored inputs would exceed the record's size budget is delivered at once, and the log says so.

**What it costs.** During a burst the first answer arrives when the reading finishes rather than when the model finishes: about eight seconds in the measured case. That is the price of answering the question the person actually finished asking, and it is paid only when a reading is running beside the answer.

**What it does not cover.** A resumed run the platform kills after taking its stored inputs cannot be resumed again. The failure destination's retry finds nothing parked; it releases the conversation, so it is not stranded, and logs an error. The parked answer is not delivered and its placeholder is left unresolved.

*Verified by* `backend/test/lib/an-answer-waits-for-the-reading.test.ts`, `backend/test/lib/a-queue-behind-a-turn-is-not-its-history.test.ts`, `backend/test/lib/channel-history-context.test.ts` and `backend/test/lib/the-queue-is-read-again-when-it-moves.test.ts`.

## A drain IS a task, and declining the row cost what tasks already solve

The drain has always been declared as a `TaskStateMachine` - validated by the same validator as every other machine in the codebase, with states, declared edges, an `awaits` on `clarifying`, and a terminal. The design reused that framework and deliberately declined the task ROW, on two grounds:

> It reuses the FRAMEWORK and not the task ROW. Tasks are work somebody owns, appear in their list, and outlive the turn; a drain is a phase of one turn, and giving each one a row would put an item in a person's open work every time an assistant read a queue.

**Both grounds have since stopped being true, and neither failed loudly.**

A drain is no longer a phase of one turn. The lock's lifetime is the DRAIN rather than the turn, and the handover chain lets one drain span up to `TRIAGE_MAX_PASSES` turns. It already outlives a turn, which is the property the objection turned on.

And it would not appear in a person's open work. A drain is the ASSISTANT'S work; `getActiveTasksForUser` reads the owner's partition, so an assistant-owned drain lands in the assistant's. It reaches a person only when it hands over at `clarifying` - which is exactly the moment the proposal IS asking them something, and the moment they most need it in their list.

**What declining the row actually cost.** Every property the drain has been missing is one that tasks already have, and each was found separately, as its own defect:

| The drain needed | Tasks already have it |
|---|---|
| An owner, so state and responsibility cannot disagree | `assigneeId`/`assigneeType`, one writer, handed over at every `awaits` boundary |
| Supervision when it stops moving | `TASK_STALL_TURNS` and `recordNoTransitionTurn` |
| An operator who can see and stop one | The task service's read and stop path |
| Resolution timing separated from human think time | `v_task_resolution`, `resolve_ms` decomposed into `agent_ms` and the rest |
| A legal-move check that is not bespoke | The same declared-edge validation every machine gets |

The queue instead grew a parallel half of each: `queueStatus` on the turn record with its own conditional write, a stage vocabulary only it knows, and a bespoke latency view. That view's first definition reported a read instant EARLIER than the acknowledgement it followed - the kind of error a shared surface does not let you make.

**So the drain becomes a task**, of a declared type, owned by the assistant that is reading, handed to the requester at `clarifying` like any other awaiting step, and terminal at `settled`. Its timing is then task resolution, measured the way every other task is measured.

### One drain per queue, not per pass

A chain of readings is ONE reading that took more than one turn, so the task's identity has to survive the handover. A correlation id cannot carry it: it changes per link BY DESIGN, so that a further pass is not swallowed as a duplicate delivery. So the identity is carried on the record the whole chain shares, claimed by conditional write.

The claim tells a LOSER THE WINNER'S ID rather than refusing it. Every message that queues runs the open path, so a burst of three would otherwise open three drains for one queue - and a loser told only "no" would either open a second task or work a drain that nothing records.

The id ends with the QUEUE rather than with the pass, and that is an asymmetry in the clear. A pass ends at either branch, so the triage claim and the stage reset at both; a remainder is the same queue still being worked, so only an empty queue removes the drain. The two branches sit next to each other and differ by one attribute, which is what makes this the thing an ordinary refactor flattens.

### What this depended on landing first

A drain hands over at `clarifying`, so it inherits whatever happens to a task the assistant is handed and does not move. Nothing returned such a task: `maybeHandOver` gives it to the assistant when a person replies at an awaiting step, that hand-over is meant to be momentary, and a turn that advanced NOTHING left the state declaring a person was awaited while `assigneeId` said the assistant held it - `awaits` and the owner disagreeing, which the ownership model claims cannot happen.

Measured on the deployment: 56 tasks in that condition, every one invisible in its own requester's open-work list because that list reads the owner's partition. Without the fix, the first reply to a drain that parsed as nothing would strand it identically.

**Status: partially built.** The row, its identity and the hand-back are built. The stage a person sees is still carried on `queueStatus` separately from the task's own state, so nothing advances the task yet and the hand-over at `clarifying` does not happen.

Verified by `backend/test/lib/one-drain-per-queue-not-per-pass.test.ts` and `backend/test/lib/an-unmoved-task-goes-back-to-the-person.test.ts`.

### The drain references the message, and closes when the queue does

Two rules the first build of this got wrong, both found by review rather than by anything failing.

**A drain carries the message's ID and never its text.** A queued message may be targeted - addressed privately to the assistant - and the drain's row is one the room can see, so storing an excerpt published a private request's words into a conversation-visible record. Content is resolved AS THE CALLER when something displays it, which is the rule the queue itself already follows and the reason `queued` holds ids rather than text. It is the only honest choice on accuracy grounds too: a drain covers a whole queue from possibly several people, so there is no single message whose words describe it.

This leaves a question that is deliberately not answered here: the referenced message can be EDITED or REDACTED after the drain reads it, and the assistant has to adjust rather than carry on against a stale reading. Tracked, not built.

**The drain closes when the queue empties, and closing means the STATUS.** `clearQueue` removed the drain's id from the record while nothing closed the row, which then lived to its 24-hour TTL. An open drain is not inert: it is the newest live task the assistant owns in that channel and the router reads the newest, so it masked a chain that was genuinely blocked on a person and their reply stopped resuming their own work. It also held `liveTaskInChannel` true, suppressing drift, and would eventually have tripped stall supervision on work nobody was doing.

Reaching a terminal STATE does not close a row. Every query that decides what is live filters on `status`, so a drain sitting in `settled` with `status: pending` is still live work to every reader that matters. Both are written; the status is the half that does the work.

It closes at the same point and on the same condition as the notice settles, because the queue emptying, the notice settling and the drain closing are one fact said three ways - to the record, to the person, and to the system. Gating them on two separate answers is what let them disagree.

Verified by `backend/test/lib/a-drain-carries-the-id-and-closes-itself.test.ts`.

### A drain never waits on a person, because the queue is behind it

The drain machine declared `awaits: { party: 'requester' }` on `clarifying`, on the reasoning that a proposal put to somebody is a step waiting on them - which is true of every other machine here and wrong for this one.

**A drain that waits is a QUEUE that lives until somebody answers.** The drain is not one person's workflow; it is the assistant reading a queue that may hold several people's messages. Holding it for one answer makes everybody else's message wait on a reply they cannot give and may not be able to see. The queue is the shared resource, and the whole feature exists to keep it moving.

**Nothing is lost by not waiting, because the wait already had a home.** Every queued message that becomes work opens a `queued_request`, whose initial state `proposed` awaits the requester. The question is therefore recorded, owned, visible in that person's list, and answerable at their pace, against the task it is actually about. The drain asking AND holding was the same wait kept in two places, and the drain's copy was the one with a queue attached to it.

So the drain asks, records the work, and clears. It still shows `clarifying`, because it did put something to somebody and a person watching should see that; the stage is a statement, not a block. Where the reading could not tell what a message meant, the answer is a task recorded against that message - a placeholder that says what is unclear - rather than a drain that stops until somebody explains.

It could not have been made coherent in any case. A drain that hands over at `clarifying` is closed the moment the queue empties, which is the same turn, so it was handed to somebody and taken back before they could see it.

The general hand-back for tasks that DO wait is unaffected and still needed: an unmoved turn returns an awaiting task to the person it awaits, which is how 56 tasks stranded on the deployment stop being stranded. A drain is simply no longer one of the things that depends on it.

Verified by `backend/test/lib/the-queue-says-what-it-is-doing.test.ts` and `backend/test/lib/a-step-declares-who-it-awaits.test.ts`, which names `queue_drain` as the one shipped machine that must declare no wait at all.

### The stage a person sees and the drain's own state are one fact

Adopting the task row left the drain carrying its stage twice: `queueStatus` on the turn record, which the notice renders and a person reads, and the task's `taskState`, which nothing moved. It sat in `waiting` for the drain's whole life.

A second vocabulary that is frozen is worse than not having one. The operator view and the resolution timing both read the state, so every drain reported as never having started - and the reason the task row was adopted at all was to stop the queue growing a parallel half of what tasks already have.

**The record decides, and the task follows.** The conditional advance on the turn record is the authority for ordering: it refuses a stage that cannot legally follow the stored one, which is what settles the genuine race between the private half and the clear, and it is the mechanism already proven against that race. The task advances only when that write ACCEPTED the move. Asking the machine twice, in two places, is exactly how two records of one fact drift apart.

**One read per drain, not one per stage.** The task is fetched once and its state carried forward locally, because the record has already established the order and a drain sits on the path somebody is waiting on. A stage whose write fails leaves the local state moved on regardless: the task falls behind by one, the drain still closes, and the alternative - refusing to advance because one write failed - would strand the state at the exact stage that failed.

Verified by `backend/test/lib/a-drain-carries-the-id-and-closes-itself.test.ts`.

### The reading can say it could not tell, and a whole reading that failed says so

The reading's vocabulary was `amends` or `new`, and nothing else. Every queued message had to be one of them, and `new` opens a `queued_request` in `proposed` - a row that says "here is the work I propose to do".

So a message nobody understood produced a confident proposal, labeled with a slice of the person's own words read back to them. They had to notice it was wrong, and until they did, a task nobody could act on sat in their list looking like agreed work. The placeholder this design needed could not be expressed at all, because the vocabulary had no word for it.

**`unclear` is that word, and `queued_clarification` is what it opens.** Its first state `asked` awaits the requester: the message is held, the request is not understood, and one answer defines it. It is a separate type from `queued_request` because the claim is different - one proposes work and the other asks a question, and which one a person sees decides whether they are correcting a wrong guess or answering a straight ask. It also gets a task while work is in flight, where an ordinary amendment opens nothing: an unclear message cannot fold into work nobody has identified.

The model is told the word and the rule for it, because a vocabulary nothing mentions is one that is never used, and that failure looks exactly like the model choosing not to use it. The rule matters as much as the word: do not guess a request in order to fill the line, and label an unclear message with what you would need to know rather than what you would do.

**And when the WHOLE reading failed, the assistant states that rather than listing guesses.** The derived floor runs when the judged reading was unusable - nothing was understood about any of those messages - and it marked every one of them `new`. A reading that understood nothing was therefore the most confident output this path can produce. Those items are now `unclear`, and the proposal opens by saying it could not work them out instead of "here is what I understood" above a list of guesses.

FR10 is unchanged by this and still satisfied. The queue still always drains, and every message still becomes a durable item that nothing loses. What changed is what that item claims.

Verified by `backend/test/lib/a-message-it-could-not-make-out.test.ts`.

### The judgement is the model's; the selection that drives the process is a choice from a set

The reading decides, per queued message, whether it amends the work in flight, whether it can be understood at all, and how it ranks. That is judgement and it belongs to the model. What also belonged to the model, and should not have, is the FORM the judgement arrived in: a `TRIAGE:` line, matched with a regex, whose fields were then checked against closed sets. The decision was constrained. The channel carrying it was not.

**The gap was measured, not theoretical.** A triage turn is dispatched as an ordinary turn, so it runs the profile's persona and answers in prose - "zero `TRIAGE:` lines, no `PROPOSAL:` marker, and not even the `ANOTHER_PASS:` escape hatch" against a real deployment. The reading was unusable and the derived floor had to carry it. That floor is a good thing to have and a bad thing to depend on.

**So the reading is recorded through a tool whose fields are enums** - the three intents, the three priorities, and the ids of this queue. An intent outside the set is not a value to detect and reject; it is a value the model cannot express. A message id that was never queued is likewise unreachable, so a reading cannot classify a message that does not exist or quietly rename one that does. And a tool call cannot be answered in prose.

**Three tiers, and the two outer ones need no cooperation.** The tool when the reading arrives through it; the text contract as the fallback for a provider that cannot enforce or does not support a schema; and the derived floor, which marks every message unclear, when neither yields a reading. Only the middle tier depends on a model following a format.

**Every field is re-checked on both channels.** A schema is a request to the provider, not a guarantee from it, and this value decides what happens to somebody's message. The same closed sets apply to both, so neither channel can accept what the other would refuse.

Two properties fall out of the change. The `PROPOSAL:` split stops being a security boundary on the primary channel - tool arguments are separate from the prose, so a message quoted back cannot contribute to the decision. And the reading tool is deliberately NOT behind the per-profile tool allowlist: every other tool there is a capability a deployment grants, while this one is how a reading is recorded at all, and gating it would allow an assistant that can be asked to read a queue and has no way to answer.

**Two wiring defects, both silent, both found by deploying.** The tool was first registered while the directive still described the line format, so the model had two contracts for one answer and followed the prompt - `toolCalled: false` on every turn, which is the model behaving correctly. And `readingOf` was placed in the options bag, but the resilience wrapper forwards a fixed list of options and reads everything else off the config, so the field was dropped without a word and the turn was told to call a tool it had never been offered. Neither is visible to a unit test; the log line that separates "the model chose wrongly" from "the model was never offered the channel" is kept for that reason.

**What this does NOT change.** The reading still sees the whole queue at once, still produces one entry per message, and still never merges two messages into one item - grouping exists only to offer a SPLIT. Amendments still fold into the running turn when they reach it in time. `unclear` is a third option beside `amends` and `new`, not a new path.

Verified by `backend/test/lib/the-reading-is-a-choice-not-a-sentence.test.ts`, and live: `viaTool: true, toolCalled: true, usable: true`.
