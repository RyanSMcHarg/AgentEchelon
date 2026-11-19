---
title: "ADR-067: A workflow is triggered by an event or an intent, and its steps create tasks"
status: "Stage 1 and decision 8 Accepted 2026-11-05; every open question and worked-example gap decided 2026-11-05; the other decisions and stages 2 to 5 Proposed. Status lives in SPEC-WORKFLOWS-AND-TASKS."
date: 2026-11-05
related:
  - "./061-a-welcome-is-a-workflow-an-event-starts.md"
  - "./063-a-workflow-step-assigns-a-task-and-an-idle-assistant-takes-up-its-own.md"
  - "./064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md"
  - "./065-a-draft-answers-the-golden-set-before-it-is-activated.md"
  - "./066-an-intents-workflow-rides-the-assistants-version.md"
  - "./033-a-conversation-answers-one-turn-at-a-time.md"
  - "./024-task-ownership.md"
  - "./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md"
  - "./036-why-turns-enter-through-amazon-lex.md"
  - "./047-a-turn-resolves-its-task-machines-once.md"
  - "./048-an-assistant-is-not-a-classification.md"
  - "../../overview/TENETS.md"
  - "../../specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md"
  - "../../specs/interaction/conversation/DESIGN-TASK-STATE-TRANSITIONS.md"
  - "../../specs/interaction/quality/SPEC-BATTLE.md"
  - "../../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md"
  - "../../specs/interface/SPEC-ADMIN-CONSOLE.md"
  - "../../specs/interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md"
  - "../../../backend/lambda/src/lib/event-workflow.ts"
  - "../../../backend/lambda/src/lib/event-task.ts"
  - "../../../backend/lambda/src/lib/event-run-store.ts"
  - "../../../backend/lambda/src/lib/task-state-machines.ts"
  - "../../../backend/lambda/src/lib/task-step.ts"
  - "../../../backend/lambda/src/lib/task-tools.ts"
  - "../../../backend/lambda/src/lib/version-machines.ts"
  - "../../../backend/lambda/src/lib/task-tracking.ts"
  - "../../../backend/lambda/src/lib/workflow-task.ts"
  - "../../../backend/lambda/src/lib/golden-walk.ts"
  - "../../../backend/lambda/src/lib/assistant-ownership.ts"
  - "../../../backend/lambda/src/router-agent-handler.ts"
  - "../../../backend/lambda/src/assistant-async-processor.ts"
  - "../../../backend/lambda/src/task-service.ts"
  - "../../../backend/lambda/src/user-tasks-api.ts"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
  - "../../../backend/lambda/src/analytics-aurora/analytics-query.ts"
  - "../../../frontend/packages/admin/src/components/admin/WorkflowBuilder.tsx"
---

# ADR-067: A workflow is triggered by an event or an intent, and its steps create tasks

## Status

**Stage 1 and decision 8 Accepted 2026-11-05; everything else Proposed.** The owner accepted stage 1 (one Workflows list in the console over today's engines) and decision 8's participation model (no routing or assignment in the platform; direct and indirect participants; only a reference leaves the platform, with the one exception decision 8 names), and named the next design record: events in and out, proven with the PagerDuty connector. On 2026-11-05 the owner also decided every open question (the decisions section below records each choice) and every worked-example gap ("Decisions on the worked examples' gaps"); the only open items are ADR-066's two, which SPEC-WORKFLOWS-AND-TASKS lists. Stages 2 to 5 are Proposed with their questions decided. Little here is built: the assistant page's "Shipped" label (WT53) and the duel rule (WT107) hold today. **Status for every part lives in [SPEC-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/SPEC-WORKFLOWS-AND-TASKS.md)**; this record keeps why each part is shaped as it is. It amends ADR-061 decision 1 (an event is no longer the only trigger of a workflow), ADR-063 decision 1 (which machines a task step may open, and what a step continues on), and ADR-066 decisions 3 and 4 (an intent's workflow is edited in the one Workflows list rather than from the intent's card).

## Context

An assistant runs two kinds of multi-step work today, on two engines, and the console presents them as two things.

| | Event workflow (ADR-061, ADR-063) | Task machine (ADR-066, SPEC-TASK-STATE-TRANSITIONS) |
|---|---|---|
| Started by | a platform event, one of `EVENT_WORKFLOW_EVENTS` (`backend/lambda/src/lib/event-workflow.ts:60`) | a person's message the classifier labels with an intent whose delivery is `TASK_MULTI_STEP` and whose key names a machine the version may open (`backend/lambda/src/router-agent-handler.ts:9685`, `backend/lambda/src/lib/delivery-options.ts:37`) |
| Shape | `EventWorkflow`: `on`, `types`, `initial`, `states` of `EventStepDef`, `deadline` (`backend/lambda/src/lib/event-workflow.ts:308`, `:340`) | `TaskStateMachine`: `initial`, `states` of `TaskStateDef` (`backend/lambda/src/lib/task-state-machines.ts:59`, `:635`) |
| Step kinds | `send`, `agent`, `opening`, `prompt`, `action` (the intake), `task`, and a terminal `disposition` (`backend/lambda/src/lib/event-workflow.ts:308`) | one kind, a state: a model turn under `prompt`, `tools`, `requiresTool`, `requires`, `produces`, `presented`, `confirm`, `brief`, `template`; a wait under `awaits` and `choices`; a platform act under `action`; a pause under `rests`; an end under `terminal` and `reopens` (`backend/lambda/src/lib/task-state-machines.ts:69` to `:339`) |
| Who moves it | the router's runner, which takes declared edges on each step's outcome (`runEventWorkflow`, `backend/lambda/src/lib/event-workflow.ts:1380`) | the model's `advance_task_state` call, a declared action's outcome, a card choice pressed by the assignee, or a deadline, each through the task service (`advanceTaskStateTo`, `backend/lambda/src/lib/task-tracking.ts:2907`; SPEC-TASK-STATE-TRANSITIONS FR2) |
| Graph | acyclic, at most `MAX_EVENT_RUN_STEPS` moves (`backend/lambda/src/lib/event-workflow.ts:356`) | may loop (revising, reopen), bounded per turn |
| Spans turns | at an `agent` or `task` step, continued once by `continueAfter` (`backend/lambda/src/lib/event-workflow.ts:1528`) | at every state that awaits a party, resumed by that party's message, a card press or a pickup |
| Stored on | the version's `eventWorkflows` | the version's `intentPack.machines`, over the classification's and the platform's (`machinesForVersion`, `backend/lambda/src/lib/version-machines.ts:67`) |
| Console | the Workflows section's builder, with the welcome among event workflows (SPEC-ADMIN-CONSOLE FR59) | read-only steps behind **View steps**; a separate "Task workflows" heading under Workflows (SPEC-ADMIN-CONSOLE, the Workflows section) |

The two already meet. A workflow's `task` step opens a task of a machine and waits for it to settle (`TaskStep`, `backend/lambda/src/lib/task-step.ts:38`); an `agent` step's `workflow:` opens an `incident_first_look` task, the one entry of `EVENT_TASK_MACHINES` (`backend/lambda/src/lib/event-workflow.ts:130`, `:221`); an event run is itself recorded on a task record marked as a run (`EVENT_RUN_STATUS`, `backend/lambda/src/lib/event-run-store.ts:18`). So the platform has one idea expressed twice: something starts work, the work is a sequence of steps, and some of the steps hand a tracked piece of work to somebody.

The owner's direction, 2026-11-05: "I am wondering if we can simplify. Events and user messages kick off workflows, the workflow can include one or more task creation"; the intent workflows and the welcome "should all be editable"; "The platform workflows should be in a separate section explaining that they are used for managing task opening, viewing, closing and managing queues"; "Anything that is common for managing queue, tasks, that are platform level and need consistency are platform"; "Incident first look should be editable"; the key considerations are "analytics, including tracking versions. Machine states when specific steps need specific requirements to move forward. Ownership of workflows and tasks. Whether steps can be in parallel or not. Tracking open tasks for users, what appears in the task list etc"; on assignment, "We will not build workforce management, routing etc into this platform at least not anytime soon. Passing events back and forth and adding users signed in from existing tools is the model I want"; on reopening, "Don't we already allow revision? Seems like we should just allow it and it can be a new workflow if needed, but how do we track how often a task needs to be reopened for rework?"; and on private requests, "Withhold everything".

The direction is to say that once: events and a person's messages start workflows, and a workflow can create one or more tasks. That changes what a team sees and edits, and, carried through, how the router, the processor, the task service and the console run and store multi-step work. This record decides the model, which parts stay the platform's, the five considerations the owner named (decisions 6 to 10), and the order in which the change is safe to make.

## Decisions

### 1. Three terms, and the trigger set

- **Trigger.** What starts a workflow, one of four kinds: a platform event, a person's message through the intent the classifier labels it with, an explicit command, or an inbound fact from another tool (the next record, "events in and out").
  - The events are today's closed set: `assistant-joined`, `conversation-opened`, `person-joined`, `invitation-sent`, `invitation-unredeemed`, `alarm-state-changed` (`EVENT_WORKFLOW_EVENTS`, `backend/lambda/src/lib/event-workflow.ts:60`), each verified on arrival as ADR-061 decision 1 states. `task-reopened` joins the set (decision 2), and the meeting events join it when the meetings code lands, as ADR-061 already says.
  - An intent trigger is `on: { intent: <key> }`. The classifier decides the intent once for the turn and records it as data (`classification.intent`, the label every later reader uses); no trigger reads the message's words, and no step decides by recognizing a phrase (tenet D11). A workflow's trigger is a declaration matched against that label by key.
  - **Proposed amendment (2026-11-05):** the explicit command a person invokes. Owner: "In the future meetings will also trigger a workflow and that may be from a button or a slash command." A workflow declares `on: { command: <name> }`; the one declaration is offered as a button in the client and as a slash command, recognized as a platform-defined token at the start of the message, before any task binding (pattern work on a token the platform defines, which tenet D11 allows, as `/battle` and `/stop` are recognized in `backend/lambda/src/lib/flow-bypass.ts`); a press arrives on `PersonApi` for the caller the edge resolved and is refused unless the caller is a member cleared for the conversation's classification. The run acts as the person who invoked it and takes the visibility of the surface it came from, private by default (decision 8). **NOT BUILT.**
  - An intent workflow declares the conversation types it runs in, so a step may name a participant role; in a conversation of another type the canonical workflow runs (decided 2026-11-05, G20).
- **Workflow.** The steps a trigger runs, in the order its edges choose. Step kinds: **send**, **model turn** (a prompt turn or an agent turn), **wait** (for a time or an inbound fact; a wait on a person is a create-task step), **create a task**, **intake**, and **end**. A workflow may span turns: it stops at an agent turn handed to the processor, at a wait and at a created task, and continues once when that step completes. A welcome's prompt turn does not stop the run: nothing follows it in the run (`PromptWelcomeStep`, `backend/lambda/src/lib/event-workflow.ts`).
- **Task.** The tracked record a create-task step makes: its requester, its assignee and its assistant (ADR-024, decision 8 below), its state, its card, its deadline, its deliveries, its origin version (ADR-066 decision 5). It is what a person sees in their open work and on the card (decision 10). A workflow creates zero, one or several tasks, one after another (decision 9).

**How an intent trigger relates to today's rule.** Today an intent whose delivery is `TASK_MULTI_STEP` and whose key names a machine the version may open opens a task of that type on the turn that classified it (`taskType = turnMachines[classification.intent] && mayOpen(...)`, `backend/lambda/src/router-agent-handler.ts:9685`), and that turn works the task's first step. Under this record that rule is a workflow:

```yaml
report_generation:
  on: { intent: report_generation }
  initial: work
  states:
    work:
      task:
        machine: report_generation   # the task's own steps (decision 2); must be the machine keyed by the intent
        for: requester               # the person whose message triggered the run
        # by: absent, the run's own assistant
        # deadline: absent, exempt on an intent trigger's canonical step
      onSuccess: done
      onFailure: done
    done: { disposition: success }
```

- **The canonical intent workflow is the router's rule, not a stored `TaskStep`.** Where a version declares no workflow on an intent that today opens a task, the runtime runs exactly what the router runs today, and the YAML above is how the console draws it. Its create-task step differs from a validated `TaskStep` (`backend/lambda/src/lib/task-step.ts:38`) in three ways, each of which reproduces today's behavior:
  - It schedules no deadline. `TaskStep.deadline` is required, 5 minutes to 30 days (`backend/lambda/src/lib/task-step.ts:50`, `:160` to `:164`), and a deadline cancels the task when it falls (ADR-063 decision 4). No intent task has one today, so an intent trigger's create-task step is exempt from ADR-063 F1 unless it declares one.
  - It keeps the work items' options: `place_item` and `action_item` open with the plan's `contextId` and `TRIP_TASK_TTL_SECONDS`, and an `action_item` with the requester as its holder (`backend/lambda/src/router-agent-handler.ts:9695` to `:9704`). `TaskStep` has no field for either, and gains none: the canonical step inherits them from the router.
  - It keeps the `general` fallback: a `TASK_MULTI_STEP` intent whose machine is missing or deselected opens a `general` task (`backend/lambda/src/router-agent-handler.ts:9685` to `:9687`), which no create-task step can name.
  - Stage 3 materializes the canonical workflow in a new draft, the way `withStartingMachines` copies the starting machines (`backend/lambda/src/lib/profile-lifecycle.ts:1163`), so a version says what it runs; the materialized entry carries the same three properties as data the validator accepts only on an intent trigger's first create-task step.
- **The first create-task step names the intent's own machine.** On an intent trigger, validation refuses a first create-task step whose `machine` is not the intent's key (error: `intentWorkflows.<key>.states.<step>.task.machine is <key>: the first task an intent opens is the intent's own`). This keeps the stalled-step rule and continue-before-trigger exact (decision 2, the guarantees table).
- **The turn that triggered it works the first step.** A create-task step reached on an intent trigger's own turn opens the task through the router's door (`createTask`, `backend/lambda/src/router-agent-handler.ts:9710`) with `workflowRun` set and no ready naming, and that turn works it, as today, so the person waits no longer than now. It does not go through `openWorkflowTask`, which names the task ready on creation (`backend/lambda/src/task-service.ts:662`, `nameWhatChanged`), so no idle pickup races the triggering turn for the first step. The settlement naming applies as for any task that records a run (`backend/lambda/src/task-service.ts:581` to `:582`).
- **Continue before trigger.** A message from a person who already has a live task of this assistant in the conversation goes to that task's turn, as today, where the model judges whether the message is about the task and answers an aside without advancing it (`activeTask`, `backend/lambda/src/router-agent-handler.ts:9603`; `selectDeliveryOption` keeps an active task multi-step, `backend/lambda/src/lib/delivery-options.ts:37`); it starts no second run. Decided 2026-11-05: when that turn reads the message as a new request for a different multi-step intent, it opens the request as its own task and the first keeps waiting (**NOT BUILT**). One thread per piece of work holds (`assistantOwesTheStep`, `backend/lambda/src/lib/task-state-machines.ts:624`).
- **Single-turn intents have no workflow.** An intent whose delivery is `DIRECT` or `PLACEHOLDER_UPDATE` is answered in one turn, as today, and no workflow run is recorded for it. A one-step workflow wrapping every single turn is rejected (Options considered): it would write a run record per turn, add a hop before the reply and measure nothing the turn's own record does not already carry (tenet D7). The response type stays the intent's choice (ADR-066 decision 3); choosing `TASK_MULTI_STEP` gives the intent a workflow.
- **What an intent workflow may do that today's rule cannot.** Continue after its task settles: ask a participant role's holder to approve the delivered result (a create-task step over `approval`), tell the room (a send), or open a second task. Each is bounded by the reopen rule (decision 2: steps after a task that reopens run once, at its first settlement) and the audience rule (decision 8).
- **The run is keyed by the turn's correlation id.** An intent run's key is `intent#<correlationId>#<assistant>`, beside `eventRunKey` (`backend/lambda/src/lib/event-workflow.ts:1010`). The correlation id is the id the turn's own fulfillment claim deduplicates a redelivered message on (`fulfil-${correlationId}`, `backend/lambda/src/router-agent-handler.ts:8834`): declared on a bypass, derived from the message id where one is declared, and otherwise from the 90-second bucket of the channel, sender and text (`backend/lambda/src/router-agent-handler.ts:8500` to `:8508`; `turnCorrelationId`, `backend/lambda/src/lib/correlation.ts:83`). The inbound message id is not used: it comes from a best-effort lookup that matches stored text and returns `''` on failure (`inboundMessage`, `backend/lambda/src/router-agent-handler.ts:7888` to `:7901`). A turn with no correlation id opens its task as today and runs no run-level steps. The task records the correlation id (`backend/lambda/src/lib/task-tracking.ts:881`), so a continuation can recompute the key from the row (stage 3).

### 2. One model over two engines: a task step owns its task's steps, and the run never writes the task's state

The cleanest rule, and the one this record adopts: **a workflow has two levels, and each level has one writer.**

- **The run level** is the workflow's own graph: sends, model turns, waits, create-task steps, intakes and ends, taken by the router's runner on each step's outcome (`runEventWorkflow`). It stays acyclic, sequential (decision 9) and bounded by its step count.
- **The task level** is the steps inside a create-task step: the task's machine. A task's state is the name of the step it is in, written only by the paths that write it today, all through the task service: `advance_task_state`, a declared action's outcome, an assignee's card press, a deadline's cancel, an operator's cancel, and, for an `agent` step's event task today, the processor's one system advance once the step posted (`backend/lambda/src/assistant-async-processor.ts:1834` to `:1839`, taking the first step's one declared transition from `openEventTask`, `backend/lambda/src/lib/event-task.ts:67`), which SPEC-TASK-STATE-TRANSITIONS FR2 permits only as a platform machine's own step. A task may loop, as a revision does.
- **The run observes the task's ending, never its middle.** The run waits at the create-task step and continues once when the task settles, on `onSuccess` for a success terminal, `onDeadline` (else `onFailure`) for a deadline, `onFailure` otherwise (an operator's cancel reads as `task:failure:<state>`, `settlementOutcome`, `backend/lambda/src/lib/workflow-task.ts:34` to `:40`), reading the terminal state as `task:state` on that step's edges only (`continueAfter`, `backend/lambda/src/lib/event-workflow.ts:1528`; ADR-063 decision 3). No run step sets a task's state, so the assignee and the state keep one writer each (ADR-024 D8; SPEC-TASK-STATE-TRANSITIONS FR2).

In the console both levels are one builder: a create-task step opens to its task's steps, drawn with the same canvas and palette, so a team edits "the workflow" and sees where the tracked part begins and ends. In storage the task's steps stay the machine the step names, so ADR-066's hashing (`originMachineHash`) and origin pinning are unchanged.

**What survives of each engine's fields.** Every field survives; the change is the vocabulary the console and the docs use and which level a field belongs to.

| Unified step | Level | Today's event step fields | Today's machine state fields |
|---|---|---|---|
| Send | run, and a task step's entry action | `send`: `to`, `template`, `mention`, `fromRole`; the welcome's `opening` | none; a state's `action: { tool: deliver_document }` posts a platform-filled document |
| Model turn | run (agent, prompt) and task (a state with a `prompt`) | `agent`: `prompt`, `tools`, `to`, `deadlineMs`, `fallback`, `propose`, `opens`, `reads` (`as` is retired by the ownership tenet, WT118); the welcome's `prompt` | `prompt`, `label`, `placeholder`, `tools`, `requiresTool`, `requires`, `produces`, `presented`, `confirm`, `brief`, `template`, `templates`, `defaultTemplate`, `resolvedByOneResponse` |
| Wait | task | none at run level today | `awaits` (`requester`, `worker`), `choices`, `rests` |
| Create a task | run | `task`: `machine`, `for`, `by`, `visibility`, `priority`, `deadline`; `agent.workflow` | none |
| Intake | run | `action: { tool: start_intake, to }` | none |
| Start a meeting | run, with the `meetings` capability | `action: { tool: start_meeting, ringSeconds, notice, email }`: the conversation's meeting started or found, a ring sent to its connected members, the room told and emailed the join link, the link in the run's values as `meeting_link` (SPEC-ASSISTANT-MEETINGS FR39). To ask first, a `meeting_offer` task step goes in front, its `start` ending on to the meeting (FR40) | none |
| Platform action | task | none | `action` with `onSuccess`, `onFailure` |
| End | both | `disposition` | `terminal`, `reopens` |
| Edges and conditions | both | `onSuccess`, `onFailure`, `onDeadline`, conditioned `{ to, when }` lists, a step's `when` | `transitions`, `edgeWhen`, a state's `when`, `onSuccess` and `onFailure` of an action |

**A model-advanced transition, as steps.** A task-level model turn's outgoing edges are the moves the model may ask for; decision 7 records what each requirement is, who checks it, and what the model decides against what code decides. The model never moves a run-level edge.

**A wait spans turns, at either level, as a fact on a record.**

- **Inside a task**, a wait is a step that `awaits` a party. Entering it hands the task to that party through the one writer (`setTaskAssignee`, `backend/lambda/src/lib/task-tracking.ts:251`), so it appears in their open work (decision 10); the party's next message is routed to the task by the referent rule (FR14), or they press a choice on the card (`advanceAsAssignee`, `backend/lambda/src/task-service.ts:673`), and the assistant takes up the step that follows when it is idle (`pickupReadiness`, `backend/lambda/src/lib/workflow-task.ts:103`).
- **At the run level**, a wait on a person is a create-task step over a waiting platform machine: `approval` for a decision, `acknowledgement` for a confirmation (`backend/lambda/src/lib/task-state-machines.ts:1346`, `:1363`). A wait on a person must be in their open work, carry a deadline and be completable on a card, which are a task's guarantees, so the builder's **Wait** step for a person writes a task step and shows only the party, the choices and the deadline. A wait for a time or for an inbound fact is a run-level `wait` step (decided 2026-11-05, G4, G33), because nobody's open work holds it. A written answer is the platform form machine (decided 2026-11-05, G16).
- **A run that stops** is recorded on its run record, and continues once (`continuationClaim`, `backend/lambda/src/lib/event-workflow.ts:1348`) when the task service names the settlement to its own router (`handleTaskNaming`, `backend/lambda/src/router-agent-handler.ts:3211`). A time a step waits for is a one-shot schedule (`handleTaskDeadlineFired`, `backend/lambda/src/router-agent-handler.ts:3900`). A naming that is lost leaves the run stopped (ADR-063 decision 6; the task service never retries it, `backend/lambda/src/task-service.ts:571` to `:574`); under this record that includes the steps after a person's request, so the low-frequency reconciliation sweep tenet D6 calls correct design behind an event path is a stage 3 prerequisite (OPEN 10).

**A task step may continue on opening, not only on settling.** The ops room's first look opens `incident_first_look` and the run goes on once the first look is posted, while the task rests in the room until someone says the incident is over (`backend/lambda/src/lib/event-workflow.ts:383` to `:397`; `findings_shared` declares `rests`, `backend/lambda/src/lib/task-state-machines.ts:930`). A create-task step therefore declares `continue: settled` (the default, ADR-063 decision 3) or `continue: opened`, which takes `onSuccess` once the task leaves its initial state and leaves the task to its own steps. **NOT BUILT.** How the task leaves its first step under FR2, once the machine is the team's:

- **The automatic move is declared (decided 2026-11-05, G39).** The processor's system advance (`backend/lambda/src/assistant-async-processor.ts:1834`) is permitted today only because `incident_first_look` is a platform machine whose one transition the runtime takes. Once the machine is the team's, its first state declares the move as data (`auto: findings_shared`), validation refuses an `auto` that names an edge the state does not declare, and the runtime takes it once per entry after the first look's turn posts. That is a runtime advancer of the FR17 kind on a platform-validated edge, so FR2's rule holds (the runtime takes only a declared edge, never one of its own judgment) and a team's edit names the edge. The create-task step opens the task held by the ops assistant (`by: { assistantRole: 'ops' }`), the task service names it ready, and a pickup turn works `reading_health` (ADR-063 decision 5). **NOT BUILT.**
- **The signal that continues the run.** The task service names only `settled` and `ready` today (`backend/lambda/src/task-service.ts:581` to `:586`; `handleTaskNaming` refuses any other kind, `backend/lambda/src/router-agent-handler.ts:3213`). It gains `kind: 'entered'`, named when a task whose `workflowRun.continue` is `opened` leaves its initial state, which `handleTaskNaming` handles by continuing the run on the step's `onSuccess` under the step's continuation claim, so a later return to the initial state continues nothing. **NOT BUILT.**
- **A first step whose turn fails.** A pickup turn that ends without posting holds the entry (`worked-this-entry`, `backend/lambda/src/lib/workflow-task.ts:120`), so no second pickup runs the first look again; the run waits at the step until the task leaves its initial state or settles, and a settlement before `entered` continues on the settlement's edge.

**A task that can reopen ends the run's interest at its first settlement.** `report_generation`'s `completed` declares `reopens: ['revising']` and `image_generation` reopens into `revise` (`backend/lambda/src/lib/task-state-machines.ts:857`, `:1102`), while the run continues once per step (`continuationClaim`). Decided 2026-11-05 (the owner's words are in Context): steps after such a task are allowed and run once, when the task first finishes; a later reopen raises a `task-reopened` event, so a team that wants the revised result approved again attaches a workflow to that event; and rework is measured from the reopen transitions the archive already holds, as a view in Effectiveness rather than a new counter (tenet D7). The shipped `report_generation` therefore carries the approval example of decision 1 without a team copy. **NOT BUILT.**

**The alternatives for how a task's state relates to the run's step.**

| Rule | What it means | Why not, or why |
|---|---|---|
| **A. The task step owns its task's steps; the run sees the ending only (adopted)** | Two levels, one writer each; the builder draws them as one workflow | Keeps the one writer of state and assignee, the acyclic run, the per-entry claims, origin pinning and the golden walk exactly as built; the console still shows one model |
| B. Flatten: a task is a span of run steps between "create" and "close" | The task's state is the run's current step | The run graph must then loop (revisions, reopen), so the bounded acyclic run is lost; the run record and the task row become one record with two writers (the router's runner and the task service); every task reader (`machinesForTask`, the open-work mirror, pickup, the card) would read run state. The largest rewrite for no new capability |
| C. Run steps set the task's state ("set state" steps) | The workflow drives the task from outside | A second writer of a task's state beside `advance_task_state` and the card, which FR2 and ADR-024 exist to prevent; a run step and a model turn racing on one task |

**The platform's guarantees, kept.** Each holds because rule A leaves the code that holds it in place:

| Guarantee | Held by |
|---|---|
| One thread per piece of work | `assistantOwesTheStep` (`backend/lambda/src/lib/task-state-machines.ts:624`) and continue-before-trigger (decision 1) |
| The stalled-step rule | `resumesAStalledStep` (`backend/lambda/src/lib/task-continuity.ts:239`), read by the router (`backend/lambda/src/router-agent-handler.ts:8174`) on the task's state. Its candidate test compares the task's type with the type the turn opens (`isStalledStepCandidate`, `backend/lambda/src/lib/task-continuity.ts:287`; `turnOpensTaskType`, `backend/lambda/src/router-agent-handler.ts:6840`, `:6866`), and the type the turn opens is the intent's key. It stays exact because an intent trigger's first create-task step names the machine keyed by its intent (decision 1, validated); a later task of the run is never a stalled-step candidate for that intent |
| The turn queue | the turn lock and its handover (ADR-033); a run-level model turn takes no lock, as an agent step does today, and a task-level turn takes it, as a pickup does (ADR-063 decision 5) |
| Task ownership and handover | `setTaskAssignee` and `maybeHandOver`, at the task's `awaits` boundaries only (ADR-024 D8; decision 8) |
| Cards and the second press refused | `choices` on a waiting step, `advanceAsAssignee` and its refusals (`backend/lambda/src/task-service.ts:673`; `assigneeAdvanceRefusal`, `backend/lambda/src/lib/workflow-task.ts:70`) |
| Deadlines | a create-task step's required `deadline` (`backend/lambda/src/lib/task-step.ts:50`), on the classification's scheduler; an intent trigger's canonical step is exempt (decision 1) |
| Idle pickup | `pickupReadiness` and `orderForPickup` (`backend/lambda/src/lib/workflow-task.ts:103`, `:138`), reading `awaits`, `rests`, `action` and the row |
| Origin-version pinning | `originConfigId` and `originMachineHash` on the task (`originTaskFields`, `backend/lambda/src/router-agent-handler.ts:6664`; `machinesForTask`, `backend/lambda/src/lib/version-machines.ts:108`), extended to the run (decision 5) |
| Golden walks | `walkTask` (`backend/lambda/src/lib/golden-walk.ts:219`) walks a create-task step's machine, as it walks an intent's machine today (decision 6) |

### 3. The platform workflows stay the platform's, fixed

The platform workflows are the machines in `PLATFORM_MACHINE_KEYS` (`backend/lambda/src/lib/task-state-machines.ts:724`): the turn queue's five (`queue_drain`, `queued_request`, `queued_clarification`, `queued_combination`, `work_still_wanted`, `PLATFORM_TASK_MACHINE_KEYS`, `:707`), the work items `action_item` and `place_item`, and the asks `approval` and `acknowledgement`. They are the shared mechanics of opening, viewing and closing tasks, deciding on a card, and running the queue, and they stay fixed for two reasons:

- **Code reads their states by name.** The drain's stage is written from `queue_drain`'s states and every one of them rests; the queue opens its own machines directly; `assistantOwesTheStep` applies the platform rule at every state of a queue machine (`backend/lambda/src/lib/task-state-machines.ts:631`); `approval`'s and `acknowledgement`'s choices are what the card offers and what `task:state` enumerates on a step's edges (`backend/lambda/src/lib/task-step.ts:95`); the router opens `action_item` and `place_item` with the plan's TTL and, for an action item, the requester as holder (`backend/lambda/src/router-agent-handler.ts:9695`). A changed state name breaks the code, not the team's behavior.
- **Consistency across assistants.** A person meets the same queue, the same to-do and the same approval card whichever assistant asked, which is what makes "waiting on you" one concept (ADR-024; decision 10).

The rule for what is platform, in the owner's words: "Anything that is common for managing queue, tasks, that are platform level and need consistency are platform." Everything else is the team's (decision 4).

**How a team's workflow uses them.** By reference, never by copy: a create-task step names `machine: approval` (a decision on a card), `machine: acknowledgement` (a confirmation), or a work item; the run waits on it like any task. A version that declares a machine under a platform key is refused by name, and the runtime resolves a platform key only from the platform set (ADR-066 decision 2, built: `versionMachineErrors`, `backend/lambda/src/lib/active-profile.ts:1046`; `machinesForVersion`). The queue's own five are never opened by a step (`machinesAStepMayOpen`, `backend/lambda/src/lib/task-step.ts:85`).

**What leaves the fixed set.** `incident_first_look` is today the one machine an `agent` step may open (`EVENT_TASK_MACHINES`, `backend/lambda/src/lib/event-workflow.ts:130`), and it is resolved from the platform's set only (`openEventTask` reads `DEFAULT_TASK_STATE_MACHINES`, `backend/lambda/src/lib/event-task.ts:43`). It becomes an editable machine of the version like any intent's, opened by the ops room's create-task step with `continue: opened` and `by: { assistantRole: 'ops' }`, its first step worked by an ordinary task turn and its run continued by the `entered` naming (decision 2). **NOT BUILT.**

**A naming to keep straight.** `SHIPPED_EVENT_WORKFLOWS` (`backend/lambda/src/lib/event-workflow.ts:397`: `welcome`, `ops-room`, `opening-and-subject`, `join-recap`, `incident-watch`, `chase-unredeemed`) are shipped starting points a version copies and edits, not platform workflows in this decision's sense. The console calls them **Shipped** (decision 4), and the constant carries the same name (OPEN 5).

### 4. Everything else is editable per version, in one Workflows list

**Editable, per version, through the draft:** the welcome and every event workflow (`eventWorkflows`, already editable on the builder), and every intent's workflow and its task's steps, shipped or custom:

| Workflow | Trigger | Where it ships from |
|---|---|---|
| `welcome` | `assistant-joined` | `SHIPPED_EVENT_WORKFLOWS` |
| `ops-room` and its `incident_first_look` task | `conversation-opened` (`ops`) | `SHIPPED_EVENT_WORKFLOWS`; `DEFAULT_TASK_STATE_MACHINES` (`backend/lambda/src/lib/task-state-machines.ts:918`) |
| `image_generation` | intent | `DEFAULT_TASK_STATE_MACHINES` (`:812`) |
| `guided_troubleshooting` | intent | `DEFAULT_TASK_STATE_MACHINES` (`:868`) |
| `data_extraction` | intent | `DEFAULT_TASK_STATE_MACHINES` (`:944`) |
| `report_generation` | intent | `DEFAULT_TASK_STATE_MACHINES` (`:1005`) |
| `code_delivery` | intent | `DEFAULT_TASK_STATE_MACHINES` (`:1112`) |
| `technical_design` | intent | `DEFAULT_TASK_STATE_MACHINES` (`:1137`) |
| `account_brief` (a custom one) | intent | the demo classification's pack (`ACCOUNT_BRIEF_INTENT`, `demo/stratum-company/intent-packs.ts:116`) |
| any workflow a team writes | an event or an intent its pack declares | the version itself |

**What the console shows.** One **Workflows** list on the assistant's page, grouped by trigger:

1. **Welcome**, first: the `assistant-joined` workflow per conversation type, with **Edit**. Edit offers three choices for how the welcome opens: **Template** (the opening's text and suggested prompts), **Prompt** (a model turn after the opening), or **Workflow**. Choosing Workflow swaps the template picker for the builder, which starts from a copy of a shipped workflow or from scratch.
2. **When something happens**: one group per event (Conversation opened, Person joined, Invitation sent, Invitation unredeemed, Alarm state changed), each workflow with the rooms it runs in and its steps, and Edit.
3. **When someone asks**: one entry per intent that has a workflow, named by the intent's summary, showing its steps with each create-task step opening to its task's steps, and Edit. An intent answered in one turn is listed under Scope and models only.
4. **Platform**, a separate section, read-only, never copyable over its key, with the owner's explanation as its note: these are used for managing task opening, viewing, closing and managing queues, and every assistant uses them the same way. Each lists its steps and where a team's workflow may use it (`approval` and `acknowledgement` by a create-task or Wait step).

Each entry reads as the platform runs it, from the same definitions the runtime reads (SPEC-ADMIN-CONSOLE FR60): a version that declares nothing on an intent shows the canonical workflow (decision 1), marked as running by default, and a shipped workflow not copied shows that it runs only once copied, where that is the runtime's rule, as the Workflows section does today. Every label and note named here ("Shipped", "Runs by default", the Platform note, each stage 1 reason below) comes from the console's existing string source under the admin locale, as the current Workflows section's "Runs only once copied" does, never as fixed English in a component (tenets P5, D11). Stage 1 (build order) fixes how each edge case is drawn.

**This supersedes the console plan of separate sections.** The Workflows section and the creation wizard's Workflows step list "Welcome, Event workflows, Task workflows, Message templates" as separate headings (SPEC-ADMIN-CONSOLE, the wizard and the Workflows section); under this record they become the one list above and the Platform section, with Message templates and onboarding where they are. ADR-066 decisions 3 and 4 (the intent's card opens its workflow in the builder's intent mode) hold, with the card linking to the intent's entry in the list rather than being a second place to edit it. On acceptance, SPEC-ADMIN-CONSOLE is amended at FR56 (the Workflows section's and the wizard's headings), FR59 (the builder edits an intent's workflow and a task's steps, not only event workflows) and FR60 (an intent card links to its entry rather than opening a second editor), and gains a new FR, "one Workflows list grouped by trigger, with a read-only Platform section", Priority `Table stakes`, status **NOT BUILT**.

### 5. Migration, and what it costs

This is a runtime change across the router, the processor, the task service and the console, not a relabeling. The build order (below) keeps each stage's runtime behavior identical for a version that changes nothing.

- **Existing versions are read, never rewritten.** `eventWorkflows` keeps its shape; an event workflow is a workflow whose trigger is an event. `intentPack.machines` keeps its shape; a machine is the task's steps that a create-task step names. A version is immutable by its `configId` (`backend/lambda/src/lib/version-machines.ts`, header), so no stored version is migrated in place: the validator and the runner keep accepting `agent.workflow` on stored versions and imports, read as a create-task step with `continue: opened`, and a new draft is written in the create-task form, the `withStartingMachines` pattern (`backend/lambda/src/lib/profile-lifecycle.ts:1163`). `agent.workflow` is refused for new drafts only, from stage 2; a stored version and an import keep it until stage 4's shared validator retires it with an import rewrite into the new draft.
- **The workflow selection.** Today `workflows` (ADR-047) narrows which machines may open (`mayOpen`, `backend/lambda/src/router-agent-handler.ts:6686`). With intent workflows declared, an intent opens work exactly when its workflow is declared, and the selection becomes derived from the declarations; a version's selection is carried into its first draft after stage 3 by declaring the canonical workflow only for the intents it selects. The selection field's name also collides with "Workflows" in the console: the stored key stays `workflows` until stage 4 retires it.
- **The shipped machines.** `DEFAULT_TASK_STATE_MACHINES` minus `PLATFORM_MACHINE_KEYS` stay the starting points a draft copies (ADR-066 decision 1); `incident_first_look` joins them (decision 3).
- **Running tasks and runs.** A task keeps the machine it started on (`originConfigId`, ADR-066 decision 5). A run is not pinned today: a continuation reads the version served now (`servedWelcomeVersion` in `handleEventContinuation`, `backend/lambda/src/router-agent-handler.ts:3423`), so an activation that removes the step a run waits at strands it (`'no such agent or task step'`, `:3426`). Stage 2 records the run's origin version on the run record and continues it there, the run-level equivalent of ADR-066 decision 5. A run started on an experiment arm records the arm's `configId` as its origin, as a task does (`originTaskFields` takes the arm's version where the turn is on one, `backend/lambda/src/router-agent-handler.ts:9735` to `:9737`), and records the arm beside it (`experimentArm`, `:9731`), so its later turns are served and counted as the task's are (decision 6). A task a workflow step opens records no origin version today (ADR-066 "OPEN"); stage 2 records it. **NOT BUILT.**
- **A duel side runs no intent workflow.** There are two task-opening doors, the ordinary intent path and the duel side (`backend/lambda/src/router-agent-handler.ts:9607` to `:9660`, the side's task opened with `createTask` at `:9629`). A duel side opens its task through the duel door and runs no run-level steps: a battle compares the answer both sides give, and an approval or a room send per side would ask people twice and measure the steps rather than the assistants. This keeps SPEC-BATTLE's rule that a battle turn opens a task only when it would have anyway, applied to the task alone. It holds today, where no intent workflow runs (decided 2026-11-05, OPEN 11).
- **The demo.** The demo's packs (`demo/stratum-company/intent-packs.ts`) and the `ops-premium` role keep working unchanged through stages 1 and 2, because they ride the classification's pack as starting points; the demo's assistants show `account_brief` under "When someone asks" from stage 1.
- **The cost, stated.** Stage 1 touches the console only. Stage 2 changes how the router and the task service resolve a workflow-opened task's machine and a run's version, with no IAM change. Stage 3 moves the router's task-opening door behind the run engine on the hottest path a person has, the turn that opens their work, so it carries the latency check that the first step is worked in the same turn. Stage 4 merges two validators and retires two fields, with export and import compatibility. Each stage ships with its own e2e on dev before the next starts.

### 6. Analytics and version tracking

**What is built.** Every archived message record carries `profile_config_id` (the version that served it), `intent`, `delivery_option`, `task_id`, `task_type`, `task_state`, `task_transition`, `task_step` (the step the turn started in), `turn_kind`, `experiment_id` and `variant_id` (`transformToMessageRecord`, `backend/lambda/src/analytics-aurora/kinesis-archival.ts:1078`, `:1139` to `:1150`, `:1170` to `:1171`). A turn bound to a task carries `task_origin_config_id` and `task_origin_machine_hash` (`:1153` to `:1154`), projected by migration 097 with an index on `(task_type, task_origin_machine_hash)` (ADR-066 decision 8). A task opened under an experiment arm records it (`experimentArm`, `backend/lambda/src/router-agent-handler.ts:9731`) and a pickup turn is served and counted by it (`pickupArmFields`, `:3297`). An event step's turn records `turnKind: 'event_step'` and carries `eventStep` (workflow, step, event, outcome) and `eventRun` (run key and its transitions) on its message metadata (`backend/lambda/src/assistant-async-processor.ts:1697` to `:1705`, ADR-061 rule 11), which the archive keeps as the record's `metadata` with no projection column. Effectiveness L1 reads an intent's turns per task step and per model (`getIntentSteps`, `backend/lambda/src/analytics-aurora/analytics-query.ts:7485`; SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR39 to FR41). No Effectiveness query reads `task_origin_machine_hash` yet, and none reads a workflow or a run.

**How each unit is attributed, under this record.**

| Unit | Attributed by | Where it is recorded |
|---|---|---|
| A turn | `profile_config_id`, `intent`, `turn_kind`, `experiment_id`, `variant_id`; a task turn adds `task_type`, `task_step`, `task_origin_config_id`, `task_origin_machine_hash` | the archive record (system of record) and the `messages` projection, as today |
| A run | its workflow's name, its trigger (event or intent), its origin `configId`, its workflow edition hash, its arm | the run record (where a run stopped, ADR-061 decision 5) and, on every turn and task it dispatches, `workflow_name`, `workflow_step`, `workflow_run_key`, `workflow_origin_config_id`, `workflow_origin_hash` on `transformToMessageRecord` and the projection, by a migration in stage 3. **NOT BUILT** |
| A run-level step | the run's fields plus `workflow_step` | the archive record of the turn the step posted; a step that posts nothing (a gated step, a silent end) reaches the archive only through the next posted step's `eventRun.transitions` |
| A task | its opening intent (`openingIntent`, ADR-064 decision B), its origin version and machine hash, its arm, and, when a run opened it, the run's fields | the task row; every turn bound to it carries them, as today |
| A task step | `task_step` on each turn | as today |

**A workflow edit is its own edition.** The run records `originWorkflowHash` over the one workflow it runs, the canonical hash `machineHashOf` takes over one machine (`backend/lambda/src/lib/version-machines.ts:157`), so a version edit that changes the welcome's sends changes the welcome's edition and no intent's, and a persona edit changes no workflow's edition. A run's edition is its workflow hash, and each task's edition is its own machine hash (`task_origin_machine_hash`), so a run that opens several tasks over several machines is measured per level, never as one pair (G13). **NOT BUILT.**

**Which store answers which question (tenet D7).** The archive is the system of record for every turn, transition and edition; the Aurora projection answers the analytics query; the run record answers only where a run stopped, and is never read for analytics (it expires a week after it is written today, `EVENT_RUN_TTL_SECONDS`, `backend/lambda/src/lib/event-run-store.ts:19`, and lives for the sum of its remaining waits, at most 45 days, holding references only, from stage 3). No new counter: a per-step or per-workflow figure is a query over the projected turns.

**What Effectiveness reads, per step and per workflow.** Per task step, the existing L1 rows (`getIntentSteps`), narrowed by `task_origin_machine_hash` so one edition of a machine is compared with another. Per workflow, a new grouping over `workflow_name` and `workflow_origin_hash`: runs started (distinct `workflow_run_key`), each run-level step's turns and latency, and the share of runs whose created tasks reached a success terminal (`task_terminal`). Every run writes a run-end archive record (decided 2026-11-05, OPEN 7), and rework is a view over the reopen transitions the archive holds. **NOT BUILT.**

**The golden set.** A golden entry of a multi-step intent walks the intent workflow's first create-task step's machine, as `walkTask` does today (`backend/lambda/src/lib/golden-walk.ts:219`), whose outcomes already include `not-exercised` with the step named (`:138`). Run-level steps after the task settles (an approval by another person, a send) are reported **not exercised**, with the step named, until the walk simulates them; event workflows are covered by Preview run (SPEC-ADMIN-CONSOLE FR59), not by the golden set. **NOT BUILT.**

**Options.** (a) Run attribution on the archive record's metadata only, as event steps do today: no migration, but every Effectiveness figure parses JSON and no index serves it. (b) Projected columns on the existing records, as ADR-066 decision 8 did for the machine (recommended). (c) A separate runs table written by the router: a second writer of analytics facts beside the archive, which tenet D7 refuses.

**Recommendation and cost.** Option (b) in stage 3: five archive fields, one migration, one Effectiveness grouping, and the per-edition filter on the existing step rows. Cost: one migration that auto-applies at cold start (idempotent, `ADD COLUMN IF NOT EXISTS`), the fields threaded through the processor's analytics metadata as `taskOriginMachineHash` is (`backend/lambda/src/lib/async-processor-core.ts:5233`), and one console grouping. Decided 2026-11-05 (OPEN 7): every run writes a run-end archive record.

### 7. Step requirements to move forward

**What is built, and who checks each requirement.**

| Requirement | What it says | Checked by | Decided by |
|---|---|---|---|
| `transitions`, `edgeWhen`, a state's `when` | which moves exist and the conditions on them | `authorizeTransition` (`backend/lambda/src/lib/task-state-machines.ts:2123`), called by the tool handler first (`backend/lambda/src/lib/task-tools.ts:891`) and again by the store, which is the authority (`advanceTaskStateTo`, `backend/lambda/src/lib/task-tracking.ts:2944`, reached through the task service's `advanceTask`, `backend/lambda/src/task-service.ts:544`) | code, on recorded values |
| `requires` | what the step needs from the person before it moves | the processor's tool handler (`handleAdvanceTaskStateTool`, `backend/lambda/src/lib/task-tools.ts:777`), which refuses `requirement_unsourced` (`:949`) until each need is recorded with its source and evidence (`collectedRequirements`) | the model judges from the person's words and records the evidence; code compares names |
| `requiresTool` (ADR-064 decision 3) | a named tool returned success since the step was entered | the tool handler, `required_tool_not_run` (`backend/lambda/src/lib/task-tools.ts:926` to `:930`), over the run recorded once per entry (`recordToolRun`, `backend/lambda/src/lib/task-store.ts:292`) | code |
| `presented` | the step is put to the person before it is left | the tool handler, `opening_step_must_be_presented` (`backend/lambda/src/lib/task-tools.ts:897`) | code, on "entered this turn" |
| `produces: document` (what `delivers` used to say, retired, `backend/lambda/src/lib/task-state-machines.ts:210` to `:213`) | the move carries the document (FR27) | the tool handler | code |
| `awaits` | whose turn the step is | the store hands the task over (`setTaskAssignee`); pickup holds a task that awaits another (`backend/lambda/src/lib/workflow-task.ts:115`) | code |
| `choices` on a card | the moves the awaited person may press | the task service (`assigneeAdvanceRefusal`, `backend/lambda/src/lib/workflow-task.ts:70` to `:83`), then the store's `authorizeTransition` with no values held, so a conditioned choice is refused rather than guessed | the person presses; code checks |
| a run step's `when`, run edges | whether a run step runs, and where the run goes on each outcome | the router's runner (`gateHolds`, `backend/lambda/src/lib/event-workflow.ts:1408`) | code |

**One checker per requirement, under the unified model.** Each requirement keeps the one checker it has: the graph and its conditions in the store, the model-judged needs and the turn-scoped rules (`requires`, `requiresTool`, `presented`, the brief) in the tool handler, a party's choice in the task service, and a run step's gate in the router's runner. The builder shows each as a property of its step, at its level, and a run-level step never checks a task-level requirement: a run step that needs "the report is approved" reads the approval task's terminal state on its own edge (`task:state`), never the report task's `requires`. A card press does not satisfy `requires`, because a choice state names the moves a person may make, not the facts the model records; a machine that needs both declares them on two steps.

**What the model decides, and what code decides (tenet D11).** The model decides whether the person's words satisfy a need, records what it judged with its evidence, and names which declared move to ask for. Code decides whether the move exists, whether its conditions hold on recorded values, whether the required tools ran, whether the step was presented, whether a pressed choice is the awaited person's and the state's own, and where a run goes on an outcome. No requirement is decided by recognizing a phrase.

**Options.** (a) Keep each check where it is (recommended). (b) Move every check into the store: the store would need the turn's context (what was entered this turn, the turn's collected values, the tool runs in flight), which widens the task service's payload and its trust surface for no rule the store does not already enforce on the graph. (c) Give `requires` a code-checkable form, a typed field the awaited person fills on a card, so a need can be met without a model's judgment: this is the written-answer platform machine of decision 2, **NOT BUILT**.

**Recommendation and cost.** Option (a): no runtime change; the builder's step inspector shows each requirement with who checks it. Cost: stage 1 console work only. Decided 2026-11-05 (OPEN 12): typed recorded values with a small set of comparisons, plus a count of entries into a state.

### 8. Ownership of workflows and tasks

**A workflow's owner is the assistant's owning team, through the version.** A workflow is data on a version; a version belongs to one assistant; an assistant is owned by the team named in the `owner-team` tag on its `AppInstanceBot`, read live (`OWNER_TEAM_TAG`, `backend/lambda/src/lib/assistant-ownership.ts:4`, `:20`; ADR-048), and a team member's console edits and activates only the assistants their teams own (`requireOwnedAssistant`, `backend/lambda/src/lib/assistant-scope.ts:38`; SPEC-ADMIN-CONSOLE FR58). Who may change a workflow is who may edit a draft (`edit-profiles`), and who makes it live is who may activate (`activate-profiles`). A shipped workflow or machine is the platform's until copied, then the version's; a platform machine (decision 3) is the platform's always. Which version a run uses is its origin version (decision 5).

**A task's people, as built.**

- **Requester**: the person whose message opened it, fixed for the task's life (`userArn`; `ownerPersonId`, `backend/lambda/src/lib/task-tracking.ts:843`, `:875`).
- **Assignee**: who holds it now, the one field `setTaskAssignee` writes (`backend/lambda/src/lib/task-tracking.ts:251`), handed on at `awaits` boundaries (ADR-024 D8). At creation it is the worker where the first step awaits the worker, the requester where the first step awaits a person, else the caller's owner or the requester (`backend/lambda/src/lib/task-tracking.ts:849` to `:854`). The open-work mirror is keyed by it (`putMirrorRow`, `:932` to `:938`).
- **Assistant**: whose work it is (`assistantId`), which answers a message about it (ADR-030) and runs its turns.
- **Worker** (a step-opened task): who does the work, a person, a participant role's one holder (`oneHolder`, `backend/lambda/src/lib/task-step.ts:147`, `:155`; ADR-063) or an assistant by role.

**Who may advance a task.** The task's assistant, through `advance_task_state` on its own turn; the assignee person, by a card choice, any other caller refused `NOT_ASSIGNEE` (`backend/lambda/src/lib/workflow-task.ts:79`; answered 403, `backend/lambda/src/user-tasks-api.ts:535`, which the chat shows in the person's language from `frontend/packages/shared/src/locales/en.json` `NOT_ASSIGNEE`, `frontend/packages/chat/src/components/TaskCard.tsx:25`); the deadline; and an operator's cancel or reassign (`backend/lambda/src/admin-tasks.ts`). A run step never does (decision 2).

**How a workflow-created task's people are set.** Through `openWorkflowTask` (`backend/lambda/src/task-service.ts:606`): the requester from the step's `for` (a person only), the worker from `by`, else the run's assistant; a task for nobody is held by its worker (`:649`); and the task service refuses, before any write, an assistant that is not its own classification's (`isOwnAssistant`, `:594` to `:598`, `:629` to `:635`). An intent trigger's canonical step sets them as the router does today (decision 1). The `requester` reference (`for: requester`, the person whose message triggered an intent run) is not a `TaskPerson` today (`backend/lambda/src/lib/task-step.ts:30`) and is built in stage 3, which first needs it. **NOT BUILT.**

**The audience of a run's steps follows the message that triggered it.** A task is private unless declared otherwise (`backend/lambda/src/lib/task-step.ts:45`; ADR-033: its existence is visible, its details are not, `backend/lambda/src/lib/task-visibility.ts:1` to `:7`), and an intent may be triggered by a targeted message (ADR-036: every reply part takes its placeholder's audience). The rule, at both layers:

- **The rule.** A run an intent triggers takes the audience of the message that triggered it. The first task's visibility is decided when the request arrives (`inboundTaskFields`, from the message's targeting; absent reads as private), not by the workflow, so the rule is applied when the run reaches each step. A run another trigger starts takes a visibility too: a run started by an event about a task (`task-reopened`, an inbound fact naming it) takes that task's visibility; a command takes the visibility of the surface it came from, private by default; an event about a conversation (an assistant joins, a conversation opens) runs in the room, as today.
- **The first layer, the runner.** A private run reaches no one but its requester (decided 2026-11-05, OPEN 9): a send to the room or to another person, a create-task step whose `for` or `by` names another person, and an outbound event to an outside tool record `withheld`, post nothing, take their failure edge and are logged by step, never by content, and the requester is told by a targeted notice from a message template that a step was withheld. A task a private run opens is private whatever its step declares, its existence room-visible as ADR-033 allows. The platform exits (`/stop` and "get me a person") are not run steps and are never withheld; the handoff carries a reference only, and the person who picks it up signs in to read it. A privately reported outage is therefore not paged. **NOT BUILT.**
- **The second layer, at each door.** The run's send path, its create-task door and its connector-action path each refuse a run marked private, whatever the runner decided, so a later caller cannot inherit the open default. **NOT BUILT.**
- **The console.** On an intent trigger, a step that reaches the room or another person is marked as running only when the request is shared, from the console's string source, so a team sees the rule before it activates.

**Who does the work is decided in the deployment's own tools, not here.** The platform does not assign work across a pool of people, route a request between teams or keep a team's queue; a dispatch system, a field-service tool, a ticketing system or an on-call pager does, and the platform integrates with it rather than replacing it (tenet P5; SPEC-CONVERSATION-TYPES, Non-Goals: "Reimplementing a vendor's routing or assignment"). A workflow reaches such a tool through its connector (SPEC-CONNECTORS) in two directions: an outbound event (a connector action that creates the job, the ticket or the page) and an inbound event (the tool's own "accepted by", "delivered" or "acknowledged", naming the task it concerns and taking a transition the task's machine declares). When the tool names the person who will do the work, that person signs in through the deployment's identity provider like every other user (SPEC-CONNECTORS K1) and is added to the conversation as the holder of the participant role the step names, so one holder per role (ADR-063 B1) holds because the tool chose them.

What exists and what does not. Built: the inbound half up to a fact. A vendor's events arrive on its Amazon EventBridge partner event bus, the receiver checks the source, claims a replay record, resolves the people the event names through `Identities` only, admits them at the connector's classification (which must be the conversation's own before a person is added or moves anything), and publishes an `ae.connector` fact naming the admitted people (`backend/lambda/src/connector-ingest.ts`, `backend/lambda/src/lib/connector-participants.ts`), with PagerDuty and Salesforce adapters (`backend/lambda/src/lib/connectors/vendors.ts`). **NOT BUILT:** a consumer of `ae.connector` (so no fact starts or moves a workflow), outbound connector actions, the ServiceNow, Jira Service Management and ServiceTitan adapters, and a step that adds an admitted person to a conversation. A.6 to A.8 show where each is needed.

**Two ways to take part in a workflow.** Every actor is identified the same way, and they differ only in where they act.

| | Direct | Indirect |
|---|---|---|
| Who | A person (an `AppInstanceUser`) or an assistant (an `AppInstanceBot`) who is a member of the conversation | A service, or a person working in another tool (a field-service app, a ticketing system, an internal review app), who never joins the conversation |
| How they act | A message, a card choice, or a reply over the transport they joined by: chat, or a text or call through the deployment's number (SPEC-TELEPHONY), resolved once by the model as data where no card exists (tenet D11); each text they receive is a message template that may carry the full text or a reference link | An event to the platform (an `ae.connector` fact) that names the run or task by its external reference and takes a declared transition; and an event from the platform (a connector action) that hands them the work |
| How they are identified | Their bearer-pinned credential (tenet D1) | The person the event names, resolved through `Identities` only and admitted at the conversation's classification (SPEC-CONNECTORS K1, K4); a service is the connector itself |
| What they see | The conversation, the card, their open work; a member by phone receives texts, the one named exception to "only a reference leaves" (owner, 2026-11-05: "Template that can take the full text or reference link as a variable"), because the phone is that member's transport | What the outbound event carries: a reference, never a copy. A person who opens it signs in through the deployment's identity provider and reads as themselves, so the classification boundary applies to them as to any member |
| What the record names | The member who moved it | The person the event named, or the connector when it names nobody |

A person may be direct in one workflow and indirect in the next, and a workflow may move between the two: a technician added to the conversation by phone is direct, and the same technician closing the work order in the field-service app is indirect. Indirect participation is **NOT BUILT** past the receiver; A.10 and A.11 show it end to end.

So an approval asked of another person exists only about a task the room may already see, and the approver's card shows the approval task's own label and the shared task's reference, which they can open as a member. A private request's deliverable is never shared with another person (OPEN 9).

**Options.** (a) Ownership as above, with the audience rule (recommended). (b) A workflow-level owner separate from the assistant's team: a second ownership record beside the tag, which ADR-048 settled against. (c) No audience rule, relying on the step author: discloses a private request's existence and outcome to the room, which ADR-033 refuses.

**Recommendation and cost.** Option (a). Cost: the runner's `withheld` outcome, the send path's refusal and the console mark in stage 3, each with a unit test, and the deny-style test that a private trigger's room send posts nothing. Decided 2026-11-05 (OPEN 9): a private run reaches no one but its requester, outside tools included; the requester is told when a step is withheld.

### 9. Parallel steps

**What is built: a run is strictly sequential.** `runEventWorkflow` walks one cursor, one step per iteration, bounded by `MAX_EVENT_RUN_STEPS` (`backend/lambda/src/lib/event-workflow.ts:1396` to `:1399`, `:356`); a create-task step opens one task, keyed by the run and the step (`eventTaskId`, `backend/lambda/src/lib/event-task.ts:27` to `:29`), and the run stops there; its continuation is claimed once per step (`continuationClaim`, `backend/lambda/src/lib/event-workflow.ts:1348`). Tasks of different runs may be live at once in a conversation, and an assistant takes its ready ones one at a time, by priority then age (`orderForPickup`, `backend/lambda/src/lib/workflow-task.ts:138`), under the conversation's one turn lock (ADR-033).

**Options.**

- (a) **Sequential within a run** (recommended). A run that needs several tasks opens them one after another; independent work that should proceed together is two workflows, or two tasks opened by successive steps with `continue: opened` on the first.
- (b) **A fan-out step**: one step opens N tasks (for example, ask each holder of a role) and a join continues the run on `all`, `any` or `first`. What it costs: a claim and a task id per branch (`after#<step>#<branch>`), a join record on the run with a conditional count, a deadline per branch and a rule for a branch that times out under `all`, edges that read N terminal states, a golden walk that reports each branch, and analytics per branch. Branches worked by assistants in one conversation gain nothing, because the turn lock serializes their turns and idle pickup orders them; only branches held by different people actually run at once.
- (c) **Parallel model turns inside one task**: refused, because a task's state has one writer and one current step (decision 2).

**Recommendation and cost.** Option (a) for stages 1 to 4, at no cost. Option (b), if wanted, only as "several tasks opened by one step, each tracked", with join `all` first, after stage 3; **NOT BUILT**. Decided 2026-11-05 (OPEN 8): sequential for stages 1 to 4, a fan-out step planned for a later stage.

### 10. Open tasks for people, and the task list

**What is built.**

- **Waiting on you.** `GET /tasks/mine` lists the live tasks (status pending or in progress, `backend/lambda/src/lib/task-tracking.ts:1923`) the caller holds, from the mirror keyed by the assignee (`backend/lambda/src/user-tasks-api.ts:650` to `:653`), only from conversations the caller is still a member of and cleared for (`admit`, `:641`). Each row carries its state, title, due time, assistant, visibility, and, where its state awaits a party, what it needs (`needsOf`, `:231`), read against the machines of the assistant's classification pack (`machinesByAssistant`, `:79`), not the task's origin version. The chat shows them as "waiting on you" (`OpenWorkItems.tsx`, `workItems.headlineOne` and `workItems.headlineMany`).
- **Cards.** A state that awaits a person and declares `choices` is answered on its card (`POST /tasks/advance`, `backend/lambda/src/user-tasks-api.ts:615`, to `advanceAsAssignee`).
- **The progress line.** The turn queue's notice moves through its stages on the message a person already watches (`advanceQueueNotice`, `backend/lambda/src/lib/turn-queue-notice.ts:335`); it describes queued turns, not tasks.
- **Private tasks.** A private task's existence and assistant are visible to the room through its reference; only its requester, its holder and its assistant read what it is (`backend/lambda/src/lib/task-visibility.ts:1` to `:7`).
- **What never appears.** A run record is a task record marked `event_run`, which no open-work read selects (`backend/lambda/src/lib/event-run-store.ts:8` to `:9`). An assistant-held task sits in the assistant's partition, never a person's list.

**What a run creates, and where it shows.**

| Created by a run | Appears in "waiting on you" | Visible in the conversation |
|---|---|---|
| An intent's task (the canonical step) | the requester's, while the step awaits them, as today | per its visibility, as today |
| A Wait step (`approval`, `acknowledgement`) for a person or a role holder | that person's, with its choices on the card and its deadline | per its visibility; the audience rule (decision 8) |
| A task with `by: { assistantRole }` (the first look) | nobody's | as a conversation task, its existence and state |
| A send, a model turn, an intake | never: they are not tasks | as the message they post |
| The queue's machines | never: the queue opens them for assistants | the progress line only |
| The run record | never | never |

A wait on a person is a task, so it appears exactly as a task does; a run-level `wait` for a time or an inbound fact waits on nobody and is in nobody's list. A run waiting on an assistant-held task shows nothing in a person's list, which is correct: nothing waits on a person.

**Closing and canceling.** A person closes their task through its own steps or a card; `/stop` cancels the turn's held work; an operator cancels or reassigns (`backend/lambda/src/admin-tasks.ts`); the deadline cancels a step-opened task. A canceled task settles as `task:failure:<state>` (or `task:deadline`), and the run continues on that edge (decision 2). Canceling a run itself, with its open tasks, is **NOT BUILT** (OPEN 13).

**What stage 2 must change.** `/tasks/mine` reads `needs` from the classification pack (`machinesByAssistant`), so a state that exists only on a version shows no needs, and a card for it is refused by the task service, which reads only `packTaskStateMachines()` (`advanceAsAssignee`, `backend/lambda/src/task-service.ts:678`). Both read the task's origin version in stage 2 (build order).

**Options.** (a) The table above, with no new list (recommended). (b) A separate "runs" view per person: a run is the assistant's process, not a person's work, and a second list would split "waiting on you" into two concepts, which ADR-024 made one.

**Recommendation and cost.** Option (a). Cost: the stage 2 origin reads on the two sites above; nothing new in the chat. Decided 2026-11-05 (OPEN 13): an operator cancel, each task settling on its own edge, that also undoes the run's outbound writes under the assistant's own session; the undo half belongs to the next record, "events in and out".

## Tenets that settle a question

| Tenet | The question it settles |
|---|---|
| **D11** No decision depends on recognizing a phrase | An intent trigger matches the classifier's recorded label by key; a wait completes on a card choice (data) or on a model turn that records what it judged; no trigger or edge reads a person's words (decision 7) |
| **D9** Consistent designs for similar functionality | Two engines for one pattern become one model, one builder and one validator; where the levels genuinely differ (the run's outcome edges against the task's model-chosen moves), decision 2 records why, rather than forking quietly |
| **D6** Event-driven, not polling | A wait continues on the task service's naming, a card press or a person's message; a time waited for is a one-shot schedule. A lost settlement naming leaves the run stopped (ADR-063 decision 6), which under this record includes the steps after a person's request; the low-frequency reconciliation sweep D6 calls correct design behind an event path is **NOT BUILT**, tracked, and a stage 3 prerequisite (OPEN 10) |
| **D5** Degrade, never block a reply | A run claim or run-record write that fails on an intent trigger opens the task as today and answers the person; run-level steps are skipped and logged (stage 3) |
| **D7** One store per question | The task row answers a task's state; the run record answers where a run stopped; the archive is the system of record for every transition and edition; the Aurora projection answers the analytics query; no metric counts what the ledger counts (decision 6) |
| **P5** The builder decides | Every workflow but the platform's is the team's, edited per version, including the incident first look and the welcome's mode; the console's words come from its string source |
| **D8** Reuse before building | A wait on a person is a create-task step over a platform machine, not a new primitive, and a run-level `wait` for a time reuses the one-shot scheduler; an intent trigger reuses the run engine and the existing task door |
| **D1, P4, D3** Acting as itself; IAM is the enforcement; two layers | No IAM effect in stage 1; stage 3 reads `intentWorkflows` under the grant the router already uses to read the version it serves. Stage 2 makes no IAM change: a task carries the machine it started on (`Task.originMachine`), so a card press and a deadline settle on it with no read of any version. No step runs a turn as another assistant (WT118): a request to a role reads only that assistant's advertisement, and the router starts the role assistant's own run of the intent on its served version, so the asking run never reads the owner's definition; the processor reads steps only from its own version, and the task service's `isOwnAssistant` is the second layer for `by: { assistantRole }` |

## Security posture

- **The classification boundary does not move.** A workflow, its triggers and its tasks are data on a version, and a version acts in one classification (ADR-042). A create-task step's `by: { assistantRole }` resolves only among the room's live assistants of the conversation's own classification (ADR-063, "Who may assign work to whom"), and the task service refuses, before any write, an assistant that is not its own classification's (`isOwnAssistant` in `openWorkflowTask`, `backend/lambda/src/task-service.ts:594` to `:598`, `:629` to `:635`). An intent trigger fires only on a turn that classification's router classified.
- **Who may see what.** Every run takes a visibility from its trigger (decision 8), and a private run reaches no one but its requester, outside tools included, enforced by the runner and again at the send path, the create-task door and the connector-action path. Deny-style unit tests prove a private trigger's room send posts nothing, its outbound event is never sent, and a task it opens for another person is refused at the door.
- **People other tools name.** A person a vendor event names is resolved through `Identities` only and admitted at the connector's classification, and is added to a conversation or moves its task only where that is the conversation's classification, with a deny test owed (`an-event-person-of-another-classification-is-not-added`). The deployment's own app reaches the platform over its own EventBridge bus, whose resource policy admits `PutEvents` only from the app's named principal, with a synth deny test owed.
- **What leaves the platform.** An outbound event carries a reference, never a copy; the one exception is a text to a member who joined by phone, a message template that may carry the full text. A run record holds references only, at most 45 days; archive facts carry the AppInstanceUser id and references only and follow the archive's erasure path.
- **Continuations are verified from the record, never from the hand-back.** An intent run's continuation recomputes its key from the task row (its correlation id and assistant) and reads the requester from the task's `userArn` (stage 3), as an event run's does from the event's own fields (`backend/lambda/src/router-agent-handler.ts:3434` to `:3437`).
- **The platform workflows cannot be shadowed.** Unchanged from ADR-066 decision 2: refusal by name at draft, validate, activate and import, and resolution from the platform set only at runtime.
- **No new writer.** A run step never writes a task's state or assignee (decision 2). The first look's system advance becomes a declared automatic move on an edge validation requires the state to declare (decision 2), taken through the task service like every other move.
- **No stage widens a grant.** Stage 2's task service reads the machine a task started on from the task's own row, so it reads no assistant's version; a body-store read scoped to the classification could not be written, because body keys name the assistant and not the classification.
- **Who may change it** is who may edit a draft (`edit-profiles`) on an assistant the caller's team owns, and who makes it live is who may activate (`activate-profiles`) (decision 8).

## Options considered

| Option | Why not |
|---|---|
| Keep two models and present them side by side (event workflows, task workflows) | The owner's direction; a team cannot see that a welcome and a report are the same kind of thing, and a step that hands work over has to be explained twice |
| Flatten tasks into the run (rule B) | Loses the bounded acyclic run and the one writer of task state; the largest rewrite for no capability rule A does not give |
| Run steps that set a task's state (rule C) | A second writer of state, which FR2 and ADR-024 refuse |
| Every turn is a workflow run, single turns as one-step workflows | A run record and a hop per turn, measured nothing new; a single turn already has its record (tenet D7) |
| A run-level wait on a person beside tasks | A wait on a person needs open work, a deadline and a card, which a task already is (tenet D8); a wait for a time or an inbound fact is a run-level `wait` step, because nobody's open work holds it |
| Make the platform machines editable with a warning | Code reads their states by name; an edit breaks the queue or the card for that assistant only, and a person meets a different approval per assistant |
| Store intent workflows in `eventWorkflows` | Its names refuse underscores (`/^[a-z0-9][a-z0-9-]{0,62}$/`, `backend/lambda/src/lib/event-workflow.ts:358`), it holds at most 8 workflows in 32,000 characters (`MAX_VERSION_EVENT_WORKFLOWS`, `MAX_VERSION_EVENT_WORKFLOWS_BYTES`, `:1582`, `:1584`), which the shipped event workflows and six intents already exceed, and its `on` must be an event (`:833`) |
| Key an intent run on the inbound message id | The id comes from a best-effort text match that returns `''` on failure (decision 1) |
| Keep the processor's undeclared system advance for a team-edited first look | It would take an edge the runtime chose rather than one the machine declares, which FR2 forbids; the move is declared as data instead (decision 2, G39) |
| Rewrite stored versions' `agent.workflow` with a migration script | A version is immutable by its `configId`; a rewrite changes its hash and its export (decision 5) |
| Do it in one stage | The opening turn of every multi-step request would change at once with the console, the validator and the task service; a regression would have no smaller stage to roll back to |

## Consequences

- A team edits one list of workflows, each starting from an event or a request, and sees where tracked work begins inside it.
- An intent's workflow can continue after its task: approve, notify, open more work, within the reopen rule (steps after a task that reopens run once) and the audience rule. Today's behavior is its canonical one-step case, reproduced exactly, deadline-free, work-item options and `general` fallback included.
- The incident first look becomes the team's to change; its first step is a task turn, which takes the turn lock (OPEN 2), and leaves through its declared automatic move, and the run continues on a new `entered` naming.
- The run gains an origin version, an arm and an edition hash, so a run survives an activation as a task already does, and a workflow edit is measured as its own edition.
- `EVENT_TASK_MACHINES` and `agent.workflow` retire into the create-task step for new drafts, stored versions read compatibly; the selection field retires into declared intent workflows.
- A duel side runs no intent workflow; a battle compares the task alone.

## Build order

Each stage lists what it builds, the prerequisites that gate it, its tests (named after the behavior) and its e2e on dev.

### Stage 1. One list, today's engines (console only, no runtime change)

**Status:** partly built, 2026-11-05: the grouped list, the welcome's form, the Platform section and "Shipped"; editing a task's steps in the builder and the stored kept welcome are not. Each part's status and proof is in SPEC-WORKFLOWS-AND-TASKS (WT53, WT97, WT98, WT112).

**Prerequisites:** none in the runtime. ADR-066 decisions 1 and 2 are built (machines on the version, platform keys refused). This stage is ADR-066 build step 3 (the builder's task-machine mode, which SPEC-ADMIN-CONSOLE FR60 records as **NOT BUILT** because `WorkflowBuilder` draws only an event workflow's graph) plus the grouped list. It can be accepted and built without deciding any OPEN item.

**What it builds:** the Workflows list grouped by trigger with Welcome first; the welcome's Edit with Template, Prompt and Workflow; intent entries drawn as the canonical workflow over the version's machines, the task's steps edited in the builder's machine mode and written to `intentPack.machines` through the draft patch; the read-only Platform section with the owner's note; every label from the admin string source.

**How each case is drawn:**

| Case | What the console shows |
|---|---|
| An intent's run level (the steps around its task) | read-only in stage 1, drawn as the canonical workflow; only the task's steps are editable, because the runtime cannot run steps around a task until stage 3 (FR60: the console shows only what the runtime runs) |
| `action_item` and `place_item` intents | listed under When someone asks, their task drawn read-only from Platform, with the reason that the work items are the platform's |
| `incident_first_look` | inside the `ops-room` entry under Conversation opened, its steps read-only with the reason that it runs the platform's steps until stage 2 |
| An intent deselected by the version's `workflows` selection | listed under When someone asks, marked not offered by this version, linking to the selection control that governs it |
| A `TASK_MULTI_STEP` intent with no machine | listed with the reason that it opens a general task, and an action that copies a starting machine into the draft where one exists (ADR-066 decision 1) |
| Switching the welcome from Workflow back to Template or Prompt | the workflow stays in the draft's `keptWelcomeWorkflow` field, outside `eventWorkflows`, until it is removed, so a toggle loses nothing and a kept welcome never runs (G40) |
| `join-recap`, which `withJoinRecap` adds to a version's `person-joined` workflow at runtime (`backend/lambda/src/lib/event-workflow.ts:1654`) | drawn as a read-only last step of each `person-joined` workflow, marked as added by the platform; never written to the draft |
| A deployment with no body store | an intent's task steps read-only, with the reason that the pack is kept inline and a copied machine does not fit (`startsWithMachines` requires `bodyBucket()`, `backend/lambda/src/lib/profile-lifecycle.ts:1150` to `:1155`); the list and the welcome's modes work as everywhere |

**Tests:** admin unit tests `a-workflows-list-groups-by-trigger` (grouping and order, Welcome first), `a-welcome-switches-mode-and-loses-nothing`, `an-intents-task-steps-write-the-pack` (through the draft patch), `the-platform-section-offers-no-edit-or-copy`, `an-intents-run-level-is-read-only-in-stage-1`, and one rendering test per row of the table above.

**E2e on dev:** edit an intent's task step in a draft, validate, activate, and a new request runs the edited step; the Platform section shows the queue's machines read-only; the welcome switched to Workflow runs the copied workflow.

### Stage 2. A workflow-opened task and a run on their origin

**Prerequisites:** met 2026-11-05 (OPEN 2 and OPEN 3 decided; stage 1 accepted).

**What it builds:**

- A task carries the version's own machine it opened on (`Task.originMachine`), and the task service moves it on that machine at `advanceAsAssignee`, `cancelForDeadline`, `nameWhatChanged` and `readyTasks` (`machinesOfTask`).
- The router's `openWorkflowTaskStep` passes the version's `machineDef` (`backend/lambda/src/router-agent-handler.ts:3139`, the call at `:3172` to `:3178`, which the service already accepts, `backend/lambda/src/task-service.ts:612`), with `originConfigId` and `originMachineHash` on the task; `handleEventContinuation` evaluates `task:state` against the task's origin machines rather than `taskStateMachines()` (`backend/lambda/src/router-agent-handler.ts:3463`).
- `/tasks/mine` reads a task's `needs` from its origin version where it has one (`machinesByAssistant`, `backend/lambda/src/user-tasks-api.ts:79`), within that route's own read grant.
- The run's origin version (and arm) on the run record, continued there.
- `incident_first_look` editable and opened by a create-task step with `continue: opened`; the processor's system advance replaced by the declared automatic move; the `entered` naming; failure outcomes that say why (G23).
- Read compatibility for `agent.workflow` on stored versions and imports, and the create-task form for new drafts (decision 5).

**Tests:** `a-step-opened-task-runs-its-versions-machine` (after a newer version declares another), `a-run-continues-on-its-origin-version` (after an activation that removes its step), `a-task-step-continues-when-its-task-opens` (`continue: opened` takes `onSuccess` once the task leaves its initial state, and not again when it returns), `a-declared-automatic-move-survives-a-team-edit` (a first step with two transitions, one declared `auto`; validation refuses an `auto` the state does not declare; the move is taken once per entry), `a-card-press-settles-on-the-tasks-version`, `a-stored-agent-workflow-still-runs`, and the synth deny test for the task service's body-store read.

**E2e on dev:** the ops room's first look runs from a version's edited `incident_first_look`; a run waiting on an approval finishes on its origin after the version is replaced; a card press on a version-only state settles.

### Stage 3. An intent triggers a workflow

**Prerequisites, one list (SPEC-WORKFLOWS-AND-TASKS repeats it):** stage 2 on dev; OPEN 1 (`intentWorkflows`, decided 2026-11-05); declared types on intent workflows (G20); the archive fact per settlement built (G14); the reconciliation sweep built (OPEN 10); the duel rule recorded in SPEC-BATTLE (OPEN 11).

**What it builds:**

- `on: { intent }` stored in `intentWorkflows` and validated (the first create-task step names the intent's machine; steps after a task that reopens run once) and run by the router's runner, with the audience rule at the runner and the send path (decision 8).
- The canonical workflow at runtime (no deadline, the work items' options, the `general` fallback) and materialized in new drafts.
- The task door reached through the create-task step on the triggering turn (`createTask` with `workflowRun` set, no ready naming), which works the first step; continue-before-trigger.
- The run keyed `intent#<correlationId>#<assistant>`; `WorkflowRunRef` gains the trigger's kind and intent beside its required `event` (`backend/lambda/src/lib/task-tracking.ts:533` to `:547`); the run record outlives the sum of its remaining waits, at most 45 days, as a step-opened task's row outlives its deadline by a day (`backend/lambda/src/task-service.ts:639`).
- An intent run's continuation recomputes its key from the task row and reads the requester from its `userArn`, never from the hand-back.
- Steps after the task settles; the `requester` reference; the visibility of every trigger and the withheld notice (decision 8); `task-reopened`; a new request mid-task opening its own task; the exits (`/stop` ends the person's own run, "get me a person" as a platform command); an operator's run cancel, its task half; the run-end record; the per-edition and rework views; the duel side runs no intent workflow; a run on an arm records the arm.
- Tenet D5: a run claim or record write that fails opens the task as today and answers the person; run-level steps are skipped and logged.
- The selection derived from declarations; the five workflow fields on the archive and the projection (decision 6) with their migration; the golden walk's not-exercised report for run-level steps.

**Tests:** `an-intent-starts-a-workflow`; `a-version-with-no-intent-workflow-behaves-as-today` (the existing task e2e suite unchanged); one test per canonical case: `an-intents-canonical-task-schedules-no-deadline`, `an-action-item-keeps-its-plan-ttl-and-holder`, `a-deselected-intent-still-opens-general`; `a-duel-side-runs-no-intent-workflow`; `steps-after-a-reopening-task-run-once`; `a-reopen-starts-its-own-run-once`; `a-private-run-sends-nothing-outside` (deny-style); `a-cancelled-run-settles-each-task-once`; `a-run-writes-one-run-end-record`; `a-stop-ends-the-persons-own-run`; `a-redelivered-message-starts-no-second-run`; `a-forged-hand-back-continues-nothing`; `a-private-requests-room-send-posts-nothing` (deny-style); `no-pickup-runs-the-first-step-twice`; `a-failed-run-write-still-answers`; `an-intent-workflows-second-task-opens-after-the-first-settles`; `the-workflow-hash-changes-with-the-workflow-not-the-persona`.

**E2e on dev:** a report request (on the shipped `report_generation`, in a conversation-visible request) delivers, then the run asks the room's lead to approve on the card, and the run's send posts. Latency: `ttff_ms` on the `exchanges` projection for task-opening turns (`delivery_option = 'TASK_MULTI_STEP'`, a task opened on the turn), compared with the baseline of the last recorded dev e2e run of the task suite before stage 3 deploys; the median may be no more than 100 ms above the baseline, and the result is recorded here with its date and query.

### Stage 4. One step schema

**Prerequisites:** stage 3 on dev.

**What it builds:** one validator over both levels' step fields (`eventWorkflowErrors` and `validateTaskStateMachine` sharing the field checks); the builder's two modes merged; the `workflows` selection key and `agent.workflow` retired, with export and import compatibility (an import carrying either is rewritten into the new draft's form); the constant's rename to `SHIPPED_EVENT_WORKFLOWS` (OPEN 5).

**Tests:** `the-shared-validator-refuses-each-malformed-field-once`; `an-old-export-imports-into-the-new-form`.

**E2e on dev:** export a version with every kind of workflow, import it on another deployment, and each runs.

### Stage 5. Time, values and forms

**Prerequisites:** stage 3 on dev.

**What it builds:** the run-level `wait` for a duration or a recorded time (G4); three kinds of deadline, due, remind and timeout, on the one-shot scheduler (G5); typed recorded values and a state-entry count on edges (G6); a notice on entering a state (G19); the platform form machine (G16, G24).

**Tests:** `a-wait-step-fires-once-at-its-time`, `a-due-time-cancels-nothing`, `a-reminder-stops-at-its-cap`, `an-edge-compares-a-recorded-value`, `a-form-records-its-fields`.

**E2e on dev:** a service call's survey is sent two days after sign-off, and a quote card shows its amount.

### The next records

- **Events in and out:** the `ae.connector` consumer and `on: { fact }`, outbound actions under the assistant's own session, the add step, the indirect worker, who decided, the deployment's own app, the outbound undo of a canceled run, and references that resolve to nothing after erasure. Done when a PagerDuty e2e on dev opens a room from an alert, adds the named responder and settles on the acknowledgement.
- **Drift as a workflow event:** `subject-changed`, the `drift_offer` machine and the open and go steps (A.9). Done when a drift e2e on dev moves a subject through a team's workflow.

## What is built, and what proves it

Status for every decision and stage, with the test that proves each, lives in [SPEC-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/SPEC-WORKFLOWS-AND-TASKS.md). Little in this record is built (the assistant page's "Shipped" label and the duel rule hold today); the parts it builds on are built and their rows there name their proof.

## Decisions on the open questions

1. **Decided 2026-11-05** (the owner took the recommendation): the stored home of an intent trigger. `eventWorkflows` cannot hold it (Options considered: names refuse underscores, at most 8 workflows in 32,000 characters, `on` must be an event). **Decision:** a separate `intentWorkflows` map keyed by the intent's key, at most one entry per `TASK_MULTI_STEP` intent the pack declares, with its own byte limit and the same body-store home as `intentPack.machines`; the task's steps stay in `intentPack.machines`, so ADR-066's hashing is unchanged. It adds one field to the export format, which an older import simply lacks.
2. **Decided 2026-11-05:** the incident first look's first step is a task turn and takes the turn lock (ADR-063 decision 5), so a person writing in the ops room while it runs is queued rather than answered beside it; measured in stage 2's e2e.
3. **Decided 2026-11-05:** a `continue: opened` step is exempt from ADR-063 F1's required deadline, as an intent trigger's canonical step is, because its run no longer waits on the task; the task row's expiry bounds it.
4. **Decided 2026-11-05:** a single-turn intent has no workflow; an intent that needs steps is made multi-step.
5. **Decided 2026-11-05:** "Shipped" names every copyable starting point in the console from stage 1, "Platform" names the fixed set, and the constant is renamed in stage 4.
6. **Decided 2026-11-05:** steps after a task that reopens run once, at its first settlement; a later reopen raises a `task-reopened` event a team may attach a workflow to; rework is a view in Effectiveness over the reopen transitions the archive holds (decision 2).
7. **Decided 2026-11-05:** every run writes a run-end archive record, through the archive, never a counter (decision 6).
8. **Decided 2026-11-05:** runs are sequential for stages 1 to 4; a fan-out step is planned for a later stage (decision 9).
9. **Decided 2026-11-05:** a private run reaches no one but its requester; every step to the room, another person or an outside tool is withheld, and the requester is told (decision 8). The platform exits are not run steps and are never withheld.
10. **Decided 2026-11-05:** the low-frequency reconciliation sweep for a lost settlement naming (tenet D6, ADR-063 decision 6) is built before stage 3 ships, over tasks that record a run and settled without a continuation.
11. **Decided 2026-11-05,** owner: "Should a battle itself be a workflow? Do what is easiest here without breaking what is currently working". A duel side opens its task as today and runs no workflow steps; the battle keeps its own engine; a battle started as a workflow by the `/battle` command is a later proposal.
12. **Decided 2026-11-05:** typed recorded values with a small set of comparisons, plus a count of entries into a state, and the platform form machine for written answers and what a card shows (G6, G16, G24).
13. **Decided 2026-11-05:** an operator cancels a run, each live task settles on its own edge, and the outbound writes the run made are undone under the assistant's own session (the undo with the next record); every run also carries a platform exit no team can remove: `/stop` ends the person's own run, and "get me a person" is a platform command and button that hands off through the deployment's own tools, never recognized from a phrase. The exits are never withheld, a private run's included; the handoff carries a reference only, and the person who picks it up signs in to read it.

## Decisions on the worked examples' gaps

Decided by the owner 2026-11-06, the tenet this design is held to: ownership is never broken. A workflow and its tasks belong to the assistant whose version declares them; work that needs another assistant's access is a request naming one of its advertised intents, which its own version runs and may decline, and the asking run receives only the ending and what that assistant declares shared (DESIGN-WORKFLOWS-AND-TASKS section 1, SPEC-WORKFLOWS-AND-TASKS WT118). Why: access stays with the assistant granted it, so an asker never inherits another's reach (tenets D1, D3, D4); the owning team keeps control of its process, its cost, its policies and whether anything is provided (P5); only the outcome crosses an assistant boundary; each declared intent is measured one way whoever asked, so its owners see all of its demand (D7); an owner can change its workflow, model or version without breaking any assistant that asks it, because the contract is the advertised intent and its ending (P3); and a workflow holds only its own assistant's steps, so it is read and audited alone (P4). The benefits are set out in DESIGN-WORKFLOWS-AND-TASKS section 1, "Why ownership is the tenet". Built 2026-11-06, proven by unit tests (`backend/test/lib/a-request-to-another-assistant-runs-its-own-workflow.test.ts`); its dev run is owed: an agent step's `as` is retired; a request (`by: { assistantRole }`) starts the owning assistant's own run of the advertised intent on its served version, says what is needed through `ask`, may not declare `visibility`, `priority`, `fields` or `deadline`, and continues the asking run on the task's ending with only its own values; every run records what started it (`person`, `assistant` or `event`), a breakdown of each workflow edition. **NOT BUILT**: a value the owner declares shared through its advertisement; per-step instructions for a person holding a step; the asking assistant's view of its own step as a request; and WT119. Where more than one live assistant in the room holds the role, nobody is asked and the step fails (built, same test).

Decided 2026-11-05, each recorded in its SPEC-WORKFLOWS-AND-TASKS row: an intent workflow declares its conversation types (G20); `requester` is a task person and a send audience on intent triggers (G17, G18); a new request mid-task opens its own task (G15); a run-level `wait` for a time or an inbound fact (G4, G33); three kinds of deadline, due, remind and timeout (G5); typed recorded values and an entry count (G6); the form machine (G16, G24); a run record lives for the sum of its remaining waits, at most 45 days, holding references only, reached by a person's erasure (G12); a text to a member by phone is a message template carrying the full text or a reference link (G37); the first look's automatic move is declared (G39); a kept welcome is stored outside `eventWorkflows` (G40); `continue: opened` is refused on an intent trigger (G43); a task given to an assistant role runs the machine from that role's assistant's active version, which pins its origin (G11, revised 2026-11-06); accepting a queued request starts its intent's workflow as if the message had arrived alone, keyed by the queued message's own correlation id (G9).

## Appendix A: worked examples

This appendix tests the model by writing eleven workflows in the shape this record proposes: five that run today (A.1 to A.5), three a deployment would want that nothing ships (A.6 to A.8), drift detection (A.9), which runs today outside any workflow and which teams want to shape, and two that mix direct and indirect participants (decision 8): a service appointment that moves between a technician by phone, a support ticket and a new conversation (A.10), and an external statement signed off by a legal reviewer who never uses chat (A.11). Each uses only the steps and fields the decisions define. Where an example needs something the record does not define, the YAML says so in a comment naming a gap (G1 to G44), and A.12 groups the gaps. A.6 to A.8 follow decision 8's boundary: who does the work is decided in the deployment's own tools, which the workflow reaches by outbound and inbound events. Every example is **NOT BUILT** in this form; A.1 to A.5 describe what runs today in the record's vocabulary.

Each example is followed by one row per consideration the owner named: analytics and versions, requirements to move forward, ownership, parallel steps, and the task list.

Conventions in the YAML: `on: { intent }` is decision 1's trigger; a create-task step is `task:` with `TaskStep`'s fields (`backend/lambda/src/lib/task-step.ts:38`); `continue:` is decision 2's; edges read `task:state` only on the step that opened the task (ADR-063 decision 1). A machine's states use `TaskStateDef`'s fields (`backend/lambda/src/lib/task-state-machines.ts:59`). Template names no shipped template carries (for example `delivery-not-accepted`) are the team's own message templates (ADR-062).

### A.1 The welcome (existing, event trigger)

The assistant joins a conversation, opens it from the deployment's orientation, and follows the opening with one model-written message (SPEC-WELCOME-AND-CONTEXT FR24).

```yaml
welcome:
  on: assistant-joined
  initial: opening
  states:
    opening:
      opening: { examples: [ask about a plan, ask for a report] }   # WelcomeOpeningStep fields
      onSuccess: greet
      onFailure: done
    greet:
      prompt: { template: welcome-greeting, tools: [load_company_context] }   # read tools only
      onSuccess: done
      onFailure: done
    done: { disposition: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | The prompt step's turn records `turnKind: 'event_step'` with `eventStep` and `eventRun` on its message metadata, with no projection column (decision 6, "What is built"), so Effectiveness cannot group welcomes today. Under decision 6 the run carries `workflow_name: welcome` and `workflow_origin_hash`; editing the opening's examples or the prompt's template name changes the welcome's edition and no intent's. A template's own text changing under the same name changes no workflow hash, so a copy edit is not a new edition unless the template is pinned by version |
| Requirements to move forward | None at task level. A step's `when` gates it on platform sources (for example `person:onboarded`), checked by the runner (`gateHolds`) |
| Ownership | The workflow is the version's, owned by the assistant's team (decision 8). The run is the joining assistant's; the prompt turn is its own, metered `machineWritten` (`PromptWelcomeStep`, `backend/lambda/src/lib/event-workflow.ts:288`) |
| Parallel | None needed. The prompt turn posts after the run has moved on, which is a run that ends early, not two steps at once |
| Task list | Nothing: a welcome creates no task, and the run record is never listed (decision 10) |

**Where the model breaks:**

- G40: switching the welcome from Workflow back to Template keeps the workflow in the draft, while the runtime takes the first matching `assistant-joined` entry (`welcomeWorkflowOf`), so a kept second welcome could be the one that runs. Decided 2026-11-05: the unused welcome is kept outside `eventWorkflows`, where nothing that runs reads it.
- Nothing else: the welcome is a pure run-level workflow and fits.

### A.2 The ops room and its first look (existing, event trigger, `continue: opened`)

An event opens an ops room; the room is told, the lead is greeted, and the ops assistant takes a first look at the deployment's health as a task that then rests as the room's work.

```yaml
ops-room:
  on: conversation-opened
  types: [ops]
  initial: opening
  states:
    opening:
      send: { to: room, template: ops-room-opening, mention: { lead: participantRole:lead } }
      onSuccess: greet-lead
      onFailure: greet-lead
    greet-lead:
      send: { to: { participantRole: lead }, template: ops-lead-welcome }
      onSuccess: first-look
      onFailure: first-look
    first-look:
      task:
        machine: incident_first_look     # the version's copy (decision 3)
        by: { assistantRole: ops }       # for: absent, the task is for nobody
        visibility: conversation
        priority: high
        # deadline: required today (task-step.ts:50); exempt (OPEN 3, decided)
        continue: opened                 # GAP G21: a field of `task` or of the step? TASK_STEP_FIELDS refuses it today
      onSuccess: done
      onFailure: tell-unavailable        # GAP G23: also taken when no ops assistant is in the room
    tell-unavailable:
      send: { to: room, template: ops-first-look-unavailable }
      onSuccess: done
      onFailure: done
    done: { disposition: success }

incident_first_look:
  initial: reading_health
  states:
    reading_health:
      transitions: [findings_shared]
      tools: [read_deployment_health]
      requiresTool: [read_deployment_health]   # a team edit the record allows: the read runs before the move
      auto: findings_shared                    # the declared automatic move (G39), taken once the turn posts
    findings_shared:
      transitions: [reading_health, resolved]
      rests: true
    resolved: { transitions: [], terminal: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | The first look's turn becomes a task turn: `task_type: incident_first_look`, `task_step: reading_health`, `task_origin_machine_hash`, so Effectiveness L1 reads it per step (`getIntentSteps`), which it cannot do while it is an `event_step`. Editing `reading_health`'s prompt changes the machine's edition, not `ops-room`'s; editing a send's template name changes `ops-room`'s only |
| Requirements to move forward | `requiresTool` on `reading_health`, checked by the tool handler (`required_tool_not_run`); the move itself is the model's `advance_task_state`, authorized by the store. `findings_shared -> resolved` is the model's judgment that the room said the incident is over (tenet D11: recorded, never matched on words) |
| Ownership | Workflow: the ops assistant's team, through the ops assistant's version: the `ops` type names the ops role as the owner of its workflows (`workflowOwner`, ADR-061 decision 1 as amended 2026-11-12), so the run is the ops assistant's and the first look is its own task. Task: no requester; worker and assistant are the ops assistant, which holds it. Any member may ask for another read; only the ops assistant's turn moves it |
| Parallel | `continue: opened` lets the run end while the task rests, the one place the record lets a run and a task proceed independently. Nothing follows `first-look`, so no two run steps overlap. `incident-watch` runs beside it as a separate run on `alarm-state-changed` |
| Task list | Nobody's "waiting on you": an assistant-held task is in the assistant's partition. The room sees it through its reference, as a conversation task (decision 10 table) |

**Where the model breaks:**

- G39, the first look could stall: today the runtime takes `reading_health`'s one transition once the turn posted, and a team-edited machine may declare two. If the turn had to call `advance_task_state` itself, a turn that did not advance would hold the entry and the run would never reach `onSuccess`, and this example's `requiresTool` makes a missed advance likelier. Decided 2026-11-05: the state declares its automatic move as data (decision 2).
- G23, failure outcomes merge. Today the agent step posts `ops-assistant-absent` when no ops assistant is in the room and `ops-first-look-unavailable` when the turn misses its 20-second deadline. A create-task step that cannot find its worker "is not opened and takes onFailure" (ADR-063), and a task turn has no model deadline, so the two messages cannot be told apart and the late case posts nothing.
- G22, another run cannot move this task. `incident-watch` re-reads health when the alarm returns to `OK`, but its `recheck` is an agent step of a different run, not a turn bound to this task, so the first look stays at `findings_shared` until a person says it is over. Rule C (run steps set state) is refused for good reason; what is missing is a way for an event run's model turn to take an existing task as its subject.
- G21: where `continue:` lives, and the deadline exemption (OPEN 3), are both code changes in stage 2.

### A.3 image_generation (existing, intent trigger, reopens)

A person asks for an image; the assistant gathers the brief, confirms it when the request is incomplete, draws it, and revises it on request.

```yaml
image_generation:
  on: { intent: image_generation }   # the canonical workflow (decision 1): a runtime rule, not a stored TaskStep
  initial: work
  states:
    work:
      task: { machine: image_generation, for: requester }   # no deadline: exempt on the canonical step
      onSuccess: done
      onFailure: done
    done: { disposition: success }

image_generation:   # the machine, as shipped (task-state-machines.ts:812)
  initial: gather
  states:
    gather:   { transitions: [confirm, generate], awaits: { party: requester }, requires: [what to draw] }
    confirm:  { transitions: [generate, gather], awaits: { party: requester }, presented: true,
                confirm: when-incomplete, brief: [the subject, the style, the composition], resolvedByOneResponse: true }
    generate: { transitions: [done, failed], produces: image,
                action: { tool: generate_image, args: { prompt: 'requirement:what to draw' } }, onSuccess: done, onFailure: failed }
    revise:   { transitions: [generate, done], awaits: { party: requester } }
    done:     { transitions: [], terminal: success, reopens: [revise] }
    failed:   { transitions: [], terminal: failure }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | Each turn carries `task_step`; `generate` runs on the image model of the intent's route (ADR-064), so per-step model cost is already attributable. A reopen's turns carry the same `task_id` and the reopen's `task_transition`, so revisions per image are a query over projected turns. The run's edition is (canonical workflow hash, machine hash); only the machine hash moves when a team edits it |
| Requirements to move forward | `gather` requires "what to draw" (the model records it with evidence; the tool handler refuses `requirement_unsourced`). `gather -> generate` past `confirm` is allowed only when every need of `brief` is recorded and the task entered `gather` this turn (`directEdgeRefusal`, code). `generate` is the platform's act; its outcome takes `onSuccess` or `onFailure` |
| Ownership | Requester: the person. Held by the requester at `gather`, `confirm` and `revise`, by the assistant at `generate`. Only the model on the requester's turn may reopen (`by: 'tool'`) |
| Parallel | None |
| Task list | In the requester's open work while it awaits them, with the needs of the current state; it leaves at `done`, and a reopen returns it (status `in_progress`, `revise` awaits the requester) |

**Where the model breaks:**

- Nothing, as the canonical one-step case. Steps after `work` run once, at the first delivery (decision 2), so "post the final image to the room" posts the first image; a team that wants a revision posted too attaches a workflow to `task-reopened`.
- G6, a bound on loops. A team that wants "no more than three billable redraws" cannot say it: `revise -> generate` is an ordinary edge, and no condition source counts entries into a state.

### A.4 report_generation with an approval after delivery (existing machine, new run steps)

A person asks for a report; once it is delivered and the person says it stands, the room's lead approves it on a card, and the room is told. This is the example decision 1 offers for "what an intent workflow may do that today's rule cannot".

On the shipped machine it runs as written (decision 2, decided 2026-11-05): `completed` declares `reopens: [revising]` (`backend/lambda/src/lib/task-state-machines.ts:1102`), so the approval is asked once, about the first delivery, and a later revision raises `task-reopened`, to which a team attaches a workflow that asks again. The YAML below is the team copy this record first proposed; it remains valid, and is no longer required.

On the team's copy without `reopens`:

```yaml
report_generation:
  on: { intent: report_generation }
  # types: [team]   GAP G20: a participantRole in `by` requires declared types (task-step.ts:141); an intent trigger has none
  initial: work
  states:
    work:
      task: { machine: report_generation, for: requester }   # the version's copy: completed declares no reopens
      onSuccess: approve
      onFailure: done
    approve:
      task:
        machine: approval            # platform machine, by reference (decision 3)
        for: requester
        by: { participantRole: lead }
        visibility: conversation
        deadline: { afterMinutes: 2880 }
      onSuccess: [{ to: announce, when: { task:state: approved } }, { to: tell-declined }]
      onDeadline: tell-unanswered
      onFailure: done
    announce:
      send: { to: room, template: report-approved }       # withheld when the request was private (decision 8)
      onSuccess: done
      onFailure: done
    tell-declined:
      send: { to: requester, template: report-declined }  # GAP G18: `requester` is not a send audience (EventAudience, event-workflow.ts:151)
      onSuccess: done
      onFailure: done
    tell-unanswered:
      send: { to: requester, template: report-approval-lapsed }   # GAP G18
      onSuccess: done
      onFailure: done
    done: { disposition: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | The report's turns are attributed as today, plus the run's five fields. The approval settles on a card press, which writes no archive record today (G14), so "share of approved reports" and "time to approval" have no fact to read. Removing `reopens` changes the machine hash; adding `approve` changes the workflow hash; Effectiveness compares the two separately (decision 6) |
| Requirements to move forward | Inside the report: `requires` and `presented` at `collecting_requirements` and `drafting_outline`, and `produces: document` on `generating`. At run level: the approval's `choices`, checked by the task service against the assignee; the run's branch reads `task:state` |
| Ownership | Report task: the requester's, worked by the assistant. Approval task: for the requester, worked and held by the lead (`oneHolder`, ADR-063 B1); only the lead may press, and any other caller is refused `NOT_ASSIGNEE`. The run is the assistant's |
| Parallel | None needed |
| Task list | The report in the requester's list while it awaits them; then the approval in the lead's list with its card and its due time; nothing in the requester's list while the lead decides |

**Where the model breaks:**

- Decision 2's reopen rule: the approval is asked about the first delivery only. A revision after `completed` reopens the same task and raises `task-reopened`; asking the lead again is a workflow on that event, and how often reports are reworked is the rework view (decided 2026-11-05).
- G20: an intent workflow that names a participant role must declare the conversation types it runs in, and the record's intent trigger has no `types`, nor a rule for an intent that fires in a type the workflow does not declare. Stage 3's own e2e ("the run asks the room's lead to approve") hits this directly.
- G18: the audience rule speaks of "steps addressed to its requester", and no send audience names the requester of an intent run.
- G16: a declined report carries no reason, because the approval card offers two choices and a written reason has no platform machine.
- G14: the approval's settlement is unmeasured until each settlement writes an archive fact (a stage 3 prerequisite).

### A.5 account_brief (existing custom intent, canonical)

A person on the premium assistant asks for a brief on one account; the assistant reads the account record, then writes the brief (`ACCOUNT_BRIEF_WORKFLOW`, `demo/stratum-company/intent-packs.ts:126`).

```yaml
account_brief:
  on: { intent: account_brief }
  initial: work
  states:
    work:
      task: { machine: account_brief, for: requester }
      onSuccess: done
      onFailure: done
    done: { disposition: success }

account_brief:
  initial: researching
  states:
    researching: { transitions: [drafting], tools: [load_company_context], requiresTool: [load_company_context] }
    drafting:    { transitions: [completed] }
    completed:   { transitions: [], terminal: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | Per-step rows (`researching`, `drafting`) per model, narrowed by machine hash from stage 3. The machine rides the classification's pack until a draft copies it (ADR-066 decision 1), so its edition is the pack's until then |
| Requirements to move forward | `requiresTool`: `researching -> drafting` is refused with `required_tool_not_run` until `load_company_context` returned success since the step was entered. The rest is the model's advance |
| Ownership | The requester's; worked by the assistant |
| Parallel | None |
| Task list | No state awaits the requester, and the router passes no owner, so the task is created held by the requester (`backend/lambda/src/lib/task-tracking.ts:851` to `:854`) and lists in their open work while it is live, with no needs. Decision 10's table does not list this case: a task that waits on nobody can read as "waiting on you" for the turn or two it lives |

**Where the model breaks:**

- Nothing structural; the canonical case fits. The task-list reading above is a decision 10 clarification, not a change the record makes.

### A.6 A delivery (new, intent trigger, an outside dispatch system)

A customer asks for something to be delivered. The assistant collects the item, the address and a window, and confirms them. The deployment's dispatch system, not the platform, takes the job, chooses a driver and reports its progress: the workflow sends the job out, waits for the system to say it was accepted, adds the named driver to the conversation, and follows the system's status events (out for delivery, delivered, a failed attempt). A failed attempt is rescheduled with the customer, the customer confirms receipt, and the work closes.

```yaml
delivery:
  on: { intent: delivery_request }
  # types: [customer-delivery]   GAP G20: needed for participantRole driver
  initial: request
  states:
    request:
      task: { machine: delivery_request, for: requester }   # the intent's own machine, first (decision 1)
      onSuccess: [{ to: dispatch, when: { task:state: confirmed } }, { to: done }]
      onFailure: done
    dispatch:
      action: { tool: dispatch_create_job, args: { item: 'requirement:the item', address: 'requirement:the delivery address',
                window: 'requirement:the delivery window' } }   # GAP G7: an outbound event; a run-level connector action and the connector are both missing
      onSuccess: accepted
      onFailure: tell-not-accepted
    accepted:
      wait:
        event: dispatch.job-accepted                # GAP G33: an inbound event, verified, naming this run's job
        deadline: { afterMinutes: 120 }
      onSuccess: add-driver
      onDeadline: tell-not-accepted
    add-driver:
      add: { participantRole: driver, person: 'event:assignee' }   # GAP G32: the person the system named, signed in through the IdP
      onSuccess: track
      onFailure: track                              # the system's events still move the task with nobody added
    track:
      task:
        machine: delivery_tracking
        for: requester
        by: { participantRole: driver }
        visibility: conversation
        deadline: { afterMinutes: 10080 }           # GAP G5: the deadline cancels the job; a late delivery needs escalation, not a cancel
      onSuccess: receipt
      onDeadline: tell-late
      onFailure: tell-failed
    receipt:
      task:
        machine: acknowledgement                    # awaits the worker
        for: requester
        by: requester                               # GAP G17: `requester` is not a TaskPerson, and `by` needs it too
        deadline: { afterMinutes: 4320 }
      onSuccess: done
      onDeadline: done                              # receipt unconfirmed for three days closes the job
      onFailure: done
    tell-not-accepted: { send: { to: requester, template: delivery-not-accepted }, onSuccess: done, onFailure: done }   # GAP G18
    tell-late:         { send: { to: requester, template: delivery-late },         onSuccess: done, onFailure: done }   # GAP G18
    tell-failed:       { send: { to: requester, template: delivery-failed },       onSuccess: done, onFailure: done }   # GAP G18
    done: { disposition: success }

delivery_request:
  initial: collecting
  states:
    collecting:
      transitions: [confirming]
      awaits: { party: requester }
      requires: [the item, the delivery address, the delivery window]   # the model judges the words; the dispatch system checks the address and the window
      presented: true
    confirming:
      transitions: [confirmed, collecting, withdrawn]
      awaits: { party: requester }
      choices: [confirmed, withdrawn]
    confirmed: { transitions: [], terminal: success }
    withdrawn: { transitions: [], terminal: handoff }

delivery_tracking:
  initial: scheduled
  states:
    scheduled:
      transitions: [out_for_delivery, rescheduling, cancelled]
      on: { 'dispatch.out-for-delivery': out_for_delivery, 'dispatch.cancelled': cancelled }   # GAP G33: inbound events take declared edges
      notify: { to: requester, template: delivery-scheduled }   # GAP G19: no notice on entry
    out_for_delivery:
      transitions: [delivered, attempt_failed]
      on: { 'dispatch.delivered': delivered, 'dispatch.attempt-failed': attempt_failed }       # the driver acts in the dispatch tool, not on a card
      notify: { to: requester, template: delivery-out }         # GAP G19
    attempt_failed:
      transitions: [rescheduling, failed]
      awaits: { party: requester }
      requires: [a new delivery window, or that they no longer want it]   # GAP G6: "fail after the second attempt" has no condition source
    rescheduling:
      transitions: [scheduled]
      action: { tool: dispatch_reschedule, args: { window: 'requirement:a new delivery window' } }   # GAP G7: a consequential external write
      onSuccess: scheduled
    delivered: { transitions: [], terminal: success }
    failed:    { transitions: [], terminal: failure }
    cancelled: { transitions: [], terminal: failure }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | The run has three tasks over three machines (`delivery_request`, `delivery_tracking`, `acknowledgement`); decision 6 measures the run by its workflow hash and each task by its own machine hash, so an edit to `delivery_tracking` is that machine's new edition, not the run's (G13). Time to accept and on-time share are the dispatch system's figures, and the platform needs only the moments it saw: the inbound events and the transitions they took, which write no archive record today (G14). Attempts per delivery is a count of `attempt_failed` entries |
| Requirements to move forward | `collecting` requires three needs the model records with evidence; `confirming` is the customer's choice; the job's acceptance and every status move are inbound events the dispatch system sends, each verified and allowed only on a declared edge (G33); the reschedule is a connector write the customer's recorded window drives (G7). The address and the window are checked by the dispatch system, which answers the outbound event |
| Ownership | Workflow: the assistant's team. Every task is for the customer. Who drives is the dispatch system's decision; the platform's part is to add the person it names, who signed in through the deployment's identity provider, as the `driver` role's holder (G32). The receipt is meant to be held by the customer (G17). A reschedule the customer asks for while the task waits on the dispatch system has no defined path (G8) |
| Parallel | None needed. Each wait follows the last; sequential runs (decision 9, option a) fit |
| Task list | Customer: `delivery_request` while collecting and confirming; nothing while the dispatch system has the job (the customer sees it move through the conversation's task reference and the entry notices); `attempt_failed` returns to them; then the receipt. Driver: nothing in the task list, because they act in the dispatch tool; the platform lists only what waits on a person in it |

**Where the model breaks:**

- G7, the outbound event. A run-level step may run the intake's `action` and two `propose` ops (`PROPOSAL_OPS`, `backend/lambda/src/lib/event-workflow.ts:263`), not a connector tool, and no dispatch connector is registered (`TOOL_REGISTRY`, `backend/lambda/src/lib/tool-registry.ts:61`, has one mock connector). Creating a job and rescheduling it are consequential external writes, which need a declared confirmation (the customer's `confirming` choice is that confirmation here).
- G33, the inbound event. The connector receiver verifies a vendor's event and publishes an `ae.connector` fact (SPEC-CONNECTORS, "A vendor event, end to end"), but nothing consumes the fact: `EVENT_WORKFLOW_EVENTS` is closed, and no step waits for a fact or binds it to a run or a task. The out-of-band advance the `place_item` comment defers is the same missing piece. Every status move of the delivery depends on it, and no dispatch vendor has an adapter.
- G32, adding the named person. The receiver already resolves the people a vendor names through `Identities` and admits only those whose clearance reaches the connector's classification (SPEC-CONNECTORS K1, K4); a person with no row is `unresolved`, and a connector issuing them an invitation is **NOT BUILT**. What is missing is the step that adds an admitted person to this conversation as a role's holder. Adding a member is an invitation today (`addInvitedMember`, `backend/lambda/src/lib/channel-creation.ts:1195`), bound to a conversation type that declares invitations.
- G19: the customer is told nothing when the parcel goes out, because a state entered on an event runs no assistant turn and no task step sends on entry.
- G5: the job's deadline cancels the tracking task, so a late delivery is closed rather than escalated.
- G8: a reschedule asked for while the dispatch system has the job, and a cancel asked for by the customer at any point (OPEN 13, a run cancel), have no declared mover.
- G6: "after the second failed attempt, return it" needs a count no condition reads.
- G15: while the customer holds `attempt_failed` or the receipt, a new message from them continues that task (continue before trigger), so the second delivery request reaches that task's turn, where the model judges whether it is about the first; a new multi-step request cannot open its own task today (decided 2026-11-05: it will, G15).
- G12: the run spans up to ten days of task deadlines in sequence, beyond the run record's seven-day TTL (`EVENT_RUN_TTL_SECONDS`, `backend/lambda/src/lib/event-run-store.ts:19`); the record lives for the sum of its remaining waits, at most 45 days (decided 2026-11-05), which for a chain is the sum of its waits.

### A.7 A service call: appliance repair (new, intent trigger)

A customer reports a broken appliance. The assistant triages the symptom with guided questions and may resolve it remotely. Otherwise the warranty decides whether the call is free or quoted; a paid call needs the customer's approval of the quote. The deployment's field-service tool, not the platform, creates the work order and assigns a technician; the workflow adds the named technician to the conversation, and the visit follows the tool's events (on site, parts needed, parts arrived, fixed). The customer signs off, the work closes, and a survey follows two days later.

```yaml
service_call:
  on: { intent: service_call }
  # types: [customer-service]   GAP G20
  initial: triage
  states:
    triage:
      task: { machine: service_call, for: requester }
      onSuccess: [{ to: warranty, when: { task:state: needs_visit } }, { to: done }]   # resolved_remotely ends the run
      onFailure: done
    warranty:
      task:
        machine: warranty_check
        for: requester
        deadline: { afterMinutes: 30 }
      onSuccess: [{ to: visit, when: { task:state: covered } }, { to: quote }]
      onFailure: quote
    quote:
      task:
        machine: approval                 # the customer approves the call-out quote
        for: requester
        by: requester                     # GAP G17
        deadline: { afterMinutes: 2880 }  # GAP G24: the card shows the task's label and reference, not the amount
      onSuccess: [{ to: order, when: { task:state: approved } }, { to: done }]
      onDeadline: done
      onFailure: done
    order:
      action: { tool: fsm_create_work_order, args: { symptom: 'requirement:what is going wrong' } }   # GAP G7: outbound; a ServiceTitan connector is NOT BUILT
      onSuccess: assigned
      onFailure: done
    assigned:
      wait: { event: fsm.technician-assigned, deadline: { afterMinutes: 1440 } }   # GAP G33: inbound event
      onSuccess: add-technician
      onDeadline: done
    add-technician:
      add: { participantRole: technician, person: 'event:assignee' }   # GAP G32: the person the tool named, signed in through the IdP
      onSuccess: visit
      onFailure: visit
    visit:
      task:
        machine: technician_visit
        for: requester
        by: { participantRole: technician }   # the tool chose them; one holder per role holds
        visibility: conversation
        deadline: { afterMinutes: 43200 }     # the 30-day bound; a back-ordered part can exceed it
      onSuccess: survey-intro
      onFailure: done
    survey-intro:
      # GAP G4: no run-level step waits for a time; the survey should follow two days after sign-off
      send: { to: requester, template: service-survey-intro }   # GAP G18
      onSuccess: survey
      onFailure: done
    survey:
      task:
        machine: service_survey
        for: requester
        by: requester                     # GAP G17
        deadline: { afterMinutes: 10080 }
      onSuccess: done
      onDeadline: done
      onFailure: done
    done: { disposition: success }

service_call:            # the intent's own machine: guided_troubleshooting's shape with two success endings
  initial: collecting_symptoms
  states:
    collecting_symptoms:
      transitions: [diagnosing]
      awaits: { party: requester }
      requires: [the appliance and model, what is going wrong, when it started, the purchase date]
      presented: true
    diagnosing:          { transitions: [guiding, needs_visit] }
    guiding:             { transitions: [awaiting_result] }
    awaiting_result:     { transitions: [resolved_remotely, diagnosing, needs_visit], awaits: { party: requester } }
    resolved_remotely:   { transitions: [], terminal: success }
    needs_visit:         { transitions: [], terminal: success }   # a routing ending: the run reads which (G6)

warranty_check:
  initial: checking
  states:
    checking:
      transitions: [covered, not_covered]
      tools: [lookup_warranty]            # GAP G7: no such registered tool
      requiresTool: [lookup_warranty]     # the model reads the result and chooses; no edge reads the result itself (G6)
    covered:     { transitions: [], terminal: success }
    not_covered: { transitions: [], terminal: success }

technician_visit:
  initial: booking
  states:
    booking:
      transitions: [booked]
      awaits: { party: requester }
      requires: [a visit window]
      action: { tool: fsm_book_visit, args: { window: 'requirement:a visit window' } }   # GAP G7: the tool checks the window against the technician's
    booked:
      transitions: [on_site, booking]
      on: { 'fsm.on-site': on_site }              # GAP G33; GAP G4: no reminder the day before; GAP G19: no notice on entry
    on_site:
      transitions: [fixed, needs_parts]
      awaits: { party: worker }
      choices: [fixed, needs_parts]               # the technician, added to the conversation, answers on the card or in the tool (both bind to the same edges)
    needs_parts:
      transitions: [parts_quoted]
      awaits: { party: worker }
      requires: [the parts needed and their cost]
    parts_quoted:
      transitions: [awaiting_parts, declined]
      awaits: { party: requester }
      choices: [awaiting_parts, declined]         # the customer decides on the parts quote on their card
    awaiting_parts:
      transitions: [booking]                      # the second visit is the same loop: booking again
      on: { 'fsm.parts-arrived': booking }        # GAP G33: the parts system's "arrived"
    fixed:
      transitions: [signed_off, on_site]
      awaits: { party: requester }
      choices: [signed_off, on_site]              # "not fixed" returns the technician to the job
    signed_off: { transitions: [], terminal: success }
    declined:   { transitions: [], terminal: failure }

service_survey:
  initial: asked
  states:
    asked:
      transitions: [rated_good, rated_fair, rated_poor]
      awaits: { party: worker }
      choices: [rated_good, rated_fair, rated_poor]   # GAP G16: a written comment has no platform machine
    rated_good: { transitions: [], terminal: success }
    rated_fair: { transitions: [], terminal: success }
    rated_poor: { transitions: [], terminal: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | Five machines in one run (G13). The measures a service team wants (remote resolution rate, first-visit fix rate, visits per job, quote acceptance, survey score) are terminal states and loop counts; the remote resolution and the warranty result settle on assistant turns and reach the archive as `task_terminal`, while the quote, the visit's choices and the survey settle on card presses and reach nothing (G14). The survey's rating is a terminal state name, so the score is a query over `task_state` once it is archived |
| Requirements to move forward | `collecting_symptoms` requires four needs (model, with evidence); `warranty_check` requires the lookup to have run (code) and the model to choose the ending from its result; the quote, the visit's states and the survey are choices of the party each awaits (task service); `needs_parts` requires the parts and cost from the technician before the customer is asked |
| Ownership | Every task is for the customer. Triage and the warranty check are the assistant's. The field-service tool picks the technician, and the platform adds the person it names (G32); the visit is then worked by the technician and moves between the technician and the customer at each `awaits` boundary (`maybeHandOver`), which is the two-party case the model handles well. The quote and the survey need the customer as worker (G17) |
| Parallel | None is required. The warranty lookup could run while the customer books a window, which saves one short step; sequential is correct and simpler. Parts on order and the customer's availability are two waits, but one follows the other inside the visit |
| Task list | Customer: symptom collection and results, the quote card, booking, the parts quote card, sign-off, the survey card, each while it awaits them. Technician: the visit at `on_site` and `needs_parts`, the states that await them; `booked` and `awaiting_parts` wait on the tool's events and list for nobody. Its due time is 30 days out and says nothing about the appointment. The appointment's own time is not a field anywhere a list reads (G4) |

**Where the model breaks:**

- Assignment is the field-service tool's, by decision 8: the platform keeps no technician pool. Its part is G32 (add the technician the tool names, signed in through the identity provider) and G33 (the tool's events move the visit).
- G7: no warranty lookup, field-service, booking or parts connector is registered; each is one adapter and one registry entry. Every connector tool is declared `changesState: false`, and a consequential external write (create the work order, book the slot, order the part) has no proposal-and-confirm path inside a task; the run-level `propose` covers two ops (`PROPOSAL_OPS`, `backend/lambda/src/lib/event-workflow.ts:263`). Here the customer's quote approval and booking choice are the confirmations.
- G33: on site, parts arrived and the booking's confirmation come from the field-service tool, and no inbound event can carry them.
- G4: a survey two days after sign-off, a reminder before the visit, and an appointment time a list can show each need a time a step waits for, which no step kind provides. The only time a task has is its whole deadline, which cancels.
- G6: warranty versus paid is decided by the model reading a tool result and choosing an ending, because no edge condition reads a recorded value; the branch is legitimate (the model records its evidence), but a code-checkable fact (a purchase date against a warranty term) is decided by judgment.
- G24: the customer approves a quote on a card that shows the approval task's label and the task's reference (decision 8), not the amount.
- G16: the survey's comment, and a reason for a declined parts quote, have no written-answer machine.
- G12: a job with a back-ordered part can outlast the 30-day task bound and the seven-day run record.

### A.8 Full triage in a shared room (new, intent trigger, queue, private request, outside tools)

Requests arrive in a shared support room. Each is triaged for urgency and category and sent on: a billing question to the billing assistant in the room (a roommate), an access problem to the identity team's ticketing system, an outage to the deployment's on-call pager. The ticketing system and the pager, not the platform, decide who works the request and escalate it on their own policies; the workflow sends the request out, waits for their events, adds the engineer the pager names to the room, and closes with the requester. Several requests may arrive at once, and one may be private.

```yaml
support_request:
  on: { intent: support_request }
  # types: [support]   GAP G20: needed for participantRole responder and triage_lead
  initial: triage
  states:
    triage:
      task: { machine: support_request, for: requester }
      onSuccess:                                         # GAP G6: urgency and category are terminal state names
        - { to: route-billing, when: { task:state: billing } }
        - { to: page,          when: { task:state: outage } }
        - { to: ticket,        when: { task:state: access } }
        - { to: done }                                   # answered in triage
      onFailure: done
    route-billing:
      task:
        machine: billing_case
        for: requester
        by: { assistantRole: billing }                   # the roommate (GAP G11: whose version's machine it works)
        visibility: conversation                         # GAP G10: a private trigger keeps it private
        deadline: { afterMinutes: 1440 }
      onSuccess: confirm-resolved
      onDeadline: tell-lead
      onFailure: tell-lead
    ticket:
      action: { tool: ticketing_create, args: { queue: identity, summary: 'requirement:what is affected' } }   # GAP G7: ServiceNow or Jira Service Management, both NOT BUILT
      onSuccess: ticket-closed
      onFailure: tell-lead
    ticket-closed:
      wait: { event: ticketing.resolved, deadline: { afterMinutes: 4320 } }   # GAP G33: inbound event naming this run's ticket
      onSuccess: confirm-resolved
      onDeadline: tell-lead
    page:
      action: { tool: pagerduty_trigger, args: { service: 'requirement:what is affected', urgency: high } }   # GAP G7: outbound; the PagerDuty connector receives only
      onSuccess: acknowledged
      onFailure: tell-lead
    acknowledged:
      wait: { event: pagerduty.incident.acknowledged, deadline: { afterMinutes: 60 } }   # GAP G33: the built PagerDuty adapter publishes this fact; nothing consumes it
      onSuccess: add-responder
      onDeadline: tell-lead
    add-responder:
      add: { participantRole: responder, person: 'event:assignee' }          # GAP G32: incident.assignments[], resolved and admitted by the receiver
      onSuccess: work-outage
      onFailure: work-outage
    work-outage:
      task:
        machine: outage_case
        for: requester
        by: { assistantRole: ops }
        visibility: conversation
        priority: high
        deadline: { afterMinutes: 1440 }
      onSuccess: confirm-resolved
      onFailure: tell-lead
    confirm-resolved:
      task:
        machine: resolution_check                        # the team's: choices [resolved, not_resolved]
        for: requester
        by: requester                                    # GAP G17
        deadline: { afterMinutes: 4320 }
      onSuccess: [{ to: done, when: { task:state: resolved } }, { to: reopened }]   # the run is acyclic: no return to the routing steps
      onDeadline: done
      onFailure: done
    reopened:  { send: { to: { participantRole: triage_lead }, template: support-reopened },  onSuccess: done, onFailure: done }
    tell-lead: { send: { to: { participantRole: triage_lead }, template: support-unanswered }, onSuccess: done, onFailure: done }
    done: { disposition: success }

support_request:
  initial: classifying
  states:
    classifying:
      transitions: [clarifying, billing, outage, access, answered]
      tools: [load_company_context]
    clarifying:
      transitions: [billing, outage, access, answered]
      awaits: { party: requester }
      requires: [what is affected, how many people it affects, since when]
    billing:  { transitions: [], terminal: success }
    outage:   { transitions: [], terminal: success }
    access:   { transitions: [], terminal: success }
    answered: { transitions: [], terminal: success }
```

**Several requests at once.** While the room's assistant is answering, new messages queue behind the turn lock (ADR-033); the reading opens one `queued_request` (or `queued_clarification`) per message, each awaiting its sender at `proposed`, routed under the intent the message was classified with (`intentsById`, `backend/lambda/src/lib/turn-triage-proposal.ts:1515` to `:1519`; `taskTypeFor`, `:1560`). A queued support request runs the platform's `queued_request` until its sender accepts it; accepting it starts `support_request`'s workflow, keyed by the queued message's own id, and the run's own task step takes the accepted request (G9).

**A private request in the shared room.** A targeted message opens its first task private (decision 8). The runner then withholds every step that reaches anyone but the requester: `tell-lead`, `add-responder`, `reopened` and the outbound `ticket` and `page` record `withheld` and take their failure edges, and the requester is told a step was withheld. A privately reported outage is therefore not paged (G10). Handing to an assistant role (`route-billing`, `work-outage`) is not withheld, because no other person is reached.

| Consideration | How the example lands |
|---|---|
| Analytics and versions | Category mix and urgency are the triage task's terminal states, which reach the archive on the assistant turn that advanced (`task_terminal`). Time to acknowledge and escalation are the pager's figures; the platform needs only the events it received and the steps they took, plus the requester's resolution answer, all of which settle without an assistant turn and reach nothing today (G14). Four machines in one run (G13). A misroute has no fact: the routed work fails or times out, which reads the same as slow work |
| Requirements to move forward | Classification is the model's choice among declared endings (D11 holds: a recorded move, not a matched phrase); `clarifying` requires three needs; the ticket's resolution and the page's acknowledgement are inbound events, verified and bound to this run (G33); the run's routing reads `task:state` |
| Ownership | The run is the room's primary assistant's. Each task is for the requester; the billing case is the billing roommate's (`assistantId` is the worker), the outage case the ops assistant's. Who works the access ticket and who answers the page are the ticketing system's and the pager's decisions; the platform adds the named engineer as the `responder` role's holder (G32). The task service refuses a roommate of another classification (`isOwnAssistant`) |
| Parallel | None needed. Paging every on-call engineer and continuing on the first acknowledgement is the pager's fan-out, not the workflow's, so decision 9's sequential runs hold |
| Task list | Requester: the triage task while `clarifying`, then nothing while the work is elsewhere, then the resolution check. The responder: the outage case's states that await a person, once they are added. The ticketing system's and the pager's queues stay in those tools. Assistants' tasks are in no person's list. Queued requests appear in each sender's list as `queued_request` rows, not as support requests |

**Where the model breaks:**

- G9, the queue does not trigger workflows. A queued request runs the platform's `queued_request` machine under its message's intent, so requests that arrive together (the common case in a busy room) skip triage and routing. The record does not say whether accepting a queued request starts the intent's run, or what its run key is (the queued message's correlation id is not the reading turn's). This is a platform queue (decision 3), not team routing, so it stays the platform's to answer. Decided 2026-11-05: accepting a queued request starts the intent's workflow as if the message had arrived alone, keyed by the queued message's own correlation id.
- G10, a private request and the systems outside. Decided 2026-11-05 (OPEN 9, owner: "Withhold everything"): a private run reaches no one but its requester, so it adds no responder and sends no outbound event; a privately reported outage is not paged, and the requester is told a step was withheld and may ask again in the room.
- G7 and G33: the pager and the ticketing system need a connector each (an outbound event) and an inbound event each (acknowledged, resolved), verified and bound to the run that sent them.
- G32: the responder joins only if the pager's assignee resolves to a user of the deployment, signed in through its identity provider, in the room's classification.
- G11, the roommate's version. `by: { assistantRole: billing }` opens a task of the run's version's `billing_case`, worked by the billing assistant, whose own version may declare a different `billing_case` or none. The record pins a step-opened task to the run's origin version (decision 5), so the roommate works the primary's machine with its own persona; the record does not say so, and turn-level delegation (`backend/lambda/src/lib/delegation.ts`, on a fall-through to `general` only) is not a step a workflow can take. Decided 2026-11-06, replacing the 2026-11-05 choice of the run's version: the task runs the machine from the active version of the assistant holding the role, so its steps offer only that assistant's tools (tenet D1) and that assistant's team owns how the work is done; the run's workflow names the machine and continues on the task's ending. Built 2026-11-06 under the ownership tenet (WT118): the role assistant's own run of the intent opens the task on its served version, so the asking run never resolves that version.
- G6: urgency and category become terminal state names, so adding a category is a machine edit and a new edition; urgency and category together (high billing, low outage) multiply the endings.
- The acyclic run: a requester who says "not resolved" cannot return the run to the routing steps behind it, so the graph tells the lead (`reopened`) rather than paging again.

### A.9 Drift detection: a subject changes (existing behavior, proposed event trigger)

A person changes the subject mid-conversation. The platform notices, offers to continue the new subject in a conversation of its own or in a related one every member can already reach, and acts on the answer. On a move, the new conversation opens knowing what it is for, and the subject leaves the original conversation's context; on a decline, the subject becomes one of this conversation's own and the question the offer held is answered first (SPEC-DRIFT-CONVERGENCE, FR1 to FR26). Today this is a fixed flow inside the router (`runLiveDriftFlow`, `backend/lambda/src/lib/live-drift-flow.ts`), behind `enableLiveDrift` in Aurora mode, gated per conversation type by `driftEnabled` (`ops` declares it off, `live-drift-flow.ts:431`). Drift as a workflow event lets a team decide what happens when the subject changes (SPEC-WORKFLOWS-AND-TASKS WT88).

**What stays the platform's.** Detection is not a workflow step and is not editable, for the reasons decision 3 gives a platform machine:

- **The signal.** The nearest cosine distance to the conversation's anchors, the threshold, the skip conditions and the active-task suppression (FR1 to FR5, FR10). It is deterministic and embedding-based, so no team edit can put a phrase match into it (tenet D11).
- **The scope.** The related-conversation search is scoped to the intersection of every human member's memberships and the serving assistant's, computed live from Amazon Chime SDK and applied inside the query (FR8, FR9). The scope is the access control, so a workflow receives a rival conversation already scoped and can never widen it.
- **The offer's lifecycle.** Answered only by a message sent after it (FR12), held durably rather than in Amazon Lex session state (FR13), held while a duel runs (FR19).
- **The move.** A move declares `moves` on the acting reply and the link, and the next turn's history and the next summary are built without the moved exchange (FR26, `backend/lambda/src/lib/moved-subject.ts`). This is the guarantee that the original conversation's context is correct after a move, so it is the platform's act on the step, never a template's text.
- **The record.** Every offer reaches a terminal outcome on `drift_events` with `outcome_at`, settled by the abandonment detector where nothing signals (FR25; tenet D6: the absence of an event is time-based).

**What a team decides** is the response: whether to offer at all, what the offer says, where a moved subject goes, who comes with it, which context it carries, and what the room is told.

The shipped default, which reproduces today's flow:

```yaml
subject-changed:
  on: subject-changed                  # GAP G25: not in EVENT_WORKFLOW_EVENTS; raised by detection on the turn, and its first step answers that turn
  types: [general]
  initial: offer
  states:
    offer:
      task:
        machine: drift_offer           # GAP G26: a platform machine (decision 3); today a conversation_creation_tasks row
        for: requester                 # the person whose message changed the subject
        visibility: private          # the offer reaches only the sender, as today
        deadline: { afterMinutes: 30 } # today's offer lifetime; the abandonment detector settles it `abandoned` at 24 hours
      onSuccess:
        - { to: move,     when: { task:state: move,     event:suggestedAction: confirm } }   # GAP G6: a condition on event data
        - { to: continue, when: { task:state: move,     event:suggestedAction: redirect } }
        - { to: done }                 # keep: adopted as this conversation's subject, the held question answered (platform)
      onDeadline: done
      onFailure: done
    move:
      open:                            # GAP G27: a step that opens a conversation
        type: general                  # today's split is always the ordinary type (channel-creation.ts:472)
        classification: parent         # fixed: the parent's, which IAM gates the new channel on
        members: [requester]           # today: the sender and the assistant only
        carry: [subject, quote, parent-link]   # priorSubject, priorMessage and parentRef in the channel context store
        mode: move                     # the platform declares `moves`; `split` is today's split, which declares none
      onSuccess: done                  # the new conversation's own assistant-joined workflow (A.1) welcomes it with what was carried
      onFailure: done                  # the offer stays open and the message is answered, as today
    continue:
      go: { to: 'event:rivalConversation', mode: move }   # GAP G27: navigate to a conversation the scope already proved
      onSuccess: done
      onFailure: done
    done: { disposition: success }

drift_offer:                           # platform, fixed
  initial: offered
  states:
    offered:
      transitions: [move, keep]
      awaits: { party: requester }
      choices: [move, keep]
      resolvedByOneResponse: true      # any later message settles it; one that is not an answer is `keep` and is answered
      template: drift-offer            # or drift-redirect-offer, by the event's suggestedAction
    move: { transitions: [], terminal: success }
    keep: { transitions: [], terminal: success }
```

A team's edit, for a team room where several people work together and drift often means "this needs its own thread with the same people":

```yaml
subject-changed:
  on: subject-changed
  types: [team]
  initial: route
  states:
    route:
      decide:                                           # GAP G6: no step branches on event data alone
        - { to: incident, when: { event:intent: incident_report } }   # the classified intent of the drifting message, recorded as data
        - { to: offer }
    offer:
      task: { machine: drift_offer, for: requester, visibility: private, deadline: { afterMinutes: 30 } }
      onSuccess: [{ to: move, when: { task:state: move } }, { to: done }]
      onDeadline: done
    move:
      open:
        type: team
        classification: parent
        members: room                                   # GAP G29: the people in the room; withheld on a private message (decision 8)
        carry: [subject, quote, parent-link, 'task:requirements']   # GAP G28: a live task's recorded needs, by reference
        mode: move
      onSuccess: tell-room
      onFailure: done
    tell-room:
      send: { to: room, template: subject-moved }       # the durable link exists (topicMovedLink); the team's own words around it
      onSuccess: done
      onFailure: done
    incident:
      open:
        type: ops                                       # its conversation-opened workflow is the ops room (A.2): an event chain, nothing new
        classification: parent
        members: [requester]
        carry: [subject, quote, parent-link]
        mode: split                                     # the incident is also still this room's business: a split, not a move
      onSuccess: done
      onFailure: offer
    done: { disposition: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | Detection already writes `drift_events` (distance, confidence, intent, outcome, `outcome_at`, correlation id) and EMF per stage, and each turn's subject decision rides its analytics record (FR16, FR23, FR25). The run adds `workflow_name` and `workflow_origin_hash` (decision 6), so offer accuracy and take-up (FR17, FR18) can be compared per workflow edition. Two outcomes have no value today: a workflow that records without offering, and a move made without asking (`drift_events.outcome` allows four values) (G30). No counter is added: the outcome row is the fact (tenet D7) |
| Requirements to move forward | Detection's own gates are code (the threshold, the skips, the live-task suppression). The offer's answer is the requester's choice on the card, or one later message the model resolves (`resolvedByOneResponse`); today it is `classifyConfirmDeclineReply`, an English pattern list (`backend/lambda/src/lib/routing-state.ts:27`) that fails safe toward keeping the subject (G26). The move is refused while a duel runs (FR19) |
| Ownership | The workflow is the version's, owned by the assistant's team. The offer task is the requester's, held by them. The new conversation is created by the service admin, never the assistant (`createConversationFromDrift`, `backend/lambda/src/lib/channel-creation.ts:452`), in the parent's classification; a team chooses its type and who comes, within what the parent's members already saw |
| Parallel | None. The offer is one wait; the move is one act |
| Task list | The offer lists in the requester's open work for its 30 minutes, which it does not today, because a `conversation_creation_tasks` row is not a task. A one-message decision that the next message settles may be better kept out of the list (G26) |

**Passing context to the new conversation.** Today the new conversation receives three things, all in the channel context store rather than member-writable channel `Metadata`: the subject (`priorSubject`), the person's own message quoted (`priorMessage`), and the link back to the message it came from (`parentRef`); and its first summary is seeded from the subject (`drift-spawn`), so drift works there from its first message (Appendix B of SPEC-DRIFT-CONVERGENCE). The welcome composer renders them through the new conversation's own welcome, so the context arrives through A.1's workflow with no new mechanism. What a team may add is G28. **Recommendation:** carry by reference, never by copy. A live task's recorded needs, the parent's current summary and its conversation variables are read from the parent at the child's turn, under the same classification, through `parentRef`; the quoted message is already the one copy, and it is the open erasure gap (FR15), so a workflow may not add a second.

**Managing the current conversation's context.** `mode: move` is today's move: the moved exchange stays readable as the record and leaves the model's history and the summary. `mode: split` is today's split: the link is posted with no `moves`, and the subject stays. A decline adopts the subject so it is never offered again (FR6) and answers the held question first (FR24). All three are platform acts the step names, because a team's template cannot carry the turn declaration that drives them (`backend/lambda/src/lib/turn-declaration.ts`).

**Where the model breaks:**

- G25, the event. Drift is not an event, and its fired offer is the turn's whole reply: the agent flow never runs (Appendix D of the spec). As a trigger it must be raised synchronously on the turn, before intent dispatch, and its workflow's first step must answer that turn, or the turn has two responders. ADR-041's one responder per turn decides it: the drift run answers, and the intent is not dispatched on that turn. A workflow that records only and offers nothing must then hand the turn back to dispatch in the same invocation.
- G26, the offer is not a task, and its answer is a phrase match. The open offer is a `conversation_creation_tasks` row, and "yes" is recognized by an English pattern list, which is the shape tenet D11 rules out. It fails safe (an unrecognized yes keeps the subject here, and the person can ask outright through the explicit-routing path), but the exception is not stated where an operator finds it. **Recommendation:** a platform `drift_offer` machine with choices `move` and `keep` on a card, a typed reply resolved by the model once as data, and "anything that is not an answer is `keep`" kept as the machine's rule.
- G27, a step that opens or goes to a conversation. No run step creates a conversation or navigates to one. The step must keep today's constraints: the service admin creates it, the classification is the parent's, the type is one the classification serves, and a rival comes only from the platform's scoped search.
- G28, carrying more context. Only the three context-store fields cross today. A carry list over the parent's recorded data (task requirements, variables, the summary) needs a read-by-reference rule so a redaction in the parent reaches the child.
- G29, who comes along. Today only the sender joins the new conversation, even from a room of several people. `members: room` is a disclosure decision: on a message the room saw, nothing new is disclosed; on a private (targeted) message it is withheld, by decision 8's audience rule.
- G30, outcomes. `drift_events.outcome` has four values (`declined`, `accepted`, `abandoned`, `rejected_in_new_channel`), and the accuracy measure (FR17, FR18) assumes every fired detection was offered. A workflow that offers nothing, or moves without asking, needs its own outcome value, or the accuracy rate reads those as unanswered offers.
- G31, a live task. Any live task suppresses detection (FR10), so `subject-changed` never fires mid-task, and a new subject raised while a report is in progress is answered inside the report's turn. The two-axis rule (Appendix D of the spec) is the target; until it is built, the event is not raised while a task is live, and moving a live task to the new conversation is out of scope (a task belongs to its conversation, decision 8).
- G6 again: `event:suggestedAction` and `event:intent` are event data, which no edge condition reads today.

### A.10 A service appointment across people, a phone, a ticket and a new conversation (new, direct and indirect)

A customer and the assistant start in a conversation: the appliance is broken, triage does not fix it, and a visit is needed. The field-service tool assigns a technician, who is added to the conversation by phone: the customer and the technician text and call each other through the deployment's number, each seeing only that number, and every text and call transcript lands in the conversation under its speaker's name (SPEC-TELEPHONY, the delivery worked example). After the visit the technician finds a fault that needs the support team. Once the technician approves the handoff, a support ticket is opened in the ticketing system, and the team's choice decides what happens next: the assigned support agent is added to this conversation, or a new support conversation opens carrying some of this one's context.

```yaml
service_appointment:
  on: { intent: service_call }
  types: [customer-service]                      # declares the technician and support_agent roles (G20)
  initial: triage
  states:
    triage:
      task: { machine: service_call, for: requester }                 # direct: the customer and the assistant
      onSuccess: [{ to: order, when: { task:state: needs_visit } }, { to: done }]
      onFailure: done
    order:
      action: { tool: fsm_create_work_order, args: { symptom: 'requirement:what is going wrong' } }   # GAP G7: outbound; records the ExternalRef
      onSuccess: assigned
      onFailure: done
    assigned:
      wait: { event: fsm.technician-assigned, deadline: { afterMinutes: 1440 } }   # indirect: the dispatcher works in the tool (G33)
      onSuccess: add-technician
      onDeadline: done
    add-technician:
      add: { participantRole: technician, person: 'event:assignee', transport: phone }   # GAP G32, GAP G37: direct, by text and call through the deployment's number
      onSuccess: visit
      onFailure: done
    visit:
      task:
        machine: technician_visit
        for: requester
        by: { participantRole: technician }
        visibility: conversation
        deadline: { afterMinutes: 43200 }
      onSuccess: [{ to: handoff, when: { task:state: needs_support } }, { to: done }]
      onFailure: done
    handoff:
      task:
        machine: approval
        for: requester
        by: { participantRole: technician }      # direct, by text: no card reaches a phone, so the reply is resolved once as data (G37)
        deadline: { afterMinutes: 1440 }
      onSuccess: [{ to: ticket, when: { task:state: approved } }, { to: done }]
      onDeadline: done
      onFailure: done
    ticket:
      action: { tool: ticketing_create, args: { summary: 'requirement:what is going wrong', parts: 'requirement:the parts needed and their cost' } }   # GAP G7
      onSuccess: ticket-assigned
      onFailure: done
    ticket-assigned:
      wait: { event: ticketing.assigned, deadline: { afterMinutes: 480 } }   # indirect: the ticketing system chooses the agent
      onSuccess: [{ to: add-agent, when: { workflow:option: same-conversation } }, { to: new-conversation }]   # GAP G6: the team's declared option
      onDeadline: done
    add-agent:
      add: { participantRole: support_agent, person: 'event:assignee' }   # direct from here on: the agent works in this conversation
      onSuccess: resolved
      onFailure: new-conversation
    new-conversation:
      open:                                       # A.9's step (G27): the same step drift uses
        type: support
        classification: parent
        members: [requester, 'event:assignee']    # the customer and the agent the ticket named; the technician is not carried (G29)
        carry: [subject, parent-link, 'task:requirements', 'external:ticket']   # some of the context, by reference (G28)
        mode: split                               # the appointment stays this conversation's record
      onSuccess: resolved
      onFailure: done
    resolved:
      wait: { event: ticketing.resolved, deadline: { afterMinutes: 20160 } }   # indirect: the agent may close it in the ticketing tool
      onSuccess: done
      onDeadline: done
    done: { disposition: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | One run, three tasks, and four inbound events, each a fact the archive must record with the step it moved (G14); time from approval to an agent and the share of handoffs that open a new conversation are queries over those facts. The new conversation records `parentRef`, so its own runs join back to this one by reference, not by a copied id (G36) |
| Requirements to move forward | Direct: the customer's needs and choices, the technician's visit states and the handoff approval (answered by text, resolved by the model and recorded). Indirect: assignment, ticket assignment and ticket resolution, each an inbound event allowed only on a declared step. The team's option between the two paths is a declared value, not a judgment |
| Ownership | Workflow: the assistant's team. Who visits and who supports are the field-service tool's and the ticketing system's choices. The technician and the agent are direct participants once added, each the holder of one role; the dispatcher and the agent closing the ticket in the tool are indirect, named on the events that record their moves (G35) |
| Parallel | None needed |
| Task list | The customer's needs while they await them; the technician's visit and the handoff approval, which reach the technician by text, not in a list they never open (G37); nothing for the dispatcher or for a support agent who works only in the ticketing tool, whose own queue holds the ticket |

**Where the model breaks:**

- G37, a direct participant by phone. The technician is a member reached by text and call; `provideComms`, the Twilio connector and `IngressApi` are **NOT BUILT** (SPEC-TELEPHONY), and a card choice has no form on a phone, so an awaited choice must also be answerable by a reply the model resolves once as data, never by matching "yes" (A.9, G26). Every text is a message template that may carry the full text or a reference link, the one named exception to "only a reference leaves the platform" (decided 2026-11-05).
- G36, a run across conversations. The run lives in the appointment's conversation; `new-conversation` hands the rest to a conversation of another type with its own assistant and its own runs. The ticket's resolution arrives for this run, while the work happens in the new conversation. **Recommendation:** an `open` step ends the run's interest in the work there, unless it declares a wait on an event that names the run's external reference; the new conversation's runs carry `parentRef`, and nothing moves a task between conversations (decision 8).
- G28 and G29, as in A.9: what crosses is chosen by the team, read by reference, and the people carried are the ones the work names.
- G6: the team's choice between adding the agent and opening a new conversation is a declared value the edge reads, which no condition source holds today.
- G7, G32 and G33, as in A.6 to A.8.

### A.11 Sign-off on an external statement by a reviewer who never uses chat (new, indirect approval)

A person asks the assistant for a public statement. The assistant drafts it with them in the conversation. Legal must sign off before it goes out, and the legal team works in its own review app: it never joins the conversation. The workflow sends the draft to that app, the app's reviewer approves or rejects with a reason there, and the decision returns as an event naming the reviewer. An approved statement is published; a rejected one returns to the requester with the reason.

```yaml
external_statement:
  on: { intent: external_statement }
  initial: draft
  states:
    draft:
      task: { machine: statement_draft, for: requester }   # direct: the requester and the assistant; produces: document, no reopens
      onSuccess: [{ to: legal, when: { task:state: ready } }, { to: done }]
      onFailure: done
    legal:
      task:
        machine: approval                        # the platform's machine, one decision (decision 3)
        for: requester
        by: { indirect: legal_review }           # GAP G34: an indirect worker; the connector, not a member, answers
        deadline: { afterMinutes: 2880 }
        send: { document: 'task:draft.document' }   # GAP G38: outbound to the deployment's own app; carries a reference, never the text
      onSuccess: [{ to: publish, when: { task:state: approved } }, { to: revise }]
      onDeadline: tell-lapsed
      onFailure: tell-lapsed
    publish:
      action: { tool: cms_publish, args: { document: 'task:draft.document' } }   # GAP G7: a consequential write, confirmed by the approval
      onSuccess: tell-published
      onFailure: tell-failed
    revise:
      send: { to: requester, template: statement-rejected, with: { reason: 'event:reason' } }   # GAP G16, GAP G18: the reason arrives as event data
      onSuccess: done
      onFailure: done
    tell-published: { send: { to: requester, template: statement-published }, onSuccess: done, onFailure: done }   # GAP G18
    tell-lapsed:    { send: { to: requester, template: statement-unreviewed }, onSuccess: done, onFailure: done }  # GAP G18
    tell-failed:    { send: { to: requester, template: statement-not-published }, onSuccess: done, onFailure: done }   # GAP G18
    done: { disposition: success }
```

| Consideration | How the example lands |
|---|---|
| Analytics and versions | The approval's settlement is an inbound event, so time to sign-off and the rejection rate are facts only if the event is archived with the step it moved (G14). A rejection's reason is the review app's record; the platform stores it by reference, or as the event's own field if the requester is to read it |
| Requirements to move forward | Direct: the draft's needs and its `produces: document`. Indirect: the approval, an inbound event carrying `approved` or `rejected`, the reviewer and a reason, accepted only on the declared `approval` edges and only from the declared connector. Publishing is a consequential write whose confirmation is the approval itself |
| Ownership | The run and the draft are the assistant's team's and the requester's. Who reviews is the legal team's app's choice. The reviewer is a person of the deployment: the event names them, the receiver resolves them through `Identities` and admits them at the conversation's classification, and the approval records them as the one who decided (G35). A reviewer who could not be admitted cannot approve |
| Parallel | None needed. Two reviewers (legal and communications) is two approvals in sequence, or the review app's own parallel review behind one event |
| Task list | The requester's draft while it awaits them, then nothing: the approval waits on an indirect worker and lists for nobody in the platform. The reviewer sees it in the review app's own queue |

**Where the model breaks:**

- G34, an indirect worker. `by` names a person, a participant role or an assistant role, all of them direct; `awaits` names `requester` or `worker`; and `NOT_ASSIGNEE` refuses any card press but the holder's. **Recommendation:** `by: { indirect: <connector> }` makes the connector the task's worker, holds the task for nobody in the platform, and lets only an inbound event of that connector take its declared edges. This is the third awaited party G1 asked about, in the form the owner's model needs.
- G35, who decided. A move taken by an inbound event records the person the event named, resolved and admitted, as the actor on the task's transition and in the audit; an event naming nobody admitted is recorded as the connector's and cannot settle an approval that requires a person. Today the receiver counts the people it could not admit, and no transition record names an indirect actor.
- G38, the deployment's own app as a connector. The registry accepts only built vendors (PagerDuty, Salesforce), so a business's internal review app has no way in. **Recommendation:** a first-party connector over the deployment's own EventBridge bus: a declared source, a declared event schema naming the run's external reference, the decision and the person by their identity provider subject, and the same replay record, resolution and admission as a vendor's. One registry entry, no adapter code beyond the schema.
- What leaves the platform. The outbound event carries a reference to the draft. The reviewer opens it by signing in through the identity provider and reads it as themselves, so a reviewer without the classification cannot read it (tenet D1). A copy of the text in the review app would be a second store the redaction path cannot reach. Every outbound event carries a reference (decision 8), and a private run sends none (G10).
- G16: the rejection's reason comes back as event data, which the requester reads; no platform form machine is needed for a reason written in another tool.

### A.12 What the examples show

The existing workflows fit. The welcome, `image_generation` and `account_brief` are a pure run or the canonical case and need nothing new; the ops room fits with its declared automatic move (G39); the approved report fits on the shipped machine, its later steps running once. The two levels, the one writer per task and the run's observation of endings hold in every example, and none of the three new workflows needs rule B or rule C. Drift detection (A.9) fits as an event workflow once detection raises an event: the signal, the scope, the offer's lifecycle, the move and the outcome record stay the platform's, and the team's part is the response.

The new workflows reach the edges of the model, and the gaps cluster. None of them asks the platform to assign work: under decision 8 the dispatch system, the field-service tool, the ticketing system and the pager choose who does the work, and what the platform lacks is the events in and out and the step that adds the person those tools name.

**Missing step kinds.**

- G4, a time a step waits for: a run-level delay (a survey after two days, a reminder before a visit) and a per-state time inside a task (an appointment, a delivery window), each a one-shot schedule like `handleTaskDeadlineFired`, never a poll (tenet D6). **Recommendation:** a run-level `wait: { afterMinutes }` step and a state-level `after: { minutes, to }` edge, both on the existing scheduler. Decided 2026-11-05 (stage 5).
- G19, a notice on entry: a task state entered on a card press runs no assistant turn, so the requester is not told the parcel is out or the technician is booked. Decision 2's table lists "a task step's entry action" as a send, and only `deliver_document` exists. **Recommendation:** a state-level `notify: { to: requester | worker, template }` that the task service sends on entry through the targeted send the task-assigned message already uses (ADR-063 decision 2). Proposed for stage 5.
- G16, a written answer: decision 2 already names this platform machine as **NOT BUILT**; the report's decline reason, the survey's comment and a failure reason all need it. Decided 2026-11-05 as the platform form machine (stage 5).
- G22, a run's model turn taking an existing task as its subject: `incident-watch` cannot resolve the first look. **Recommendation:** a model-turn step that names a live task of the conversation by machine as its turn's subject, so the move stays the model's `advance_task_state` and rule A holds. Later.
- A run cancel (OPEN 13, decided) is exercised by A.6's customer cancel.
- G27, a step that opens a conversation or goes to one (A.9). **Recommendation:** an `open` step over `createConversationCore` with the service admin as creator, the parent's classification, a declared type, members drawn only from the people the triggering message reached (G29), and `mode: move | split` naming the platform's existing move and split; a `go` step only to a conversation the platform's scoped search returned. With G25, this is what drift as a workflow event needs.
- G32, a step that adds the person an outside tool names (A.6 to A.8). **Recommendation:** an `add` step that takes a person from an inbound event, resolves them to a user of the deployment (signed in through its identity provider), refuses anyone outside the conversation's classification, and makes them the holder of a participant role the conversation type declares, recorded like an invitation's redemption. The platform never chooses the person.

**Missing fields.**

- G20, `types` on an intent trigger. `by` or `for` naming a participant role requires declared types (`backend/lambda/src/lib/task-step.ts:141`), and an intent fires in any conversation type the assistant serves. **Recommendation:** an intent workflow declares `types`; in a conversation of another type the canonical workflow runs instead, stated in decision 1. **Stage 3 prerequisite**: stage 3's own e2e asks the room's lead to approve.
- G17 and G18, the requester as worker and as audience. `for: requester` is decision 1's; `by: requester` (a confirmation the requester gives on a card, since `approval` and `acknowledgement` await the worker) and `to: requester` (a send) are used by every new example and defined nowhere. **Recommendation:** add `requester` to `TaskPerson` and to `EventAudience` on intent triggers only, resolved from the task row's `userArn` (the Security posture's continuation rule). Stage 3.
- G5, a deadline that escalates without canceling, and an absolute deadline read from a recorded value. **Recommendation:** a deadline that takes `onDeadline` while the task stays live, with its effect on the run stated (the run continues past a live task, which is `continue: opened` semantics). Decided 2026-11-05 as three kinds, due, remind and timeout (stage 5); it amends ADR-063 F1.
- G6, a condition over a recorded value. Edge conditions read platform sources (`backend/lambda/src/lib/variables.ts`) and `task:state`; urgency, category, warranty and attempt counts become terminal state names or the model's choice. Terminal names as the branch are workable and keep tenet D11; a typed recorded value (OPEN 12, option (c)) and an entry count would make the code-checkable facts checkable by code. Decided 2026-11-05 (OPEN 12, stage 5).
- G8, which party may cause a move. `choices` say what the holder may press and `reopens` what the requester may ask for; a reschedule or a cancel by the requester while the worker holds the task has neither. **Recommendation:** decision 7 states whether a requester's message binds to a task another person holds (FR14), and if it does, which edges its turn may take. A stage 3 statement; the build is later.
- G21, where `continue:` lives (`TASK_STEP_FIELDS` refuses an unknown field), and G23, a create-task step's failure outcome that does not tell "no worker in the room" from a failed task: both are stage 2 specification fixes for the ops room.
- G24, a decision card that carries what is decided (a quote's amount): the card carries the approval task's label and a reference. Decided 2026-11-05 with the form machine (OPEN 12, stage 5).
- G28 and G29, what a moved subject carries and who comes with it (A.9): carried context is read from the parent by reference, never copied, so a redaction in the parent reaches the child; members follow the triggering message's audience.

**Parallelism.** None of the eleven examples needs two run steps at once. A send followed by a wait covers "notify, then wait for acknowledgement"; loops and multi-party back-and-forth live inside one task. The one fan-out the examples raise, "page every on-call engineer and continue on the first acknowledgement", is the pager's own escalation policy, not the workflow's. **Recommendation:** decision 9's option (a) holds for stages 1 to 4. No example needs `continue: opened` on an intent trigger, so refusing it there (G43) costs nothing.

**Events in and out.** Every new example needs a system outside the platform: a dispatch system, a field-service and parts system, a warranty lookup, a ticketing system, an on-call pager. That is the integration model decision 8 states, and it has two halves.

- G7, the outbound event. A task state's `action` may run a registered context or connector tool (`isActionTool`, `backend/lambda/src/lib/task-state-machines.ts:1863`), so the step shape exists inside a task; a run-level step may not, and only one mock connector is registered. **Recommendation:** each connector is one adapter and one registry entry; a run-level `action` may run one; a connector action that changes state outside (create a job, book a slot, page) runs only after a person confirmed what it sends, through a `choices` state or a `confirm` brief, as `propose` is at run level today.
- G33, the inbound event. The verification half is built: the connector receiver takes a vendor's event from its EventBridge partner event bus, refuses a foreign source, deduplicates by the vendor's event id and publishes an `ae.connector` fact naming the admitted people (SPEC-CONNECTORS). Nothing consumes the fact. **Recommendation:** the `ae.connector` fact is the inbound event, consumed by one rule that names the run or task by the `ExternalRef` the outbound event recorded, and takes only a transition the machine declares under `on:` or completes a run's `wait: { event }` step (the SPEC-TASK-STATE-TRANSITIONS conditions for a runtime advancer). A fact for no live run may start one, which is the incident use case SPEC-CONVERSATION-TYPES names ("an alert opens the room"). The PagerDuty adapter is enough to prove it (A.8). It is the next record after this one, and it gates A.6 to A.8; stages 1 to 4 do not include it.
- G32, the person an outside tool names, is a step kind (above). Resolution and admission are built (SPEC-CONNECTORS K1, K4), so the step adds only a person the fact already names as admitted; an unresolved person waits on the connector-issued invitation SPEC-CONNECTORS lists as **NOT BUILT**. The platform keeps no roster of who is available.

**Ownership.**

- G1, a third party: `awaits` names `requester` or `worker`. A driver or a technician who acts on the card is added as the role's holder (G32); one who acts in their own tool is an indirect worker, which is G34.

**Direct and indirect participants (decision 8; A.10, A.11).** Both kinds act on the same tasks through the same declared edges, and differ only in the channel the move arrives on.

- G34, an indirect worker: `by: { indirect: <connector> }` makes a connector the worker, holds the task for nobody in the platform, and lets only that connector's inbound event take its declared edges. It replaces a third awaited party.
- G35, who decided: a move an inbound event takes records the person the event names, resolved through `Identities` and admitted at the classification, as its actor in the transition and the audit; an event naming nobody admitted cannot settle an approval that requires a person.
- G36, a run whose work continues in another conversation: an `open` step ends the run's interest there unless it declares a wait on the work's external reference; nothing moves a task between conversations.
- G37, a direct participant by phone: a member reached through the deployment's number (SPEC-TELEPHONY, **NOT BUILT**) answers an awaited choice by a reply the model resolves once as data, because no card reaches a phone.
- G38, the deployment's own app as a connector: a first-party connector over the deployment's own EventBridge bus with a declared event schema, and the vendor path's replay record, resolution and admission.
- **What leaves the platform** is a reference, never a copy: an indirect person who opens it signs in through the identity provider and reads as themselves, so the classification boundary and the redaction path hold for them as for a member.
- G2 and G3, pools, team queues and tasks in another conversation, are **not gaps**: decision 8 leaves assignment and routing to the deployment's own tools. A workflow's people are members of its conversation, one per role, and the tool chooses which person.
- G11, which version a role's task runs. Decided 2026-11-06: the active version of the assistant holding the role; stage 3.
- G15: continue before trigger sends a person's new message to their held task's turn, where the model judges whether it is about the task; long-lived tasks (a receipt, a survey, a rescheduled attempt) make a new request mid-task common. Decided 2026-11-05: a new request for a different multi-step intent opens its own task while the first keeps waiting.

**Analytics.**

- G13: a run that creates several tasks over several machines has one workflow hash and a machine hash per task. **Recommendation:** decision 6 names the run's edition as the workflow hash and each task's edition as its own `task_origin_machine_hash` (already on every task turn), never a single pair. A stage 3 text change.
- G30: `drift_events` outcomes assume every detection was offered; a drift workflow that records only, or moves without asking, needs its own outcome value so the accuracy and take-up rates (SPEC-DRIFT-CONVERGENCE FR17) keep their populations.
- G14: in the new examples most waits settle on a card, a deadline or an inbound event, so the measures teams care about (time to accept, first-visit fix, survey score, how often a page went unacknowledged) have no archive fact. The outside tool keeps its own figures; the platform records only the events it received and the moves they took. One archive record per settlement no assistant turn records, through the existing archive path, never a counter, is a **stage 3 prerequisite** (decided 2026-11-05).
- G12, run length: the run record's seven-day TTL and the 30-day task bound are short for service work; decided 2026-11-05: a run record outlives the sum of its remaining waits, at most 45 days, holding references only.
- Version tracking holds otherwise: every example's edits land on exactly one hash, workflow or machine, as decision 6 intends.

**Drift's own gaps.** G25 (the event, raised on the turn and answering it), G26 (the offer as a platform machine, replacing an English pattern list that tenet D11 rules out), G27 to G29 (open or go to a conversation, carry context by reference, members by audience), G30 (outcomes) and G31 (no event while a task is live, until the two-axis rule exists). G26's first half is built: the reply is the classifier model's reading (SPEC-WORKFLOWS-AND-TASKS WT87), and deployed dev runs the pattern list until it deploys.

**The task list.** Decision 10's table holds for every example, with four additions: work that waits on an outside tool or an indirect worker lists for nobody, and the tool's own queue is where its people see it (A.6 to A.8, A.11), while a direct participant by phone is reached by text rather than by a list (A.10); a requester sees nothing in "waiting on you" while another person holds their work (correct; the conversation's task reference is where they see it move); a task that awaits nobody and was created without an owner lists in the requester's open work while it is live (A.5); and a queued request lists as a `queued_request` row, not as the work it becomes (A.8, G9).

**What stage 1 can carry.** The console changes nothing at runtime, so no gap above is closed in stage 1. Stage 1 can draw what the examples need to be honest about: a participant role in an intent entry marked as needing declared types (G20), a create-task step's deadline shown as canceling the task (G5), and a run-level step after a machine that reopens drawn as running once, at the first settlement (A.3, A.4).

**Further gaps the examples confirm.**

| Gap | What the examples add |
|---|---|
| G39, the ops room's first look could stall | Confirmed by A.2; a team's `requiresTool` makes a missed advance likelier. Decided 2026-11-05: the machine declares its automatic move as data, which survives a team edit |
| G40, a kept welcome could run | A.1 needs the unused welcome kept outside `eventWorkflows`; decided with stage 1 |
| G41, an intent with no declared workflow | A.3 and A.5 rely on the canonical rule and A.6 to A.8 declare their own; with G20, an intent workflow in a conversation type it does not declare runs the canonical workflow |
| G14, settlements unmeasured | Every new example; a stage 3 prerequisite |
| G43, `continue: opened` on an intent | No example needs it; refused on intent triggers |
| G44, a team machine two workflows reuse | `approval` and `acknowledgement` are reused across A.4, A.6, A.7 and A.8 and are the platform's, so read-only; a team machine two workflows reuse carries one machine hash, and each workflow's edition is its own |
| G42, the reopen rule for event workflows | An event workflow opening `report_generation` follows the same rule as A.4: its later steps run once, and a reopen raises `task-reopened` |
| G21, `continue` and the deadline | A.2 needs both named in stage 2 |
