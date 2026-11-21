/**
 * WHAT THE INCIDENT SPECS SHARE (SPEC-WORKFLOWS-AND-TASKS WT120, WT121, WT129): reading what a conversation's people see, a
 * workflow run's tasks from the task table, the incident conversations an alarm opened for the on-call, and the cleanup that
 * settles what a spec opened through the product's own cancel and takes a deleted incident conversation off its team
 * conversation's record.
 */
import { awsv, awsvText } from './aws';
import { messageRowsVisibleTo } from './third-party-view';
import { channelTasks, pollFor, resolveChannelContextTable, resolveTaskTable } from './task-backend';
import { pressCard } from './workflow-task';
import { signedCall, type VendedCredentials, exchange } from './admin-api';
import { adminUrl } from './api-urls';
import { shippedMessageTemplate } from '../../../backend/lambda/src/lib/shipped-message-templates';
import { untilRoomChanges } from './watchdog/wire-wait';

/** An SSM parameter's value, or '' where it is not set or cannot be read. */
export const ssmValue = (name: string): string => {
  try { const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim(); return v === 'None' ? '' : v; } catch { return ''; }
};

const visible = (content: string) => content.replace(/<!--[\s\S]*?-->/g, '').trim();

/** A message's Metadata, parsed, or an empty object where it carries none or none that parses. */
const metaOf = (raw: string): Record<string, any> => {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/**
 * What an assistant posted in a conversation, as one person sees it, oldest first, each with its parsed Metadata (`meta`),
 * where an event workflow records the step that posted it (`meta.eventStep.workflow`, the workflow or the asked intent).
 */
export const posts = (room: string, asArn: string) => messageRowsVisibleTo(room, asArn)
  .filter((m) => m.senderArn.includes('/bot/'))
  .map((m) => ({ ...m, text: visible(m.content), meta: metaOf(m.metadata) }))
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/** One post as `posts` reads it. */
export type Post = ReturnType<typeof posts>[number];

/** The workflow, or the asked intent, whose step posted a message, or '' for one no run posted. */
export const postedBy = (m: Post): string => String(m.meta?.eventStep?.workflow || '');

/**
 * WHAT AN ASSISTANT POSTED, ONCE `done` ACCEPTS IT: read now, then again on each of the room's message events
 * (`untilRoomChanges`), so a wait on a room's messages follows its events rather than a timer. Returns the last read when
 * `timeoutMs` passes, so an assertion on it reports what was seen.
 */
export const postsUntil = (room: string, asArn: string, done: (p: Post[]) => boolean, opts: { timeoutMs?: number } = {}): Promise<Post[]> =>
  untilRoomChanges(room, asArn, () => posts(room, asArn), done, opts);

/**
 * WHETHER A POST READS AS ONE SHIPPED TEMPLATE'S CHAT TEXT, its values filled: the template's own words, read from the
 * catalog, so a spec holds no copy of them.
 */
export const saysTemplate = (name: string) => {
  const chat = shippedMessageTemplate(name).messageSections?.chat ?? '';
  const parts = chat.trim().split(/\{\{?\s*[a-z_]+\s*\}?\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(parts.join('[\\s\\S]+?'));
  return (text: string) => pattern.test(text);
};

/** Take one child off a room's server-only record, by its id, at the index it holds when read. */
export function forgetChild(room: string, childId: string): void {
  const table = resolveChannelContextTable();
  if (!table || !childId) return;
  const key = JSON.stringify({ channelArn: { S: room } });
  const row = awsv(['dynamodb', 'get-item', '--table-name', table, '--key', key, '--projection-expression', 'children', '--consistent-read']);
  const at = ((row?.Item?.children?.L ?? []) as Array<{ M?: { channelId?: { S?: string } } }>).findIndex((c) => c.M?.channelId?.S === childId);
  if (at < 0) return;
  awsv(['dynamodb', 'update-item', '--table-name', table, '--key', key, '--update-expression', `REMOVE children[${at}]`,
    '--condition-expression', `children[${at}].channelId = :id`, '--expression-attribute-values', JSON.stringify({ ':id': { S: childId } })]);
}

/**
 * The conversations of one type a conversation opened, read from the children its own row records (the creator writes the
 * list as each child opens), as ARNs on the same app instance.
 */
export function childrenOfType(room: string, typeKey: string): string[] {
  const table = resolveChannelContextTable();
  if (!table || !room) return [];
  const row = awsv(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ channelArn: { S: room } }), '--projection-expression', 'children', '--consistent-read']);
  const base = room.slice(0, room.indexOf('/channel/') + '/channel/'.length);
  return ((row?.Item?.children?.L ?? []) as Array<{ M?: { channelId?: { S?: string }; typeKey?: { S?: string } } }>)
    .filter((c) => c.M?.typeKey?.S === typeKey && c.M?.channelId?.S)
    .map((c) => `${base}${c.M!.channelId!.S}`);
}

/** Press a task's card as its worker, with the choice its button carries, from the state the task rests in. */
export function press(token: string, task: RunTask, choice: string, state?: string): Promise<{ status: number; body: any }> {
  return pressCard(token, { channelArn: task.channelArn, taskId: task.taskId, state: state ?? task.taskState, choice });
}

/** Remove every task row a conversation holds, from the task table, by its own key. */
export function removeTasksHeldBy(channelArn: string): void {
  const table = resolveTaskTable('agent-tasks');
  if (!table || !channelArn) return;
  const rows = (awsv(['dynamodb', 'scan', '--table-name', table, '--filter-expression', 'channelArn = :c', '--projection-expression', 'taskId, channelArn',
    '--expression-attribute-values', JSON.stringify({ ':c': { S: channelArn } })])?.Items ?? []) as Array<{ taskId?: { S?: string } }>;
  for (const r of rows) {
    if (r.taskId?.S) awsv(['dynamodb', 'delete-item', '--table-name', table, '--key', JSON.stringify({ taskId: { S: r.taskId.S }, channelArn: { S: channelArn } })]);
  }
}

/**
 * A name as letters and digits alone, lower case. The conversation an event opens is named for reading
 * ("AgentEchelon E2e Incident Abc123" for the alarm `AgentEchelon-e2e-incident-abc123`), so the two are compared this way.
 */
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The incident conversations the on-call is a member of: `ops` conversations named for one alarm. */
export function opsRoomsOf(leadArn: string, alarm: string): string[] {
  const out: string[] = [];
  let next = '';
  for (let page = 0; page < 20; page += 1) {
    const r = awsv(['chime-sdk-messaging', 'list-channel-memberships-for-app-instance-user', '--app-instance-user-arn', leadArn, '--chime-bearer', leadArn, '--max-results', '50', ...(next ? ['--next-token', next] : [])]);
    for (const m of (r?.ChannelMemberships ?? []) as Array<{ ChannelSummary?: { ChannelArn?: string; Name?: string } }>) {
      if (m.ChannelSummary?.ChannelArn?.includes('/channel/') && m.ChannelSummary.ChannelArn.includes('-ops-') && nameKey(m.ChannelSummary.Name ?? '').includes(nameKey(alarm))) out.push(m.ChannelSummary.ChannelArn);
    }
    next = String(r?.NextToken || '');
    if (!next) break;
  }
  return out;
}

/** One task a workflow run opened, as its row records it. */
export interface RunTask {
  taskId: string; channelArn: string; status: string; taskState: string; taskType: string; error: string;
  /** The run's step that opened it, its run, and the resource the run's event named. */
  step: string; runKey: string; resource: string;
  /** The run's process id, where the run carries one (SPEC-PROCESSES P2). */
  processId: string;
  createdAt: string; updatedAt: string;
}

/** The tasks workflow runs opened in a conversation (`evt-`), read from the task table. */
export function runTasksIn(channelArn: string): RunTask[] {
  const table = resolveTaskTable('agent-tasks');
  if (!table || !channelArn) return [];
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return channelTasks(table, channelArn).filter((r) => s(r.taskId).startsWith('evt-')).map((r) => ({
    taskId: s(r.taskId), channelArn: s(r.channelArn), status: s(r.status), taskState: s(r.taskState), taskType: s(r.taskType), error: s(r.error),
    step: s(r.workflowRun?.step), runKey: s(r.workflowRun?.runKey), resource: s(r.workflowRun?.values?.resource), processId: s(r.workflowRun?.process?.id),
    createdAt: s(r.createdAt), updatedAt: s(r.updatedAt),
  }));
}

/** Whether a task is still open work. */
export const isLive = (t: RunTask): boolean => ['pending', 'in_progress'].includes(t.status);

/** The one live task a run's step opened in a conversation, waited for; undefined where none opened in time. */
export async function liveTaskAt(channelArn: string, step: string, opts: { resource?: string; timeoutMs?: number } = {}): Promise<RunTask | undefined> {
  const pick = (rows: RunTask[]) => rows.find((t) => t.step === step && isLive(t) && (!opts.resource || t.resource === opts.resource));
  return pick(await pollFor(() => runTasksIn(channelArn), (rows) => !!pick(rows), { timeoutMs: opts.timeoutMs ?? 120_000, intervalMs: 5_000 }));
}

/** Press an acknowledgement card (`acknowledgement`'s one choice) as its worker, as the card's button does. */
export function acknowledge(token: string, task: RunTask): Promise<{ status: number; body: any }> {
  return pressCard(token, { channelArn: task.channelArn, taskId: task.taskId, state: task.taskState || 'asked', choice: 'acknowledged' });
}

/**
 * SETTLE WHAT A SPEC OPENED, THROUGH THE PRODUCT'S OWN CANCEL (ADR-067 WT27): each run with live work in the conversation is
 * cancelled as an operator cancels it, by one of its tasks (`POST /admin/tasks/channel/{id}/cancel`, `run: true`), so each task
 * settles on its own edge and the run goes on to its end. `keep` narrows it to the tasks the spec's own runs opened. Returns
 * the runs it asked to cancel; waits, up to `timeoutMs`, for no live task to remain. A run that was never cancelled leaves its
 * tasks pending and its process never ending, which a later run of the process view would read.
 */
export async function cancelOpenRuns(adminIdToken: string, channelArn: string, opts: { keep?: (t: RunTask) => boolean; timeoutMs?: number } = {}): Promise<number> {
  const keep = opts.keep ?? (() => true);
  const live = () => runTasksIn(channelArn).filter((t) => isLive(t) && keep(t));
  const byRun = new Map<string, RunTask>();
  for (const t of live()) if (t.runKey && !byRun.has(t.runKey)) byRun.set(t.runKey, t);
  const channelId = channelArn.split('/channel/')[1] ?? '';
  // STOPPING A TASK IS VENDED FOR ONE CONVERSATION (tasks-manage), as an operator gets it: a console session alone is refused.
  const vend = byRun.size ? await exchange(adminIdToken, { identity: 'admin', capabilities: ['tasks-manage'], channelArn, reason: 'end-to-end cleanup of the runs this spec opened' }) : undefined;
  if (vend && vend.status !== 200) { console.warn(`cleanup: no task grant for ${channelId} (${vend.status})`); return 0; }
  const admin = vend?.body.credentials as VendedCredentials;
  for (const t of byRun.values()) {
    const res = await signedCall(adminUrl('admin-conversations', `/admin/tasks/channel/${channelId}/cancel`), admin, 'POST', { taskId: t.taskId, run: true });
    if (res.status !== 200 && res.status !== 404) console.warn(`cleanup: the run of ${t.taskId} was not cancelled (${res.status})`);
  }
  if (byRun.size) await pollFor(() => live(), (rows) => rows.length === 0, { timeoutMs: opts.timeoutMs ?? 60_000, intervalMs: 5_000 }).catch(() => undefined);
  return byRun.size;
}
