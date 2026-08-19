---
title: "ADR-024: One owner for a task, and the lookup that follows from it"
status: Accepted 2026-08-09 (all six decisions set; built and deployed 2026-08-10)
date: 2026-08-09
related:
  - "./023-battle-round-coordination.md"
  - "./026-task-shaped-battle-rounds.md"
  - "../../specs/capabilities/DESIGN-BATTLE.md"
  - "../../specs/interaction/conversation/CROSS-CHANNEL-TASKS.md"
  - "../../specs/interaction/conversation/SPEC-NOTIFICATION-BRIDGE.md"
  - "../../../backend/lambda/src/lib/task-tracking.ts"
  - "../../../backend/lambda/src/lib/task-notify.ts"
  - "../../../backend/lambda/src/lib/battle-state.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/analytics-aurora/schema/010-task-state-machine.sql"
  - "../../../backend/lib/stacks/foundations-stack.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
tracking: |
  BUILT AND DEPLOYED (all eight migration steps; see "The migration"). New rows carry
  `ownerId`/`ownerType` behind the single `setTaskOwner` writer, `createBattleTask` is deleted, the
  battle state row carries no `taskId`, and `channelArn-updatedAt-index` is live. Raised by the
  owner's task model: a task has a state and steps, is assigned to a human or an assistant, the
  assignment can change per step, and it can be owned by only one at a time. The pre-migration shape
  carried TWO ownership fields and enforced nothing, which blocked the battle work: dropping `taskId`
  from the battle state row (DESIGN-BATTLE 2a, ADR-023) requires a lookup for "the active task owned
  by this actor in this channel", the same question for a duelling assistant and for a person holding
  a work item. Decisions: the owner is the app-instance principal's unique id plus a stored type;
  ownership changes are entries in the existing `stateHistory` log; a task is visible to its
  conversation's current members whatever its owner, via the conversation-keyed index; a task stores
  what it requires of the message that started it - a bounded excerpt plus the user message id where
  one can be had - rather than a verbatim transcript; tasks stay in DynamoDB so every read works in
  Athena mode; and the mirror is re-partitioned by owner and stays a base table, the only shape that
  keeps the strongly consistent duplicate-task guard. Remaining by decision: the Lex path leaves
  `userMessageId` absent, and reassignment ships unwired.
---

# ADR-024: One owner for a task, and the lookup that follows from it

## Status

**All six decisions are set (owner, 2026-08-09), and the migration is built and deployed
(2026-08-10; all eight steps, see "The migration").**

| | Question | State |
|---|---|---|
| D1 | how an owner is represented | **decided:** the app-instance principal's unique id (R2) |
| D2 | where the owner lookup lives | **decided:** re-partition the existing mirror by owner, keeping it a base table (I1) |
| D3 | where ownership history goes | **decided:** the existing task log, `stateHistory` (H1) |
| D4 | who can see a task | **decided:** the conversation's current members, whatever the owner |
| D5 | what a task stores of the message | **decided:** what the task requires - a bounded excerpt, plus the id of the **user's** message that created it, resolvable or absent |
| D6 | where tasks live | **decided:** DynamoDB only. Every read works in Athena mode, and nothing goes to Aurora that DynamoDB already answers |

Nothing gates the migration now. D2 turned on one trade and it was settled in favour of keeping the
strongly consistent duplicate-task guard.

## Context

The owner's model: *"tasks should have a state, steps, and can be assigned to humans or assistants.
this can change depending on the step, but can only be owned by one at a time."*

The current shape cannot express it, and the reason is structural rather than a missing check.

### What existed at decision time

The shape below is the PRE-MIGRATION state this ADR was decided against; the migration has since
replaced it (new rows carry `ownerId`/`ownerType`, and `createBattleTask` is deleted).

Two tables, both defined in `foundations-stack.ts:63-100`, and all access to both is contained in
`lib/task-tracking.ts` (verified at decision time: no other file under `backend/lambda/src` reads either table):

| Table | Key | Indexes | Role |
|---|---|---|---|
| `AgentTasksTable` | PK `taskId`, SK `channelArn` | `contextId-index` (sparse, plan cascade) | source of truth |
| `UserTasksTable` | PK `userSub`, SK `taskId` | `userSub-taskType-index` | active-task lookup, a mirror |

Three fields carry something ownership-shaped on `Task` (`task-tracking.ts:108-160`):

- **`userArn`** - the requester. Always set. Its derived sub is the mirror's partition key at create
  time (`task-tracking.ts:275-277`).
- **`assigneeUserSub`** - the human owner. Set by exactly one caller, and it sets it to the
  requester: `router-agent-handler.ts:1721-1727` assigns an `action_item` to whoever asked for it.
- **`assignedBotArn`** - the assistant owner. Set by exactly one caller, `createBattleTask`
  (`task-tracking.ts:321-368`).

**Two fields for one concept means "owned by one at a time" is not representable, let alone
enforced**, and there is no notion of ownership changing at a step boundary. `stateHistory`
(`task-tracking.ts:56-63`) records who requested each transition (`tool` or `system`) but never who
owned the task across it.

### Four things found while grounding this ADR

Stated because a migration that does not address them ships reassignment broken. **All four are since
fixed by the migration**: findings 1 and 2 by the owner re-partition (one id to key on, migration step
3), finding 3 by `reassignTask` replacing the uncalled `updateTaskAssignee` as a deliberate, tested,
documented affordance (step 5), and finding 4 by `createBattleTask` collapsing into `createTask` with
an assistant owner, so battle tasks enter the mirror. As found, **three of the four
were latent rather than live**, and they were latent for one reason only: the single assignee-setting
caller set the assignee to the requester, so the two ids coincided.

1. **The mirror is partitioned by the REQUESTER at create and by the ASSIGNEE afterwards.**
   `createTask` writes the mirror row under `userArn`'s sub (`:275-277`) even when
   `opts.assigneeUserSub` is supplied, while `mirrorTaskStatus` (`:679-694`),
   `cancelTasksForStop` (`:652`) and `updateTaskAssignee` (`:757`) all prefer `assigneeUserSub`. The
   two writers disagree about which partition the row lives in.
2. **The status mirror is an upsert, so the disagreement creates a second, partial row.**
   `mirrorTaskStatus` issues an `UpdateCommand` keyed on the assignee's partition; if no row is there
   it creates one carrying `status` and `updatedAt` and nothing else. That row has **no `ttl`, so it
   never expires**, no `taskType`, so it is absent from `userSub-taskType-index`, and no
   `channelArn`, so the channel-scoped filter drops it. Meanwhile the requester's row keeps the stale
   status, and `getActiveTask` reads status off the mirror.
3. **`updateTaskAssignee` has no callers.** It is exported, carefully written, and referenced by
   nothing in `backend/` (source or test). **Per-step reassignment does not exist today**; the
   function is the shape a future caller would use, not a working path.
4. **A battle task is in neither index.** `createBattleTask` deliberately skips the mirror
   (`:315-320, :366`) because two bots on one user and one task type collide on
   `userSub-taskType-index`. So there is no "active task owned by this assistant" lookup at all, and
   the battle state row's `taskId` is the stand-in for one.

**"Battle task" is a category that should not survive this.** A battle is not a task (DESIGN-BATTLE
§2a); a battle *turn* may open one because its intent was task-shaped, and that task then proceeds on
its own. What actually distinguishes those rows is that **an assistant owns them** - which is the
whole of D1. Under one owner field, `createBattleTask` collapses into `createTask` with an assistant
owner, and the separate constructor goes with it.

**A duel side DOES continue the chain it owns** ([ADR-026](./026-task-shaped-battle-rounds.md), owner
2026-08-10). This paragraph used to cite a never-continue rule (`dd909a7`) as a second distinguishing
characteristic. That rule was written when the only lookup available asked about the USER,
where continuing would have absorbed the person's unrelated open task. Asking by OWNER - the whole of D2 -
removes the hazard the rule existed for: a duel side's `getActiveTaskForOwner` result is that side's own
chain, never the human's and never the rival's. The rule then became actively harmful, because it made a
resumed side restart its state machine from step 0 every turn. Continuing is now the behaviour, and the
separate constructor being a second creation door is precisely what kept the wrong branch first. **Whether `battleId` should stay on the task row is then a live question**
and the answer looks like no: which duel a turn belonged to is battle state's business, the per-side
collision is prevented by the owner rather than by the battle id, and a task carrying it is the same
fusion §2a removed everywhere else. Worth settling when the constructor is collapsed, not before.

### Why this blocks the battle work

DESIGN-BATTLE §2a settles that battle state is not task state, so the battle row carries no `taskId`.
The two resume paths that read that field to find a duelling side's task chain are
`planBattleResume` and `resumeBotFromWaiting`, both in `lib/battle-state.ts` (`:722` and `:432`
respectively; the latter is called from `channel-flow-processor.ts:904`). Removing the field leaves
them with no lookup - unless one exists that answers **"the active task owned by this actor in this
channel"**, which is the same question for a duelling assistant and for a person holding a work
item. One index then serves both, and the battle row needs nothing.

`planBattleResume` is retired by the continuation handoff: the flow no longer plans a delivery option,
so nothing calls it, and `flow-does-not-run-the-turn.test.ts` pins the symbol out of the flow.

**The index that was nearly built was the wrong shape.** `userSub-botArn-taskType-index` would have
been a battle-specific index standing in for a general ownership concept, and it would have kept the
`(user, taskType)` collision alive by adding a bot to the key rather than replacing the subject.

## What must be true of any answer

- **One owner, structurally.** Not two fields plus a rule. A second field is a second source of
  truth, and the finding above is what that costs.
- **The owner can be a human or an assistant, distinguishable without parsing the id.** Today's ids
  are already heterogeneous: an `AppInstanceUserId` is a raw pool sub for a native user, a `fed_`
  one-way hash for a federated one (`backend/lambda/src/membership-audit.ts:94`), and an assistant is a `/bot/` ARN.
  Deciding "is this a person?" by inspecting the string is a rule that breaks the first time an id
  format changes.
- **Ownership can change at a step, and the change is recorded.** The append-only log already exists
  for state; ownership belongs in the same record or beside it, or a reassigned task loses its
  history of who held it.
- **"The active task owned by this actor in this channel" is ONE lookup**, with the same shape for
  both actor types.
- **Visibility is scoped by conversation membership, not by ownership (owner, 2026-08-09).** Every
  task in a conversation is visible to that conversation's current members whatever its current
  owner. **Ownership decides who must act next; it never decides who can see.** See D4 - this is a
  second lookup, and no option below provides it.
- **The duplicate-task guard survives.** `getActiveTask` falls back to a **strongly consistent
  base-table read** (`:412-417`) precisely because the GSI is eventually consistent and a rapid
  follow-up turn would otherwise start a second `data_extraction` or `report_generation`. That guard
  works only because the mirror's **base table** is partitioned by the subject of the lookup. **A
  global secondary index can never be read consistently**, so any answer that moves the owner lookup
  onto a GSI gives this up and pays for it in duplicated model calls.
- **Existing tasks keep working across the change.** Plan tasks carry `TRIP_TASK_TTL_SECONDS`, about
  200 days (`:196`), so "wait for the rows to expire" is not a migration strategy.
- **The requester is not the owner.** They coincide today by default. A battle task already
  separates them (`userArn` is the person who ran `/battle`, `assignedBotArn` is the side that owns
  the chain), so the distinction is real before any of this is built.

## D1. How an owner is represented (owner decision, 2026-08-09: DECIDED, R2)

**The owner is the app-instance principal's unique id.** Not an ARN, not a composite key, not a
type-prefixed string: the bare unique id, the same identifier the channel membership uses.

**One point of precision, because the wording matters at the assistant end.** AE's assistants are
**`AppInstanceBot`s**, not `AppInstanceUser`s (`assistant-profile-stack.ts:1077, 1104`;
`battle-stack.ts:237` for the alt slots), and the two are sibling resource types under one app
instance. So the decision reads as *the app-instance principal's* unique id: an `AppInstanceUserId`
for a person, an `AppInstanceBotId` for an assistant. It is not a humans-only rule, and reading it
as one would put ownership back where it started.

**This is R2, and it makes the backfill an attribute addition.** Existing mirror rows are already
keyed on exactly this value (`task-tracking.ts:276`, `userArn.split('/user/').pop()`), so no live row
is re-keyed - which is what a 200-day plan TTL demanded.

**`ownerType` is still required, and it follows from the decision rather than qualifying it.** The
unique id alone **cannot be turned back into an ARN**, because the ARN needs `/user/` or `/bot/` in
its path, and an ARN is what every Amazon Chime SDK call takes. It is not that inferring the type from the id
would be fragile; it is that the id does not contain the information at all. So the stored pair is
`ownerId` (unique id, opaque) plus `ownerType` (`'user' | 'assistant'`), and the ARN is reconstructed
as `${appInstanceArn}/user/${ownerId}` or `${appInstanceArn}/bot/${ownerId}`.

**Consequently ruled out:**

- **R1, one composite key string** (`user#<id>`): the type would be inside the key and could not be
  lost, but every existing row is keyed on a bare id, so it is a **re-key** of live data - a backfill
  plus a read-both window rather than an expiry, against a 200-day TTL.
- **R3, store the member ARN and read the type from its path**: it makes the ARN prefix load-bearing
  for a correctness decision, and it stores a derived value next to the id it is derived from.

**The one thing to hold at the writer:** `ownerId` and `ownerType` are two attributes for one fact,
so "`ownerType` is always present" is a writer rule rather than a structural guarantee. One
constructor and no direct writes is what makes it hold, and all task access already sits behind a
single module.

## D2. Where the owner lookup lives

### I1. Generalize the mirror: its partition key becomes the OWNER (recommended)

The mirror's PK holds the owner id rather than the requester's sub, battle tasks are mirrored too,
and the lookup is a base-table query on the owner with a channel filter.

- **For it:** it is the only option that keeps the strongly consistent recheck, because the subject
  of the lookup stays a **base-table** partition key. It also collapses the resume path from **three
  GSI queries per turn** (`router-agent-handler.ts:1333-1338` loops over three task types, each of
  which can fall through to a second consistent read) to one query on the owner.
- **Against it, and it is the real cost:** the table's partition key attribute is literally named
  `userSub`, and **DynamoDB cannot rename a key attribute**. Either an assistant's id is stored in a
  field called `userSub` - drift-inviting, and exactly the sort of thing that reads as a defect two
  sessions later - or the table is replaced (I3).

### I2. A GSI on `AgentTasksTable` keyed by owner

`PK ownerId`, `SK channelArn`, on the source of truth, and the mirror stops being the answer.

- **For it:** one table, no mirror to keep consistent, and the mirror's split-brain finding above
  disappears rather than being fixed.
- **Against it:** a GSI cannot be read consistently, so the duplicate-task guard is lost. That guard
  exists because losing it doubles the cost of the two most expensive intents.

### I3. A new owner-keyed table, replacing the mirror

`PK ownerId`, `SK taskId`, plus `ownerType`; the current mirror is backfilled into it and retired.

- **For it:** keeps I1's consistency property and gets an honestly named key. The clean end state.
- **Against it:** the largest change - a new table, a backfill of live rows, a dual-write or
  dual-read window while both exist, and a retirement step that is easy to leave half-done.

### I4. Add `ownerType` only, and change no keys

The minimum. Ownership becomes readable but the lookup does not change.

- **Against it:** the battle lookup still has no answer, so the work this unblocks stays blocked.
  Recorded because it is the tempting small step, and it buys nothing that is needed.

| | Owner lookup | Consistent recheck survives | Battle tasks findable | Live-data migration |
|---|---|---|---|---|
| I1 | base-table query on the mirror | **yes** | yes | backfill in place, key attribute misnamed |
| I2 | GSI on the source of truth | **no** | yes | new GSI only |
| I3 | base-table query on a new table | **yes** | yes | new table plus backfill and cutover |
| I4 | unchanged | yes | **no** | none |

## D3. Where ownership history is recorded (owner decision, 2026-08-09: DECIDED, H1)

**Ownership changes are entries in the task log, which already has a home:** `Task.stateHistory`
(`task-tracking.ts:118`), the append-only log of SPEC-TASK-STATE-TRANSITIONS §6, appended at
`:940` and projected into Aurora per turn. No second log (H2) and not nothing (H3).

**What that requires of the entry shape, because an ownership change is not a graph edge.** A
`StateTransition` is `{from, to, at, by, reason?, messageId?}` where `from` and `to` are declared
machine states. Two additions:

- Every entry carries the **owner in force**, so each state edge is attributable to whoever held the
  task when it was traversed.
- An ownership change is recorded with **`ownerFrom` / `ownerTo`, leaving `from` and `to` absent**,
  rather than reusing `from`/`to` behind a discriminator. A consumer that reads `from` then gets
  nothing rather than a principal id in a field every other reader treats as a state name. Fail to
  read the discriminator and you get an absent value, not a plausible wrong one.

**Two live consumers make this concrete, and both are ways a reassignment could silently corrupt
task analytics if it is appended through the state path:**

1. **The projected edge.** `taskTransition` is the **net** edge over the turn's in-memory
   `transitions` array, `{from: transitions[0].from, to: transitions[last].to}`
   (`async-processor-core.ts:2424-2428`, pushed at `:1677`), and it lands in Aurora as
   `exchanges.task_transition`, whose declared meaning is "the authorized edge this turn applied"
   (`schema/010-task-state-machine.sql`). Push a reassignment into that array and the projected edge
   spans an owner id and a state name, so the Effectiveness L3 timeline shows an edge that never
   happened.
2. **The stall signal.** That same array is the test for "the tool advanced the task this turn"
   (`async-processor-core.ts:3028, :3050`), which is what clears `turnsInState`. A reassignment
   counted there clears the stall counter, so a task that was handed over but never progressed reads
   as progressing - and `turnsInState` is precisely the signal the deferred chaser idea would run on.

**So the append is its own write.** `advanceTaskStateTo` couples the log append to `taskState = :to`
and `turnsInState = 0` under an optimistic condition on `from` (`:936-962`). An ownership entry goes
through a separate append that touches neither, and does not enter the turn's `transitions` array.

**One bound to set while adding a writer to this log.** `stateHistory` grows by `list_append` with
**no cap and no trim anywhere** (`:940`), on an item that can live about 200 days
(`TRIP_TASK_TTL_SECONDS`), against DynamoDB's 400KB item limit. The log is already unbounded; D3 adds
a second class of writer to it. A long-lived plan task that is reassigned repeatedly is the shape
that reaches the limit first, and an item that hits it fails the **write**, which on this path is the
transition itself. Either cap the retained entries or state the expected ceiling; do not add the
writer and leave the bound unexamined.

## D4. The conversation-scoped read (owner decision, 2026-08-09: settled in principle, unbuilt)

**Tasks are visible to the current members of their conversation regardless of who owns them.** The
principle is decided; what it needs is not built, and it is worth being exact about how far from
built it is.

**There is no conversation-keyed read of tasks today.** `AgentTasksTable` is PK `taskId`, SK
`channelArn` (`foundations-stack.ts:63-65`), so the channel is a **sort** key and cannot be queried
on its own. Nothing anywhere asks "the tasks in this conversation":

- `getActiveTask` keys on the subject and applies `channelArn` as a post-read **filter**
  (`task-tracking.ts:439-442`), so it can only narrow one actor's tasks to a channel.
- `getActiveTasksForUser` queries the mirror by user across all channels (`:493-504`).
- `contextId-index` is the closest thing and answers a different question for a subset: it is
  **sparse** (only work-item tasks carry `contextId`) and keyed by **plan**, which is deliberately
  cross-conversation, not by conversation.
- `scanActiveDueTasks` is a full **Scan** (`:816-836`), which is what a missing index looks like.

**Where it goes, since the ADR is precise elsewhere and an implementer should not have to guess:** on
`AgentTasksTable`, the source of truth, because the mirror has no conversation partition to hang it
from and a conversation's tasks span owners. `PK channelArn`; the sort key wants to make "what is
**open** here" cheap, so `status` or `updatedAt` rather than `taskId`, and the choice is worth one
measurement rather than a coin toss. It is not sparse: every task has a `channelArn`.

So this requirement is a **second index**, `PK channelArn`, orthogonal to D1 and D2: every option
above fails it equally, and whichever wins pays for this one too. The two reads then split cleanly
by question - **by owner, "what must I act on"; by conversation, "what is open here"** - and the
owner lookup stops being asked to do double duty, which is what the channel filter on
`getActiveTask` is today.

**This settles the resume-subject question in the migration below, and it splits it in two.** Read
scope is the conversation, so a member who owns nothing still sees the conversation's tasks and the
assistant can speak about them. Whether a turn **advances** a task someone else owns is the separate
question, and ownership is what answers it.

**The confidentiality boundary is unchanged, and that is why this is safe.** A task's
`userMessage` and `details` carry conversation content, and the conversation already is the boundary
(membership plus channel classification). A task inherits that boundary rather than being narrowed
further by who happens to hold it. **Membership is read live, never from a stored roster copy**, and
the cross-conversation hint stays deliberately terse (counts and task types, no content:
`task-tracking.ts:515-560`), because that one crosses the boundary and this one does not.

**"Current" is doing real work in that sentence, so state both edges.** Visibility follows membership
**at read time**, not membership at task creation: someone who joins later sees the tasks already
open in the conversation, and someone removed from it stops seeing them. That matches how the
conversation's own history already behaves, which is the reason it is the right rule, but the
alternative reading - members as of creation - is a different feature and should not be arrived at by
accident.

### What D4 exposes: the task record, not the text behind it

**The mechanism first, because the risk is easy to state and easy to overstate.** A task row keeps a
**verbatim copy** of the message that started it (`Task.userMessage`, set from the transcript at
`task-tracking.ts:249`), and `details` accumulates what the task collected since. Redaction removes a
message's content from the conversation, but nothing under `lib/task-*` participates in redaction, so
that copy is untouched. Today it only ever surfaces on the requester's own turn. **Widen the read to
every member and the assistant could surface text from a message the user watched disappear.**

**A cascade is also impractical here, and for a concrete reason.** Following a redaction through to
the task would mean finding the task from the redacted message, and there is no dependable mapping:
on the router path `Task.messageId` holds the turn's **correlationId, not an Amazon Chime SDK message id**
(`router-agent-handler.ts:1729-1731`), which is documented at the call site and is a correlation key
by design. **D5 addresses the copy itself rather than the cascade**, and shrinks what is at stake
here from a full transcript to a bounded excerpt.

**So the question is smaller than it first looks: does conversation-scoped visibility expose the
task's stored text, or only the task record?** Recommended answer, and it is the same one the
prompt-context consequence already reaches independently: **the record only** - type, state, owner,
due date, and whether it is open. The stored copy stays exactly as reachable as it is today, which
means **nothing has to cascade**, because D4 grants sight of a task, not of the message behind it.
The narrow read is also the cheaper one to build.

**What choosing the other way would cost, stated so the choice is real:** exposing the text needs a
redaction-aware read, and that needs a message-to-task mapping this data model does not have.

## D5. What a task stores of the message that started it (owner decision, 2026-08-09)

**A task stores what the task requires. It does not require the full text, and it turns out barely to
use it.**

**`Task.userMessage` has exactly one consumer**, `buildTaskContextForPrompt`
(`task-tracking.ts:1141-1159`), and it reads **`.substring(0, 200)`**. Every other `userMessage` in
the codebase is the *event's* field - the live turn's message on its way to the processor - which is
a different thing that happens to share a name. So the row stores an unbounded verbatim transcript
and 200 characters of it are ever read.

**Storing a bounded excerpt is therefore not a trade, it is a strict reduction.** At the excerpt
length the single consumer already truncates to, the prompt it builds is byte-identical, so there is
no behaviour to preserve and nothing to weigh against the smaller copy. Name the length beside that
consumer rather than repeating a bare `200` at the writer, or the two drift and the excerpt silently
stops matching what is read.

**`details` stays as it is.** It holds what the task collected - the task's own state, not a copy of
somebody's message - which is exactly the "what the task requires" test.

### The pointer is the USER's message, and it must be available

**The requirement (owner): the task carries the id of the user's message that created it.** Not the
assistant's response, and not a correlation key that labels the assistant's placeholder - which is
what `Task.messageId` holds today, and the reason the distinction has to be stated rather than
assumed.

**The concept already exists and is already named.** `TurnRequest.userMessageId`
(`router-agent-handler.ts:645, 753, 788`) is exactly this: the inbound user message id, declared by
callers that hold one. Today it is consumed only to derive a correlation id (`:1499-1503`) and then
dropped. **On `@all` and `/battle` the handler is already holding the user's message id at the moment
it creates the task**, so storing it there is a field, not a mechanism.

**On the ordinary Lex path it is absent in both places you would look, and that is the whole
difficulty:**

- The handler receives **exactly three request attributes** from Amazon Chime SDK - channel arn, sender arn, lex
  platform - and the message id is not among them (`router-agent-handler.ts:1484-1486`). This is why
  `Task.messageId` holds a correlation id there: an absent input, not an oversight.
- The processor does not have it either. Its `messageId` is the **assistant's placeholder**, which it
  resolves from the correlation mapping and then updates in place (`async-processor-core.ts:2128-2159`).
- The flow sees the user's message and its id, but the control row it writes
  (`claimPlaceholderMapping`, `channel-flow-processor.ts:270`) is claimed when it sees the
  **assistant's placeholder** carrying `<!--corr:...-->`. It never learns which correlation id belongs
  to which user message, because the handler derives that id from the turn.

**So on the ordinary path the id must be recovered rather than received.** Four ways, and one cost
decides between them:

| | How | Cost |
|---|---|---|
| A | the handler resolves it synchronously (list recent messages, match sender and content) | it sits **in front of the placeholder**, and TTFF is already about 4.5s against a 1s target with the overage in the inbound hop. Also ambiguous when a user sends the same text twice |
| B | the processor resolves it after the placeholder and attaches it in a second write | off the critical path, and the scan already exists - the processor scans recent messages to find its own placeholder (`:600-611`) and would look for the newest non-bot message from the sender instead |
| C | the flow declares it | needs a keying story first: on this path the flow cannot tell which correlation id belongs to which user message. Not simply "add a field" |
| D | take it from the archive | the exchange already pairs user and agent messages at no runtime cost, but it lands seconds later and only in Aurora, so a runtime reader still has nothing |

**Recommended: B**, with A ruled out on TTFF grounds rather than on taste. A task whose turn dies
before the stamp lands then has no pointer, which is the correct degradation.

**The invariant that matters more than the mechanism:** the field is **either a resolvable user
message id or absent**. It is never filled with the correlation id as a fallback. That substitution
is exactly what produced today's misleading `Task.messageId`, and repeating it would launder a
correlation key into a field readers will follow.

**So two fields rather than one overloaded one, and `Task.messageId` does not survive:**

- `correlationId` - always present, derived when it cannot be declared. What ties the task to the
  rest of its turn.
- `userMessageId` - the resolvable Amazon Chime SDK message id of the user's message, or absent. What a reader
  can actually follow back.

A field named `messageId` that holds a correlation key on the path that creates most tasks will
mislead every future reader; the comment at the call site (`router-agent-handler.ts:1729-1731`)
exists because it already has.

**What this does to the redaction question above:** the residue shrinks from a full transcript to a
bounded excerpt, and D4's read exposes no text at all, so no non-owner can reach even the excerpt.
Where a `userMessageId` exists, a reader resolves the live message and gets its redacted state rather
than a stale copy, which is the outcome a cascade was reaching for without the cascade.

## D6. Tasks stay in DynamoDB, and so does cross-conversation context (owner decision, 2026-08-09)

**Tasks stay in DynamoDB, and ownership is not projected into Aurora at all.** Aurora is a deployment
mode and the default is `athena` (`backend/bin/backend.ts:69-70`), with precedent that
Aurora-requiring features go inert in the other mode (`enableLiveDrift`). Every task read named below
is a key-value read that DynamoDB already answers, so there is nothing for a second store to add.

**The rule, stated so it is not re-litigated per feature: do not put a task read in Aurora when
DynamoDB already answers it.** The cost is not the column, it is the second copy - a projection lags,
so it invites a live decision being made from stale ownership, and it splits a feature across two
stores where one deployment mode has only one of them.

**Consequence, accepted:** ownership reaches no dashboard. "Who held this task when it stalled" is
answerable only from the DynamoDB log. If that is ever wanted in the console it is a separate
decision, made on its own merits rather than absorbed into this one.

**Cross-conversation task context already works, and it is DynamoDB-only.**
`getActiveTasksForUser` is a Query on the mirror's **partition key**, no GSI and no scan
(`task-tracking.ts:484-513`), and `buildCrossChannelTasksHint` (`:533-560`) turns it into a terse
prompt fragment - counts and task types, no content, current conversation excluded - injected at
`assistant-async-processor.ts:680-688`. That read exists **only because the mirror is partitioned by
the subject**: `AgentTasksTable` is PK `taskId` / SK `channelArn`, so "this actor's tasks everywhere"
is a scan without it. It is also an argument for D2 keeping a subject-partitioned base table.

**What D1 and D2 change here is the meaning, not the mechanism.** Keyed by owner, this read becomes
*"work I hold, everywhere"* rather than "tasks whose mirror row happens to sit under me" - which,
per finding 1, is the requester at create and the assignee afterwards. It sharpens a read that is
currently ambiguous.

### Three reads, two indexes

| Read | The question | Index | What it exposes |
|---|---|---|---|
| owner, across conversations | what must I act on | owner (base-table PK) | counts and types only, never content - it crosses the conversation boundary |
| conversation, all owners | what is open here | channel (D4) | the task record, no stored text |
| owner within a conversation | what does this turn resume | owner, channel-filtered | full task context, to its owner |

**Two consequences, stated because neither is a refactor:**

- **A task you created but no longer own leaves your cross-conversation hint**, and stays visible to
  you in the conversation where it lives. Correct under "owner is who must act next", and a second
  behaviour change on top of the resume one.
- **Battle tasks enter the mirror for the first time** (`createBattleTask` skips it today), so an
  assistant gains a cross-conversation view of its own work. **Nothing consumes it yet**, and that is
  precisely the shape a queue consumer would read.

**What stays Aurora-only is semantic context, not task context.** Drift and similar-conversation
detection need pgvector and already require `analyticsMode=aurora`. Cross-conversation *task* context
is a key-value read and does not follow them.

### On queuing, since ownership is half of it

Recorded so the distance is measured rather than assumed. After D1, D2 and D4 the model is
queue-**shaped**: the owner index is "this actor's queue", `status` and `dueBy` are eligibility, and
the log is the audit trail. **It is not a queue, and the gap is larger than it looks:**

- **Nothing consumes.** `scanActiveDueTasks` and `markTaskReminded` have **no callers** anywhere in
  `backend/`, and there is no scheduled rule for one. The comment at `task-tracking.ts:157-159`
  saying "the scheduled reminder uses it" describes an intent, not a wiring, and should be corrected
  rather than inherited.
- **Nothing enqueues outside a turn.** Both creators are turn-triggered and the only task tool is
  `advance_task_state`. A queue that can only be filled by a live user turn is a per-turn record.
- **No discipline.** `getActiveTask` returns the most recently updated active task of a type, and the
  model is one active per `(owner, taskType)` - a slot, not a backlog. No ordering, no lease, no
  redelivery. The one-owner invariant is the nearest thing to a lease and it never expires.

**So this ADR makes queuing possible and does not make it exist.** What is missing is an actor and a
discipline, which is the deferred chaser question seen from the other side.

## D2 decided (owner, 2026-08-09): I1, the mirror re-partitioned by owner

**The mirror keeps being a base table and its partition becomes the owner.** The reasoning is a single
trade: the strongly consistent recheck is a real guard against a real cost (a duplicated
`data_extraction` or `report_generation`), and it can only be kept by leaving the subject of the
lookup as a **base-table** partition key. Three things follow at no extra cost - cross-conversation
is the same partition query (D6), the backfill is an attribute add rather than a re-key because D1's
id is what those rows already hold, and the resume path collapses from up to three GSI queries per
turn (`router-agent-handler.ts:1333-1338`) to one.

**I2 is ruled out on the guard**, not on taste: a global secondary index can never be read
consistently, so an owner GSI on the source-of-truth table drops the duplicate-task protection
silently and pays for it in repeated expensive model calls.

**The cost is accepted and must be written down where it will be seen.** The mirror's partition key
attribute is named `userSub` and **DynamoDB cannot rename a key attribute**, so an assistant's id
lives in a field called `userSub`. It is contained - all task access sits behind one module - but it
is visible to anyone reading the table in the console, which is exactly where it misleads. The field
carries a comment saying what it actually holds, and **I3 (a new owner-keyed table) stays the honest
end state** if that name is ever judged worth a migration: same behaviour, correct key, at the cost of
a table, a backfill, a dual-write window and a retirement step that is easy to leave half-done.

**D4's conversation index is independent of all of this**, so it can land in parallel rather than in
sequence.

**Correction, made while building it:** an earlier draft of this ADR said that index also retires the
`scanActiveDueTasks` Scan. **It does not.** That sweep is global - every plan, every channel, filtered
on `dueBy` - and a `channelArn`-partitioned index cannot answer a cross-channel question without
querying every channel. What retires it is a **sparse `dueBy` index**, which the code comment at
`:811-815` already names as the scale path and which is a different index. It is also moot today,
since nothing calls the Scan.

## The migration

**Status: ALL EIGHT STEPS BUILT AND DEPLOYED.** `channelArn-updatedAt-index` is live on the
agent-tasks table (`IndexStatus: ACTIVE`), read back off the deployment rather than inferred from a
successful stack update. The ownership rules are pinned by `task-ownership.test.ts`,
`battle-task.test.ts` and `battle-continuation-keeps-its-variant.test.ts`, the last of which exists
because swapping the battle task lookup from the bot owner to the human passed every other test in the
repo. The four-shard backend suite has not been run to completion on the settled tree.

In order, and the first two are prerequisites rather than steps:

1. **One writer.** A single `setTaskOwner` used by `createTask`, `createBattleTask` and reassignment,
   which is where the one-owner invariant is enforced and where `ownerId` and `ownerType` are only
   ever written together (D1). `assignedBotArn` and `assigneeUserSub` become derived reads during
   the transition and are then deleted.
2. **Backfill.** Existing rows get `ownerType: 'user'` and keep their id untouched, since it is
   already the app-instance principal's unique id. Battle tasks get `ownerType: 'assistant'` with
   `ownerId` taken from `assignedBotArn`'s **last ARN segment**, not the ARN, and are written into
   the mirror for the first time.
3. **Fix the split partition** (finding 1) and **the ttl-less upsert** (finding 2) as part of the
   move, not after it. Under one owner they cannot recur, because there is one id to key on.
4. **Repoint the battle lookup.** `planBattleResume` takes the owner lookup; `taskId` leaves the
   battle state row; `resumeBotFromWaiting` stops reading it.
5. **Reassignment ships as a forward-looking affordance, unwired (owner, 2026-08-09).** It is not
   needed yet and is expected soon, so `reassignTask` replaces `updateTaskAssignee` and waits for a
   caller rather than being deleted and rebuilt. **This is not finding 3 repeating**, and the
   difference is worth stating because the two look identical from outside: finding 3 was uncalled by
   accident, undocumented and untested, so nobody could tell whether reassignment worked or had
   simply never run. This one is uncalled on purpose, says so at the definition, and is covered by
   tests. When a caller arrives it also decides whether the hand-off announces itself.
6. **Split the resume subject from the read subject (D4).** Today `getActiveTask` is called with the
   **sender's** sub (`router-agent-handler.ts:1335`), so one lookup serves both "what can I see" and
   "what do I resume". Under D4 they separate: the conversation index answers what is open here, and
   ownership answers what this turn advances. A task assigned to someone else stops being resumed
   when its creator speaks, and stays visible to them throughout. **That is a behaviour change, and
   it is the point rather than a side effect** - a member seeing work they do not own is the
   requirement.
7. **Add the conversation index** (`PK channelArn`, D4), and repoint the visibility reads onto it.
   It is a separate index from the owner one and neither substitutes for the other. Sorted by
   `updatedAt`, which is a judgement rather than a measurement: recency answers "what is open here"
   in one ordered query, where a `status` sort key needs one query per active status and still does
   not order them.
8. **Bound what the row stores of the message (D5)**, split `Task.messageId` into `correlationId` and
   an optional `userMessageId`, and have the bypass paths store the id they already hold. Existing
   rows keep whatever they hold: the prompt builder reads the excerpt or falls back to the old field.

   **Built, with one part deferred and named rather than quietly skipped:** the bypass paths declare
   the user's message id, and the Lex path leaves it **absent**. Recovering it there needs the
   processor's second write (option B), which is a separate change on a different path; absent is the
   honest value in the meantime, and the invariant that it is never the correlation id standing in is
   what the test pins.

### What is left

**Nothing in the migration.** Two things it deliberately did not do, named so they are not mistaken
for oversights:

- **The Lex path leaves `userMessageId` absent.** Recovering it needs the processor's second write,
  which is a separate change on a different path.
- **Reassignment has no caller**, by decision (step 5).

**Half of step 6 turned out to be already done**, and the reason is worth keeping: the resume lookup
is keyed by the sender, and once the mirror was re-partitioned by owner that same call means "the
task this actor OWNS" rather than "the task whose mirror row happens to sit under them". The subject
moved with the partition rather than needing its own change.

## How this gets proven

**Three existing suites pin the two-field shape and move with the migration rather than after it**,
so they are part of the change and not follow-up work: `test/lib/battle-task.test.ts` (nine
references, the assistant half), `test/lib/task-tracking-cross-channel.test.ts` (seven, the mirror
and its GSI) and `test/lib/task-tracking-interrupt-resume.test.ts` (the pause/resume mirror path,
which is where finding 2 lives). Deleting `assignedBotArn` and `assigneeUserSub` without them is how
a green suite stops meaning anything.

| Invariant | The test that can fail |
|---|---|
| One owner at a time | Set an assistant owner on a task that has a human owner; assert the writer rejects it. Reintroduce a second ownership field and it must go red |
| Owner type is not inferred from the id | Own a task with an id that looks like the other type (a `fed_` id, a bare sub); assert the type is read from `ownerType` alone, and that the ARN rebuilt for an Amazon Chime SDK call takes its `/user/` or `/bot/` segment from it |
| An owner is a unique id, never an ARN | Assert a stored `ownerId` contains no `arn:` prefix and no path segments, including on a battle task backfilled from `assignedBotArn` |
| A reassignment is not a state edge | Reassign without advancing; assert `stateHistory` gains an entry with `ownerFrom`/`ownerTo` and no `from`/`to`, that `taskState` is unchanged, and that **`turnsInState` is NOT cleared**. Route the append through the state path and the stall signal must go red |
| A reassignment projects no edge | Assert the turn's `taskTransition` is absent, so `exchanges.task_transition` stays null and the L3 timeline shows no edge |
| Every state edge names its holder | Advance a task, reassign it, advance again; assert the log attributes each edge to the owner in force at the time |
| One lookup, both actor types | The same query returns a duelling assistant's task and a person's work item, differing only in the owner passed |
| The duplicate guard survives | Two turns within the GSI's replication window; assert the second continues the existing task. Move the lookup to a GSI and it must go red - this is the test that decides D2 |
| Reassignment moves the row and leaves nothing behind | Reassign, then assert exactly one mirror row exists, under the new owner, carrying `ttl`, `taskType` and `channelArn`. Findings 1 and 2 are both red against this today |
| Ownership history survives reassignment | Reassign mid-chain; assert the log names both holders and the step at which it changed |
| A battle side's task is findable without `taskId` | Drop the field from the row; assert the resume still finds the chain |
| Migrated rows keep working | A pre-migration row with no `ownerType` resolves to its human owner and stays resumable |
| A member sees work they do not own (D4) | Two members, one task, owned by the other; assert the non-owner's turn sees it. Key the visibility read by owner and it must go red |
| Cross-conversation follows the owner (D6) | Reassign a task to another member; assert it leaves the creator's cross-conversation hint, appears in the new owner's, and stays visible to both in the conversation it lives in |
| Every task read works without Aurora (D6) | Run the owner, conversation and cross-conversation reads with no Aurora configured; assert all three answer. Take any of them through the projection and it must go red in Athena mode |
| Visibility stops at the conversation | A member of conversation A queries; assert conversation B's tasks are absent, and that the cross-conversation hint still carries counts and types only, never content |
| The conversation read exposes no stored text | A non-owner's turn reads a task whose excerpt and `details` hold known content; assert neither reaches the turn. Return the record with its text and it must go red - this is what makes a redaction cascade unnecessary rather than merely deferred |
| A task stores an excerpt, not a transcript (D5) | Create a task from a message far longer than the excerpt length; assert the stored value is bounded, and that the prompt built from it is byte-identical to the one built from the full text. Store the transcript and the bound must go red |
| The pointer is the USER's message | Resolve the stored id against the channel and assert it is the user's message, not the assistant's placeholder or its later-updated answer. Store the placeholder id and it must go red |
| The pointer is resolvable or absent, never a correlation key | Assert it is set on a bypass-created task, and that a task created where no id was available leaves it **absent** rather than falling back to the correlation id |
| Seeing is not advancing | The non-owner speaks; assert the task is visible to that turn and is NOT resumed or advanced by it |

## Consequences

- **The person-owed lookup is the one a task-shaped chain takes, and anything that must happen when a
  chain is ANSWERED belongs on it.** Ownership follows the state a chain starts in, and every
  report, extraction and troubleshooting chain starts in one that awaits the person, so they hold it
  from its first moment. The assistant-held branch therefore does not run for those chains at all.
  This is easy to get wrong in a way nothing reports: a duel's resume was written on the assistant-held
  branch, and after this ADR the response was accepted, the task advanced, and both sides of a live
  duel sat in `WAITING_FOR_USER` with round 2 suppressed. See
  [ADR-030](./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md).
- **A held chain is what makes the refusal structural.** The person-owed lookup only ever returns a
  chain THIS speaker holds, so a member who did not start a duel finds nothing and advances nothing,
  without a comparison that could be got wrong.
- **A state can declare what it needs before it releases the person**
  ([ADR-031](./031-a-step-says-what-it-needs.md)). `awaitsUser` says who holds the work; `requires`
  says what they still owe, which is what lets a partial answer be recognised as one.
- **The battle work unblocks in this order:** this ADR, then `taskId` leaves the battle row, then
  ADR-023's per-`(battleId, botArn, round)` claim and bounded wait. Nothing above the ADR is safe to
  build first, because the lookup shape decides the rest.
- **Analytics: ownership reaches no dashboard, by decision (D6) and by construction (D3).** The
  per-turn projection is built from the turn's in-memory `transitions` array as `{from, to}` and
  nothing else (`async-processor-core.ts:2424-2428`), and D3 keeps ownership entries out of that
  array. `stateHistory` in DynamoDB is the only place ownership history exists. Stated so nobody
  assumes the existing projection picked it up.
- **The notification bridge keeps its mechanism and gains a distinction it is missing today.**
  `matchAssigneeInRoster` (`task-notify.ts:26`) reverse-matches the owner id against the live channel
  roster to recover a resolvable identity, and that is unchanged for a human owner. An assistant
  owner has no roster match and must not be notified. **Today that is a silent fallthrough rather
  than a branch:** `postTaskHandoffNotice` returns false on no match
  (`async-processor-core.ts:3072-3073`), which will cover both "the owner is an assistant" (normal)
  and "the human owner has left the conversation" (a dropped notification nobody hears about). A
  stored `ownerType` separates them, so this is a small correctness gain rather than only a port.
- **A reassignment does not announce itself, and that is accepted for now (owner, 2026-08-09).** A
  hand-off is user-visible today - an in-channel message plus an email `notify` directive
  (`async-processor-core.ts:3076-3089`) - but it fires on a task entering `awaiting_completion`, not
  on reassignment. Reassignment therefore lands silent, and it ships that way rather than growing a
  notification path alongside the ownership change. **It is an optimisation, not a gap left
  unnoticed:** the mechanism already exists and takes a target recovered from the roster, so wiring
  it later is a caller, not a design. Worth doing when reassignment is used in anger, since the
  person who has just acquired a task is the one who most needs telling.
- **What the assistant can say about a conversation's work changes (D4).** Today the only in-channel
  task context a turn carries is the sender's own resumed task, and other members' tasks are
  invisible to it. Under conversation-scoped visibility an assistant can answer "what is open here"
  for the conversation rather than for the speaker, which is a prompt-context change as well as an
  index one, and it should stay a summary rather than replaying another member's task content.
- **The deferred chaser question stays deferred, and this ADR keeps it possible.** Whether every task
  should have an assistant that chases whoever is not moving it forward is the owner's "ADR for
  another day". It is compatible with one owner only if a chaser is **not** an owner: owner is who
  must act next, chaser is who ensures it moves. Conflate them and the two-fields-one-concept defect
  returns wearing a different name.
