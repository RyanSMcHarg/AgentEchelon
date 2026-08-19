# SPEC: Task state transitions

**Status:** Implemented. **Verified by:** `backend/test/lib/task-loop-machines.test.ts`,
`backend/test/task-state-machines.test.ts`, `backend/test/lib/task-ownership.test.ts`,
`backend/test/lib/task-has-an-end.test.ts`.

**Coverage:** `tests/e2e/task-state-machine.spec.ts` - drives a machine-backed task through real turns and
asserts the persisted `taskState` moves along declared edges rather than being inferred from the reply
text; `tests/e2e/tasks.spec.ts` - a report request opens a tracked task and the `task_id` reaches analytics,
which is what makes the machine observable to an operator rather than only to the turn that ran it.

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
every `awaitsUser` boundary, and every task-shaped chain STARTS in one - so the person holds it from
its first moment and it reaches their queue.

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

## 4. Machines are configuration, not code

`DEFAULT_TASK_STATE_MACHINES` ships the built-in graphs keyed by `taskType`; a deployment's intent pack
can supply its own (`SPEC-CONFIGURABLE-INTENT-PACK`). A machine is a map of state -> `TaskStateDef`
(`task-state-machines.ts`: `{ transitions[], terminal?, awaitsUser?, resolvedByOneResponse?, requires?,
delivers?, prompt?, placeholder? }`):

- `transitions: []` marks a **terminal** state, and `terminal` records its outcome
  (`success` | `failure` | `handoff`);
- `awaitsUser: true` marks a state blocked on the PERSON, which is what moves ownership to them;
- `resolvedByOneResponse: true` (opt-in, deliberately rare) marks a state where ONE answer from the
  person completes the step, so their reply may advance it without the model being consulted - set
  only where the step IS the answer (a confirmation, an approval, a single choice), never on
  requirements gathering;
- `requires: string[]` names WHAT the step needs from the person before the workflow can go on,
  in the person's vocabulary (it is read back to them when something is missing); the sufficiency
  check is semantic and belongs to the model. Absent, any response is treated as sufficient;
- `prompt` and `placeholder` (optional) carry the state's system-prompt fragment and placeholder
  copy, making both pack-configurable and localizable;
- `delivers: true` marks a state a document-producing workflow hands its file back from. The
  attachment gate derives its delivery states from the merged machines (never a hardcoded list a
  per-deployment machine could not match), and a file is generated when the turn **declares** a
  transition into a delivering state or from one to a terminal, or when a follow-up **inside** a
  delivering state re-produces the document with no legal transition to declare (guarded by a
  trailing-question veto, since a turn that ends by asking is not delivering). Below the 400-char
  minimum artifact size the content posts inline instead - the task advances identically either
  way; only the packaging differs. Task creation resolves the initial state from the same merged
  machines, so a pack-declared task type is never created stateless.

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

## How this gets proven

| Invariant | The test that can fail |
|---|---|
| An illegal edge is refused | Request a `to` absent from the current state's `transitions`; assert `illegal_transition` and no write |
| A task that moved mid-turn is not clobbered | Authorize against a stale read; assert `state_changed` |
| Lifecycle follows the machine | A machine-backed task mid-flow is not `completed` (`shouldMarkTaskCompleted`) |
| An ending is recorded | `task-has-an-end.test.ts`: a terminal status appends an entry carrying its outcome, and a per-turn `in_progress` write does not |
| An ending releases the queue | `task-has-an-end.test.ts`: terminal statuses mirror; `in_progress` does not touch the mirror or spend a read |
| An ownership entry is not read as an edge | Assert `from`/`to` absent and `ownerFrom`/`ownerTo` present |
| A stall never advances anything | Increment `turnsInState` across turns; assert `taskState` is unchanged |

## Related

- [`ADR-024`](../../../design/decisions/024-task-ownership.md) - one owner at a time, and why
  `assistantId` is separate.
- [`ADR-032`](../../../design/decisions/032-where-a-rule-runs.md) - the composer addresses a task
  answer; post-processing repairs the ones that reach nobody.
- [`LATENCY-TARGETS.md`](../../../guides/developer/LATENCY-TARGETS.md) - task resolution is measured
  separately from turn latency.
- [`CROSS-CHANNEL-TASKS.md`](./CROSS-CHANNEL-TASKS.md) - what a person owes, across conversations.
