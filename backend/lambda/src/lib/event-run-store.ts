/**
 * AN EVENT RUN'S RECORD, AND ITS EXACTLY-ONCE CLAIMS (ADR-061 decision 5).
 *
 * A run is a task record keyed `event-run#<event>#<natural key>#<assistant>` in the conversation, written once: a
 * redelivered event, a retried container or a second `WelcomeIntent` finds it and starts no second run. Each step
 * is claimed by a record of its own under the run, which carries the step's outcome, so one conditional write
 * decides between an agent step's output and its fallback and the step records are the run's transition log.
 *
 * MARKED AS AN EVENT RUN, NEVER AS WORK. The records carry `eventRun: true` and the status `event_run`, which no
 * open-work read selects, and they expire (`ttl`) 45 days after they are written (ADR-067 WT26): past every wait a run
 * may still hold, since a task step's deadline falls at most 30 days out. They hold references only.
 *
 * Reached only through the task service (`task-service.ts`), whose role holds the table; the router and the
 * processor ask it (`task-store.ts`).
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

export const EVENT_RUN_PREFIX = 'event-run#';
export const EVENT_RUN_STATUS = 'event_run';
/** At most 45 days (ADR-067 WT26), past the longest wait a run may hold (`MAX_TASK_DEADLINE_MINUTES`, 30 days). */
export const EVENT_RUN_TTL_SECONDS = 45 * 24 * 3600;

export interface EventRunClaim {
  claimed: boolean;
  /** Why it was not claimed: it already was, or the write failed. */
  reason?: 'already_claimed' | 'failed';
}

export interface EventRunStoreDeps {
  send: (command: PutCommand) => Promise<unknown>;
  table: string;
  now?: () => number;
}

const conditional = (err: unknown) => (err as { name?: string })?.name === 'ConditionalCheckFailedException';

async function putOnce(item: Record<string, unknown>, deps: EventRunStoreDeps): Promise<EventRunClaim> {
  const now = (deps.now ?? Date.now)();
  try {
    await deps.send(new PutCommand({
      TableName: deps.table,
      Item: {
        ...item,
        eventRun: true,
        status: EVENT_RUN_STATUS,
        createdAt: new Date(now).toISOString(),
        ttl: Math.floor(now / 1000) + EVENT_RUN_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(taskId)',
    }));
    return { claimed: true };
  } catch (err) {
    if (conditional(err)) return { claimed: false, reason: 'already_claimed' };
    console.error('[event-run] a claim could not be written', { err: (err as Error)?.name });
    return { claimed: false, reason: 'failed' };
  }
}

/** Claim a run. Only the first claim of a key succeeds. */
export function claimEventRun(
  input: { runKey: string; channelArn: string; workflow: string },
  deps: EventRunStoreDeps,
): Promise<EventRunClaim> {
  return putOnce({ taskId: `${EVENT_RUN_PREFIX}${input.runKey}`, channelArn: input.channelArn, workflow: input.workflow }, deps);
}

/** Claim one step of a run, recording its outcome. Only the first claim of a step succeeds, whatever its outcome. */
export function claimEventStep(
  input: { runKey: string; channelArn: string; step: string; outcome: string },
  deps: EventRunStoreDeps,
): Promise<EventRunClaim> {
  return putOnce({
    taskId: `${EVENT_RUN_PREFIX}${input.runKey}#step#${input.step}`,
    channelArn: input.channelArn,
    step: input.step,
    outcome: input.outcome,
  }, deps);
}

/** The most step claims one read names: a run's steps, its continuations and its end (`MAX_EVENT_RUN_STEPS` bounds a run). */
export const MAX_STEP_CLAIMS_READ = 64;

/**
 * WHICH OF A RUN'S STEP CLAIMS ARE HELD (the run's own transition log): each name a step, a continuation claim
 * (`after#<step>`) or the run's end (`end`), answered with the outcome its claim recorded. Null where any read fails, so
 * a caller never takes a step that could not be read for one not reached.
 */
export async function readEventSteps(
  input: { runKey: string; channelArn: string; steps: readonly string[] },
  deps: { send: (command: GetCommand) => Promise<{ Item?: Record<string, unknown> }>; table: string },
): Promise<Record<string, string> | null> {
  try {
    const names = [...new Set(input.steps)].slice(0, MAX_STEP_CLAIMS_READ);
    const out: Record<string, string> = {};
    await Promise.all(names.map(async (step) => {
      // READ CONSISTENTLY: a join counts a part's ending from the claim its hand-back has just written (`joinPartStates`).
      const got = await deps.send(new GetCommand({ TableName: deps.table, Key: { taskId: `${EVENT_RUN_PREFIX}${input.runKey}#step#${step}`, channelArn: input.channelArn }, ConsistentRead: true }));
      if (got?.Item?.eventRun === true) out[step] = typeof got.Item.outcome === 'string' ? got.Item.outcome : '';
    }));
    return out;
  } catch (err) {
    console.warn('[event-run] a run\'s step claims could not be read', { err: (err as Error)?.name });
    return null;
  }
}

/**
 * A RUN WAITING ON A TIME (ADR-067 decision 2, WT20): one record per wait, keyed by its id (`runWaitId`), holding the
 * run's continuation (the run key, the workflow, the step, the event's references and the run's values, never a message),
 * which the wait's one-shot schedule names by id when it fires. Written once, so a redelivered run schedules no second
 * wait; read once the schedule fires.
 */
export function holdRunWait(
  input: { waitId: string; channelArn: string; continuation: Record<string, unknown> },
  deps: EventRunStoreDeps,
): Promise<EventRunClaim> {
  return putOnce({ taskId: `${EVENT_RUN_PREFIX}wait#${input.waitId}`, channelArn: input.channelArn, continuation: input.continuation }, deps);
}

export async function readRunWait(
  input: { waitId: string; channelArn: string },
  deps: { send: (command: GetCommand) => Promise<{ Item?: Record<string, unknown> }>; table: string },
): Promise<Record<string, unknown> | null> {
  try {
    const out = await deps.send(new GetCommand({ TableName: deps.table, Key: { taskId: `${EVENT_RUN_PREFIX}wait#${input.waitId}`, channelArn: input.channelArn } }));
    const c = out?.Item?.eventRun === true ? out.Item.continuation : undefined;
    return c && typeof c === 'object' ? c as Record<string, unknown> : null;
  } catch (err) {
    console.warn('[event-run] a wait record could not be read', { err: (err as Error)?.name });
    return null;
  }
}

/**
 * A PERSON A RUN GREETED BY NAME (ADR-061 decision 5, "No greeting twice"): one record per conversation and person,
 * written when a send that mentions them posts, and read on their first turn so it does not greet them again.
 */
export async function recordEventGreeting(
  input: { channelArn: string; personArn: string },
  deps: EventRunStoreDeps,
): Promise<EventRunClaim> {
  return putOnce({ taskId: `${EVENT_RUN_PREFIX}greeted#${input.personArn}`, channelArn: input.channelArn }, deps);
}

export async function wasGreetedByEventRun(
  input: { channelArn: string; personArn: string },
  deps: { send: (command: GetCommand) => Promise<{ Item?: Record<string, unknown> }>; table: string },
): Promise<boolean> {
  try {
    const out = await deps.send(new GetCommand({
      TableName: deps.table,
      Key: { taskId: `${EVENT_RUN_PREFIX}greeted#${input.personArn}`, channelArn: input.channelArn },
    }));
    return out?.Item?.eventRun === true;
  } catch (err) {
    console.warn('[event-run] the greeting record could not be read', { err: (err as Error)?.name });
    return false;
  }
}
