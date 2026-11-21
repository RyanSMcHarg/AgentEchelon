# Communication paths: how one part of the platform reaches another

> **Read this before adding anything that makes one component act on another**: a message, an event, a schedule, a task, a stream consumer or a Lambda invoke. Each kind of reach has one established path, and a new reach takes the path its kind already uses. A path of its own is a hidden trigger: nobody declared it, nobody attaches or detaches it, and nothing in the console or the archive shows it.

The rules come from the tenets: an actor acts only as itself (D1), events over polling (D6), one store per question (D7), and governance enforced by IAM before a request runs (P4). [MESSAGE-FLOW](./MESSAGE-FLOW.md) traces one message end to end; this guide says which path a new reach takes.

## The paths

| You need to | Path | Service | Who receives it | Recorded in |
|---|---|---|---|---|
| Say something a person or an assistant reads | A message in the conversation | Amazon Chime SDK messaging (`SendChannelMessage`, `lib/chime/send.ts`) | The conversation's members | The conversation archive, from the message stream |
| Hand a question to another assistant in the conversation | A handover: a private address to that assistant carrying the handover marker | Amazon Chime SDK messaging; the channel flow routes it (`routeHandover`, `channel-flow-processor.ts`), and post-processing's handover backstop delivers one the flow missed (`deliverMissedHandover`, `lib/handover-backstop.ts`) | The addressed assistant, through its classification's router | The conversation archive |
| React to a message after it is posted, off the reply path | A consumer of the message stream | Amazon Kinesis (the Amazon Chime SDK messaging streaming configuration), and the message archive's Amazon Data Firehose stream | Post-processing, the analytics projection, the notification bridge (email), the membership audit, the message archive | The conversation archive; each consumer's own facts |
| Have an assistant do part of a run | A workflow step: a task the run opens, worked by the assistant its step names (`by: { assistantRole }`), or a declared action the platform runs on entry with no model call. A task the platform raises for a run, such as its runbook drawn on the dashboard, takes the same path under a platform run name, and a quiet step (an action and no prompt) posts nothing | The task service (`lib/task-service-op.ts`) and the router's run engine | The assistant holding the step's role | The task row and the run's facts in the archive |
| Start or continue a run on something outside the conversation, chosen by a team | An attached trigger: an event on a bus, received by a rule the trigger service created when someone attached it | Amazon EventBridge: the default bus for AWS events, a connector's partner or own-app bus ([ADR-068](../../design/decisions/068-the-deployments-own-app-is-a-connector-over-its-own-bus.md)), and the process bus for hand-offs (built, not deployed; [DESIGN-PROCESSES](../../specs/interaction/conversation/DESIGN-PROCESSES.md) section 12) | The rule's one target, a classification's relay (`EventTriggerRelay`), which hands the event to that classification's router | The run it starts, in the archive |
| React to a platform or AWS event the deployment always handles | A platform rule: declared in a stack, targeting one named function by its own ARN | Amazon EventBridge (for example the meeting lifecycle, the incident watch's alarm changes, the typed conversations an event opens, connector events, admin notices, group and issuer changes) | That function, which checks the record again before it acts | The function's own facts |
| Act when something did not happen by a time | A deadline | Amazon EventBridge Scheduler (`lib/event-deadlines.ts`) | The router, which checks the record again before acting | The run's facts |
| Run something periodic, or a backstop sweep behind an event path | A schedule rule a stack owns | Amazon EventBridge schedule rules (for example the archive's projections and retention, the membership audit, the connector grant revoker, the idle checker) | The named function | The function's own facts |
| Reach a function that holds what the caller may not | A service seam | AWS Lambda invoke: `RequestResponse` for an answer, `Event` to start a job the service runs | The service, for example the task service, the data plane, the user profile service, the vend, the conversation creator, the provisioner, the golden-set runner, the meeting run, transactional mail | The service's own audit or facts |
| Email someone who is not yet a member | Transactional mail | The Notifications stack's mail sender (`lib/transactional-mail.ts`) | The invited, claimed or nudged person | The mail's own record |
| Tell an open console that a job ended | The console events API | A Lambda destination to EventBridge, then the console events publisher (`admin-services-stack.ts`) | The admin console | The job's own facts |

## Direct Lambda invokes are for four things only

A Lambda invoke is a call, not a channel: it is fast and synchronous where it must be, and it is invisible to everything that reads conversations, triggers and the archive. So it is used only where one of these holds:

1. **A service seam.** The caller lacks a reach the service holds (a classification's task table, the Aurora data plane, the vend that issues an assistant's session, the creator that makes a conversation), and asks it for one typed operation, or starts one job. The service checks the request itself; the caller's word decides nothing.
2. **Entry into a classification's engine.** Everything that starts work in a classification enters through its router, the one entry for every tier: the channel flow, the trigger relay, the creator's hand-back, and the platform's own continuations (`lib/say-through-router.ts`, the triage, the handover backstop, the join recap). Asynchronous, except where the caller needs the router's answer (for example the channel flow, or a notice whose outcome the caller reports).
3. **The router dispatching an assistant's turn.** Only the router invokes an assistant's processor, for a turn (a person's message, a welcome, a room name, a task pickup, a meeting summary) or a step its run declared (a send's `voiceSend`, an event step), and the turn recovery handler re-dispatches a failed turn's own payload (`turn-lock-release-on-failure.ts`). A processor takes no mode that no turn or step declares.
4. **A function continuing its own work** (a long audit or a batch invoking itself for the next page, a parked turn resuming itself).

A new invoke that fits none of these is the wrong path: the reach is a workflow step, an event or a message.

## Rules for each path

- **Messages.** What a person reads is said in the conversation, in the speaker's voice and the reader's language, from a template ([ADR-062](../../design/decisions/062-a-message-is-a-template-stored-and-versioned-like-a-document.md)). Channel Metadata is member-writable, so it carries hints and directives, never a decision about identity, classification or membership.
- **The message stream.** A consumer never sits on the reply path: email, analytics and archival follow the message. A notice that must reach email goes into the conversation with a `notify` directive, and the notification bridge sends it from the stream, so it is one message in chat and in email.
- **Workflow steps.** A run has an assistant act through a declared step, so the step shows in the workflow, the console and the run's record. A fixed outcome is a declared action, not a model's choice.
- **Events.** An event carries ids, types and references, never the record it is about ([WORKFLOW-STEP-REFERENCE](../admin/WORKFLOW-STEP-REFERENCE.md), "Designing an event for a use case"). No person creates a rule: every attached trigger's rule is the trigger service's, targeting a relay, and every other rule is a stack's. A receiver checks the event again against what was attached or what the record says. Where who may put a source or who may subscribe to it matters, the bus enforces both: the process bus admits only each router role's own source and only the trigger service's rules.
- **Timers.** A schedule is for the absence of an event, for periodic work, or for a low-frequency reconciliation sweep behind an event path (D6). A deadline that fires checks the record before it acts.
- **Polling.** Never for state an event already delivers (D6).

## Known exceptions

| Exception | Why it exists | Status |
|---|---|---|
| The processor invokes the battle orchestrator when a battle's first round ends (`lib/async-processor-core.ts`) | The orchestrator collects the round's answers; its rebuttal enters the router as any continuation does | **OPEN** |
| The proactive briefing emails every member directly (`proactive-briefing.ts`, `emailPeople`), with no message in the conversation | The briefing is sent to each person, not said in a conversation | **OPEN**: a `notify` directive on a posted briefing would make it one message |
| The archival pipeline alarm also emails its recipients directly (`alarm-to-admin-channel.ts`) | It fires when the message stream has stopped, and the notification bridge reads that stream | Kept |
| Cost sleep mode's notices go by an Amazon SNS email subscription | They are sent while the deployment is asleep, when no conversation path runs | Kept |
| Who may put and who may subscribe to `ae.alert` on the default bus | The raisers span many roles in many stacks | **OPEN** ([DESIGN-EVENT-TARGETS](../../specs/interaction/conversation/DESIGN-EVENT-TARGETS.md) section 12) |

The client events and the meeting events reach their own archives by direct put to Amazon Data Firehose, not from the message stream; they are separate archives of what the clients and the meetings report.

## Related

- [MESSAGE-FLOW](./MESSAGE-FLOW.md): one message, end to end.
- [MESSAGE-DELIVERY-GUIDE](./MESSAGE-DELIVERY-GUIDE.md): message size and the one send.
- [DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION](../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md): the handover between assistants.
- [DESIGN-WORKFLOWS-AND-TASKS](../../specs/interaction/conversation/DESIGN-WORKFLOWS-AND-TASKS.md): runs, steps and tasks.
- [DESIGN-EVENT-TARGETS](../../specs/interaction/conversation/DESIGN-EVENT-TARGETS.md): triggers, watches and their targets.
- [TENETS](../../overview/TENETS.md): D1, D6, D7 and P4.
