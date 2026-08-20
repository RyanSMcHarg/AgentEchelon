# SPEC: Task state transitions

**Status:** Implemented. **Verified by:** `backend/test/lib/task-loop-machines.test.ts`,
`backend/test/task-state-machines.test.ts`, `backend/test/lib/task-ownership.test.ts`,
`backend/test/lib/task-has-an-end.test.ts`,
`backend/test/lib/a-delivering-step-claims-no-file.test.ts`,
`backend/test/lib/a-step-declares-who-it-awaits.test.ts`,
`backend/test/lib/the-router-reads-either-wait-declaration.test.ts`,
`backend/test/lib/step-needs-are-checked.test.ts`, `backend/test/lib/profile-manifest.test.ts`.

**Coverage:** `tests/e2e/task-state-machine.spec.ts` - drives a machine-backed task through real turns and
asserts the persisted `taskState` moves along declared edges rather than being inferred from the reply
text; `tests/e2e/tasks.spec.ts` - a report request opens a tracked task and the `task_id` reaches analytics,
which is what makes the machine observable to an operator rather than only to the turn that ran it;
`tests/e2e/report-flow-branches.spec.ts` - drives the report journey past the outline into a scoping
change, a revision and completion, asserting the turn continues the task rather than being offered a
new conversation; `tests/e2e/place-item-flow.spec.ts` - the propose, confirm and place journey with its
breakout branches, where a correction is not a confirmation and a decline does not silently complete.

**Problem and who it's for:** A person asks for something that cannot be answered in one turn - a
report, an extraction, a troubleshooting walkthrough. They expect the assistant to remember where they
got to, to ask only for what is still missing, and to finish. Without a declared machine the assistant
re-derives "where are we" from the transcript on every turn, which drifts, loops, and re-asks questions
already answered. This is for the deployment configuring those flows and for the operator who has to
tell a stalled task from a slow one.

**Layer:** Core platform, interaction. **Code:** `backend/lambda/src/lib/task-state-machines.ts`
(the graphs), `backend/lambda/src/lib/task-tracking.ts` (persistence, ownership, lifecycle),
`backend/lambda/src/lib/task-tools.ts` (the tool the model calls).

> **This document was cited by 19 source files before it existed.** It is written to the sections those
> citations already name (§3-§8), because the code is the older artefact and renumbering it to suit a
> new document would break every reference at once.

## What tasks are for

**The goal: multi-turn, multi-party work completed inside the flow of the conversation, not beside
it.** A person who asks for something that takes several turns should finish it where they started it,
without being sent to a portal, a form, or a second thread. The task machinery exists so the platform
can hold that work: what step it is on, who owes the next move, what the step still needs, and how the
result comes back. The measure of success is negative. Nobody leaves the conversation to finish what
they began in it, and no assistant re-derives "where are we" from the transcript on every turn.

**"Multi-party" is the load-bearing word.** A conversation may hold one person and one assistant, or
several people, or several assistants, or both. The same declared machine has to work in all of them,
which is why ownership is a separate axis from authorship (§2) and why a step declares whether it
blocks on a person (§4) rather than the runtime guessing from who spoke last.

**A step's owner is a PRINCIPAL, and the right principal is often a ROLE rather than an identity.**
Both people and assistants can carry a role that decides whether they are the correct owner of a step:
the traveller's manager approves the trip, whoever holds the finance role signs off the spend, the
assistant that owns the booking capability places the reservation. The question a step needs to answer
is not only "is this blocked on a human" but "is THIS principal entitled to complete it", and the
answer is frequently a role held by a person or by an assistant rather than a named identity. A step
expresses the first half: it declares `awaits: { party: 'requester' }`, and `requester` is the only
reference that ships, so a step blocked on a specific person, on a role, or on a particular assistant
still declares the same thing, and any reply that reaches a waiting step is treated as an answer to
it. The declaration's SHAPE is what admits the second half later (§12.6). Naming the entitled
principal is what turns a workflow convenience into a control, since a step that records an approval
nobody entitled gave is worse than one that waits.

### The delivery shapes a task has to serve

| Shape | What it means | Where it stands |
|---|---|---|
| **Broadcast** | The work and its result are visible to the whole conversation. | Served. The default for an ordinary turn and for a resumed chain, whose answer is posted as its own public message. |
| **Private / targeted** | A person addresses one assistant, and the exchange is visible only to them and the assistant. | Served **per turn**, not per task. A turn's reply inherits the targeting of the placeholder that turn was given. A task that begins with a targeted message does **not** stay targeted across later turns, and a resumed chain's answer is broadcast. Stated here because the gap is not obvious from the mechanism. |
| **Battle** | One prompt is answered by several assistants, whose replies must be publicly comparable. | Served. A duel side runs the ordinary request path with its own identity and its own task chain, and its clarification is public so a rival can see it ([ADR-029](../../../design/decisions/029-clarification-is-public-and-answers-get-their-own-placeholder.md), [ADR-026](../../../design/decisions/026-task-shaped-battle-rounds.md)). |

### The shipped machines are reference workflows, not production ones

`DEFAULT_TASK_STATE_MACHINES` gives a deployment five working flows on day one, and they exist to
**prove the contract and to be replaced**. They are deliberately minimal. A deployment that intends to
run one of these in earnest is expected to expand and refine it, not adopt it as it stands.

The clearest illustration is `guided_troubleshooting.escalated`. It is terminal with disposition
`handoff`, and **nothing routes that anywhere**: no person is notified, no queue receives the work,
and no external system is called. Worse than that, the disposition does not survive to an operator.
Any terminal state marks the task lifecycle `completed`, and a completed task's terminal kind is
recorded as `success`, so an escalation reaches the ledger indistinguishable from a resolution. The
declared disposition reaches only the model, in the tool's return value. Where an escalation should GO
belongs to the deploying organisation, so the missing destination is a boundary; the missing
distinction in the record is not, and a deployment that relies on this state should expect to fix
both.

The same reading applies to the rest. None of these machines carries an SLA, a retry policy, an
approval bound to an entitled approver, or a hop to any system outside the conversation. `place_item`
ends at the machine's terminal, not at a host system's write. `report_generation` produces a document,
not a distribution. Treat them as worked examples of the contract this document describes.

### What the model has to grow into

These are directions, not descriptions. Each names what exists today so nothing here reads as shipped.

- **Handoff between a human and an assistant.** Ownership already changes hands at every `awaits`
  boundary and the item reaches that person's cross-conversation queue (§2,
  [`CROSS-CHANNEL-TASKS.md`](./CROSS-CHANNEL-TASKS.md)). What is not expressed is WHICH person or role
  a step awaits: the only reference that resolves is `requester`, so a step that must be answered by a
  specific other person, or by whoever holds a role, cannot say so.
- **Handoff between assistants.** A message that answers another assistant's work is handed to that
  assistant, and the task carries `assistantId` so the chain keeps its owner
  ([ADR-030](../../../design/decisions/030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md)).
  What is not built is a general handoff a machine can DECLARE as a step.
- **Sub-agents.** A step that fans work out to several assistants and collects the results has no
  representation: the record has no parent/child relationship, and every task today is opened on a
  person's turn.
- **Deterministic steps.** Some steps are not model judgements. Creating a resource either succeeds or
  fails, and the machine should move on the outcome. The transition log already distinguishes a
  runtime-driven entry (`by: 'system'`) from a model-requested one (§6), while §3 states that state
  advances only through `advance_task_state` and the runtime never force-advances. There is already
  one precedent for an authorized edge the model did not request: a `place_item` proposal advances
  `collecting -> confirming` as the tool's success side-effect (§5). What that precedent does not
  cover is an edge driven by the OUTCOME of a non-model action, which is the open question.

## 1. What a task is, and what it is not

A **task** is a multi-turn unit of work with a declared shape. It is not a conversation, and it is not
a to-do item: it exists because a delivery option said this request needs more than one turn
(`DeliveryOption`, `lib/delivery-options.ts`).

Two orthogonal states, and conflating them is the mistake this spec exists to prevent:

| | Field | Meaning | Values |
|---|---|---|---|
| **Lifecycle** | `status` | is this work still live | `pending`, `in_progress`, `completed`, `failed`, `cancelled`, `abandoned` |
| **Machine** | `taskState` | where in the declared graph it is | per-machine, e.g. `collecting_requirements` -> `drafting_outline` -> `generating` |

A machine-backed task is only `completed` once its machine reaches a terminal state
(`shouldMarkTaskCompleted`), so the admin view can never show Completed while the machine is still
generating. A task with no machine has nothing to progress and completes on its turn.

## 2. Ownership is a separate axis again (ADR-024)

`ownerId`/`ownerType` say who must act NEXT; `assistantId` says whose work it is and never moves. Both
are needed: with one field, a chain blocked on a person is either invisible in that person's queue or
indistinguishable from another assistant's chain in the same partition. Ownership changes hands at
every `awaits` boundary, and the three conversational machines (`report_generation`,
`data_extraction`, `guided_troubleshooting`) START in one, so the person holds those from their first
moment and they reach the queue immediately. Where the initial state awaits nobody (`place_item`,
`action_item`, both of which open on the assistant doing something), the requester is still the
default first owner.

## 3. How a transition is requested and authorized

The model does not set state. It calls **`advance_task_state`**, and the runtime authorizes the edge
against the declared graph before persisting it:

- the tool is registered only when the active task is machine-backed;
- the requested `to` must be in the current state's `transitions`;
- the transition is authorized against the state read at the START of the turn, and a task that moved
  in between returns `state_changed` rather than being force-advanced - the caller re-reads and
  re-decides.

`AdvanceResult` distinguishes `illegal_transition` (the graph forbids it) from `persist_failed` (an
infrastructure error) from `state_changed`, because only the last is a retry candidate.

**The runtime NEVER force-advances.** A model that fails to drive its task produces a stall signal
(§7), not a state change.

**And it authorizes the EDGE ONLY.** This is the other half of the same rule and it is easy to miss.
The runtime checks that `current -> to` is declared; it does not check whether the step's declared
needs were met (`requires`, §4), and `reason` is free text that nothing constrains. So an advance
whose needs are unmet is **authorized**, because nothing in the runtime is looking. The instruction not
to advance lives in the turn's prompt, and the judgement lives with the model.

That is deliberate, since only the answer's content can say whether it named an audience and a keyword
test for that is worthless. It is written down here because "the sufficiency check belongs to the
model" reads as "the model decides WHEN the list is satisfied" when it actually means "nothing
verifies that it was". A live report advanced from `collecting_requirements` on its first turn,
declaring it had everything, having never asked about the one need the person then had to supply
unprompted.

## 4. Machines are configuration, not code

`DEFAULT_TASK_STATE_MACHINES` ships the built-in graphs keyed by `taskType`; a deployment's intent pack
can supply its own (`SPEC-CONFIGURABLE-INTENT-PACK`). A machine is a map of state -> `TaskStateDef`
(`task-state-machines.ts`: `{ transitions[], terminal?, awaits?, resolvedByOneResponse?, requires?,
delivers?, prompt?, placeholder? }`):

- `transitions: []` marks a **terminal** state, and `terminal` records its outcome
  (`success` | `failure` | `handoff`);
- `awaits: { party: 'requester' }` marks a state blocked on the PERSON, which is what moves ownership
  to them. It holds a REFERENCE the runtime resolves when the step needs an owner, never a principal
  id, and `requester` is the only reference that ships (§12.6). The deprecated `awaitsUser: true`
  remains accepted and is normalized to the same reference, so a machine already stored in a profile
  version or carried through profile export and import keeps working; every consumer reads the wait
  through one normalizer (`awaitedPartyOf`) rather than off either field, because a consumer left on
  one form stops firing for a machine authored in the other without failing.
  **A state that ends its turn on a question needs it, and where a machine has no separate waiting
  state the producing state IS the wait.** Three of the shipped machines name their wait explicitly
  (`awaiting_result`, `confirming`, `options_presented`), so the state that produces the thing being
  waited on is passed through within the turn and awaits nobody. The other two do not:
  `report_generation.drafting_outline` exits only to `generating` and `data_extraction.validating`
  only to `formatting`, both of which are the assistant working, so those two carry the declaration
  themselves. Omitting it there does not merely mislay a queue item - ownership stays with the
  assistant, so anything keyed on "the person holds work here" is answered wrongly, which is how a
  direct answer to the assistant's outline question was classified as topic drift
  (`SPEC-DRIFT-CONVERGENCE`, "Active-Task Suppression"). Consumers that only need to know whether a
  workflow is RUNNING must not key on this declaration;
- `resolvedByOneResponse: true` (opt-in, deliberately rare) marks a state where ONE clear answer from
  the person completes the step, so the assistant takes that answer and moves on rather than asking
  again - set only where the step IS the answer (a confirmation, an approval, a single choice), never
  on requirements gathering. **It does not mean any reply completes the step, and it is not a licence
  for the runtime to advance.** A correction ("make it 45 minutes and put it before the kickoff") and
  a decline ("do not add it") arrive at the same step as a "yes", and no structural test separates
  them - they are all one reply to a one-exit state. The flag is rendered into the turn's prompt
  (`buildTaskContextForPrompt`), where the only reader that can tell them apart decides: agreement
  advances via `advance_task_state`, a correction is put back to the person with the step left where
  it is, and a decline advances nothing and is not reported as done. `applyUserResponseToTask` moves
  no state at all - it hands the work back to the assistant, which is what makes the reply trigger the
  next turn, and §8's single authorized path is then the only writer;
- `requires: string[]` names WHAT the step needs from the person before the workflow can go on,
  in the person's vocabulary (it is read back to them when something is missing); the sufficiency
  check is semantic and belongs to the model. Absent, any response is treated as sufficient. **The
  runtime does not enforce it**: the list and the rule to ask for only what is missing are rendered
  into the turn's prompt, `advance_task_state` never reads them (§3), and an advance with unmet needs
  is authorized like any other legal edge. `requires` therefore names what the step needs and tells
  the model to collect it; it does not gate the exit;
- `prompt` and `placeholder` (optional) carry the state's system-prompt fragment and placeholder
  copy, making both pack-configurable and localizable;
- `delivers: true` marks a state a document-producing workflow hands its file back from. The
  attachment gate derives its delivery states from the merged machines (never a hardcoded list a
  per-deployment machine could not match), and a file is generated when the turn **declares** a
  transition into a delivering state or from one to a terminal, or when a follow-up **inside** a
  delivering state re-produces the document without declaring a transition this turn (guarded by a
  trailing-question veto, since a turn that ends by asking is not delivering). Below the 400-char
  minimum artifact size the content posts inline instead - the task advances identically either
  way; only the packaging differs. Task creation resolves the initial state from the same merged
  machines, so a pack-declared task type is never created stateless.

  **The model does not know which packaging it got, so it does not claim one.** Packaging is decided
  after the reply exists, from the declared transition and the artifact floor, and the model wrote
  the reply before either was known. A live report posted inline under a sentence saying it had been
  saved as a Markdown file, and the person asked where the file was. A state flagged `delivers`
  therefore carries a rule in its grounding (`buildTaskContextForPrompt`): write the content, do not
  assert a saved, attached or downloadable file, and do not refer to "the attached document". It is
  read off the same `delivers` flag, so a per-deployment machine that renames or adds a delivering
  state carries the rule with it. The alternative - checking the finished reply for a file claim -
  is the output-shape heuristic this gate exists to keep out of the decision.

## 5. Proposals drive their own edges

A step that proposes something to the person (`propose_item`, `place_item`) advances the machine as a
consequence of the proposal rather than by a separate call - the proposal IS the transition from
collecting to confirming. This keeps "what the assistant did" and "where the task is" from being two
statements that can disagree.

## 6. The transition log

`stateHistory` is an **append-only** record on the task: one entry per transition, each carrying `at`,
`by` (`tool` when the model requested it, `system` when the runtime did), the edge (`from`/`to`), and
optionally `reason` and `messageId`.

Ownership changes append an entry too, and deliberately carry `ownerFrom`/`ownerTo` INSTEAD of
`from`/`to` - an ownership change is not a graph edge, and a reader walking `from` would otherwise get
a principal id in a field every other reader treats as a state name.

**A task's ENDING is an entry in this log.** The writer that ends a task (`updateTaskStatus`) appends a
terminal entry carrying its outcome, so the log answers *when* it ended and *how it went*, not just
that it did. There is deliberately **no separate `resolvedAt` column**: a scalar beside the log would
be a second source for one fact, free to disagree with the entry describing it. `v_task_resolution`
reads the ending from here (`LATENCY-TARGETS.md`).

**The ending also releases the person's queue.** `/tasks/mine` reads the user-task mirror, so a task
that ends without mirroring its status stays `in_progress` in that person's list for the whole of its
TTL. That is not cosmetic: the composer addresses a person's next message at the assistant holding
their open item (ADR-032), so a queue that never lets go points a reply at work that is already done.

`abandoned` is **not** terminal. The person dropped out and may come back, so the task stays active and
a nudge can offer to resume it.

## 7. Stall telemetry

`turnsInState` counts consecutive active-task turns that applied NO transition. It resets to 0 on every
authorized advance and increments otherwise.

It is a **dashboard signal, never a control**: it feeds `task_state_stalled` so an operator can see
that a model is failing to drive its task. Nothing reads it to force an advance, because a runtime that
advances a machine the model did not drive is inventing progress.

## 8. One authorized path, and the shadow that proved it

State advances ONLY through `advance_task_state`. The keyword shadow-detector that preceded it still
runs in comparison mode, and it is a comparison rather than a fallback on purpose: two writers to one
state field is the divergence class this spec exists to remove.

## 9. Who decides what: the platform's half and the deployment's half

A machine is configuration (§4), and the line between what the RUNTIME decides and what the
DEPLOYMENT declares is the thing most often got wrong when authoring one. The runtime owns
mechanism: it authorizes an edge against the declared graph, persists the state, moves ownership,
packages a delivery, closes the turn, and meters the spend. The deployment owns meaning: which states
exist, what each needs from the person, which of them block on a human, which produce a document, and
what the assistant says while it is in one.

```
   A delivery option decides this request needs more than one turn
                                  |
                                  v
 +--------------------------------------------------------------------------------+
 | CREATE                                                                          |
 |  DEPLOYMENT declares: the machine (`taskType`) and its `initial` state          |
 |  PLATFORM does:       resolves `initial` from the PACK-MERGED machines, writes  |
 |                       the row, stamps `assistantId`, sets the first owner       |
 +--------------------------------------------------------------------------------+
                                  |
                                  v
 +--------------------------------------------------------------------------------+
 | ASSIGN                                                                          |
 |  DEPLOYMENT declares: `awaits: { party: 'requester' }` on every waiting state   |
 |  PLATFORM does:       moves ownership at each `awaits` boundary, mirrors        |
 |                       the task into that person's cross-conversation queue,     |
 |                       and treats their next message as an ANSWER to this work   |
 |                                                                                 |
 |  A state that waits on a person and does NOT declare `awaits` is the            |
 |  authoring error with the widest blast radius: ownership never moves, so the    |
 |  turn that follows is not recognised as continuing the task (§11).              |
 +--------------------------------------------------------------------------------+
                                  |
                                  v
 +--------------------------------------------------------------------------------+
 | STEP                                                                            |
 |  DEPLOYMENT declares: the legal edges (`transitions`), what the step needs       |
 |                       (`requires`, in the person's vocabulary), the state's      |
 |                       `prompt` fragment and `placeholder` copy                   |
 |  PLATFORM does:       authorizes the requested edge, refuses one the graph does  |
 |                       not allow, refuses a stale write, appends to `stateHistory`|
 |                                                                                 |
 |  The SUFFICIENCY of an answer is semantic and belongs to the model: `requires`   |
 |  names what is owed and is read back to the person, but nothing structurally     |
 |  forces the model to collect it before advancing.                                |
 +--------------------------------------------------------------------------------+
                                  |
                                  v
 +--------------------------------------------------------------------------------+
 | DELIVER (§10)                                                                   |
 |  DEPLOYMENT declares: `delivers: true` on the states an artifact comes back from |
 |  PLATFORM does:       decides attachment vs inline, generates and uploads the    |
 |                       file, and posts it. The FORMAT is not configurable today   |
 +--------------------------------------------------------------------------------+
                                  |
                                  v
 +--------------------------------------------------------------------------------+
 | CLOSE                                                                           |
 |  DEPLOYMENT declares: which states are terminal, and each one's disposition      |
 |  PLATFORM does:       marks the task completed only when the machine reaches a   |
 |                       terminal state, appends the ending to `stateHistory`,      |
 |                       releases the person's queue, and closes the TURN by        |
 |                       stamping `respPhase: 'final'` (§11)                        |
 +--------------------------------------------------------------------------------+
```

## 10. Delivery: attachment or inline, and how an author steers it

`delivers: true` (§4) is the deployment's control over the TASK path. It is not the only way a file
gets produced, and the rest of this section is the platform's.

**When a file is produced.** On the task path, a file is generated when the turn DECLARES a transition
into a delivering state, or from one to a terminal state, or when a follow-up INSIDE a delivering
state re-produces the document without declaring a transition. That last door is guarded by a
trailing-question veto: a turn that ends by asking something is not delivering. Note the condition is
that the model declared no transition THIS TURN, not that the graph offers none.

**Two doors bypass the task path entirely**, and an author should know both. A turn that reads as an
ad-hoc document request generates one with no task and no size floor. A `/battle` round-1
`report_generation` turn generates unconditionally, skipping both the declared-transition gate and the
floor, so both sides of a duel produce a comparable artefact.

**One precondition sits above all of them.** File generation is gated on the processor having an
attachments bucket configured. Without it a `delivers` state advances exactly as declared and never
attaches anything.

**When it posts inline instead.** Below a 400-character minimum artifact size the content posts as
chat text. The machine advances identically either way; only the packaging differs. This is
deliberate: a one-sentence answer shipped as a downloadable file buries the answer behind a click.

**What the file is.** A generated artifact is Markdown, always. The stored object carries
`text/markdown; charset=utf-8` while the attachment record handed to the client carries the bare
media type, and it is named for the task that produced it (`report-*`, `extract-*`, else `document-*`)
plus a timestamp, stored under `generated-docs/<channelId>/`. The declared charset is load-bearing, since a viewer that
guesses decodes UTF-8 as windows-1252 and renders punctuation as mojibake. **The format is a platform
decision, not a per-state one**: a machine cannot ask for PDF or XLSX today, and a deployment that
needs one is asking for a capability that does not exist rather than a configuration it has missed.

**What the state's `prompt` must not promise.** The prompt fragment is where an author tells the
assistant how to talk about its output, and it is the ONLY honest control over that. An assistant
told to announce a saved file will announce one on a turn that posted inline, and the person is then
told to look for something that was never created. State the conditional, or say nothing about files
at all and let the attachment speak for itself. The runtime deliberately does not infer delivery from
what the answer LOOKS like: an output-shape heuristic previously decided both packaging and
completion, shipped a clarifying question as a report, and was removed (§8).

## 11. Defaults an author has to know, because nothing asks

**Finality is declared, not inferred.** Every posted update carries a `respPhase`, and `final` is the
only phase that closes a turn. The mapping fails closed, so an unrecognised phase becomes a progress
update rather than an ending. A delivering turn that does not stamp `final` leaves the turn open in
the latency ledger for good, which is a measurement defect rather than a user-visible one, and is
therefore the kind that survives a demo (`LATENCY-TARGETS.md`).

**A just-closed task is still context.** A message that arrives shortly after a task reaches a
terminal state is usually ABOUT that task ("where is the file?", "can you make it shorter?"). The
platform keeps a recently-closed task in scope for exactly this reason, for **10 minutes by default**,
tunable with `RECENTLY_ENDED_TASK_WINDOW_MINUTES`. The trade is stated rather than hidden, and it is
larger than one turn: someone who genuinely changes subject inside that window is answered in this
conversation for the REST of the window, on every turn in it, rather than being offered a split. That
is the cheaper of the two failures, but it is a window and not a single grace turn.

**Three decisions are made BEFORE the model sees the turn**, and all of them read task state:

| Decision | What it reads | What goes wrong without declared task state |
|---|---|---|
| Topic drift | the message embedding against the conversation summary | a direct answer to the assistant's own question is offered a new conversation |
| Intent classification | the message text alone | a short answer inside a workflow classifies as an acknowledgment |
| Model selection | the classified intent | a trivial-looking turn resolves to the cheapest model, and produces the deliverable on it |

None of the three can consult the model's judgement, because none of them has run it yet. They rely
on the machine having DECLARED that the person owes an answer. This is why `awaits` is not a
cosmetic flag: it is the signal three separate subsystems use to tell a continuation from a new
subject.

## 12. Who a step awaits: the direction, and what ships next

> **Status: DIRECTION, not description.** One part of this section ships before the platform's next
> release: the SHAPE of the declaration (§12.6). Everything else is deferred and is written here so
> the shape is chosen against the whole problem rather than against the first case. Nothing in §12.1
> to §12.7 exists as a mechanism. Where a supporting piece IS built, this section says so and names it,
> and §12.5 gives the built pieces and the missing joint as a table.

### 12.1 A step awaits a PRINCIPAL, and the right principal is often a ROLE

A state's wait declaration answers "is this blocked on a human", and `requester` is the only reference
that resolves, so it can say nothing more. The question a workflow actually asks is "which
principal is entitled to complete this step", and the answer is frequently a role rather than a named
identity, held by a person or by an assistant: the traveller's manager approves the trip, whoever
holds the finance role signs off the spend, the assistant that owns the booking capability places the
reservation.

Two distinct questions hide inside one flag today, and they separate as soon as more than one person
is in the conversation:

- **Assignment.** Who is ASKED to act, whose queue it appears in, and who gets nudged.
- **Entitlement.** Who MAY complete it. Often broader than the assignee (any account manager), and
  sometimes narrower than "anyone who can post here".

A step that records an approval from a principal who was never entitled to give it is worse than a
step that waits, which is what makes this a control rather than a convenience.

### 12.2 Three ways an owner is chosen, and one mechanism that serves all three

| Category | The reference a step declares | What resolves it | Cost and failure |
|---|---|---|---|
| **By relation to the task** | `requester`, `initiator`, the assigned user, the assigned assistant | the task record itself | free, always resolvable |
| **By relation to a person** | the manager of the requester, an account manager, a technical account manager | an external system of record, through the connectors seam | a network call: it can fail, return nobody, or return someone who is not a member |
| **By role in the conversation** | whoever holds a named role in THIS conversation | conversation membership plus a role binding | local, and the binding is already stored (§12.4) |

The third overlaps the second in practice. The overlap is in the RESOLVER, not in what the step
declares, so one declaration shape serves all three and the resolvers stay pluggable.

### 12.3 Declare a reference, resolve late, and record what was resolved

A step declares a REFERENCE to a principal. The runtime resolves it to a concrete principal at the
moment the step needs an owner, and records the resolved principal in the transition log (§6).

That ordering is what survives a **swap**. When an account manager changes, a task that stored the
RESOLVED person is now owned by someone who has left the account, and every open approval points at
the wrong principal. A task that stored the REFERENCE resolves to the new person on the next read,
while the append-only log still answers who actually held the step at each point, which an approval
may later have to defend. The same argument applies to a conversation role that changes hands
mid-task.

The corollary is a rule for authors: a field that names WHO a step awaits holds a reference, never a
resolved principal id.

Three consequences follow, and each is a decision rather than an implementation detail:

1. **Failure to resolve is a state, not an error.** A lookup that fails, returns nobody, or returns a
   non-member leaves a step with no owner. That outcome needs a declared landing state, or the step
   stalls with nothing to show for it.
2. **Admitting a resolved principal is an access-control event.** Bringing a manager into the
   conversation is usually right, because they arrive with the context. It also grants them the
   channel's history at the channel's classification. When resolution is built, admission must
   therefore be bounded by the same rules as any other membership change, and must not be a side
   effect of resolution. Nothing enforces that today, because nothing resolves.
3. **A resolver has a cost the caller must see.** A category-one reference is a record read. A
   category-two reference is a call to another company's system.

### 12.4 A role is often specific to ONE conversation, and the storage for that exists

A role need not be an organisational job title. It is frequently local to a single conversation: the
approver on this case, the reviewer of this document. Two pieces of that are already built and are
named here so the design is not re-derived:

- **The conversation type declares a SHAPE for the vocabulary and the admission policy, and nothing
  consumes it yet.** `ParticipantPolicy` (`backend/lib/config/conversation-types.ts`) carries `seed`
  (roles admitted at creation), `mayAdmit` (roles that may be pulled in on demand), and `resolveVia`
  (connectors that turn "bring in a `<role>`" into a concrete identity). Its own file groups it under
  seams that are **not yet consumed**, and no code reads those three fields. Its comment states the
  intended contract, that resolved participants are admitted at the channel's classification and
  connectors feed admission rather than bypassing it, but that contract is **stated, not enforced**.
  Consequence 2 of §12.3 is therefore a requirement on work not started, not a property the platform
  has.
- **The channel context store holds the per-conversation bindings.** `memberIdentities` carries an
  optional `role` per member (`backend/lambda/src/lib/channel-context-client.ts`), in the server-only
  store rather than in member-writable channel Metadata, and it has writers on the federated create
  and add-member paths. Two limits an author will hit: the add-member writer records an identity only
  when it has an issuer, so a NATIVE member's role cannot be stored today, and a role is truncated to
  16 characters on the create path.

So the layering is: the conversation TYPE supplies the vocabulary, the channel context store supplies
the BINDINGS, and an identity provider or a system of record is one resolver among several rather than
the source of all roles. **What is missing is the consumption side.** Nothing reads a member's role to
decide who owns a step, and `resolveVia` names the connectors runtime, which is designed and not
built (`SPEC-CONNECTORS`).

### 12.5 The assigned assistant is the fail-safe for progress

`assistantId` says whose work a task is, and it never moves (§2). That immovability is what makes it
the right anchor for PROGRESS. The awaited party changes at every boundary; the accountable assistant
does not. A task blocked on a person who never answers, or on a step whose action failed, needs a
principal accountable for noticing and acting: nudging, re-asking, reassigning, escalating, or closing
it honestly. Ownership answers who acts NEXT. This answers who is responsible when nobody does.

**Today nothing performs that role for an ordinary task**, and the pieces it would compose already
exist separately:

| Piece | State |
|---|---|
| A stall signal | Built. `turnsInState` counts consecutive task turns applying no transition and feeds `task_state_stalled`. §7 states it is a dashboard signal and NEVER a control, and nothing reads it to act. |
| A landing state | Built. `abandoned` is deliberately not terminal (§6), so a task can be parked and resumed. |
| A resume path | Built and unwired. `pauseTask` and `resumeTask` exist with unit coverage and no production caller. |
| An accountable principal | Built. `assistantId`, which never moves. |
| Something that joins them | **Not built.** |

Two adjacent mechanisms are easy to mistake for this and are neither of them it. The abandonment
detector runs on a schedule but is drift-specific: it reconciles `drift_events` outcomes, not tasks.
The battle orchestrator evaluates a round-1 deadline, but only when an event invokes it, and its
degraded branch is documented as unreachable because closing it needs a time-based trigger the battle
stack does not have. **There is no scheduled sweep for duels either.** A stranded duel ends by
stranding until its row TTL, exactly as an ordinary task does. So a task nobody advances stays open
until TTL, with no nudge and no notice.

Open questions this raises, none of them settled: what an assistant may do unasked and how often; that
a nudge posted in the conversation is visible to everyone, which collides with a task that began as a
targeted request; whether a fail-safe action is metered as a turn; and whether "close it honestly"
means `abandoned`, `failed`, or a terminal that says the platform gave up rather than the person did.

### 12.6 What ships before the next release, and what is deferred

**Ships: the declaration's SHAPE, with exactly one reference.** A state declares
`awaits: { party: 'requester' }`. `awaitsUser: true` remains accepted and is normalized to the same
meaning, so a machine authored against the older form keeps working, including one already stored in
a profile version or carried through profile export and import.

The reason to change the shape now rather than later is that this is the breaking half. Moving from a
boolean to an object changes a declaration that lives in versioned, exportable assistant
configuration. Adding further reference kinds to the object afterwards is additive and breaks
nothing. Only `'requester'` ships, because declaring a value nothing resolves would describe a
capability that does not exist.

**Deferred, and none of it is implied by the above:** any second reference kind; resolver plumbing of
any sort; entitlement enforcement; the queue and notification consequences of a step owned by someone
other than the requester; reading a conversation role to decide ownership; and the landing state for a
failed resolution.

### 12.7 Not every step is answered by a chat message

A step can need three things the current model cannot express, and they are one missing capability
rather than three:

| Case | What moves the step | Example |
|---|---|---|
| A deterministic action | the action's own outcome | create the meeting: it either succeeded or it did not, and no judgement is involved |
| An external event | a platform event | someone joins the meeting |
| Out-of-band input | a submission from another surface | an account-request or registration form, or a host system applying a proposal |

**None of the three is a model turn**, and a model turn is the only thing that can currently move a
machine. `advance_task_state` is a tool, callable only inside the turn's tool loop, and the reply path
keys on a message arriving in the conversation. So a form submitted elsewhere, an event, or a
completed action has no way to advance anything.

**The affordance half is PARTLY built, and less of it is here than it looks.** An assistant can emit a
control marker (`backend/lambda/src/lib/message-markers.ts`), and the chat client renders the ones it
parses: the active-task and battle markers. The proposal and suggestions markers are emitted for a
HOST widget that is not part of this platform, and the Apply that widget offers calls a host endpoint
that does not exist here either. So the emission half exists; the surface and the RETURN path do not.

**And one shipped machine was written against that return path.** `place_item` proposes an item and
waits for the person to confirm it. The step it was drawn for is completed by something other than a
chat message - a host applying the proposal - and nothing delivers that completion.

**So `placed` records the APPROVAL, not the apply.** The machine's own comment used to call `placed`
the host-apply landing, with the task resting in `confirming` until the apply arrived, and that
described a system this is not: on that reading no task could ever reach `placed`, because nothing
outside a model turn can move a machine, and every place-item task would sit in `confirming` until its
TTL expired. What the runtime does, and has always done, is complete the step when the person agrees
and the model advances it. A state meaning "the host actually applied it" is a DEFERRED capability
that waits on the out-of-band advance below, not a rename of this one.

The cost of that is worth stating plainly, because it is the reason the deferred capability matters:
the record cannot distinguish an approval from an applied change. A `place_item` task that reaches
`placed` says a person said yes, and says nothing about whether anything was placed.

Two things follow, and both are decisions rather than implementation details:

1. **An advance from outside a model turn needs a DECLARATION, not just an entry point.** §3 authorizes
   the edge a model proposes; §8 exists to keep state to one writer. A runtime advancer without a
   state saying it expects one is exactly the unbounded second writer that rule prevents, and the
   removed force-walker is the precedent for what that costs.
2. **An out-of-band advance is an authorization decision.** A submission that moves a task arrives on
   an API call, so the submitter has to be checked against the party the step awaits. Otherwise anyone
   holding the endpoint advances somebody else's task. This is the entitlement question of §12.1
   arriving as a concrete requirement, and it is the strongest argument for a step declaring WHO it
   awaits: an out-of-band advance has no sender to infer that from.

Note what this does NOT change. Mandatory INPUT, as opposed to a mandatory event, has a better answer
than `requires` today: a step whose fields must be supplied gives its work to a tool that DECLARES
them required in its input schema (`corporate-travel-tool.ts` declares `origin`, `destination` and
`departDate`). That is structural presence rather than semantics, and it is a stronger signal than
`requires` (§4) because the model provider honours it. It is **not** a runtime check: this document's
own tool declares `reason` required, and its handler accepts a call without one. Declaring a field
required makes it far likelier to arrive; it does not guarantee it.

## How this gets proven

| Invariant | The test that can fail |
|---|---|
| An illegal edge is refused | Request a `to` absent from the current state's `transitions`; assert `illegal_transition` and no write |
| A task that moved mid-turn is not clobbered | Authorize against a stale read; assert `state_changed` |
| Lifecycle follows the machine | A machine-backed task mid-flow is not `completed` (`shouldMarkTaskCompleted`) |
| An ending is recorded | `task-has-an-end.test.ts`: a terminal status appends an entry carrying its outcome, and a per-turn `in_progress` write does not |
| An ending releases the queue | `task-has-an-end.test.ts`: terminal statuses mirror; `in_progress` does not touch the mirror or spend a read |
| An ownership entry is not read as an edge | Assert `from`/`to` absent and `ownerFrom`/`ownerTo` present |
| Production never starts before the person has answered | `task-state-machines.test.ts`: in every declared machine, a state with an edge into a `delivers` state from outside one must await somebody |
| Both wait declarations mean one thing | `a-step-declares-who-it-awaits.test.ts`: the same machine, said each way, produces the same first owner, the same ownership boundary, the same hand-back, and the same pack-merged reading; `the-router-reads-either-wait-declaration.test.ts` drives a real turn through each |
| A machine that awaits nobody cannot declare `requires` | `step-needs-are-checked.test.ts`: the rule fires for a machine authored in the declared form, and a party nothing resolves is refused |
| A stored profile survives the shape change | `profile-manifest.test.ts`: a version whose machine says `awaitsUser: true` exports, imports and activates, and still resolves to `requester` |
| A stall never advances anything | Increment `turnsInState` across turns; assert `taskState` is unchanged |

## Related

- [`ADR-024`](../../../design/decisions/024-task-ownership.md) - one owner at a time, and why
  `assistantId` is separate.
- [`ADR-032`](../../../design/decisions/032-where-a-rule-runs.md) - the composer addresses a task
  answer; post-processing repairs the ones that reach nobody.
- [`LATENCY-TARGETS.md`](../../../guides/developer/LATENCY-TARGETS.md) - task resolution is measured
  separately from turn latency.
- [`CROSS-CHANNEL-TASKS.md`](./CROSS-CHANNEL-TASKS.md) - what a person owes, across conversations.
