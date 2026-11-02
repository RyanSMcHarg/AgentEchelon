/**
 * A DEADLINE IS A ONE-SHOT SCHEDULE THE ROUTER CREATES (ADR-061 decision 1, tenet D6).
 *
 * The absence of an event cannot be event-sourced, so an event that marks a deadline (`invitation-unredeemed`) comes
 * from one Amazon EventBridge Scheduler one-time schedule, created once, when the thing it times starts: the router
 * creates it while it handles `invitation-sent`, and only when the room primary's served version declares a workflow on
 * the deadline event. Nothing sweeps for candidates.
 *
 * WHAT A SCHEDULE HOLDS. Ids only: the deadline event, the conversation and the invitation. Never a name, an address
 * or text. Its name is derived from those ids (`deadlineScheduleName`), so the paths that end what it times early (revoking
 * an invitation, archiving its conversation) delete it by name, with no list call and no record of schedules of its own.
 *
 * WHERE IT LIVES. Each classification owns one schedule group and one scheduler role (`assistant-profile-stack.ts`):
 * the router's create and delete reach only its own group, the router may pass only its own scheduler role, and that
 * role may invoke only that classification's router. The schedule deletes itself once it has fired
 * (`ActionAfterCompletion: DELETE`).
 *
 * WHAT FIRING MEANS. Nothing, until the router checks it (`handleDeadlineFired`): the conversation is its own
 * classification's and is not archived, the invitation is still pending, and the people it names are still members.
 * A schedule that survives what it timed is harmless for that reason (tenet D5), and is the expected end where an invitation
 * is redeemed or its people offboarded, which delete no schedule by decision: it fires, starts nothing and deletes itself.
 */
import { createHash } from 'crypto';
import {
  ActionAfterCompletion, ConflictException, CreateScheduleCommand, DeleteScheduleCommand, FlexibleTimeWindowMode,
  ResourceNotFoundException, SchedulerClient,
} from '@aws-sdk/client-scheduler';
import {
  DEADLINE_EVENTS, DEADLINE_METRIC_NAMESPACE, DEADLINE_SCHEDULE_FAILED_METRIC, INVITATION_ID, isDeadlineEvent, type DeadlineEvent,
} from './event-workflow.js';

export { DEADLINE_EVENTS, DEADLINE_METRIC_NAMESPACE, DEADLINE_SCHEDULE_FAILED_METRIC, isDeadlineEvent, type DeadlineEvent };

type Sender = { send(command: unknown): Promise<any> };

/** How long before the timed thing's own expiry a deadline is brought forward to, so it never fires on an expired record. */
export const DEADLINE_EXPIRY_MARGIN_SECONDS = 300;

/** What a fired schedule hands the router: ids only. */
export interface DeadlineFiring {
  event: DeadlineEvent;
  channelArn: string;
  invitationId: string;
}

/** What asks the router to delete the deadline schedules of one invitation, or of every invitation of a conversation. */
export interface DeadlineCancel {
  channelArn: string;
  /** Absent: every invitation of the conversation, as its archive asks. */
  invitationId?: string;
}

const short = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 20);

/**
 * THE SCHEDULE'S NAME, derived from the ids it times, so the path that resolves the invitation deletes it by name.
 * Unique within a classification's group; at most 64 characters of `[0-9a-zA-Z-_.]`, as the scheduler requires.
 */
export function deadlineScheduleName(event: DeadlineEvent, channelArn: string, invitationId: string): string {
  const conversation = channelArn.split('/channel/')[1] ?? channelArn;
  return `${event === 'invitation-unredeemed' ? 'iu' : 'dl'}-${short(conversation)}-${short(invitationId)}`;
}

/**
 * WHEN THE DEADLINE FIRES (decision 1, "never after the invitation's expiry"): `afterMinutes` after now, brought forward
 * to the margin before the timed thing's own expiry. Undefined when that moment is not comfortably in the future,
 * so an invitation about to lapse gets no schedule.
 */
export function deadlineAt(nowMs: number, afterMinutes: number, expiresAtSeconds?: number): Date | undefined {
  let at = nowMs + afterMinutes * 60_000;
  if (typeof expiresAtSeconds === 'number') at = Math.min(at, (expiresAtSeconds - DEADLINE_EXPIRY_MARGIN_SECONDS) * 1000);
  if (!(at > nowMs + 60_000)) return undefined;
  return new Date(Math.ceil(at / 1000) * 1000);
}

/** The scheduler's one-time expression for a moment, in UTC: `at(yyyy-mm-ddThh:mm:ss)`. */
export function atExpression(at: Date): string {
  return `at(${at.toISOString().slice(0, 19)})`;
}

/** A firing as the router reads it, or null for anything else. */
export function deadlineFiringOf(raw: unknown): DeadlineFiring | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !isDeadlineEvent(r.event)) return null;
  if (typeof r.channelArn !== 'string' || !r.channelArn.includes('/channel/')) return null;
  if (typeof r.invitationId !== 'string' || !INVITATION_ID.test(r.invitationId)) return null;
  return { event: r.event, channelArn: r.channelArn, invitationId: r.invitationId };
}

/** Where a classification's schedules live and who fires them, from the router's environment. */
export interface DeadlineWiring {
  group: string;
  roleArn: string;
  routerArn: string;
}

export function deadlineWiringFromEnv(routerArn: string | undefined): DeadlineWiring | null {
  const group = process.env.EVENT_DEADLINE_GROUP || '';
  const roleArn = process.env.EVENT_DEADLINE_ROLE_ARN || '';
  return group && roleArn && routerArn ? { group, roleArn, routerArn } : null;
}

let defaultClient: Sender | null = null;
const clientOf = (c?: Sender): Sender => c ?? (defaultClient ??= new SchedulerClient({}));

/**
 * CREATE ONE DEADLINE SCHEDULE, once. A schedule of that name already in the group is the same deadline (a redelivered
 * `invitation-sent`), so it is left as it is. Its input carries the firing's ids alone, and it deletes itself once fired.
 */
export async function createDeadlineSchedule(
  wiring: DeadlineWiring, firing: DeadlineFiring, at: Date, client?: Sender,
): Promise<'created' | 'exists'> {
  try {
    await clientOf(client).send(new CreateScheduleCommand({
      Name: deadlineScheduleName(firing.event, firing.channelArn, firing.invitationId),
      GroupName: wiring.group,
      ScheduleExpression: atExpression(at),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
      Target: {
        Arn: wiring.routerArn,
        RoleArn: wiring.roleArn,
        Input: JSON.stringify({ aeDeadline: firing }),
        RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
      },
    }));
    return 'created';
  } catch (err) {
    if (err instanceof ConflictException || (err as { name?: string })?.name === 'ConflictException') return 'exists';
    throw err;
  }
}

/** DELETE ONE DEADLINE SCHEDULE by name. One that is gone already (fired, or never created) is not an error. */
export async function deleteDeadlineSchedule(
  wiring: Pick<DeadlineWiring, 'group'>, event: DeadlineEvent, channelArn: string, invitationId: string, client?: Sender,
): Promise<'deleted' | 'absent'> {
  try {
    await clientOf(client).send(new DeleteScheduleCommand({
      Name: deadlineScheduleName(event, channelArn, invitationId),
      GroupName: wiring.group,
    }));
    return 'deleted';
  } catch (err) {
    if (err instanceof ResourceNotFoundException || (err as { name?: string })?.name === 'ResourceNotFoundException') return 'absent';
    throw err;
  }
}

/** A cancel as the router reads it, or null. */
export function deadlineCancelOf(raw: unknown): DeadlineCancel | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.channelArn !== 'string' || !r.channelArn.includes('/channel/')) return null;
  if (r.invitationId !== undefined && (typeof r.invitationId !== 'string' || !INVITATION_ID.test(r.invitationId))) return null;
  return { channelArn: r.channelArn, ...(typeof r.invitationId === 'string' ? { invitationId: r.invitationId } : {}) };
}

// ── A TASK STEP'S DEADLINE (ADR-063 decision 4) ───────────────────────────────────────────────────────────

/** What a task step's fired schedule hands the router: the conversation and the task, ids only. */
export interface TaskDeadlineFiring {
  kind: 'task';
  channelArn: string;
  taskId: string;
}

/** A task's id as a schedule carries it: the id a task step's `eventTaskId` derives. */
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The schedule's name for one task, derived from its ids, so settling the task or archiving its room deletes it by name. */
export function taskDeadlineScheduleName(channelArn: string, taskId: string): string {
  const conversation = channelArn.split('/channel/')[1] ?? channelArn;
  return `tk-${short(conversation)}-${short(taskId)}`;
}

/** A task firing as the router reads it, or null for anything else. */
export function taskDeadlineFiringOf(raw: unknown): TaskDeadlineFiring | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || r.kind !== 'task') return null;
  if (typeof r.channelArn !== 'string' || !r.channelArn.includes('/channel/')) return null;
  if (typeof r.taskId !== 'string' || !TASK_ID.test(r.taskId)) return null;
  return { kind: 'task', channelArn: r.channelArn, taskId: r.taskId };
}

/**
 * CREATE A TASK STEP'S DEADLINE SCHEDULE, once, on the classification's own group, passing its own scheduler role, as an
 * invitation's is: ids-only input, and it deletes itself once fired. A schedule of that name already there is the same
 * deadline (a redelivered event), left as it is.
 */
export async function createTaskDeadlineSchedule(wiring: DeadlineWiring, firing: TaskDeadlineFiring, at: Date, client?: Sender): Promise<'created' | 'exists'> {
  try {
    await clientOf(client).send(new CreateScheduleCommand({
      Name: taskDeadlineScheduleName(firing.channelArn, firing.taskId),
      GroupName: wiring.group,
      ScheduleExpression: atExpression(at),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
      ActionAfterCompletion: ActionAfterCompletion.DELETE,
      Target: {
        Arn: wiring.routerArn,
        RoleArn: wiring.roleArn,
        Input: JSON.stringify({ aeDeadline: firing }),
        RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
      },
    }));
    return 'created';
  } catch (err) {
    if (err instanceof ConflictException || (err as { name?: string })?.name === 'ConflictException') return 'exists';
    throw err;
  }
}

/** DELETE A TASK STEP'S DEADLINE SCHEDULE by name. One already gone (fired, or never made) is not an error. */
export async function deleteTaskDeadlineSchedule(wiring: Pick<DeadlineWiring, 'group'>, channelArn: string, taskId: string, client?: Sender): Promise<'deleted' | 'absent'> {
  try {
    await clientOf(client).send(new DeleteScheduleCommand({ Name: taskDeadlineScheduleName(channelArn, taskId), GroupName: wiring.group }));
    return 'deleted';
  } catch (err) {
    if (err instanceof ResourceNotFoundException || (err as { name?: string })?.name === 'ResourceNotFoundException') return 'absent';
    throw err;
  }
}
