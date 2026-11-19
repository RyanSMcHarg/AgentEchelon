/** The console's event triggers (`event-triggers-api.ts`): the event types a workflow can start on, and those attached to a team's room. */
import { adminUrl } from './adminApi';
import { adminRequest } from './sigv4Fetch';

/** A trigger as listed: a team room's, or a watched conversation's with the key's kind and the event's key path (DESIGN-EVENT-TARGETS). */
/** One attached trigger; `assistant` is the assistant it was attached for, whose version runs its workflow, where one was named. */
export interface EventTrigger { id: string; workflow: string; ruleArn: string | null; pattern: string | null; kind?: string; keyPath?: string | null; assistant?: string | null }
export type EventTriggerChoice = { eventType: string; resourceArn?: string } | { resourceArn: string } | { rule: string };

const enc = encodeURIComponent;

export async function listEventTypes(q: string): Promise<Array<{ name: string; registry: string }>> {
  const out = await adminRequest<{ eventTypes: Array<{ name: string; registry: string }> }>('GET', adminUrl('admin-conversations', '/admin/event-types'), { query: { q } });
  return out.eventTypes;
}

/** What one event type carries, read from its schema: its source, detail type and the paths to its detail fields. */
export interface DescribedEventType { name: string; source: string; detailType: string; detailPaths: string[] }

export async function describeEventType(name: string): Promise<DescribedEventType> {
  return (await adminRequest<{ eventType: DescribedEventType }>('GET', adminUrl('admin-conversations', '/admin/event-types'), { query: { describe: name } })).eventType;
}

export function listEventTriggers(typeKey: string, classification: string): Promise<{ channelArn: string | null; target?: 'watched'; triggers: EventTrigger[] }> {
  return adminRequest('GET', adminUrl('admin-conversations', `/admin/event-triggers/${enc(typeKey)}/${enc(classification)}`));
}

/**
 * Attach a trigger for the workflow on one assistant's version: the rule records that assistant, so its version runs the
 * workflow and the run speaks as it.
 */
export function attachEventTrigger(typeKey: string, classification: string, workflow: string, choice: EventTriggerChoice, watched?: { kind: string; keyPath: string }, assistant?: string): Promise<{ id: string; ruleArn: string }> {
  return adminRequest('POST', adminUrl('admin-conversations', `/admin/event-triggers/${enc(typeKey)}/${enc(classification)}`), { body: { workflow, ...choice, ...(watched ? { target: 'watched', ...watched } : {}), ...(assistant ? { assistant } : {}) } });
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
