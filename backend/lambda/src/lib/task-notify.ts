/**
 * Task hand-off / due-date notification helpers.
 *
 * Pure logic for turning assignable work-item tasks into channel notices that the notification
 * bridge (lib/channel-notify.ts, via the channel-flow processor) fans out to the assignee's email:
 *   - matchAssigneeInRoster — whether a task's assignee is still in the conversation's grounded roster.
 *   - selectTasksToRemind — which open, dated tasks are due-soon / overdue this run (cooldown-gated).
 *   - buildAssignmentNotice — the channel message and email subject, rendered from the `task-assigned` message
 *     template (ADR-062 decision 6).
 *
 * No AWS here — the scheduled lambda + processor wire these to Dynamo/Chime; this stays unit-testable.
 */
import type { Task, TaskStatus } from './task-tracking.js';
import { ACTIVE_TASK_STATUSES } from './task-tracking.js';
import type { ParsedTemplate } from './document-template.js';
import { renderMessageTemplate } from './message-template.js';
import { shippedMessageTemplate } from './shipped-message-templates.js';

/**
 * One member of the roster a turn is grounded on (`lib/host-grounding.ts`): the person id live
 * membership reports, with the host-supplied role when one was recorded.
 */
export interface RosterParticipant {
  sub: string;
  iss?: string;
  role?: string;
}

/**
 * The assignee's person id when they are still in the conversation's roster, else null (the roster
 * was shed for size, or the assignee left). A task's `assigneePersonId` is the assignee's AppInstanceUser
 * id, which is the id membership reports, so this is a membership test and nothing more: where to reach
 * them is the directory's question at send time.
 */
export function matchAssigneeInRoster(
  assigneePersonId: string | undefined,
  roster: RosterParticipant[],
): string | null {
  if (!assigneePersonId) return null;
  return roster.some((p) => p?.sub === assigneePersonId) ? assigneePersonId : null;
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

/**
 * What a task is called in its notice: the name its details carry, else the template's label for its kind
 * (`label.actionItem`, `label.workItem`, `label.item`), so the fallback is worded where the rest of the notice is.
 */
function taskLabel(task: Task, template: ParsedTemplate): string {
  const d = (task.details || {}) as Record<string, unknown>;
  const named = [d.title, d.name, d.what].find((v) => typeof v === 'string' && v) as string | undefined;
  if (named) return named;
  const labels = template.messageSections ?? {};
  if (task.taskType === 'action_item') return labels['label.actionItem'] ?? '';
  if (task.taskType === 'place_item') return labels['label.workItem'] ?? '';
  return labels['label.item'] ?? '';
}

/** A task notice rendered from its template: the chat line, and the email subject the bridge sends it under. */
function taskNotice(task: Task, template: ParsedTemplate, resolved: Record<string, string> = {}): TaskNotice {
  const rendered = renderMessageTemplate(template, { ...resolved, what: taskLabel(task, template), dueBy: formatDueBy(task.dueBy) }, {
    sections: ['chat', 'email.subject'], refusedValue: 'empty',
  });
  const s = rendered.ok ? rendered.sections : {};
  return { subject: s['email.subject'] ?? '', content: s.chat ?? '' };
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

/** The template each task notice is said from (ADR-062 decision 6). */
export const TASK_NOTICE_TEMPLATES = { assigned: 'task-assigned' } as const;

/**
 * The "you're set to handle this" message posted when an action item becomes the assignee's to act on, from
 * the `task-assigned` template: the one `template` selected, else the shipped one. Carries no PII; the bridge
 * resolves the assignee's address from the IDP.
 */
export function buildAssignmentNotice(
  task: Task,
  template: ParsedTemplate = shippedMessageTemplate(TASK_NOTICE_TEMPLATES.assigned),
  /** The text a field bound to a source or a version variable inserts, read by the caller's resolver. */
  resolved: Record<string, string> = {},
): TaskNotice {
  return taskNotice(task, template, resolved);
}

