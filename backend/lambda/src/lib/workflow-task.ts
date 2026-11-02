/**
 * THE DECISIONS ABOUT A TASK A WORKFLOW ASSIGNED, AND ABOUT WORK AN IDLE ASSISTANT TAKES UP (ADR-063).
 *
 * Pure: every function here reads a task row and the machines and decides, and nothing here reads or writes a table. The
 * task service makes the writes (`task-service.ts`), the router acts on what it names (`router-agent-handler.ts`), and
 * the turn's exit asks which work is next (`turn-handover.ts`), each through these functions, so the rules live once.
 *
 * What it guarantees:
 *  - HOW A TASK ENDED IS READ FROM ITS ROW (`settlementOutcome`): its terminal state and that state's declared kind, or a
 *    deadline's cancel, never anything anybody wrote.
 *  - A CARD PRESS MOVES ONLY WHAT IT WAS DRAWN FOR (`assigneeAdvanceRefusal`): the caller is the task's current assignee,
 *    the task is still live and still in the state the card showed, and the choice is one that state declares.
 *  - READY, BLOCKED AND WAITING ARE DATA (`pickupReadiness`, decision 5): the state's declarations (`awaits`, `rests`,
 *    `action`, `transitions`) and the row's lifecycle, claims and turn count. No phrase is recognized (tenet D11).
 *  - ONE TOTAL ORDER (`orderForPickup`): priority, then age, then id.
 */
import { createHash } from 'crypto';
import { awaitedPartyOf, entrySequenceOf, terminalKindOf, type TaskStateMachine } from './task-state-machines.js';
import type { Task, TaskPriority } from './task-tracking.js';

/** The `error` a task's deadline writes when it cancels the task (decision 4), which the settlement reads back. */
export const TASK_DEADLINE_ENDING = 'deadline';

/** The lifecycle statuses an ended task carries. */
const ENDED_STATUSES = new Set(['completed', 'failed', 'cancelled']);
/** The lifecycle statuses a task an assistant may take up carries. */
const LIVE_STATUSES = new Set(['pending', 'in_progress']);

/**
 * HOW A TASK ENDED, as the outcome its run continues on (decision 3), or undefined while it is still open. A deadline's
 * cancel is `task:deadline`; a terminal state is `task:<its kind>:<its name>`; any other ending (an operator's cancel, a
 * stop, a failure) is `task:failure:<the state it rested in>`.
 */
export function settlementOutcome(task: Pick<Task, 'taskType' | 'taskState' | 'status' | 'error'>, machines: Record<string, TaskStateMachine>): string | undefined {
  if (!task.taskType || !task.taskState) return undefined;
  if (task.status === 'cancelled' && task.error === TASK_DEADLINE_ENDING) return 'task:deadline';
  const kind = terminalKindOf(task.taskType, task.taskState, machines);
  if (kind) return `task:${kind}:${task.taskState}`;
  return ENDED_STATUSES.has(task.status) ? `task:failure:${task.taskState}` : undefined;
}

/** What a task card carries on a message's Metadata (decision 2): ids and declared names only, never words. */
export interface TaskCard {
  id: string;
  state: string;
  choices: string[];
  /** Epoch seconds: the card offers nothing after it. */
  expiresAt?: number;
}

/** The card for a task whose current state declares choices, or undefined. */
export function taskCardOf(task: Pick<Task, 'taskId' | 'taskType' | 'taskState' | 'workflowRun'>, machines: Record<string, TaskStateMachine>): TaskCard | undefined {
  const def = task.taskType && task.taskState ? machines[task.taskType]?.states[task.taskState] : undefined;
  if (!def?.choices?.length || !task.taskState) return undefined;
  return {
    id: task.taskId, state: task.taskState, choices: [...def.choices],
    ...(typeof task.workflowRun?.deadlineAt === 'number' ? { expiresAt: task.workflowRun.deadlineAt } : {}),
  };
}

/** Why a card press is refused, as the route answers it, or undefined when it may be taken. */
export type AssigneeAdvanceRefusal = 'NOT_FOUND' | 'NOT_ASSIGNEE' | 'SETTLED' | 'STATE_MOVED' | 'NOT_A_CHOICE';

/**
 * WHETHER THE CALLER MAY TAKE A CHOICE ON THIS TASK'S CARD (decision 2, the FR17 submission advance). Only the task's
 * current assignee, and only a person (an assistant advances through its own turn); only a live task still in the state
 * the card was drawn for; only a choice that state declares. The edge's own conditions are then checked by the advance
 * itself (`authorizeTransition`).
 */
export function assigneeAdvanceRefusal(
  task: Pick<Task, 'taskType' | 'taskState' | 'status' | 'assigneeId' | 'assigneeType'> | null,
  machines: Record<string, TaskStateMachine>,
  press: { callerPersonId: string; state: string; choice: string },
): AssigneeAdvanceRefusal | undefined {
  if (!task?.taskType || !task.taskState) return 'NOT_FOUND';
  // A SETTLED TASK IS SAID TO BE SETTLED, whoever presses: once it ends it is handed back to its assistant, so the person
  // who pressed a second time is no longer its assignee, and "not yours" would be the wrong reason.
  if (!LIVE_STATUSES.has(task.status) || !machines[task.taskType]?.states[task.taskState]?.transitions.length) return 'SETTLED';
  if (!press.callerPersonId || task.assigneeType !== 'user' || task.assigneeId !== press.callerPersonId) return 'NOT_ASSIGNEE';
  if (task.taskState !== press.state) return 'STATE_MOVED';
  const choices = machines[task.taskType]?.states[task.taskState]?.choices ?? [];
  return choices.includes(press.choice) ? undefined : 'NOT_A_CHOICE';
}

/** Why an assistant does not take a task up now (decision 5): the task is blocked, or its state requires waiting. */
export type PickupHold =
  | 'not-assigned' | 'not-live' | 'no-machine'
  // Requires waiting.
  | 'terminal' | 'awaits-another' | 'rests'
  // Blocked.
  | 'runs-an-action' | 'taken-up' | 'worked-this-entry' | 'delivered-this-entry';

/** The claim a pickup takes on the task row, once per entry into a state: `pickup:<state>`, keyed further by entry. */
export const pickupClaimState = (state: string): string => `pickup:${state}`;

/**
 * WHETHER AN ASSISTANT TAKES THIS TASK UP NOW (decision 5), read from the machine and the row alone. Ready when the
 * assistant is the assignee and nothing holds it: its state is not terminal, awaits nobody (or the worker, who is this
 * assistant), does not rest and runs no declared action; its lifecycle is live; and this entry of the state was neither
 * taken up already, nor worked by a turn that did not move it, nor delivered from: a document handed over from this
 * entry, whether attached or posted inline, is the step's work done, so no turn writes it again (ADR-064 decision B).
 */
export function pickupReadiness(
  task: Pick<Task, 'taskType' | 'taskState' | 'status' | 'assigneeId' | 'assigneeType' | 'workerId' | 'workerType' | 'actionRuns' | 'stateHistory' | 'turnsInState' | 'deliveries'>,
  machines: Record<string, TaskStateMachine>,
  assistantId: string,
): { ready: true } | { ready: false; hold: PickupHold } {
  const hold = (h: PickupHold) => ({ ready: false as const, hold: h });
  if (!assistantId || task.assigneeType !== 'assistant' || task.assigneeId !== assistantId) return hold('not-assigned');
  if (!LIVE_STATUSES.has(task.status)) return hold('not-live');
  const def = task.taskType && task.taskState ? machines[task.taskType]?.states[task.taskState] : undefined;
  if (!def || !task.taskState) return hold('no-machine');
  if (!def.transitions.length) return hold('terminal');
  const awaited = awaitedPartyOf(def);
  if (awaited && !(awaited.party === 'worker' && task.workerType === 'assistant' && task.workerId === assistantId)) return hold('awaits-another');
  if (def.rests) return hold('rests');
  if (def.action) return hold('runs-an-action');
  const entry = entrySequenceOf(task.stateHistory, task.taskState);
  if ((task.actionRuns ?? []).includes(`${pickupClaimState(task.taskState)}#${entry}`)) return hold('taken-up');
  if ((task.turnsInState ?? 0) > 0) return hold('worked-this-entry');
  if (deliveredThisEntry(task, task.taskState)) return hold('delivered-this-entry');
  return { ready: true };
}

/**
 * WHETHER A DOCUMENT WAS HANDED OVER FROM THE CURRENT ENTRY OF A STATE: a delivery recorded from the state at or after
 * the task last entered it (`stateHistory`), or any from it when the task was opened there and never re-entered it.
 */
export function deliveredThisEntry(task: Pick<Task, 'stateHistory' | 'deliveries'>, state: string): boolean {
  const entries = (task.stateHistory ?? []).filter((e) => e && e.to === state);
  const enteredAt = entries.length ? String(entries[entries.length - 1].at ?? '') : '';
  return (task.deliveries ?? []).some((d) => d.fromState === state && String(d.at ?? '') >= enteredAt);
}

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/** The order an idle assistant takes its ready tasks in (decision 5): high, normal, low; then the oldest; then by id. */
export function orderForPickup<T extends Pick<Task, 'priority' | 'createdAt' | 'taskId'>>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => (PRIORITY_RANK[a.priority ?? 'normal'] - PRIORITY_RANK[b.priority ?? 'normal'])
    || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    || a.taskId.localeCompare(b.taskId));
}

/** Whose budget a pickup turn spends (decision I3): the owner's for a queued request they asked for, the global budget otherwise. */
export function pickupBudget(task: Pick<Task, 'taskType' | 'ownerPersonId'>): { owner: string } | 'machineWritten' {
  return task.taskType === 'queued_request' && task.ownerPersonId ? { owner: task.ownerPersonId } : 'machineWritten';
}

/**
 * THE CORRELATION A PICKUP TURN RUNS UNDER: one per task, state and entry, so two namings of the same ready step collapse
 * into one turn at the processor's dedup claim, and the lock handed to it names exactly that turn.
 */
export function pickupCorrelationId(task: Pick<Task, 'taskId' | 'taskState' | 'stateHistory'>): string {
  const entry = entrySequenceOf(task.stateHistory, task.taskState ?? '');
  return `pickup-${createHash('sha256').update(`${task.taskId}#${task.taskState ?? ''}#${entry}`).digest('hex').slice(0, 32)}`;
}

/** What the processor's exit hands the router when it gives the lock to a pickup turn (decision 5). Ids only. */
export interface TaskPickupRequest { channelArn: string; botArn: string; taskId: string; correlationId: string }
