/**
 * Client seam for the TASK SERVICE.
 *
 * Same shape as `data-plane-client.ts`: named functions over one `op` switch, so a caller changes its
 * import source rather than its body, and the transport stays in one file.
 *
 * ── WHY A SEAM AND NOT A DIRECT READ ─────────────────────────────────────────────────────────────
 *
 * The service is where "may this caller see this task" is decided, and it can only be that if callers
 * stop reading the table themselves. The seam is what makes moving a call site a one-line change.
 *
 * ── THE PHASED PATH, STATED SO IT CANNOT BE FORGOTTEN ────────────────────────────────────────────
 *
 * `hasTaskService()` gates it, exactly as `hasDataPlane()` gates retrieval. Until a deployment sets
 * `TASK_SERVICE_ARN`, callers keep their existing direct read, because dropping task context on an
 * unmigrated deployment would be a behavior regression for a security change nobody had enabled yet.
 *
 * THAT FALLBACK IS A BYPASS AND IT IS TEMPORARY. While it exists the boundary holds only where the
 * service is wired. What closes it is not discipline: it is removing the direct table grant from the
 * router and processor roles, at which point the fallback cannot read anything and must be deleted.
 * `test/task-store-boundary.test.ts` names the three current holders and says out loud that the list
 * should shrink to one, so the unfinished state is visible rather than assumed complete.
 *
 * ── DEGRADATION ──────────────────────────────────────────────────────────────────────────────────
 *
 * Task hints are best-effort at every existing call site: a failure must not cost the turn. So an
 * invoke error returns the empty answer rather than throwing. It never falls back to a direct read on
 * ERROR - only on "not wired" - because a service that is present and refusing is making a decision,
 * and reading around a refusal would turn the boundary into a suggestion.
 */

import { LambdaClient } from '@aws-sdk/client-lambda';
import { invokeTaskServiceOp } from './task-service-op.js';
import type { TasksForTurn } from '../task-service.js';
import type { Task, AdvanceResult, UserTask, ConversationTask, ActionClaim } from './task-tracking.js';
import { sessionClient } from './assistant-session.js';

export type { TasksForTurn };

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const lambda = sessionClient(LambdaClient, { region: AWS_REGION });

/** Read at CALL time, so a test that sets it after import still sees it. */
function serviceArn(): string {
  return process.env.TASK_SERVICE_ARN || '';
}

/** True when this deployment routes task access through the service. */
export function hasTaskService(): boolean {
  return !!serviceArn();
}

/** The empty answer, which is what every failure returns. */
const EMPTY: TasksForTurn = { current: null, here: [], elsewhere: [] };

async function invoke<T>(op: string, input: unknown): Promise<T> {
  const arn = serviceArn();
  if (!arn) throw new Error(`TASK_SERVICE_ARN unset; cannot run '${op}'`);
  return (await invokeTaskServiceOp<T>(lambda, arn, op, input)) as T;
}

/**
 * Everything a turn needs to know about tasks, in ONE call.
 *
 * COMPOSITE BECAUSE OF THE BUDGET, not for tidiness. The three reads it replaces run sequentially
 * before the model call; three invokes would cost more than time-to-first-feedback can afford, while
 * one invoke whose parts run concurrently inside the service is close to the cost of the reads today.
 * A future read a turn needs belongs INSIDE this shape rather than beside it.
 */
export async function tasksForTurn(input: {
  channelArn: string;
  taskId?: string;
  senderArn?: string;
}): Promise<TasksForTurn> {
  try {
    return (await invoke<TasksForTurn>('tasksForTurn', input)) ?? EMPTY;
  } catch (err) {
    console.warn('[task-service-client] tasksForTurn failed; answering without task context', {
      err: (err as Error)?.message,
    });
    return EMPTY;
  }
}

/**
 * The router's reads.
 *
 * EACH ANSWERS EMPTY ON REFUSAL AND ON FAILURE ALIKE, the rule the rest of this client follows: a
 * refusal that looked different from a failure would be a probe, and a caller that fell back to the
 * table on either would answer with exactly the data the boundary withheld.
 */
export async function ownerChannelTasks(input: {
  ownerId: string;
  channelArn: string;
  opts?: { endedWithinMs?: number };
}): Promise<{ live: UserTask[]; recentlyEnded: UserTask[] }> {
  const empty = { live: [], recentlyEnded: [] };
  try {
    return (await invoke<{ live: UserTask[]; recentlyEnded: UserTask[] }>('ownerChannelTasks', input)) ?? empty;
  } catch (err) {
    console.warn('[task-service-client] ownerChannelTasks failed', { err: (err as Error)?.message });
    return empty;
  }
}

export async function activeTaskByType(input: {
  personId: string;
  taskType: string;
  channelArn?: string;
}): Promise<UserTask | null> {
  try {
    return (await invoke<UserTask | null>('activeTaskByType', input)) ?? null;
  } catch (err) {
    console.warn('[task-service-client] activeTaskByType failed', { err: (err as Error)?.message });
    return null;
  }
}

/**
 * Discard the work a stop named, once the person has answered it.
 *
 * A REFUSAL READS AS ZERO, like every other call here: the caller cannot tell a refused channel from
 * work that was already gone, and the stop reply does not change either way.
 */
/** Close the work an ended duel's sides opened. A refusal or a failure reads as nothing closed. */
export async function endDuelTasks(input: { channelArn: string; battleId: string }): Promise<{ closed: Array<{ taskId: string; assistantId?: string }> }> {
  try {
    return (await invoke<{ closed: Array<{ taskId: string; assistantId?: string }> }>('endDuelTasks', input)) ?? { closed: [] };
  } catch (err) {
    console.warn('[task-service-client] endDuelTasks failed', { err: (err as Error)?.message });
    return { closed: [] };
  }
}

export async function cancelStoppedTasks(input: {
  channelArn: string;
  taskIds: string[];
}): Promise<{ cancelled: number }> {
  try {
    return (await invoke<{ cancelled: number }>('cancelStoppedTasks', input)) ?? { cancelled: 0 };
  } catch (err) {
    console.warn('[task-service-client] cancelStoppedTasks failed', { err: (err as Error)?.message });
    return { cancelled: 0 };
  }
}

export async function stoppableTasks(input: {
  channelArn: string;
  requesterPersonId: string;
  assistantId?: string;
}): Promise<Array<{ summary: ConversationTask; full: Task }>> {
  try {
    return (await invoke<Array<{ summary: ConversationTask; full: Task }>>('stoppableTasks', input)) ?? [];
  } catch (err) {
    console.warn('[task-service-client] stoppableTasks failed', { err: (err as Error)?.message });
    return [];
  }
}

/**
 * The open work in one conversation belonging to one person and one assistant (ADR-024 D8).
 *
 * EMPTY ON FAILURE, like every other read here. This feeds a hint that improves a turn; a turn that
 * loses it answers on the runtime's assumption instead, which is the behavior that existed before
 * the hint did.
 */
export async function referentCandidates(input: {
  channelArn: string;
  assistantId: string;
  ownerPersonId: string;
}): Promise<UserTask[]> {
  try {
    return (await invoke<UserTask[]>('referentCandidates', input)) ?? [];
  } catch (err) {
    console.warn('[task-service-client] referentCandidates failed', { err: (err as Error)?.message });
    return [];
  }
}

export async function applyUserResponse(input: {
  taskId: string;
  channelArn: string;
  assistantId: string;
  messageId?: string;
  /**
   * THE MACHINES THIS TURN RESOLVED, and they are declared because they already travel.
   *
   * The router sends them (`machines: taskStateMachines()`) and the service spreads its input into
   * `applyUserResponseToTask`, so a pack-declared awaiting state hands back correctly today - by
   * accident of both sides passing an object through untouched. Neither type said so, so any
   * ordinary edit that names the fields it forwards would have dropped them, and the symptom is
   * silence: a deployment's own task type simply stops being handed back to the person it awaits.
   *
   * Absent, `applyUserResponseToTask` falls back to the platform defaults, which is the right
   * behavior for a caller that has none to offer.
   */
  machines?: Record<string, unknown>;
}): Promise<{ applied: boolean; reason?: string; from?: string; to?: string }> {
  try {
    return (await invoke<{ applied: boolean; reason?: string }>('applyUserResponse', input))
      ?? { applied: false, reason: 'not_awaiting' };
  } catch (err) {
    console.warn('[task-service-client] applyUserResponse failed', { err: (err as Error)?.message });
    return { applied: false, reason: 'not_awaiting' };
  }
}

/**
 * SYNCHRONOUS, unlike the other write here. The count it returns is what the stall signal is emitted
 * from, so an acknowledgement would make every turn look like the first one in its state.
 */
export async function recordTaskDelivery(input: {
  taskId: string; channelArn: string; delivery: unknown;
}): Promise<void> {
  try {
    await invoke<void>('recordTaskDelivery', input);
  } catch (err) {
    console.warn('[task-service-client] recordTaskDelivery failed', { err: (err as Error)?.message });
  }
}

export async function markTaskPrivate(input: { taskId: string; channelArn: string }): Promise<void> {
  try {
    await invoke<void>('markTaskPrivate', input);
  } catch (err) {
    // Loud, not swallowed: a task left conversation-visible after a targeted request is the leak
    // this exists to prevent.
    console.error('[task-service-client] markTaskPrivate failed', { err: (err as Error)?.message });
  }
}

/**
 * Claim one entry's declared step action before it runs (SPEC-TASK-STATE-TRANSITIONS FR29). A transport
 * fault is a claim NOT made, so the action does not run: at most once is the contract.
 */
export async function claimStateAction(input: { taskId: string; channelArn: string; state: string; toolRun?: string }): Promise<ActionClaim> {
  try {
    return (await invoke<ActionClaim>('claimStateAction', input))
      ?? { claimed: false, key: `${input.state}#?`, reason: 'failed' };
  } catch (err) {
    console.warn('[task-service-client] claimStateAction failed', { err: (err as Error)?.message });
    return { claimed: false, key: `${input.state}#?`, reason: 'failed' };
  }
}

/** An event run's exactly-once claim (ADR-061 decision 5). A failure is not a claim. */
export async function claimEventRun(input: { runKey: string; channelArn: string; workflow: string }): Promise<{ claimed: boolean }> {
  try {
    return (await invoke<{ claimed: boolean }>('claimEventRun', input)) ?? { claimed: false };
  } catch (err) {
    console.warn('[task-service-client] claimEventRun failed', { err: (err as Error)?.message });
    return { claimed: false };
  }
}

/** One event step's claim and outcome: the one conditional write that decides what the step posts. */
export async function claimEventStep(input: { runKey: string; channelArn: string; step: string; outcome: string }): Promise<{ claimed: boolean }> {
  try {
    return (await invoke<{ claimed: boolean }>('claimEventStep', input)) ?? { claimed: false };
  } catch (err) {
    console.warn('[task-service-client] claimEventStep failed', { err: (err as Error)?.message });
    return { claimed: false };
  }
}

/** Record that a run greeted a person by name. A failure is only logged. */
export async function recordEventGreeting(input: { channelArn: string; personArn: string }): Promise<void> {
  try { await invoke('recordEventGreeting', input); } catch (err) { console.warn('[task-service-client] recordEventGreeting failed', { err: (err as Error)?.message }); }
}

/** Whether a run greeted this person by name here. A failure reads as not greeted, so the first turn greets. */
export async function wasGreetedByEventRun(input: { channelArn: string; personArn: string }): Promise<boolean> {
  try { return (await invoke<boolean>('wasGreetedByEventRun', input)) === true; } catch { return false; }
}

export async function noTransitionTurn(input: { task: Task }): Promise<number> {
  try {
    return (await invoke<number>('noTransitionTurn', input)) ?? (input.task.turnsInState ?? 0);
  } catch (err) {
    console.warn('[task-service-client] noTransitionTurn failed', { err: (err as Error)?.message });
    return input.task.turnsInState ?? 0;
  }
}

/** One task the caller already holds the id for. Null on refusal and on failure alike. */
export async function getTask(input: { taskId: string; channelArn: string; consistent?: boolean }): Promise<Task | null> {
  try {
    return (await invoke<Task | null>('getTask', input)) ?? null;
  } catch (err) {
    console.warn('[task-service-client] getTask failed', { err: (err as Error)?.message });
    return null;
  }
}

/**
 * FIRE AND FORGET, for a write nobody reads back.
 *
 * `Event` returns as soon as Lambda ACCEPTS the payload rather than waiting for the work, so the cost
 * on a person's wait is the accept and not the write. That is only sound where the result is unused,
 * which is why it is not the default: a caller that needs an answer and gets an acknowledgement would
 * read a stale row and never know.
 */
async function invokeAsync(op: string, input: unknown): Promise<void> {
  const arn = serviceArn();
  if (!arn) throw new Error(`TASK_SERVICE_ARN unset; cannot run '${op}'`);
  await invokeTaskServiceOp(lambda, arn, op, input, 'Event');
}

/**
 * Open a task. Null ONLY when the service refused this conversation.
 *
 * A FAILURE IS NOT A REFUSAL (invariant E, ADR-033). This returned null for both, so a throttle, a
 * timeout or a cold start was indistinguishable from a deliberate boundary saying no - and the
 * caller, which throws on null, turned a transient blip into "I encountered an issue. Could you
 * try rephrasing?" with no turn dispatched at all. The person had done nothing wrong and
 * rephrasing could not help.
 *
 * The transport failure throws now, so the two are separable by anything that cares. Falling back
 * to the direct path is deliberately NOT done: reading around a boundary that is merely unreachable
 * would make it a suggestion.
 */
export async function createTask(input: {
  event: { inputTranscript?: string; requestAttributes?: Record<string, string> };
  deliveryOption: string;
  taskType?: string;
  correlationId?: string;
  opts?: Record<string, unknown>;
}): Promise<Task | null> {
  try {
    return (await invoke<Task | null>('createTask', input)) ?? null;
  } catch (err) {
    console.error('[task-service-client] createTask could not reach the service', {
      err: (err as Error)?.message,
    });
    throw err;
  }
}

/**
 * Record a status. Returns nothing, by construction and by contract.
 *
 * ASYNCHRONOUS because `updateTaskStatus` returns void and no call site reads it, so waiting for the
 * write would buy a person's patience nothing. The refusal still happens on the service side, so
 * fire-and-forget is not unchecked - it is unwaited.
 */
export async function updateTaskStatus(input: {
  taskId: string;
  channelArn: string;
  status: string;
  result?: string;
  error?: string;
}): Promise<void> {
  try {
    await invokeAsync('updateTaskStatus', input);
  } catch (err) {
    // Swallowed to match the direct call it replaces, which logs and returns rather than throwing:
    // a status that failed to record must not fail the turn that was recording it.
    console.warn('[task-service-client] updateTaskStatus dispatch failed', {
      err: (err as Error)?.message,
    });
  }
}

/**
 * Move a task to a new state.
 *
 * SYNCHRONOUS, unlike the status write, because the tool loop branches on the result: an illegal
 * transition has to come back as one so the model is told, rather than being discovered later as a
 * task that never moved.
 *
 * A FAILURE IS REPORTED AS A FAILED ADVANCE, not as an exception, so the caller's existing branch on
 * `ok: false` covers a transport fault the same way it covers a rejected transition. `persist_failed`
 * is the honest label: from the caller's side, the state did not change.
 */
export async function advanceTaskState(input: {
  taskId: string;
  channelArn: string;
  toState: string;
  by?: 'tool' | 'system';
  reason?: string;
  messageId?: string;
  details?: Record<string, unknown>;
  machines?: Record<string, unknown>;
  assistantId?: string;
  action?: { tool: string; outcome: 'success' | 'failure' };
  conditionValues?: Record<string, string | number | boolean | readonly string[]>;
}): Promise<AdvanceResult> {
  try {
    return (await invoke<AdvanceResult>('advanceTaskState', input))
      ?? { ok: false, error: 'persist_failed' };
  } catch (err) {
    console.warn('[task-service-client] advanceTaskState failed', { err: (err as Error)?.message });
    return { ok: false, error: 'persist_failed' };
  }
}

// ── A WORKFLOW'S TASKS AND AN IDLE ASSISTANT'S WORK (ADR-063) ─────────────────────────────────────────────

/** Open a workflow step's task. Null when the service refused or could not write it. */
export async function openWorkflowTask(input: Record<string, unknown>): Promise<Task | null> {
  try {
    return (await invoke<Task | null>('openWorkflowTask', input)) ?? null;
  } catch (err) {
    console.warn('[task-service-client] openWorkflowTask failed', { err: (err as Error)?.message });
    return null;
  }
}

/**
 * A PERSON'S CHOICE ON THEIR TASK (ADR-063 decision 2), relayed: by the card's route, or by the router for an answer the
 * person wrote (a drift offer's reply, WT89). The service takes it only for the assignee, in the state named, along a
 * choice that state declares, and closes the task. A transport fault is a refusal.
 */
export async function advanceAsAssignee(input: {
  taskId: string; channelArn: string; callerPersonId: string; state: string; choice: string; messageId?: string; continuedByCaller?: boolean;
}): Promise<{ ok: boolean; to?: string; error?: string }> {
  try {
    return (await invoke<{ ok: boolean; to?: string; error?: string }>('advanceAsAssignee', input)) ?? { ok: false, error: 'REFUSED' };
  } catch (err) {
    console.warn('[task-service-client] advanceAsAssignee failed', { err: (err as Error)?.message });
    return { ok: false, error: 'REFUSED' };
  }
}

/** A reopen run's step takes the reopened task (`takes: 'reopened'`). Null when refused, undefined on a fault. */
export async function takeReopenedTask(input: { taskId: string; channelArn: string; fromRunKey: string; workflowRun: Record<string, unknown>; ttlSeconds?: number }): Promise<Task | null | undefined> {
  try {
    return (await invoke<Task | null>('takeReopenedTask', input)) ?? null;
  } catch (err) {
    console.warn('[task-service-client] takeReopenedTask failed', { err: (err as Error)?.message });
    return undefined;
  }
}

/** A request whose task no router turn opened takes its intent's run (WT115, WT106). Null when refused or not written. */
export async function attachRequestRun(input: { taskId: string; channelArn: string; workflowRun: Record<string, unknown>; dueBy?: string; ttlSeconds?: number }): Promise<Task | null | undefined> {
  try {
    return (await invoke<Task | null>('attachRequestRun', input)) ?? null;
  } catch (err) {
    // A FAULT IS NOT A REFUSAL: undefined, which the caller may try again; null is the service's refusal.
    console.warn('[task-service-client] attachRequestRun failed', { err: (err as Error)?.message });
    return undefined;
  }
}

/** The task a requester may move while another person holds it, with the moves its step allows (WT114), or null. */
export async function requesterMovableTask(input: { channelArn: string; personId: string; machines?: Record<string, unknown> }): Promise<{ task: Task; moves: string[] } | null> {
  try {
    return (await invoke<{ task: Task; moves: string[] } | null>('requesterMovableTask', input)) ?? null;
  } catch (err) {
    console.warn('[task-service-client] requesterMovableTask failed', { err: (err as Error)?.message });
    return null;
  }
}

/** Hold a run's wait and its continuation (WT20). A transport fault holds nothing. */
export async function holdRunWait(input: { waitId: string; channelArn: string; continuation: Record<string, unknown> }): Promise<{ claimed: boolean; reason?: string }> {
  try {
    return (await invoke<{ claimed: boolean; reason?: string }>('holdRunWait', input)) ?? { claimed: false };
  } catch (err) {
    console.warn('[task-service-client] holdRunWait failed', { err: (err as Error)?.message });
    return { claimed: false };
  }
}

/** The continuation a run's wait holds. A transport fault reads nothing. */
export async function readRunWait(input: { waitId: string; channelArn: string }): Promise<Record<string, unknown> | null> {
  try {
    return (await invoke<Record<string, unknown> | null>('readRunWait', input)) ?? null;
  } catch (err) {
    console.warn('[task-service-client] readRunWait failed', { err: (err as Error)?.message });
    return null;
  }
}

/** Record a run's end (WT62). A transport fault records nothing and fails nothing. */
export async function recordRunEnded(input: Record<string, unknown>): Promise<{ recorded: boolean }> {
  try {
    return (await invoke<{ recorded: boolean }>('recordRunEnded', input)) ?? { recorded: false };
  } catch (err) {
    console.warn('[task-service-client] recordRunEnded failed', { err: (err as Error)?.message });
    return { recorded: false };
  }
}

/** End a task step's task at its deadline. A transport fault cancels nothing. */
export async function cancelForDeadline(input: { taskId: string; channelArn: string }): Promise<{ cancelled: boolean }> {
  try {
    return (await invoke<{ cancelled: boolean }>('cancelForDeadline', input)) ?? { cancelled: false };
  } catch (err) {
    console.warn('[task-service-client] cancelForDeadline failed', { err: (err as Error)?.message });
    return { cancelled: false };
  }
}

/** An assistant's ready work here, in pickup order. A failure is no work, and the turn releases as it always did. */
export async function readyTasks(input: { channelArn: string; assistantId: string }): Promise<Task[]> {
  try {
    return (await invoke<Task[]>('readyTasks', input)) ?? [];
  } catch (err) {
    console.warn('[task-service-client] readyTasks failed', { err: (err as Error)?.message });
    return [];
  }
}

/** Take up one entry of a task's state. A transport fault is a claim not made, so nothing is taken up twice. */
export async function claimPickup(input: { taskId: string; channelArn: string; state: string }): Promise<ActionClaim> {
  try {
    return (await invoke<ActionClaim>('claimPickup', input)) ?? { claimed: false, key: `pickup:${input.state}#?`, reason: 'failed' };
  } catch (err) {
    console.warn('[task-service-client] claimPickup failed', { err: (err as Error)?.message });
    return { claimed: false, key: `pickup:${input.state}#?`, reason: 'failed' };
  }
}

/**
 * THE OPEN TASKS OF ONE MACHINE IN EVERY CONVERSATION A CONVERSATION'S WORKFLOW OPENED (WT122), each whole: for a limit
 * counted from them. A read that fails is null, never an empty list, so a limit is never passed because its count could not
 * be taken.
 */
export async function openTasksOpenedFrom(input: { openedFrom: string; taskType: string }): Promise<Task[] | null> {
  try {
    const tasks = await invoke<Task[] | null>('openTasksOpenedFrom', input);
    return Array.isArray(tasks) ? tasks : null;
  } catch (err) {
    console.warn('[task-service-client] openTasksOpenedFrom failed', { err: (err as Error)?.message });
    return null;
  }
}

/** Settle an archived conversation's open workflow tasks (ADR-017): the ids it settled, or null when it could not. */
export async function settleArchivedTasks(input: { channelArn: string }): Promise<string[] | null> {
  try {
    const out = await invoke<{ settled?: string[]; failed?: true }>('settleArchivedTasks', input);
    return Array.isArray(out?.settled) ? out!.settled : null;
  } catch (err) {
    console.warn('[task-service-client] settleArchivedTasks failed', { err: (err as Error)?.message });
    return null;
  }
}

/** Cancel the open work of a run a settlement ended mid-way (`endsRun`): the ids it cancelled, or null when it could not. */
export async function endRunTasks(input: { channelArn: string; runKey: string; keepAlongside?: boolean; keepTaskId?: string }): Promise<string[] | null> {
  try {
    const out = await invoke<{ cancelled?: string[]; failed?: true }>('endRunTasks', input);
    return Array.isArray(out?.cancelled) ? out!.cancelled : null;
  } catch (err) {
    console.warn('[task-service-client] endRunTasks failed', { err: (err as Error)?.message });
    return null;
  }
}

/** Which of a run's step claims are held, with their outcomes. A transport fault is null, never "none held". */
export async function readEventSteps(input: { runKey: string; channelArn: string; steps: string[] }): Promise<Record<string, string> | null> {
  try {
    const out = await invoke<Record<string, string> | null>('readEventSteps', input);
    return out && typeof out === 'object' ? out : null;
  } catch (err) {
    console.warn('[task-service-client] readEventSteps failed', { err: (err as Error)?.message });
    return null;
  }
}

/**
 * The ids of a conversation's open tasks a workflow step opened (`evt-` ids), for deleting their deadlines on archive.
 * `skipMachines` leaves out the tasks of the machines the platform runs itself: a runbook refresh, a meeting's
 * action item, which no workflow run waits on.
 */
export async function workflowTaskIds(input: { channelArn: string; skipMachines?: readonly string[] }): Promise<string[]> {
  try {
    const rows = (await invoke<Array<{ taskId: string; taskType?: string }>>('adminListTasks', { channelArn: input.channelArn })) ?? [];
    return rows
      .filter((r) => !input.skipMachines?.length || !input.skipMachines.includes(r.taskType ?? ''))
      .map((r) => r.taskId).filter((id) => typeof id === 'string' && id.startsWith('evt-'));
  } catch (err) {
    console.warn('[task-service-client] workflowTaskIds failed', { err: (err as Error)?.message });
    return [];
  }
}

/**
 * The open item an id names, when its sender may answer it (ADR-035): the task service's own check, the one the channel flow
 * asks. Null on a refusal, an id naming nothing, or a transport fault, so an id it could not confirm is never honored.
 */
export async function answerableTaskById(input: { channelArn: string; taskId: string; senderSub: string }): Promise<{ taskId: string; assistantId?: string; private?: true } | null> {
  try {
    const found = await invoke<{ taskId?: string; assistantId?: string; private?: true } | null>('answerableTaskById', input);
    return found && typeof found.taskId === 'string' && found.taskId ? found as { taskId: string; assistantId?: string; private?: true } : null;
  } catch (err) {
    console.warn('[task-service-client] answerableTaskById failed', { err: (err as Error)?.message });
    return null;
  }
}

/** A revision that will not land is cleared, so another may be asked. Never throws. */
export async function abandonRevision(input: { taskId: string; channelArn: string; n: number }): Promise<{ cleared: boolean }> {
  try {
    return (await invoke<{ cleared: boolean }>('abandonRevision', input)) ?? { cleared: false };
  } catch (err) {
    console.warn('[task-service-client] abandonRevision failed', { err: (err as Error)?.message });
    return { cleared: false };
  }
}

/** The drafting assistant's revision lands as the task's next version. Never throws. */
export async function addRevisedDocument(input: { taskId: string; channelArn: string; fileKey: string; name: string; by: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    return (await invoke<{ ok: boolean; error?: string }>('addRevisedDocument', input)) ?? { ok: false };
  } catch (err) {
    console.warn('[task-service-client] addRevisedDocument failed', { err: (err as Error)?.message });
    return { ok: false };
  }
}
