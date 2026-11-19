# SPEC: Task state transitions

Status for workflows and tasks lives in [SPEC-WORKFLOWS-AND-TASKS](./SPEC-WORKFLOWS-AND-TASKS.md).

**Status:** Partial. Status for workflows and tasks lives in [SPEC-WORKFLOWS-AND-TASKS](./SPEC-WORKFLOWS-AND-TASKS.md), which holds every requirement this document used to carry, with its proof. This document describes the task machine in detail; the persona tables below cite the former ids, mapped in the requirements section.

**Coverage:** `tests/e2e/a-step-requires-its-lookup-before-the-task-moves-on.spec.ts` - a step requiring a lookup is left only after the lookup ran, and no advance is recorded as a tool error (an early advance's refusal is asserted when the model attempts one, else by the unit test `a-step-may-require-a-tool-before-the-task-leaves-it`; passed on dev 2026-11-05 (`node backend/scripts/validate.mjs --only=model-routes`), where a short acknowledgment such as "Go ahead." that resumes a stalled step is relabeled general, so the step's turn answers it (5c6b4071, `backend/test/lib/a-stalled-step-resumes-for-its-own-work.test.ts`)); `tests/e2e/an-image-is-asked-for-confirmed-drawn-and-revised.spec.ts` - an image task gathers and confirms on text, the confirming turn returns the image, and a revision draws again (passed on dev 2026-11-05); `tests/e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts` - a step override, the general route and the report route each serve their own turns of one report task (passed on dev 2026-11-05); `tests/e2e/task-state-machine.spec.ts` - the persisted `taskState` moves along declared edges, not inferred from reply text (passed on dev 2026-11-05, phase `tasks-deep`); `tests/e2e/tasks.spec.ts` - a report request opens a tracked task and its `task_id` reaches analytics (passed on dev 2026-11-05, phase `tasks`); `tests/e2e/report-flow-branches.spec.ts` - the report journey through a scoping change, a revision and completion continues the task (passed on dev 2026-11-05, phase `task-branches`); `tests/e2e/place-item-flow.spec.ts` - propose, confirm and place, where a correction is not a confirmation and a decline does not complete (passed on dev 2026-11-05, same phase); `tests/e2e/an-invitation-runs-its-workflow-until-it-is-revoked.spec.ts` (phase `welcome-workflows`) - `invitation-sent` runs for the inviter alone, the `invitation-unredeemed` deadline is scheduled and a revoked invitation's deleted, and only the kept invitation's run proceeds (fails on a deployment whose invitations function has no landing origin); verified on dev 2026-11-05, 2/2 passed (`node scripts/validate.mjs --only=welcome-workflows`); `tests/e2e/a-proposal-is-applied-once-by-its-addressee.spec.ts` (same phase) - a `send_nudge` proposal reaches the inviter alone, `POST /proposals/apply` refuses another member (`NOT_ADDRESSEE`), applies it for the inviter (the proposal records `applied`, the invitation `nudgedAt`), refuses a second apply (`PROPOSAL_DECIDED`), and one reminder reaches the typed address; verified on dev 2026-11-05, 2/2 passed, in the same run; `tests/e2e/a-workflow-step-opens-a-task-for-a-person.spec.ts` (`E2E_WORKFLOW_TASKS=1`) - FR15 to FR17: refusals name their reason, the version validates and activates, the approval opens for its subject privately with the card, approving on the card takes the run's approved edge, and a second press is refused; verified on dev 2026-11-05 (`node backend/scripts/validate.mjs --only=workflow-tasks`); `tests/e2e/a-task-deadline-ends-the-task-and-continues-the-run.spec.ts` (`E2E_WORKFLOW_TASK_DEADLINE=1`) - FR17 and FR20; verified on dev 2026-11-05 in the same run; `tests/e2e/an-idle-assistant-takes-up-its-own-work.spec.ts` (`E2E_WORKFLOW_TASK_PICKUP=1`, `E2E_TURN_QUEUE=1`) - FR20; verified on dev 2026-11-05 in the same run, with both set.

**Related:** [DESIGN-TASK-STATE-TRANSITIONS](./DESIGN-TASK-STATE-TRANSITIONS.md) - the mechanism, section by section. [ADR-066](../../../design/decisions/066-an-intents-workflow-rides-the-assistants-version.md) - an intent's workflow rides the assistant's version (the target for FR34 to FR38). [ADR-024](../../../design/decisions/024-task-ownership.md) - one owner at a time, and why the assigned assistant is separate. [CROSS-CHANNEL-TASKS.md](./CROSS-CHANNEL-TASKS.md) - what a person owes across conversations. [SPEC-CONFIGURABLE-INTENT-PACK.md](../assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) - how a deployment supplies its own machines.

**Site section:** Interaction layer, conversation.

---

## Overview

**A task is governed work on the same control plane as the people, assistants and conversations it involves.** Every conversation is an AWS resource carrying an immutable classification tag, the axis IAM evaluates, and a task lives inside one. Each classification has its own task service. A classification's assistant runtime may invoke only its own; the platform's shared callers (the channel flow, the admin tasks function and the user tasks API) may invoke each classification's service. The service refuses a conversation whose classification tag is outside the set its classification grants, and on a call naming its conversation an unreadable tag proceeds, logged, because IAM already authorized that call (`refusesChannel`, `task-service.ts`). The conversation boundary is IAM; the per-task rules (who may read or move a task) are application code enforced in one place, the task service, because the tasks table's grant carries no per-item condition.

**A private task is visible to the room as existence only.** Its detail is stripped at read, and only its owner, its assigned assistant and its requester read it in full; an unrecorded visibility reads as private (`lib/task-visibility.ts`, FR5).

**Every transition is authorized and recorded.** A step moves only along an edge its machine declares, and only when the step's own declarations hold: needs recorded with their source and evidence, a confirmation put to the person, a lookup the step requires actually run (FR3, FR7, FR26, FR33). Each move appends to an append-only log naming which writer moved it (the model's tool call or a declared platform action), the holder in force, and why (design section 6). The runtime never advances on its own judgment: every runtime edge is one a declaration names (a step action's outcome, FR29, or a choice pressed on the task card, FR17) or a platform machine's own step, such as the queue drain's (design section 6).

**Machines are configuration, versioned with the assistant.** The target ([ADR-066](../../../design/decisions/066-an-intents-workflow-rides-the-assistants-version.md)): an intent's machine is part of the assistant's version, edited in the console in the same builder as event workflows, validated, gated by a golden run that walks the task in a sandbox, and rolled back with the version; a running task stays on the version it started on; the platform machines every assistant uses to interact are fixed (FR34 to FR38). As built: a version's `intentPack.machines` declares its own machines, validated with the version and kept through export and import; a new draft starts from the machines its multi-step intents run, where the deployment keeps version bodies in S3; a platform key is refused by name on a version and on a classification pack, and resolved at runtime only from the platform set; a task records the version it started on and follows that version's machine (`machinesForVersion`, `machinesForTask`, `version-machines.ts`); and the golden walk is built. A key a version does not declare still resolves from the platform's `DEFAULT_TASK_STATE_MACHINES` merged with the classification's intent pack (`taskStateMachines`, `intent-pack.ts`, FR13). The console editor is **NOT BUILT** (FR37).

**Finishing multi-turn, multi-party work inside the conversation is expected of an assistant platform, not distinctive.** This spec delivers it (FR1 to FR14, FR25 to FR28) and marks where it falls short (FR15 to FR23). Two states are never conflated: `status` answers whether the work is live, `taskState` where in the graph it is, and a machine-backed task is `completed` only at a terminal state (FR1).

## Business Problem

Real requests take several turns, and a system with no declared shape reconstructs its position from the transcript on every turn: it re-asks answered questions, loops, and announces documents it never produced. The organization cannot tell a stalled task from a slow one, and a completion rate that merges failed, canceled, paused and running work cannot be acted on. A declared, governed task record fixes both: the assistant reads where the work stands instead of guessing, and an operator reads what happened instead of inferring it.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md). Four meet task state: one wants the work finished, one authors the graph, one tells a stall from a delay, and one judges whether the work achieved anything.

### End user

**Goal:** finish a request that takes more than one turn without leaving the conversation. They never see a state name; they see whether the assistant remembers, asks only for what is missing, delivers what they agreed, and lets them out.

| What they need | Requirement |
|---|---|
| Be remembered between turns rather than re-asked | FR1, FR6 |
| Have what they asked for recorded once, at the moment they confirmed it, and honored later | FR7, FR8 |
| Not be told a file was saved when the answer posted inline | FR8 |
| Not have the work done twice because they asked whether it was done | FR11, FR12 |
| A way out of a task that has stopped going anywhere | FR11 |
| Their reply land on the item they meant, and be asked when it is genuinely ambiguous | FR14 |
| A private request stay private, visible to the room as existence only | FR5 |
| Step out and come back, rather than being recorded as having given up | FR18 |

### AI developer

**Goal:** author machines that mean what they say. The two largest authoring errors are a waiting state that does not declare its wait and a delivering state whose prompt promises a file.

| What they need | Requirement |
|---|---|
| Declare the graph as configuration rather than change code | FR13 |
| Edit an intent's workflow on the assistant's version, in the console, and know a running task is not stranded by the edit | FR34, FR36, FR37 |
| Have an edited workflow checked against real past tasks before it serves | FR38 |
| An edge the graph forbids refused, so a machine means what it says | FR3 |
| Declare who a step awaits, in a shape an older classification pack still satisfies | FR6 |
| Declare what a step needs from the person, in the person's own vocabulary | FR7 |
| Declare which states hand a document back, and have the runtime check what it hands over | FR8 |
| Name a specific person or a role as the party a step awaits | FR15, FR16 |
| Advance a step on the outcome of an action rather than only on a model turn | FR17, FR29 |
| Limit which tools a step may use, so a checking step cannot write | FR28 |
| Fan a step out to several assistants and collect the results | FR21 |

### Admin / operator

**Goal:** know whether work is moving. Their question is "is anything wrong", and the difference between a task nobody came back to and one parked two minutes ago is the whole of it.

| What they need | Requirement |
|---|---|
| See that a model is failing to drive its task, without anything acting on that signal | FR10 |
| Tell a paused task from an abandoned one | FR18 |
| Read task execution as what happened rather than as one rate meaning four things | FR19 |
| A task nobody advanced noticed and acted on rather than left until its row expires | FR20 |
| An ending recorded with its outcome, and a queue that lets go when it ends | FR9 |

### Manager

**Goal:** know what the assistant achieves, per task rather than per turn, without opening a transcript.

| What they need | Requirement |
|---|---|
| Whether tracked multi-turn work reached its goal | FR1, FR9 |
| Completion reported apart from relevance, which is a judgment about a message | FR19 |
| Delivered documents that read as documents rather than as chat replies | FR8 |
| An approval bound to somebody entitled to give it | FR16 |

## Functional Requirements and Acceptance Criteria

**These requirements, with their status and proof, live in [SPEC-WORKFLOWS-AND-TASKS](./SPEC-WORKFLOWS-AND-TASKS.md).** Status for workflows and tasks is recorded there and nowhere else. The ids below are the ones code comments and other documents cite as "SPEC-TASK-STATE-TRANSITIONS FRn"; each maps to its row there.

| Former id | Row in SPEC-WORKFLOWS-AND-TASKS | Requirement (opening words) |
|---|---|---|
| FR1 | WT29 | Lifecycle and machine state are two separate fields |
| FR2 | WT30 | State advances only through `advance_task_state` |
| FR3 | WT31 | An edge the graph does not declare is refused |
| FR4 | WT64 | A task names one assigned assistant that never moves |
| FR5 | WT65 | A private task is room-visible as EXISTENCE only |
| FR6 | WT32 | A state declares the party it awaits as a REFERENCE the runtime resolves late |
| FR7 | WT33 | A step's declared needs ride in the tool's own schema |
| FR8 | WT34 | A delivering turn checks and corrects the document it declared before handing it over |
| FR9 | WT100 | A task's ending is an entry in the append-only transition log carrying its outcome |
| FR10 | WT54 | Stall telemetry counts consecutive task turns that applied no transition and is a dashboard signal that nothing reads to act |
| FR11 | WT35 | The runtime declines to start a second turn on work it already owes |
| FR12 | WT36 | A task records each hand-over |
| FR13 | WT37 | Machines are configuration |
| FR14 | WT101 | A plain reply is ranked against the speaker's open items in this conversation by a closed runtime-built set |
| FR15 | WT66 | A step names WHICH principal it awaits |
| FR16 | WT67 | Only a principal entitled to complete a step may complete it |
| FR17 | WT38 | A step advances on something other than a model turn |
| FR18 | WT102 | Stepping out and never coming back are separate statuses |
| FR19 | WT55 | Task execution reports as completed |
| FR20 | WT39 | A principal accountable for progress notices a task nobody is advancing and acts on it |
| FR21 | WT40 | A step fans work out to several assistants and collects the results |
| FR22 | WT68 | A task that begins as a targeted request stays targeted across its later turns |
| FR23 | WT56 | A terminal state's declared disposition survives to an operator |
| FR24 | WT41 | A machine can declare a delivery format other than Markdown |
| FR25 | WT42 | A finished task whose terminal state declares `reopens` is revisable by its requester |
| FR26 | WT43 | A step the workflow declares `presented` is put to the person before the task leaves it |
| FR27 | WT44 | The delivered file is the document the turn declares as a tool argument |
| FR28 | WT45 | A step declares the tools its turn may use (`tools`) |
| FR29 | WT46 | A step declares an `action` the platform runs on entering it |
| FR30 | WT1 | A workflow may be started by a platform event rather than by a turn's intent |
| FR31 | WT47 | A version may give a step of an intent's workflow a model of its own |
| FR32 | WT48 | A step declares what it produces (`produces`) |
| FR33 | WT49 | A step may require a tool before the task leaves it |
| FR34 | WT57 | An intent's machine is declared on the assistant's version |
| FR35 | WT51 | The platform machines every assistant uses to interact are fixed |
| FR36 | WT58 | A running task resolves its machine from the version it started on |
| FR37 | WT97 | Each intent keeps its response type, and a multi-step intent gets an editable workflow |
| FR38 | WT59 | A golden run walks a multi-step task in a sandbox |

The limits of the built rows (what FR2 does not judge, what FR11's tests cannot see, the ordering of FR15 to FR17 and FR20, FR29's at-most-once claim, and why FR23 matters) are in the design's [Known limits](./DESIGN-TASK-STATE-TRANSITIONS.md#known-limits).

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| A task as a to-do item, or as a conversation | A task exists because a delivery option said this request needs more than one turn | [Design section 1](./DESIGN-TASK-STATE-TRANSITIONS.md#1-what-a-task-is-and-what-it-is-not) |
| The runtime deciding WHEN a step's needs are satisfied | Only the answer's content can say whether it named an audience, and a keyword test for that is worthless in a deployment's second language (tenet D11) | FR7 records the accounting; the sufficiency judgment is the model's ([design section 3](./DESIGN-TASK-STATE-TRANSITIONS.md#3-how-a-transition-is-requested-and-authorized)) |
| Inferring delivery, or completion, from what a reply LOOKS like | An output-shape heuristic that decides both ships a clarifying question as a report, and a second writer to one state field is the divergence this design removes | FR2 and FR8; the shadow detector runs as a comparison ([design section 8](./DESIGN-TASK-STATE-TRANSITIONS.md#8-one-authorized-path)) |
| The conversation itself offered as a file | An assistant's history read carries targeted messages the requester may not be entitled to | [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md), "Not offered: a file containing the conversation" |
| Replacing the platform's own machines | `queue_drain`, `queued_request`, `queued_clarification`, `queued_combination` and `work_still_wanted` are how the turn queue works; code depends on their states by name | [Design, "Two kinds of shipped machine"](./DESIGN-TASK-STATE-TRANSITIONS.md#two-kinds-of-shipped-machine), [ADR-033](../../../design/decisions/033-a-conversation-answers-one-turn-at-a-time.md) |
| Resuming a task in a different conversation | A task is pinned to its conversation; the assistant is told other work exists and never picks it up here | [CROSS-CHANNEL-TASKS.md](./CROSS-CHANNEL-TASKS.md) |
| A per-state delivery format | The format is a platform decision; a deployment needing PDF or XLSX is asking for a capability, not a configuration | FR24 |
| A time-based claim to close the sub-turn window | A claim needs a non-temporal release, or a turn that dies leaves the task unanswerable, which is worse than a duplicate turn | [Design section 13.1](./DESIGN-TASK-STATE-TRANSITIONS.md#131-the-runtime-declines-to-start-a-second-turn-on-work-it-already-owes) |
| Deciding a continuation by recognizing a phrase | "stop" mid-sentence is ambiguous, a wrong guess discards work, and a phrase test does not survive another language (tenet D11) | FR11, [design section 13.2](./DESIGN-TASK-STATE-TRANSITIONS.md#132-stop-is-what-makes-declining-safe) |

## User Experience Description and Mocks

Nobody outside the deployment sees a state name; the journey is the experience.

### The end user, asking for something that takes several turns

1. **They ask for a report.** A delivery option decides it needs more than one turn, so a task opens on a declared machine whose first state awaits them, and the work is already in their list.
2. **They are asked only for what is missing, in their own words** ("the audience", "the length or format") (FR7).
3. **What they agree is recorded when they agree it.** "A concise one-page report" becomes a recorded requirement every later reader uses (FR7).
4. **The assistant works, and the conversation says so.** Nobody watches a portal.
5. **The document arrives, and reads like a document**: no greeting, no self-announcement, no question, no talk of packaging. A failing draft is corrected for up to three rounds (FR8).
6. **A short answer posts inline, and nothing claims otherwise** (FR8).
7. **Asking "is this done?" gets an answer, not the work again** (FR11, FR12).
8. **Asking for a change continues the same task**, including after delivery (FR25).
9. **They can get out.** The reply that declines a duplicate turn names `/stop`, which cancels their active tasks in that conversation and nothing else (FR11). Changing the subject also works, because drift runs before the guard.

### The end user, with more than one thing open

1. **They answer from the work item**, and the reply is addressed.
2. **Or they just type.** The runtime ranks their own open items with this assistant in this conversation and hands the ranking to the turn as an assumption (FR14).
3. **The model names the item it read the message as addressing**, and asks, naming the choices, when it cannot tell (FR14).
4. **A private request travels without its excerpt**, because the reply is visible to the room (FR5).

### The end user, in a room with other people

1. **Their private task is visible to the room as existence only** (FR5).
2. **Work handed to somebody else goes with the ability to read it**, and the person who wrote the request keeps access (FR4).
3. **A workflow can assign them a step** and they complete it on the task card, which only they receive (FR15 to FR17).

### The AI developer, authoring a machine

1. **Declare the states and their legal edges.** A state with no edges is terminal and records its outcome.
2. **Declare which states wait on a person.** Without it ownership does not move, and drift, intent classification and model selection, which run before the model, each answer wrongly (FR6).
3. **Declare what each step needs, in the person's vocabulary** (FR7), and which steps are put to the person first (FR26).
4. **Declare which states hand a document back**, with a prompt that states the conditional or says nothing about files (FR8, FR27).
5. **Narrow a step's tools, require its lookup, or make it the platform's** (FR28, FR33, FR29).
6. **Edit it on the assistant's version** (the target, FR34, FR37): choose multi-step as the intent's response type, edit its workflow in the builder event workflows use, and activate the version through the golden-set gate, which walks the task (FR38). As built, a machine is declared in the version's `intentPack.machines` (exported and imported as JSON) or the classification's intent pack, and a version selects among them with `workflows`; a pack written in the older wait form still reads the same (FR6, FR13, FR34). The console editor is **NOT BUILT** ([ADR-066](../../../design/decisions/066-an-intents-workflow-rides-the-assistants-version.md)).
7. **What they cannot express yet:** a role's holder resolved again at each step, entitlement apart from assignment, an advance on an event other than a deadline, an action on a connector operation, or a fan-out step (FR15, FR16, FR17, FR21, FR29).

### The admin / operator

1. **Open the task list for an intent and read what happened.** A machine-backed task cannot read Completed while its machine is generating (FR1).
2. **See a stall as a stall**, a counter nothing acts on (FR10).
3. **Read task execution as what happened**: per intent, completed, failed, abandoned and still running, beside relevance (FR19). **What they cannot do yet:** tell a task parked two minutes ago from one nobody came back to; the abandoned count is the paused reading (FR18).
4. **A task assigned to an assistant is taken up when it is idle, and a workflow task ends at its deadline** (FR20). A task no workflow opened, that nobody advances, stays open until its row expires.

**Mocks:** none. The task surfaces are the conversation, the person's open-work list and its task card, and the administrators' Effectiveness drill, each specified where it lives.

## Related Documents

- [DESIGN-TASK-STATE-TRANSITIONS.md](./DESIGN-TASK-STATE-TRANSITIONS.md) - the mechanism behind every requirement above, with its diagrams and invariant tests
- [ADR-024](../../../design/decisions/024-task-ownership.md) - one owner at a time, and why the assigned assistant is separate
- [ADR-032](../../../design/decisions/032-where-a-rule-runs.md) - the composer addresses a task answer; post-processing repairs the ones that reach nobody
- [ADR-063](../../../design/decisions/063-a-workflow-step-assigns-a-task-and-an-idle-assistant-takes-up-its-own.md) - a workflow step assigns a task, and an idle assistant takes up its own
- [ADR-066](../../../design/decisions/066-an-intents-workflow-rides-the-assistants-version.md) - an intent's workflow rides the assistant's version, and a golden run walks it
- [CROSS-CHANNEL-TASKS.md](./CROSS-CHANNEL-TASKS.md) - what a person owes, across conversations
- [DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md](./DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md) - the task service, its access model, and the queue's machines
- [SPEC-CONFIGURABLE-INTENT-PACK.md](../assistants/SPEC-CONFIGURABLE-INTENT-PACK.md) - the pack a deployment declares its own machines in
- [SPEC-DRIFT-CONVERGENCE.md](../assistants/SPEC-DRIFT-CONVERGENCE.md) - "Active-Task Suppression", which depends on the wait declaration
- [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md) - the visibility boundary a delivered artifact sits inside
- [HOW-TO-ADD-OR-MANAGE-A-PROFILE.md](../../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) - "What the runtime checks before it delivers", and the numbers behind every threshold
- [LATENCY-TARGETS.md](../../../guides/developer/LATENCY-TARGETS.md) - task resolution is measured separately from turn latency
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the four personas above

## Section index

Source files cite the mechanism by section number, as in `SPEC-TASK-STATE-TRANSITIONS §3`. Each number below is the section of the same number in the design.

### 1. [What a task is](./DESIGN-TASK-STATE-TRANSITIONS.md#1-what-a-task-is-and-what-it-is-not)
### 2. [Three roles](./DESIGN-TASK-STATE-TRANSITIONS.md#2-a-task-has-three-roles-because-they-change-at-different-rates-adr-024)
### 3. [How a transition is requested and authorized](./DESIGN-TASK-STATE-TRANSITIONS.md#3-how-a-transition-is-requested-and-authorized)
### 4. [Machines are configuration](./DESIGN-TASK-STATE-TRANSITIONS.md#4-machines-are-configuration-not-code)
### 5. [Proposals drive their own edges](./DESIGN-TASK-STATE-TRANSITIONS.md#5-proposals-drive-their-own-edges)
### 6. [The transition log](./DESIGN-TASK-STATE-TRANSITIONS.md#6-the-transition-log)
### 6a. [Abandoned means paused](./DESIGN-TASK-STATE-TRANSITIONS.md#6a-abandoned-means-paused-and-that-is-the-defect)
### 7. [Stall telemetry](./DESIGN-TASK-STATE-TRANSITIONS.md#7-stall-telemetry)
### 7a. [A turn that ends owing a move](./DESIGN-TASK-STATE-TRANSITIONS.md#7a-a-turn-that-ends-owing-a-move)
### 8. [One authorized path](./DESIGN-TASK-STATE-TRANSITIONS.md#8-one-authorized-path)
### 9. [Who decides what](./DESIGN-TASK-STATE-TRANSITIONS.md#9-who-decides-what-the-platform-and-the-deployment)
### 10. [Delivery: attachment or inline](./DESIGN-TASK-STATE-TRANSITIONS.md#10-delivery-attachment-or-inline-and-how-an-author-steers-it)
### 11. [Defaults an author has to know](./DESIGN-TASK-STATE-TRANSITIONS.md#11-defaults-an-author-has-to-know-because-nothing-asks)
### 12. [Who a step awaits](./DESIGN-TASK-STATE-TRANSITIONS.md#12-who-a-step-awaits)
### 12.3 [Declare a reference, resolve late](./DESIGN-TASK-STATE-TRANSITIONS.md#123-declare-a-reference-resolve-late-record-what-was-resolved)
### 12.6 [The declaration's shape](./DESIGN-TASK-STATE-TRANSITIONS.md#126-the-declarations-shape)
### 13. [One thread per piece of work](./DESIGN-TASK-STATE-TRANSITIONS.md#13-one-thread-per-piece-of-work-and-the-way-out-of-it)
