# Workflow step reference

Every node a workflow is built from, with what it takes in and what it puts out. A workflow has two levels ([DESIGN-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/DESIGN-WORKFLOWS-AND-TASKS.md) section 2): the **run**, a graph of steps started by a trigger, and the **task**, a state machine one task step opens. Both are stored on an assistant's version as JSON and drawn in the admin console's workflow builder. The requirements behind each node are in [SPEC-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/SPEC-WORKFLOWS-AND-TASKS.md).

Three rules hold for every node:

- **References, never ids.** A node names people by reference (`requester`, `subject`, a participant role) and the run resolves each when the step runs. A stored workflow carries no principal id.
- **Once.** Each step is claimed before it acts, so a redelivered event or continuation repeats nothing.
- **Bounded.** One run takes at most 16 steps.

## 1. Triggers: what starts a run

A run starts on one trigger. Its inputs are the values the router verifies before anything runs. Steps read them as sources (`event:person`, `event:alarmState`) in template fields, mentions and conditions.

| Trigger | Declared in | Fires when | Inputs the run receives | Person it names |
|---|---|---|---|---|
| `intent` | `intentWorkflows`, keyed by the intent. Every multi-step intent declares one, which opens the request's own task; a single-turn intent may declare one that opens no task of the request's own | A person's message is classified with that intent. A queued request starts its run when its sender accepts it, and a request a task's turn opens mid-task (`open_new_request`) when it is opened | The requester (the person who asked), the turn's correlation id, the conversation | `requester` |
| `assistant-joined` | `eventWorkflows` | The assistant is added to a conversation (the welcome) | The conversation and its type, and `subject` where the conversation was opened for one person | None as `event:person` |
| `conversation-opened` | `eventWorkflows`, with `types` | A conversation of a declared type is opened | `event:person`: the person the opening request named | `event:person` |
| `person-joined` | `eventWorkflows` | A person is added, verified a member by a live read | `event:person`: the person added | `joined`, `event:person` |
| `invitation-sent` | `eventWorkflows` | An invitation is issued | `event:person` and `invitation:invitee` (the invitee), `invitation:inviter`, `invitation:reason`, `invitation:role` | `event:person`, `invitation:inviter` |
| `invitation-unredeemed` | `eventWorkflows`, with `deadline: { afterMinutes }` | The invitation is still pending when its deadline fires | The same as `invitation-sent` | `event:person`, `invitation:inviter` |
| `alarm-state-changed` | `eventWorkflows` | The CloudWatch alarm the conversation watches changes state | `event:alarmName`, `event:alarmState` (`ALARM`, `OK`, `INSUFFICIENT_DATA`), read back from CloudWatch | Nobody |
| `event-received` | `eventWorkflows`, with `types` naming one team room type | An EventBridge event matches a trigger the console attached to that team room (see [Event triggers and their limits](#event-triggers-and-their-limits)) | `event:source`, `event:detailType`, `event:resource` (the event's first resource), `label` (the resource's short name). Never the event's `detail` | None |
| `task-reopened` | `eventWorkflows` | A finished task is taken back into a state with a way on | The reopened task and which reopen it is, and the values of the run it was reopened from | `requester`, `event:person` (the task's requester) |

Every trigger also gives the run the values the router holds: the conversation's classification, the conversation's type and the version's variables.

A run's own key makes it once per occurrence. For an intent that key is `intent#<correlation id>#<assistant>`, for a reopen it is `reopen-<task>-<n>`, and for any other trigger it is the event's natural key.

**Output of every run**: one `AE_RUN_ENDED` record in the conversation archive when it reaches an end step. The record carries the run key, the workflow, the trigger, the ending, its steps by name and outcome, and the version, never message text. Every message the run says also carries the workflow name, step, run key, origin version and workflow hash on the archive and the Aurora projection. Effectiveness reads both, per workflow edition.

## 2. Run-level steps

Each step is one node with outgoing edges. A step takes exactly one of the kinds below, plus the shared fields in section 3.

### `send`: a platform message

Says a message template as the run's assistant with no model call.

| Inputs | |
|---|---|
| `to` | `room`, `subject`, `joined`, `requester` (intent runs), `{ people: 'event:person' }`, `{ people: 'invitation:inviter' }` or `{ participantRole: '<name>' }` |
| `template` | A message template: the assistant's own, else the classification's, else the shipped one |
| `mention` | Optional. A template field mapped to `event:person`, `subject`, `invitation:inviter` or `participantRole:<name>`. Each renders the display name, inert |
| `fromRole` | Optional `'template'`. Says the template the addressed person's participant role confers, and `template` where none does |
| `in` | Optional `'opener'`, on a `conversation-opened` workflow, with `to: 'room'` and no `mention` or `fromRole`. Says it in the conversation that opened this one, found by the parent link this conversation's row records, at the same classification and not archived, with this conversation's link as `conversation_link`. The assistant posts there as itself, so the Amazon Chime SDK decides by membership. An incident conversation tells its team conversation "resolved" so, at the resolve |

| Outputs | |
|---|---|
| Message | Posted to the room, or targeted at the one person in the audience, in the reader's language where a variant is written. An audience of several is @mentioned in a message the room reads |
| Outcome, edge | `posted`: `onSuccess`. Audience resolves to nobody (`skipped`): `onSuccess`. A role with more holders than the audience cap, or a post that failed (`failed`): `onFailure`. With `in: 'opener'`, no recorded opener, one of another classification or archived, or an assistant that is not a member there (`refused`): `onFailure`; with `in: 'opened'` the same, and a conversation the run names that records another parent is refused as a SecurityEvent. A link (a conversation's row or tags) that still cannot be read after three attempts is a post that failed (`failed`, logged as an error): `onFailure` |

### `agent`: one model turn

Hands one turn to the run's own assistant. A step never runs a turn as another assistant: `as` and `fallback.absent` are retired and refused on a draft, and a stored step that names `as` is never dispatched, so its `fallback.send` is posted and the run takes `onFailure`. Work that needs another assistant is a `task` step that asks its role (below).

| Inputs | |
|---|---|
| `prompt` | A prompt template |
| `to` | An audience, as for `send` |
| `deadlineMs` | At most 60000. How long the turn has before its fallback is posted |
| `fallback.send` | The `send` posted when the turn does not deliver |
| `tools` | Optional. Read tools only, among the assistant's own |
| `reads` | Optional `'messages'`. The turn reads the room's recent untargeted messages |
| `propose`, `opens` | Optional. One consequential act the turn drafts and a person confirms on a card: `send_nudge` (at `invitation-unredeemed`) or `open_conversation` (of the declared type `opens`) |
| `workflow` | Optional. A task the runtime opens before the turn, whose first step the turn runs |
| `fromRole` | Optional `'brief'`. Drafts from the brief the addressed person's role confers |

| Outputs | |
|---|---|
| Message | The turn's answer, posted to `to`, or the fallback |
| Proposal | With `propose`, a confirmation card addressed to the step's one person. Nothing happens until they apply it |
| Outcome, edge | Output posted (`posted`), or a join recap with nothing to recount (`skipped`): `onSuccess`. Past the deadline, a model error, a guardrail, a refused meter, or not dispatched: the fallback is posted and the run takes `onFailure` |

### `task`: a task the run waits on

Opens one task of a machine (section 4). The run waits for it.

| Inputs | |
|---|---|
| `machine` | A machine the version selects, or a platform machine a step may open (`approval`, `acknowledgement`, `form`, `action_item`, `place_item`). Never the turn queue's own |
| `for` | Optional. The person the task is for, its requester and owner: `subject`, `joined`, `requester`, `{ people: ... }` or `{ participantRole }` with one holder |
| `by` | Optional. Who does the work: a person reference, or `{ assistantRole: '<role>' }`. Absent, the run's own assistant. `{ assistantRole }` makes the step a request: `machine` names any intent that role's assistant advertises. A single-turn intent is one turn of that assistant's, opening no task; a multi-step intent is that assistant's own run on its served version, with its own workflow for the intent (or the standard one), task steps, deadline, tools and grants. The task is visible to the conversation unless the asking run is private. Where no assistant in the room holds the role, the step fails with `no-worker`; where more than one does, nobody is asked and it fails with `failed` |
| `ask` | Optional, a request only: `{ template }`, one of the asking assistant's own message templates saying what is needed, rendered with the run's values in the conversation's language and stored on the task as its request |
| `visibility` | Optional. `conversation` or `private` (the default) |
| `priority` | Optional. `high`, `normal` (the default) or `low`, the order an idle assistant takes its tasks up |
| `deadline` | `{ afterMinutes, kind?, times? }`, 5 minutes to 30 days, or `{ at, kind? }`, a time an earlier task of the run recorded (`task:value:<need>`), never on a `remind`. `timeout` (default) ends the task. `due` shows the time on it. `remind` reminds whoever holds it, every `afterMinutes`, up to `times` (default 3, at most 5). Optional on `continue: 'opened'` and on an intent's own task step |
| `continue` | Optional. `'opened'`: the run goes on once the task leaves the state it opened in, instead of when it settles. `'alongside'`: the run goes on as soon as the task opens, and its end waits on the task: reaching its terminal step while the task is open, the run ends only once the task settles, however it ended (an incident's lead holds it while the runbook runs). `alongside` is refused on a request to an assistant role. Both are refused on an intent trigger |
| `assigned` | Optional, not on a request: `{ template }`, one of this assistant's message templates said privately to the person who holds the task, with its card, and emailed, in place of `workflow-task-assigned` |
| `endsRun` | Optional, `true`, on a `continue: 'alongside'` step only: the task's settlement ends the run where it stands, on its success terminal, its other open tasks cancelled with the run's end as their reason (`run-ended`), rather than waiting for the run to reach its end |
| `confirmEnd` | Optional, with `endsRun` only: a state of the machine that awaits the worker and offers choices, with an edge to it from every state that offers a settling choice. A press that would settle the task while the run has not reached its end moves it here, and the worker is asked in the state's notice, which may name the run's open steps (`steps`, by each step's `label`). `ops-room`'s incident owner task declares `confirming_resolve` |
| `pinned` | Optional, `true`: the step's card is kept in the conversation's pinned band, beside where the conversation stands, and the band's status (open, resolved or ended) is read from this step |
| `decidedBy` | Optional, on a step a participant role works: 1 to 4 participant roles whose holders may take its choices besides its assignee, and reopen it where its machine's ending declares `reopens`. A press is checked against the conversation's own record of who holds each role, and a step that names deciders is moved by a press only, never by an assistant's turn. On a `pinned` step the band offers its choices to those people, each confirmed before it is sent. `ops-room`'s incident owner task names `on-call:ops`, `secondary:ops` and `lead` |
| `takes` | Optional, `reopened`, on a `task-reopened` workflow only: the step takes the reopened task, of the step's machine, instead of opening one, so the task's next ending continues this run. A task that ended its run (`endsRun`) ends that run when it reopens, so nothing the run went on to (a review) goes on |
| `fields` | `form` only: 1 to 8 `{ name, type: text, number or yes-no, required? }` |

A request to an assistant role may declare only `machine`, `for`, `by`, `ask` and `continue`. `visibility`, `priority`, `fields` and `deadline` are the owning assistant's to declare, and a draft that sets one on a request is refused.

| Outputs | |
|---|---|
| Task | One task row, carrying the run (`workflowRun`), the machine it started on and its version, listed for whoever it waits on |
| `task:state` | For the step's edges: the terminal state the task ended in |
| `task:outcome` | For the step's edges, after a failure: `no-worker`, `failed`, `timed-out` or `ended` |
| `task:value:<need>` | For the step's edges, a number or a yes-or-no the task recorded. Every value it recorded, times included, also joins the run's values, which later steps read. A request hands its asking run only how the task ended, never a value the task recorded |
| Outcome, edge | A success terminal, the task left its first state with `continue: 'opened'`, or it opened with `continue: 'alongside'`: `onSuccess`. The deadline ended it: `onDeadline`, else `onFailure`. Any other ending, nobody to do the work, or the task could not be written: `onFailure` |
| Archive | A settlement no assistant turn records (a card press, a deadline, the conversation's archive) writes one `AE_TASK_SETTLED` record |

### `wait`: hold the run for a time, until the conversation it opened ends its run, until its tasks alongside settle, or until several parallel parts end

| Inputs | |
|---|---|
| `minutes` | A whole number, 1 to 43200 (30 days) |
| `until` | Instead of `minutes`: a time a task of this run recorded, `task:value:<need>` where the task's machine records the need as `time`. Missing or unreadable at run time, the step fails; already past, it comes due within a minute |
| `child` | Instead of `minutes`: `'ended'`. The run holds until the `conversation-opened` run of the conversation its `open` step opened has ended, which that run tells it through the parent link its conversation records. The workflow has an `open` step that opens a conversation (not a move). An ops incident's team conversation waits so, and its incident is the opened conversation's own work |
| `alongside` | Instead of `minutes`: `'settled'`. The run holds until each task it went on alongside (`continue: 'alongside'`) that is still open has settled, on the record its end holds on. The workflow has a task step that goes on alongside its task. An incident's post-incident review waits so on its root-cause investigation, once resolve has moved the run on |
| `join` | The wait's only key: `{ of, when, minutes? }`, a join on several parts the run started in parallel. `of` names 2 to 8 steps of this workflow, each once and each in at most one join: an `open` step that opens a conversation (the part is that conversation's own run, which ends as `child` reads it) or a task step with `continue: 'alongside'` (it ends when its task settles, as `alongside` reads it). `when`: `'all'`, every part that started has ended, or `'any'`, the first part to end. A part whose step the run never reached (an `open` behind a condition that did not hold) holds nothing and is recorded as skipped. `minutes`, optional, 1 to 43200: the join's deadline. A workflow whose join names an opened conversation does not also wait on it with `child` |

| Outputs | |
|---|---|
| Schedule | `minutes` or `until`: one one-shot schedule on the classification's scheduler. `child`: no schedule; the opened conversation's run ending is what the run waits for. `alongside`: no schedule; each task's settlement is what the run waits for. `join`: each part's ending, on that part's own record, and one one-shot schedule for its deadline (its `minutes`, else 31 days). The run's continuation is held on its record, never polled |
| Outcome, edge | The schedule fired, or the opened conversation's run ended (before or after the run reached its wait): `onSuccess`. Each task alongside settled in a success: `onSuccess`; one did not (its deadline, a cancel, an archive): `onFailure`, whose conditions read `task:outcome`. A join: `onSuccess` where every part it counted ended in a success, else `onFailure`, whose conditions read why the first part that did not succeed ended (`task:outcome`); its deadline: `onDeadline`, else `onFailure`, with `task:outcome` `timed-out`. A join records `joined:<edge>:<part waited on last>:<part>=<state>,...`, each state `success`, `failed`, `timed-out`, `ended`, `open` or `skipped`, which the Processes tab reads as what the join waited for. It could not be scheduled or held: `onFailure`, at once |

### `opening`: the welcome's opening (`assistant-joined` only)

| Inputs | `text`, or the orientation fields `companyName`, `companyBlurb`, `accessBlurb`, `examples`, `platformNote`. With none, the deployment's orientation for the classification |
|---|---|
| **Outputs** | The opening, composed with no model call. `posted`: `onSuccess`; `failed`: `onFailure` |

### `prompt`: the welcome's model turn (`assistant-joined` only)

| Inputs | `template` (a prompt template), `tools` (read tools only) |
|---|---|
| **Outputs** | One turn of the joining assistant, posted after the run has moved on. `dispatched`: `onSuccess`; `not-dispatched`: `onFailure` |

### `action`: a platform action

| Inputs | `tool: 'start_intake'`, `to`: `subject`, `joined` or `{ people: 'event:person' }`. Only on `assistant-joined`, `conversation-opened` and `person-joined` |
|---|---|
| **Outputs** | The assistant's intake questions put to that person, once. A person with nothing to be asked takes `onSuccess`, as does an intake started. A failure takes `onFailure` |

### `open`: a child conversation

| Inputs | `type`: a declared conversation type the platform does not open on its own. `for`: the child's lead, one person: a person the run names, or `{ typeRole }`, a role of that type sourced from a group with one holder (`on-call:ops`). Never on `assistant-joined` or `conversation-opened` |
|---|---|
| **Outputs** | A conversation of that type at this room's classification, opened with nobody asked, its members the type's and its lead the one person `for` names. The run waits and goes on with `conversation_link`, for a `send` (`child-conversation-opened`) to tell the room. A room that is itself a child opens no further one, and a `for` that names nobody or several opens nothing; each takes `onFailure`. Where the creator hands nothing back within 10 minutes, the step's one-shot backstop takes `onFailure` as `timed-out`; whichever comes first goes on, once, and the other continues nothing |

### End step

| Inputs | `disposition`: `success` or `failure`. No edges |
|---|---|
| **Outputs** | The run ends and writes its `AE_RUN_ENDED` record with that ending |

## 3. Fields every run-level step shares

| Field | What it does |
|---|---|
| `onSuccess`, `onFailure` | The next step. Either a step name, or an ordered list of `{ to, when }` alternatives whose last one has no `when` |
| `onDeadline` | Task steps and joins (`wait: { join }`) only. Absent, `onFailure` |
| `when` | The step's own condition. Where it does not hold, the step does nothing (`gated`) and the run takes `onSuccess` |
| `label` | Optional. The step's name as a person reads it, 1 to 80 characters, where a person is told where the run stands: a confirmation that names its open steps, and a meeting's card in its own conversation. Absent, the step's key |

A condition reads the trigger's inputs, the version's variables, the conversation's type and classification, and, on a task step's edges, `task:state` and `task:outcome`.

**Private requests.** An intent's run is private until something shares it. A step that would reach anyone but the requester is not taken (`withheld`): the requester is told once, and the run takes `onFailure`.

## 4. Task machine states

A task's machine is `initial` plus `states`. Each state is a node in the machine builder. The machine is edited per intent on the version. The task keeps the machine it started on whatever is activated later.

### What a state takes in

| Field | What it declares |
|---|---|
| `transitions` | The states it may move to. Empty on a terminal state |
| `terminal` | On a terminal state: `success`, `failure` or `handoff` |
| `prompt` | What the assistant is told to do in this step |
| `awaits` | `{ party: 'requester' }` or `{ party: 'worker' }`: who the task is blocked on. Moves the task to that party's list. Absent, the assistant works it |
| `requires` | Needs the person supplies before the task goes on, in their own words |
| `records` | Needs from `requires` the model records as a typed value: `number`, `boolean` or `time` (an instant). A number or a yes-or-no is compared by conditions; a time is what a run's wait waits until or a later deadline falls at |
| `resolvedByOneResponse` | One clear answer completes the step |
| `presented`, `confirm`, `brief` | The step is put to the person before the task may leave it. With `confirm: 'when-incomplete'`, only when the needs in `brief` are not all there |
| `choices` | Transitions offered as buttons on the task card that only its assignee receives. Only on a state that awaits somebody |
| `produces` | `text` (default), `image` or `document`. With `template`, or `templates` and `defaultTemplate`, the document template it follows |
| `tools` | Narrows the tools this step's turn may use. Never a grant |
| `requiresTool` | Tools that must have run before the task leaves the step |
| `action`, `onSuccess`, `onFailure` | A registered tool the platform runs on entering, with no model call, and the transitions its result takes |
| `auto` | One of its own transitions the runtime takes once a turn in this state has answered. Only on a state the assistant works |
| `rests` | An idle assistant does not take the step up on its own |
| `notice` | `{ to: room, requester, worker or { participantRole }, template, email? }`: a message said once each time the task enters the state. `email: true` also sends it by email to who the message addresses, where the deployment declares `notifications`. A private task's update to the room or a role is withheld |
| `when`, `edgeWhen` | A condition on entering the state, or on one of its edges |
| `reopens` | Terminal states only: the states the requester may take the finished task back to, or where the step names `decidedBy`, a holder of one of its roles by a press. A workflow on `task-reopened` may name the machine it takes back (`reopens: <machine>`); a reopen runs the one naming its task's machine, else the one naming none |
| `requesterMoves` | On a state that awaits the worker: its transitions the requester may ask for while the worker holds the task, such as a reschedule or a cancel. The requester's message reaches the task only where a state declares some, and only these moves are taken |
| `label`, `placeholder` | How the state is named to the person, and what its placeholder says |

### What a state puts out

| Output | |
|---|---|
| A move | One transition, through `advance_task_state` (the model), a card choice (the assignee), an `action` result, an `auto` move or a deadline. Each is checked against the machine and recorded in the task's history and on the turn's archive record |
| Holder | Who the task waits on, from `awaits`, shown in that person's list ("waiting on you") |
| Values | `details.collected` (the needs as written), `details.typed` (the recorded values), and for its own conditions `task:entries:<state>` (how many times the task entered a state) and `task:value:<need>` |
| Notice | The `notice` template, once per entry |
| Delivery | A reply, an image or a document file, from `produces` |
| Ending | A terminal state ends the task. If a run waits on it, the run continues on the task step's edges |

### Platform machines a task step opens

| Machine | States | Who it waits on | Card choices |
|---|---|---|---|
| `approval` | `deciding`, then `approved` (success) or `declined` (failure) | The worker | `approved`, `declined` |
| `acknowledgement` | `asked`, then `acknowledged` (success) | The worker | `acknowledged` |
| `incident_ownership` | `open`, then `resolved` (success) | The worker, the team room's on-call | `resolved`. While it is open the room holds the incident: a repeat of its event opens nothing, and it counts against the policy's open incidents |
| `form` | `asked`, then `answered` (success) or `declined` (failure) | The requester | `answered` with the step's `fields`, or `declined`. The answers are kept on the task as written and never decide anything |
| `action_item`, `place_item` | The work items any assistant opens for a person | As each state declares | None |

A version cannot declare a machine under a platform machine's name.

## Event triggers and their limits

An EventBridge event starts a workflow in a team's room and no other. Every part is an AWS resource named by convention, so the flow reads off the resources: the rule `<prefix>-<classification>-trigger-<id>` (a pattern naming an exact `source` and `detail-type`, one target, the classification's relay to its router), the team room, the Amazon Chime SDK channel `team-<type>-<classification>` tagged `team-room` and `event-rule:<id>`, and the workflow that declares that type. In the workflow editor, an `event-received` workflow's event panel lists event types from the schema registry, takes a pasted schema name, a resource's ARN or an existing rule on the default event bus (its pattern is copied, so the rule stays its owner's; a rule on a custom bus is **NOT BUILT**), and attaches it; that is an admin action (`manage-event-triggers`), separate from saving the version.

**What an event may do is the deployment's policy**, one SSM parameter edited in the same panel by an admin holding `manage-event-policy`, its history the parameter's own. A deployment that never set one runs the dev values. Each value is checked when a trigger is attached and again on every event, so lowering one holds from the next event, with no deploy.

| Limit | What it stops | Dev value | For production | Most allowed | Where it is changed |
|---|---|---|---|---|---|
| `enabled` | Everything at once: off, no event starts a workflow and nothing can be attached | `true` | `true` | - | Event policy |
| `allowedEventTypes` | Events nobody approved | CloudWatch alarm state changes, `ae.ops` incidents | The event types the deployment uses | 50 | Event policy |
| `maxTriggersPerRoom` | Rule sprawl in one room | 5 | 20 | 100 | Event policy |
| `maxTriggers` | The account's 300 rules per bus | 20 | 200 | 250 | Event policy |
| `maxOpenIncidentsPerRoom` | Rooms piling up: a new room opens only once an open one is resolved | 3 | 20 | 50 | Event policy |
| `retryAttempts`, `maxEventAgeSeconds` | Retries piling up behind a slow router | 2, 900 | 4, 3600 | 185, 86400 | Event policy |
| Relay concurrency | Events fanning out: the excess waits in the relay's queue, and the router refuses any older than `maxEventAgeSeconds` | 2 | 10 to 50 | The account's | `-c eventTriggerRelayConcurrency=N` at deploy |

**What no deployment changes**: one run per rule per 15 minutes, so a storm is one run; a pattern on an alarm's state change matches its entering `ALARM` only, whether chosen by the alarm's ARN, its event type or a copied rule; a stored policy that says off is off, even when another of its fields is invalid; a child conversation opens no further one, and neither does a workflow that runs because a room was just opened; an open incident for the same resource takes a repeat of its event, telling its room, and opens nothing. The alarm `<stack>-event-trigger-relay-throttled` fires when the relay holds a storm back. Model spend in each child's first look is bounded by the deployment's hourly Amazon Bedrock budgets, as every turn is.

## Designing an event for a use case

Review the structure of every event for each use case before it is attached: an inbound EventBridge event a workflow starts on or a watch reacts to, a connector event, and a hand-off between process stages. Sensitive data (a ticket's text, a customer's name, an account's details) stays in the deployment's approved system of record, such as a ticketing system, a document store, a CRM or an S3 bucket with its own access policy. The event carries a reference to a record in a store that both the sending and the receiving side may read, not the sensitive data itself. The platform validates and carries the reference; each side reads the record with its own identity, so the store's own access control decides who sees it.

Why: an event is seen by more principals than the record it is about. It passes through the bus, its rules and their dead-letter queues, and the run it starts is recorded in archive facts and function logs, each read under its own access. A copy of the record in the event is a second source the store's policy does not govern (tenet D7, one source per question; P5, the platform reaches systems of record where they are). So the event, and every fact and log that records it, holds no sensitive content.

What the platform does with an event today fits the rule. A run never receives the event's `detail`: an `event-received` run gets `event:source`, `event:detailType`, `event:resource` (the first resource) and `label`, and a watch trigger adds the key read from the one path the admin chose, which must sit under `$.detail.` or `$.resources[` ([DESIGN-EVENT-TARGETS](../../specs/interaction/conversation/DESIGN-EVENT-TARGETS.md) section 7). The event's other fields still travel the bus, so the sender keeps them out of the event.

**Example.** A support ticket is escalated in the deployment's ticketing system:

```json
{
  "source": "example.support",
  "detail-type": "Ticket Escalated",
  "detail": {
    "ticketId": "SUP-48213",
    "ticketUrl": "https://support.example.com/tickets/SUP-48213",
    "priority": "high"
  }
}
```

The event names the ticket and where it lives; the customer's message, name and account stay in the ticketing system. A watch trigger on the type's kind reads the key at `$.detail.ticketId`, so the run receives `SUP-48213` as its key and `label`, and nothing else from `detail`. The kind is one an opener of the type declares (`openedBy[].watches`, as the sample `ops-incident` kind reads `$.detail.incidentId`). A step names the ticket by `label` in its message, and a person opens it in the ticketing system under their own sign-in. **NOT BUILT:** a step that reads the ticket by its key through the ticketing system's connector with the assistant's own identity (the `fetchContext` connector capability, [SPEC-CONNECTORS](../../specs/communication/SPEC-CONNECTORS.md)).

## Related documents

- [SPEC-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/SPEC-WORKFLOWS-AND-TASKS.md): requirements, status and tests for each node.
- [DESIGN-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/DESIGN-WORKFLOWS-AND-TASKS.md): the two levels and how they meet.
- [ADR-067](../../design/decisions/067-a-workflow-is-triggered-by-an-event-or-an-intent-and-its-steps-create-tasks.md): the decision record.
