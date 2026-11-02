/**
 * Task Tracking for Agent Handlers
 *
 * Provides task creation, status tracking, and state machine management
 * for multi-turn agent operations. Used for guided troubleshooting,
 * data extraction, and report generation workflows.
 *
 * Two DynamoDB tables:
 * - AgentTasksTable: PK=taskId, SK=channelArn — task details
 * - UserTasksTable: PK=principalId, SK=taskId, GSI=principalId-taskType-index — active task lookup
 */

import { deliversDocument } from './task-state-machines.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DeliveryOption } from './delivery-options.js';
import { taskStateMachines as packTaskStateMachines } from './intent-pack.js';
import {
  type TaskStateMachine,
  type TerminalKind,
  DEFAULT_TASK_STATE_MACHINES,
  ADVANCE_TASK_STATE_TOOL_NAME,
  DELIVER_DOCUMENT_TOOL_NAME,
  stateNamesOf,
  authorizeTransition,
  directEdgeRefusal,
  awaitedPartyOf,
  actionRunKey,
  entrySequenceOf,
} from './task-state-machines.js';
import { emitEmfMetric } from './emf-metrics.js';
import { TASK_STALL_TURNS } from './task-trajectory.js';
import { isPrivateVisibility, type TaskVisibility } from './task-visibility.js';
import * as crypto from 'crypto';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionDocumentClient } from './assistant-session.js';
import { personIdFromArn, principalIdFromArn } from './person-arn.js';

/** CloudWatch EMF namespace for task-lifecycle metrics (SPEC-TASK-STATE-TRANSITIONS §7). */
const TASK_METRICS_NAMESPACE = 'AgentEchelon/Tasks';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// removeUndefinedValues: createTask writes optional
// taskType / taskState / messageId into the Item — taskState is
// explicitly undefined for any task with no state machine (the common
// generic-task case). Without this the PutCommand throws and is
// swallowed by the surrounding try/catch, so task tracking fails
// SILENTLY (no 500, no row) — worse than a visible error.
const dynamoClient = sessionDocumentClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER }, {
  marshallOptions: { removeUndefinedValues: true },
});

const TASKS_TABLE = process.env.TASKS_TABLE || '';
const USER_TASKS_TABLE = process.env.USER_TASKS_TABLE || '';

/**
 * THE TABLE AN EVENT RUN'S RECORDS ARE WRITTEN TO, AND THE CLIENT THAT WRITES THEM (ADR-061 decision 5). An event run
 * is a row of the task table, so this module, the one that names the task tables, hands the task service the name and
 * this client, and `event-run-store.ts` builds its conditional writes against them. The task service is the only
 * caller, so a run's claim goes through the same boundary as every other task write.
 */
export function eventRunTable(): {
  send: <C extends PutCommand | GetCommand>(command: C) => Promise<{ Item?: Record<string, unknown> }>;
  table: string;
} {
  return { send: (command) => dynamoClient.send(command as never) as Promise<{ Item?: Record<string, unknown> }>, table: TASKS_TABLE };
}

// `cancelled` = cascade-cancelled when its parent work item is dropped;
// `abandoned` = the user dropped out of the flow (kept so a nudge can offer to resume/drop it).
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'abandoned';

/** Active = still needs work (eligible for resume, nudge, cascade-cancel). */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'abandoned'];

/**
 * One entry in a task's append-only transition log (SPEC-TASK-STATE-TRANSITIONS §6) — the
 * task-lifecycle analog of the membership-history timeline. `by: 'tool'` = the model requested it
 * via advance_task_state / propose_item; `by: 'system'` = a TTL expiry, admin action, or error-path
 * fail. `reason` is the model's stated justification; `messageId` is the turn that carried the call.
 */
export interface StateTransition {
  /** The graph edge. ABSENT on an ownership entry, which is not a graph edge (ADR-024 D3). */
  from?: string;
  to?: string;
  at: string; // ISO
  by: 'tool' | 'system';
  reason?: string;
  messageId?: string;
  /**
   * Ownership entries (ADR-024 D3), as `<type>:<principalId>`. Present INSTEAD of `from`/`to`, so a
   * consumer that reads `from` gets nothing rather than a principal id in a field every other reader
   * treats as a state name. `ownerFrom` is absent when the task had no resolvable owner before.
   */
  ownerFrom?: string;
  ownerTo?: string;
  /** The owner in force when this entry was written, so every state edge is attributable. */
  owner?: string;
  /**
   * THE OUTCOME, present only on the entry that ENDS the task.
   *
   * A task's life used to have no recorded ending: `updateTaskStatus` set `status='completed'` and
   * appended nothing, so the row said it was finished and nothing said when, or how it went. This
   * entry is that ending, and it lives in the same append-only log as every other transition rather
   * than in a column beside it - one writer, one record, nothing to disagree with.
   *
   * It is NOT a graph edge, so `from`/`to` are absent: a lightweight task with no state machine also
   * ends, and reading an ending as an edge is the confusion `ownerFrom`/`ownerTo` already avoid here.
   */
  terminal?: TerminalKind;
  /**
   * THIS EDGE REOPENED A FINISHED TASK: `from` is a terminal state that declares `to` in `reopens`
   * (task-state-machines.ts). Present only on that edge, beside the `by` that authored it, which is
   * always `tool` because no runtime writer may reopen. It is also what ends the previous ending for
   * `taskEndedAt`: a task reopened after its terminal entry has not ended.
   */
  reopen?: true;
  /**
   * THIS EDGE WAS TAKEN BY THE RUNTIME ON A DECLARED STEP ACTION'S OUTCOME (SPEC-TASK-STATE-TRANSITIONS
   * FR29): the tool the state's `action` ran, and whether it succeeded, so the log says why the runtime
   * moved the task. Present only beside `by: 'system'`, on the `onSuccess` or `onFailure` edge.
   */
  action?: { tool: string; outcome: 'success' | 'failure' };
}

/**
 * Result of a requested transition (authorization + persistence). Mirrors the tool result shape.
 *
 * `state_changed` = the task moved between the read this transition was authorized against and the
 * write, so the edge was authorized from a state the task no longer occupies. Distinct from
 * `persist_failed` (an infrastructure error) because it is not a retry candidate: the caller must
 * re-read and re-decide from the CURRENT state.
 */
export type AdvanceResult =
  | { ok: true; from: string; to: string; terminal?: TerminalKind; reopened?: true }
  | {
      ok: false;
      error:
        | 'no_active_task' | 'unknown_state' | 'illegal_transition' | 'persist_failed' | 'state_changed'
        // Refused by `advance_task_state` from the machine's own declarations, before anything is
        // written (task-tools.ts): a `presented` step left on the turn it was entered, a `requires`
        // need with no source, and a move that hands over a document without declaring one.
        | 'opening_step_must_be_presented' | 'requirement_unsourced' | 'document_required'
        // A templated delivering step whose template could not be loaded, or whose platform fill has a
        // field nothing recorded (SPEC-DOCUMENT-TEMPLATES FR4, FR9).
        | 'template_unavailable' | 'template_unbound_field'
        // The move enters a state whose declared action has an argument nothing recorded, so the
        // platform could not run it (SPEC-TASK-STATE-TRANSITIONS FR29).
        | 'action_unbound_arg'
        // The step requires a tool that has not returned success since the task entered it (ADR-064 decision 3).
        | 'required_tool_not_run'
        // A declared edge whose condition (the target's `when` or the edge's `edgeWhen`) does not hold over the
        // deciding values the turn's resolver read (ADR-060 decision 6).
        | 'condition_not_met'
        // A move past a confirmed step (ADR-064 decision G) whose brief this turn's request did not carry, or whose brief
        // is missing a need on the task's record.
        | 'brief_not_in_request' | 'brief_incomplete';
      from?: string;
      legal?: string[];
    };

/**
 * Task state machines for multi-turn intents, as ORDERED state-name arrays — the legacy shape the
 * keyword shadow-detector + the terminal-last check consume. DERIVED from the authoritative
 * DEFAULT_TASK_STATE_MACHINES (task-state-machines.ts) so it can never drift from the real graph
 * (SPEC-CONFIGURABLE-ASSISTANTS 4.5 — retire the hand-maintained shadow). A per-assistant loop uses
 * the RESOLVED machines (via stateNamesOf(ctx.machines)); this default backs the machine-less paths.
 */
export const TASK_STATE_MACHINES: Record<string, string[]> = stateNamesOf(DEFAULT_TASK_STATE_MACHINES);

/**
 * Should a task turn mark the LIFECYCLE status 'completed'? Keeps the lifecycle status in step with the
 * MACHINE state (AT6): a machine-backed task is only 'completed' once its machine actually reaches a
 * TERMINAL state (the authoritative graph marks it), never force-completed mid-flow — so the admin Tasks
 * view never shows status=Completed while the machine is still `extracting`. A task WITHOUT a state
 * machine (lightweight/single-turn) has nothing to progress, so it completes on its turn as before.
 */
export function shouldMarkTaskCompleted(
  taskType: string | undefined,
  machineState: string | undefined,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): boolean {
  const machine = taskType ? machines[taskType] : undefined;
  if (!machine) return true; // no machine → nothing to progress; completes per turn (unchanged)
  return !!(machineState && machine.states?.[machineState]?.terminal);
}

/**
 * Who owns a task: the actor that must act on it NEXT (ADR-024 D1). One at a time, human or
 * assistant, reassignable at a step boundary.
 *
 * `id` is the **app-instance principal's unique id** - an `AppInstanceUserId` for a person (the opaque
 * id the credential exchange minted, whichever issuer signs them in), an `AppInstanceBotId` for an
 * assistant. Never an
 * ARN: the ARN is rebuilt from the type when a Chime call needs one.
 *
 * `type` is stored rather than inferred, and that follows from the id rather than qualifying it: the
 * unique id **cannot be turned back into an ARN** without knowing whether the path segment is
 * `/user/` or `/bot/`, so the information is not in the id at all.
 */
export type AssigneeType = 'user' | 'assistant';

export interface TaskAssignee {
  id: string;
  type: AssigneeType;
}

/** The unique id of an app-instance principal, from its ARN. `.../user/<id>` and `.../bot/<id>`. */
export { principalIdFromArn };

/**
 * The assignee in force, for a row that may predate a migration. New rows carry `assigneeId`/`assigneeType`
 * and this returns them directly; a legacy row is resolved from whichever ownership-shaped field it
 * happens to carry, in the order the old code preferred them, so a task written before the migration
 * stays resumable by the same actor it was resumable by before.
 */
export function resolveTaskAssignee(
  task: Partial<Pick<Task, 'assigneeId' | 'assigneeType' | 'ownerId' | 'ownerType' | 'assignedBotArn' | 'assigneePersonId' | 'userArn'>>,
): TaskAssignee | null {
  if (task.assigneeId && task.assigneeType) return { id: task.assigneeId, type: task.assigneeType };
  // A ROW WRITTEN BEFORE THE RENAME (ADR-024 D8). The field said `owner` and meant the assignee, so
  // this reads exactly what it always did, one link further down a chain this function already had
  // for older shapes. Live tasks keep the actor they were resumable by; the rows age out on the
  // task TTL and this link goes with them.
  if (task.ownerId && task.ownerType) return { id: task.ownerId, type: task.ownerType };
  if (task.assignedBotArn) return { id: principalIdFromArn(task.assignedBotArn), type: 'assistant' };
  if (task.assigneePersonId) return { id: task.assigneePersonId, type: 'user' };
  const fromRequester = personIdFromArn(task.userArn) || '';
  return fromRequester ? { id: fromRequester, type: 'user' } : null;
}

/**
 * THE SINGLE OWNERSHIP WRITER (ADR-024). Every path that sets an owner goes through this, because
 * "owned by one at a time" is only enforceable where there is one place to enforce it: the two
 * fields are written together or not at all, so a row can never carry a type without an id or claim
 * two owners.
 *
 * Returns the fields to merge into a Task item; it does not write, so it composes with both the
 * create paths and the reassignment path.
 */
export function setTaskAssignee(assignee: TaskAssignee): Pick<Task, 'assigneeId' | 'assigneeType'> {
  if (!assignee.id) throw new Error('[setTaskAssignee] an assignee needs an id');
  if (assignee.type !== 'user' && assignee.type !== 'assistant') {
    throw new Error(`[setTaskAssignee] unknown assignee type: ${String(assignee.type)}`);
  }
  return { assigneeId: assignee.id, assigneeType: assignee.type };
}

/**
 * How much of the message that opened a task the task keeps (ADR-024 D5). A task stores what the
 * task requires, and the ONE consumer of this text is `buildTaskContextForPrompt`, which truncates
 * to exactly this. At this length the prompt it builds is byte-identical to the one the full
 * transcript produced, so bounding the copy is a reduction with nothing traded against it.
 *
 * Defined beside its reader deliberately: split the two and the stored excerpt silently stops
 * matching what is read.
 */
export const TASK_EXCERPT_MAX_CHARS = 200;

/** One thing this task handed over: what it was, when, and the state it was produced from. */
export interface TaskDelivery {
  /** The file as the person sees it in the channel, or a short description when there is no file. */
  name: string;
  /** ISO timestamp of the hand-over. */
  at: string;
  /** The machine state that produced it, so a reader can tell a draft from a final. */
  fromState?: string;
  /**
   * The document template it was checked against and the result (SPEC-DOCUMENT-TEMPLATES FR8): which
   * version a delivered document was written against, readable from the task itself.
   */
  template?: { name: string; contentHash: string; outcome: string; chosen?: true };
}

/**
 * WHO MAY SEE A TASK EXISTS (ADR-033).
 *
 * `conversation` is ADR-024 D4: visible to the conversation's current members whatever the owner.
 * `private` is visible to the requester and the assistant that owns it, and to nobody else in the
 * room.
 *
 * THE REASON THIS IS NOT A LATER REFINEMENT. A targeted message is one other members cannot read, so
 * a task created from it that appears in their list tells them it happened. The message CONTENT never
 * travels - `getOpenTasksForConversation` is built field by field so it cannot carry text - but the
 * existence, type, owner and state do, and for a targeted request that set is the disclosure.
 *
 * ABSENT MEANS `private`. A task can be written before its targeting is known, so
 * absence can mean "nobody found out", and reading that as shared is the leak this type exists to
 * prevent. Every reader goes through `readTaskVisibility` / `isPrivateVisibility` in
 * `task-visibility.ts`, and every writer that means a task to be shared records `conversation`.
 */
export type { TaskVisibility } from './task-visibility.js';

/**
 * How urgent this work is RELATIVE to the rest of the person's list, recorded rather than inferred.
 *
 * Ordering by `createdAt` or `dueBy` would infer priority from arrival or from a deadline, and those
 * are different things: the most recently sent request is often the most important and often not, and
 * a task with no deadline is not thereby unimportant. A queue triaged into several tasks has to be put
 * in some order, and an inferred order is one nobody agreed to.
 */
export type TaskPriority = 'high' | 'normal' | 'low';

export interface Task {
  taskId: string;
  channelArn: string;
  userArn: string;
  /**
   * THE SHORT REFERENCE A PERSON TYPES TO ANSWER THIS ITEM (ADR-035): `#<taskRef>`.
   *
   * Unique within the conversation and never reused while it lives, so `#2` names the same item in
   * yesterday's message and today's. Allocated atomically at creation (`allocateTaskRef`). Absent on
   * rows written before it existed and on the queue's own drain rows, which nobody answers.
   */
  taskRef?: number;
  /**
   * THE PERSON THIS WORK BELONGS TO (ADR-024 D8).
   *
   * A task names three roles that change at three different rates: `assistantId` is the assigned
   * assistant and never moves; this is the OWNER and moves only when somebody hands the work over;
   * `assigneeId`/`assigneeType` are the ASSIGNEE and move at every `awaits` boundary.
   *
   * IT DEFAULTS TO THE REQUESTER AND IS NOT THE REQUESTER. `userArn` records who asked, which is a
   * fact about how the task started and can never be anything else. This is a position somebody
   * currently holds, so work can be handed on and afterwards belong to them.
   *
   * WHY IT HAD TO EXIST. Any question of the form "which of this person's work is this" cannot be
   * asked of the assignee: while the assistant is working - most of an interesting task's life - the
   * person is not on the row at all. The owner is what stays put, so it is what such a question
   * reads. Absent on rows written before this field, which age out on the task TTL.
   */
  ownerPersonId?: string;
  /**
   * Who may see this task EXISTS. Absent reads as `private` (see `TaskVisibility`). Derived at
   * creation from the message's targeting; narrowed later by `markTaskPrivate`, never widened.
   */
  visibility?: TaskVisibility;
  /** Relative urgency, recorded at triage. Absent reads as `normal`. */
  priority?: TaskPriority;
  /**
   * A BOUNDED EXCERPT of the request that opened the task (ADR-024 D5), not the transcript. To read
   * the message itself, resolve `userMessageId` against the channel - which also gets its redacted
   * state rather than a copy that outlived the redaction.
   */
  requestExcerpt?: string;
  /** @deprecated the unbounded copy. Superseded by `requestExcerpt`; still read for older rows. */
  userMessage?: string;
  status: TaskStatus;
  deliveryOption: DeliveryOption;
  taskType?: string;
  taskState?: string; // Current state in the state machine
  /** Append-only transition log (SPEC-TASK-STATE-TRANSITIONS §6). Absent on tasks with no machine. */
  stateHistory?: StateTransition[];
  /**
   * Consecutive active-task turns spent in the current `taskState` without a transition
   * (SPEC-TASK-STATE-TRANSITIONS §7). Reset to 0 on every authorized advance; incremented on a
   * task turn that applied none. Feeds the `task_state_stalled` signal — the runtime NEVER
   * force-advances, this is only a dashboard signal that the model is failing to drive the task.
   */
  turnsInState?: number;
  /**
   * WHAT THIS TASK HAS ALREADY HANDED OVER, append-only.
   *
   * A turn that produces a document uploads it, attaches it to a message, and remembers nothing. The
   * next turn therefore has no idea the work was delivered - so an assistant asked "is this done?"
   * cannot see that it already handed the person their report, and cannot decide whether the task
   * should be closed. Reported live: a delivered report with its task still open, and the assistant
   * unable to say either way.
   *
   * This is CONTEXT FOR THE MODEL, not a completion trigger. Completion keeps its single path - the
   * model calls `advance_task_state` and the machine reaches terminal (invariant AT6). What was
   * missing was never the authority to close a task, it was knowing there was anything to close.
   */
  deliveries?: TaskDelivery[];
  /**
   * The turn's correlation key - what ties this task to the rest of its turn's records. Always
   * present; derived when the caller cannot declare one.
   */
  correlationId?: string;
  /**
   * The RESOLVABLE Chime message id of the USER's message that opened this task, or ABSENT (ADR-024
   * D5). Never the correlation id as a fallback, and never the assistant's placeholder: that
   * substitution is what made the old `messageId` field misleading.
   *
   * Absent on the ordinary Lex path today, because Chime sends the fulfilment exactly three request
   * attributes and the message id is not among them; the bypass paths declare the inbound id they
   * already hold.
   */
  userMessageId?: string;
  /** @deprecated held a CORRELATION id on the path that creates most tasks. Use `correlationId`. */
  messageId?: string;
  details?: Record<string, unknown>; // State-specific data collected during the task
  /**
   * THE STEP-ACTION ENTRIES THIS TASK HAS CLAIMED, append-only, each `<state>#<entry sequence>`
   * (SPEC-TASK-STATE-TRANSITIONS FR29). Written by `claimStateAction` before a declared action runs, with
   * a condition that it is absent, so a retried or redelivered turn on the same entry never runs the
   * action a second time. What the run produced is recorded under `details.actions[state]`.
   */
  actionRuns?: string[];
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  ttl: number;
  /**
   * DESCRIPTIVE ONLY: which duel this task's turn belonged to (ADR-026).
   *
   * A battle is not a task; a battle TURN may open one because its intent was task-shaped, and that
   * task then proceeds like any other. Set via `TaskCreateOptions.battleId` on the one creation path -
   * there is no separate battle constructor any more, and the second door is what made a resumed side
   * restart its chain.
   *
   * NEVER read to make a decision. What keeps two sides' tasks apart is the OWNER being that side
   * (ADR-024 D1/D2), so the lookup is "the active task owned by this actor in this channel" and works
   * identically for a duelling assistant and a person holding a work item. Whether this field should
   * exist at all is the live question ADR-024 raised; it is kept because analytics joins a duel's tasks
   * by it.
   */
  battleId?: string;
  /**
   * THE OWNER (ADR-024 D1) - the actor that must act on this task next, human or assistant, one at a
   * time. Written only via `setTaskAssignee`, always as a pair. Absent on rows written before the
   * migration; use `resolveTaskAssignee` rather than reading these directly.
   */
  /**
   * WHO MUST ACT NEXT (ADR-024 D8). One of the task's three roles, and the one that moves most: it
   * changes hands at every `awaits` boundary, so it names the person while a step waits on them and
   * the assistant while the assistant is working.
   *
   * NOT the owner. `ownerPersonId` is the person the work belongs to and holds still; this is a position
   * that is handed back and forth for the life of the task. They were one field called `owner` until
   * D8, which is what made "which of this person's work is this" unanswerable while work was running.
   */
  assigneeId?: string;
  assigneeType?: AssigneeType;
  /** @deprecated The assignee, under its pre-D8 name. Read through `resolveTaskAssignee`; never written. */
  ownerId?: string;
  /** @deprecated The assignee type, under its pre-D8 name. Read through `resolveTaskAssignee`; never written. */
  ownerType?: AssigneeType;
  /**
   * THE ASSISTANT THIS CHAIN BELONGS TO, as a principal id. Written once at creation and never moved.
   *
   * Distinct from `ownerId`, and both are needed (maintainer, 2026-08-14). The OWNER is whoever must act
   * next and legitimately changes hands every time the machine crosses an `awaits` boundary; the
   * ASSISTANT is which assistant's work this is, and never changes. Collapsing them is what forced the
   * choice between two broken things: keep the assistant as owner and a task blocked on a person is
   * invisible in that person's queue, or hand it to the person and two duel sides' chains land in one
   * partition with nothing to tell them apart (ADR-024 D2 separated them by owner alone).
   *
   * With both, a duel side resolves its own chain precisely - "the task in this channel whose
   * assistant is me" - while the person holds the step and sees it in their queue.
   */
  assistantId?: string;
  /** @deprecated superseded by `ownerId`/`ownerType`. Read through `resolveTaskAssignee`. */
  assignedBotArn?: string;
  /**
   * WHO DOES THE WORK, when a workflow's task step named it (ADR-063 decision 1): a person or an assistant, as a principal
   * id, resolved once when the step ran. Written at creation and never moved, like `assistantId`. A state that
   * `awaits: { party: 'worker' }` is held by it (`awaitedHolder`). Absent on every task no step opened.
   */
  workerId?: string;
  workerType?: AssigneeType;
  /**
   * THE WORKFLOW RUN WAITING ON THIS TASK (ADR-063 decision 3), when a task step opened it: the run's ids and the
   * conversation fields its sends render, so the router can continue the run once the task settles. Nothing of the
   * task's own work is copied here, and nothing here decides anything about the task.
   */
  workflowRun?: WorkflowRunRef;
  /**
   * THE INTENT THE REQUEST THAT OPENED THIS TASK WAS CLASSIFIED AS (ADR-064 decision B). A task whose type the pack
   * declares as an intent is configured under that intent; a platform machine (`queued_request`, `queue_drain`, ...)
   * is not an intent, so its steps route, and its turns are attributed, under this one. Written once at creation, only
   * by the platform (`TaskCreateOptions.openingIntent`), and absent on a task no classified request opened.
   */
  openingIntent?: string;
  /**
   * THE EXPERIMENT ARM THE TASK WAS OPENED UNDER (ADR-064 decision J). While the experiment runs, the task's turns are
   * served that arm's version; once it stops, the live version (`resolveTaskArm`). Written once at creation, only by the
   * router, and never from a caller's `details`, so nobody chooses an arm by writing a field.
   */
  experimentArm?: TaskExperimentArm;
  // Work-item tasks: a task is anchored to a context (plan) + (optionally) a
  // work item, and assigned to a participant. itemId is the cascade key (drop the item ⇒
  // cancel its tasks); dueBy drives reminders. All optional — enterprise tasks leave them unset.
  contextId?: string;
  itemId?: string; // the work item id this task serves; null for plan-level tasks
  // @deprecated superseded by `ownerId`/`ownerType`. Read through `resolveTaskAssignee`.
  // The assignee's AppInstanceUser id. To email the assignee the notifier names this person and the
  // directory resolves their contact through `Identities`, whichever issuer signs them in; no issuer is
  // copied onto the task (avoids drift). See SPEC-NOTIFICATION-BRIDGE
  // "Identity resolution across multiple IDPs".
  assigneePersonId?: string;
  dueBy?: string; // ISO date/datetime the action is due
  // Last time a due-date reminder fired for this task (ISO). The scheduled reminder uses it to avoid
  // re-nagging on every fire. Absent ⇒ never reminded.
  lastRemindedAt?: string;
}

/** The experiment, arm and served definition a task was opened under (ADR-064 decision J). */
export interface TaskExperimentArm {
  experimentId: string;
  variantId: string;
  configId?: string;
}

/**
 * A RUN A TASK STEP OPENED THE TASK FOR (ADR-063 decision 3): ids, plus the conversation fields the run's sends render.
 * The router recomputes the run's key from these and refuses a continuation whose key does not match.
 */
export interface WorkflowRunRef {
  runKey: string;
  workflow: string;
  step: string;
  event: string;
  /** The run's assistant, which continues the run. */
  botArn: string;
  eventPerson?: string;
  subject?: string;
  invitationId?: string;
  alarm?: { name: string; state: string; changedAt: number };
  values?: Record<string, string>;
  /** When the step's deadline falls, epoch seconds, so the row outlives it and the router can name its schedule. */
  deadlineAt?: number;
}

/**
 * The active-task mirror row. **`principalId` is the OWNER's principal id** (ADR-024 D2), not
 * necessarily a user and not necessarily the requester: an assistant-owned task sits in a partition
 * keyed by its `AppInstanceBotId`.
 *
 * The id is a principal id: a person's AppInstanceUser id, or an assistant's `AppInstanceBotId` while
 * the assistant holds the work. Read `assigneeType` to know what kind of actor the id names.
 */
export interface UserTask {
  principalId: string;
  /** Mirror of `Task.taskRef`, so a person's list can show the reference they type. */
  taskRef?: number;
  /** What kind of actor `principalId` names. See `Task.assigneeType`. */
  assigneeType?: AssigneeType;
  /** @deprecated The assignee type under its pre-D8 name. Read through `assigneeTypeOf`; never written. */
  ownerType?: AssigneeType;
  /** Mirror of `Task.assistantId` - whose work this is, as opposed to who owes the next step. */
  assistantId?: string;
  /**
   * WHO THE ITEM IS FOR. Mirrored so a client can address an answer without narrowing who reads it:
   * an answer about conversation-visible work belongs in the conversation, openly, and an answer
   * about private work stays targeted.
   *
   * ABSENT MEANS PRIVATE, the same reading `TaskVisibility` gives the task itself. The consumer is a
   * composer deciding whether to address an answer openly: guessing "shared" publishes a private
   * answer; guessing "private" costs a targeted message that could have been public. Only one of
   * those is recoverable.
   */
  visibility?: TaskVisibility;
  /**
   * THE OWNER (ADR-024 D8), mirrored because the question it answers is asked of the mirror.
   *
   * `principalId` above is the ASSIGNEE and is the partition key, so it names the assistant for as long
   * as the assistant is working. "Which of this person's work here is this" therefore cannot be
   * answered from the partition; it is answered from this attribute, over the conversation index.
   */
  ownerPersonId?: string;
  taskId: string;
  taskType: string;
  channelArn: string;
  status: TaskStatus;
  taskState?: string;
  /**
   * THE PERSON'S OWN WORDS, mirrored so their queue can say which request each row is.
   *
   * Without it the mirror carried only `taskType`, and `details` is initialized empty and written by
   * nothing on the queued-request or report paths - so every row in somebody's own work list read
   * "Queued request", identically, however many there were. A list you cannot choose from is not a
   * list. Measured on the deployment: 50 rows of one type and 72 of another, all indistinguishable,
   * over tasks whose excerpts said "Q3 headcount lookup" and "Identify three tools the onboarding
   * process touches".
   *
   * Already truncated at creation (ADR-024 D5), so mirroring it adds no new disclosure and no second
   * decision about length.
   */
  requestExcerpt?: string;
  details?: Record<string, unknown>;
  /** Mirror of `Task.openingIntent`, so the turn that resumes the task routes and attributes it with no second read. */
  openingIntent?: string;
  /** Mirror of `Task.experimentArm`, so the router serves a resumed task its arm with no second read. */
  experimentArm?: TaskExperimentArm;
  createdAt: string;
  updatedAt: string;
  ttl: number;
  // Mirror of the work-item-task anchor for cross-channel/digest hints.
  contextId?: string;
  itemId?: string;
  assigneePersonId?: string; // AppInstanceUser id (see Task.assigneePersonId); resolvable identity is roster-side
  dueBy?: string;
}

/**
 * Lex event shape (minimal fields needed for task creation)
 */
export interface LexEventForTask {
  inputTranscript?: string;
  requestAttributes?: Record<string, string>;
}

function generateTaskId(): string {
  return crypto.randomUUID();
}

/**
 * THE KEY OF A CONVERSATION'S REFERENCE COUNTER (ADR-035), a row in the tasks table itself.
 *
 * The table is keyed `taskId` + `channelArn`, so the counter is one row per conversation under a
 * fixed `taskId`. It carries no `updatedAt`, `status` or `contextId`, so it is absent from every
 * index a task read uses and from the one scan (which filters on `dueBy` and `status`).
 *
 * NOT CHANNEL METADATA, which conversation members can write: a person could otherwise set the counter
 * and make two items share a reference.
 */
export const TASK_REF_COUNTER_ID = 'counter#taskRef';

/** Task types a person never answers by reference, so they do not consume a number. */
const UNREFERENCED_TASK_TYPES = new Set(['queue_drain']);

/**
 * Allocate the next reference for a conversation, atomically.
 *
 * ONE CONDITIONLESS `ADD`, which DynamoDB applies atomically, because triage creates several items for
 * one conversation concurrently and a read-then-write counter would hand two of them the same number.
 * Fails open to no reference: an item without one is still answerable the way every item was before.
 */
export async function allocateTaskRef(channelArn: string): Promise<number | undefined> {
  if (!TASKS_TABLE || !channelArn) return undefined;
  try {
    const res = await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId: TASK_REF_COUNTER_ID, channelArn },
      UpdateExpression: 'ADD refCounter :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }));
    const n = Number(res.Attributes?.refCounter);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch (err) {
    console.warn('[task-tracking] could not allocate a task reference; the item is created without one', {
      err: (err as Error)?.message,
    });
    return undefined;
  }
}

/** Default task TTL — 24h, the historical value (enterprise multi-turn tasks are short-lived). */
export const DEFAULT_TASK_TTL_SECONDS = 24 * 60 * 60;
/** Plan tasks must outlive the conversation until the work happens — default ~200 days (callers that
 *  know the plan end should pass `ttlSeconds` = end + buffer). */
export const TRIP_TASK_TTL_SECONDS = 200 * 24 * 60 * 60;

/** Work-item-task anchor + lifetime overrides. All optional. */
export interface TaskCreateOptions {
  /**
   * The machines to resolve the initial state and its ownership from. Defaults to the PACK-merged
   * set (deployment machines over the platform defaults) - never the raw defaults alone, which left
   * a pack-declared task type created STATELESS: taskState undefined, the loop never registered the
   * advance tool, and the task reached nobody's queue. A caller holding PROFILE machines may pass
   * the fully-merged set.
   */
  machines?: Record<string, TaskStateMachine>;
  /**
   * USE THIS ID RATHER THAN A FRESH ONE. Defaults to a new uuid, which is what every caller that has
   * nothing to coordinate with wants.
   *
   * It exists for work whose IDENTITY is decided before the row is: a queue drain makes a claim on
   * the shared turn record by conditional write, so that of several readings racing to open one drain
   * exactly one creates the task and the rest are told the winner. That claim has to name an id
   * before there is a row to name, and a create that minted its own would make the record point at a
   * task that does not exist.
   */
  taskId?: string;
  /**
   * WHAT THE TASK NEEDS TO CARRY FROM THE MOMENT IT IS OPENED, when its own creation is the only
   * place that knows it.
   *
   * Defaults to empty, which is what every caller before this wanted and still gets. It exists for
   * work whose SUBJECT is a set of other things: a combination question is about several queued
   * messages and the people who sent them, the merge happens on a later turn, and by then the
   * grouping that prompted the question is gone from the record. Ids and principal ids, never
   * anybody's words - the same rule the queue itself follows.
   */
  details?: Record<string, unknown>;
  contextId?: string;
  itemId?: string;
  /** Who must act on this next. Defaults to the requester, as a `user` owner. */
  owner?: TaskAssignee;
  /** Who does the work, when a workflow's task step named it (ADR-063 decision 1). Recorded, never moved. */
  worker?: TaskAssignee;
  /** The run a task step opened this task for (ADR-063 decision 3). */
  workflowRun?: WorkflowRunRef;
  /** The intent the request that opened this task was classified as (`Task.openingIntent`, ADR-064 decision B). */
  openingIntent?: string;
  /** The experiment arm the turn that opened this task was served (`Task.experimentArm`, ADR-064 decision J). */
  experimentArm?: TaskExperimentArm;
  /**
   * WHOSE WORK THIS IS - the assistant the chain belongs to, as a principal id. Fixed for the task's
   * life, unlike `owner`, which changes hands at every `awaits` boundary. Defaults to the owner
   * when the caller named an assistant one.
   */
  assistantId?: string;
  /** The user message that opened this, when the caller holds a resolvable id (ADR-024 D5). */
  userMessageId?: string;
  /**
   * WHO MAY SEE THIS TASK EXISTS (ADR-033). Derived by the caller from the targeting of the message
   * that opened it: a targeted request is one other members cannot read, so a conversation-visible
   * task created from it tells them it happened.
   *
   * Omitted reads as PRIVATE - see `TaskVisibility`. A caller that means the task to be shared must
   * pass `conversation`; a caller that does not know the targeting omits it, and the task fails closed.
   */
  visibility?: TaskVisibility;
  /**
   * Relative urgency, recorded rather than inferred (ADR-033). Omitted means `normal`.
   *
   * Ordering by `createdAt` or `dueBy` instead would infer priority from arrival or from a deadline,
   * and those are different things: the most recent request is often the most important and often
   * not, and a task with no deadline is not thereby unimportant.
   */
  priority?: TaskPriority;
  /**
   * TELL ME IF THE ROW DID NOT LAND. Defaults to false, which is what every caller before ADR-033
   * wanted and still gets.
   *
   * The fail-open default is right when a task is a SIDE EFFECT of a turn that already answered:
   * losing the row costs a work item somebody can reopen, while throwing would fail a turn whose
   * answer was already delivered. Under triage the relation inverts - the task IS the answer, and the
   * proposal the person reads describes work that exists nowhere else - so a swallowed write leaves
   * them told their messages landed when nothing holds them.
   *
   * Which of the two a call is cannot be decided here, so the caller declares it. Same shape as the
   * fail-open/fail-safe split the claim policies already draw.
   */
  throwOnWriteFailure?: boolean;
  dueBy?: string;
  /** Row TTL in seconds from now. Defaults to DEFAULT_TASK_TTL_SECONDS (24h); plan tasks pass
   *  TRIP_TASK_TTL_SECONDS (or end + buffer) so they don't expire before the work happens. */
  ttlSeconds?: number;
  /**
   * Which duel this turn belonged to, when a battle turn's intent opened a task (ADR-026).
   *
   * The task itself is ORDINARY - a battle is not a task, the intent was. This is descriptive only and
   * is never read to make a decision: the per-side collision is prevented by the OWNER being that side
   * (ADR-024 D1/D2), not by this field. Whether it should exist at all is the live question ADR-024
   * raised; it is kept for now because analytics joins a duel's tasks by it.
   */
  battleId?: string;
  /**
   * The user's message in DECODED form, for the stored excerpt.
   *
   * Amazon Chime SDK delivers a transcript percent-encoded, and a bypass entry re-encodes it to keep the
   * round trip lossless - so `event.inputTranscript` is encoded and reading it directly stores
   * `Produce%20a%20report` as the excerpt a human later reads in the admin console. The caller has
   * already decoded it for the turn, so it passes the decoded text rather than this function guessing at
   * an encoding. Falls back to the transcript when absent, which is correct for the Lex path.
   */
  requestExcerpt?: string;
}

/**
 * Create a new task and store it in DynamoDB
 */
export async function createTask(
  event: LexEventForTask,
  deliveryOption: DeliveryOption,
  taskType?: string,
  correlationId?: string,
  opts?: TaskCreateOptions
): Promise<Task> {
  const taskId = opts?.taskId || generateTaskId();
  const now = new Date().toISOString();

  const channelArn =
    event.requestAttributes?.['x-amz-lex:channel-arn'] ||
    event.requestAttributes?.['CHIME.channel.arn'] ||
    '';
  const userArn =
    event.requestAttributes?.['x-amz-lex:channel-member-arn'] ||
    event.requestAttributes?.['CHIME.sender.arn'] ||
    '';

  // Determine the initial state from the MERGED machines (pack over defaults, or the caller's
  // profile-merged set) - the same resolution every other consumer applies. The raw defaults alone
  // cannot see a deployment-pack task type.
  const machinesForCreate = opts?.machines ?? packTaskStateMachines();
  const initialState = taskType ? machinesForCreate[taskType]?.initial : undefined;

  const ttl = Math.floor(Date.now() / 1000) + (opts?.ttlSeconds ?? DEFAULT_TASK_TTL_SECONDS);
  // Work-item-task anchor fields, included only when supplied (enterprise tasks omit them).
  const anchor = {
    ...(opts?.contextId ? { contextId: opts.contextId } : {}),
    ...(opts?.itemId ? { itemId: opts.itemId } : {}),
    ...(opts?.dueBy ? { dueBy: opts.dueBy } : {}),
  };

  // THE OWNER IS WHOEVER OWES THE CURRENT STEP (ADR-024 D1, owner 2026-08-14), and that is decided by the state
  // the task STARTS in, not only by transitions later. `maybeHandOver` moves ownership when the machine
  // CROSSES an `awaits` boundary, which is right for every transition and silent about the start:
  // a machine whose INITIAL state awaits the user was born blocked on them and nothing crossed
  // anything, so the task stayed with its creator. Every `report_generation`, `data_extraction` and
  // `guided_troubleshooting` chain starts that way - which is why a duel waiting on someone appeared
  // in nobody's queue, and why "what do I owe" could not see it.
  //
  // A caller-supplied owner is honored only when the first step is NOT the person's. The ASSISTANT
  // the chain belongs to is recorded separately (`assistantId`), so handing the step to the person
  // costs nothing in traceability: two duel sides stay distinguishable by assistant, not by owner.
  const requesterPersonId = personIdFromArn(userArn) || '';
  // The awaited party is a REFERENCE, and the only one that ships resolves to the requester, who is
  // exactly the principal this line already had to hand. Read through the normalizer so a machine
  // authored in either accepted form starts in the same owner's queue.
  const initialAwaits = taskType && initialState ? awaitedPartyOf(machinesForCreate[taskType]?.states?.[initialState]) : null;
  // A STEP THAT AWAITS THE WORKER starts with the worker a task step named (ADR-063 decision 1), person or assistant.
  const startsWithTheWorker = initialAwaits?.party === 'worker' && opts?.worker ? opts.worker : null;
  const startsBlockedOnAPerson = Boolean(initialAwaits) && !startsWithTheWorker;
  const owner: TaskAssignee | null = startsWithTheWorker
    ?? ((startsBlockedOnAPerson && requesterPersonId)
      ? { id: requesterPersonId, type: 'user' as const }
      : (opts?.owner ?? (requesterPersonId ? { id: requesterPersonId, type: 'user' as const } : null)));

  // Whose work it is. Explicit when the caller names an assistant owner (a duel side does), otherwise
  // the assistant running this turn if the caller supplied one. Never moves afterwards.
  const assistantId = opts?.assistantId
    ?? (opts?.owner?.type === 'assistant' ? opts.owner.id : undefined);

  // THE REFERENCE A PERSON TYPES (ADR-035). Only when the row will actually be written: a create with no
  // table would burn a number for an item that never exists.
  const taskRef = TASKS_TABLE && channelArn && !UNREFERENCED_TASK_TYPES.has(taskType || '')
    ? await allocateTaskRef(channelArn)
    : undefined;

  const task: Task = {
    taskId,
    channelArn,
    userArn,
    ...(taskRef ? { taskRef } : {}),
    // THE OWNER, which starts as the requester and is a role rather than a record of that (D8).
    // `requesterPersonId` is already derived above for the assignee decision, so this adds no new source
    // for the same fact.
    ...(requesterPersonId ? { ownerPersonId: requesterPersonId } : {}),
    requestExcerpt: (opts?.requestExcerpt ?? event.inputTranscript ?? '').slice(0, TASK_EXCERPT_MAX_CHARS),
    status: 'pending',
    deliveryOption,
    taskType,
    taskState: initialState,
    ...(correlationId ? { correlationId } : {}),
    ...(opts?.userMessageId ? { userMessageId: opts.userMessageId } : {}),
    // Written only when the caller decided (ADR-033). An unconditional `conversation` default here
    // would record a decision nobody made; absent reads as private, which is the safe reading of
    // "nobody found out".
    ...(opts?.visibility ? { visibility: opts.visibility } : {}),
    ...(opts?.priority ? { priority: opts.priority } : {}),
    ...(opts?.battleId ? { battleId: opts.battleId } : {}),
    ...(assistantId ? { assistantId } : {}),
    ...(opts?.worker ? { workerId: opts.worker.id, workerType: opts.worker.type } : {}),
    ...(opts?.workflowRun ? { workflowRun: opts.workflowRun } : {}),
    ...(opts?.openingIntent ? { openingIntent: opts.openingIntent } : {}),
    ...(opts?.experimentArm?.experimentId && opts.experimentArm.variantId ? { experimentArm: opts.experimentArm } : {}),
    details: opts?.details ?? {},
    createdAt: now,
    updatedAt: now,
    ttl,
    ...anchor,
    ...(owner ? setTaskAssignee(owner) : {}),
  };

  if (TASKS_TABLE) {
    try {
      await dynamoClient.send(new PutCommand({
        TableName: TASKS_TABLE,
        Item: task,
      }));
      console.log(`Task created: ${taskId} (type: ${taskType || 'general'}, state: ${initialState || 'none'})`);
    } catch (error) {
      console.error('Error creating task:', error);
      // Rethrown only for a caller that said a lost row is not survivable. Logged either way, so the
      // default path keeps the exact behavior it had.
      if (opts?.throwOnWriteFailure) throw error;
    }
  }

  // The active-task mirror, partitioned by the OWNER (ADR-024 D2). It used to be partitioned by the
  // REQUESTER here while every other writer keyed on the assignee, so the moment those differed the
  // row a status update touched was not the row this one wrote.
  if (USER_TASKS_TABLE && owner) {
    await putMirrorRow(task, opts?.throwOnWriteFailure === true);
  }

  return task;
}

/**
 * Write the mirror row for a task, under its owner. The single place the mirror is created, so the
 * partition it lands in can only ever be the one `resolveTaskAssignee` reads back.
 */
async function putMirrorRow(task: Task, throwOnWriteFailure = false): Promise<void> {
  const owner = resolveTaskAssignee(task);
  if (!USER_TASKS_TABLE || !owner) return;
  try {
    const userTask: UserTask = {
      principalId: owner.id,
      assigneeType: owner.type,
      taskId: task.taskId,
      ...(task.taskRef ? { taskRef: task.taskRef } : {}),
      taskType: task.taskType || 'general',
      channelArn: task.channelArn,
      status: task.status,
      taskState: task.taskState,
      // THE REQUEST ITSELF, so a person's queue names what each row IS rather than what kind of thing
      // it is. Every write of this mirror carries it, including the reassignment path, so a row does
      // not lose its name by changing hands.
      ...(task.requestExcerpt ? { requestExcerpt: task.requestExcerpt } : {}),
      details: task.details ?? {},
      ...(task.openingIntent ? { openingIntent: task.openingIntent } : {}),
      ...(task.experimentArm ? { experimentArm: task.experimentArm } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ttl: task.ttl,
      // Carried onto the mirror so a chain can be found by ITS ASSISTANT from whichever partition the
      // owner currently puts it in. Without it here, an assistant looking for its own work in a
      // person's partition would have to read the full task row for every candidate.
      ...(task.assistantId ? { assistantId: task.assistantId } : {}),
      // Mirrored so the conversation-scoped read can narrow to one person without the partition,
      // which names the assignee and therefore the assistant for most of a task's life (D8).
      ...(task.ownerPersonId ? { ownerPersonId: task.ownerPersonId } : {}),
      // WHO THE ITEM IS FOR, mirrored so the composer can address an answer without narrowing who
      // reads it. Without it here the mirror cannot answer the question at all, and a client asking
      // it would get `undefined` for every item - shared and private alike.
      ...(task.visibility ? { visibility: task.visibility } : {}),
      ...(task.contextId ? { contextId: task.contextId } : {}),
      ...(task.itemId ? { itemId: task.itemId } : {}),
      ...(task.dueBy ? { dueBy: task.dueBy } : {}),
    };
    await dynamoClient.send(new PutCommand({ TableName: USER_TASKS_TABLE, Item: userTask }));
  } catch (error) {
    console.error('Error writing user-task mirror:', error);
    // THE MIRROR IS WHERE A PERSON FINDS THEIR OWN WORK, so a caller that declared "the task IS the
    // answer" is not served by a task row that exists only in the agent table. Under triage the
    // person is TOLD their queued request was picked up, and a swallowed mirror write meant it never
    // appeared in their list and nothing could resume it - the exact outcome the flag was added to
    // prevent, surviving one table further down.
    if (throwOnWriteFailure) throw error;
  }
}

/**
 * Get a task by ID
 */
export async function getTask(taskId: string, channelArn: string): Promise<Task | null> {
  if (!TASKS_TABLE) return null;

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
    }));
    return (result.Item as Task) || null;
  } catch (error) {
    console.error('Error getting task:', error);
    return null;
  }
}

/**
 * Get the most recent active task of a type in an OWNER's partition.
 *
 * `principalId` is the partition key, which since ADR-024 D2 holds the task's CURRENT OWNER rather than
 * its requester (`putMirrorRow`) - so this finds a chain only while that actor holds it, and a person's
 * own request becomes invisible here the moment the assistant takes it back. Named for the column,
 * which predates the repartition.
 *
 * By default this queries the `principalId-taskType-index` GSI across
 * all channels — the row returned may have originated in a different
 * channel than the current caller. Callers that intend to *resume* a
 * task SHOULD pass `opts.channelArn` so the lookup is scoped to the
 * current channel; resuming a task whose original `channelArn` doesn't
 * match the current channel will silently fail at the
 * `getTask(taskId, channelArn)` step in the async processor, since
 * that table is keyed by both.
 *
 * PREFER `getAssigneeChannelTasks` WHEN THERE IS A CHANNEL. It answers the same question over the same
 * partition without a type filter, in one paginated strongly-consistent query rather than one call
 * per declared machine, and it hands back the recently-ended rows in the same read. A caller that has
 * a channel and loops this per type is issuing reads that lookup has already made.
 *
 * For cross-channel visibility (e.g. "the tasks this actor holds
 * elsewhere"), use `getActiveTasksForUser` instead.
 */
export async function getActiveTask(
  personId: string,
  taskType: string,
  opts: { channelArn?: string } = {},
): Promise<UserTask | null> {
  if (!USER_TASKS_TABLE) return null;
  // Fast path: the principalId-taskType GSI (eventually consistent, cheap).
  const viaGsi = await queryActiveTask(personId, taskType, opts, false);
  if (viaGsi) return viaGsi;
  // Recent-write path (COST-CRITICAL): a task created moments ago by an earlier turn of the SAME
  // multi-step flow may not yet be visible on the eventually-consistent GSI. A rapid follow-up turn
  // (e.g. the details reply ~2s after a clarify) would then miss it and create a DUPLICATE task — a second
  // full run of an expensive data_extraction / report_generation, doubling cost. Re-check with a
  // STRONGLY-CONSISTENT read of the base table (PK=principalId) so the follow-up continues the existing task.
  return queryActiveTask(personId, taskType, opts, true);
}

/** Look up the most recent active task of a type. `consistent` chooses a strongly-consistent base-table
 *  query (PK=principalId) over the eventually-consistent GSI — the base table supports ConsistentRead; a GSI
 *  never does. See getActiveTask for why the consistent fallback matters (duplicate-task prevention). */
async function queryActiveTask(
  personId: string,
  taskType: string,
  opts: { channelArn?: string },
  consistent: boolean,
): Promise<UserTask | null> {
  try {
    const values: Record<string, string> = {
      ':principalId': personId,
      ':taskType': taskType,
      ':pending': 'pending',
      ':inProgress': 'in_progress',
    };
    // The GSI pre-filters by taskType via its key; the base-table query filters taskType alongside status.
    const filterParts: string[] = ['#status IN (:pending, :inProgress)'];
    if (consistent) filterParts.push('taskType = :taskType');
    if (opts.channelArn) {
      filterParts.push('channelArn = :channelArn');
      values[':channelArn'] = opts.channelArn;
    }

    // PAGINATED, WITH NO Limit, ON BOTH PATHS (the defect already removed from the owner lookup).
    //
    // DynamoDB applies `Limit` to the items READ, before the FilterExpression. This carried `Limit: 1`
    // on the GSI under a comment calling it pre-filtered and therefore safe, and it was not: the index
    // key narrows to (principalId, taskType), but the status and channel conditions are still a filter. One
    // completed row of the same type read first - and completed rows persist to TTL - filtered to
    // nothing and returned null over a live task behind it. The index sort key is the type itself, so
    // it does not order rows of one type by recency either: the first row read was never the newest.
    // The base table carried `Limit: 25` over a partition sorted by a random task id, which is exactly
    // the cap `getAssigneeChannelTasks` removed for dropping matches.
    //
    // Both partitions are bounded by the task TTL, so the full read is bounded too. The newest match is
    // chosen from every page, on both paths.
    const items: UserTask[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: USER_TASKS_TABLE,
        ...(consistent ? { ConsistentRead: true } : { IndexName: 'principalId-taskType-index' }),
        KeyConditionExpression: consistent
          ? 'principalId = :principalId'
          : 'principalId = :principalId AND taskType = :taskType',
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      items.push(...((result.Items as UserTask[] | undefined) ?? []));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return items.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0] ?? null;
  } catch (error) {
    console.error('Error getting active task:', error);
    return null;
  }
}

/**
 * THE OWNER LOOKUP (ADR-024): the active task owned by this actor in this conversation.
 *
 * The same question for a duelling assistant and for a person holding a work item, so it is one
 * query with the owner as its only subject - which is what lets the battle state row stop carrying a
 * `taskId` to answer a battle question with task state.
 *
 * A base-table query on the owner partition, filtered to this channel and to ACTIVE statuses, newest
 * first. Strongly consistent by default: this is the same read that stops a rapid follow-up turn
 * starting a second expensive task, and the eventually-consistent GSI cannot serve that (D2). Returns
 * the mirror row; the caller reads the full task from the source of truth when it needs fields the
 * index does not carry.
 */
/**
 * THE CHAIN IN THIS CHANNEL THAT BELONGS TO THIS ASSISTANT AND IS HELD BY THIS PERSON.
 *
 * The precise form of "what is this message the answer to". Both halves are load-bearing: the OWNER
 * partition is where a task blocked on a person lives, and `assistantId` is what tells two duel sides'
 * chains apart inside it - they await the same person, so the partition alone names two rows and
 * picking the newest would hand a side its rival's work.
 *
 * Returns the task ID, which is what callers should carry from here on. "The active task" as an
 * implicit notion is exactly what let a resumed turn operate on whichever row a second lookup happened
 * to return (maintainer, 2026-08-14).
 */
export async function getActiveTaskForAssistant(
  assistantId: string,
  ownerId: string,
  channelArn: string,
): Promise<UserTask | null> {
  if (!assistantId) return null;
  const held = await getActiveTasksForOwnerInChannel(ownerId, channelArn);
  return held.find((t) => t.assistantId === assistantId) ?? null;
}

/**
 * HOW LONG A FINISHED TASK KEEPS ANSWERING FOR THE CONVERSATION, in minutes.
 *
 * A message that arrives shortly after a piece of work finishes is usually ABOUT that work - "where is
 * the file?", "can you make it shorter?" - and not a new subject. The window is named and configurable
 * rather than a number inside a condition, because it is a product judgement about how long a person
 * stays in an exchange, and a deployment may know better than this default.
 *
 * WHY TEN MINUTES. It has to cover reading a delivered document and coming back with a question about
 * it, which is minutes rather than seconds. It has to be short enough that a subject raised after the
 * person has moved on is still recognized as new. The platform's existing notion of "still in this
 * exchange" is the abandonment detector's five minutes of silence after an offer; reading a report
 * takes longer than ignoring a yes/no prompt, so this is twice that.
 *
 * WHAT IT COSTS WHEN IT IS WRONG. Someone who genuinely changes the subject a minute after a report
 * lands gets no offer to split the conversation, for the rest of the window - not one turn, every turn
 * in it. They are answered normally in the current conversation, and they can still say "start a
 * separate conversation about X", which takes the explicit-routing path and is never suppressed. That
 * is the cheaper failure than the one this exists to stop, where a direct question about the thing
 * just delivered is answered with an offer to talk about it somewhere else. It is also the same trade
 * already accepted for a LIVE task, which suppresses for as long as the task runs - often far longer
 * than ten minutes.
 */
export const RECENTLY_ENDED_TASK_WINDOW_MINUTES =
  Number(process.env.RECENTLY_ENDED_TASK_WINDOW_MINUTES || '10');

/** Options for the one owner-partition read. */
export interface OwnerChannelTaskOptions {
  /**
   * Also return tasks that ENDED within this many milliseconds. Absent ⇒ live tasks only, which is
   * the historical behavior byte for byte.
   *
   * FREE. The query already reads the whole owner partition and filters after the read (see below),
   * so widening the filter changes no read cost at all - only which of the rows already paid for are
   * handed back.
   */
  endedWithinMs?: number;
}

/** What one owner holds, and recently held, in one conversation. Both lists newest first. */
export interface OwnerChannelTasks {
  /** Live work: `pending` or `in_progress`. */
  live: UserTask[];
  /**
   * Work that reached a terminal status recently, by the MIRROR's `updatedAt`.
   *
   * PROVISIONAL, and named so at the call site. The mirror is written when the ending is mirrored,
   * which is a second instant for a fact the task's `stateHistory` already records
   * (SPEC-TASK-STATE-TRANSITIONS §6: the ending is an entry in the log, and there is deliberately no
   * `resolvedAt` column beside it). This list is therefore a cheap PRE-FILTER; a caller that acts on
   * the ending reads it from the log with `taskEndedAt`.
   */
  recentlyEnded: UserTask[];
}

/**
 * WHEN THIS TASK ENDED, from the append-only log that records it (SPEC-TASK-STATE-TRANSITIONS §6).
 *
 * The terminal entry is the LAST entry carrying a `terminal` disposition - last rather than first
 * because a task can be cancelled after being abandoned, and the ending that matters is the one that
 * stuck. Undefined for a task that has not ended, or one written before the terminal entry existed.
 *
 * A REOPEN AFTER THE ENDING UNDOES IT. A declared reopen (`reopen: true`) recorded after the last
 * terminal entry means the task is running again, so it has not ended, and the next ending is the one
 * its re-completion appends.
 */
export function taskEndedAt(task: Pick<Task, 'stateHistory'> | null | undefined): string | undefined {
  const entries = task?.stateHistory ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.reopen) return undefined;
    if (entries[i]?.terminal) return entries[i].at;
  }
  return undefined;
}

/**
 * ONE READ of an owner's partition, answering both questions this turn can ask of it: what is live
 * here, and what finished here recently.
 *
 * Two lists rather than two functions because it is one query. The singular helpers already delegate
 * here for exactly that reason - they used to carry byte-identical hand-maintained queries, which is
 * how a defect could be fixed in one and kept in the other.
 */
/**
 * THE OPEN WORK IN ONE CONVERSATION THAT BELONGS TO ONE PERSON AND ONE ASSISTANT (ADR-024 D8).
 *
 * This is the read behind "which of my work here is this message about". It is deliberately NOT a
 * partition read: the mirror is partitioned by ASSIGNEE, so while the assistant is working the row
 * sits in the assistant's partition and the person it belongs to is not the key. It goes over the
 * conversation index and narrows by owner.
 *
 * ── THIS FUNCTION IS NOT THE BOUNDARY, AND MUST NOT BE MISTAKEN FOR ONE ─────────────────────────
 *
 * It applies the owner narrowing, which is one layer. The layer that decides WHO MAY RUN IT is the
 * task service in front of it: IAM decides who may invoke that service at all, and the service
 * refuses a conversation whose classification it does not answer for, before this runs (tenet P4:
 * enforced before the request runs, two layers, provable by a deny-test).
 *
 * The `ownerPersonId` handed in is carried from the message sender, which Amazon Chime SDK sets, never
 * composed from anything a person typed. An actor can only ever be asked about as itself.
 *
 * ROWS WITHOUT AN OWNER ARE NOT MATCHED. Absent means a row written before the field existed, and
 * treating absence as "belongs to whoever is asking" is the one reading that could return another
 * person's work. Those rows age out on the task TTL.
 */
export async function getConversationTasksForAssistant(
  channelArn: string,
  assistantId: string,
  ownerPersonId: string,
): Promise<UserTask[]> {
  if (!USER_TASKS_TABLE || !channelArn || !assistantId || !ownerPersonId) return [];
  const items: UserTask[] = [];
  let lastKey: Record<string, unknown> | undefined;
  try {
    // PAGINATED, WITH NO `Limit`, for the reason the sibling read records: the filter runs AFTER the
    // read and this index's sort key is a task id, so a cap reads arbitrary rows and drops matches.
    do {
      const res = await dynamoClient.send(new QueryCommand({
        TableName: USER_TASKS_TABLE,
        IndexName: 'channelArn-assistantId-index',
        KeyConditionExpression: 'channelArn = :c AND assistantId = :a',
        // THE OWNER IS A CONDITION, NOT A POST-FILTER IN THE CALLER. Applied here it cannot be
        // forgotten by a second caller later, which is how a scoping rule becomes advisory.
        //
        // AND ONLY LIVE WORK. This read fed a `task_id` enum the model may advance, and `<> completed
        // AND <> cancelled` admits `abandoned` and `failed` - so a task somebody explicitly PAUSED
        // (`pauseTask` writes `abandoned`, deliberately non-terminal) was offered back as something a
        // plain reply could resume. Every sibling read filters to pending and in_progress, and the
        // router states that as an invariant of all of them; this one has to keep it true.
        FilterExpression: 'ownerPersonId = :o AND #s IN (:pending, :inProgress)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':c': channelArn, ':a': assistantId, ':o': ownerPersonId,
          ':pending': 'pending', ':inProgress': 'in_progress',
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      items.push(...((res.Items ?? []) as UserTask[]));
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  } catch (err) {
    console.warn('[task-tracking] conversation task read failed:', (err as Error)?.message);
    return [];
  }
  return items;
}

/**
 * WHAT ONE PERSON OWNS, ACROSS EVERY CONVERSATION (ADR-024 D8).
 *
 * The sibling read answers what a principal is ASSIGNED, which is what they owe next and is a
 * partition read. This answers what they OWN, which the partition cannot: while an assistant is
 * working the row sits in the assistant's partition and the person it belongs to is only an
 * attribute. An operator asks both questions and they return different sets.
 *
 * NOT A BOUNDARY, like every other read in this file. The caller decides who may ask; the task
 * service applies the classification refusal per row, because an owner spans conversations and any of
 * them may belong to a classification the caller may not be served.
 *
 * SPARSE, because only rows written since D8 carry an owner. A person whose work all predates it
 * reads as owning nothing rather than as an error, and those rows age out on the task TTL.
 */
export async function getTasksOwnedBy(ownerPersonId: string): Promise<UserTask[]> {
  if (!USER_TASKS_TABLE || !ownerPersonId) return [];
  const items: UserTask[] = [];
  let lastKey: Record<string, unknown> | undefined;
  try {
    // NO `Limit`, AND THE REVIEW THAT REMOVED THE LAST ONE IS WHY. DynamoDB applies `Limit` to rows
    // READ, not rows matched, and this index's sort key is a task id - so a cap reads arbitrary rows
    // and filters them. An operator opening this for somebody whose owner-partition happens to begin
    // with finished rows would be told that person owns nothing. The same defect is recorded twice in
    // this file already; the partition is bounded by the task TTL, so the full read is bounded too.
    do {
      const res = await dynamoClient.send(new QueryCommand({
        TableName: USER_TASKS_TABLE,
        IndexName: 'ownerPersonId-index',
        KeyConditionExpression: 'ownerPersonId = :o',
        // LIVE WORK ONLY, matching every sibling read rather than inventing a second definition of
        // "open" that would make this surface and the assignee surface disagree for a reason the ADR
        // does not name.
        FilterExpression: '#s IN (:pending, :inProgress)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':o': ownerPersonId, ':pending': 'pending', ':inProgress': 'in_progress' },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      items.push(...((res.Items ?? []) as UserTask[]));
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  } catch (err) {
    console.warn('[task-tracking] owner task read failed:', (err as Error)?.message);
    return [];
  }
  return items;
}

/**
 * HAND A TASK TO A DIFFERENT PERSON (ADR-024 D8).
 *
 * The owner is a ROLE rather than a record of how the task started, and this is what makes that true
 * in practice: work can be delegated, and afterwards it belongs to whoever holds it.
 *
 * IT DOES NOT TOUCH THE ASSIGNEE. Who owns the work and who owes its next step are separate axes,
 * which is the whole of D8: handing a report to a colleague does not decide whether the assistant or
 * a person acts next, and moving the assignee as a side effect would answer a question nobody asked.
 * `reassignTask` remains the way the next step changes hands.
 *
 * THE REQUESTER IS NOT REWRITTEN either. `userArn` records who asked, which stays true however many
 * times the work changes hands, and it is what keeps the original requester able to read what they
 * wrote (see the disclosure gate in `getOpenTasksForConversation`).
 *
 * THE MIRROR MOVES WITH IT, because the owner is what the cross-conversation read keys on. A task
 * whose owner changed on the task row and not on its mirror would be owned by one person and listed
 * under another, which is the disagreement the single-writer rule exists to prevent.
 */
export async function reassignTaskOwner(
  taskId: string,
  channelArn: string,
  ownerPersonId: string,
): Promise<boolean> {
  if (!TASKS_TABLE || !taskId || !channelArn || !ownerPersonId) return false;
  const now = new Date().toISOString();
  const before = await getTask(taskId, channelArn).catch(() => null);
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      // ── THE HANDOVER IS RECORDED ON THE ROW, NOT ONLY IN A LOG (ADR-024 D3) ────────────────────
      //
      // The assignee axis appends a `stateHistory` entry for every move, and D3 makes "ownership
      // history survives reassignment" an invariant a test must be able to fail. This axis wrote
      // nothing: the only trace was a CloudWatch line, which expires, so after two handovers the row
      // could no longer say who owned it before. D8's own text says moving work between people is a
      // fact somebody may need to reconstruct later.
      //
      // `owner:` distinguishes it from the assignee entries in the same list, which carry
      // `${type}:${id}` for a user or an assistant. The two axes share one history and must stay
      // readable apart.
      UpdateExpression: 'SET ownerPersonId = :o, updatedAt = :now'
        + ', stateHistory = list_append(if_not_exists(stateHistory, :empty), :entry)',
      // ONLY A TASK THAT EXISTS. Without this an unknown id creates a row carrying nothing but an
      // owner, which then appears in that person's list as work that does not exist.
      ConditionExpression: 'attribute_exists(taskId)',
      ExpressionAttributeValues: {
        ':o': ownerPersonId,
        ':now': now,
        ':empty': [] as StateTransition[],
        ':entry': [{
          ...(before?.ownerPersonId ? { ownerFrom: `owner:${before.ownerPersonId}` } : {}),
          ownerTo: `owner:${ownerPersonId}`,
          at: now,
          by: 'system',
        } as StateTransition],
      },
    }));
  } catch (err) {
    console.warn('[reassignTaskOwner] task update failed:', (err as Error)?.message);
    return false;
  }
  if (!USER_TASKS_TABLE) return true;
  // BEST EFFORT ON THE MIRROR, and loud. The task row is authoritative, so a mirror that missed the
  // move is a stale listing rather than a wrong owner - recoverable on the next write, and worth
  // saying so rather than failing a handover that already happened.
  const task = await getTask(taskId, channelArn).catch(() => null);
  const assignee = task ? resolveTaskAssignee(task) : null;
  if (!assignee) return true;
  await dynamoClient.send(new UpdateCommand({
    TableName: USER_TASKS_TABLE,
    Key: { principalId: assignee.id, taskId },
    UpdateExpression: 'SET ownerPersonId = :o, updatedAt = :now',
    // CONDITIONAL, like the task write above and for the same reason. An `UpdateCommand` upserts, so
    // if the mirror row is absent - an earlier mirror write was swallowed, or the assignee resolved
    // differently - this creates one carrying `principalId`, `taskId`, `ownerPersonId` and nothing else: no
    // status, no ttl, no channel. It is filtered out of every read (a missing attribute fails the
    // status test) and never expires, which is the partial-row class the mirror's own
    // `if_not_exists` guards were added to eliminate.
    ConditionExpression: 'attribute_exists(taskId)',
    ExpressionAttributeValues: { ':o': ownerPersonId, ':now': now },
  })).catch((err: unknown) => {
    console.warn('[reassignTaskOwner] mirror update failed; the listing is stale:', (err as Error)?.message);
  });
  return true;
}

export async function getAssigneeChannelTasks(
  ownerId: string,
  channelArn: string,
  opts: OwnerChannelTaskOptions = {},
): Promise<OwnerChannelTasks> {
  const empty: OwnerChannelTasks = { live: [], recentlyEnded: [] };
  if (!USER_TASKS_TABLE || !ownerId || !channelArn) return empty;
  const endedCutoff = opts.endedWithinMs
    ? new Date(Date.now() - opts.endedWithinMs).toISOString()
    : undefined;
  try {
    // PAGINATED, WITH NO Limit - and the review that removed the Limit is worth remembering. The
    // status/channel FilterExpression runs AFTER the read, and the sort key is a random UUID, so
    // `Limit: 25` read 25 ARBITRARY rows and filtered them: once an owner's partition passed 25
    // accumulated rows (they persist to TTL, up to 200 days), the live active task could sit in the
    // unread remainder and this returned null - the chain never resumed, a duel side re-created its
    // task each turn, all silently, and directly under a comment saying a Limit would drop matches.
    // The partition is bounded by TTL, so the full read is bounded too; correctness over a cap.
    //
    // THE FILTER RUNS AFTER THE READ, which is what makes the ended half free: the rows are paid for
    // by the channel scan either way, so admitting the recently-ended ones adds no capacity, no
    // latency and no second query. It also has to be a filter and not a second lookup, because a
    // second lookup on this path would be a per-turn read bought for a rare turn.
    const statusFilter = endedCutoff
      ? '(#status IN (:pending, :inProgress) OR (#status IN (:completed, :failed, :cancelled) AND updatedAt > :since))'
      : '#status IN (:pending, :inProgress)';
    const rows: UserTask[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: USER_TASKS_TABLE,
        ConsistentRead: true,
        KeyConditionExpression: 'principalId = :owner',
        FilterExpression: `channelArn = :ch AND ${statusFilter}`,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':owner': ownerId,
          ':ch': channelArn,
          ':pending': 'pending',
          ':inProgress': 'in_progress',
          ...(endedCutoff
            ? { ':completed': 'completed', ':failed': 'failed', ':cancelled': 'cancelled', ':since': endedCutoff }
            : {}),
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      rows.push(...(((result.Items as UserTask[] | undefined) ?? [])));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    const newestFirst = rows.sort((a, b) =>
      String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
    // Partitioned by the SAME notion of an ending the writer uses (`TERMINAL_TASK_STATUS`), not by
    // `ACTIVE_TASK_STATUSES` - those differ on `abandoned`, which is deliberately not an ending
    // (the person may come back, §6), and putting it on the wrong side here would either resurrect a
    // paused task as live work or record it as a finished one.
    return {
      live: newestFirst.filter((t) => !TERMINAL_TASK_STATUS[t.status]),
      recentlyEnded: newestFirst.filter((t) => Boolean(TERMINAL_TASK_STATUS[t.status])),
    };
  } catch (error) {
    console.error('[getAssigneeChannelTasks] query failed:', error);
    return empty;
  }
}

/** What a caller learns about an item it named: enough to route the answer, nothing about the item. */
export interface AnswerableTask {
  taskId: string;
  assistantId?: string;
  private?: true;
}

/**
 * THE ONE PERMISSION CHECK BOTH SELECTORS RUN, so naming an item by id cannot reach work that naming
 * it by reference could not.
 *
 * May answer means the step awaits this person (they are the assignee) or they own the item. Null
 * otherwise, and a refusal is not told apart from a miss: the answer must not teach whose an item is.
 */
function answerableBy(found: Task, senderSub: string): AnswerableTask | null {
  // THE SAME STATUSES THE REFERENCE QUERY FILTERS ON, spelled here so the id selector cannot drift
  // into accepting a row the reference selector would not. `abandoned` is the one that makes this
  // more than a restatement: it is ACTIVE (`ACTIVE_TASK_STATUSES`) and not terminal, so a check
  // written as "not terminal" would let an id answer work a `#<n>` cannot reach.
  if (found.status !== 'pending' && found.status !== 'in_progress') return null;
  const assignee = resolveTaskAssignee(found);
  const mayAnswer = assignee?.id === senderSub || found.ownerPersonId === senderSub;
  if (!mayAnswer) return null;
  return {
    taskId: found.taskId,
    ...(found.assistantId ? { assistantId: found.assistantId } : {}),
    ...(isPrivateVisibility(found.visibility) ? { private: true as const } : {}),
  };
}

/**
 * THE OPEN ITEM AN ID NAMES, IF THIS PERSON MAY ANSWER IT.
 *
 * The same question {@link findAnswerableTaskByRef} answers, asked with the identifier a client holds
 * rather than the number a person types. A client that is showing an item knows its id, so it says
 * which item it means instead of writing a reference into the person's message for them - and an id
 * survives the renumbering a reference cannot (ADR-035's `#<n>` is allocated per conversation).
 *
 * A DIRECT READ, NOT A SCAN, and the key is the safety property: `{ taskId, channelArn }` is the
 * table's key, so an id belonging to another conversation misses rather than matching. Whether the
 * row may be answered at all is then settled by `answerableBy`, which both selectors share.
 */
export async function findAnswerableTaskById(
  channelArn: string,
  taskId: string,
  senderSub: string,
): Promise<AnswerableTask | null> {
  if (!TASKS_TABLE || !channelArn || !senderSub || !taskId) return null;
  try {
    const found = await getTask(taskId, channelArn);
    return found ? answerableBy(found, senderSub) : null;
  } catch (err) {
    console.warn('[task-tracking] id lookup failed', { err: (err as Error)?.message });
    return null;
  }
}

/** Every active task this owner holds in this channel, newest first. */
/**
 * THE OPEN ITEM A REFERENCE NAMES, IF THIS PERSON MAY ANSWER IT (ADR-035).
 *
 * The channel flow asks this before it routes a bare `#<n>` in a group conversation to an assistant,
 * so a member cannot start a turn in a room by typing `#` and a number. May answer means the step
 * awaits them (they are the assignee) or they own the item. Null for anything else: no such item, a
 * closed one, or someone else's - and the three are not told apart, so the answer cannot be used to
 * learn whose an item is.
 *
 * Over the conversation index, paginated with no `Limit`, for the reason every sibling read records:
 * the filter runs after the read.
 */
export async function findAnswerableTaskByRef(
  channelArn: string,
  taskRef: number,
  senderSub: string,
): Promise<AnswerableTask | null> {
  if (!TASKS_TABLE || !channelArn || !senderSub || !Number.isInteger(taskRef) || taskRef < 1) return null;
  try {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: TASKS_TABLE,
        IndexName: 'channelArn-updatedAt-index',
        KeyConditionExpression: 'channelArn = :ch',
        FilterExpression: 'taskRef = :ref AND #status IN (:pending, :inProgress)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ch': channelArn, ':ref': taskRef, ':pending': 'pending', ':inProgress': 'in_progress',
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      const found = ((result.Items as Task[] | undefined) ?? [])[0];
      if (found) return answerableBy(found, senderSub);
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return null;
  } catch (err) {
    console.warn('[task-tracking] reference lookup failed', { err: (err as Error)?.message });
    return null;
  }
}

export async function getActiveTasksForOwnerInChannel(
  ownerId: string,
  channelArn: string,
): Promise<UserTask[]> {
  return (await getAssigneeChannelTasks(ownerId, channelArn)).live;
}

/**
 * The newest active task this owner holds in this channel. DELEGATES to the plural lookup - the two
 * used to carry byte-identical hand-maintained queries, which is how the Limit-drops-matches defect
 * above could have been fixed in one and kept in the other. One query, one fix surface.
 */
export async function getActiveTaskForOwner(
  ownerId: string,
  channelArn: string,
): Promise<UserTask | null> {
  return (await getActiveTasksForOwnerInChannel(ownerId, channelArn))[0] ?? null;
}

/**
 * What a conversation member may see of a task (ADR-024 D4): the RECORD, not the text behind it.
 *
 * `userMessage` and `details` are deliberately absent. A task keeps a copy of the message that
 * started it, and nothing in the task path participates in redaction, so widening the read to every
 * member would surface text from a message the user watched disappear. Exposing the record instead
 * of the content is what makes a redaction cascade unnecessary rather than merely deferred - and it
 * is also what the assistant needs to say what is open here.
 */
export interface ConversationTask {
  taskId: string;
  channelArn: string;
  /**
   * The item's reference (ADR-035). Travels on a private row too: a reference says only that an item
   * exists, which the room may already see, and nothing about what it is.
   */
  taskRef?: number;
  taskType?: string;
  taskState?: string;
  status: TaskStatus;
  assigneeId?: string;
  assigneeType?: AssigneeType;
  dueBy?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * RELATIVE URGENCY, AND IT TRAVELS ON A PRIVATE ROW TOO (maintainer decision, 2026-09-01).
   *
   * Ordering is OCCUPANCY, not content: it says where this work sits against the rest of the list,
   * never what the work is. A private row is listed AS private and still takes its place, by the same
   * rule that already lets its existence and its assistant owner travel.
   *
   * It is here because without it the ranking is blind to half the list. "New work does not mean next
   * work": a queued request read later has to be prioritized against the items already recorded, and a
   * reading that cannot see where the private ones sit would either drop them from the order - which
   * is the position leak in the other direction - or rank around a list it knows to be incomplete.
   *
   * Absent reads as `normal`, the same default the task row carries.
   */
  priority?: TaskPriority;
  /**
   * TRUE ON A ROW THE VIEWER MAY KNOW EXISTS BUT NOT READ (maintainer decision, 2026-08-23): a private
   * task is visible in THAT it exists and is occupying an assistant, and invisible in WHAT it is.
   * On such a row every describing field (`taskType`, `taskState`, `dueBy`) is absent - stripped at
   * read time, never trusted to the caller to withhold. Absent means the viewer sees the full row.
   */
  private?: true;
  /**
   * TRUE ON EVERY PRIVATE ROW, including one the viewer may read. `private` above marks only the
   * redacted form, so a reader that must not repeat a private item's details where the room can read
   * (the open-work summary) needs this to tell a readable private row from a shared one.
   */
  privateItem?: true;
}

/**
 * THE CONVERSATION READ (ADR-024 D4): the open work in this conversation, whoever owns it.
 *
 * Visibility is scoped by conversation membership rather than by ownership - ownership decides who
 * must act next, never who can see - so this deliberately does not take an owner. Membership itself
 * is enforced by the caller's channel context, live and never from a stored roster copy.
 *
 * Newest first, bounded. Returns records with no message text; see ConversationTask.
 */
export async function getOpenTasksForConversation(
  channelArn: string,
  opts: {
    limit?: number;
    /**
     * WHO IS ASKING, as an app-instance principal id. A private task's DETAILS are returned only to
     * its requester or to the assistant that owns it; every other viewer receives the row with its
     * describing fields stripped and `private: true` (ADR-033, amended by the owner 2026-08-23:
     * existence is conversation-visible, details are not).
     *
     * OPTIONAL, AND THAT IS STILL THE SAFE DIRECTION: a caller that does not say who it is gets the
     * redacted form of every private row. An omitted viewer therefore under-returns DETAIL rather
     * than disclosing it - forgetting the argument can never publish a private request's content,
     * only its existence, which the room is entitled to see.
     */
    viewerId?: string;
  } = {},
): Promise<ConversationTask[]> {
  if (!TASKS_TABLE || !channelArn) return [];
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  try {
    // ── PAGINATED, BECAUSE `Limit` COUNTS ROWS READ AND NOT ROWS MATCHED (code review, 2026-09-11) ──
    //
    // This over-fetched `limit * 4` and filtered afterwards, which is the same defect this file
    // already records twice at its sibling reads - both of which dropped their `Limit` and paginate.
    // This one was the third instance and the one that matters most, because `/stop` reads it
    // through `selectStoppableTasks`: in a conversation with more finished rows than the cap, a
    // person could stop work that was genuinely running and be told there was nothing in progress.
    //
    // The caller's `limit` is a PAGE SIZE and is kept: it stops when it has that many MATCHES rather
    // than when it has read that many rows. Bounded either way - the partition is bounded by the
    // task TTL, and the loop stops at the first of "enough matches" or "no more pages".
    const all: Task[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: TASKS_TABLE,
        IndexName: 'channelArn-updatedAt-index',
        KeyConditionExpression: 'channelArn = :ch',
        FilterExpression: '#status IN (:pending, :inProgress)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':ch': channelArn,
          ':pending': 'pending',
          ':inProgress': 'in_progress',
        },
        ScanIndexForward: false, // newest first, by the index's sort key
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      all.push(...((result.Items as Task[] | undefined) ?? []));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey && all.length < limit);
    // THE VISIBILITY FILTER, applied before the limit so a private task cannot displace a visible one
    // from a caller's page and make the list look shorter than it is.
    // A PRIVATE TASK IS VISIBLE IN THAT IT EXISTS, INVISIBLE IN WHAT IT IS (maintainer decision,
    // 2026-08-23; this replaces the earlier rule that hid the row outright). Hiding it entirely
    // produced two live defects at once: the assistant it occupies looked idle to everyone else,
    // and the requester's own `/stop` - which reads this list through the same viewerless path -
    // could not find the work it was asked to stop, so "there's nothing in progress here" was said
    // over a task that kept running.
    //
    // WHO SEES THE FULL ROW is unchanged: the requester and the assistant whose work it is.
    // `resolveTaskAssignee` answers who owes the NEXT step, which changes hands at every awaits
    // boundary and is the wrong question here. Everyone else gets existence, occupancy and status,
    // with every describing field stripped AT READ TIME - never left for the caller to withhold.
    return all.slice(0, limit).map((t) => {
      // Absent reads as private (`task-visibility.ts`): a task written before its targeting was known
      // must not describe itself to the room.
      const isPrivate = isPrivateVisibility(t.visibility);
      // WHO MAY READ A PRIVATE TASK: its OWNER, its assigned assistant, and the person who asked.
      //
      // The owner is first because the owner is the role (ADR-024 D8). Gating on the requester alone
      // meant work handed to somebody else arrived with its contents withheld from the person now
      // responsible for it, which is not a handover.
      //
      // THE REQUESTER KEEPS ACCESS after handing ownership on. They wrote the request, so withdrawing
      // it hides a person's own words from them and protects nothing. It also covers every row written
      // before `ownerPersonId` existed, where the requester is the only owner the row can name.
      const mayReadDetails = !isPrivate
        || (!!opts.viewerId
          && (opts.viewerId === t.ownerPersonId
            || opts.viewerId === principalIdFromArn(t.userArn)
            || opts.viewerId === t.assistantId));
      const owner = resolveTaskAssignee(t);
      // Built field by field, NOT by deleting from the row: a spread-then-delete would leak every
      // future field by default, and the one thing this read must never carry is message content.
      return {
        taskId: t.taskId,
        channelArn: t.channelArn,
        ...(t.taskRef ? { taskRef: t.taskRef } : {}),
        status: t.status,
        // UNCONDITIONAL, like `status` and an assistant owner, and for the same reason: where work
        // sits in the order is occupancy. See ConversationTask.priority - stripping this would make
        // every ranking against the conversation's open work partial, while protecting nothing the
        // describing fields below do not already protect.
        ...(t.priority ? { priority: t.priority } : {}),
        ...(mayReadDetails && t.taskType ? { taskType: t.taskType } : {}),
        ...(mayReadDetails && t.taskState ? { taskState: t.taskState } : {}),
        // THE OWNER, WITHOUT HANDING OVER THE KEY.
        //
        // `mayReadDetails` unlocks on `viewerId` matching the requester or the owning assistant,
        // and for a private task with no explicit owner `resolveTaskAssignee` falls back to the
        // REQUESTER - so emitting `ownerId` unconditionally published the exact value that, passed
        // back as `viewerId`, unstrips the fields this read just stripped. The redaction handed out
        // its own key, and `adminListTasks` takes `viewerId` from its caller.
        //
        // An ASSISTANT owner still travels, because "which assistant this private work occupies" is
        // what the room is meant to learn (ADR-033) and an assistant id unlocks nothing it does not
        // already own. A USER owner is withheld on a row the caller may not read, while the TYPE
        // stays: that a person owes the next step is occupancy, not identity.
        ...(owner && (mayReadDetails || owner.type === 'assistant')
          ? { assigneeId: owner.id, assigneeType: owner.type }
          : {}),
        ...(owner && !mayReadDetails && owner.type !== 'assistant' ? { assigneeType: owner.type } : {}),
        ...(mayReadDetails && t.dueBy ? { dueBy: t.dueBy } : {}),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        ...(isPrivate && !mayReadDetails ? { private: true as const } : {}),
        ...(isPrivate ? { privateItem: true as const } : {}),
      };
    });
  } catch (error) {
    console.error('[getOpenTasksForConversation] query failed:', error);
    return [];
  }
}

/**
 * The prompt fragment for "what is open in this conversation" (ADR-024 D4).
 *
 * A SUMMARY, never content. It says what kind of work is open and who has to move it, so the
 * assistant can answer the question without replaying another member's task text - which it could
 * not do anyway, since the conversation read carries none.
 *
 * Owners are described by their RELATION to the viewer rather than by id. A principal id is opaque
 * to the model and useless in a sentence, and printing one into a prompt puts an identifier in front
 * of the model for no gain.
 *
 * `excludeTaskId` drops the task this turn is already resuming: that one is described in full by
 * `buildTaskContextForPrompt`, and listing it twice invites the model to treat it as two.
 */
export function buildConversationTasksHint(
  tasks: ConversationTask[],
  viewer: { id: string } | null,
  opts: { excludeTaskId?: string } = {},
): string {
  const unordered = (tasks ?? []).filter((t) => t.taskId !== opts.excludeTaskId);
  if (unordered.length === 0) return '';

  // SHOWN IN ORDER, because the list is what anything new has to be ranked AGAINST. Rendered by
  // recency it reads as arrival order, which is the inferred order `TaskPriority` exists to refuse -
  // and a reading asked to place new work against this list would be placing it against the wrong
  // one. Absent priority reads as `normal`, matching the row's own default.
  const rank: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
  const others = [...unordered].sort(
    (a, b) => rank[a.priority ?? 'normal'] - rank[b.priority ?? 'normal'],
  );

  const line = (t: ConversationTask): string => {
    // ── THE TYPE IS ASKED FIRST, BECAUSE IT OUTLIVES THE ID (code review, 2026-09-09) ────────────
    //
    // This tested `!t.assigneeId` first, which was right while the two always traveled together.
    // The private-row redaction above deliberately withholds `assigneeId` from a viewer who may not
    // read the row and deliberately KEEPS `assigneeType: 'user'` - "that a person owes the next step
    // is occupancy, not identity". Asking for the id first turned every one of those rows into
    // `unassigned`, which inverts the single fact the redaction went out of its way to preserve: the
    // model was told nobody holds the work, on the rows where somebody demonstrably does.
    //
    // Unassigned is the absence of BOTH. An owner with no readable id is held, by someone this
    // viewer is not entitled to name.
    const who = t.assigneeType === 'assistant'
      ? 'held by an assistant'
      : !t.assigneeType && !t.assigneeId
        ? 'unassigned'
        : !t.assigneeId
          ? 'held by a participant'
          : viewer && t.assigneeId === viewer.id
            ? 'held by the person you are talking to'
            : 'held by another participant';
    const state = t.taskState ? ` (${t.taskState})` : '';
    const due = t.dueBy ? `, due ${t.dueBy}` : '';
    // A REDACTED ROW SAYS SO, rather than masquerading as a "general" task. The viewer is entitled
    // to know the assistant is occupied and by private work; calling it anything more specific would
    // be inventing detail the read deliberately stripped (maintainer decision, 2026-08-23).
    // PRIORITY TRAVELS ON EVERY ROW, the redacted one included: it is where the work sits, not what
    // the work is. A private row that carried no priority would have to be ranked around rather than
    // ranked, which is the position leak this was meant to avoid, pointing the other way.
    const urgency = `, priority ${t.priority ?? 'normal'}`;
    if (t.private) return `- a private task (details not visible to you): ${who}${urgency}`;
    return `- ${t.taskType || 'general'}${state}: ${who}${due}${urgency}`;
  };

  return `
## OPEN WORK IN THIS CONVERSATION

${others.map(line).join('\n')}

Anyone in this conversation may ask about these. Only the holder can move one forward, so if someone asks about work they do not hold, say what its state is rather than continuing it. Do not quote the original request behind a task: you do not have it.
`;
}

/**
 * Cross-channel task discovery: return EVERY active task for this user,
 * regardless of channel or task type. Used by the agent handlers to
 * inject a "user has tasks open elsewhere" hint into the system prompt
 * so a user who started a multi-step workflow in conversation A can be
 * gently reminded of it when interacting in conversation B.
 *
 * Returns at most `opts.limit` rows (default 10, hard cap 25) ordered
 * by most-recently-updated first. Bounded so a user with many stale
 * not-yet-TTL'd tasks doesn't drag every turn.
 *
 * NOTE: this is intentionally a Query on the table's PK, not a Scan.
 * `UserTasksTable.PK = principalId` so the lookup is a constant-cost index
 * read per user, not a table scan.
 */
export async function getActiveTasksForUser(
  personId: string,
  opts: { limit?: number } = {},
): Promise<UserTask[]> {
  if (!USER_TASKS_TABLE) return [];

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);

  try {
    // PAGINATED, because `Limit` applies BEFORE the filter and the sort key is a task id.
    //
    // `Limit: limit * 4` read an arbitrary 40 rows and then filtered them, and the partition holds
    // every task this owner has had until TTL (up to 200 days) in id order - not time order. So a
    // user whose partition happened to start with 40 finished rows got NOTHING back, and the more
    // work someone had done the likelier that became. This read backs `/tasks/mine` and the
    // cross-channel prompt hint, so the symptom was open work vanishing for the heaviest users.
    //
    // Bounded by the same reasoning as `getAssigneeChannelTasks`: the partition is TTL-bounded, so the
    // full walk is bounded too, and a page cap stops early once enough ACTIVE rows are in hand.
    const rows: UserTask[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const result = await dynamoClient.send(new QueryCommand({
        TableName: USER_TASKS_TABLE,
        KeyConditionExpression: 'principalId = :principalId',
        FilterExpression: '#status IN (:pending, :inProgress)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':principalId': personId,
          ':pending': 'pending',
          ':inProgress': 'in_progress',
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      rows.push(...((result.Items as UserTask[] | undefined) ?? []));
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      pages += 1;
      // Enough ACTIVE rows to answer with, or a runaway partition. Either way stop: the caller wants
      // the newest `limit`, and a further page cannot change which those are once we hold more than
      // `limit` of them... except by recency, which is why the cap is generous rather than exact.
    } while (lastKey && rows.length < limit * 4 && pages < 10);

    rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return rows.slice(0, limit);
  } catch (error) {
    console.error('Error getting cross-channel tasks for user:', error);
    return [];
  }
}

/**
 * Build a brief system-prompt fragment telling the agent about tasks
 * the user has active in OTHER channels. Excludes tasks in
 * `currentChannelArn` (those are surfaced by the existing
 * `buildTaskContextForPrompt(task)` resume path, which is more
 * detailed).
 *
 * Returns an empty string when there are no cross-channel tasks — the
 * agent prompt should not carry a meta-section that says "nothing here."
 *
 * The hint is deliberately terse: count + task types only. Two reasons:
 *   1. We don't want the agent to leak channel content from
 *      conversations the user is no longer focused on.
 *   2. Channel name lookup would require an extra Chime
 *      `DescribeChannel` per other-channel task — too expensive on
 *      the critical path. If a deployer wants richer cross-channel
 *      hints, they can extend this helper.
 */
export function buildCrossChannelTasksHint(
  currentChannelArn: string,
  allActive: UserTask[],
): string {
  if (!Array.isArray(allActive) || allActive.length === 0) return '';

  const elsewhere = allActive.filter((t) => t.channelArn !== currentChannelArn);
  if (elsewhere.length === 0) return '';

  const typeCounts = new Map<string, number>();
  for (const t of elsewhere) {
    const key = t.taskType || 'general';
    typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
  }

  const breakdown = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
    .join(', ');

  return `
## OTHER ACTIVE WORK

The user has ${elsewhere.length} active task${elsewhere.length === 1 ? '' : 's'} in other conversations (${breakdown}).

Do NOT interrupt the current conversation to handle them. Only acknowledge them if the user's message references one (e.g. "what was I working on?"), in which case offer to pick the thread up there.
`;
}

/**
 * Update task status
 */
/**
 * The lifecycle statuses a task cannot leave, and what each one MEANS as an outcome.
 *
 * `abandoned` is deliberately absent: the person dropped out and may still come back, so it stays in
 * `ACTIVE_TASK_STATUSES` and a nudge can offer to resume it. A task is only ended here when nothing
 * further is expected of anyone.
 */
export const TERMINAL_TASK_STATUS: Partial<Record<TaskStatus, TerminalKind>> = {
  completed: 'success',
  failed: 'failure',
  cancelled: 'handoff',
};

/**
 * A TASK MUST SAY WHEN IT ENDED, and this is the writer that ends it.
 *
 * THE HOLE THIS CLOSES. `stateHistory` is the append-only record of a task's life, and every graph
 * transition appended to it - except the last one. A task could be set to `completed` here with no
 * entry written at all, so the row said it was finished and nothing said WHEN, by whom, or how. The
 * only timestamp left was `updatedAt`, which every write moves, so it cannot answer "when did this
 * end" a moment after anything else touches the row.
 *
 * WHY THAT MATTERS BEYOND TIDINESS. Task resolution is measured separately from turn latency, on
 * purpose: a task with `resolve_ms = 4h` and `agent_ms = 22s` is healthy, and only a stamped terminal
 * instant can say so. Without one, every ended task is a measurement gap - and gaps of this shape do
 * not error, they just quietly leave the population, which is the failure this file's guards exist to
 * prevent.
 *
 * ONE WRITER, NOT A NEW COLUMN. A `resolvedAt` field would be a second place for the same fact,
 * free to disagree with the history beside it. The entry appends to `stateHistory` like every other
 * transition, so a reader that already walks the log gets the ending for free.
 *
 * `by: 'system'` because this writer is not the model's `advance_task_state` call: it is the runtime
 * concluding the task, on a turn's completion or an error path.
 */
/**
 * Record that this task handed something over.
 *
 * Append-only via `list_append`, so two deliveries from one task both survive and a revision does not
 * erase the draft it replaced. `if_not_exists` seeds the list, because a task written before this field
 * existed has no attribute to append to.
 *
 * Best-effort by construction: the person already HAS the document by the time this runs, and losing a
 * note about it must never cost them the delivery. A failure here degrades to the behavior that
 * shipped before - an assistant that cannot see what it handed over.
 */
export async function recordTaskDelivery(
  taskId: string,
  channelArn: string,
  delivery: TaskDelivery,
): Promise<void> {
  if (!TASKS_TABLE) return;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression:
        'SET deliveries = list_append(if_not_exists(deliveries, :empty), :d), #updatedAt = :now',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: {
        ':empty': [],
        ':d': [delivery],
        ':now': new Date().toISOString(),
      },
      ConditionExpression: 'attribute_exists(taskId)',
    }));
  } catch (err) {
    console.warn('[task-tracking] could not record a delivery (non-fatal):', err);
  }
}

/**
 * Narrow a task to private. ONE WAY: it never widens one.
 *
 * A targeted request must produce a private task and a targeted answer (DESIGN 2.4). The task is
 * opened by the router, which cannot know: the channel flow callback carries no `Target` at all,
 * so targeting is only established later, in the processor, from the placeholder the flow posted.
 * This is how the decision reaches the row once it IS known.
 *
 * Narrowing only, deliberately. A bug that makes a private task public leaks a person's request
 * into the room and cannot be taken back; one that makes a public task private shows a member
 * less than they could have seen, which they can ask about. So this function cannot express the
 * dangerous direction.
 */
export async function markTaskPrivate(taskId: string, channelArn: string): Promise<void> {
  if (!TASKS_TABLE || !taskId || !channelArn) return;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression: 'SET visibility = :private, updatedAt = :now',
      ExpressionAttributeValues: { ':private': 'private', ':now': new Date().toISOString() },
    }));

    // ── AND THE MIRROR, because a narrowing that reaches one table is not a narrowing ───────────
    //
    // The composer decides how to ADDRESS an answer from the mirror row: an item it reads as
    // `conversation` is answered with a public mention, anything else with a target. So a task
    // created conversation-visible and later narrowed here left the mirror saying `conversation`,
    // and every later answer about it went to the room - undoing the privacy the person had just
    // chosen by targeting their message.
    //
    // Keyed through the OWNER rather than by scanning for the id: the mirror is partitioned by
    // owner and carries no index on `taskId`, so the row is reachable only once the task says whose
    // it is. That is a read of the row this just wrote, which is also what makes it current.
    const narrowed = await getTask(taskId, channelArn);
    const owner = narrowed ? resolveTaskAssignee(narrowed) : null;
    if (USER_TASKS_TABLE && owner) {
      await dynamoClient.send(new UpdateCommand({
        TableName: USER_TASKS_TABLE,
        Key: { principalId: owner.id, taskId },
        UpdateExpression: 'SET visibility = :private',
        // Only where the row exists: a mirror is written for an owner, and a task whose owner has
        // changed hands has no row under the old one.
        ConditionExpression: 'attribute_exists(taskId)',
        ExpressionAttributeValues: { ':private': 'private' },
      })).catch((err: unknown) => {
        if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') return;
        console.error('[task-tracking] could not narrow the mirror row', {
          taskId, message: (err as Error)?.message,
        });
      });
    }
  } catch (err) {
    // Best effort in the sense that it must not break the turn, and NOT in the sense that it does
    // not matter: a task left conversation-visible after a targeted request is the leak this
    // exists to prevent, so it is logged loudly rather than swallowed.
    console.error('[task-tracking] could not narrow a task to private', {
      taskId, message: (err as Error)?.message,
    });
  }
}

export async function updateTaskStatus(
  taskId: string,
  channelArn: string,
  status: TaskStatus,
  result?: string,
  error?: string
): Promise<void> {
  if (!TASKS_TABLE) return;

  const now = new Date().toISOString();

  try {
    const updateExpression = ['SET #status = :status', '#updatedAt = :updatedAt'];
    const expressionAttributeNames: Record<string, string> = {
      '#status': 'status',
      '#updatedAt': 'updatedAt',
    };
    const expressionAttributeValues: Record<string, string> = {
      ':status': status,
      ':updatedAt': now,
    };

    if (result !== undefined) {
      updateExpression.push('#result = :result');
      expressionAttributeNames['#result'] = 'result';
      expressionAttributeValues[':result'] = result;
    }

    if (error !== undefined) {
      updateExpression.push('#error = :error');
      expressionAttributeNames['#error'] = 'error';
      expressionAttributeValues[':error'] = error;
    }

    // THE ENDING, APPENDED. `list_append` over `if_not_exists` covers a task whose machine never wrote
    // a transition (a lightweight single-turn task has no graph), so the terminal entry is the whole
    // history rather than being dropped for want of a list to append to.
    // DECLARED ONLY WHERE THE EXPRESSION USES THEM. A value no expression references is rejected by
    // DynamoDB outright, which is a defect this file has already paid for once.
    if (!TERMINAL_TASK_STATUS[status]) {
      expressionAttributeValues[':tCompleted'] = 'completed';
      expressionAttributeValues[':tFailed'] = 'failed';
      expressionAttributeValues[':tCancelled'] = 'cancelled';
    }

    const terminalKind = TERMINAL_TASK_STATUS[status];
    if (terminalKind) {
      const terminalEntry: StateTransition = {
        at: now,
        by: 'system',
        // NOT a graph edge: `from`/`to` name states in a machine, and this records the LIFECYCLE
        // ending, which a machine-less task also has. Reading it as an edge is the mistake ADR-024 D3
        // avoided for ownership entries in this same log, and it is avoided the same way here.
        terminal: terminalKind,
        reason: error !== undefined ? `task ${status}: ${error}`.slice(0, 300) : `task ${status}`,
      };
      // NO SEPARATE `resolvedAt` COLUMN, deliberately. A scalar beside the log would be a second place
      // for one fact, free to disagree with the entry describing it - and the log already holds
      // per-transition instants, so the ending is readable from the record that was always the record.
      updateExpression.push('#stateHistory = list_append(if_not_exists(#stateHistory, :empty), :terminalEntry)');
      expressionAttributeNames['#stateHistory'] = 'stateHistory';
      (expressionAttributeValues as Record<string, unknown>)[':terminalEntry'] = [terminalEntry];
      (expressionAttributeValues as Record<string, unknown>)[':empty'] = [];
    }

    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      // AN UPDATE, NOT AN UPSERT. DynamoDB creates the item when the key is absent, so a mistyped
      // or stale task id wrote a stub row carrying nothing but a status - a task that never existed,
      // in the table the operator console reads. The condition makes a wrong id a failure, which is
      // what it always was.
      // AN ENDING IS NOT REOPENED BY A LATE WRITE.
      //
      // This call is dispatched asynchronously, and an async invoke is neither ordered nor
      // exactly-once: a throttled `in_progress` that Lambda retries can land AFTER the `completed`
      // that followed it. With only `attribute_exists` to satisfy, that write won.
      //
      // The damage outlives the moment. The mirror row is written on terminal statuses only, so the
      // two tables then disagree permanently, and the resurrected task stays in
      // `getOpenTasksForConversation` for the rest of its TTL - to the person, work that never
      // finishes; to the operator, a queue that is losing nothing and completing nothing.
      //
      // A terminal write may still overwrite a terminal one: a cancel racing a completion is a real
      // decision either way and both are endings. What is refused is going BACKWARDS.
      ConditionExpression: TERMINAL_TASK_STATUS[status]
        ? 'attribute_exists(taskId)'
        : 'attribute_exists(taskId) AND (attribute_not_exists(#status) OR NOT #status IN (:tCompleted, :tFailed, :tCancelled))',
      UpdateExpression: updateExpression.join(', '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }));

    console.log(`Task ${taskId} updated to status: ${status}`, terminalKind ? { terminalKind, endedAt: now } : {});

    // AND THE QUEUE HAS TO LEARN IT ENDED. `/tasks/mine` reads the MIRROR, not this row, and nothing
    // propagated an ending to it: only `pauseTask` and `resumeTask` mirrored, so a task that COMPLETED
    // kept its mirror row at `in_progress` for the whole of its TTL. Measured on the deployment: one
    // test user held nine "open" items, finished ones among them.
    //
    // That is not a cosmetic queue defect. The composer addresses a person's next message at the
    // assistant holding their open item (ADR-032), so a queue that never lets go would point a reply
    // at work that is already done - a wrong answer arriving for a right-looking reason.
    //
    // TERMINAL STATUSES ONLY, so this stays off the per-turn path: `in_progress` is written on every
    // task turn and mirroring it would put a read and a write on each one, to restate what the mirror
    // already says. An ending happens once.
    if (terminalKind) {
      const ended = await getTask(taskId, channelArn);
      if (ended) await mirrorTaskStatus(ended, status);
    }
  } catch (updateError) {
    // A NON-TERMINAL WRITE ONTO AN ENDED TASK IS REFUSED BY DESIGN (the condition above), and it is an
    // ordinary event, not a fault: a follow-up turn on a recently finished report starts by marking its
    // task `in_progress`, and the task stays ended unless the turn reopens it, which the reopen edge
    // does in its own write (`advanceTaskStateTo`). Logged as what it is, so a real failure still
    // stands out as one.
    if (!TERMINAL_TASK_STATUS[status] && (updateError as { name?: string })?.name === 'ConditionalCheckFailedException') {
      console.warn(`[task-tracking] ${taskId}: the ${status} write was refused because the task has ended or does not exist`);
      return;
    }
    console.error('Error updating task status:', updateError);
  }
}

/**
 * Pure: of the given task rows, the ids to cancel — those that are ACTIVE and (when `itemId` is given)
 * anchored to that work item. Omit `itemId` to select every active task (a plan-level cancel).
 */
export function selectTasksToCancel(
  tasks: Array<{ taskId: string; status: TaskStatus; itemId?: string }>,
  itemId?: string,
): string[] {
  return tasks
    .filter(
      (t) =>
        (ACTIVE_TASK_STATUSES as readonly string[]).includes(t.status) &&
        (!itemId || t.itemId === itemId),
    )
    .map((t) => t.taskId);
}

/**
 * Cascade-cancel a plan's open tasks when a work item is dropped.
 * Queries the agent-tasks `contextId-index`, selects ACTIVE tasks for `itemId` (or ALL the plan's
 * tasks when `itemId` is omitted — a plan delete), and marks them `cancelled` in BOTH tables (the
 * user-tasks mirror too, so a cancelled task can't resurface via getActiveTask). Best-effort +
 * idempotent — a missing task is not an error. Returns the number cancelled.
 */
/**
 * Cancel ONE task in both tables: the task row and the per-user mirror.
 *
 * Extracted because a second caller appeared. The mirror matters as much as the row - `getActiveTask`
 * reads it, so a task cancelled in one table and not the other comes back to life on the next turn,
 * which is worse than never having cancelled it. Keeping that pairing in one place is the point.
 */
async function cancelOneTask(
  task: { taskId: string; channelArn: string }
    & Partial<Pick<Task, 'ownerId' | 'ownerType' | 'assignedBotArn' | 'assigneePersonId' | 'userArn'>>,
): Promise<void> {
  await updateTaskStatus(task.taskId, task.channelArn, 'cancelled');
  const personId = resolveTaskAssignee(task)?.id || '';
  if (!USER_TASKS_TABLE || !personId) return;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: USER_TASKS_TABLE,
      Key: { principalId: personId, taskId: task.taskId },
      UpdateExpression: 'SET #s = :c, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':c': 'cancelled', ':now': new Date().toISOString() },
    }));
  } catch (e) {
    console.warn('[task-tracking] user-task mirror cancel failed:', e);
  }
}

/**
 * STOP THE WORK IN THIS CONVERSATION - every active task this person holds here.
 *
 * The way out of a task that is not going anywhere, and the reason the runtime can safely decline to
 * start a second turn on work it is already doing: a person who is told "I am still working on that"
 * must have something to say when the answer is "no you are not". Without this, declining would make a
 * stalled task unanswerable, which is a worse failure than the duplicate turn it prevents.
 *
 * Scoped to the CHANNEL and to the OWNER, so stopping work here never reaches into another
 * conversation or cancels somebody else's task. Returns what it cancelled, so the reply can name it
 * rather than claiming something vague happened.
 */
export async function cancelActiveTasksInChannel(
  channelArn: string,
  requesterPersonId: string,
  /**
   * WHICH ASSISTANT'S WORK, when the stop named one (ADR-033). Omitted means every assistant's, which
   * is the pre-targeting behavior and is still correct for a caller that has no target to give.
   *
   * MATCHED ON `assistantId`, not on the owner, for the reason the block below already gives about
   * the requester: ownership moves between the person and the assistant at every step boundary, so an
   * owner-scoped filter would miss a task at exactly the moment somebody wants to stop it.
   * `assistantId` is "whose work this is" and does not move.
   */
  assistantId?: string,
): Promise<ConversationTask[]> {
  if (!TASKS_TABLE || !channelArn || !requesterPersonId) return [];
  const cancelled: ConversationTask[] = [];
  try {
    // SCOPED TO WHO STARTED THE WORK, which is neither of the two things the first attempts used.
    //
    // NOT by current OWNER: by the time somebody needs to stop, they do not own it. Their answer handed
    // the task to the assistant (`applyUserResponseToTask` -> `reassignTask`), which is the very
    // mechanism that lets the runtime know a turn is owed. An owner-scoped stop found nothing and told
    // the person there was nothing in progress, while the task it could not see held the conversation.
    //
    // NOT by CHANNEL either: a conversation can carry work several people asked for, and stopping
    // "everything here" would cancel somebody else's report because a different person typed `/stop`.
    //
    // The requester is stable for the life of the task - ownership moves between the person and the
    // assistant at every step boundary, and the person who ASKED does not change. That is the one who
    // gets to call it off.
    //
    // Read per task rather than from the listing, which projects a shape without the requester on it.
    // The count is bounded (a conversation with more than a handful of open tasks is already a problem
    // this cannot fix) and being right about whose work is being cancelled is worth the reads.
    for (const { summary, full } of await selectStoppableTasks(channelArn, requesterPersonId, assistantId)) {
      await cancelOneTask(full);
      cancelled.push(summary);
    }
  } catch (err) {
    console.error('[task-tracking] cancelActiveTasksInChannel failed:', err);
  }
  return cancelled;
}

/**
 * The work a `/stop` from this person, aimed at this assistant, would be about.
 *
 * SPLIT OUT SO A STOP CAN NAME THE WORK WITHOUT DESTROYING IT (ADR-033). Stopping is immediate;
 * discarding is confirmed, so the turn that suppresses the answer needs to describe what it held in
 * order to ask about it, and describing is not deciding. Sharing the selection with the cancellation
 * is the point: a stop that asked about one set of tasks and then cancelled a different set would be
 * the worst possible outcome of adding a confirmation step.
 */
export async function selectStoppableTasks(
  channelArn: string,
  requesterPersonId: string,
  assistantId?: string,
): Promise<Array<{ summary: ConversationTask; full: Task }>> {
  if (!TASKS_TABLE || !channelArn || !requesterPersonId) return [];
  const picked: Array<{ summary: ConversationTask; full: Task }> = [];
  // THE REQUESTER IS THE VIEWER, and the argument is load-bearing: without it their own private task
  // came back redacted-by-existence only... and before existence-visibility, not at all - so `/stop`
  // told a person "there's nothing in progress here" over a private task that kept running. The
  // requester may always see their own work in full, and only their own survives the filter below.
  const open = await getOpenTasksForConversation(channelArn, { limit: 25, viewerId: requesterPersonId });
  // THE FULL READS RUN TOGETHER. This sits on the `/stop` acknowledgment's own path, and each read
  // asks about a different task, so running them in series was paying the list's length in round
  // trips at the one moment the design promises immediacy. `Promise.all` keeps result order equal
  // to the list's order, so `picked` is unchanged in everything but wall clock.
  const fulls = await Promise.all(open.map((summary) => getTask(summary.taskId, channelArn)));
  for (let i = 0; i < open.length; i++) {
    const summary = open[i];
    const full = fulls[i];
    const startedBy = personIdFromArn(full?.userArn) || '';
    if (!full || startedBy !== requesterPersonId) continue;
    // A TARGETED STOP LEAVES THE OTHER ASSISTANTS ALONE. Without this the person who stopped the
    // one writing a report also cancels the one halfway through an unrelated lookup, which is work
    // nobody asked to lose in a room where they cannot see what else was running.
    if (assistantId && full.assistantId !== assistantId) continue;
    // THE QUEUE IS NOT THE WORK IN PROGRESS (ADR-033, "`/stop` does not touch the queue"). Two kinds of
    // row are the queue rather than what the assistant is doing, and both were selected here because
    // they carry the person as requester and the stopped assistant as `assistantId`:
    //  - the DRAIN, which is the reading of the queue. Cancelling it named "the queue" as stopped work
    //    in the acknowledgment and the question, and closed the row the resolution timing reads.
    //  - a queued request not yet begun: triage's proposal (`proposed`) or question (`asked`), which
    //    is a message the person sent while they waited and never withdrew. "The headcount question is
    //    still a question" - discarding it is the data loss the ADR rules out.
    // Once a queued request is ACCEPTED it is work in progress like any other, and a stop cancels it.
    if (isQueueNotWork(full)) continue;
    picked.push({ summary, full });
  }
  return picked;
}

/**
 * The queue's own rows, which a stop leaves alone. Literals rather than the exported constants because
 * `queue-drain-task.ts` imports this module; `a-stop-leaves-the-queue-tasks.test.ts` pins them equal.
 */
const QUEUE_DRAIN_TYPE = 'queue_drain';
const QUEUED_ITEM_TYPES = new Set(['queued_request', 'queued_clarification', 'queued_combination']);

function isQueueNotWork(task: Pick<Task, 'taskType' | 'taskState'>): boolean {
  if (task.taskType === QUEUE_DRAIN_TYPE) return true;
  if (!task.taskType || !QUEUED_ITEM_TYPES.has(task.taskType)) return false;
  // Not begun means still in the machine's first state, which for every queued type awaits the person.
  // A row with no recorded state was never moved, so it is in that state too.
  const initial = packTaskStateMachines()[task.taskType]?.initial;
  return !task.taskState || task.taskState === initial;
}

/**
 * Discard exactly the work a stop named, by id.
 *
 * BY ID, NOT BY CHANNEL. `cancelTasksForStop` below takes everything under a context, which is right
 * for a stop that decides in the same breath. This one settles a question asked EARLIER: the ids were
 * recorded when the person was asked, and cancelling anything else would discard work that arrived
 * between the question and their answer - work they were never asked about.
 *
 * THROUGH `cancelOneTask`, which is the whole reason this is not a loop over `updateTaskStatus`: the
 * per-user mirror has to go with the row. `getActiveTask` reads the mirror, so a task cancelled in
 * one table and not the other comes back to life on the next turn.
 */
export async function cancelStoppedTasks(channelArn: string, taskIds: string[]): Promise<number> {
  if (!TASKS_TABLE || !channelArn || !taskIds.length) return 0;
  let cancelled = 0;
  for (const taskId of taskIds) {
    try {
      const full = await getTask(taskId, channelArn);
      // ALREADY GONE IS NOT A FAILURE. They may have cancelled it themselves, or it may have finished
      // between the question and the answer - and finished work is KEPT.
      if (!full || full.status === 'completed' || full.status === 'cancelled') continue;
      await cancelOneTask(full);
      cancelled++;
    } catch (err) {
      console.error('[cancelStoppedTasks] could not cancel', { taskId, err: (err as Error)?.message });
    }
  }
  return cancelled;
}

export async function cancelTasksForStop(contextId: string, itemId?: string): Promise<number> {
  if (!TASKS_TABLE || !contextId) return 0;
  let cancelled = 0;
  try {
    const q = await dynamoClient.send(new QueryCommand({
      TableName: TASKS_TABLE,
      IndexName: 'contextId-index',
      KeyConditionExpression: 'contextId = :t',
      ExpressionAttributeValues: { ':t': contextId },
    }));
    const tasks = (q.Items as Task[] | undefined) ?? [];
    const byId = new Map(tasks.map((t) => [t.taskId, t]));
    for (const id of selectTasksToCancel(tasks, itemId)) {
      await cancelOneTask(byId.get(id)!);
      cancelled++;
    }
  } catch (err) {
    console.error('[cancelTasksForStop] query/cancel failed:', err);
  }
  return cancelled;
}

/**
 * Mirror a status change into the `user-tasks` index so getActiveTask (which filters on the mirror's
 * status) reflects it. The agent-tasks row is the source of truth; this keeps the convenience index
 * consistent. Best-effort — a mirror miss never blocks the source-of-truth update.
 */
async function mirrorTaskStatus(task: Task, status: TaskStatus): Promise<void> {
  await mirrorTask(task, { status });
}

/**
 * What a mirror write carries: the fields of the task row the `user-tasks` copy restates and its
 * readers act on. `status` is what the live-task lookups filter on; `taskState` is the step the chat
 * app's list, `open_work_summary` and the Tasks console name and read the awaited party from; `details`
 * is the record a state change may merge into.
 */
interface MirrorChange {
  status?: TaskStatus;
  taskState?: string;
  details?: Record<string, unknown>;
}

/**
 * THE ONE MIRROR WRITE. Every change the copy restates goes through here, so the copy and the task
 * row move together and the copy has one shape.
 *
 * `onlyIfPresent` updates a copy that exists and never creates one. A state change on a task that was
 * written without a copy - an event task with no requester has no person to list it for - leaves it
 * without one, and the condition that says so is the expected outcome rather than a fault. Without it
 * the write is the upsert the status writers rely on to heal a lost copy.
 */
async function mirrorTask(task: Task, change: MirrorChange, opts: { onlyIfPresent?: boolean } = {}): Promise<void> {
  if (!USER_TASKS_TABLE) return;
  const owner = resolveTaskAssignee(task);
  if (!owner) return;
  // Empty is treated as absent below: it is an index key, and an index key cannot be empty.
  const ownerPersonIdValue = task.ownerPersonId || personIdFromArn(task.userArn) || '';
  try {
    // An UPSERT, so it must write a WHOLE row. It used to set only `status` and `updatedAt`: when the
    // key it computed differed from the one `createTask` had written under - which it did, one keying
    // on the assignee and the other on the requester - this created a second row carrying nothing
    // else. No `ttl`, so it never expired; no `taskType`, so it was invisible to the lookup GSI; no
    // `channelArn`, so the channel-scoped filter dropped it. One owner removes the divergence, and
    // `if_not_exists` removes the partial row even if a mirror write was ever lost.
    await dynamoClient.send(new UpdateCommand({
      TableName: USER_TASKS_TABLE,
      Key: { principalId: owner.id, taskId: task.taskId },
      // ── A WHOLE ROW MEANS EVERY FIELD A READ KEYS ON (code review, 2026-09-04) ────────────
      //
      // Two of them were missing after D8 and the upsert reasoning above is exactly why it matters:
      // this path can RECREATE a row. Without `ownerPersonId` and `assistantId` the row it recreates is
      // invisible to both indexes D8 added - the owner listing and the referent read - so a task
      // healed here silently stops being findable by the questions those exist to answer.
      //
      // And it wrote `ownerType`, the pre-D8 name, while the field's own annotation says it is never
      // written. A row created by the mirror write and later touched here carried both names; one
      // healed only here carried only the deprecated one. That is what would have kept the
      // `assigneeType ?? ownerType` fallbacks alive past the TTL window the "no backfill" argument
      // depends on.
      UpdateExpression:
        'SET updatedAt = :now, assigneeType = :at'
        + (change.status ? ', #s = :s' : '')
        + (change.taskState ? ', taskState = :ts' : '')
        + (change.details ? ', details = :details' : '')
        + ', taskType = if_not_exists(taskType, :tt)'
        + ', channelArn = if_not_exists(channelArn, :ch)'
        + ', createdAt = if_not_exists(createdAt, :created)'
        + ', #ttl = if_not_exists(#ttl, :ttl)'
        // ── ONLY WHEN THERE IS A VALUE, BECAUSE THESE TWO ARE INDEX KEYS ────────────────────────
        //
        // `ownerPersonId` is the hash key of `ownerPersonId-index` and `assistantId` the range key of
        // `channelArn-assistantId-index`. DynamoDB refuses an empty string in an index key and fails
        // the WHOLE UpdateItem, which the catch below swallows - so writing `''` here would mean a
        // task with no assistant never got its terminal status mirrored at all, reinstating the exact
        // defect the note above records fixing: finished work sitting in someone's list, with the
        // composer addressing replies at a completed task.
        //
        // Conditional on the value existing rather than defaulted, and `if_not_exists` on top of that
        // because an owner handover writes `ownerPersonId` here directly: a status mirror must not undo it.
        + (ownerPersonIdValue ? ', ownerPersonId = if_not_exists(ownerPersonId, :os)' : '')
        + (task.assistantId ? ', assistantId = if_not_exists(assistantId, :aid)' : '')
        // The reference a person types, so a row healed here stays answerable by it (ADR-035).
        + (task.taskRef ? ', taskRef = if_not_exists(taskRef, :ref)' : '')
        // What a resumed turn routes and is served by (ADR-064 decisions B and J), so a copy healed here keeps them.
        + (task.openingIntent ? ', openingIntent = if_not_exists(openingIntent, :oi)' : '')
        + (task.experimentArm ? ', experimentArm = if_not_exists(experimentArm, :arm)' : ''),
      ...(opts.onlyIfPresent ? { ConditionExpression: 'attribute_exists(taskId)' } : {}),
      ExpressionAttributeNames: { ...(change.status ? { '#s': 'status' } : {}), '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ...(change.status ? { ':s': change.status } : {}),
        ...(change.taskState ? { ':ts': change.taskState } : {}),
        ...(change.details ? { ':details': change.details } : {}),
        ':now': new Date().toISOString(),
        ':at': owner.type,
        ':tt': task.taskType || 'general',
        ':ch': task.channelArn,
        ':created': task.createdAt,
        ':ttl': task.ttl,
        ...(ownerPersonIdValue ? { ':os': ownerPersonIdValue } : {}),
        ...(task.assistantId ? { ':aid': task.assistantId } : {}),
        ...(task.taskRef ? { ':ref': task.taskRef } : {}),
        ...(task.openingIntent ? { ':oi': task.openingIntent } : {}),
        ...(task.experimentArm ? { ':arm': task.experimentArm } : {}),
      },
    }));
  } catch (e) {
    if (opts.onlyIfPresent && (e as { name?: string })?.name === 'ConditionalCheckFailedException') return;
    console.warn('[mirrorTask] user-task mirror update failed:', e);
  }
}

/**
 * INTERRUPT — pause an active multi-step task so the user can step out of the sequence and return later.
 * Marks it `abandoned` in BOTH tables, so getActiveTask (pending|in_progress only) stops returning it
 * and subsequent turns are handled normally instead of being folded back into the task. The task's
 * `taskState` is deliberately left untouched, so a later resumeTask picks up exactly where it left off.
 * No-op if the task is gone or already closed (completed/failed/cancelled). Best-effort.
 */
export async function pauseTask(taskId: string, channelArn: string): Promise<boolean> {
  const task = await getTask(taskId, channelArn);
  if (!task) return false;
  if (!(ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)) return false;
  await updateTaskStatus(taskId, channelArn, 'abandoned');
  await mirrorTaskStatus(task, 'abandoned');
  return true;
}

/**
 * RESUME — re-enter a paused/abandoned task at its saved state ("pick up where you left off").
 * Flips the status back to `in_progress` in BOTH tables WITHOUT touching `taskState`, so the flow
 * resumes from the exact step the user left. Returns the task (with its preserved `taskState`) for the
 * caller to re-prime the turn, or null when there is nothing resumable (missing, or already
 * completed/failed/cancelled — we never resurrect a closed task).
 */
export async function resumeTask(taskId: string, channelArn: string): Promise<Task | null> {
  const task = await getTask(taskId, channelArn);
  if (!task) return null;
  const resumable: readonly TaskStatus[] = ['abandoned', 'pending', 'in_progress'];
  if (!resumable.includes(task.status)) return null;
  await updateTaskStatus(taskId, channelArn, 'in_progress');
  await mirrorTaskStatus(task, 'in_progress');
  return { ...task, status: 'in_progress' };
}

/**
 * REASSIGN — hand a task to a different owner, human or assistant (ADR-024 D1/D3).
 *
 * WIRED, as of the `awaits` boundary: `maybeHandOver` below calls this when a task's state starts
 * or stops being blocked on a person, which is the "work-item flow" this was left waiting for. It
 * shipped unwired on purpose from 2026-08-09 (documented and covered, unlike `updateTaskAssignee`,
 * which it replaced and which was uncalled by ACCIDENT), so nobody had to guess whether reassignment
 * worked or had simply never run.
 *
 * One thing the earlier note flagged is still true and still accepted: the hand-off is SILENT. Nothing
 * tells the person in the conversation that an item is now theirs; they find it in the queue.
 *
 * Updates the `agent-tasks` row through `setTaskAssignee`, appends the change to the task log, and MOVES
 * the mirror: that table is partitioned by the owner, so a reassignment is a delete-old + put-new (a
 * plain update cannot move a partition key). The old row is deleted LAST, so a failure mid-way leaves
 * the task findable under both owners rather than under neither.
 *
 * The one-owner invariant holds by construction: there is one field pair and one writer, so handing a
 * task over cannot leave the previous owner also holding it.
 */
export async function reassignTask(
  taskId: string,
  channelArn: string,
  owner: TaskAssignee,
): Promise<void> {
  if (!TASKS_TABLE || !owner?.id) return;
  const now = new Date().toISOString();
  let prev: Task | null = null;
  const fields = setTaskAssignee(owner);
  try {
    prev = await getTask(taskId, channelArn);
    if (!prev) return;
    const from = resolveTaskAssignee(prev);
    if (from && from.id === owner.id && from.type === owner.type) return; // already there
    // The ownership change is an entry in the SAME log as state transitions (D3), carrying
    // ownerFrom/ownerTo and NO from/to: a reassignment is not a graph edge, and a consumer that reads
    // `from` must get nothing rather than a principal id in a field every other reader treats as a
    // state name. It touches neither `taskState` nor `turnsInState` — counting it as a transition
    // would clear the stall signal on a task that was handed over but never progressed.
    const entry: StateTransition = {
      ...(from ? { ownerFrom: `${from.type}:${from.id}` } : {}),
      ownerTo: `${owner.type}:${owner.id}`,
      at: now,
      by: 'system',
    };
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression:
        // The new names, and the old attributes are left where they are rather than removed: a
        // row mid-migration keeps whatever it already had, and `resolveTaskAssignee` prefers the new
        // pair, so the stale copy is unreachable rather than contradictory.
        'SET assigneeId = :oid, assigneeType = :otype, updatedAt = :now'
        + ', stateHistory = list_append(if_not_exists(stateHistory, :empty), :entry)',
      ExpressionAttributeValues: {
        ':oid': fields.assigneeId,
        ':otype': fields.assigneeType,
        ':now': now,
        ':empty': [] as StateTransition[],
        ':entry': [entry],
      },
    }));
  } catch (err) {
    console.error('[reassignTask] agent-tasks update failed:', err);
    return;
  }
  if (!USER_TASKS_TABLE) return;
  const oldSub = resolveTaskAssignee(prev)?.id || '';
  if (oldSub === owner.id) return; // same partition; nothing to move
  try {
    await putMirrorRow({ ...prev, ...fields, updatedAt: now });
    if (oldSub) {
      await dynamoClient.send(new DeleteCommand({
        TableName: USER_TASKS_TABLE,
        Key: { principalId: oldSub, taskId },
      }));
    }
  } catch (err) {
    console.warn('[reassignTask] user-tasks mirror move failed (non-fatal):', err);
  }
}

/** Stamp `lastRemindedAt` so the scheduled reminder doesn't re-fire within its cooldown. Best-effort. */
export async function markTaskReminded(
  taskId: string,
  channelArn: string,
  whenISO: string = new Date().toISOString(),
): Promise<void> {
  if (!TASKS_TABLE) return;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression: 'SET lastRemindedAt = :r, updatedAt = :now',
      ExpressionAttributeValues: { ':r': whenISO, ':now': whenISO },
    }));
  } catch (err) {
    console.warn('[markTaskReminded] update failed (non-fatal):', err);
  }
}

/**
 * Scan `agent-tasks` for ACTIVE tasks that carry a `dueBy` (the candidate set for due-date reminders,
 * across ALL plans). A Scan is fine at the current scale (dark-launch / internal) and is bounded by a
 * server-side FilterExpression so it returns only the relevant rows; the scale path is a sparse
 * `dueBy`-sorted GSI (only dated tasks indexed) — documented, not built. Paginates fully.
 */
export async function scanActiveDueTasks(): Promise<Task[]> {
  if (!TASKS_TABLE) return [];
  const out: Task[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const r: { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> } = await dynamoClient.send(new ScanCommand({
        TableName: TASKS_TABLE,
        FilterExpression: 'attribute_exists(dueBy) AND attribute_exists(contextId) AND #s IN (:p, :i, :a)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':p': 'pending', ':i': 'in_progress', ':a': 'abandoned' },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      out.push(...((r.Items as Task[] | undefined) ?? []));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  } catch (err) {
    console.error('[scanActiveDueTasks] scan failed:', err);
  }
  return out;
}

/**
 * Advance task to next state in the state machine
 */
export async function advanceTaskState(
  taskId: string,
  channelArn: string,
  taskType: string,
  details?: Record<string, unknown>
): Promise<string | null> {
  if (!TASKS_TABLE) return null;

  const task = await getTask(taskId, channelArn);
  if (!task) return null;

  const states = TASK_STATE_MACHINES[taskType];
  if (!states || !task.taskState) return null;

  const currentIndex = states.indexOf(task.taskState);
  if (currentIndex === -1 || currentIndex >= states.length - 1) return null;

  const nextState = states[currentIndex + 1];
  const now = new Date().toISOString();

  try {
    const updateExpr = 'SET taskState = :nextState, updatedAt = :now' +
      (details ? ', details = :details' : '');
    const exprValues: Record<string, unknown> = {
      ':nextState': nextState,
      ':now': now,
    };
    if (details) {
      exprValues[':details'] = { ...task.details, ...details };
    }

    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: exprValues,
    }));

    console.log(`Task ${taskId} advanced: ${task.taskState} -> ${nextState}`);
    return nextState;
  } catch (error) {
    console.error('Error advancing task state:', error);
    return null;
  }
}

/**
 * Advance a task to an EXPLICITLY REQUESTED state, authorized against the task type's graph
 * (SPEC-TASK-STATE-TRANSITIONS §3). This is the only sanctioned mutation of `taskState` for
 * machine-backed tasks under the new design: the model requests a transition (via the
 * advance_task_state / propose_item tool), the runtime authorizes the edge, and only an authorized
 * edge persists — appending to `stateHistory` (§6). Returns a discriminated result the tool layer
 * renders directly; an unauthorized request changes no state and returns an error the model can read
 * and recover from in the same loop iteration.
 *
 * The caller supplies the already-fetched `task` (the processor holds it), so this performs check 1
 * ("an active task exists") on the passed object and checks 2-3 against the graph.
 */
/**
 * The state a DELIVERING step lands in once it has actually delivered - or `undefined` when the step is
 * not one that finishes on delivery.
 *
 * WHY THE RUNTIME AND NOT THE MODEL. Completion was the model's alone, on the rule that the runtime
 * never force-advances (the `advanceDeliveredTaskToCompletion` walker was removed for closing a task
 * from `drafting_outline` while the reply was still asking for approval). That rule stands for what it
 * was protecting against. This is not that walker:
 *
 *   - it is gated on the MACHINE'S OWN DECLARATION (`delivers`), never on what the output looked like,
 *     which is the property the removed one was judged on;
 *   - it refuses any state that AWAITS somebody, so the `drafting_outline` case it broke cannot arise;
 *   - it takes ONE declared edge, never a walk, and only when the machine names exactly one terminal
 *     successor - two ways to finish is a choice, and a choice is not the runtime's to make.
 *
 * And it is what the owner's rule requires: "if the report is delivered it is complete, unless the user
 * objects with additional changes required". Telling the MODEL that was tried first and is deployed; a
 * scan of the task table afterwards found every recent report still `in_progress`, several sitting in
 * `generating` - delivered and never advanced. The instruction was necessary and not sufficient, so the
 * fact does the work instead. A person who wants changes asks for them, and asking is what reopens it.
 */
export function terminalStateAfterDelivery(
  taskType: string | undefined,
  machineState: string | undefined,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): string | undefined {
  if (!taskType || !machineState) return undefined;
  const machine = machines[taskType];
  const state = machine?.states?.[machineState];
  if (!deliversDocument(state)) return undefined;
  if (awaitedPartyOf(state)) return undefined;
  const terminals = (state.transitions ?? []).filter((next) => machine?.states?.[next]?.terminal);
  return terminals.length === 1 ? terminals[0] : undefined;
}

export async function advanceTaskStateTo(args: {
  task: Task;
  toState: string;
  by?: 'tool' | 'system';
  reason?: string;
  messageId?: string;
  details?: Record<string, unknown>;
  machines?: Record<string, TaskStateMachine>;
  /**
   * The assistant running this turn, as a principal id. Used to hand the task BACK when it leaves a
   * state that was blocked on the person (`awaits`).
   *
   * Optional because not every caller is an assistant turn. When it is absent and a hand-back is due,
   * ownership is left with the user and the condition is logged: an item that lingers in someone's
   * queue is visible and fixable, whereas silently dropping the owner would leave the task held by
   * nobody and findable by no query.
   */
  assistantId?: string;
  /**
   * THE RUNTIME IS TAKING A DECLARED STEP ACTION'S OUTCOME EDGE (FR29): recorded on the log entry, which
   * is `by: 'system'`, so the log says which action moved the task and how it went.
   */
  action?: { tool: string; outcome: 'success' | 'failure' };
  /**
   * THE DECIDING VALUES THE TURN'S RESOLVER READ for the machine's conditions (`decidingValues`, ADR-060 decision 6),
   * already held back by trust and call site. Absent, a declared condition does not hold.
   */
  conditionValues?: Record<string, import('./variables.js').VariableValue>;
}): Promise<AdvanceResult> {
  const { task, toState } = args;
  const machines = args.machines ?? DEFAULT_TASK_STATE_MACHINES;
  if (!task.taskType || !task.taskState) {
    return { ok: false, error: 'no_active_task' };
  }

  // WHO IS ASKING decides whether a declared reopen is available: only the model's call, on a turn
  // carrying the requester's message, may reopen a finished task (`reopens`, task-state-machines.ts).
  const authz = authorizeTransition(task.taskType, task.taskState, toState, machines, {
    by: args.by ?? 'tool',
    ...(args.conditionValues ? { conditionValues: args.conditionValues } : {}),
  });
  if (!authz.ok) {
    return { ok: false, error: authz.error, from: authz.from, legal: authz.legal };
  }
  const reopened = authz.reopen === true;
  // THE SECOND LAYER OF A MOVE PAST A CONFIRMED STEP (ADR-064 decision G): its brief is on the record this move writes,
  // whoever asked for it. The turn's own check (`handleAdvanceTaskStateTool`) also holds the move to the opening turn.
  const direct = reopened ? undefined : directEdgeRefusal(machines[task.taskType], task.taskState, toState, { ...(task.details ?? {}), ...(args.details ?? {}) });
  if (direct) {
    return { ok: false, error: direct.error, from: task.taskState };
  }

  if (!TASKS_TABLE) {
    // No persistence backend (e.g. unit context): the authorization decision still stands, and the
    // in-memory task moves — including clearing its stall counter, same as the persisted path.
    task.turnsInState = 0;
    if (reopened) task.status = 'in_progress';
    return { ok: true, from: authz.from, to: authz.to, terminal: authz.terminal, ...(reopened ? { reopened: true as const } : {}) };
  }

  const now = new Date().toISOString();
  // The owner in force rides on the edge (ADR-024 D3), so the log says who held the task when it
  // moved rather than only that it moved.
  const holder = resolveTaskAssignee(task);
  const entry: StateTransition = {
    from: authz.from,
    to: authz.to,
    at: now,
    by: args.by ?? 'tool',
    ...(holder ? { owner: `${holder.type}:${holder.id}` } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.messageId ? { messageId: args.messageId } : {}),
    ...(reopened ? { reopen: true as const } : {}),
    ...(args.action ? { action: { tool: args.action.tool, outcome: args.action.outcome } } : {}),
  };

  try {
    const sets = [
      'taskState = :to',
      'updatedAt = :now',
      'stateHistory = list_append(if_not_exists(stateHistory, :empty), :entry)',
      // §7: a transition clears the stall counter — the task moved, so it isn't stalled.
      'turnsInState = :zero',
    ];
    const exprValues: Record<string, unknown> = {
      ':to': authz.to,
      ':now': now,
      ':empty': [] as StateTransition[],
      ':entry': [entry],
      ':zero': 0,
    };
    if (args.details) {
      sets.push('details = :details');
      exprValues[':details'] = { ...task.details, ...args.details };
    }
    // A REOPEN RETURNS THE LIFECYCLE TO RUNNING, in the same write as the edge. `updateTaskStatus`
    // refuses to move an ended task backwards, and rightly, because a late async write must not
    // resurrect finished work; a declared reopen is the one sanctioned way back, so it carries its own
    // status rather than asking that writer to make an exception.
    if (reopened) {
      sets.push('#status = :inProgress');
      exprValues[':inProgress'] = 'in_progress';
    }
    exprValues[':from'] = authz.from;
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId: task.taskId, channelArn: task.channelArn },
      UpdateExpression: 'SET ' + sets.join(', '),
      ...(reopened ? { ExpressionAttributeNames: { '#status': 'status' } } : {}),
      // OPTIMISTIC CONCURRENCY. `authorizeTransition` above ran against `task.taskState`, which was read
      // at the START of this turn. Writing unconditionally meant the graph was checked against a value
      // never re-verified at write time: if another turn advanced the task in between, this write took an
      // edge that is not legal from the state the task actually occupies, silently landing it somewhere
      // the machine forbids. Overlapping turns on one task are a REAL condition here, not a theoretical
      // one - `getActiveTask` already carries a mitigation for a rapid follow-up turn arriving ~2s after
      // a clarify, and `deliverOnGeneration` walks several hops as separate writes.
      // Pinning the write to the state we authorized FROM makes the machine the authority at the moment
      // it actually matters. A lost race fails cleanly and the caller re-reads.
      ConditionExpression: 'taskState = :from',
      ExpressionAttributeValues: exprValues,
    }));
    task.turnsInState = 0;
    task.taskState = authz.to;
    console.log(
      `[task-state] ${task.taskId} ${authz.from} -> ${authz.to} ` +
        `(by ${entry.by}${reopened ? ', reopen' : ''}${args.reason ? `: ${args.reason}` : ''})`,
    );
    if (reopened) task.status = 'in_progress';
    // AND THE MIRROR LEARNS THE STEP, on every edge. The chat app's list, `open_work_summary` and the
    // Tasks console read the step from the copy, so a copy left on the state it was created in names a
    // step the task has left. Written before the hand-over, which moves the copy to the new holder's
    // partition from the row this write already advanced.
    //
    // A REOPEN ALSO RETURNS THE COPY TO RUNNING, for the reason `updateTaskStatus` mirrors an ending:
    // the queue reads the copy, so a reopened report left `completed` there would be work in progress
    // that no live-task lookup can find. That write may restore a lost copy; an ordinary edge only
    // updates a copy that exists, so a task written without one stays without one.
    await mirrorTask(
      task,
      {
        taskState: authz.to,
        ...(reopened ? { status: 'in_progress' as const } : {}),
        ...(args.details ? { details: exprValues[':details'] as Record<string, unknown> } : {}),
      },
      { onlyIfPresent: !reopened },
    );
    await maybeHandOver({ task, machine: machines[task.taskType], to: authz.to, assistantId: args.assistantId });
    return { ok: true, from: authz.from, to: authz.to, terminal: authz.terminal, ...(reopened ? { reopened: true as const } : {}) };
  } catch (error) {
    // A failed condition is NOT an infrastructure error: the task moved under us, so this edge was
    // authorized from a state it no longer occupies. Report it distinctly - retrying the same
    // transition would be wrong, and the model must not be told the state changed when it did not.
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      console.warn(
        `[task-state] ${task.taskId} ${authz.from} -> ${authz.to} lost a race (no longer in ${authz.from}); not applied`,
      );
      return { ok: false, error: 'state_changed', from: authz.from };
    }
    // Persistence failed AFTER authorization — report failure so the model does not believe the
    // state changed. The task rests in its current state (§7), which is recoverable.
    console.error('[task-state] Error persisting transition:', error);
    return { ok: false, error: 'persist_failed', from: authz.from };
  }
}

/**
 * Move the task between the person and the assistant as the machine crosses an `awaits` boundary.
 *
 * THIS IS THE CALLER `reassignTask` WAS BUILT AND LEFT UNWIRED FOR. A state that declares `awaits` is
 * blocked on that party, so they should hold it: that is what puts a report waiting on scope and
 * a duel's clarifying question into ONE queue the user can work through, instead of each workflow
 * inventing its own "waiting on you" signal (ADR-024, ADR-029).
 *
 * Only a BOUNDARY moves ownership. A transition between two states that both await the user leaves it
 * with the user, and one between two that do not leaves it with the assistant, so an ordinary
 * multi-step task does not churn the mirror partition on every hop.
 *
 * Best-effort by construction: the state transition is already durable and is the source of truth. A
 * failed hand-over means the queue is briefly wrong, which is recoverable; throwing here would fail a
 * turn that has already, correctly, moved.
 */
/**
 * WHO DOES THE WORK on a task a workflow's step opened (ADR-063 decision 1), from the record, or null. A task no step
 * opened has no worker, and a state awaiting one is read as awaiting the requester (`AWAITED_PARTIES`).
 */
export function workerOf(task: Pick<Task, 'workerId' | 'workerType'>): TaskAssignee | null {
  return task.workerId && (task.workerType === 'user' || task.workerType === 'assistant') ? { id: task.workerId, type: task.workerType } : null;
}

async function maybeHandOver(args: {
  task: Task;
  machine?: TaskStateMachine;
  to: string;
  assistantId?: string;
}): Promise<void> {
  const { task, machine, to, assistantId } = args;
  if (!TASKS_TABLE || !machine) return;
  // Through the normalizer, so the boundary is the same one for a machine authored in either accepted
  // form. `requester` is the only shipped reference and it resolves to a person, so "awaits somebody"
  // and "the person holds it" are still the same question here.
  const awaited = awaitedPartyOf(machine.states?.[to]);
  const holder = resolveTaskAssignee(task);
  // A STEP THAT AWAITS THE WORKER IS THE WORKER'S (ADR-063 decision 1), person or assistant, and the worker is read
  // from the record the step wrote, never from the caller.
  const worker = awaited?.party === 'worker' ? workerOf(task) : null;
  if (worker) {
    if (holder?.id === worker.id && holder.type === worker.type) return;
    try {
      await reassignTask(task.taskId, task.channelArn, worker);
      console.log('[task-state] handed to the worker', { taskId: task.taskId, state: to, workerType: worker.type });
    } catch (err) {
      console.warn('[task-state] hand-over failed (state change stands):', err);
    }
    return;
  }
  const heldByUser = holder?.type === 'user';
  if (Boolean(awaited) === heldByUser) return; // already on the right side of the boundary

  try {
    if (awaited) {
      // The REQUESTER is who is being waited on: they are the person in this conversation whose answer
      // the machine needs, and the reference is resolved HERE, against the task record, rather than
      // stored. `assigneePersonId` on a legacy row is honored through resolveTaskAssignee, so
      // this does not fight a task that already names a different human.
      const personId = task.assigneePersonId || personIdFromArn(task.userArn) || '';
      if (!personId) {
        console.warn('[task-state] cannot hand over: no user on the task', { taskId: task.taskId });
        return;
      }
      await reassignTask(task.taskId, task.channelArn, { id: personId, type: 'user' });
      console.log('[task-state] handed to the user', { taskId: task.taskId, state: to, personId });
      return;
    }
    if (!assistantId) {
      console.warn(
        '[task-state] leaving a waiting state with no assistant to hand back to; the item stays in the user queue',
        { taskId: task.taskId, state: to },
      );
      return;
    }
    await reassignTask(task.taskId, task.channelArn, { id: assistantId, type: 'assistant' });
    console.log('[task-state] handed back to the assistant', { taskId: task.taskId, state: to });
  } catch (err) {
    console.warn('[task-state] hand-over failed (state change stands):', err);
  }
}

/**
 * A user's message, applied as the RESPONSE to the work they owe.
 *
 * THE GENERAL SHAPE OF EVERY WORKFLOW, and the reason none of them needs its own signal. A state that
 * declares `awaits` means the machine is blocked on that party and the task is theirs to hold. When
 * they speak in that conversation, that message IS the response: the handler reads the state they are
 * answering, checks the response can resolve it, moves the machine on, and the hand-back to the
 * assistant is what triggers the workflow's next action. A duel resumes its side, a report starts
 * generating, an extraction begins pulling - the same three steps, with no per-feature sentinel,
 * marker, or waiting flag anywhere in it.
 *
 * WHAT IT DOES, and it is one thing: it hands the work back. The task stops being owed by the person
 * and belongs to the assistant again, which is what makes their message trigger the next action rather
 * than merely record one. The TRANSITION is not its business.
 *
 * IT USED TO ADVANCE THE MACHINE ITSELF, on a state that declared `resolvedByOneResponse` and had one
 * exit, and that was a second writer to `taskState` deciding a question only the message's content can
 * answer. The check here is structural - it asks whether the state awaits someone, never what was
 * said - so at `place_item.confirming` it read "actually, make it 45 minutes and put it before the
 * kickoff" and "no, do not add it" as approvals, and moved the task to `placed`, a SUCCESS terminal
 * that closes it. The person's correction then had nowhere to go, because the task that would carry it
 * was finished, and the plan recorded an approval nobody gave.
 *
 * There is no structural test that separates a confirmation from a correction. Both are one reply to a
 * step with one exit; only their content differs. A keyword list of affirmatives would be a second
 * semantic judge sitting next to the model's, disagreeing with it in a language nobody chose, and
 * SPEC-TASK-STATE-TRANSITIONS §8 already settles who advances a machine: `advance_task_state`, on the
 * turn that has the text and the model. So every reply now defers, and `resolvedByOneResponse` says
 * what it always meant to say - to the MODEL, in the prompt (`buildTaskContextForPrompt`), that one
 * clear answer is enough here and it need not keep asking.
 *
 * WHAT IT COSTS: nothing in model calls, which is the part that looks like a cost and is not. A reply
 * to a waiting step already dispatches a turn - the router corrects even a two-character answer's
 * intent so it does (`resumedWaitingWork`), so a "yes" at a confirmation was always going to reach the
 * model. What changes is WHEN the machine moves: at the end of that turn rather than before it starts.
 * If the model then fails to call the tool, the task stays where it is and `turnsInState` records a
 * stall (§7) - visible and recoverable, as against a silent wrong terminal.
 *
 * Returns what happened so the caller can say it, rather than a boolean nobody can explain.
 */
export async function applyUserResponseToTask(args: {
  taskId: string;
  channelArn: string;
  /** The assistant that takes the work back, as a principal id. */
  assistantId: string;
  machines?: Record<string, TaskStateMachine>;
  messageId?: string;
}): Promise<{
  /**
   * Whether this call moved the machine. NO PATH SETS IT TRUE any more, and the field stays because it
   * is what the two router call sites log: a result that quietly changed from an object to a boolean
   * would leave those lines saying something else. `reason` is the field to read.
   */
  applied: boolean;
  reason?: 'not_awaiting' | 'no_machine' | 'deferred_to_model' | 'opened_by_this_message';
  from?: string;
  to?: string;
}> {
  const task = await getTask(args.taskId, args.channelArn);
  if (!task?.taskType || !task.taskState) return { applied: false, reason: 'not_awaiting' };

  // A MESSAGE IS NEVER THE ANSWER TO THE TASK IT OPENED. Amazon Chime SDK delivers at least once, and a
  // redelivered request reaches the waiting-task step before the duplicate check: the task its first
  // delivery opened is waiting on the person by then, so without this the request was applied as the
  // person's own answer and the task moved to the assistant, out of their queue. Nothing is handed back.
  if (args.messageId && task.userMessageId === args.messageId) {
    return { applied: false, reason: 'opened_by_this_message', from: task.taskState };
  }

  const machines = args.machines ?? DEFAULT_TASK_STATE_MACHINES;
  const machine = machines[task.taskType];
  const state = machine?.states?.[task.taskState];
  if (!machine || !state) return { applied: false, reason: 'no_machine' };

  // Not blocked on the person ⇒ this message is ordinary conversation. Moving a machine on the
  // strength of an unrelated remark is how a workflow advances past a step nobody completed.
  if (!awaitedPartyOf(state)) return { applied: false, reason: 'not_awaiting', from: task.taskState };

  // HAND BACK, AND LEAVE THE TRANSITION ALONE. `awaits` says the machine is blocked on a party;
  // it does not say their next message finishes the step, and nothing here can read the message to
  // find out. A state with one exit is no different: "make it 45 minutes" and "yes, go ahead" are both
  // one reply to a one-exit step, and only their content tells them apart.
  //
  // The hand-back is the whole mechanism. The assistant owns the work again, so the turn that follows
  // acts on it, and `advance_task_state` moves the machine on the turn that has the text and the model
  // (§8: state advances through that tool and the runtime never force-advances).
  await reassignTask(args.taskId, args.channelArn, { id: args.assistantId, type: 'assistant' })
    .catch((err) => console.warn('[task-response] hand-back failed:', err));
  return { applied: false, reason: 'deferred_to_model', from: task.taskState };
}

/*
 * advanceDeliveredTaskToCompletion and its BFS walker were REMOVED here (maintainer decision 2026-08-18).
 * They force-walked a task to its terminal state when the OUTPUT looked deliverable-shaped - a second
 * completion door beside the model's own advance_task_state, and it closed a task from
 * drafting_outline while the reply was still asking for outline approval. Completion now has one
 * path: the model declares it, the machine reaches terminal, shouldMarkTaskCompleted reports it
 * (invariant AT6). Do not reintroduce a walker that completes a task the model did not complete.
 */

/**
 * Turns a machine-backed task may sit in one state before the runtime flags it stalled
 * (SPEC-TASK-STATE-TRANSITIONS §7). Env-overridable (`TASK_STALL_TURNS`), default 6, floor 1. The
 * runtime NEVER force-advances on a stall — this only surfaces, on the dashboard, tasks the model is
 * failing to drive forward. Defined in the pure `task-trajectory` module so the analytics reader
 * takes the same threshold without loading the task store.
 */
export { TASK_STALL_TURNS };

/**
 * Record an active-task turn that applied NO transition (SPEC-TASK-STATE-TRANSITIONS §7): atomically
 * increment `turnsInState`, and once it reaches TASK_STALL_TURNS emit `task_state_stalled` (log + EMF)
 * so a model that keeps a task pinned in one state is visible. Reflects the new count back onto the
 * passed `task`. Best-effort — a telemetry miss never blocks the reply; returns the (best-known)
 * counter for tests/callers. No-op for a task with no machine state.
 */
/** What claiming one entry's step action came to. */
export type ActionClaim =
  | { claimed: true; key: string }
  | { claimed: false; key: string; reason: 'already_claimed' | 'state_changed' | 'failed' };

/**
 * CLAIM ONE ENTRY'S STEP ACTION BEFORE IT RUNS (SPEC-TASK-STATE-TRANSITIONS FR29), so it runs at most
 * once per entry into the state however often the turn is retried or redelivered.
 *
 * The key is `<state>#<entry sequence>`, the sequence being how many times the task's transition log
 * shows it entering the state (`entrySequenceOf`), read from the row the caller passes: the task
 * service passes the row it has just read, so the sequence is current. One conditional write appends
 * the key to `actionRuns` only when the task is still in the state and the key is not there yet.
 *
 * AT MOST ONCE, NOT AT LEAST ONCE. A claim that fails is never run around: a turn that died between
 * the claim and the record leaves an entry whose outcome nobody knows, and running a side effect again
 * on a guess is the worse failure. The task then rests in the state, whose outcome edges are ordinary
 * transitions the model can still take.
 */
export async function claimStateAction(args: { task: Task; state: string; pickup?: boolean; toolRun?: string }): Promise<ActionClaim> {
  const { task, state } = args;
  // AN IDLE ASSISTANT'S PICKUP IS CLAIMED THE SAME WAY, under its own prefix (ADR-063 decision 5), so taking up a state
  // and running its action are two claims that never collide. A required tool's success is recorded the same way, once
  // per entry, under `tool:<name>:` (ADR-064 decision 3), so it survives the turns a step spans.
  const key = toolRunKeyOf(args.toolRun, args.pickup, state, task);
  if (task.taskState !== state) return { claimed: false, key, reason: 'state_changed' };
  if ((task.actionRuns ?? []).includes(key)) return { claimed: false, key, reason: 'already_claimed' };
  if (!TASKS_TABLE) {
    // No persistence backend (a unit context): the in-memory row carries the claim.
    task.actionRuns = [...(task.actionRuns ?? []), key];
    return { claimed: true, key };
  }
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId: task.taskId, channelArn: task.channelArn },
      UpdateExpression: 'SET actionRuns = list_append(if_not_exists(actionRuns, :empty), :key), updatedAt = :now',
      ConditionExpression: 'taskState = :state AND (attribute_not_exists(actionRuns) OR NOT contains(actionRuns, :run))',
      ExpressionAttributeValues: {
        ':empty': [] as string[], ':key': [key], ':run': key, ':state': state, ':now': new Date().toISOString(),
      },
    }));
    task.actionRuns = [...(task.actionRuns ?? []), key];
    return { claimed: true, key };
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return { claimed: false, key, reason: 'already_claimed' };
    }
    console.error('[task-state] step action claim failed:', error);
    return { claimed: false, key, reason: 'failed' };
  }
}

/** The claim key of a state entry: an action's, an idle pickup's, or a required tool's success. */
function toolRunKeyOf(toolRun: string | undefined, pickup: boolean | undefined, state: string, task: Task): string {
  const entry = actionRunKey(state, entrySequenceOf(task.stateHistory, state));
  return toolRun ? `tool:${toolRun}:${entry}` : `${pickup ? 'pickup:' : ''}${entry}`;
}

/** The tools a state requires (`requiresTool`) that have not returned success since the task last entered it. */
export function requiredToolsNotRun(task: Task, state: string, required: readonly string[] | undefined): string[] {
  if (!required?.length) return [];
  const runs = new Set(task.actionRuns ?? []);
  return required.filter((t) => !runs.has(toolRunKeyOf(t, false, state, task)));
}

export async function recordNoTransitionTurn(task: Task): Promise<number> {
  if (!task.taskType || !task.taskState) return task.turnsInState ?? 0;

  // Resolve the new count: authoritative via an atomic ADD when a backend exists (survives concurrent
  // turns), else the in-memory increment. The stall signal below fires off this resolved count either
  // way, so it stays observable without a persistence backend (e.g. in tests).
  let turns = (task.turnsInState ?? 0) + 1;
  if (TASKS_TABLE) {
    try {
      const res = await dynamoClient.send(new UpdateCommand({
        TableName: TASKS_TABLE,
        Key: { taskId: task.taskId, channelArn: task.channelArn },
        // ADD is atomic across concurrent turns and treats a missing attribute as 0.
        UpdateExpression: 'SET updatedAt = :now ADD turnsInState :one',
        ExpressionAttributeValues: { ':now': new Date().toISOString(), ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }));
      const persisted = Number((res.Attributes as { turnsInState?: number } | undefined)?.turnsInState);
      if (Number.isFinite(persisted)) turns = persisted;
    } catch (err) {
      console.warn('[task-state] turnsInState increment failed (non-fatal):', err);
    }
  }
  task.turnsInState = turns;

  if (turns >= TASK_STALL_TURNS) {
    console.log(
      '[task-state] task_state_stalled ' +
        JSON.stringify({ taskId: task.taskId, taskType: task.taskType, taskState: task.taskState, turnsInState: turns }),
    );
    emitEmfMetric({
      namespace: TASK_METRICS_NAMESPACE,
      metrics: [{ name: 'task_state_stalled', unit: 'Count' }],
      dimensionSets: [['TaskType'], ['TaskType', 'TaskState']],
      properties: {
        task_state_stalled: 1,
        TaskType: task.taskType,
        TaskState: task.taskState,
        turnsInState: turns,
        TaskId: task.taskId,
      },
    });
  }
  // ── THE BALL GOES BACK IF THE ASSISTANT DID NOT MOVE IT (maintainer, 2026-09-03) ──────────────────
  //
  // `maybeHandOver` gives a task to the ASSISTANT when a person replies at an awaiting step, so the
  // turn that follows can act on it. That hand-over is meant to be momentary: the assistant holds it
  // for the turn, advances the machine, and the machine decides who holds it next.
  //
  // Nothing returned it when the turn advanced NOTHING. The state still said a person was being
  // waited on, while `ownerId` said the assistant held it - the two disagreeing, which is the one
  // thing the ownership model claims cannot happen. Measured on the deployment: 56 tasks owned by the
  // assistant while sitting in a state that declares `awaits` - 50 `report_generation` in
  // `collecting_requirements` and 6 `queued_request` in `proposed`. Every one of them is invisible in
  // its own requester's open-work list, because that list reads the OWNER's partition.
  //
  // This is the moment that fact is known: no transition was applied, and the state still awaits
  // somebody. So ownership returns to them, which is exactly what the state already says.
  //
  // ONLY FROM THE ASSISTANT, and only to the awaited party. A task the person already holds needs no
  // write, and a state awaiting nobody is the assistant's to keep working on.
  //
  // BEST EFFORT, like the stall counter above: this improves who a row is listed under, and a failed
  // write must not cost the turn that just ran.
  try {
    // THE PACK'S MACHINES, NOT ONLY THE PLATFORM'S (code review, 2026-09-04).
    //
    // Creation already resolves through the pack, so a deployment that defines its own task types
    // gets rows in states this file had never heard of. Reading the DEFAULTS here meant
    // `machines[task.taskType]` was undefined for exactly those types, `awaitedPartyOf` saw nothing
    // to await, and the hand-back declined to run - leaving a pack-defined task stuck owned by the
    // assistant in a state that awaits its requester. That is the disagreement this whole block
    // exists to prevent, and it was reintroduced for every type the platform did not ship.
    //
    // The resolver merges over the defaults, so nothing the platform defines is lost.
    const machines = packTaskStateMachines();
    const stateDef = machines[task.taskType]?.states?.[task.taskState];
    const awaited = awaitedPartyOf(stateDef);
    const owner = resolveTaskAssignee(task);
    // A STEP THAT AWAITS THE WORKER returns to the worker the task step recorded (ADR-063 decision 1).
    const worker = awaited?.party === 'worker' ? workerOf(task) : null;
    if (worker && !(owner?.id === worker.id && owner.type === worker.type)) {
      await reassignTask(task.taskId, task.channelArn, worker);
    } else if (awaited && !worker && owner?.type === 'assistant') {
      // The requester reference resolves to the requester, who is the principal on the task's own
      // `userArn`.
      //
      // THE ARN HAS TO NAME A PERSON. An ARN with no `/user/` segment yields no id rather than the
      // whole ARN, so the task is never handed to an "owner" whose id is an entire ARN - a partition
      // nobody reads, which loses the row more thoroughly than leaving it with the assistant. Caught
      // by the test for exactly that case.
      const requesterPersonId = personIdFromArn(task.userArn) || '';
      if (requesterPersonId) {
        await reassignTask(task.taskId, task.channelArn, { id: requesterPersonId, type: 'user' });
        console.log('[task-state] the turn moved nothing and the step awaits a person; handing it back', {
          taskId: task.taskId, taskType: task.taskType, taskState: task.taskState, to: requesterPersonId,
        });
      }
    }
  } catch (err) {
    console.warn('[task-state] could not hand an unmoved task back to the person it awaits:',
      (err as Error)?.message);
  }

  return turns;
}


/**
 * Mark task as in progress
 */
export async function startTask(taskId: string, channelArn: string): Promise<void> {
  await updateTaskStatus(taskId, channelArn, 'in_progress');
}

/**
 * Mark task as completed with result
 */
export async function completeTask(taskId: string, channelArn: string, result: string): Promise<void> {
  await updateTaskStatus(taskId, channelArn, 'completed', result);
}

/**
 * Mark task as failed with error
 */
export async function failTask(taskId: string, channelArn: string, error: string): Promise<void> {
  await updateTaskStatus(taskId, channelArn, 'failed', undefined, error);
}

/**
 * Build task context string for system prompt.
 *
 * WHERE THE SUFFICIENCY RULE LIVES (maintainer, 2026-08-14). When the current step declares what it needs
 * (`requires`), the person's message is reviewed against that list: everything there ⇒ advance and get
 * on with the work; something missing ⇒ ask for THAT, and only that, leaving the step where it is.
 *
 * It is the model's judgement and not the machine's, deliberately. Only the answer's content can say
 * whether it named an audience, and the structural check the router runs before this
 * (`applyUserResponseToTask`) is explicit that it cannot read content - which is why a step with one
 * exit used to advance on whatever arrived first.
 *
 * ASKING ONLY FOR WHAT IS MISSING is the part that is easy to lose. The person has already answered
 * part of the question; re-asking the whole thing reads as not having been listened to, which is the
 * same complaint as advancing without the answer, arriving from the other side.
 *
 * WHO PACKAGES A DELIVERABLE (see the delivering-state section below). A step that delivers a
 * document is told not to claim it saved a file, because it cannot know whether it did: packaging is
 * decided AFTER the text exists, from the transition the turn declared and the minimum artifact size
 * (SPEC-TASK-STATE-TRANSITIONS §4). A live report posted inline under a reply that said it had been
 * saved as a Markdown file, and the person asked where the file was.
 */
export function buildTaskContextForPrompt(
  task: Task | null,
  /**
   * THE TURN'S MACHINES. Required, and it used to default to `DEFAULT_TASK_STATE_MACHINES` (ADR-047).
   *
   * A default here answers a DIFFERENT question than the caller asked: the platform set, without the
   * classification's pack and without the assistant's selection. It is a real answer, it looks right,
   * and nothing at runtime notices - which is how `needsOf` once read the platform set inside a
   * function that hydrates no pack (`user-tasks-api.ts`). The call site was fixed; the signature that
   * permitted it was not. A caller that genuinely works outside a turn passes
   * `DEFAULT_TASK_STATE_MACHINES` explicitly, which is a decision rather than an accident.
   */
  machines: Record<string, TaskStateMachine>,
): string {
  if (!task) return '';

  const stateLabel = task.taskState ? ` (${task.taskState})` : '';
  const detailsStr = task.details && Object.keys(task.details).length > 0
    ? `\nCollected information: ${JSON.stringify(task.details)}`
    : '';

  // Only for a step that is BLOCKED ON THE PERSON and says what it needs. A step the workflow is
  // getting on with by itself has nothing to chase, and a step with no list keeps today's behavior:
  // any answer is sufficient, which is right for a confirmation or a single choice.
  const requires = task.taskType && task.taskState
    ? machines[task.taskType]?.states?.[task.taskState]?.requires
    : undefined;
  // A PRESENTED STEP IS PUT TO THE PERSON before it is left (`TaskStateDef.presented`), and the runtime
  // refuses the advance on the turn the step was entered. So on such a step, "everything is there" is
  // said back to them as what is being taken and where it came from, and their reply is what moves it
  // on. A step that does not declare it keeps the model's judgement: everything there, carry on.
  const presented = task.taskType && task.taskState
    ? machines[task.taskType]?.states?.[task.taskState]?.presented
    : undefined;
  const everythingThere = presented
    ? `- Everything there, and you have not yet put it to them ⇒ list each need with what you are taking
  for it and where it came from (their words, or the named source you retrieved it from), and ask them
  to confirm or correct it. Do not advance on this turn: their reply is what moves it on.
- Everything there, and they have confirmed it or just supplied the last of it ⇒ move on. Call
  \`${ADVANCE_TASK_STATE_TOOL_NAME}\` with every need in \`collected\` and continue the work.`
    : `- Everything there ⇒ move on. Call \`${ADVANCE_TASK_STATE_TOOL_NAME}\` and continue the work; do not
  ask them to confirm what they have already told you.`;
  const sufficiency = requires?.length
    ? `

### THIS STEP NEEDS

${requires.map((r) => `- ${r}`).join('\n')}

Check the user's message against that list, together with anything already collected above.

${everythingThere}
- Every need carries where it came from: their own words (quote them briefly), or a passage you
  retrieved (name its source). Never fill a need from nothing - a need with neither is missing.
- Something missing ⇒ ask for ONLY the missing part, in one short question, and do not advance the
  task. Do not re-ask for anything they have already given, and do not restate the whole list back
  at them.
- They decline to specify, or tell you to choose ⇒ that is an answer, and their words are its
  evidence. Say what you are choosing and move on. Do not ask again.
`
    : '';

  // A step the machine declares as `resolvedByOneResponse` is one where ONE clear answer is enough -
  // a confirmation, an approval, a single choice - so the model is told not to keep asking. It is
  // rendered HERE, to the model, because that is the only reader that can tell a confirmation from a
  // correction; the runtime used to act on this flag itself and moved a proposal to its SUCCESS
  // terminal on "actually, make it 45 minutes", recording an approval nobody gave.
  //
  // Mutually exclusive with `requires` by validation, so the two blocks can never both render and tell
  // the model to advance on any answer and to withhold until a checklist is satisfied.
  const oneAnswerCompletes = task.taskType && task.taskState
    ? machines[task.taskType]?.states?.[task.taskState]?.resolvedByOneResponse
    : undefined;
  const oneAnswer = oneAnswerCompletes
    ? `

### ONE ANSWER COMPLETES THIS STEP

You have put something to the user and are waiting on their decision. Do not re-ask for detail you
already have, and do not restate the whole proposal back at them.

- They agree ⇒ that completes it. Call \`${ADVANCE_TASK_STATE_TOOL_NAME}\`, then say briefly what
  happened.
- They ask for something DIFFERENT ⇒ that is not agreement. Do not advance. Put the corrected version
  back to them the same way you put the first one, and wait again.
- They say no, or to drop it ⇒ that is not agreement either. Do not advance and do not tell them it
  went ahead. Acknowledge it and ask what they would like instead.
`
    : '';

  // A step the machine declares as DELIVERING (`delivers`) hands over a document the model DECLARES
  // as an argument, separate from its reply (`deliveringContract`). Whether that document is packaged
  // as a downloadable file or posted inline is decided after the text exists, from the minimum artifact
  // size, so the model writing it cannot know, and any claim it makes about a saved file is a guess
  // that was wrong live. Read from the same `delivers` flag the attachment gate reads, so a
  // per-deployment machine that renames or adds a delivering state carries the rule with it.
  //
  // WHAT THIS TASK HAS ALREADY HANDED OVER.
  //
  // A turn knew everything about the document it was writing and nothing about the one it wrote last
  // time, so an assistant asked "is this task complete?" could not see that it had already delivered
  // the report - and answered by starting the work again. The person watched a finished report sit
  // next to an open work item while the assistant re-generated it.
  //
  // This is CONTEXT, not a trigger. It does not complete anything: it tells the model what happened so
  // the model can make the call the machine requires (invariant AT6 - completion has one path, and this
  // does not add a second one). An assistant that can see it delivered the report is in a position to
  // close the task, or to say plainly that it already did the work.
  const delivered = (task.deliveries ?? []).slice(-3);
  const deliveredSoFar = delivered.length
    ? `

### ALREADY DELIVERED ON THIS TASK

${delivered.map((d) => `- ${d.name} (${d.at}${d.fromState ? `, from ${d.fromState}` : ''})`).join('\n')}

The person already has ${delivered.length === 1 ? 'this' : 'these'}. Do not produce it again unless they
ask for a change. If the work is finished, say so and advance the task to its final state; if they are
asking for a revision, advance to the revising step instead. If they are simply asking whether it is
done, answer the question - the delivery above is the evidence.`
    : '';

  const delivers = task.taskType && task.taskState
    ? deliversDocument(machines[task.taskType]?.states?.[task.taskState])
    : undefined;
  const deliveryHonesty = delivers ? `

${deliveringContract()}` : '';

  // ── NAMING AN ITEM IS NOT ANSWERING IT ──────────────────────────────────────
  //
  // MEASURED LIVE in `conv-1790010890868-807ae3b58087`, four times in one conversation. The person
  // asked ABOUT an open item and the turn read every one of those questions as the item's answer:
  //
  //   "#1 What do you want to know about this question? Seems pretty clear" -> "That's you, by the way."
  //   "Why do you still show so many machines in progress?"                 -> "Done - #3 is now dropped."
  //   "#3 You've already answered this, haven't you?"                       -> an apology and a close
  //   "#4 Why is task 4 still showing up? It is already closed out"         -> the task advanced again
  //
  // The reply came out of the step rather than out of the words, the item was advanced or closed, and
  // the person's actual question went unanswered - which then produced the NEXT confused message
  // ("That's you, by the way." -> "What's me" -> "That is done." -> "What is done?").
  //
  // THE CAUSE WAS THE LINE THAT USED TO BE HERE: "When responding, continue working on this task."
  // Unconditional, and read by the model as an instruction to progress the item whatever arrived. The
  // structural half of this was already fixed once for the same reason - `resolvedByOneResponse` no
  // longer lets the RUNTIME advance a step, because no structural test separates "yes" from "actually,
  // make it 45 minutes". This is the same distinction one layer up: no structural test separates a
  // message that answers an item from one that asks about it, so the model is told to make the call.
  //
  // WHY THE MODEL AND NOT A CLASSIFIER. It is the only reader with the person's words, the step and
  // what has already been collected in front of it at once. A classifier would be a second opinion
  // formed from less.
  return `
## ACTIVE TASK

Type: ${task.taskType || 'general'}${stateLabel}
Status: ${task.status}
Original request: ${(task.requestExcerpt ?? task.userMessage)?.substring(0, TASK_EXCERPT_MAX_CHARS) ?? '(not recorded)'}${detailsStr}${sufficiency}${oneAnswer}${deliveredSoFar}${deliveryHonesty}

### IS THIS MESSAGE ANSWERING THIS ITEM, OR ASKING ABOUT IT?

Decide that before anything else. The message reaching you attached to this item means it REFERS to
it, including when it names it as \`#<number>\` - it does not mean it answers it.

- It ANSWERS the step ⇒ carry on with the work, as the step above describes.
- It ASKS ABOUT the item - why it is open, whether it is already done, what you still need, what its
  status is ⇒ **answer the question**. Do not advance it, do not close it, and do not report progress
  that the question itself did not make. Then, if the answer is that it should not be open, say so and
  do the closing as its own deliberate act.
- It is about something else entirely ⇒ acknowledge it briefly and offer to come back to this item.

Never reply with a bare progress line ("That is done", "Done - #3 is now dropped") to a message that
asked you something. The person cannot tell what you acted on, and the next thing they send will be
asking what you meant.
`;
}

/**
 * THE DELIVERING CONTRACT, as the model reads it: what the document is, what the reply is, and what a
 * delivery does to the task.
 *
 * One rendering, read in two places: the prompt of a turn that STARTS in a delivering state
 * (`buildTaskContextForPrompt`), and the result of an `advance_task_state` that LANDS in one
 * (task-tools.ts), because a turn that moves into a delivering step mid-loop never sees the first.
 * Measured live: an extraction advanced out of requirements gathering and into a delivering step in a
 * single model call, wrote a greeting, a table and "I can't generate a downloadable file" beside the
 * call, and that whole reply was packaged as the document. The instructions for the step it had moved
 * into existed only in a prompt rendered for the step it had left.
 *
 * WHO PACKAGES IT. The model declares the document as an argument (`document` on the advance, or
 * `deliver_document` for a rewrite while the task stays in the step); only that text becomes the file,
 * and the reply posts as chat. Whether the document arrives as a file or inline is decided after the
 * text exists, from the minimum artifact size, so the model is told not to claim a file either way.
 */
export function deliveringContract(): string {
  return `### DELIVERING THIS STEP

The document and your reply are two different things, and you say which is which.

- THE DOCUMENT is the complete deliverable, written for a reader outside this conversation. Pass it
  whole as \`document\`: on \`${ADVANCE_TASK_STATE_TOOL_NAME}\` when you move into a delivering step or
  finish from one, or on \`${DELIVER_DOCUMENT_TOOL_NAME}\` while the task stays here: when the move into
  this step carried no document, because this step writes it, and when you rewrite it.
  Only the declared document is packaged; nothing in your reply becomes part of it.
- The document has no greeting, does not address the person, makes no offers and asks no questions,
  and says nothing about files, attachments or downloads. A person opening it next week is not in this
  conversation. Measured live: a delivered extraction opened "Hi <name>, I have everything I need...
  here's your downloadable table:" and closed "let me know if you'd like the mitigation owners added".
- YOUR REPLY is what you say to the person, and it posts as chat beside the document: a line on what
  you produced, and any offer or question you have for them.
- Do not say you have saved, attached, created, uploaded or exported a file, and do not offer a
  download link. Whether the document arrives as a file or as text is decided after you answer.
- Refer to what you produced as the report, the summary, or the extraction, never as "the file
  above" or "the attached document".

**DELIVERING IT COMPLETES IT.** When you hand over the finished thing, the work is done: call
\`${ADVANCE_TASK_STATE_TOOL_NAME}\` on the SAME turn to carry it towards its final state. Do not
leave it open pending approval, and do not wait to be told it was satisfactory - a person who wanted
changes will ask for them, and asking is what reopens it.

**ONE CALL IS ONE STEP, AND SOMETIMES THE FINAL STATE IS FURTHER OFF.** For some work the next state
IS the last one and a single call finishes it. For other work there are steps in between, and you
cannot tell which from the state name alone. The answer tells you: \`finished: true\` means it is
closed, and \`finished: false\` comes back with \`next_states\` naming what is still ahead.

**SO SAY WHAT THE ANSWER SAID, NOT WHAT YOU INTENDED.** Only call it closed, done or complete when the
answer came back \`finished: true\`. On \`finished: false\` the work is still open: either call the tool
again for the next step, if this turn can honestly take it, or say plainly what moved and what is
left. Telling somebody their work is finished when it is not is worse than telling them it is still
going, because they stop checking.

If they DO come back asking for changes, that is not a finished task being reopened by you; advance
to the revising step and make the change. If they simply ask whether it is done, answer them - the
delivery already happened, and re-producing it is not an answer.
`;
}
