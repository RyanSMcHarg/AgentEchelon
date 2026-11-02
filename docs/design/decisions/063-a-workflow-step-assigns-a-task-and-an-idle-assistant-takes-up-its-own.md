---
title: "ADR-063: A workflow step assigns a task, and an idle assistant takes up its own"
status: >-
  Accepted 2026-10-29. Built and deployed to dev, slices T1 to T6, verified by
  `backend/test/lib/a-workflow-step-opens-a-task-for-a-person.test.ts` and the tests "What is built" names. The owner settled
  decisions A to J (A and G changed from the recommendation, J deferred and NOT BUILT). Each slice's e2e is
  written, and no run of it on dev is recorded (NOT VERIFIED).
date: 2026-10-29
related:
  - "./024-task-ownership.md"
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./060-a-variable-is-declared-once-and-its-trust-decides-what-it-may-do.md"
  - "./061-a-welcome-is-a-workflow-an-event-starts.md"
  - "./062-a-message-is-a-template-stored-and-versioned-like-a-document.md"
  - "../../overview/TENETS.md"
  - "../../specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md"
  - "../../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md"
  - "../../specs/interaction/conversation/SPEC-TURN-QUEUE.md"
  - "../../specs/interaction/conversation/CROSS-CHANNEL-TASKS.md"
  - "../../specs/interaction/conversation/DESIGN-CONVERSATION-TYPES.md"
  - "../../specs/communication/SPEC-NOTIFICATION-BRIDGE.md"
  - "../../specs/interaction/governance/SPEC-ABUSE-CONTROLS.md"
  - "../../../backend/lambda/src/lib/event-workflow.ts"
  - "../../../backend/lambda/src/lib/event-task.ts"
  - "../../../backend/lambda/src/lib/event-run-store.ts"
  - "../../../backend/lambda/src/lib/event-deadlines.ts"
  - "../../../backend/lambda/src/lib/task-state-machines.ts"
  - "../../../backend/lambda/src/lib/task-tracking.ts"
  - "../../../backend/lambda/src/lib/turn-lock.ts"
  - "../../../backend/lambda/src/lib/turn-handover.ts"
  - "../../../backend/lambda/src/lib/task-notify.ts"
  - "../../../backend/lambda/src/lib/open-work-summary.ts"
  - "../../../backend/lambda/src/lib/notify-directive.ts"
  - "../../../backend/lambda/src/lib/notice-preferences.ts"
  - "../../../backend/lambda/src/lib/abuse-controls.ts"
  - "../../../backend/lambda/src/task-service.ts"
  - "../../../backend/lambda/src/user-tasks-api.ts"
  - "../../../backend/lambda/src/proposals-api.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../frontend/packages/chat/src/components/OpenWorkItems.tsx"
  - "../../../frontend/packages/chat/src/components/ProposalCard.tsx"
  - "../../../frontend/packages/admin/src/components/admin/EventWorkflowEditor.tsx"
tracking: |
  Asked for: "Tasks in workflows to humans or assistants", and "When idle, assistants should also make sure they are
  checking if there are tasks assigned to them they should pick up (if this isn't already built)". It is not built:
  "What is already built" below says where each half stops, with the file and line.
  Read first, and not re-derived here: the turn queue and its drain (DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING section 2.6,
  ADR-033), task ownership (ADR-024), and who a step awaits (SPEC-TASK-STATE-TRANSITIONS section 12).
---

# ADR-063: A workflow step assigns a task, and an idle assistant takes up its own

## Status

**Accepted (2026-10-29). Built and deployed to dev; each slice's e2e is written and NOT VERIFIED, with no run recorded.** The owner settled every open question ("Decisions taken"). Every slice of the build order is built; "What is built" names each with its cited code and the test that verifies it, "What is not built" what remains and why, and each slice's e2e is written; no run of it on dev is recorded.

## Context

ADR-061 made "something happened, then work" one mechanism: an event starts a workflow of `send`, `agent`, `opening`, `prompt` and `start_intake` steps, and the welcome is the workflow `WelcomeIntent` starts. A workflow can greet, say targeted things and run one bounded model turn. It cannot hand a piece of work to somebody and wait for it to be done. The tasks platform can hold that work (machines, an owner, an assignee that moves at every wait, an open-work list, a turn queue), but only a person's message or a model turn starts it, and nothing hands an assistant the work that is already assigned to it.

Two requests meet here. A workflow step assigns a task to a person, to a participant role or to an assistant role. And an assistant that has nothing running in a conversation takes up the tasks assigned to it there, without anyone writing to it first.

### What was built before this ADR, and where each half stopped

| Question | Answer today | Where |
|---|---|---|
| Can a workflow step open a task? | **Partly.** An `agent` step's `workflow:` opens a task of one platform machine, `incident_first_look` (`EVENT_TASK_MACHINES`), owned by the step's assistant and visible to the room; the turn runs its first step and the runtime takes that step's one transition once the turn posted | `backend/lambda/src/lib/event-workflow.ts:126`, `openEventTask` in `event-task.ts`, the processor's `eventStep` branch (`backend/lambda/src/assistant-async-processor.ts:1646`) |
| Can a step name who a task's step waits on? | **No.** A state declares `awaits: { party: 'requester' }`, and `requester` is the only reference that resolves (SPEC-TASK-STATE-TRANSITIONS FR15, NOT delivered) | `backend/lambda/src/lib/task-state-machines.ts:33` |
| Is the assignee separate from the owner and the assistant? | **Yes.** Three roles: `assistantId` (never moves), `ownerPersonId`, and `assigneeId`/`assigneeType` (moves at every `awaits` boundary), one writer (`setTaskAssignee`) | ADR-024 D8; `backend/lambda/src/lib/task-tracking.ts:204` |
| Does a person see what they owe? | **Yes.** `GET /tasks/mine` reads the caller's assignee partition of the user-tasks mirror; the chat client's open-work list shows it, oldest first, and opens the conversation | `getActiveTasksForUser` in `task-tracking.ts`; `user-tasks-api.ts`; `OpenWorkItems.tsx` |
| Is a person told when work becomes theirs? | **Partly.** One machine, `action_item` reaching `awaiting_completion`, posts the `task-assigned` template as a room message whose notify directive emails the assignee (kind `conversation`, the default) | `backend/lambda/src/assistant-async-processor.ts:2727`, `postTaskHandoffNotice` (`backend/lambda/src/lib/async-processor-core.ts:6982`) |
| How does a person complete a step? | **By writing in the conversation.** The router starts a turn, the model names the item (FR14) and calls `advance_task_state` (FR2). The chat client addresses a reply to an item with `Metadata.task.id` (section 12.8). Nothing outside a model turn advances a task (FR17, its submission half NOT delivered) | SPEC-TASK-STATE-TRANSITIONS sections 3, 12.7 and 12.8 |
| Can a run wait for something and continue? | **For an `agent` step only.** The processor hands the run back, the router claims `after#<step>` once and takes the step's edge; `continueAfter` returns without running for any other step kind | `continuationClaim` and `continueAfter` (`backend/lambda/src/lib/event-workflow.ts:1418`); `handleEventContinuation` (`backend/lambda/src/router-agent-handler.ts:3044`) |
| Is there a deadline mechanism? | **Yes, for one event.** Each member classification has an EventBridge Scheduler group and a scheduler role that invokes only its own router; a one-shot schedule carries ids only and deletes itself after firing. The firing shape names an invitation and nothing else | `deadlineFiringOf` and `createDeadlineSchedule` (`backend/lambda/src/lib/event-deadlines.ts:82`, `backend/lambda/src/lib/event-deadlines.ts:110`); `handleDeadlineFired` (`backend/lambda/src/router-agent-handler.ts:3486`) |
| Does an idle assistant take up tasks assigned to it? | **No.** A turn's exit hands the lock to a reading when messages are queued, and otherwise releases it and reads no task (`backend/lambda/src/lib/turn-handover.ts:342`, `backend/lambda/src/lib/turn-handover.ts:149`). The only reads of an assignee's tasks in a conversation are the operator's assignee route and the router's read of the speaker's own chain. A task no turn has touched is "waiting for its first turn" and nothing gives it one (`backend/lambda/src/lib/task-state-machines.ts:514`) | `settleTurnLockAtExit`, `releaseLock` (`turn-lock.ts`) |
| Does the queue run accepted work one item at a time? | **Specified, not built.** ADR-033 "Then one task at a time, until the queue is clear" says the agreed tasks run in order, each taking the lock, until none is ready. SPEC-TURN-QUEUE has no requirement row for it, and no code reads `queued_request.accepted`: a second accepted request waits for the person's next message | ADR-033; `backend/lambda/src/lib/task-state-machines.ts:1175` |
| Does anything act on a task nobody advances? | **No** (FR20). The stall counter is a dashboard signal by design, and the due-date sweep `scanActiveDueTasks` has no caller and no grant | SPEC-TASK-STATE-TRANSITIONS section 12.5; DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING section 3.1 |
| Who holds the task tables? | **The task service alone**, one per classification, which refuses against its own `SERVICE_CLASSIFICATION` and the conversation's immutable tag. The router, the processor and the user-tasks function invoke it | `backend/lambda/src/task-service.ts`; `backend/test/task-store-boundary.test.ts` |
| Can a condition read a task? | **No.** The `task:` variable kind is refused at validation as NOT BUILT | `NOT_BUILT_SOURCES` in `variables.ts` |

So the request is two gaps the specifications already name: a step that names the principal it waits on, completed from outside a turn by the entitled person (FR15, FR16 and FR17's submission half), and a principal accountable for progress that acts when nobody does (FR20), applied to the loop ADR-033 specifies and never built.

### What "idle" means, from the records that exist

The turn lock is keyed by conversation and responder (`turn#<channelArn>#<responderId>`, `turn-lock.ts`), so busy is a property of an assistant in one conversation, not of the assistant everywhere: its turns are separate Lambda invocations and run in many conversations at once. **An assistant is idle in a conversation when no turn holds that conversation's lock for it and its queue is empty.** That is the state ADR-033 calls settled, and the drain machine's last stage reaches it (DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING section 2.6). Idle is therefore never sampled. It is entered at one of two moments, each an event a component already handles:

1. **A turn ends with nothing queued.** `settleTurnLockAtExit` reaches the branch that releases the lock (`turn-handover.ts:342`). This is the moment ADR-033 already uses to re-read the queue rather than a sweep, "because turn completion is an EVENT and the last moment anything holds the conversation".
2. **Work becomes an assistant's while it holds no lock there.** The write that makes an assistant a task's assignee (a workflow step opening the task, a person completing their step so the next step is the assistant's, an operator handing work over) is itself the event.

## Decisions taken

The owner settled the open questions on 2026-10-29. Two were changed from the recommendation (A and G), and the rest were accepted as recommended, with the sweep (J) deferred.

| Letter | Question | Chosen |
|---|---|---|
| A | How a step names who does the work | **Changed.** The step names who the task is for (`for`, its requester and owner) and who does the work (`by`, the worker), and the worker may be a person, a participant role or an assistant role. The machine's `awaits` still decides who acts at each state; the step only sets the worker the machine's work states await (Decision 1) |
| B | A participant role with several holders | **B1.** Only a role every declared type gives one holder |
| C | The email's notice kind | **C2.** A new mutable kind, `task` |
| D | How a person completes a task | **D2.** The card for declared choices, and writing for everything else |
| E | Who names the settlement and the readiness of work | **E1.** The task service, to its own classification's router only |
| F | Is the deadline required, and what does it do | **F1.** Required; it cancels the task and takes `onDeadline`, else `onFailure` |
| G | Which assigned work an idle assistant takes up | **Changed.** Every task assigned to it, in priority order, moving proactively unless the task is blocked or its state requires waiting; both are read from machine and task data, never from words (Decision 5) |
| H | A deployment with the turn queue off | **H1.** Pickup runs only where the turn queue is on; validation warns where it is off |
| I | Whose budget a pickup turn spends | **I3.** The owner's where the owner asked for the work (a queued request), `machineWritten` otherwise |
| J | The backstop behind the two events | **Deferred** and **NOT BUILT** (a nudge behind idle pickup). No sweep is built here; the consequence is stated in Decision 6 |

## Decision 1: a `task` step opens a task of a declared machine, and the machine decides who acts at each step

A workflow step may open a task. It names a machine, the person the task is for, and who does the work; it never overrides the machine's own waits.

```yaml
review:
  task:
    machine: approval                  # a machine the version selects (its `workflows`), or a platform reference machine
    for: subject                       # optional: the person the task is for, its requester and owner
    by: { participantRole: approver }  # optional: who does the work; default the run's assistant
    visibility: conversation           # absent reads as private, as every task does (ADR-033)
    priority: high                     # optional: high, normal or low; absent is normal
    deadline: { afterMinutes: 2880 }   # required (Decision 4)
  onSuccess: [{ to: pay, when: { task:state: approved } }, { to: tell-declined }]
  onFailure: chase
  onDeadline: chase                    # optional; absent takes onFailure
```

- **`for` names the person the task is for.** It becomes the task's requester and its owner (`userArn`, `ownerPersonId`), so every existing machine's `awaits: { party: 'requester' }` resolves to that person with no change. It accepts the references an audience already resolves to one person: `subject`, `joined`, `{ people: event:person }`, `{ people: invitation:inviter }` and `{ participantRole: <name> }` (one holder, Decision B). Absent, the task is for nobody, and its machine must declare no state that awaits the requester.
- **`by` names the worker: who does the work.** A person (the same references as `for`), a participant role with one holder, or an assistant role (`{ assistantRole: <role> }`). Absent, the worker is the run's own assistant. The worker is resolved once, when the step runs, and recorded on the task as `workerId` and `workerType`; like `assistantId` it never moves.
- **The machine's `awaits` decides who acts at each state, and nothing else does (ADR-024).** A new awaited party, `worker`, joins `requester`: a state that `awaits: { party: 'worker' }` is held by the worker, a state that awaits the requester by the person the task is for, and a state that awaits nobody by the task's assistant. The assignee is still written only by `setTaskAssignee`, on creation and at each `awaits` boundary (`maybeHandOver`), so the step adds no second writer. A task's assistant (`assistantId`) is the worker when the worker is an assistant, and the run's assistant otherwise, which is the assistant accountable for a person's work.
- **An assistant worker is found as an `agent` step's `as` finds it**: the run's own assistant where it holds the role, else the room's live assistant of the same classification holding it (`assistantForStep`). Where none is in the room the task is not opened and the step takes `onFailure`.
- **Which machines.** A machine the version's `workflows` selection offers, a platform reference machine, or one of `EVENT_TASK_MACHINES`. The platform's queue machines (`PLATFORM_TASK_MACHINE_KEYS`) are never opened by a step, because code depends on their states by name. Two reference machines ship for work somebody does: `approval` (`deciding` awaits the worker and declares the choices `approved` and `declined`, both terminal of kind `success`, because the task was decided either way and the run branches on which) and `acknowledgement` (`asked` awaits the worker and declares the choice `acknowledged`).
- **One task per step of a run.** Its id follows from the run's key and the step (`eventTaskId`), so a redelivered event opens the same task, and the step is claimed once like every other step.
- **The run waits, and the step records `opened`.** The run stops at a task step as it stops at an `agent` step, and continues only when the task settles (Decision 3).
- **The graph stays acyclic.** A task step is one node with outcome edges. The machine inside it may loop through its own states; the run around it cannot.
- **`task:state`** is a built variable source, readable only on the edges of the task step that opened the task: the terminal state's name, an enum of that machine's terminal states, platform trust.
- **The step shape is what the visual builder draws.** A task step is one node whose outgoing edges are `onSuccess`, `onFailure` and `onDeadline`; its fields are the machine, `for`, `by`, `visibility`, `priority` and `deadline`. The visual workflow builder reads this shape and adds nothing to it.

## Decision 2: a person is told in the conversation, in their list and by email, and completes it there or on a card

- **The conversation.** Opening a task whose first holder is a person posts the run assistant's `workflow-task-assigned` template **targeted to that person**, never to the room, because a task's existence may be visible to the room while what it asks of a person is not (ADR-033 "Existence is visible; details are not"). The message carries a card on its Metadata (`task: { id, state, choices, expiresAt }`), which only its addressee receives, drawn by the chat client the way it draws a proposal. A room line, where the author wants one, is a separate `send`.
- **The list.** Nothing new: a task whose assignee is the person lands in their assignee partition, so `/tasks/mine` and the open-work list show it (ADR-024 D2).
- **Email.** The same message emails the person through the notification bridge's directive, under the mutable notice kind `task` (Decision C), so muting conversation email and muting assigned work are separate choices.
- **Completing it by writing.** Unchanged: the person answers in the conversation, the router starts a turn, the model names the item and advances it (FR2, FR14).
- **Completing it on the card.** A state that a person completes by choosing declares the choices, `choices: [approved, declined]`, each a declared transition of that state and only on a state that awaits somebody. Pressing one calls `POST /tasks/advance` on the user-tasks function, which verifies membership as the caller and reads the conversation's tags before it invokes the conversation's own task service. The task service advances the task only when the caller's AppInstanceUser id is the task's current assignee, the state is still the one the card was drawn for, the choice is one the state declares, and the edge's ADR-060 conditions hold (no values are held for a card press, so a conditioned choice is refused rather than guessed). A button is data, so no decision rests on recognizing a phrase (tenet D11).

## Decision 3: the task settling continues the run, once

- **The task carries its run.** A task a step opened records the run on its row (`workflowRun`): the run's key, the workflow's name, the step, the event, the run's assistant, and the people, invitation or alarm the event named, as ids, with the conversation fields the run's sends render. Nothing of the task's own work is copied into the run.
- **The task service names the settlement.** Every path that ends a task goes through the task service (a turn's `advance_task_state` into a terminal state, the card, the deadline's cancel, an operator's cancel), so it is the one place that sees a task a run is waiting on settle. It names `{ channelArn, taskId }` to its own classification's router, asynchronously, and nothing else: no state name, no details and no words.
- **The router continues it once.** It reads the task back through its task service (settled, and still naming a run of this classification's assistant), deletes the task's deadline schedule, recomputes the run key from the run's ids, claims `after#<step>` exactly as for an `agent` step (`continuationClaim`), and takes the edge: `onSuccess` for a terminal of kind `success`, `onDeadline` (else `onFailure`) for a task its deadline cancelled, and `onFailure` for every other ending. `continueAfter` accepts a task step beside an `agent` step; nothing else of the runner changes.
- **A naming that arrives twice loses the continuation claim and runs nothing.** A naming that does not arrive leaves the run stopped at its step with the task settled; with no sweep (Decision J) nothing finds it, and the run's later steps do not run.

## Decision 4: a task step has a deadline on the existing scheduler

- **Every task step declares `deadline.afterMinutes`**, within the bounds deadline events use (5 minutes to 30 days). A task nobody completes is the absence of an event, which cannot be event-sourced (tenet D6); the deadline is the declared answer to it, and the task row's expiry is set past it.
- **It reuses the classification's schedule group, scheduler role and router entry.** Opening the task creates one one-shot schedule whose name is derived from the conversation and the task, whose input carries ids only (`{ kind: 'task', channelArn, taskId }`), and which deletes itself after firing. No grant changes.
- **Firing means nothing until the router checks it**: the conversation is its own classification's and not archived, and the task is still open and still names a run. Then the task is cancelled with the outcome `deadline` and the run continues on `onDeadline`, else `onFailure`. A schedule that outlives what it timed fires, finds the task settled, and starts nothing.
- **Settling the task deletes its schedule** on the router's continuation, and **archiving the conversation deletes its open workflow tasks' schedules** on the path that already deletes its invitation deadlines.

## Decision 5: an idle assistant takes up the tasks assigned to it, in priority order

This is ADR-033's "Then one task at a time, until the queue is clear", built, and extended from the queue's own requests to every task an assistant is assigned in a conversation.

**Ready, blocked and waiting, from data alone (`pickupReadiness`).** A task is ready for an assistant in a conversation when the assistant is its assignee and nothing below holds it. Each test reads the machine's declarations or the task row, never anything anyone wrote:

| The task is not taken up when | Read from |
|---|---|
| **Its state requires waiting:** it awaits a party that does not resolve to this assistant (the requester, or a worker who is a person or another assistant) | the state's `awaits` and the row's `workerId` |
| **Its state requires waiting:** it is terminal | the state's `transitions` |
| **Its state requires waiting:** it rests, held until somebody asks or a time passes (`rests: true`), as `incident_first_look.findings_shared` and the states of `queue_drain`, which the queue's own reading drives, declare | the state's `rests` |
| **It is blocked:** its lifecycle is not live (`pending`, `in_progress`) | the row's `status` |
| **It is blocked:** its state declares a step `action`, which the platform runs on entry with no turn | the state's `action` |
| **It is blocked:** it was already taken up in this entry of its state, or a turn already ran in this entry and did not move it | the row's `actionRuns` (`pickup:<state>#<entry>`) and `turnsInState` |
| **It is blocked:** a document was already delivered from this entry of its state, attached or posted inline (`delivered-this-entry`, ADR-064 decision B) | the row's `deliveries` (`fromState`, `at`) and `stateHistory` |

A time a task waits for is its deadline (Decision 4), which arrives as an event; a state that should hold until then declares `rests`.

**Priority.** A task's priority is the `priority` its row already carries (`high`, `normal`, `low`; ADR-033 records it at triage for a queued request). A task step declares it (`priority`, absent `normal`); a machine declares none, because how urgent a piece of work is depends on why it was opened, not on its shape. Ready tasks are taken high first, then normal, then low; within one priority the oldest (`createdAt`) first, then by id, so the order is total and the same on every read.

**Taken up once per entry.** A pickup is claimed on the task row by the per-entry claim a declared action uses (`claimStateAction`, its key prefixed `pickup:`), so a state is taken up once each time it is entered. A pickup turn that ends without moving the task is not taken up again for that entry; the stall counter records it, and the deadline or a person's next message decides what happens next. This also bounds the loop: each pickup is one step of one task, and the chain ends when nothing is ready.

**When idle is entered, two events take up work, and no timer does.**

1. **At a turn's exit with nothing queued.** Where `settleTurnLockAtExit` would release the lock, it first asks the task service for this assistant's ready tasks in this conversation (its assignee partition, filtered to the conversation). A task the ending turn worked and did not move is held by its own turn count; one it moved into a new step is a new entry and is ready like any other, which is how the assistant moves on through its work. When one is ready it **hands the lock over** to a pickup turn for the first in priority order, in one conditional write (`handOverLock`), so the conversation is never unheld between the two. When none is ready it releases, conditionally on no task having been named ready meanwhile.
2. **When work becomes an assistant's while it holds no lock there.** The task service, on a write that makes an assistant the assignee of a task (opening it, a card press, an advance into a state the assistant holds), names `{ channelArn, taskId }` to its own router (Decision E). The router re-reads the task, checks it is ready, and claims the lock (`claimTurn`). Claimed: it dispatches the pickup turn. Held: it records the task id on the turn record (`pickupPending`); the holder's release is conditional on that record being empty, so a holder that read the tasks before the naming finds it on release and hands over instead.

**The pickup turn.** An ordinary task turn of the task's assistant, on its own session and grants (tenet D1), dispatched by the router the way the task-continuation turn is, on an acknowledgment carrying the turn's correlation, and carrying the task id and no person's message. The processor runs it through its one pipeline, so a delivering step's document, a newly entered state's declared action, a long reply's splitting and the turn's attribution are an ordinary turn's. It holds the lock because it works in the room: a person who writes meanwhile is queued and read as ADR-033 describes. Its instruction is the task state's own `prompt`, rendered as every task turn renders it, and it has the task tools, so it advances the task as an ordinary turn would. It is declared on the ledger as a turn kind of its own, `task_step`, carrying the task's type and state. A message it posts is visible according to the task's visibility: a private task's pickup turn posts targeted to its owner.

**What does not change.** A person's message still starts a turn, the decline guard still refuses a second turn on work the assistant already owes (FR11), and a task in another conversation is never taken up here (CROSS-CHANNEL-TASKS).

**Where the turn queue is off (Decision H).** Idle is defined by the lock, so where there is none nothing is taken up: an assistant's first step of a workflow task still runs (the step opens the task and the run's own dispatch is the turn), and a later step waits for a message. A version whose workflow assigns work to an assistant validates with a warning that names it.

**Whose budget (Decision I).** A pickup turn on a `queued_request` spends its owner's rate limit and budget, because the person asked for that work; every other pickup turn is `machineWritten` against the deployment's global budget.

## Decision 6: no sweep in this merge

The two events above are the mechanism. A low-frequency reconciliation sweep is the correct backstop behind an event path (tenet D6), and the owner deferred it ("a nudge behind idle pickup"), and it is **NOT BUILT**. **The consequence, stated:** an event that is lost (a naming that did not arrive, a handler that failed between its read and its dispatch) leaves the work where it is. A ready task in a room nobody writes to waits until its task's deadline cancels it, and a settled task whose naming was lost leaves its run stopped at the task step. The first is found the next time a turn of that assistant exits in that conversation, or ended by its deadline; the second is not found at all, and the run's later steps do not run.

## IAM this adds

| Grant | On | Narrowed to | Deny test |
|---|---|---|---|
| Invoke the router | each classification's task service role | its own classification's router, found by its parameter, as `sayThroughRouterWiring` scopes the invitations function | synth: classification A's task service invokes A's router and no other function |
| Advance a task as its assignee | the existing user-tasks function | no new grant: it already reads tags, checks membership as the caller and invokes a conversation's task service by name; the new op authorizes inside the task service | unit: the task service refuses another member, a choice the state does not declare, a state that has moved on and a settled task |
| Create and delete task deadline schedules | each router's existing `AgentHandlerDeadlineSchedules` | unchanged: its own group, passing its own scheduler role | the existing `deadlines-and-proposals-are-granted-narrowly.test.ts` |

**Who may assign work to whom.**

| Assigner | Assignee | Allowed | Held by |
|---|---|---|---|
| A version's workflow step, run by the room's primary | a person, through a reference (`for`, `by`) | when the reference resolves to a current member of the conversation | validation (references only, never an id), the router's membership read when the step runs |
| A version's workflow step | an assistant (`by: { assistantRole }`) | only a live assistant of the conversation's own classification that is a member of the room | `assistantForStep` (its own classification's registry only), and the task service refusing an assistant assignee outside its classification's registry |
| A model turn | anyone | **never**: no tool assigns or reassigns a task; ownership moves only at a machine's declared `awaits` boundaries (ADR-024) | the tool registry has no such tool |
| A person | anyone | **never**: `POST /tasks/advance` moves only a task the caller is assigned, along a choice its state declares | the task service's assignee check |
| An operator | an owner | unchanged: `tasks-reassign-owner` | the capability |

**Across classifications, refused at every layer** (tenet D3): a workflow names an assistant role, never an assistant, and the router's live list holds only its own classification's assistants; the task service refuses an assistant id outside its own registry and a conversation outside its own tag; the task service invokes only its own router; the router dispatches only its own processor; and the processor bears only its own classification's assistants (tenet D1).

## Build order

Each slice's e2e runs on dev after the deploy at the end of this merge; none is reported done on unit tests alone.

| Slice | What it builds | Its e2e on dev |
|---|---|---|
| **T1. Declaration** | The `task` step (`machine`, `for`, `by`, `visibility`, `priority`, `deadline`, `onDeadline`), the awaited party `worker`, the state declarations `choices` and `rests`, the reference machines `approval` and `acknowledgement`, `task:state` on a task step's edges, validation wherever an event workflow is validated, the console editor's step kind | A version with a task step validates and activates; one naming one of the turn queue's own machines, a deadline out of bounds or a terminal state the machine does not have is refused with each reason |
| **T2. A person's task** | The router opens the task through its task service with the resolved requester, owner and worker and the run on the row; the targeted `workflow-task-assigned` message with its card Metadata and its email under `task`; the task service names the settlement to its router; the generalized continuation | A welcome opens an `acknowledgement` task for the subject; it is in their open-work list and the test inbox; the subject acknowledges by writing; the run's next send posts |
| **T3. The card** | The chat client's task card, `POST /tasks/advance`, the task service's assignee advance and its refusals | The subject approves an `approval` task on the card and the run takes the `approved` edge; a second press is refused as settled |
| **T4. The deadline** | The task firing on the existing scheduler, the router's check, the cancel and `onDeadline`, deletion on settle and on archive | A task with a five-minute deadline is left alone; it is cancelled with the outcome `deadline` and the run takes `onDeadline` |
| **T5. Assistant work and pickup** | `by: { assistantRole }`, `pickupReadiness` and the priority order, the readiness naming, `pickupPending` and the conditional release, the selection at the turn's exit, the per-entry pickup claim, the `task_step` turn kind and its budget, the turn-queue warning | A workflow assigns a task to the ops role's assistant and it is worked with no message in the room; three accepted queued requests are worked one after another with no further message |
| **T6. Roles and the record** | A participant-role worker or requester (one holder), the cross-classification deny tests, SPEC-TASK-STATE-TRANSITIONS FR15, FR16, FR17 and FR20, a SPEC-TURN-QUEUE row for one task at a time, the notification kind, the profile guide; this ADR's status | The role's holder completes a task and the run continues |

## Options considered

- **A timer that looks for work.** Refused by tenet D6 as the primary mechanism: both moments idle begins are already events a component handles. A low-frequency sweep behind them is the backstop D6 allows, deferred (Decision 6).
- **A `pickup: true` marker a state opts into** (the recommendation for G). Not chosen: an assistant works its assigned tasks proactively, and a state that must not be taken up declares `rests` instead, so the exception is declared and the rule is the default.
- **A step-level `assignee` that holds for the whole task.** A second writer of the assignee beside the `awaits` boundary, which ADR-024 exists to prevent, and it cannot express a task that moves between a person and an assistant. The worker is a party the machine's states await instead.
- **A new "worker" component that owns assigned work per assistant.** Refused by tenet D8: the turn lock, its handover, the queue's re-read at exit and the task service already are that component.
- **Tasks as a separate workflow engine beside event workflows.** Refused by tenet D9: a task step is one more step kind of ADR-061's runner, and the task is the machine the platform already validates.
- **Taking the lock for a pickup turn the way an `agent` step does not.** An `agent` step answers no one and leaves no work in the room (ADR-061 rule 12). A pickup turn works a task the room may see and may be followed by more, which is the case ADR-033 says takes the lock "like any other turn".

## Consequences

- A workflow can hand work to a person, a participant role or an assistant and wait for it, so a welcome that greets and then asks a lead to approve, or an opening that hands a first look to the ops assistant and then continues, is a workflow rather than code.
- The queue's agreed work runs to the end without the person having to write again, which ADR-033 promised.
- A task a workflow opens always ends: completed, declined, or cancelled by its deadline, and the run says what happened next, except where the settlement's naming is lost (Decision 6).
- The task service gains one outbound call, to its own router. It is the first time the task service invokes anything, and it is the price of having one writer see every settlement and every assignment.
- A deployment with the turn queue off keeps today's behavior for assigned work after its first step.

## What is built

Built and deployed to dev, slices T1 to T6. Each slice's e2e is written; no run of it on dev is recorded, so each is NOT VERIFIED.

| Slice | What is built | Code | Verified by |
|---|---|---|---|
| T1 | The `task` step (`machine`, `for`, `by`, `visibility`, `priority`, `deadline`) and its `onDeadline` edge, validated wherever an event workflow is (`taskStepErrors`, `eventWorkflowErrors`): a machine the runtime runs, read at the draft patch, validate, activate and import from the classification's intent pack over the platform's (`deploymentTaskMachines`, the read `workflowSelectionErrors` makes; an unreadable pack refuses, never falls back), never one of the turn queue's own; `for` and `by` as one-person references, a participant role every declared type gives one holder, or `{ assistantRole }`; a bounded deadline; `task:state` an enum of the machine's terminal states on that step's edges alone (`withTaskState`). The awaited party `worker` (`AWAITED_PARTIES`), the state declarations `choices` and `rests`, carried through an intent pack, and the reference machines `approval` and `acknowledgement`. A version's selection must include the machine; an assistant role the classification does not declare, and assistant work where the turn queue is off, are warnings (`stepRoleWarnings`, `pickupWarnings`). The console's step kind `task` | `backend/lambda/src/lib/task-step.ts`, `backend/lambda/src/lib/event-workflow.ts`, `backend/lambda/src/lib/task-state-machines.ts`, `backend/lambda/src/lib/profile-lifecycle.ts`, `frontend/packages/admin/src/components/admin/EventWorkflowEditor.tsx` | `backend/test/lib/a-workflow-step-opens-a-task-for-a-person.test.ts`, `backend/test/lib/a-pack-machine-keeps-its-flags.test.ts`, `frontend/packages/admin/src/components/admin/EventWorkflowEditor.test.tsx` |
| T2 | The worker on the row (`workerId`, `workerType`, `workerOf`), held by states that await it through the one writer (`createTask`, `maybeHandOver`); the run on the row (`workflowRun`). The router resolves the references and the task service opens the task (`openWorkflowTask`), refusing an assistant outside its classification's live assignments. A person who holds the first step is told privately in `workflow-task-assigned`, with the card on the Metadata, and emailed under the mutable kind `task`. The task service names a settled task to its own router (`nameWhatChanged`, `nameTaskThroughRouter`); the router reads it back and continues the run once (`handleTaskNaming`, `continueAfter` on a task step) | `backend/lambda/src/lib/task-tracking.ts`, `backend/lambda/src/task-service.ts`, `backend/lambda/src/router-agent-handler.ts` (`openWorkflowTaskStep`, `handleTaskNaming`), `backend/lambda/src/lib/workflow-task.ts`, `backend/lambda/src/lib/notice-preferences.ts` | `backend/test/lib/a-workflow-step-opens-a-task-for-a-person.test.ts`, `backend/test/lib/a-person-completes-their-task-on-the-card.test.ts` |
| T3 | `POST /tasks/advance` on the user-tasks function (membership as the caller, tags, the conversation's own task service) and the task service's `advanceAsAssignee`, which takes a choice only for the current assignee, in the state the card was drawn for, along a declared choice (`assigneeAdvanceRefusal`). The chat client's task card | `backend/lambda/src/user-tasks-api.ts`, `backend/lambda/src/task-service.ts`, `frontend/packages/chat/src/components/TaskCard.tsx` | `backend/test/lib/a-person-completes-their-task-on-the-card.test.ts`, `frontend/packages/chat/src/components/TaskCard.test.tsx` |
| T4 | The task firing on the classification's schedule group (`createTaskDeadlineSchedule`, `taskDeadlineFiringOf`), created when the task opens, checked on fire (`handleTaskDeadlineFired`), the task cancelled with the deadline's ending (`cancelForDeadline`), read back as `task:deadline` and continued on `onDeadline`, else `onFailure`; the schedule deleted on settle and on archive | `backend/lambda/src/lib/event-deadlines.ts`, `backend/lambda/src/router-agent-handler.ts`, `backend/lambda/src/task-service.ts` | `backend/test/lib/a-task-deadline-ends-the-task-and-continues-the-run.test.ts` |
| T5 | `pickupReadiness`, `orderForPickup` and `pickupBudget`; at a turn's exit with nothing queued the lock is handed to a pickup turn or released conditionally (`handOverToPickup`, `releaseLockUnlessPickupPending`, `pickupPending`); a task named ready takes the lock or is recorded for the holder (`handleTaskReady`, `notePickupPending`); the exit's hand-off is dispatched by the router (`handleTaskPickup`). The pickup is an ordinary task turn (`dispatchTaskPickup`): metered, the entry claimed once (`claimPickup`), an acknowledgment posted as the assistant with the turn's correlation and its mapping recorded, and the task-continuation dispatch's fields, with the `task-pickup` prompt template as its one message; the processor runs it through its one pipeline, and the answer declares `task_step` on the ordinary metadata (`declaredTurnKind`) | `backend/lambda/src/lib/workflow-task.ts`, `backend/lambda/src/lib/turn-handover.ts`, `backend/lambda/src/lib/turn-lock.ts`, `backend/lambda/src/router-agent-handler.ts`, `backend/lambda/src/lib/async-processor-core.ts` | `backend/test/lib/an-idle-assistant-takes-up-its-own-work.test.ts`, `backend/test/lib/a-pickup-turn-is-an-ordinary-task-turn.test.ts` (through the real tool loop: the move enters a state with a declared action, which runs, and the next step delivers a document) |
| T6 | A participant-role requester or worker (one holder, decision B1, resolved from the role's holders who are members); the cross-classification deny tests; the task service's router grant and its own assignment read (`sayThroughRouterWiring` for its own classification); SPEC-TASK-STATE-TRANSITIONS FR15, FR16, FR17 and FR20, SPEC-TURN-QUEUE FR13, SPEC-NOTIFICATION-BRIDGE FR19, the profile guide | `backend/lib/stacks/assistant-profile-stack.ts`, the documents named | `backend/test/a-task-service-reaches-only-its-own-router.test.ts`, `backend/test/lib/a-person-completes-their-task-on-the-card.test.ts` |

**As built, where it differs from the decisions above.**

- **The machines a step may open** are the ones the runtime runs: the classification's intent pack merged over the platform's, read by validation from the same parameter and body the router and the task service hydrate. A version's own `machines` field is not among them, because the runtime does not run it either.
- **The task service's naming** follows every successful advance it makes, the card press, the deadline's cancel, an operator's cancel and a stop's cancel, reading the row back to decide whether to name it settled or ready. A status written by another path names nothing.
- **A task the ending turn worked** is not left out of the exit's read: a task it did not move is held by its own turn count (`worked-this-entry`), and one it moved into a new step is a new entry and is ready like any other.

## What is not built

- **The sweep behind idle pickup** (Decision 6), deferred and **NOT BUILT**: a lost event leaves ready work until its deadline, and a lost settlement leaves its run stopped at the task step.
- **A role with several holders** (decision B1): refused at validation; entitlement separate from assignment (SPEC-TASK-STATE-TRANSITIONS FR16) waits on it.
- **The worker resolved again at each step** (FR15): it is resolved once, when the step runs.
- **Pickup where the turn queue is off** beyond a task's first step (decision H1): by decision, with a validation warning.
- **An assistant assigning or reassigning work at runtime, a task step fanned out over several people** (sub-agent identity is BLOCKED, ADR-061 decision 8, rule 10), **and a `task:` condition anywhere but a task step's own edges.**
- **The e2e of each slice**, written and not run: they need the deploy at the end of this merge.

## What proves it

`backend/test/lib/a-workflow-step-opens-a-task-for-a-person.test.ts` (T1, T2: declaration, the worker through the one writer, the run opened once and continued once), `backend/test/lib/a-person-completes-their-task-on-the-card.test.ts` (T2, T3: the task service opens and refuses, and every deny case of the card), `backend/test/lib/a-task-deadline-ends-the-task-and-continues-the-run.test.ts` (T4), `backend/test/lib/an-idle-assistant-takes-up-its-own-work.test.ts` (T5: readiness, order, the exit's hand-off and its race, the per-entry claim, the pickup dispatched as an ordinary task turn with no processor branch of its own), `backend/test/lib/a-pickup-turn-is-an-ordinary-task-turn.test.ts` (T5: a pickup through the real tool loop runs a declared action and delivers a document), `backend/test/lib/a-pickup-reaches-the-processors-own-router.test.ts` (T5: the exit names its pickup to the router the processor reads from its own `ROUTER_ARN_PARAM`, and gives the handed lock back when there is none), `backend/test/a-task-service-reaches-only-its-own-router.test.ts` (synth, deny), `frontend/packages/chat/src/components/TaskCard.test.tsx`, and the e2e specs `tests/e2e/a-workflow-step-opens-a-task-for-a-person.spec.ts`, `tests/e2e/a-task-deadline-ends-the-task-and-continues-the-run.spec.ts` and `tests/e2e/an-idle-assistant-takes-up-its-own-work.spec.ts`, each to be recorded here with its date and result when it passes on dev.
