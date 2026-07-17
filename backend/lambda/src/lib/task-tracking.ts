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
import {
  type TaskStateMachine,
  type TerminalKind,
  DEFAULT_TASK_STATE_MACHINES,
  authorizeTransition,
} from './task-state-machines.js';
import { emitEmfMetric } from './emf-metrics.js';
import * as crypto from 'crypto';

/** CloudWatch EMF namespace for task-lifecycle metrics (SPEC-TASK-STATE-TRANSITIONS §7). */
const TASK_METRICS_NAMESPACE = 'AgentEchelon/Tasks';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// removeUndefinedValues: createTask/createBattleTask write optional
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
  from: string;
  to: string;
  at: string; // ISO
  by: 'tool' | 'system';
  reason?: string;
  messageId?: string;
}

/** Result of a requested transition (authorization + persistence). Mirrors the tool result shape. */
export type AdvanceResult =
  | { ok: true; from: string; to: string; terminal?: TerminalKind }
  | {
      ok: false;
      error: 'no_active_task' | 'unknown_state' | 'illegal_transition' | 'persist_failed';
      from?: string;
      legal?: string[];
    };

/**
 * Task state machines for multi-turn intents
 */
export const TASK_STATE_MACHINES: Record<string, string[]> = {
  guided_troubleshooting: [
    'collecting_symptoms',
    'diagnosing',
    'proposing_solutions',
    'awaiting_result',
    'resolved',
    'escalated',
  ],
  data_extraction: [
    'collecting_requirements',
    'extracting',
    'validating',
    'formatting',
    'completed',
  ],
  report_generation: [
    'collecting_requirements',
    'drafting_outline',
    'generating',
    'revising',
    'completed',
  ],
  // Place-an-item task. place_item gathers WHERE a new item
  // goes (position + what it involves) then proposes a placed add_item. The advance is driven by the
  // PROPOSAL itself (robust), not prose keywords: `collecting` → `confirming` when the assistant emits
  // the add_item proposal; → `placed` once the user confirms it (the host apply; deferred to a later
  // phase — for now the task rests in `confirming`/TTL until cascade or a nudge closes it).
  place_item: [
    'collecting',
    'confirming',
    'placed',
  ],
  // Action item. A real-world action handed to a plan
  // participant: gather what/when/who → present options + concrete steps/deep-link → the user
  // completes it off-platform → mark done. Carries a dueBy (due-by) + an assignee (who's
  // responsible); on a shared plan the assistant asks who, else it's the requester.
  action_item: [
    'gathering',
    'options_presented',
    'awaiting_completion',
    'completed',
  ],
};

export interface Task {
  taskId: string;
  channelArn: string;
  userArn: string;
  userMessage: string;
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
  messageId?: string;
  details?: Record<string, unknown>; // State-specific data collected during the task
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  ttl: number;
  /**
   * Phase-2 `/battle` TASK_*: the assistant this task is assigned to.
   * In a battle each bot runs its OWN task chain for the same user
   * prompt, so a task is owned by a bot, not just the user. Set only
   * for battle tasks (createBattleTask); undefined for normal tasks.
   * Battle tasks are looked up by taskId per-bot — NOT via the
   * userSub-taskType active-lookup GSI (two bots + one user + one
   * taskType would collide there) — so no GSI change is needed.
   */
  battleId?: string;
  assignedBotArn?: string;
  // Work-item tasks: a task is anchored to a context (plan) + (optionally) a
  // work item, and assigned to a participant. itemId is the cascade key (drop the item ⇒
  // cancel its tasks); dueBy drives reminders. All optional — enterprise tasks leave them unset.
  contextId?: string;
  itemId?: string; // the work item id this task serves; null for plan-level tasks
  // The assignee's `fed_` Chime/AppInstanceUser id (the user-tasks partition key) — NOT a raw
  // host-pool sub, and not reversible (deriveFederatedSub is a one-way hash). To email an assignee
  // across MULTIPLE IDPs, the notifier reverse-matches this id against the channel roster
  // ({sub, iss}) via deriveFederatedSub to recover the resolvable (sub, iss). The roster is the
  // single IDP pointer; we deliberately do NOT copy iss onto the task (avoids drift). See
  // SPEC-NOTIFICATION-BRIDGE "Identity resolution across multiple IDPs".
  assigneeUserSub?: string;
  dueBy?: string; // ISO date/datetime the action is due
  // Last time a due-date reminder fired for this task (ISO). The scheduled reminder uses it to avoid
  // re-nagging on every fire. Absent ⇒ never reminded.
  lastRemindedAt?: string;
}

export interface UserTask {
  userSub: string;
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
  contextId?: string;
  itemId?: string;
  assigneeUserSub?: string;
  dueBy?: string;
  /** Row TTL in seconds from now. Defaults to DEFAULT_TASK_TTL_SECONDS (24h); plan tasks pass
   *  TRIP_TASK_TTL_SECONDS (or end + buffer) so they don't expire before the work happens. */
  ttlSeconds?: number;
}

/**
 * Create a new task and store it in DynamoDB
 */
export async function createTask(
  event: LexEventForTask,
  deliveryOption: DeliveryOption,
  taskType?: string,
  messageId?: string,
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

  // Determine initial state from state machine
  const initialState = taskType && TASK_STATE_MACHINES[taskType]
    ? TASK_STATE_MACHINES[taskType][0]
    : undefined;

  const ttl = Math.floor(Date.now() / 1000) + (opts?.ttlSeconds ?? DEFAULT_TASK_TTL_SECONDS);
  // Work-item-task anchor fields, included only when supplied (enterprise tasks omit them).
  const anchor = {
    ...(opts?.contextId ? { contextId: opts.contextId } : {}),
    ...(opts?.itemId ? { itemId: opts.itemId } : {}),
    ...(opts?.assigneeUserSub ? { assigneeUserSub: opts.assigneeUserSub } : {}),
    ...(opts?.dueBy ? { dueBy: opts.dueBy } : {}),
  };

  const task: Task = {
    taskId,
    channelArn,
    userArn,
    userMessage: event.inputTranscript || '',
    status: 'pending',
    deliveryOption,
    taskType,
    taskState: initialState,
    messageId,
    details: {},
    createdAt: now,
    updatedAt: now,
    ttl,
    ...anchor,
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

  // Also write to UserTasksTable for active task lookup
  if (USER_TASKS_TABLE && userArn) {
    const userSub = userArn.split('/user/').pop() || '';
    if (userSub) {
      try {
        const userTask: UserTask = {
          userSub,
          taskId,
          taskType: taskType || 'general',
          channelArn,
          status: 'pending',
          taskState: initialState,
          details: {},
          createdAt: now,
          updatedAt: now,
          ttl,
          ...anchor,
        };
        await dynamoClient.send(new PutCommand({
          TableName: USER_TASKS_TABLE,
          Item: userTask,
        }));
      } catch (error) {
        console.error('Error creating user task:', error);
      }
    }
  }

  return task;
}

/**
 * Phase-2 `/battle` TASK_*: create a task OWNED BY A SPECIFIC ASSISTANT.
 *
 * In a battle, each bot independently runs its own task chain for the
 * same user prompt, so we create one Task per bot, assigned to that
 * bot (assignedBotArn) and tagged with the battleId. Each gets its own
 * taskId; the per-bot battle state row carries that taskId so the
 * round-2 orchestrator can wait on "each bot's task chain reached a
 * terminal state".
 *
 * Deliberately does NOT write the UserTasksTable single-active-per-
 * (userSub,taskType) row: two bots + one user + one taskType would
 * collide on that GSI and getActiveTask would return only one. Battle
 * tasks are addressed by taskId per-bot instead — which is why this
 * needs no GSI migration (per the owner decision).
 */
export async function createBattleTask(args: {
  channelArn: string;
  userArn: string;
  assignedBotArn: string;
  battleId: string;
  userMessage: string;
  taskType: string;
  deliveryOption: DeliveryOption;
  messageId?: string;
}): Promise<Task> {
  const taskId = generateTaskId();
  const now = new Date().toISOString();
  const initialState = TASK_STATE_MACHINES[args.taskType]
    ? TASK_STATE_MACHINES[args.taskType][0]
    : undefined;

  const task: Task = {
    taskId,
    channelArn: args.channelArn,
    userArn: args.userArn,
    userMessage: args.userMessage,
    status: 'pending',
    deliveryOption: args.deliveryOption,
    taskType: args.taskType,
    taskState: initialState,
    messageId: args.messageId,
    details: {},
    createdAt: now,
    updatedAt: now,
    ttl: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    battleId: args.battleId,
    assignedBotArn: args.assignedBotArn,
  };

  if (TASKS_TABLE) {
    try {
      await dynamoClient.send(new PutCommand({ TableName: TASKS_TABLE, Item: task }));
      console.log(
        `[battle-task] Created ${taskId} for bot ${args.assignedBotArn} ` +
          `(battle ${args.battleId}, type ${args.taskType}, state ${initialState || 'none'})`,
      );
    } catch (error) {
      console.error('[battle-task] Error creating battle task:', error);
    }
  }
  // Intentionally NOT written to USER_TASKS_TABLE — see the doc above.
  return task;
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

  try {
    const expressionAttributeValues: Record<string, string> = {
      ':userSub': userSub,
      ':taskType': taskType,
      ':pending': 'pending',
      ':inProgress': 'in_progress',
    };
    const filterParts: string[] = ['#status IN (:pending, :inProgress)'];
    if (opts.channelArn) {
      filterParts.push('channelArn = :channelArn');
      expressionAttributeValues[':channelArn'] = opts.channelArn;
    }

    const result = await dynamoClient.send(new QueryCommand({
      TableName: USER_TASKS_TABLE,
      IndexName: 'userSub-taskType-index',
      KeyConditionExpression: 'userSub = :userSub AND taskType = :taskType',
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: false,
      Limit: 1,
    }));

    return (result.Items?.[0] as UserTask) || null;
  } catch (error) {
    console.error('Error getting active task:', error);
    return null;
  }
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

    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression: updateExpression.join(', '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }));

    console.log(`Task ${taskId} updated to status: ${status}`);
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
      const userSub = t.assigneeUserSub || t.userArn?.split('/user/').pop() || '';
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
  const userSub = task.assigneeUserSub || task.userArn?.split('/user/').pop() || '';
  if (!userSub) return;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: USER_TASKS_TABLE,
      Key: { userSub, taskId: task.taskId },
      UpdateExpression: 'SET #s = :s, updatedAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':now': new Date().toISOString() },
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
 * Re-stamp a task's assignee (reassignment). Updates the
 * `agent-tasks` row in place, and MOVES the `user-tasks` mirror: that table is partitioned by
 * `userSub`, so a reassignment is a delete-old + put-new (a plain update can't move a partition key).
 * Best-effort; the agent-tasks row is the source of truth, the mirror is a convenience index.
 * `assigneeUserSub` is the new assignee's Chime/AppInstanceUser id (see Task.assigneeUserSub).
 */
export async function updateTaskAssignee(
  taskId: string,
  channelArn: string,
  assigneeUserSub: string,
): Promise<void> {
  if (!TASKS_TABLE || !assigneeUserSub) return;
  const now = new Date().toISOString();
  let prev: Task | null = null;
  try {
    prev = await getTask(taskId, channelArn);
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId, channelArn },
      UpdateExpression: 'SET assigneeUserSub = :a, updatedAt = :now',
      ExpressionAttributeValues: { ':a': assigneeUserSub, ':now': now },
    }));
  } catch (err) {
    console.error('[updateTaskAssignee] agent-tasks update failed:', err);
    return;
  }
  if (!USER_TASKS_TABLE || !prev) return;
  const oldSub = prev.assigneeUserSub || prev.userArn?.split('/user/').pop() || '';
  if (oldSub === assigneeUserSub) return; // no move needed
  try {
    // Re-mirror under the new owner (carry the anchor + status so getActiveTasksForUser stays correct).
    await dynamoClient.send(new PutCommand({
      TableName: USER_TASKS_TABLE,
      Item: {
        userSub: assigneeUserSub,
        taskId,
        taskType: prev.taskType,
        channelArn,
        status: prev.status,
        ...(prev.taskState ? { taskState: prev.taskState } : {}),
        ...(prev.details ? { details: prev.details } : {}),
        createdAt: prev.createdAt,
        updatedAt: now,
        ttl: prev.ttl,
        ...(prev.contextId ? { contextId: prev.contextId } : {}),
        ...(prev.itemId ? { itemId: prev.itemId } : {}),
        assigneeUserSub,
        ...(prev.dueBy ? { dueBy: prev.dueBy } : {}),
      },
    }));
    if (oldSub) {
      await dynamoClient.send(new DeleteCommand({
        TableName: USER_TASKS_TABLE,
        Key: { userSub: oldSub, taskId },
      }));
    }
  } catch (err) {
    console.warn('[updateTaskAssignee] user-tasks mirror move failed (non-fatal):', err);
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
  const entry: StateTransition = {
    from: authz.from,
    to: authz.to,
    at: now,
    by: args.by ?? 'tool',
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
    await dynamoClient.send(new UpdateCommand({
      TableName: TASKS_TABLE,
      Key: { taskId: task.taskId, channelArn: task.channelArn },
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeValues: exprValues,
    }));
    task.turnsInState = 0;
    console.log(
      `[task-state] ${task.taskId} ${authz.from} -> ${authz.to} ` +
        `(by ${entry.by}${args.reason ? `: ${args.reason}` : ''})`,
    );
    return { ok: true, from: authz.from, to: authz.to, terminal: authz.terminal };
  } catch (error) {
    // Persistence failed AFTER authorization — report failure so the model does not believe the
    // state changed. The task rests in its current state (§7), which is recoverable.
    console.error('[task-state] Error persisting transition:', error);
    return { ok: false, error: 'persist_failed', from: authz.from };
  }
}

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
 * Build task context string for system prompt
 */
export function buildTaskContextForPrompt(task: Task | null): string {
  if (!task) return '';

  const stateLabel = task.taskState ? ` (${task.taskState})` : '';
  const detailsStr = task.details && Object.keys(task.details).length > 0
    ? `\nCollected information: ${JSON.stringify(task.details)}`
    : '';

  return `
## ACTIVE TASK

Type: ${task.taskType || 'general'}${stateLabel}
Status: ${task.status}
Original request: ${task.userMessage?.substring(0, 200) ?? '(not recorded)'}${detailsStr}

When responding, continue working on this task. Guide the user through the current step.
If the user's message is off-topic, acknowledge it briefly and redirect back to the task.
`;
}
