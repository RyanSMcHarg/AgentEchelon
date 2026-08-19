---
title: "ADR-032: Where a rule runs - the critical path, or after it"
status: Accepted 2026-08-14 (owner). Tenets stated; the worked example is built, and its server half is verified live.
date: 2026-08-14
related:
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md"
  - "../../../backend/lambda/src/channel-flow-processor.ts"
  - "../../../backend/lambda/src/message-post-processing.ts"
  - "../../../backend/lambda/src/lib/task-answer-repair.ts"
  - "../../../backend/lib/stacks/post-processing-stack.ts"
  - "../../../frontend/packages/chat/src/components/MessageInput.tsx"
tracking: |
  Tenets, plus one worked example built end to end: the composer addresses a task answer and names the
  task; post-processing dispatches the ones that arrived at nobody, and counts them. Supersedes the
  direction, taken earlier the same day, that the channel flow should repair a missing `Target` inline.
  Both halves are built and deployed. The server half is verified live; the composer half is
  unit-verified with no live exercise yet - the `Repairs` count falling to zero is what will show it
  working.
---

# ADR-032: Where a rule runs - the critical path, or after it

## Status

**Accepted (owner, 2026-08-14).** Tenets stated. The one worked example is built, in both halves:

| Part | State |
|---|---|
| Post-processing dispatches an answer that reached nobody | Built, deployed, **VERIFIED LIVE**. `Verified by:` `backend/test/task-answer-repair.test.ts` |
| The repair is counted | Built, deployed, **VERIFIED LIVE** (`Repairs: 1`, `Classification: premium`). `Verified by:` `backend/test/post-processing-wiring.test.ts` |
| An answer already delivered is left alone, by all three routes | **VERIFIED LIVE** for `Target` and for `CHIME.mentions`; `@all` / `/battle` are unit-covered |
| The composer addresses a task answer and names the task | Built and deployed. `Verified by:` `frontend/packages/chat/src/components/MessageInput.task-answer.test.tsx`. **No live exercise** - the `Repairs` count is what will show whether it works, by falling to zero |

**Every fact this rests on was measured against the deployment** rather than inherited. The stream
record carries `Target: [{ MemberArn }]`, `Metadata`, and `MessageAttributes` with the full
`CHIME.mentions` ARNs, and omits `Target` entirely when unset.

**One of those measurements changed the design.** The rule first asked only whether a message carried a
`Target`. A mention carries none - Amazon Chime SDK routes it to the mentioned bot's Lex via
`CHIME.mentions` - so a mention-addressed answer was indistinguishable from one that reached nobody.
Confirmed against the deployment before the fix: such a message was carried all the way to the task
lookup, and only a task id resolving to nothing stopped it dispatching a second turn on a message that
had already been answered. `@all` and `/battle` carry neither field and are claimed by the channel flow
from the content, so post-processing now stands down on the same tokens, from the same shared matcher
the flow and the router use. What had been a client-side invariant is now three checks on fields the
stream carries.

## Problem and who it's for

Every rule added to the channel flow is paid for by every person in every conversation, including the
ones the rule will never apply to. The flow is synchronous: it runs before a message is delivered, on
all of them, and Amazon Chime SDK is waiting on it. A rule that only matters when something has already
gone wrong still costs its read on the turn where nothing is wrong.

The pull is constant and it always sounds reasonable, because the flow is the one component that sees
everything. Left unchecked it ends with the flow doing the work of the turn, which is the divergence
`flow-does-not-run-the-turn.test.ts` exists to ratchet closed.

## The tenets

**1. The channel flow's only EXCLUSIVE power is denial.** A message it releases cannot be un-released,
so anything that must stop a message being delivered has to be there. Everything else it does is a
LATENCY CHOICE, not a capability, because the message stream can do it afterwards - including
dispatching a turn.

**2. Reserve the critical path for what cannot be done later.** Denial. Direction that a later
component could not reconstruct. Anything the turn genuinely cannot proceed without.

**3. A correction for a state that SHOULD NOT EXIST belongs off the critical path.** If a client is
responsible for addressing a message and does not, that is a client defect. Repairing it inline is
worse than leaving it visible, for a reason that outlives the defect: once the repair is inline, the
correct path and the broken path become indistinguishable, so nobody fixes the client and the repair
becomes the primary path by default.

**4. Post-processing sees everything, after the fact, without blocking.** The Kinesis mirror of the
message stream already carries every message and already has a consumer. Repair, detection,
measurement and archival belong there.

**5. The latency asymmetry is the whole argument.** A repair on the stream costs time ONLY in the
broken case. The same repair inline costs time in EVERY case, to buy nothing on the turns that were
already correct.

**6. A repair must be COUNTED, or it becomes the design.** A stream-side fix that silently succeeds is
indistinguishable from the defect not existing. It has to emit a signal that says how often it fired,
so the client defect stays measurable and someone can close it. A repair nobody can see is a permanent
one.

## The worked example, and it reverses an earlier direction

**A person answers a task in a shared conversation and addresses nobody.** Nothing runs. `InvokedBy`
routes on mentions, silence-by-default is right everywhere else, and their answer sits in the channel
while the workflow it would unblock stays blocked. Nothing errors; the conversation stops.

The direction taken earlier the same day was that the channel flow should notice and correct it. Two
things are wrong with that, and only the second is about architecture:

- **It is not buildable as stated.** A flow can neither read a `Target` (the callback delivers none) nor set one (`ChannelMessageCallback` carries `MessageId`, `Content`, `Metadata`,
  `PushNotification`, `MessageAttributes`, `SubChannelId`, and no `Target`).
- **It is the wrong place even where it is buildable.** The client knows which task the person is
  answering - it rendered it - so it can address the message correctly at send. A message arriving
  without that is a defect in the client, and tenet 3 applies.

So: **the client always addresses a task answer, and the stream repairs the cases where it did not.**
The repair dispatches the turn the same way every other entry does, so the person gets their answer
late rather than never, and the counter from tenet 6 says how often the client is getting it wrong.

**What the client stamps is the TASK ID, and nothing else.** Not the assistant: a task already records
`assistantId`, so a copy in message metadata would be a second source for one fact, free to disagree
with the row it describes. The repair reads the assistant off the task. That is also the cheaper
mistake to avoid - a wrong copy would not merely be corrected, it would dispatch a turn to the wrong
assistant, which hands over and sends the person a redirection receipt, where reading the task is one
point read on a path that only runs when something is already broken.

What the id carries cannot be derived, which is why it is there at all: it is the client stating that
this message ANSWERS a specific piece of work. Without it the trigger would have to be "the sender
holds an open task in this channel", and an ordinary remark would be annexed into work the person was
not talking about.

### What was built, and the two things it refuses to do

The composer addresses the message while something is waiting on this person HERE, and shows what it is
doing with a dismiss beside it - a person who wants to say something else in the room must be able to,
or every remark becomes an answer. What the person types always wins: an explicit mention, `@all` and a
slash command each take the branch away. In a 1:1 it does nothing at all, because Amazon Chime SDK's
AUTO trigger already routes every message to the assistant there.

**A task answer takes precedence over the sticky mention, because the chip and the send must agree.**
The banner renders "Answering <work item>" ahead of the sticky target, so when both exist the sticky
prefix stands down for that send: prepending it would set the mention target to the sticky human,
force the send out of the task-answer branch, and route the message to that person with no task id
while the UI said the opposite - the work item would stay blocked. The sticky target is not cleared,
only skipped; it comes back once the work item is answered or dismissed, exactly as the banner does
(`MessageInput.tsx`).

Post-processing then acts only on what arrived at nobody, and two of its refusals are load-bearing
rather than defensive:

- **An addressed message is never repaired.** A `Target` means the message reached that bot's Lex and
  the turn ran, including when the person addressed the WRONG assistant, which ADR-030 hands over. The
  failure this prevents is the expensive one, because it answers a person twice and both answers look
  correct.
- **The speaker must hold the task.** The hint is untrusted, so the row is read and its owner checked.
  This is the stream-side form of a refusal the router gets structurally: its person-owed lookup can
  only ever return a chain that person holds, and here the task was NAMED rather than found, so the
  question has to be asked out loud.

The assistant identity is derived from the channel ARN rather than stored, and it is still validated:
it goes to the turn as `TurnRequest.botArn`, which `isSanctionedBattleBot` checks against this
classification's own bot and the published alt-slot roster. A task carrying a junk or foreign
`assistantId` cannot make a handler answer as an arbitrary bot.

## Consequences

- The flow's converged state (`flow-does-not-run-the-turn.test.ts`, `entries: []`) is protected by a
  stated rule rather than by nobody happening to add anything.
- "The flow sees everything" stops being an argument for putting a rule there. So does the message
  stream, later, for free.
- A repair path is a measurement of a defect, not a feature. Tenet 6 is what keeps that true.
- Latency on the critical path becomes a thing that must be ARGUED for, against a default of "the
  stream can do this".

## How this gets proven

| Invariant | The test that can fail |
|---|---|
| The flow stays converged | `flow-does-not-run-the-turn.test.ts` with `entries: []`; any turn decision added to the flow fails it |
| A repair is counted | `task-answer-repair.test.ts` asserts the `Repairs` metric on the branch that repairs, so a silent fix cannot ship; `post-processing-wiring.test.ts` asserts the alarm exists |
| The repair dispatches through the same entry | `task-answer-repair.test.ts` asserts it invokes the router and posts nothing itself, so a repaired turn is not a second implementation of one |
| An addressed message is never repaired | `task-answer-repair.test.ts`: a message carrying a `Target` decides `addressed`. Getting this wrong answers one message twice, and both answers look correct |
| A bystander cannot advance someone else's work | `task-answer-repair.test.ts`: the speaker must hold the task, checked against the owner on the row |
| One stream delivery, one repair | `task-answer-repair.test.ts`: a durable claim per message id, since a Kinesis redelivery lands on whichever container is free |
| The client addresses what it renders | `MessageInput.task-answer.test.tsx`: a group-channel answer carries the target and the task id, and an explicit mention or a slash command takes it back |
