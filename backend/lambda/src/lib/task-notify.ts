/**
 * Task hand-off / due-date notification helpers.
 *
 * Pure logic for turning assignable work-item tasks into channel notices that the notification
 * bridge (lib/channel-notify.ts, via the channel-flow processor) fans out to the assignee's email:
 *   - matchAssigneeInRoster — recover the resolvable {sub, iss} for a task's assignee from the
 *     channel roster (the task only stores the one-way `fed_` Chime id; see Task.assigneeUserSub).
 *   - selectTasksToRemind — which open, dated tasks are due-soon / overdue this run (cooldown-gated).
 *   - buildAssignmentNotice / buildReminderNotice — the channel message + email subject, carrying the
 *     metadata.notify directive that targets the assignee.
 *
 * No AWS here — the scheduled lambda + processor wire these to Dynamo/Chime; this stays unit-testable.
 */
import { deriveFederatedSub } from './federated-identity.js';
import type { NotifyTarget, RosterParticipant } from './channel-notify.js';
import type { Task, TaskStatus } from './task-tracking.js';
import { ACTIVE_TASK_STATUSES } from './task-tracking.js';

/**
 * Recover the assignee's resolvable {sub, iss} from the channel roster. A task's `assigneeUserSub` is
 * the assignee's Chime/AppInstanceUser id — for a FEDERATED member that's `deriveFederatedSub(iss, sub)`
 * (a one-way hash), for a NATIVE member it's the raw sub. We can't invert the hash, so we match by
 * recomputing it for each roster member (carrying raw {sub, iss}). Returns null when no member matches
 * (e.g. the roster was shed for size, or the assignee left the conversation).
 */
export function matchAssigneeInRoster(
  assigneeUserSub: string | undefined,
  roster: RosterParticipant[],
): NotifyTarget | null {
  if (!assigneeUserSub) return null;
  for (const p of roster) {
    if (!p?.sub) continue;
    if (p.iss) {
      // Federated member: channel id = deriveFederatedSub(iss, sub).
      if (deriveFederatedSub(p.iss, p.sub) === assigneeUserSub) return { sub: p.sub, iss: p.iss };
    } else if (p.sub === assigneeUserSub) {
      // Native member: channel id IS the raw sub.
      return { sub: p.sub };
    }
  }
  return null;
}

export type DueKind = 'due_soon' | 'overdue';

export interface RemindSelection {
  task: Task;
  kind: DueKind;
}

/**
 * Pure: of the given task rows, the ones to remind on this run — ACTIVE, with a `dueBy`, either
 * already overdue or due within `soonWindowMs`, and not reminded within `cooldownMs` (so a daily
 * schedule doesn't re-nag every fire). `nowMs`/windows are injected so the clock stays mockable.
 */
export function selectTasksToRemind(
  tasks: Task[],
  nowMs: number,
  opts: { soonWindowMs: number; cooldownMs: number },
): RemindSelection[] {
  const active = new Set<TaskStatus>(ACTIVE_TASK_STATUSES);
  const out: RemindSelection[] = [];
  for (const t of tasks) {
    if (!active.has(t.status)) continue;
    if (!t.dueBy) continue;
    const due = Date.parse(t.dueBy);
    if (Number.isNaN(due)) continue;
    const isOverdue = due < nowMs;
    const isDueSoon = due >= nowMs && due - nowMs <= opts.soonWindowMs;
    if (!isOverdue && !isDueSoon) continue;
    if (t.lastRemindedAt) {
      const last = Date.parse(t.lastRemindedAt);
      if (!Number.isNaN(last) && nowMs - last < opts.cooldownMs) continue;
    }
    out.push({ task: t, kind: isOverdue ? 'overdue' : 'due_soon' });
  }
  return out;
}

/** Short human label for what a task is, from its collected details / type (best-effort). */
function taskLabel(task: Task): string {
  const d = (task.details || {}) as Record<string, unknown>;
  const named = [d.title, d.name, d.what].find((v) => typeof v === 'string' && v) as string | undefined;
  if (named) return named;
  if (task.taskType === 'action_item') return 'an action item';
  if (task.taskType === 'place_item') return 'a work item';
  return 'an item';
}

/** Format a `dueBy` ISO value as a friendly date (UTC date only; time-of-day rarely matters here). */
export function formatDueBy(dueBy?: string): string {
  if (!dueBy) return '';
  const d = new Date(dueBy);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export interface TaskNotice {
  /** The channel message text (also the email body). */
  content: string;
  /** The email subject. */
  subject: string;
}

/**
 * The "you're set to handle this" message posted when an action item becomes the assignee's to
 * act on. Carries no PII — the bridge resolves the assignee's address from the IDP.
 */
export function buildAssignmentNotice(task: Task): TaskNotice {
  const what = taskLabel(task);
  const by = formatDueBy(task.dueBy);
  const byClause = by ? ` by ${by}` : '';
  return {
    subject: `You're set to handle ${what}`,
    content:
      `You're down to handle ${what}${byClause}. Open the conversation and I'll walk you through ` +
      `the steps — I'll keep the details with the work item.`,
  };
}

/** The due-soon / overdue reminder message. */
export function buildReminderNotice(task: Task, kind: DueKind): TaskNotice {
  const what = taskLabel(task);
  const by = formatDueBy(task.dueBy);
  if (kind === 'overdue') {
    return {
      subject: `Overdue: ${what}`,
      content:
        `Heads up — ${what} was due${by ? ` ${by}` : ''} and still isn't done. ` +
        `Want me to help finish it, or should we drop it from the list?`,
    };
  }
  return {
    subject: `Reminder: ${what}${by ? ` by ${by}` : ''}`,
    content:
      `Reminder: ${what} is coming up${by ? ` (due ${by})` : ''}. ` +
      `Reply here and I'll help you get it done.`,
  };
}
