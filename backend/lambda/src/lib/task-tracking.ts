/**
 * Task Tracking for Agent Handlers
 *
 * Provides task creation, status tracking, and state machine management
 * for multi-turn agent operations. Used for guided troubleshooting,
 * data extraction, and report generation workflows.
 *
 * Two DynamoDB tables:
 * - AgentTasksTable: PK=taskId, SK=channelArn — task details
 * - UserTasksTable: PK=userSub, SK=taskId, GSI=userSub-taskType-index — active task lookup
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DeliveryOption } from './delivery-options.js';
import { taskStateMachines as packTaskStateMachines } from './intent-pack.js';
import {
  type TaskStateMachine,
  type TerminalKind,
  DEFAULT_TASK_STATE_MACHINES,
  ADVANCE_TASK_STATE_TOOL_NAME,
  stateNamesOf,
  authorizeTransition,
  awaitedPartyOf,
} from './task-state-machines.js';
import { emitEmfMetric } from './emf-metrics.js';
import * as crypto from 'crypto';

/** CloudWatch EMF namespace for task-lifecycle metrics (SPEC-TASK-STATE-TRANSITIONS §7). */
const TASK_METRICS_NAMESPACE = 'AgentEchelon/Tasks';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// removeUndefinedValues: createTask writes optional
// taskType / taskState / messageId into the Item — taskState is
// explicitly undefined for any task with no state machine (the common
// generic-task case). Without this the PutCommand throws and is
// swallowed by the surrounding try/catch, so task tracking fails
// SILENTLY (no 500, no row) — worse than a visible error.
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const TASKS_TABLE = process.env.TASKS_TABLE || '';
const USER_TASKS_TABLE = process.env.USER_TASKS_TABLE || '';

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
  | { ok: true; from: string; to: string; terminal?: TerminalKind }
  | {
      ok: false;
      error: 'no_active_task' | 'unknown_state' | 'illegal_transition' | 'persist_failed' | 'state_changed';
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
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): boolean {
  const machine = taskType ? machines[taskType] : undefined;
  if (!machine) return true; // no machine → nothing to progress; completes per turn (unchanged)
  return !!(machineState && machine.states?.[machineState]?.terminal);
}

/**
 * Who owns a task: the actor that must act on it NEXT (ADR-024 D1). One at a time, human or
 * assistant, reassignable at a step boundary.
 *
 * `id` is the **app-instance principal's unique id** - an `AppInstanceUserId` for a person (a raw
 * pool sub, or a `fed_` hash for a federated user), an `AppInstanceBotId` for an assistant. Never an
 * ARN: the ARN is rebuilt from the type when a Chime call needs one.
 *
 * `type` is stored rather than inferred, and that follows from the id rather than qualifying it: the
 * unique id **cannot be turned back into an ARN** without knowing whether the path segment is
 * `/user/` or `/bot/`, so the information is not in the id at all.
 */
export type OwnerType = 'user' | 'assistant';

export interface TaskOwner {
  id: string;
  type: OwnerType;
}

/** The unique id of an app-instance principal, from its ARN. `.../user/<id>` and `.../bot/<id>`. */
export function principalIdFromArn(arn: string | undefined): string {
  return arn?.split('/').pop() || '';
}

/**
 * The owner in force, for a row that may predate the migration. New rows carry `ownerId`/`ownerType`
 * and this returns them directly; a legacy row is resolved from whichever ownership-shaped field it
 * happens to carry, in the order the old code preferred them, so a task written before the migration
 * stays resumable by the same actor it was resumable by before.
 */
export function resolveTaskOwner(
  task: Partial<Pick<Task, 'ownerId' | 'ownerType' | 'assignedBotArn' | 'assigneeUserSub' | 'userArn'>>,
): TaskOwner | null {
  if (task.ownerId && task.ownerType) return { id: task.ownerId, type: task.ownerType };
  if (task.assignedBotArn) return { id: principalIdFromArn(task.assignedBotArn), type: 'assistant' };
  if (task.assigneeUserSub) return { id: task.assigneeUserSub, type: 'user' };
  const fromRequester = task.userArn?.split('/user/').pop() || '';
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
export function setTaskOwner(owner: TaskOwner): Pick<Task, 'ownerId' | 'ownerType'> {
  if (!owner.id) throw new Error('[setTaskOwner] an owner needs an id');
  if (owner.type !== 'user' && owner.type !== 'assistant') {
    throw new Error(`[setTaskOwner] unknown owner type: ${String(owner.type)}`);
  }
  return { ownerId: owner.id, ownerType: owner.type };
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

export interface Task {
  taskId: string;
  channelArn: string;
  userArn: string;
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
   * time. Written only via `setTaskOwner`, always as a pair. Absent on rows written before the
   * migration; use `resolveTaskOwner` rather than reading these directly.
   */
  ownerId?: string;
  ownerType?: OwnerType;
  /**
   * THE ASSISTANT THIS CHAIN BELONGS TO, as a principal id. Written once at creation and never moved.
   *
   * Distinct from `ownerId`, and both are needed (owner, 2026-08-14). The OWNER is whoever must act
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
  /** @deprecated superseded by `ownerId`/`ownerType`. Read through `resolveTaskOwner`. */
  assignedBotArn?: string;
  // Work-item tasks: a task is anchored to a context (plan) + (optionally) a
  // work item, and assigned to a participant. itemId is the cascade key (drop the item ⇒
  // cancel its tasks); dueBy drives reminders. All optional — enterprise tasks leave them unset.
  contextId?: string;
  itemId?: string; // the work item id this task serves; null for plan-level tasks
  // @deprecated superseded by `ownerId`/`ownerType`. Read through `resolveTaskOwner`.
  // The assignee's Chime/AppInstanceUser id — a raw pool sub for a native user, a `fed_` hash for a
  // federated one, and not reversible (deriveFederatedSub is one-way). To email an assignee across
  // MULTIPLE IDPs, the notifier reverse-matches this id against the channel roster ({sub, iss}) via
  // deriveFederatedSub to recover the resolvable (sub, iss). The roster is the single IDP pointer; we
  // deliberately do NOT copy iss onto the task (avoids drift). See SPEC-NOTIFICATION-BRIDGE
  // "Identity resolution across multiple IDPs".
  assigneeUserSub?: string;
  dueBy?: string; // ISO date/datetime the action is due
  // Last time a due-date reminder fired for this task (ISO). The scheduled reminder uses it to avoid
  // re-nagging on every fire. Absent ⇒ never reminded.
  lastRemindedAt?: string;
}

/**
 * The active-task mirror row. **`userSub` is the OWNER's principal id** (ADR-024 D2), not
 * necessarily a user and not necessarily the requester: an assistant-owned task sits in a partition
 * keyed by its `AppInstanceBotId`.
 *
 * THE NAME IS WRONG AND CANNOT BE FIXED IN PLACE - DynamoDB cannot rename a key attribute, and this
 * one is the table's partition key. The alternative was a new table plus a backfill of live rows
 * against a 200-day plan TTL; the accepted trade is recorded in ADR-024 D2, which also keeps a
 * correctly named table as the end state. Read `ownerType` to know what kind of actor the id names.
 */
export interface UserTask {
  userSub: string;
  ownerType?: OwnerType;
  /** Mirror of `Task.assistantId` - whose work this is, as opposed to who owes the next step. */
  assistantId?: string;
  taskId: string;
  taskType: string;
  channelArn: string;
  status: TaskStatus;
  taskState?: string;
  details?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  ttl: number;
  // Mirror of the work-item-task anchor for cross-channel/digest hints.
  contextId?: string;
  itemId?: string;
  assigneeUserSub?: string; // `fed_` Chime id (see Task.assigneeUserSub) — resolvable identity is roster-side
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
  contextId?: string;
  itemId?: string;
  /** Who must act on this next. Defaults to the requester, as a `user` owner. */
  owner?: TaskOwner;
  /**
   * WHOSE WORK THIS IS - the assistant the chain belongs to, as a principal id. Fixed for the task's
   * life, unlike `owner`, which changes hands at every `awaits` boundary. Defaults to the owner
   * when the caller named an assistant one.
   */
  assistantId?: string;
  /** The user message that opened this, when the caller holds a resolvable id (ADR-024 D5). */
  userMessageId?: string;
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
  const taskId = generateTaskId();
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
  // A caller-supplied owner is honoured only when the first step is NOT the person's. The ASSISTANT
  // the chain belongs to is recorded separately (`assistantId`), so handing the step to the person
  // costs nothing in traceability: two duel sides stay distinguishable by assistant, not by owner.
  const requesterSub = userArn.split('/user/').pop() || '';
  // The awaited party is a REFERENCE, and the only one that ships resolves to the requester, who is
  // exactly the principal this line already had to hand. Read through the normalizer so a machine
  // authored in either accepted form starts in the same owner's queue.
  const startsBlockedOnAPerson = Boolean(
    taskType && initialState
    && awaitedPartyOf(machinesForCreate[taskType]?.states?.[initialState]),
  );
  const owner: TaskOwner | null =
    (startsBlockedOnAPerson && requesterSub)
      ? { id: requesterSub, type: 'user' as const }
      : (opts?.owner ?? (requesterSub ? { id: requesterSub, type: 'user' as const } : null));

  // Whose work it is. Explicit when the caller names an assistant owner (a duel side does), otherwise
  // the assistant running this turn if the caller supplied one. Never moves afterwards.
  const assistantId = opts?.assistantId
    ?? (opts?.owner?.type === 'assistant' ? opts.owner.id : undefined);

  const task: Task = {
    taskId,
    channelArn,
    userArn,
    requestExcerpt: (opts?.requestExcerpt ?? event.inputTranscript ?? '').slice(0, TASK_EXCERPT_MAX_CHARS),
    status: 'pending',
    deliveryOption,
    taskType,
    taskState: initialState,
    ...(correlationId ? { correlationId } : {}),
    ...(opts?.userMessageId ? { userMessageId: opts.userMessageId } : {}),
    ...(opts?.battleId ? { battleId: opts.battleId } : {}),
    ...(assistantId ? { assistantId } : {}),
    details: {},
    createdAt: now,
    updatedAt: now,
    ttl,
    ...anchor,
    ...(owner ? setTaskOwner(owner) : {}),
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
    }
  }

  // The active-task mirror, partitioned by the OWNER (ADR-024 D2). It used to be partitioned by the
  // REQUESTER here while every other writer keyed on the assignee, so the moment those differed the
  // row a status update touched was not the row this one wrote.
  if (USER_TASKS_TABLE && owner) {
    await putMirrorRow(task);
  }

  return task;
}

/**
 * Write the mirror row for a task, under its owner. The single place the mirror is created, so the
 * partition it lands in can only ever be the one `resolveTaskOwner` reads back.
 */
async function putMirrorRow(task: Task): Promise<void> {
  const owner = resolveTaskOwner(task);
  if (!USER_TASKS_TABLE || !owner) return;
  try {
    const userTask: UserTask = {
      userSub: owner.id,
      ownerType: owner.type,
      taskId: task.taskId,
      taskType: task.taskType || 'general',
      channelArn: task.channelArn,
      status: task.status,
      taskState: task.taskState,
      details: task.details ?? {},
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ttl: task.ttl,
      // Carried onto the mirror so a chain can be found by ITS ASSISTANT from whichever partition the
      // owner currently puts it in. Without it here, an assistant looking for its own work in a
      // person's partition would have to read the full task row for every candidate.
      ...(task.assistantId ? { assistantId: task.assistantId } : {}),
      ...(task.contextId ? { contextId: task.contextId } : {}),
      ...(task.itemId ? { itemId: task.itemId } : {}),
      ...(task.dueBy ? { dueBy: task.dueBy } : {}),
    };
    await dynamoClient.send(new PutCommand({ TableName: USER_TASKS_TABLE, Item: userTask }));
  } catch (error) {
    console.error('Error writing user-task mirror:', error);
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
 * Get the most recent active task for a user by task type.
 *
 * By default this queries the `userSub-taskType-index` GSI across
 * all channels — the row returned may have originated in a different
 * channel than the current caller. Callers that intend to *resume* a
 * task SHOULD pass `opts.channelArn` so the lookup is scoped to the
 * current channel; resuming a task whose original `channelArn` doesn't
 * match the current channel will silently fail at the
 * `getTask(taskId, channelArn)` step in the async processor, since
 * that table is keyed by both.
 *
 * For cross-channel visibility (e.g. "the user has tasks active
 * elsewhere"), use `getActiveTasksForUser` instead.
 */
export async function getActiveTask(
  userSub: string,
  taskType: string,
  opts: { channelArn?: string } = {},
): Promise<UserTask | null> {
  if (!USER_TASKS_TABLE) return null;
  // Fast path: the userSub-taskType GSI (eventually consistent, cheap).
  const viaGsi = await queryActiveTask(userSub, taskType, opts, false);
  if (viaGsi) return viaGsi;
  // Recent-write path (COST-CRITICAL): a task created moments ago by an earlier turn of the SAME
  // multi-step flow may not yet be visible on the eventually-consistent GSI. A rapid follow-up turn
  // (e.g. the details reply ~2s after a clarify) would then miss it and create a DUPLICATE task — a second
  // full run of an expensive data_extraction / report_generation, doubling cost. Re-check with a
  // STRONGLY-CONSISTENT read of the base table (PK=userSub) so the follow-up continues the existing task.
  return queryActiveTask(userSub, taskType, opts, true);
}

/** Look up the most recent active task of a type. `consistent` chooses a strongly-consistent base-table
 *  query (PK=userSub) over the eventually-consistent GSI — the base table supports ConsistentRead; a GSI
 *  never does. See getActiveTask for why the consistent fallback matters (duplicate-task prevention). */
async function queryActiveTask(
  userSub: string,
  taskType: string,
  opts: { channelArn?: string },
  consistent: boolean,
): Promise<UserTask | null> {
  try {
    const values: Record<string, string> = {
      ':userSub': userSub,
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

    const result = await dynamoClient.send(new QueryCommand({
      TableName: USER_TASKS_TABLE,
      ...(consistent ? { ConsistentRead: true } : { IndexName: 'userSub-taskType-index' }),
      KeyConditionExpression: consistent
        ? 'userSub = :userSub'
        : 'userSub = :userSub AND taskType = :taskType',
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ScanIndexForward: false,
      // A GSI query is pre-filtered so Limit:1 is safe; a filtered base-table query must not Limit:1
      // (the Limit applies BEFORE the filter and could drop the match), so bound it modestly instead.
      ...(consistent ? { Limit: 25 } : { Limit: 1 }),
    }));

    const items = (result.Items as UserTask[] | undefined) ?? [];
    if (!consistent) return items[0] ?? null;
    // Base-table result isn't ordered by recency across the whole partition; pick the newest match.
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
 * to return (owner, 2026-08-14).
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
 * person has moved on is still recognised as new. The platform's existing notion of "still in this
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
   * the historical behaviour byte for byte.
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
 */
export function taskEndedAt(task: Pick<Task, 'stateHistory'> | null | undefined): string | undefined {
  const entries = task?.stateHistory ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
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
export async function getOwnerChannelTasks(
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
        KeyConditionExpression: 'userSub = :owner',
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
    console.error('[getOwnerChannelTasks] query failed:', error);
    return empty;
  }
}

/** Every active task this owner holds in this channel, newest first. */
export async function getActiveTasksForOwnerInChannel(
  ownerId: string,
  channelArn: string,
): Promise<UserTask[]> {
  return (await getOwnerChannelTasks(ownerId, channelArn)).live;
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
  taskType?: string;
  taskState?: string;
  status: TaskStatus;
  ownerId?: string;
  ownerType?: OwnerType;
  dueBy?: string;
  createdAt: string;
  updatedAt: string;
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
  opts: { limit?: number } = {},
): Promise<ConversationTask[]> {
  if (!TASKS_TABLE || !channelArn) return [];
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  try {
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
      Limit: limit * 4, // the status filter runs post-read; over-fetch rather than under-return
    }));
    const rows = (result.Items as Task[] | undefined) ?? [];
    return rows.slice(0, limit).map((t) => {
      const owner = resolveTaskOwner(t);
      // Built field by field, NOT by deleting from the row: a spread-then-delete would leak every
      // future field by default, and the one thing this read must never carry is message content.
      return {
        taskId: t.taskId,
        channelArn: t.channelArn,
        status: t.status,
        ...(t.taskType ? { taskType: t.taskType } : {}),
        ...(t.taskState ? { taskState: t.taskState } : {}),
        ...(owner ? { ownerId: owner.id, ownerType: owner.type } : {}),
        ...(t.dueBy ? { dueBy: t.dueBy } : {}),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
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
  const others = (tasks ?? []).filter((t) => t.taskId !== opts.excludeTaskId);
  if (others.length === 0) return '';

  const line = (t: ConversationTask): string => {
    const who = !t.ownerId
      ? 'unassigned'
      : t.ownerType === 'assistant'
        ? 'held by an assistant'
        : viewer && t.ownerId === viewer.id
          ? 'held by the person you are talking to'
          : 'held by another participant';
    const state = t.taskState ? ` (${t.taskState})` : '';
    const due = t.dueBy ? `, due ${t.dueBy}` : '';
    return `- ${t.taskType || 'general'}${state}: ${who}${due}`;
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
 * `UserTasksTable.PK = userSub` so the lookup is a constant-cost index
 * read per user, not a table scan.
 */
export async function getActiveTasksForUser(
  userSub: string,
  opts: { limit?: number } = {},
): Promise<UserTask[]> {
  if (!USER_TASKS_TABLE) return [];

  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: USER_TASKS_TABLE,
      KeyConditionExpression: 'userSub = :userSub',
      FilterExpression: '#status IN (:pending, :inProgress)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':userSub': userSub,
        ':pending': 'pending',
        ':inProgress': 'in_progress',
      },
      Limit: limit * 4, // FilterExpression runs post-read; over-fetch to compensate
    }));

    const rows = (result.Items as UserTask[] | undefined) ?? [];
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
      const t = byId.get(id)!;
      await updateTaskStatus(id, t.channelArn, 'cancelled');
      const userSub = resolveTaskOwner(t)?.id || '';
      if (USER_TASKS_TABLE && userSub) {
        try {
          await dynamoClient.send(new UpdateCommand({
            TableName: USER_TASKS_TABLE,
            Key: { userSub, taskId: id },
            UpdateExpression: 'SET #s = :c, updatedAt = :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':c': 'cancelled', ':now': new Date().toISOString() },
          }));
        } catch (e) {
          console.warn('[cancelTasksForStop] user-task mirror update failed:', e);
        }
      }
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
  if (!USER_TASKS_TABLE) return;
  const owner = resolveTaskOwner(task);
  if (!owner) return;
  try {
    // An UPSERT, so it must write a WHOLE row. It used to set only `status` and `updatedAt`: when the
    // key it computed differed from the one `createTask` had written under - which it did, one keying
    // on the assignee and the other on the requester - this created a second row carrying nothing
    // else. No `ttl`, so it never expired; no `taskType`, so it was invisible to the lookup GSI; no
    // `channelArn`, so the channel-scoped filter dropped it. One owner removes the divergence, and
    // `if_not_exists` removes the partial row even if a mirror write was ever lost.
    await dynamoClient.send(new UpdateCommand({
      TableName: USER_TASKS_TABLE,
      Key: { userSub: owner.id, taskId: task.taskId },
      UpdateExpression:
        'SET #s = :s, updatedAt = :now, ownerType = :ot'
        + ', taskType = if_not_exists(taskType, :tt)'
        + ', channelArn = if_not_exists(channelArn, :ch)'
        + ', createdAt = if_not_exists(createdAt, :created)'
        + ', #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':s': status,
        ':now': new Date().toISOString(),
        ':ot': owner.type,
        ':tt': task.taskType || 'general',
        ':ch': task.channelArn,
        ':created': task.createdAt,
        ':ttl': task.ttl,
      },
    }));
  } catch (e) {
    console.warn('[mirrorTaskStatus] user-task mirror update failed:', e);
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
 * Updates the `agent-tasks` row through `setTaskOwner`, appends the change to the task log, and MOVES
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
  owner: TaskOwner,
): Promise<void> {
  if (!TASKS_TABLE || !owner?.id) return;
  const now = new Date().toISOString();
  let prev: Task | null = null;
  const fields = setTaskOwner(owner);
  try {
    prev = await getTask(taskId, channelArn);
    if (!prev) return;
    const from = resolveTaskOwner(prev);
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
        'SET ownerId = :oid, ownerType = :otype, updatedAt = :now'
        + ', stateHistory = list_append(if_not_exists(stateHistory, :empty), :entry)',
      ExpressionAttributeValues: {
        ':oid': fields.ownerId,
        ':otype': fields.ownerType,
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
  const oldSub = resolveTaskOwner(prev)?.id || '';
  if (oldSub === owner.id) return; // same partition; nothing to move
  try {
    await putMirrorRow({ ...prev, ...fields, updatedAt: now });
    if (oldSub) {
      await dynamoClient.send(new DeleteCommand({
        TableName: USER_TASKS_TABLE,
        Key: { userSub: oldSub, taskId },
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
}): Promise<AdvanceResult> {
  const { task, toState } = args;
  const machines = args.machines ?? DEFAULT_TASK_STATE_MACHINES;
  if (!task.taskType || !task.taskState) {
    return { ok: false, error: 'no_active_task' };
  }

  const authz = authorizeTransition(task.taskType, task.taskState, toState, machines);
  if (!authz.ok) {
    return { ok: false, error: authz.error, from: authz.from, legal: authz.legal };
  }

  if (!TASKS_TABLE) {
    // No persistence backend (e.g. unit context): the authorization decision still stands, and the
    // in-memory task moves — including clearing its stall counter, same as the persisted path.
    task.turnsInState = 0;
    return { ok: true, from: authz.from, to: authz.to, terminal: authz.terminal };
  }

  const now = new Date().toISOString();
  // The owner in force rides on the edge (ADR-024 D3), so the log says who held the task when it
  // moved rather than only that it moved.
  const holder = resolveTaskOwner(task);
  const entry: StateTransition = {
    from: authz.from,
    to: authz.to,
    at: now,
    by: args.by ?? 'tool',
    ...(holder ? { owner: `${holder.type}:${holder.id}` } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.messageId ? { messageId: args.messageId } : {}),
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
    exprValues[':from'] = authz.from;
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId: task.taskId, channelArn: task.channelArn },
      UpdateExpression: 'SET ' + sets.join(', '),
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
        `(by ${entry.by}${args.reason ? `: ${args.reason}` : ''})`,
    );
    await maybeHandOver({ task, machine: machines[task.taskType], to: authz.to, assistantId: args.assistantId });
    return { ok: true, from: authz.from, to: authz.to, terminal: authz.terminal };
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
  const holder = resolveTaskOwner(task);
  const heldByUser = holder?.type === 'user';
  if (Boolean(awaited) === heldByUser) return; // already on the right side of the boundary

  try {
    if (awaited) {
      // The REQUESTER is who is being waited on: they are the person in this conversation whose answer
      // the machine needs, and the reference is resolved HERE, against the task record, rather than
      // stored. `assigneeUserSub` on a legacy row is honoured through resolveTaskOwner, so
      // this does not fight a task that already names a different human.
      const userSub = task.assigneeUserSub || task.userArn?.split('/user/').pop() || '';
      if (!userSub) {
        console.warn('[task-state] cannot hand over: no user on the task', { taskId: task.taskId });
        return;
      }
      await reassignTask(task.taskId, task.channelArn, { id: userSub, type: 'user' });
      console.log('[task-state] handed to the user', { taskId: task.taskId, state: to, userSub });
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
  reason?: 'not_awaiting' | 'no_machine' | 'deferred_to_model';
  from?: string;
  to?: string;
}> {
  const task = await getTask(args.taskId, args.channelArn);
  if (!task?.taskType || !task.taskState) return { applied: false, reason: 'not_awaiting' };

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
 * advanceDeliveredTaskToCompletion and its BFS walker were REMOVED here (owner decision 2026-08-18).
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
 * failing to drive forward.
 */
export const TASK_STALL_TURNS = Math.max(1, Number(process.env.TASK_STALL_TURNS) || 6);

/**
 * Record an active-task turn that applied NO transition (SPEC-TASK-STATE-TRANSITIONS §7): atomically
 * increment `turnsInState`, and once it reaches TASK_STALL_TURNS emit `task_state_stalled` (log + EMF)
 * so a model that keeps a task pinned in one state is visible. Reflects the new count back onto the
 * passed `task`. Best-effort — a telemetry miss never blocks the reply; returns the (best-known)
 * counter for tests/callers. No-op for a task with no machine state.
 */
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
 * WHERE THE SUFFICIENCY RULE LIVES (owner, 2026-08-14). When the current step declares what it needs
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
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): string {
  if (!task) return '';

  const stateLabel = task.taskState ? ` (${task.taskState})` : '';
  const detailsStr = task.details && Object.keys(task.details).length > 0
    ? `\nCollected information: ${JSON.stringify(task.details)}`
    : '';

  // Only for a step that is BLOCKED ON THE PERSON and says what it needs. A step the workflow is
  // getting on with by itself has nothing to chase, and a step with no list keeps today's behaviour:
  // any answer is sufficient, which is right for a confirmation or a single choice.
  const requires = task.taskType && task.taskState
    ? machines[task.taskType]?.states?.[task.taskState]?.requires
    : undefined;
  const sufficiency = requires?.length
    ? `

### THIS STEP NEEDS

${requires.map((r) => `- ${r}`).join('\n')}

Check the user's message against that list, together with anything already collected above.

- Everything there ⇒ move on. Call \`${ADVANCE_TASK_STATE_TOOL_NAME}\` and continue the work; do not
  ask them to confirm what they have already told you.
- Something missing ⇒ ask for ONLY the missing part, in one short question, and do not advance the
  task. Do not re-ask for anything they have already given, and do not restate the whole list back
  at them.
- They decline to specify, or tell you to choose ⇒ that is an answer. Say what you are assuming and
  move on. Do not ask again.
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

  // A step the machine declares as DELIVERING (`delivers`) produces content that may be packaged as
  // a downloadable file or posted inline. The runtime decides which, after the text exists, from the
  // declared transition and the minimum artifact size - so the model writing the text cannot know,
  // and any claim it makes about a saved file is a guess that was wrong live. Read from the same
  // `delivers` flag the attachment gate reads, so a per-deployment machine that renames or adds a
  // delivering state carries the rule with it. The alternative - checking the finished reply for a
  // file claim - is the output-shape heuristic this codebase has already retired twice.
  const delivers = task.taskType && task.taskState
    ? machines[task.taskType]?.states?.[task.taskState]?.delivers
    : undefined;
  const deliveryHonesty = delivers
    ? `

### DELIVERING THIS STEP

Write the finished content directly in your reply. You do NOT package it: whether it arrives as a
downloadable file or as text in the conversation is decided after you answer.

- Do not say you have saved, attached, created, uploaded or exported a file, and do not offer a
  download link. A file is attached for the person automatically when there is one.
- YOUR WHOLE REPLY BECOMES THE DOCUMENT. Write the document and nothing else: no greeting, no
  addressing the person by name, no "here is your table" lede, and no closing offer to change it.
  Those belong to a conversation, and a person opening this file next week is not in one - they get a
  greeting written to someone at a moment that has passed, and an offer they cannot answer from a
  file. Measured live: a delivered extraction opened "Hi <name>, I have everything I need... here's
  your downloadable table:" and closed "let me know if you'd like the mitigation owners added".
- Refer to what you produced as the report, the summary, or the extraction, never as "the file
  above" or "the attached document".
`
    : '';

  return `
## ACTIVE TASK

Type: ${task.taskType || 'general'}${stateLabel}
Status: ${task.status}
Original request: ${(task.requestExcerpt ?? task.userMessage)?.substring(0, TASK_EXCERPT_MAX_CHARS) ?? '(not recorded)'}${detailsStr}${sufficiency}${oneAnswer}${deliveryHonesty}

When responding, continue working on this task. Guide the user through the current step.
If the user's message is off-topic, acknowledge it briefly and redirect back to the task.
`;
}
