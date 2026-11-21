/** The console's event triggers (`event-triggers-api.ts`): the event types a workflow can start on, and those attached to a team's room. */
import { adminUrl } from './adminApi';
import { adminRequest } from './sigv4Fetch';
import { teamAssistant } from './teamScope';

/** A trigger as listed: a team room's, or a watched conversation's with the key's kind and the event's key path (DESIGN-EVENT-TARGETS). */
/** One attached trigger; `assistant` is the assistant it was attached for, whose version runs its workflow, where one was named. */
export interface EventTrigger { id: string; workflow: string; ruleArn: string | null; pattern: string | null; kind?: string; keyPath?: string | null; assistant?: string | null }
export type EventTriggerChoice = { eventType: string; resourceArn?: string } | { resourceArn: string } | { rule: string } | { platformEvent: { source: string; detailType: string } }
  | { handoff: { classification: string; process: string; name: string } };

const enc = encodeURIComponent;

export async function listEventTypes(q: string): Promise<Array<{ name: string; registry: string }>> {
  const out = await adminRequest<{ eventTypes: Array<{ name: string; registry: string }> }>('GET', adminUrl('admin-conversations', '/admin/event-types'), { query: { q } });
  return out.eventTypes;
}

/** A hand-off an active version declares (DESIGN-PROCESSES section 12): who sends it, its process and name, and its typed fields. */
export interface DeclaredHandoff { assistant: string; classification: string; process: string; name: string; fields: Record<string, { type: string; values?: string[]; store?: string }> }

/** Every hand-off the deployment's active versions declare: the trigger form's Hand-off source. */
export async function listDeclaredHandoffs(): Promise<DeclaredHandoff[]> {
  return (await adminRequest<{ handoffs: DeclaredHandoff[] }>('GET', adminUrl('admin-conversations', '/admin/event-types'), { query: { handoffs: '1' } })).handoffs;
}

/** A rule already in the account, offered to copy; `attached` marks this deployment's own trigger and watch rules. */
export interface AccountRule { name: string; arn: string; pattern: string | null; state: string; description?: string; attached: boolean }
/** An alarm in the account, with its state now. */
export interface AccountAlarm { name: string; arn: string; state: string; kind: 'metric' | 'composite'; namespace?: string; metric?: string }

/** The account's rules on the default bus, by name prefix (an admin's, `manage-event-triggers`). */
export async function listAccountRules(q: string): Promise<AccountRule[]> {
  return (await adminRequest<{ rules: AccountRule[] }>('GET', adminUrl('admin-conversations', '/admin/event-rules'), { query: { q } })).rules;
}

/** The account's alarms with their state, by name prefix (an admin's, `manage-event-triggers`). */
export async function listAccountAlarms(q: string): Promise<AccountAlarm[]> {
  return (await adminRequest<{ alarms: AccountAlarm[] }>('GET', adminUrl('admin-conversations', '/admin/event-alarms'), { query: { q } })).alarms;
}

/** What one event type carries, read from its schema: its source, detail type and the paths to its detail fields. */
export interface DescribedEventType { name: string; source: string; detailType: string; detailPaths: string[] }

export async function describeEventType(name: string): Promise<DescribedEventType> {
  return (await adminRequest<{ eventType: DescribedEventType }>('GET', adminUrl('admin-conversations', '/admin/event-types'), { query: { describe: name } })).eventType;
}

/** The triggers of a conversation type at a classification; a team member's are those attached for their own assistant. */
export function listEventTriggers(typeKey: string, classification: string): Promise<{ channelArn: string | null; target?: 'watched'; triggers: EventTrigger[] }> {
  const team = teamAssistant();
  return adminRequest('GET', team
    ? adminUrl('admin-conversations', `/admin/assistants/${enc(team)}/event-triggers/${enc(typeKey)}/${enc(classification)}`)
    : adminUrl('admin-conversations', `/admin/event-triggers/${enc(typeKey)}/${enc(classification)}`));
}

/**
 * Attach a trigger for the workflow on one assistant's version: the rule records that assistant, so its version runs the
 * workflow and the run speaks as it.
 */
export function attachEventTrigger(typeKey: string, classification: string, workflow: string, choice: EventTriggerChoice, watched?: { kind: string; keyPath: string; target?: 'watched' | 'named' }, assistant?: string, replaces?: string): Promise<{ id: string; ruleArn: string }> {
  const where = watched ? { target: watched.target ?? 'watched', kind: watched.kind, keyPath: watched.keyPath } : {};
  return adminRequest('POST', adminUrl('admin-conversations', `/admin/event-triggers/${enc(typeKey)}/${enc(classification)}`), { body: { workflow, ...choice, ...where, ...(assistant ? { assistant } : {}), ...(replaces ? { replaces } : {}) } });
}

/**
 * Remove a trigger, naming the assistant whose editor removes it: the route refuses a rule attached for another assistant,
 * whose version runs it.
 */
export function removeEventTrigger(typeKey: string, classification: string, id: string, assistant?: string): Promise<{ removed: string }> {
  return adminRequest('POST', adminUrl('admin-conversations', `/admin/event-triggers/${enc(typeKey)}/${enc(classification)}/${enc(id)}/remove`), { body: assistant ? { assistant } : {} });
}

/** The deployment's event policy (WT122): what an AWS event may do at all. */
export async function readEventPolicy(): Promise<unknown> {
  return (await adminRequest<{ policy: unknown }>('GET', adminUrl('admin-conversations', '/admin/event-policy'))).policy;
}

/** Replace the policy whole; the server refuses one over the most it allows, naming each reason. */
export async function saveEventPolicy(policy: unknown): Promise<unknown> {
  return (await adminRequest<{ policy: unknown }>('POST', adminUrl('admin-conversations', '/admin/event-policy'), { body: policy })).policy;
}

/** A notice the platform raises (DESIGN-EVENT-TARGETS section 12): a security one is always on; an operational one is on, off, or unknown where its state cannot be read. */
export interface AdminNotice { key: string; messageType: string; security: boolean; enabled: boolean | null }

/** Every admin notice and whether it posts into the admin notifications conversation. */
export async function listAdminNotices(): Promise<AdminNotice[]> {
  return (await adminRequest<{ notices: AdminNotice[] }>('GET', adminUrl('admin-conversations', '/admin/admin-notices'))).notices;
}

/** Switch an operational notice; the server refuses a security notice. */
export async function switchAdminNotice(key: string, enabled: boolean): Promise<AdminNotice> {
  return (await adminRequest<{ notice: AdminNotice }>('POST', adminUrl('admin-conversations', `/admin/admin-notices/${enc(key)}`), { body: { enabled } })).notice;
}
