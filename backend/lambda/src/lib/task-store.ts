/**
 * THE ONE PLACE A TURN TOUCHES TASKS.
 *
 * Signature-compatible with `task-tracking.js`, so migrating a call site is a change of import and
 * nothing else. That is deliberate: a migration that also rewrites bodies is one where a behavior
 * change hides inside a refactor, and there are a dozen call sites to move.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────────────────
 *
 * Governance is infrastructure, and every sensitive operation is supposed to carry at least two
 * enforcement layers so one missed check is not a breach. Task access had one: a `channelArn` the
 * caller supplied, in a query. The service is the second layer, and it can only BE the second layer
 * if callers stop reaching the table directly - which is what this seam makes cheap.
 *
 * ── THE MIGRATION IS OVER *NOW*, AND THE FALLBACK IS UNREACHABLE IN SERVICE ─────────────────────
 *
 * `hasTaskService()` gated each function while the call sites were being moved, so a deployment that
 * had not enabled the service kept working. That phase is finished: the direct table grants are off
 * the router and processor roles, so on any deployed environment the fallback below could not read
 * anything even if it ran.
 *
 * IT SAID THAT ONCE BEFORE IT WAS TRUE, and the gap is worth keeping written down. The processor had
 * been moved onto `tasksForTurn`; the ROUTER had not, and still imported its reads from
 * `task-tracking` - while the grants came off both roles as though both had moved. Every unit test
 * stayed green, because DynamoDB is mocked there and removing a grant only makes the boundary test
 * greener. It surfaced on a real deployment as `AccessDeniedException` on every turn that asked who
 * owned the work. The router's reads are at the bottom of this file now, and the boundary test's
 * FRONTED list names them, so the same half-migration cannot be declared finished again.
 *
 * It is kept because the ARN is unset in unit tests, which is what lets them exercise the real task
 * logic against a mocked table rather than a mocked service. In a deployed environment the stack that
 * grants the invoke is the same one that sets the ARN, so the service path is the only path.
 *
 * That invariant is asserted rather than assumed - `test/task-store-boundary.test.ts` pins both
 * halves: every turn function is told where the service is, and the service role is the ONLY holder
 * of the tables.
 *
 * ── AND WHAT THE SERVICE REFUSING MEANS ──────────────────────────────────────────────────────────
 *
 * Not "unavailable, read around it". A refusal is the boundary deciding, and reaching past it would
 * answer with exactly the data the refusal withheld. So a refusal returns the same empty answer a
 * failure does, and neither one falls back to the table.
 */

import * as direct from './task-tracking.js';
import * as service from './task-service-client.js';
import { hasTaskService } from './task-service-client.js';
import type {
  Task, TaskStatus, AdvanceResult, LexEventForTask, TaskCreateOptions, UserTask, ConversationTask, ActionClaim,
} from './task-tracking.js';
import type { DeliveryOption } from './delivery-options.js';

export { hasTaskService };

/** One task, by id. Null when it does not exist, or when the boundary refused it. */
export async function getTask(taskId: string, channelArn: string): Promise<Task | null> {
  if (!hasTaskService()) return direct.getTask(taskId, channelArn);
  return service.getTask({ taskId, channelArn });
}

/**
 * Open a task.
 *
 * THROWS WHEN THE BOUNDARY REFUSES, and that is not the same as a failure. Every caller uses the
 * task it returns, so there is no honest empty value: a refusal means this assistant tried to open
 * work in a conversation it may not serve, which should never happen in service and must be loud
 * rather than silently producing a turn that proceeds without the task it thinks it has.
 */
export async function createTask(
  event: LexEventForTask,
  deliveryOption: DeliveryOption,
  taskType?: string,
  correlationId?: string,
  opts?: TaskCreateOptions,
): Promise<Task> {
  if (!hasTaskService()) return direct.createTask(event, deliveryOption, taskType, correlationId, opts);
  // TWO OUTCOMES, SAID SEPARATELY (invariant E). Both still stop the turn - the boundary is not
  // read around when it cannot be reached - but a refusal and an outage are no longer the same
  // sentence in the log, and the second one names something an operator can act on.
  let created;
  try {
    created = await service.createTask({
      event, deliveryOption: String(deliveryOption), taskType, correlationId,
      opts: opts as Record<string, unknown> | undefined,
    });
  } catch (err) {
    console.error('[task-store] the task service could not be reached to open a task', {
      correlationId, taskType, message: (err as Error)?.message,
    });
    throw new Error('[task-store] the task service could not be reached to open a task');
  }
  if (!created) throw new Error('[task-store] the task service refused to open a task here');
  return created;
}

/**
 * Record a status.
 *
 * Returns void, like the call it replaces, and no call site reads a result - which is what lets the
 * service dispatch it without waiting and keep the write off a person's wait entirely.
 */
export async function updateTaskStatus(
  taskId: string,
  channelArn: string,
  status: TaskStatus,
  result?: string,
  error?: string,
): Promise<void> {
  if (!hasTaskService()) return direct.updateTaskStatus(taskId, channelArn, status, result, error);
  return service.updateTaskStatus({ taskId, channelArn, status: String(status), result, error });
}

/**
 * Move a task to a new state.
 *
 * THE TASK IS PASSED IN AND ONLY ITS IDENTITY TRAVELS. The service re-reads the row so the optimistic
 * guard compares against something fresh: handing it this caller's snapshot across a network hop
 * would widen the very race the guard exists to lose loudly. The MACHINES do travel, because they are
 * this profile's and the service cannot resolve them without reimplementing profile resolution -
 * and configuration cannot go stale the way a row can.
 */
export async function advanceTaskStateTo(
  args: Parameters<typeof direct.advanceTaskStateTo>[0],
): Promise<AdvanceResult> {
  if (!hasTaskService()) return direct.advanceTaskStateTo(args);
  const { task, ...rest } = args;
  if (!task?.taskId || !task?.channelArn) return { ok: false, error: 'no_active_task' };
  return service.advanceTaskState({
    taskId: task.taskId,
    channelArn: task.channelArn,
    ...rest,
    machines: rest.machines as Record<string, unknown> | undefined,
  });
}

/**
 * ── THE ROUTER'S READS ───────────────────────────────────────────────────────────────────────────
 *
 * The migration this file's header called finished was half done. The PROCESSOR was moved onto
 * `tasksForTurn`; the ROUTER kept importing `getActiveTask`, `getAssigneeChannelTasks` and friends
 * straight from `task-tracking`, and the table grants were removed from BOTH roles as though both
 * had moved. Nothing failed in test - DynamoDB is mocked there, and the boundary test only forbids
 * importing the four FRONTED functions - so it held until a deployed router asked a real table and
 * was denied on every turn.
 *
 * These are the missing half. Signature-compatible, like everything above, so a call site moves by
 * changing its import.
 */

/** The owner's work in one conversation, live and recently ended. */
export async function getAssigneeChannelTasks(
  ownerId: string,
  channelArn: string,
  opts?: Parameters<typeof direct.getAssigneeChannelTasks>[2],
): Promise<Awaited<ReturnType<typeof direct.getAssigneeChannelTasks>>> {
  // FORWARDED EXACTLY AS GIVEN, never defaulted here. "Signature-compatible" has to include the
  // ABSENCE of an argument: defaulting it to `{}` in the seam makes a call that passed nothing
  // indistinguishable from one that passed an empty object, and a test asserting the un-scoped shape
  // sees a scope that the caller never asked for. The direct function owns its own defaults.
  if (!hasTaskService()) return direct.getAssigneeChannelTasks(ownerId, channelArn, ...(opts ? [opts] : []) as [never]);
  return service.ownerChannelTasks({ ownerId, channelArn, ...(opts ? { opts } : {}) });
}

/**
 * The owner's single active task here.
 *
 * COMPOSED FROM THE READ ABOVE rather than given an op of its own: it is the same question with the
 * first answer taken, and a second op would be a second place for "which one is active" to drift.
 */
export async function getActiveTaskForOwner(
  ownerId: string,
  channelArn: string,
): Promise<UserTask | null> {
  if (!hasTaskService()) return direct.getActiveTaskForOwner(ownerId, channelArn);
  return (await getAssigneeChannelTasks(ownerId, channelArn)).live[0] ?? null;
}

/** One active task of a given type for a person, scoped to a conversation. */
export async function getActiveTask(
  personId: string,
  taskType: string,
  opts?: { channelArn?: string },
): Promise<UserTask | null> {
  // Forwarded as given, for the reason above: a caller with no conversation to scope to passes
  // nothing, and the seam must not turn that into an empty scope object.
  if (!hasTaskService()) return direct.getActiveTask(personId, taskType, ...(opts ? [opts] : []) as [never]);
  return service.activeTaskByType({ personId, taskType, ...(opts ?? {}) });
}

/** What a `/stop` from this person, aimed at this assistant, would be about (ADR-033). */
export async function selectStoppableTasks(
  channelArn: string,
  requesterPersonId: string,
  assistantId?: string,
): Promise<Array<{ summary: ConversationTask; full: Task }>> {
  if (!hasTaskService()) return direct.selectStoppableTasks(channelArn, requesterPersonId, assistantId);
  return service.stoppableTasks({ channelArn, requesterPersonId, ...(assistantId ? { assistantId } : {}) });
}

/**
 * The open work in this conversation that belongs to this person and this assistant (ADR-024 D8).
 *
 * THROUGH THE SEAM LIKE EVERY OTHER TASK READ, and here it matters more than usual: the service is
 * where the classification boundary is applied, before the read runs. Reaching around it to the table
 * would leave the owner narrowing as the only thing standing between a turn and another
 * classification's work, which is one layer where the tenet asks for two.
 */
export async function referentCandidates(
  args: { channelArn: string; assistantId: string; ownerPersonId: string },
): Promise<Array<Parameters<typeof direct.getConversationTasksForAssistant> extends never ? never : Awaited<ReturnType<typeof direct.getConversationTasksForAssistant>>[number]>> {
  if (!hasTaskService()) {
    return direct.getConversationTasksForAssistant(args.channelArn, args.assistantId, args.ownerPersonId);
  }
  return service.referentCandidates(args) as never;
}

/** Hand a task back to the assistant when the person it awaited has replied. */
export async function applyUserResponseToTask(
  args: Parameters<typeof direct.applyUserResponseToTask>[0],
): Promise<Awaited<ReturnType<typeof direct.applyUserResponseToTask>>> {
  if (!hasTaskService()) return direct.applyUserResponseToTask(args);
  return service.applyUserResponse(args) as Promise<Awaited<ReturnType<typeof direct.applyUserResponseToTask>>>;
}

/** Count a turn that advanced no state. Returns the new count, which feeds the stall signal. */
/**
 * Narrow a task to private (DESIGN 2.4).
 *
 * Through the seam like every other task write from a turn: the processor role holds no direct
 * UpdateItem on the task tables, so the first version of this wrote straight to DynamoDB and was
 * refused by IAM on every targeted request - logged loudly, which is how it was caught, and the
 * task stayed conversation-visible anyway.
 */
/**
 * Discard the work a stop named, once the person has answered it.
 *
 * THROUGH THE SEAM, and this one was learned the hard way: the first version called the discard
 * directly from the processor and was refused by IAM on every attempt, so a person could answer "drop
 * it" and watch the work stay open. The processor holds no direct write on the task tables by design.
 */
export async function cancelStoppedTasks(
  channelArn: string,
  taskIds: string[],
): Promise<number> {
  if (!hasTaskService()) return direct.cancelStoppedTasks(channelArn, taskIds);
  const res = await service.cancelStoppedTasks({ channelArn, taskIds });
  return res?.cancelled ?? 0;
}

export async function markTaskPrivate(taskId: string, channelArn: string): Promise<void> {
  if (!hasTaskService()) return direct.markTaskPrivate(taskId, channelArn);
  return service.markTaskPrivate({ taskId, channelArn });
}

/**
 * Record what a task DELIVERED.
 *
 * Through the seam, because it writes a task row and the processor role holds no direct write on
 * the task tables. Called directly it fails with AccessDenied, which task-tracking swallows - so
 * every delivery went unrecorded and nothing said so.
 */
export async function recordTaskDelivery(
  taskId: string,
  channelArn: string,
  delivery: Parameters<typeof direct.recordTaskDelivery>[2],
): Promise<void> {
  if (!hasTaskService()) return direct.recordTaskDelivery(taskId, channelArn, delivery);
  return service.recordTaskDelivery({ taskId, channelArn, delivery });
}

/**
 * Claim one entry's declared step action before it runs (SPEC-TASK-STATE-TRANSITIONS FR29).
 *
 * ONLY THE TASK'S IDENTITY TRAVELS, as for an advance: the service re-reads the row, because the entry
 * the claim is keyed on is read from a transition log this caller's copy may predate.
 */
export async function claimStateAction(task: Task, state: string): Promise<ActionClaim> {
  if (!hasTaskService()) return direct.claimStateAction({ task, state });
  return service.claimStateAction({ taskId: task.taskId, channelArn: task.channelArn, state });
}

/**
 * RECORD THAT A STEP'S REQUIRED TOOL SUCCEEDED (ADR-064 decision 3), once per entry, by the same conditional write that
 * claims a step action, so the advance out of the step finds it however many turns the step spans.
 */
export async function recordToolRun(task: Task, state: string, tool: string): Promise<ActionClaim> {
  if (!hasTaskService()) return direct.claimStateAction({ task, state, toolRun: tool });
  const claim = await service.claimStateAction({ taskId: task.taskId, channelArn: task.channelArn, state, toolRun: tool });
  if (claim.claimed || claim.reason === 'already_claimed') task.actionRuns = [...new Set([...(task.actionRuns ?? []), claim.key])];
  return claim;
}

export async function recordNoTransitionTurn(task: Task): Promise<number> {
  if (!hasTaskService()) return direct.recordNoTransitionTurn(task);
  return service.noTransitionTurn({ task });
}

/**
 * What one person owes, across every conversation and classification (`GET /tasks/mine`).
 *
 * A DIRECT READ, and the one this seam keeps on purpose. The work-item route runs outside every
 * classification, so it has no task service of its own to ask, and the question spans all of them: the
 * mirror partition is the caller's own person id, which the route resolves from the request and never
 * takes from it. The route's role holds the read; no turn function does.
 */
export async function getActiveTasksForUser(
  personId: string,
  opts?: Parameters<typeof direct.getActiveTasksForUser>[1],
): Promise<UserTask[]> {
  return direct.getActiveTasksForUser(personId, ...(opts ? [opts] : []) as [never]);
}

/**
 * AN EVENT RUN'S CLAIMS (ADR-061 decision 5), through the task service. With no service (a unit context) the
 * claims are held by this container, which is the same answer for one invocation.
 */
const localEventClaims = new Set<string>();

export async function claimEventRun(input: { runKey: string; channelArn: string; workflow: string }): Promise<boolean> {
  if (!hasTaskService()) {
    const key = `${input.channelArn}|${input.runKey}`;
    if (localEventClaims.has(key)) return false;
    localEventClaims.add(key);
    return true;
  }
  return (await service.claimEventRun(input)).claimed;
}

export async function claimEventStep(input: { runKey: string; channelArn: string; step: string; outcome: string }): Promise<boolean> {
  if (!hasTaskService()) {
    const key = `${input.channelArn}|${input.runKey}#step#${input.step}`;
    if (localEventClaims.has(key)) return false;
    localEventClaims.add(key);
    return true;
  }
  return (await service.claimEventStep(input)).claimed;
}

const localGreetings = new Set<string>();

/** Record that a run greeted a person by name in a conversation (ADR-061 decision 5, "No greeting twice"). */
export async function recordEventGreeting(input: { channelArn: string; personArn: string }): Promise<void> {
  if (!hasTaskService()) { localGreetings.add(`${input.channelArn}|${input.personArn}`); return; }
  await service.recordEventGreeting(input);
}

/** Whether a run greeted this person by name here, read from the run's record and never from what was posted. */
export async function wasGreetedByEventRun(input: { channelArn: string; personArn: string }): Promise<boolean> {
  if (!input.personArn) return false;
  if (!hasTaskService()) return localGreetings.has(`${input.channelArn}|${input.personArn}`);
  return service.wasGreetedByEventRun(input);
}

// ── A WORKFLOW'S TASKS AND AN IDLE ASSISTANT'S WORK (ADR-063) ─────────────────────────────────────────────
// Service-only: these exist for the router and the processor of a deployed classification, whose task service holds the
// tables. With no service (a unit context) each answers as a refusal would: nothing opened, nothing ready.

export async function openWorkflowTask(input: Record<string, unknown>): Promise<Task | null> {
  return hasTaskService() ? service.openWorkflowTask(input) : null;
}
export async function cancelForDeadline(input: { taskId: string; channelArn: string }): Promise<{ cancelled: boolean }> {
  return hasTaskService() ? service.cancelForDeadline(input) : { cancelled: false };
}
export async function readyTasks(input: { channelArn: string; assistantId: string }): Promise<Task[]> {
  return hasTaskService() ? service.readyTasks(input) : [];
}
export async function claimPickup(input: { taskId: string; channelArn: string; state: string }): Promise<ActionClaim> {
  return hasTaskService() ? service.claimPickup(input) : { claimed: false, key: `pickup:${input.state}#?`, reason: 'failed' };
}
export async function workflowTaskIds(channelArn: string): Promise<string[]> {
  return hasTaskService() ? service.workflowTaskIds({ channelArn }) : [];
}
