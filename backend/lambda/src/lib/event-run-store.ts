/**
 * AN EVENT RUN'S RECORD, AND ITS EXACTLY-ONCE CLAIMS (ADR-061 decision 5).
 *
 * A run is a task record keyed `event-run#<event>#<natural key>#<assistant>` in the conversation, written once: a
 * redelivered event, a retried container or a second `WelcomeIntent` finds it and starts no second run. Each step
 * is claimed by a record of its own under the run, which carries the step's outcome, so one conditional write
 * decides between an agent step's output and its fallback and the step records are the run's transition log.
 *
 * MARKED AS AN EVENT RUN, NEVER AS WORK. The records carry `eventRun: true` and the status `event_run`, which no
 * open-work read selects, and they expire (`ttl`) a week after they are written.
 *
 * Reached only through the task service (`task-service.ts`), whose role holds the table; the router and the
 * processor ask it (`task-store.ts`).
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

export const EVENT_RUN_PREFIX = 'event-run#';
export const EVENT_RUN_STATUS = 'event_run';
export const EVENT_RUN_TTL_SECONDS = 7 * 24 * 3600;

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
