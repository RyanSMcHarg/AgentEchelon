/**
 * WHAT THIS DEPLOYMENT LETS AN AWS EVENT DO (SPEC-WORKFLOWS-AND-TASKS WT122): which event types a team room may attach, how many
 * triggers there may be, and how many incidents a room may hold open at once. One SSM parameter, edited in the console by the
 * deployment's admins (`manage-event-policy`), its history the parameter's own. Absent, the dev values below apply, so a
 * deployment that never set one runs at the strictest values.
 *
 * Read on every attach and on every event, so a lowered value or a switched-off policy holds from the next event, with no deploy.
 * The most any edit may set is bounded; the limits the platform holds whatever the policy says (no child opens a child, an
 * alarm matches entering ALARM only, one run per rule per window) are not here, because no deployment may change them.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface EventPolicy {
  /** Off: no event starts any workflow, and nothing can be attached. The kill switch. */
  enabled: boolean;
  /** The event types a trigger may match, each its exact `source` and `detail-type`. Empty allows none. */
  allowedEventTypes: Array<{ source: string; detailType: string }>;
  /** The most triggers one team room may hold. */
  maxTriggersPerRoom: number;
  /** The most trigger rules the deployment may hold, under the account's rules-per-bus quota. */
  maxTriggers: number;
  /** The most watch triggers one conversation type may hold (DESIGN-EVENT-TARGETS section 4). Absent from a policy saved before it existed: the dev value. */
  maxWatchTriggersPerType?: number;
  /** The most incidents one team room may hold open at once: a new room opens only once one is resolved. */
  maxOpenIncidentsPerRoom: number;
  /**
   * The most conversations a pattern type creates in a day (DESIGN-EVENT-TARGETS 11.2), counted as they are created, so an event
   * stream cannot open conversations without limit. Absent in a policy written before it: the default holds.
   */
  maxPatternConversationsPerDay?: number;
  /** How often a rule retries delivering one event, and for how long. */
  retryAttempts: number;
  maxEventAgeSeconds: number;
}

/** The dev values, and the values of a deployment that never set its own. Raised for production in the console. */
export const DEV_EVENT_POLICY: EventPolicy = Object.freeze({
  enabled: true,
  allowedEventTypes: [
    { source: 'aws.cloudwatch', detailType: 'CloudWatch Alarm State Change' },
    { source: 'ae.ops', detailType: 'Incident opened' },
    { source: 'ae.ops', detailType: 'Incident updated' },
  ],
  maxTriggersPerRoom: 5,
  maxWatchTriggersPerType: 5,
  maxTriggers: 20,
  maxOpenIncidentsPerRoom: 3,
  maxPatternConversationsPerDay: 25,
  retryAttempts: 2,
  maxEventAgeSeconds: 900,
}) as EventPolicy;

/** What no edit may exceed: the account's 300 rules per bus, and EventBridge's own retry bounds. */
export const EVENT_POLICY_MOST = Object.freeze({
  allowedEventTypes: 50, maxTriggersPerRoom: 100, maxWatchTriggersPerType: 100, maxTriggers: 250, maxOpenIncidentsPerRoom: 50, retryAttempts: 185, maxEventAgeSeconds: 86_400,
  maxPatternConversationsPerDay: 1000,
});

const whole = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Why a policy is refused, as sentences. Empty when it may be saved. */
export function eventPolicyErrors(raw: unknown): string[] {
  if (!isObj(raw)) return ['the policy is an object'];
  const errs: string[] = [];
  const c = EVENT_POLICY_MOST;
  if (typeof raw.enabled !== 'boolean') errs.push('enabled is true or false');
  const types = raw.allowedEventTypes;
  if (!Array.isArray(types) || types.length > c.allowedEventTypes) errs.push(`allowedEventTypes lists at most ${c.allowedEventTypes} event types`);
  else if (types.some((t) => !isObj(t) || typeof t.source !== 'string' || !t.source || typeof t.detailType !== 'string' || !t.detailType)) errs.push('each allowed event type names its source and detailType');
  if (!whole(raw.maxTriggersPerRoom, 0, c.maxTriggersPerRoom)) errs.push(`maxTriggersPerRoom is a whole number from 0 to ${c.maxTriggersPerRoom}`);
  if (raw.maxWatchTriggersPerType !== undefined && !whole(raw.maxWatchTriggersPerType, 0, c.maxWatchTriggersPerType)) errs.push(`maxWatchTriggersPerType is a whole number from 0 to ${c.maxWatchTriggersPerType}`);
  if (!whole(raw.maxTriggers, 0, c.maxTriggers)) errs.push(`maxTriggers is a whole number from 0 to ${c.maxTriggers}`);
  if (!whole(raw.maxOpenIncidentsPerRoom, 1, c.maxOpenIncidentsPerRoom)) errs.push(`maxOpenIncidentsPerRoom is a whole number from 1 to ${c.maxOpenIncidentsPerRoom}`);
  if (raw.maxPatternConversationsPerDay !== undefined && !whole(raw.maxPatternConversationsPerDay, 1, c.maxPatternConversationsPerDay)) errs.push(`maxPatternConversationsPerDay is a whole number from 1 to ${c.maxPatternConversationsPerDay}`);
  if (!whole(raw.retryAttempts, 0, c.retryAttempts)) errs.push(`retryAttempts is a whole number from 0 to ${c.retryAttempts}`);
  if (!whole(raw.maxEventAgeSeconds, 60, c.maxEventAgeSeconds)) errs.push(`maxEventAgeSeconds is a whole number from 60 to ${c.maxEventAgeSeconds}`);
  const known = new Set(Object.keys(DEV_EVENT_POLICY));
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length) errs.push(`the policy does not declare ${unknown.join(', ')}`);
  return errs;
}

/**
 * The policy a stored value means: the value itself when it is valid, the dev values otherwise, and off whenever it says off.
 * Never more permissive: a switched-off policy with any other field wrong is still switched off.
 */
export function eventPolicyOf(raw: unknown): EventPolicy {
  if (!eventPolicyErrors(raw).length) return { maxWatchTriggersPerType: DEV_EVENT_POLICY.maxWatchTriggersPerType, ...(raw as EventPolicy) };
  return isObj(raw) && raw.enabled === false ? { ...DEV_EVENT_POLICY, enabled: false } : DEV_EVENT_POLICY;
}

/** Whether every source and detail type a pattern names is one the policy allows. */
export function eventTypeAllowed(policy: EventPolicy, source: string, detailType: string): boolean {
  return policy.allowedEventTypes.some((t) => t.source === source && t.detailType === detailType);
}

export function patternAllowed(policy: EventPolicy, pattern: { source?: unknown; 'detail-type'?: unknown }): boolean {
  const sources = Array.isArray(pattern.source) ? pattern.source as string[] : [];
  const types = Array.isArray(pattern['detail-type']) ? pattern['detail-type'] as string[] : [];
  return sources.length > 0 && types.length > 0 && sources.every((s) => types.every((d) => eventTypeAllowed(policy, s, d)));
}

let ssm: SSMClient | null = null;
let cached: { at: number; policy: EventPolicy } | null = null;
/** How long one read serves: short, so a switched-off policy holds within this many seconds. */
export const EVENT_POLICY_CACHE_MS = 30_000;

/**
 * The deployment's policy, read from its parameter (`EVENT_POLICY_PARAM`). Absent: the dev values. Unreadable: the policy is
 * treated as off, so a read that fails never lets an event through that a working read would have refused.
 */
export async function readEventPolicy(now = Date.now()): Promise<EventPolicy> {
  if (cached && now - cached.at < EVENT_POLICY_CACHE_MS) return cached.policy;
  // NAMED BY THE FUNCTION'S ENVIRONMENT, or derived from the deployment's root where the function carries only that (the router,
  // whose environment is held under Lambda's limit).
  const name = process.env.EVENT_POLICY_PARAM || (process.env.SSM_ROOT ? `${process.env.SSM_ROOT}/event-triggers/policy` : undefined);
  let policy: EventPolicy;
  try {
    if (!name) throw Object.assign(new Error('no policy parameter is named'), { name: 'Unconfigured' });
    ssm = ssm ?? new SSMClient({});
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    policy = eventPolicyOf(JSON.parse(res.Parameter?.Value ?? 'null'));
  } catch (err) {
    policy = (err as { name?: string }).name === 'ParameterNotFound' ? DEV_EVENT_POLICY : { ...DEV_EVENT_POLICY, enabled: false };
  }
  cached = { at: now, policy };
  return policy;
}

/** For tests: forget the cached read. */
export function forgetEventPolicy(): void { cached = null; }
