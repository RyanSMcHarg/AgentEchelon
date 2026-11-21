/**
 * THE CONSOLE'S EVENT TRIGGERS (SPEC-WORKFLOWS-AND-TASKS WT121): list the event types a workflow can start on, and attach or detach
 * one for a team's room. The version names a workflow; this admin action makes the AWS resources, so a version edit creates nothing.
 *
 * What this function may do is bounded by IAM, not by what it is asked: it writes only rules under this deployment's trigger
 * prefix, targets only a relay to a router, reads other rules, and tags a channel only with `event-rule:` keys (`AdminServices`).
 *
 * Attaching writes the rule first and the channel's tag second, and detaching removes the tag first: the router runs nothing
 * for a rule its room does not name, so at no point between the two can an event start a run nobody chose. An attach whose
 * target or tag could not be written removes the rule it made, so nothing is left half-written, and a throttled call answers
 * 429 `TRIGGER_THROTTLED`, which the console says as "try again".
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ADMIN_NOTICE_TYPES, adminNoticeStateParam, switchableNotice, type AdminNoticeType } from './lib/admin-notice-types.js';
import { DeleteRuleCommand, DescribeRuleCommand, DisableRuleCommand, EnableRuleCommand, EventBridgeClient, ListRulesCommand, ListTagsForResourceCommand, ListTargetsByRuleCommand, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand } from '@aws-sdk/client-eventbridge';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { eventPolicyErrors, forgetEventPolicy, patternAllowed, readEventPolicy } from './lib/event-policy.js';
import { DescribeSchemaCommand, ListSchemasCommand, SchemasClient } from '@aws-sdk/client-schemas';
import { TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { defaultProfileRegistry, loadProfileRegistry } from '../../lib/profile-registry';
import { definitionParamName } from './lib/active-profile.js';
import { HANDOFF_FIELD_TYPES, PROCESS_SOURCE_PREFIX, type AttachedHandoff, type HandoffField } from './lib/event-workflow.js';
import { InvocationType, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { requireAdmin } from './lib/auth.js';
import { requireOwnedAssistant, isRefusal as isScopeRefusal } from './lib/assistant-scope.js';
import { readChannelTags } from './lib/channel-classification.js';
import { DEV_ORIGIN, originsFrom, requestOrigin, responder } from './lib/http-response.js';
import {
  EVENT_RULE_TAG_PREFIX, describeSchema, patternFor, patternFromRule, teamRoomArn, triggerRuleId, triggerRuleName, triggerTargetInput, type EventPattern, eventTypeMatches,
  ASSISTANT_HANDLE, WATCH_TAG, watchRuleId, watchRuleName, watchRuleTags, watchTargetInput,
  HANDOFF_KEY_PATH, MAX_INPUT_TEMPLATE, RUN_ROOT_TAG, attachedHandoffOf, editRunRoot, handoffPattern } from './lib/event-triggers.js';
import { REF_KIND, isRefPath, watchedKindSources } from '../../lib/config/event-openers';
import { CONNECTOR_FACT_SOURCE, CONVERSATION_TYPES, NAMED_WATCH_KIND, PATTERN_WATCH_KIND, PROCESS_CONVERSATION_PATTERN, PROCESS_WATCH_KIND, classificationAllowedForType, eventReachesType, isPatternType, isTeamRoomType, patternVariables } from '../../lib/config/conversation-types';
import { groupSourcedRoles } from '../../lib/config/participant-roles';


const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGINS, DEV_ORIGIN);
const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,POST,OPTIONS' });
const respond = (event: APIGatewayProxyEvent, status: number, body: unknown): APIGatewayProxyResult => http.respond(status, body, requestOrigin(event));

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN ?? '';
const RULE_PREFIX = process.env.EVENT_TRIGGER_RULE_PREFIX ?? '';
const CREATOR_NAME_PATTERN = process.env.TYPED_CREATOR_NAME_PATTERN ?? '';
/** This deployment's instance, which a platform source's events name (`detail.instance`). */
const INSTANCE_NAME = process.env.AE_INSTANCE_NAME ?? '';
const REGISTRIES = ['aws.events', 'discovered-schemas'];
const NAME = /^[A-Za-z0-9._@-]{1,256}$/;
const WORKFLOW = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RULE_ID = /^[a-f0-9]{12}$/;

/**
 * THE ASSISTANT A TRIGGER IS ATTACHED FOR, from the version the console attaches it from: its version's workflow runs when the
 * event arrives, and the run speaks as it (`workflowOwnerOf`). Recorded on the rule, never inferred. The router refuses one that
 * is not a live assistant of the classification and a member of the room. Absent: the room's type or primary owns the run.
 */
function attachingAssistant(body: Record<string, unknown>): { assistant?: string } | { error: string } {
  if (body.assistant === undefined) return {};
  return typeof body.assistant === 'string' && ASSISTANT_HANDLE.test(body.assistant) ? { assistant: body.assistant } : { error: 'assistant names the assistant whose version the workflow is on' };
}
/**
 * A HAND-OFF THE DEPLOYMENT'S ACTIVE VERSIONS DECLARE (DESIGN-PROCESSES sections 4.2 and 12): the sending assistant and its
 * classification, the process, the hand-off and its typed fields.
 */
export interface DeclaredHandoff { assistant: string; classification: string; process: string; name: string; fields: Record<string, HandoffField> }

/**
 * ONE ASSISTANT'S ACTIVE `processes`, read from its active definition by name (`ReadActiveDefinitions`), the rest of the
 * definition discarded: configuration, never a conversation or a person's data. An assistant with no active version has none.
 */
async function activeProcessesOf(assistant: string): Promise<Record<string, unknown>> {
  const res = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(process.env.SSM_ROOT ?? '', assistant)}:active` })).catch((err) => {
    const name = (err as { name?: string }).name;
    if (name === 'ParameterNotFound' || name === 'ParameterVersionLabelNotFound') return undefined;
    throw err;
  });
  try {
    const p = (JSON.parse(res?.Parameter?.Value ?? '{}') as { processes?: unknown }).processes;
    return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
  } catch { return {}; }
}

/** A declaration's fields, kept only where every field is of a closed type (O2); anything else declares nothing to attach. */
function typedFields(raw: unknown): Record<string, HandoffField> | undefined {
  const fields = raw && typeof raw === 'object' ? (raw as { fields?: unknown }).fields : undefined;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) return undefined;
  return Object.values(fields).every((v) => v && typeof v === 'object' && (HANDOFF_FIELD_TYPES as readonly unknown[]).includes((v as { type?: unknown }).type))
    ? fields as Record<string, HandoffField> : undefined;
}

/** EVERY HAND-OFF THE DEPLOYMENT'S ACTIVE VERSIONS DECLARE, for the names the profile registry lists (SPEC-PROCESSES P6). */
export async function declaredHandoffs(read: (assistant: string) => Promise<Record<string, unknown>> = activeProcessesOf): Promise<DeclaredHandoff[]> {
  await loadProfileRegistry();
  const registry = defaultProfileRegistry;
  const out: DeclaredHandoff[] = [];
  for (const assistant of registry.profileNames()) {
    const classification = registry.classificationOfAssistant(assistant);
    if (!classification) continue;
    for (const [process, p] of Object.entries(await read(assistant))) {
      const handoffs = p && typeof p === 'object' ? (p as { handoffs?: unknown }).handoffs : undefined;
      for (const [name, h] of Object.entries(handoffs && typeof handoffs === 'object' ? handoffs as Record<string, unknown> : {})) {
        const fields = typedFields(h);
        if (fields) out.push({ assistant, classification, process, name, fields });
      }
    }
  }
  return out;
}

/**
 * THE HAND-OFF A RECEIVING TEAM ATTACHES (DESIGN-PROCESSES section 12), read again from the active versions, never from the
 * request: the request names the sending classification, the process and the hand-off, and the declaration is the one an
 * active version declares now. Its pattern is the exact source and `detail-type` on this instance. Two assistants of one
 * classification declaring the same hand-off would put the same event, so the receiver could not tell them apart: refused.
 */
export async function handoffChoice(body: Record<string, unknown>, list: () => Promise<DeclaredHandoff[]> = declaredHandoffs): Promise<
  undefined | { status: number; code: string; error: string } | { pattern: EventPattern; attached: AttachedHandoff; bus: string }
> {
  if (body.handoff === undefined) return undefined;
  if (['platformEvent', 'eventType', 'resourceArn', 'rule'].some((k) => body[k] !== undefined)) return { status: 400, code: 'TRIGGER_INVALID', error: 'a hand-off is chosen alone' };
  const h = body.handoff && typeof body.handoff === 'object' ? body.handoff as Record<string, unknown> : {};
  if (![h.classification, h.process, h.name].every((v) => typeof v === 'string' && ASSISTANT_HANDLE.test(v))) {
    return { status: 400, code: 'TRIGGER_INVALID', error: 'handoff names the sending classification, the process and the hand-off' };
  }
  if (!INSTANCE_NAME) return { status: 503, code: 'NO_INSTANCE', error: 'this deployment names no instance, so a hand-off cannot be matched to it' };
  const bus = handoffRuleBus();
  if (!bus) return { status: 503, code: 'NO_PROCESS_BUS', error: 'this deployment names no process event bus, so no hand-off can be attached' };
  const found = (await list()).filter((d) => d.classification === h.classification && d.process === h.process && d.name === h.name);
  if (!found.length) return { status: 404, code: 'NO_SUCH_HANDOFF', error: 'no active version declares that hand-off' };
  if (found.length > 1) return { status: 409, code: 'HANDOFF_AMBIGUOUS', error: 'more than one assistant of that classification declares that hand-off' };
  const d = found[0];
  return { pattern: handoffPattern(d.classification, d.process, d.name, INSTANCE_NAME), attached: attachedHandoffOf(d.classification, d.process, d.name, d.fields), bus };
}

/**
 * THE BUS A HAND-OFF'S RULE IS WRITTEN ON (DESIGN-PROCESSES section 12), the one seam that names it: the bus the routers put
 * hand-offs on (`PROCESS_EVENT_BUS`). Unnamed, no hand-off is attached.
 */
export function handoffRuleBus(): string | undefined {
  return process.env.PROCESS_EVENT_BUS || undefined;
}

/** Whether a pattern names a process source: such an event is a hand-off, attached only as one (`handoffChoice`). */
export const namesAProcessSource = (p: { source?: unknown }): boolean =>
  (Array.isArray(p.source) ? p.source : []).some((x) => typeof x === 'string' && x.startsWith(PROCESS_SOURCE_PREFIX));
const PROCESS_SOURCE_ONLY_AS_HANDOFF = { code: 'HANDOFF_ONLY', error: 'a process source is attached as a hand-off, whose declared fields the receiving router checks' };

const TRIGGERS_ROUTE = '/admin/event-triggers/{typeKey}/{classification}';
/** The platform's admin notices, which no workflow may start on. */
export const ADMIN_NOTICE_SOURCE = 'ae.alert';
/** A team's own triggers (`view-event-triggers`): the rules attached for the route's assistant, which the caller's team owns. */
const TEAM_TRIGGERS_ROUTE = '/admin/assistants/{assistant}/event-triggers/{typeKey}/{classification}';
const REMOVE_ROUTE = `${TRIGGERS_ROUTE}/{ruleId}/remove`;

/**
 * THE ASSISTANT A REMOVAL IS ASKED FOR (the console's editor of that assistant's version), from the body: absent, or a
 * handle. A rule attached for another assistant runs that assistant's version, so it is refused (`otherAssistantsRule`).
 */
function removingAssistant(event: APIGatewayProxyEvent): { assistant?: string } | { error: string } {
  let body: Record<string, unknown> = {};
  try { body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {}; } catch { return { error: 'the body is not JSON' }; }
  return body && typeof body === 'object' ? attachingAssistant(body) : {};
}

/** Whether a rule recorded for one assistant is asked to be removed for another. */
const otherAssistantsRule = (recorded: string | undefined, asked: string | undefined): boolean => !!recorded && !!asked && recorded !== asked;
const OTHER_ASSISTANT = { code: 'TRIGGER_OTHER_ASSISTANT', error: 'that trigger was attached for another assistant, whose version runs it' };

const eventbridge = new EventBridgeClient({});
const cloudwatch = new CloudWatchClient({});

/** The most rules or alarms one listing returns: the form searches by prefix past it. */
export const MAX_LISTED = 200;
/** A name prefix the form searches by: the characters a rule or an alarm name may start with. */
const LIST_PREFIX = /^[\w .:/#+=@-]{0,255}$/;

/** A rule in the account, as the trigger form offers it to copy: this deployment's own trigger and watch rules are marked. */
export interface AccountRule { name: string; arn: string; pattern: string | null; state: string; description?: string; attached: boolean }

/** THE ACCOUNT'S RULES ON THE DEFAULT BUS, by name prefix: the form copies one's pattern, and marks this deployment's own. */
export async function listAccountRules(prefix: string, send: (c: ListRulesCommand) => Promise<{ Rules?: Array<Record<string, unknown>>; NextToken?: string }> = (c) => eventbridge.send(c) as never): Promise<AccountRule[]> {
  const out: AccountRule[] = [];
  let token: string | undefined;
  do {
    const res = await send(new ListRulesCommand({ ...(prefix ? { NamePrefix: prefix } : {}), NextToken: token, Limit: 100 }));
    for (const r of res.Rules ?? []) {
      const name = String(r.Name ?? '');
      if (!name) continue;
      out.push({
        name, arn: String(r.Arn ?? ''), pattern: typeof r.EventPattern === 'string' ? r.EventPattern : null, state: String(r.State ?? ''),
        ...(typeof r.Description === 'string' && r.Description ? { description: r.Description.slice(0, 256) } : {}),
        // THIS DEPLOYMENT'S OWN TRIGGER AND WATCH RULES are attached already, never offered to copy.
        attached: !!RULE_PREFIX && name.startsWith(RULE_PREFIX),
      });
    }
    token = res.NextToken;
  } while (token && out.length < MAX_LISTED);
  return out.slice(0, MAX_LISTED);
}

/** An alarm in the account, as the trigger form offers it: its name, ARN and state now. */
export interface AccountAlarm { name: string; arn: string; state: string; kind: 'metric' | 'composite'; namespace?: string; metric?: string }

/** THE ACCOUNT'S ALARMS, by name prefix, with each one's state: read only (`cloudwatch:DescribeAlarms`). */
export async function listAccountAlarms(prefix: string, send: (c: DescribeAlarmsCommand) => Promise<{ MetricAlarms?: Array<Record<string, unknown>>; CompositeAlarms?: Array<Record<string, unknown>>; NextToken?: string }> = (c) => cloudwatch.send(c) as never): Promise<AccountAlarm[]> {
  const out: AccountAlarm[] = [];
  let token: string | undefined;
  do {
    const res = await send(new DescribeAlarmsCommand({ ...(prefix ? { AlarmNamePrefix: prefix } : {}), AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], NextToken: token, MaxRecords: 100 }));
    for (const a of res.MetricAlarms ?? []) {
      if (!a.AlarmName || !a.AlarmArn) continue;
      out.push({ name: String(a.AlarmName), arn: String(a.AlarmArn), state: String(a.StateValue ?? ''), kind: 'metric', ...(a.Namespace ? { namespace: String(a.Namespace) } : {}), ...(a.MetricName ? { metric: String(a.MetricName) } : {}) });
    }
    for (const a of res.CompositeAlarms ?? []) {
      if (!a.AlarmName || !a.AlarmArn) continue;
      out.push({ name: String(a.AlarmName), arn: String(a.AlarmArn), state: String(a.StateValue ?? ''), kind: 'composite' });
    }
    token = res.NextToken;
  } while (token && out.length < MAX_LISTED);
  return out.slice(0, MAX_LISTED);
}
const schemas = new SchemasClient({});
const chime = chimeMessagingClient();
const lambda = new LambdaClient({});
const ssm = new SSMClient({});

/**
 * The deployment's trigger rules at every classification, the count `maxTriggers` bounds: a team room's is named
 * `<prefix>-<classification>-trigger-<id>` and a watched conversation's `<prefix>-<classification>-watch-<id>`, and both count.
 */
const TRIGGER_RULE = /-(trigger|watch)-[a-f0-9]{12}$/;
/** Whether an EventBridge call was refused because the rule is already gone. */
function ruleIsGone(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'ResourceNotFoundException';
}

/** An EventBridge read of a rule: its answer, undefined only where the rule is gone, and any other failure thrown. */
function ruleRead<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((err) => { if (ruleIsGone(err)) return undefined; throw err; });
}

/**
 * A TRIGGER'S RULE, DELETED OR THE REMOVAL FAILS: its target first, then the rule. A rule already gone counts as deleted;
 * any other refusal, or a target EventBridge did not remove, throws, so the caller is answered with the failure and the
 * rule is never reported removed while it still runs the workflow.
 */
async function deleteTriggerRule(Rule: string): Promise<void> {
  // A HAND-OFF'S RULE IS ON THE PROCESS EVENT BUS (DESIGN-PROCESSES section 12): the rule is removed from every bus a trigger is
  // written on, a bus that does not hold it answering as gone.
  for (const bus of triggerBuses()) {
    const on = bus ? { EventBusName: bus } : {};
    try {
      const res = await eventbridge.send(new RemoveTargetsCommand({ Rule, Ids: ['router'], ...on }));
      if ((res?.FailedEntryCount ?? 0) > 0) throw new Error(`the target of ${Rule} was not removed: ${res.FailedEntries?.[0]?.ErrorCode ?? 'unknown'}`);
    } catch (err) {
      if (!ruleIsGone(err)) throw err;
    }
    try {
      await eventbridge.send(new DeleteRuleCommand({ Name: Rule, ...on }));
    } catch (err) {
      if (!ruleIsGone(err)) throw err;
    }
  }
}

/** Every bus a trigger's rule is written on: the default bus, and the process event bus a hand-off's rule is on. */
function triggerBuses(): Array<string | undefined> {
  const bus = handoffRuleBus();
  return bus ? [undefined, bus] : [undefined];
}

/** A trigger's rule by its name, on whichever bus holds it, with the bus it was found on; undefined where none holds it. */
async function describeTriggerRule(Name: string): Promise<{ Arn?: string; EventPattern?: string; bus?: string } | undefined> {
  for (const bus of triggerBuses()) {
    const rule = await ruleRead(eventbridge.send(new DescribeRuleCommand({ Name, ...(bus ? { EventBusName: bus } : {}) })));
    if (rule?.Arn) return { ...rule, ...(bus ? { bus } : {}) };
  }
  return undefined;
}

async function triggerCount(): Promise<number> {
  let n = 0;
  for (const bus of triggerBuses()) {
    let token: string | undefined;
    do {
      const res = await eventbridge.send(new ListRulesCommand({ NamePrefix: RULE_PREFIX, NextToken: token, Limit: 100, ...(bus ? { EventBusName: bus } : {}) }));
      n += (res.Rules ?? []).filter((r) => TRIGGER_RULE.test(r.Name ?? '')).length;
      token = res.NextToken;
    } while (token);
  }
  return n;
}

/** The event types the schema registry knows: AWS's own, and those discovered on this account's buses. */
async function listEventTypes(query: string): Promise<Array<{ name: string; registry: string }>> {
  const out: Array<{ name: string; registry: string }> = [];
  for (const registry of REGISTRIES) {
    let token: string | undefined;
    do {
      const res = await schemas.send(new ListSchemasCommand({ RegistryName: registry, NextToken: token, Limit: 100 })).catch((err) => {
        // A registry absent because discovery is off is an empty list; anything else is a real failure and reaches the caller.
        if ((err as { name?: string }).name === 'NotFoundException') return { Schemas: [], NextToken: undefined };
        throw err;
      });
      for (const s of res.Schemas ?? []) {
        if (s.SchemaName && eventTypeMatches(s.SchemaName, query)) out.push({ name: s.SchemaName, registry });
      }
      token = res.NextToken;
    } while (token && out.length < 100);
  }
  return out.slice(0, 100);
}

/** What one schema in the registry says its event carries. */
async function describedSchemaNamed(name: string): Promise<{ source: string; detailType: string; detailPaths: string[] } | undefined> {
  for (const registry of REGISTRIES) {
    const res = await schemas.send(new DescribeSchemaCommand({ RegistryName: registry, SchemaName: name })).catch(() => undefined);
    const d = res ? describeSchema(res.Content) : undefined;
    if (d) return d;
  }
  return undefined;
}

async function typeOfSchemaNamed(name: string): Promise<{ source: string; detailType: string } | undefined> {
  const d = await describedSchemaNamed(name);
  return d ? { source: d.source, detailType: d.detailType } : undefined;
}

/** A rule named by its ARN or its name, on the bus its ARN names, the default otherwise. A trigger copies a rule on the default bus only. */
function ruleRef(ref: string): { Name: string; EventBusName?: string } {
  const after = ref.startsWith('arn:') ? ref.split(':rule/')[1] ?? '' : ref;
  const [first, second] = after.split('/');
  return second ? { Name: second, EventBusName: first } : { Name: first };
}

/** What the caller chose, as one pattern, or why it means nothing a rule could match precisely. */
async function patternOfChoice(body: Record<string, unknown>): Promise<EventPattern | { error: string }> {
  const str = (k: string) => (typeof body[k] === 'string' && body[k] ? body[k] as string : undefined);
  const rule = str('rule');
  if (rule) {
    const ref = ruleRef(rule);
    if (ref.EventBusName && ref.EventBusName !== 'default') return { error: 'a trigger copies a rule on the default event bus; a rule on a custom bus cannot be copied yet' };
    const res = await eventbridge.send(new DescribeRuleCommand({ Name: ref.Name })).catch(() => undefined);
    return res ? patternFromRule(res.EventPattern) : { error: 'no such rule on this account' };
  }
  // AN AGENTECHELON EVENT, named by its source and detail type: the platform's own, never an admin notice (`ae.alert`), which
  // reaches the admin channel by its own rule and never a member's workflow. The policy's allowed types hold it after this.
  const platform = body.platformEvent as { source?: unknown; detailType?: unknown } | undefined;
  if (platform !== undefined) {
    const source = typeof platform?.source === 'string' ? platform.source : '';
    const detailType = typeof platform?.detailType === 'string' ? platform.detailType : '';
    if (!/^ae\.[a-z][a-z0-9.-]{0,40}$/.test(source) || !detailType || detailType.length > 128) return { error: 'platformEvent names an AgentEchelon source and a detail type' };
    if (source === ADMIN_NOTICE_SOURCE) return { error: 'an admin notice is not a trigger: it reaches the admin channel by its own rule' };
    if (source.startsWith(PROCESS_SOURCE_PREFIX)) return { error: PROCESS_SOURCE_ONLY_AS_HANDOFF.error };
    return patternFor({ source, detailType });
  }
  const schema = str('eventType');
  if (schema) {
    if (!NAME.test(schema)) return { error: 'eventType is a schema name' };
    const type = await typeOfSchemaNamed(schema);
    if (!type) return { error: 'no schema of that name in the registry; send the event once, with discovery on, or paste a rule instead' };
    return patternFor({ ...type, ...(str('resourceArn') ? { resourceArn: str('resourceArn') } : {}) });
  }
  if (str('resourceArn')) return patternFor({ resourceArn: str('resourceArn') });
  return { error: 'name a platformEvent, an eventType, a resourceArn or a rule' };
}

/** One watch rule this classification holds for a type, as the console lists it: its binding from its tags, its key path from its target. */
interface WatchTrigger { id: string; workflow: string; ruleArn: string | null; pattern: string | null; kind: string; keyPath: string | null; assistant?: string; supersedes?: string }

/**
 * One listed rule as this type's watch trigger, or undefined when it is another's or is gone before its tags are read. A tag
 * read that fails for any other reason throws, so a list or a count is never short by a rule that still runs.
 */
async function watchTriggerFrom(r: { Name?: string; Arn?: string; EventPattern?: string }, namePrefix: string, typeKey: string, classification: string, bus?: string): Promise<WatchTrigger | undefined> {
  const id = (r.Name ?? '').slice(namePrefix.length);
  if (!RULE_ID.test(id) || !r.Arn) return undefined;
  const tagged = await ruleRead(eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: r.Arn })));
  if (!tagged) return undefined;
  const tags = Object.fromEntries((tagged.Tags ?? []).map((t) => [t.Key, t.Value]));
  if (tags[WATCH_TAG.type] !== typeKey || tags[WATCH_TAG.classification] !== classification) return undefined;
  const target = (await eventbridge.send(new ListTargetsByRuleCommand({ Rule: r.Name, ...(bus ? { EventBusName: bus } : {}) })).catch(() => undefined))?.Targets?.[0];
  return { id, workflow: tags[WATCH_TAG.workflow] ?? '', ruleArn: r.Arn, pattern: r.EventPattern ?? null, kind: tags[WATCH_TAG.kind] ?? '', keyPath: target?.InputTransformer?.InputPathsMap?.key ?? null, ...(tags[WATCH_TAG.assistant] ? { assistant: tags[WATCH_TAG.assistant] } : {}), ...(tags[RUN_ROOT_TAG] ? { supersedes: tags[RUN_ROOT_TAG] } : {}) };
}

/** One watch rule by its id, read by itself: this type's at this classification, or undefined. */
async function watchTriggerById(typeKey: string, classification: string, id: string): Promise<WatchTrigger | undefined> {
  const Name = watchRuleName(RULE_PREFIX, classification, id);
  const rule = await describeTriggerRule(Name).catch(() => undefined);
  return rule?.Arn ? watchTriggerFrom({ Name, Arn: rule.Arn, EventPattern: rule.EventPattern }, watchRuleName(RULE_PREFIX, classification, ''), typeKey, classification, rule.bus) : undefined;
}

/** The watch rules this classification holds for a type (DESIGN-EVENT-TARGETS section 7), read from the rules themselves. */
async function watchTriggersOf(typeKey: string, classification: string): Promise<WatchTrigger[]> {
  const namePrefix = watchRuleName(RULE_PREFIX, classification, '');
  const out: WatchTrigger[] = [];
  for (const bus of triggerBuses()) {
    let token: string | undefined;
    do {
      const res = await eventbridge.send(new ListRulesCommand({ NamePrefix: namePrefix, NextToken: token, Limit: 100, ...(bus ? { EventBusName: bus } : {}) }));
      const found = await Promise.all((res.Rules ?? []).map((r) => watchTriggerFrom(r, namePrefix, typeKey, classification, bus)));
      out.push(...found.filter((t): t is WatchTrigger => !!t));
      token = res.NextToken;
    } while (token);
  }
  return out;
}

/** The role that leads a type's team room: the one it fills from a group, with one holder. */
const teamRoomLeadRole = (typeKey: string): string | undefined =>
  groupSourcedRoles((k) => k === typeKey).find((r) => r.decl.holders === 'one')?.role;

/**
 * Open the room if it has never been, or complete it: the creator's id is fixed, so an existing room is the answer and nothing
 * is doubled. Answers whether it stands, with the creator's own reason when it does not (an on-call group without exactly one
 * person, an assistant the type names that this deployment does not declare).
 */
async function ensureTeamRoom(typeKey: string, classification: string): Promise<{ ok: true } | { ok: false; reason?: string }> {
  if (!CREATOR_NAME_PATTERN) return { ok: false, reason: 'no conversation creator is configured' };
  const res = await lambda.send(new InvokeCommand({
    FunctionName: CREATOR_NAME_PATTERN.replace('{classification}', classification),
    InvocationType: InvocationType.RequestResponse,
    Payload: Buffer.from(JSON.stringify({ detail: { conversationType: typeKey, forRole: teamRoomLeadRole(typeKey), teamRoom: true } })),
  }));
  if (res.FunctionError) return { ok: false };
  const out = JSON.parse(Buffer.from(res.Payload ?? []).toString() || '{}') as { ok?: boolean; error?: unknown };
  return out.ok === true ? { ok: true } : { ok: false, ...(typeof out.error === 'string' ? { reason: out.error.slice(0, 300) } : {}) };
}

export const ADMIN_NOTICES_ROUTE = '/admin/admin-notices';
export const ADMIN_NOTICE_SWITCH_ROUTE = '/admin/admin-notices/{key}';

/** An operational notice's rule, by this instance's rule prefix (`adminNoticeRuleName`). */
const noticeRule = (key: string): string => `${RULE_PREFIX}admin-notice-${key}`;
const noticeParam = (key: string): string => adminNoticeStateParam(process.env.SSM_ROOT ?? '', key);

/**
 * EVERY NOTICE TYPE AND WHETHER IT POSTS: a security notice always; an operational one as its recorded state says, the state its
 * rule read at the last deploy and the switch has kept since. A state that cannot be read is reported as unknown, never as on.
 */
export async function listAdminNotices(): Promise<Array<{ key: string; messageType: string; security: boolean; enabled: boolean | null }>> {
  return Promise.all(ADMIN_NOTICE_TYPES.map(async (t) => {
    if (t.security) return { key: t.key, messageType: t.messageType, security: true, enabled: true };
    const value = await ssm.send(new GetParameterCommand({ Name: noticeParam(t.key) })).then((r) => r.Parameter?.Value, () => undefined);
    return { key: t.key, messageType: t.messageType, security: false, enabled: value === 'ENABLED' ? true : value === 'DISABLED' ? false : null };
  }));
}

/**
 * SWITCH AN OPERATIONAL NOTICE: the rule first, then the recorded state a deploy keeps and the console reads, so the console
 * never shows a state the rule is not in. A rule switch that fails changes nothing recorded; a record that cannot be written
 * switches the rule back. Either way the call throws, so the console says it did not take.
 */
export async function switchAdminNotice(notice: AdminNoticeType, enabled: boolean): Promise<void> {
  if (notice.security) throw new Error('a security notice is always on');
  const ruleTo = (on: boolean) => eventbridge.send(on ? new EnableRuleCommand({ Name: noticeRule(notice.key) }) : new DisableRuleCommand({ Name: noticeRule(notice.key) }));
  await ruleTo(enabled);
  try {
    await ssm.send(new PutParameterCommand({ Name: noticeParam(notice.key), Value: enabled ? 'ENABLED' : 'DISABLED', Type: 'String', Overwrite: true }));
  } catch (err) {
    await ruleTo(!enabled).catch((e) => console.error('[EventTriggers] a notice whose state could not be recorded could not be switched back', { notice: notice.key, name: (e as Error)?.name }));
    throw err;
  }
}

/** What manage-profiles names after an activation: the assistant whose triggers are checked against its active version. */
export interface TriggerSweepRequest { aeTriggerSweep: { assistant: string } }

const isSweepRequest = (event: unknown): event is TriggerSweepRequest => {
  const e = event as Partial<TriggerSweepRequest & APIGatewayProxyEvent> | null;
  return !!e && typeof e === 'object' && e.httpMethod === undefined && !!e.aeTriggerSweep && typeof e.aeTriggerSweep.assistant === 'string';
};

/**
 * THE WORKFLOWS AN ASSISTANT'S ACTIVE VERSION RUNS ON AN ATTACHED EVENT (`event-received`), read from its active definition by
 * name (`ReadActiveDefinitions`): inline where the definition holds them, else the names it keeps where they are a body of the
 * store (`eventWorkflowsListed`). Null where no version is active or the definition cannot be read, so nothing is judged.
 */
async function attachableWorkflowsOf(assistant: string): Promise<Set<string> | null> {
  const res = await ssm.send(new GetParameterCommand({ Name: `${definitionParamName(process.env.SSM_ROOT ?? '', assistant)}:active` })).catch((err) => {
    const name = (err as { name?: string }).name;
    if (name === 'ParameterNotFound' || name === 'ParameterVersionLabelNotFound') return undefined;
    throw err;
  });
  if (!res?.Parameter?.Value) return null;
  try {
    const def = JSON.parse(res.Parameter.Value) as { eventWorkflows?: Record<string, { on?: unknown }>; eventWorkflowsListed?: Array<{ name: string; on: string }> };
    const listed = def.eventWorkflows
      ? Object.entries(def.eventWorkflows).map(([name, wf]) => ({ name, on: wf?.on }))
      : def.eventWorkflowsListed;
    if (!Array.isArray(listed)) return null;
    return new Set(listed.filter((w) => w.on === 'event-received').map((w) => w.name));
  } catch { return null; }
}

/**
 * AN ACTIVATION'S TRIGGER CLEANUP (DESIGN-EVENT-TARGETS section 7): every trigger rule this deployment's trigger service owns
 * (its prefix, a trigger or watch rule) that was attached for this assistant (its `assistant` tag), whose workflow the
 * assistant's active version no longer runs on an attached event (it starts on a lifecycle event now, or is gone), is
 * detached as a removal detaches one: the team conversation's tag, then the rule's target, then the rule. Another assistant's
 * rule, or one attached for none, is never touched. Each rule that cannot be removed is logged and left, so the next activation
 * tries again; nothing here fails the activation that named it.
 */
export async function sweepAssistantTriggers(assistant: string): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  if (!ASSISTANT_HANDLE.test(assistant) || !RULE_PREFIX || !APP_INSTANCE_ARN) return { removed, failed };
  const keep = await attachableWorkflowsOf(assistant).catch(() => null);
  if (!keep) return { removed, failed };
  for (const bus of triggerBuses()) {
    let token: string | undefined;
    do {
      const res = await eventbridge.send(new ListRulesCommand({ NamePrefix: RULE_PREFIX, NextToken: token, Limit: 100, ...(bus ? { EventBusName: bus } : {}) }));
      for (const r of res.Rules ?? []) {
        const name = r.Name ?? '';
        const kind = TRIGGER_RULE.exec(name)?.[1];
        if (!kind || !r.Arn) continue;
        try {
          const tagged = await ruleRead(eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: r.Arn })));
          const tags = Object.fromEntries((tagged?.Tags ?? []).map((t) => [t.Key ?? '', t.Value ?? '']));
          if (tags.assistant !== assistant || !tags.workflow || keep.has(tags.workflow)) continue;
          const classification = tags.classification ?? '';
          const id = name.slice(name.length - 12);
          // THE TEAM CONVERSATION'S TAG FIRST, so the conversation never names a trigger whose rule is gone.
          if (kind === 'trigger' && tags['team-room'] && classification) {
            await chime.send(new UntagResourceCommand({ ResourceARN: teamRoomArn(APP_INSTANCE_ARN, tags['team-room'], classification), TagKeys: [`${EVENT_RULE_TAG_PREFIX}${id}`] }));
          }
          await deleteTriggerRule(name);
          removed.push(id);
        } catch (err) {
          failed.push(name);
          console.warn('[EventTriggers] a trigger the active version no longer runs could not be removed; the next activation tries again', { rule: name, name: (err as Error)?.name });
        }
      }
      token = res.NextToken;
    } while (token);
  }
  if (removed.length || failed.length) console.log(JSON.stringify({ _auditEvent: 'event_triggers_swept_after_activation', assistant, removed, failed }));
  return { removed, failed };
}

export const handler = async (event: APIGatewayProxyEvent | TriggerSweepRequest): Promise<APIGatewayProxyResult> => {
  // AN ACTIVATION'S CLEANUP is a direct invoke from manage-profiles, the one caller granted it; a gateway request always names
  // its method, so it never reaches this.
  if (isSweepRequest(event)) {
    await sweepAssistantTriggers(event.aeTriggerSweep.assistant).catch((err) => console.warn('[EventTriggers] an activation\'s trigger cleanup failed', { name: (err as Error)?.name }));
    return { statusCode: 200, body: '' };
  }
  // The deployment's set, read at runtime from the rows its stacks publish, before anything reads a classification.
  await loadProfileRegistry();
  if (event.httpMethod === 'OPTIONS') return http.empty(200, requestOrigin(event));
  const gate = await requireAdmin(event);
  if ('statusCode' in gate) return gate;
  if (!APP_INSTANCE_ARN || !RULE_PREFIX) return respond(event, 503, { error: 'event triggers are not configured' });

  try {
    // THE DEPLOYMENT'S POLICY (WT122): read, and replaced whole by an admin holding `manage-event-policy`.
    // THE ROUTE THE GATEWAY MATCHED, never a suffix of the path: each route's capability is what IAM checked, so a path that
    // ends like another route (`/admin/event-triggers/x/event-policy`) must reach only the route it matched.
    const route = event.resource ?? '';
    if (route === '/admin/event-policy') {
      if (event.httpMethod === 'GET') return respond(event, 200, { policy: await readEventPolicy() });
      if (event.httpMethod !== 'POST') return respond(event, 405, { error: 'method not allowed' });
      let next: unknown;
      try { next = JSON.parse(event.body ?? 'null'); } catch { next = null; }
      const errs = eventPolicyErrors(next);
      if (errs.length) return respond(event, 400, { code: 'POLICY_INVALID', errors: errs });
      await ssm.send(new PutParameterCommand({ Name: process.env.EVENT_POLICY_PARAM, Value: JSON.stringify(next), Type: 'String', Overwrite: true }));
      forgetEventPolicy();
      console.log(JSON.stringify({ _auditEvent: 'event_policy_changed', actor: gate.claims.actor || 'operator', policy: next }));
      return respond(event, 200, { policy: next });
    }
    // THE ADMIN NOTICES (DESIGN-EVENT-TARGETS section 12, `manage-event-triggers`): each notice type and whether it posts into
    // the admin notifications conversation. A security notice is always on and is refused a switch here, as IAM refuses it.
    if (route === ADMIN_NOTICES_ROUTE) {
      if (event.httpMethod !== 'GET') return respond(event, 405, { error: 'method not allowed' });
      return respond(event, 200, { notices: await listAdminNotices() });
    }
    if (route === ADMIN_NOTICE_SWITCH_ROUTE) {
      if (event.httpMethod !== 'POST') return respond(event, 405, { error: 'method not allowed' });
      const key = event.pathParameters?.key;
      const notice = switchableNotice(key);
      if (!notice) {
        return ADMIN_NOTICE_TYPES.some((t) => t.key === key)
          ? respond(event, 403, { code: 'NOTICE_ALWAYS_ON', error: 'a security notice is always on' })
          : respond(event, 404, { code: 'NO_SUCH_NOTICE', error: 'no notice of that key' });
      }
      let body: unknown;
      try { body = JSON.parse(event.body ?? 'null'); } catch { body = null; }
      const enabled = (body as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== 'boolean') return respond(event, 400, { code: 'NOTICE_INVALID', error: 'enabled is true or false' });
      await switchAdminNotice(notice, enabled);
      console.log(JSON.stringify({ _auditEvent: 'admin_notice_switched', actor: gate.claims.actor || 'operator', notice: notice.key, enabled }));
      return respond(event, 200, { notice: { key: notice.key, messageType: notice.messageType, security: false, enabled } });
    }
    // WHAT THE TRIGGER FORM CHOOSES FROM (`manage-event-triggers`): the account's rules and its alarms, by name prefix.
    if (route === '/admin/event-rules' || route === '/admin/event-alarms') {
      if (event.httpMethod !== 'GET') return respond(event, 405, { error: 'method not allowed' });
      const prefix = (event.queryStringParameters?.q ?? '').trim();
      if (!LIST_PREFIX.test(prefix)) return respond(event, 400, { code: 'LIST_INVALID', error: 'q is a name prefix' });
      return route === '/admin/event-rules'
        ? respond(event, 200, { rules: await listAccountRules(prefix) })
        : respond(event, 200, { alarms: await listAccountAlarms(prefix) });
    }
    if (route === '/admin/event-types') {
      if (event.httpMethod !== 'GET') return respond(event, 405, { error: 'method not allowed' });
      // ONE EVENT TYPE DESCRIBED (DESIGN-EVENT-TARGETS section 7): what it carries, so the form asks only for what it does not.
      const describe = event.queryStringParameters?.describe;
      if (describe !== undefined) {
        if (!NAME.test(describe)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'describe names a schema' });
        const described = await describedSchemaNamed(describe);
        return described ? respond(event, 200, { eventType: { name: describe, ...described } }) : respond(event, 404, { code: 'NO_SUCH_EVENT_TYPE', error: 'no schema of that name in the registry' });
      }
      // THE HAND-OFFS THE ACTIVE VERSIONS DECLARE (SPEC-PROCESSES P6), the trigger form's Hand-off source.
      if (event.queryStringParameters?.handoffs !== undefined) return respond(event, 200, { handoffs: await declaredHandoffs() });
      return respond(event, 200, { eventTypes: await listEventTypes(event.queryStringParameters?.q ?? '') });
    }
    // A TEAM'S OWN TRIGGERS: read only, after the second check that the caller's team owns the assistant the route names (IAM
    // named it in their session first). Only the rules attached for that assistant are listed: a rule attached for none is
    // the room's, and another's is another team's.
    if (route === TEAM_TRIGGERS_ROUTE) {
      if (event.httpMethod !== 'GET') return respond(event, 405, { error: 'method not allowed' });
      const owned = await requireOwnedAssistant(event);
      if (!owned) return respond(event, 404, { error: 'not found' });
      if (isScopeRefusal(owned)) return owned;
      const listed = await listTriggers({ ...event, resource: TRIGGERS_ROUTE });
      if (listed.statusCode !== 200) return listed;
      const body = JSON.parse(listed.body) as { triggers?: Array<{ assistant?: string }> };
      return respond(event, 200, { ...body, triggers: (body.triggers ?? []).filter((t) => t.assistant === owned.assistant) });
    }
    return await listTriggers(event);
  } catch (err) {
    console.error('[event-triggers] failed', { err: (err as Error)?.name, message: (err as Error)?.message });
    return respond(event, 500, { error: 'event triggers could not be read or changed' });
  }
};

/** THE TRIGGER ROUTES of one conversation type at one classification: listing, attaching and removing. */
async function listTriggers(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const route = event.resource ?? '';
  try {
    if (route !== TRIGGERS_ROUTE && route !== REMOVE_ROUTE) return respond(event, 404, { error: 'not found' });
    const typeKey = event.pathParameters?.typeKey ?? '';
    const classification = event.pathParameters?.classification ?? '';
    // ONE RULE FOR WHICH TYPES AN EVENT REACHES, the one the workflow validator and the console read (`eventReachesType`), and a
    // trigger whose event names its conversation reaches any type an event may run in but a meeting's.
    const namesItsConversation = event.httpMethod === 'POST' && route === TRIGGERS_ROUTE && (() => { try { return JSON.parse(event.body ?? '{}')?.target === 'named'; } catch { return false; } })();
    if ((!eventReachesType(typeKey) && !(namesItsConversation && CONVERSATION_TYPES[typeKey] && !CONVERSATION_TYPES[typeKey]!.meeting)) || !classificationAllowedForType(typeKey, classification)) {
      return respond(event, 400, { code: 'NOT_A_TRIGGER_TYPE', error: 'a trigger runs in a conversation type an event reaches (a team conversation type, or one whose opener watches a key), at a classification it permits' });
    }
    // A TYPE THAT IS NOT A TEAM ROOM'S RECEIVES AN EVENT IN THE CONVERSATION THAT WATCHES ITS KEY (DESIGN-EVENT-TARGETS).
    // A TRIGGER WHOSE EVENT NAMES ITS CONVERSATION IS A WATCH RULE, listed and removed with the type's watch triggers, which a
    // team conversation type and a type no event otherwise reaches do not list: it is refused for those, so none is left unlisted.
    if (namesItsConversation && (isTeamRoomType(typeKey) || !eventReachesType(typeKey))) {
      return respond(event, 409, { code: 'NAMED_TARGET_TYPE', error: 'a trigger whose event names its conversation is attached to a type whose watch triggers are listed: not a team conversation type, and one an event reaches' });
    }
    if (!isTeamRoomType(typeKey) || namesItsConversation) return await watchedTarget(event, route, typeKey, classification);
    const channelArn = teamRoomArn(APP_INSTANCE_ARN, typeKey, classification);
    const prefix = EVENT_RULE_TAG_PREFIX;

    if (route === TRIGGERS_ROUTE && event.httpMethod === 'GET') {
      const tags = await readChannelTags(chime as never, channelArn).catch(() => ({} as Record<string, string>));
      const triggers = await Promise.all(Object.entries(tags).filter(([k]) => k.startsWith(prefix)).map(async ([k, workflow]) => {
        const id = k.slice(prefix.length);
        const rule = await describeTriggerRule(triggerRuleName(RULE_PREFIX, classification, id));
        // THE ASSISTANT IT WAS ATTACHED FOR, from the rule's own tag, so the console shows each assistant its own triggers. A
        // read that fails answers the list with the failure: a trigger is never shown as nobody's while it is another's.
        const tagged = rule?.Arn ? await ruleRead(eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: rule.Arn }))) : undefined;
        const assistant = tagged?.Tags?.find((t) => t.Key === 'assistant')?.Value;
        return { id, workflow, ruleArn: rule?.Arn ?? null, pattern: rule?.EventPattern ?? null, ...(assistant ? { assistant } : {}) };
      }));
      return respond(event, 200, { channelArn, triggers });
    }

    if (route === REMOVE_ROUTE) {
      if (event.httpMethod !== 'POST') return respond(event, 405, { error: 'method not allowed' });
      const id = event.pathParameters?.ruleId ?? '';
      if (!RULE_ID.test(id)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'ruleId is a trigger\'s id' });
      const asked = removingAssistant(event);
      if ('error' in asked) return respond(event, 400, { code: 'TRIGGER_INVALID', error: asked.error });
      const Rule = triggerRuleName(RULE_PREFIX, classification, id);
      // ONLY THE ASSISTANT IT WAS ATTACHED FOR removes it, read from the rule's own tag; a tag that cannot be read refuses.
      const rule = await describeTriggerRule(Rule);
      const tagged = rule?.Arn ? await ruleRead(eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: rule.Arn }))) : undefined;
      if (otherAssistantsRule(tagged?.Tags?.find((t) => t.Key === 'assistant')?.Value, asked.assistant)) return respond(event, 409, OTHER_ASSISTANT);
      // THE RULE GOES FIRST, then the room's tag: a rule that stays keeps its tag, so the console still lists it and a
      // removal can be tried again, and no rule runs on with nothing naming it.
      await deleteTriggerRule(Rule);
      await chime.send(new UntagResourceCommand({ ResourceARN: channelArn, TagKeys: [`${prefix}${id}`] }));
      return respond(event, 200, { removed: id });
    }

    if (event.httpMethod !== 'POST') return respond(event, 405, { error: 'method not allowed' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body ?? '{}') as Record<string, unknown>; } catch { return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'the body is not JSON' }); }
    // A TEAM ROOM TYPE'S TRIGGER RUNS IN ITS TEAM ROOM: a watch target is for any other type.
    if (body.target !== undefined && body.target !== 'team') return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'a team conversation type\'s trigger runs in its team conversation' });
    const workflow = typeof body.workflow === 'string' ? body.workflow : '';
    if (!WORKFLOW.test(workflow)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'workflow names the workflow the event starts' });
    const attached = attachingAssistant(body);
    if ('error' in attached) return respond(event, 400, { code: 'TRIGGER_INVALID', error: attached.error });
    const { assistant } = attached;
    // AN EDIT NAMES THE TRIGGER IT REPLACES: one of this room's, for the same workflow, attached for the same assistant.
    const replaces = body.replaces === undefined ? undefined : typeof body.replaces === 'string' && RULE_ID.test(body.replaces) ? body.replaces : null;
    if (replaces === null) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'replaces is the id of the trigger the edit replaces' });
    // A HAND-OFF FROM ANOTHER TEAM (SPEC-PROCESSES P6) runs in the team conversation, whose workflow opens the conversation the work is done in.
    const handoff = await handoffChoice(body);
    if (handoff && 'error' in handoff) return respond(event, handoff.status, { code: handoff.code, error: handoff.error });
    const pattern = handoff ? handoff.pattern : await patternOfChoice(body);
    if ('error' in pattern && typeof pattern.error === 'string') return respond(event, 400, { code: 'TRIGGER_INVALID', error: pattern.error });
    if (!handoff && namesAProcessSource(pattern as EventPattern)) return respond(event, 400, PROCESS_SOURCE_ONLY_AS_HANDOFF);
    // THE POLICY HOLDS AT ATTACH, and the router holds it again on every event.
    const policy = await readEventPolicy();
    if (!policy.enabled) return respond(event, 409, { code: 'TRIGGERS_OFF', error: 'event triggers are switched off in this deployment\'s policy' });
    if (!patternAllowed(policy, pattern as EventPattern)) return respond(event, 409, { code: 'EVENT_TYPE_NOT_ALLOWED', error: 'this deployment\'s policy does not allow that event type' });
    // THE ROOM, OPENED OR COMPLETED ON EVERY ATTACH. Its id is fixed, so the creator opens it once and afterwards completes
    // it with the members its type names: a room whose creation stopped part way carries its `team-room` tag from
    // `CreateChannel` with nobody in it, so the tag alone never says it is ready. A standing room is completed even mid-handover;
    // only a room opened for the first time needs its on-call group to have exactly one person, and that refuses with the reason.
    // The creator's own reason is answered, so a room refused for another cause (an assistant the type names that this
    // deployment does not declare) says so.
    const room = await ensureTeamRoom(typeKey, classification);
    if (!room.ok) {
      return respond(event, 409, { code: 'NO_TEAM_ROOM', error: `the team conversation could not be opened${room.reason ? `: ${room.reason}` : ''}` });
    }
    // ITS OWN TRIGGERS, read from its tags once it stands. A read that fails refuses: the room's count is never taken as zero.
    const roomTags = await readChannelTags(chime as never, channelArn);
    // AN EDIT OF AN EDIT KEYS ITS RUNS BY THE FIRST RULE OF THE CHAIN, which the replaced rule records (`RUN_ROOT_TAG`).
    let runRoot: string | undefined;
    if (replaces) {
      if (roomTags[`${prefix}${replaces}`] !== workflow) return respond(event, 404, { code: 'TRIGGER_NOT_FOUND', error: 'this room holds no such trigger for this workflow' });
      const old = await describeTriggerRule(triggerRuleName(RULE_PREFIX, classification, replaces));
      const oldTags = old?.Arn ? await ruleRead(eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: old.Arn }))) : undefined;
      if (otherAssistantsRule(oldTags?.Tags?.find((t) => t.Key === 'assistant')?.Value, assistant)) return respond(event, 409, OTHER_ASSISTANT);
      runRoot = editRunRoot(replaces, oldTags?.Tags?.find((t) => t.Key === RUN_ROOT_TAG)?.Value, RULE_ID);
    }
    // A REPLACEMENT IS COUNTED ONCE: the trigger it replaces leaves as it arrives, so an edit at the cap is not refused.
    const replacing = replaces ? 1 : 0;
    if (Object.keys(roomTags).filter((k) => k.startsWith(prefix)).length - replacing >= policy.maxTriggersPerRoom) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the conversation holds as many triggers as the policy allows' });
    if (await triggerCount() - replacing >= policy.maxTriggers) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the deployment holds as many trigger rules as the policy allows' });
    const relay = (process.env.EVENT_TRIGGER_RELAY_NAME_PATTERN ?? '').replace('{classification}', classification);
    const relayArn = `arn:aws:lambda:${process.env.AWS_REGION}:${event.requestContext.accountId}:function:${relay}`;
    const id = triggerRuleId(channelArn, workflow, pattern as EventPattern, assistant);
    const Name = triggerRuleName(RULE_PREFIX, classification, id);
    // AN EDIT THAT CHANGED THE RULE keys its runs by the rule it replaces, so an event both match during the swap starts one run.
    const supersedes = runRoot && runRoot !== id ? runRoot : undefined;
    const input = triggerTargetInput({ rule: id, channelArn, workflow, assistant, ...(supersedes ? { supersedes } : {}), ...(handoff ? { handoff: handoff.attached } : {}) });
    if (input.InputTemplate.length > MAX_INPUT_TEMPLATE) return respond(event, 409, { code: 'HANDOFF_TOO_LARGE', error: 'the hand-off declares more than a rule\'s input can record' });
    const rule = await eventbridge.send(new PutRuleCommand({
      Name,
      ...(handoff ? { EventBusName: handoff.bus } : {}),
      Description: `Starts ${workflow} in the ${typeKey} team conversation at ${classification}`,
      EventPattern: JSON.stringify(pattern),
      State: 'ENABLED',
      Tags: [{ Key: 'classification', Value: classification }, { Key: 'team-room', Value: typeKey }, { Key: 'workflow', Value: workflow }, ...(assistant ? [{ Key: 'assistant', Value: assistant }] : []), ...(supersedes ? [{ Key: RUN_ROOT_TAG, Value: supersedes }] : [])],
    }));
    // NOTHING IS LEFT HALF-WRITTEN: a rule this attach made, whose target or room tag could not be written, is removed again, so
    // the deployment never holds a rule its room does not name. A trigger the room already named is left as it runs.
    const named = roomTags[`${prefix}${id}`] !== undefined;
    try {
      await eventbridge.send(new PutTargetsCommand({
        Rule: Name,
        ...(handoff ? { EventBusName: handoff.bus } : {}),
        Targets: [{ Id: 'router', Arn: relayArn, InputTransformer: input, RetryPolicy: { MaximumRetryAttempts: policy.retryAttempts, MaximumEventAgeInSeconds: policy.maxEventAgeSeconds } }],
      }));
      await chime.send(new TagResourceCommand({ ResourceARN: channelArn, Tags: [{ Key: `${prefix}${id}`, Value: workflow }] }));
    } catch (err) {
      if (!named) {
        await deleteTriggerRule(Name).catch((e) => console.error('[EventTriggers] an attach that failed could not remove its rule', { name: (e as Error)?.name }));
      }
      // A THROTTLED CALL IS SAID AS ONE (the Amazon Chime SDK's TagResource on a busy conversation): the console says to try again.
      if (isThrottled(err)) return respond(event, 429, { code: 'TRIGGER_THROTTLED', error: 'the call was throttled; nothing was attached, try again' });
      throw err;
    }
    // THE TRIGGER IT REPLACED GOES ONCE THE NEW ONE STANDS: its rule first, then the room's tag, as a removal does. An edit
    // that kept every part is the same rule, rewritten in place above, and nothing is removed.
    if (replaces && replaces !== id) {
      await deleteTriggerRule(triggerRuleName(RULE_PREFIX, classification, replaces));
      await chime.send(new UntagResourceCommand({ ResourceARN: channelArn, TagKeys: [`${prefix}${replaces}`] }));
    }
    return respond(event, 200, { id, ruleArn: rule.RuleArn, channelArn, pattern, ...(assistant ? { assistant } : {}), ...(replaces ? { replaced: replaces } : {}) });
  } catch (err) {
    console.error('[EventTriggers] the request failed', { message: (err as Error)?.message, name: (err as Error)?.name });
    return respond(event, 500, { error: 'the trigger could not be changed' });
  }
};

/** Whether an AWS call was refused for its rate: the Amazon Chime SDK's throttle, or any service's. */
function isThrottled(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return ['ThrottledClientException', 'ThrottlingException', 'TooManyRequestsException'].includes(e?.name ?? '') || e?.$metadata?.httpStatusCode === 429;
}

/**
 * THE WATCHED CONVERSATION'S TRIGGERS (DESIGN-EVENT-TARGETS sections 4 and 7): list, attach and remove the watch rules of a type
 * that is not a team room's. The binding is the rule's own tags, written here and nowhere else, which the router reads.
 */
async function watchedTarget(event: APIGatewayProxyEvent, route: string, typeKey: string, classification: string): Promise<APIGatewayProxyResult> {
  if (route === TRIGGERS_ROUTE && event.httpMethod === 'GET') {
    return respond(event, 200, { target: 'watched', channelArn: null, triggers: await watchTriggersOf(typeKey, classification) });
  }
  if (route === REMOVE_ROUTE) {
    if (event.httpMethod !== 'POST') return respond(event, 405, { error: 'method not allowed' });
    const id = event.pathParameters?.ruleId ?? '';
    if (!RULE_ID.test(id)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'ruleId is a trigger\'s id' });
    const asked = removingAssistant(event);
    if ('error' in asked) return respond(event, 400, { code: 'TRIGGER_INVALID', error: asked.error });
    // ONLY THIS TYPE'S RULE is removed: one named by another type's or classification's path is not found here.
    const found = await watchTriggerById(typeKey, classification, id);
    if (!found) return respond(event, 404, { code: 'TRIGGER_NOT_FOUND', error: 'this type holds no such trigger' });
    // ONLY THE ASSISTANT IT WAS ATTACHED FOR removes it.
    if (otherAssistantsRule(found.assistant, asked.assistant)) return respond(event, 409, OTHER_ASSISTANT);
    const Rule = watchRuleName(RULE_PREFIX, classification, id);
    await deleteTriggerRule(Rule);
    return respond(event, 200, { removed: id });
  }
  if (event.httpMethod !== 'POST') return respond(event, 405, { error: 'method not allowed' });
  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body ?? '{}') as Record<string, unknown>; } catch { return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'the body is not JSON' }); }
  if (body.target !== 'watched' && body.target !== 'named') return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'a type that is not a team conversation type runs its trigger in the conversation that watches the event\'s key (target: watched), or in the one a connector fact names (target: named)' });
  const workflow = typeof body.workflow === 'string' ? body.workflow : '';
  if (!WORKFLOW.test(workflow)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'workflow names the workflow the event starts' });
  const attached = attachingAssistant(body);
  if ('error' in attached) return respond(event, 400, { code: 'TRIGGER_INVALID', error: attached.error });
  const { assistant } = attached;
  // A PATTERN TYPE'S TRIGGER (DESIGN-EVENT-TARGETS 11.2) runs in the conversation the type's pattern names for the event: its
  // rule is a watch rule marked with the pattern kind, and reads the key only where the pattern names `{key}`.
  // A TRIGGER WHOSE EVENT NAMES ITS CONVERSATION (DESIGN-EVENT-TARGETS 11.3), from a connector fact, verified against the
  // receiver's record before anything runs there.
  const named = body.target === 'named';
  const byPattern = !named && isPatternType(typeKey);
  // A HAND-OFF FROM ANOTHER TEAM (DESIGN-PROCESSES section 12): in a conversation per process, a pattern type's, or in the
  // conversation watching the process. The kind and the key path are fixed here, never taken from the request.
  const handoff = await handoffChoice(body);
  if (handoff && 'error' in handoff) return respond(event, handoff.status, { code: handoff.code, error: handoff.error });
  if (handoff && named) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'a hand-off runs in a new conversation, a conversation per process or the conversation watching the process' });
  if (!handoff && body.kind === PROCESS_WATCH_KIND) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'the process kind is the platform\'s own, attached as a hand-off' });
  if (handoff && byPattern && CONVERSATION_TYPES[typeKey]!.conversationPattern !== PROCESS_CONVERSATION_PATTERN) {
    return respond(event, 409, { code: 'HANDOFF_PATTERN', error: `a hand-off reaches a conversation per process only where the type's pattern is ${PROCESS_CONVERSATION_PATTERN}` });
  }
  // A HAND-OFF NAMES NO PERSON, so its pattern conversation is opened for the type's one-holder lead role, which it must declare.
  if (handoff && byPattern && !teamRoomLeadRole(typeKey)) return respond(event, 409, { code: 'HANDOFF_NO_LEAD_ROLE', error: 'the type declares no role with one holder to open a hand-off\'s conversation for' });
  const variables = byPattern ? patternVariables(CONVERSATION_TYPES[typeKey]!.conversationPattern!) ?? [] : [];
  // A PATTERN CONVERSATION IS OPENED FOR SOMEONE: the person its pattern names, or the type's one-holder lead role. A type with
  // neither could never be opened, so its trigger is refused here rather than refused on every event.
  if (!handoff && byPattern && !variables.includes('person') && !teamRoomLeadRole(typeKey)) {
    return respond(event, 409, { code: 'PATTERN_NO_LEAD_ROLE', error: 'the type\'s pattern names no person and the type declares no role with one holder to open its conversation for' });
  }
  const usesKey = variables.includes('key');
  const kind = named ? NAMED_WATCH_KIND : byPattern ? PATTERN_WATCH_KIND : handoff ? PROCESS_WATCH_KIND : typeof body.kind === 'string' ? body.kind : '';
  const keyPath = handoff ? HANDOFF_KEY_PATH : named || (byPattern && !usesKey) ? '$.resources[0]' : typeof body.keyPath === 'string' ? body.keyPath : '';
  // A PERSON, OR A CONVERSATION THE EVENT NAMES, IS TRUSTED ONLY FROM A CONNECTOR FACT, whose receiver records them.
  const needsFact = named || variables.includes('person');
  if (!REF_KIND.test(kind)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'kind names the kind of key the conversation watches' });
  if (!isRefPath(keyPath)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'keyPath is a plain path under $.detail. or $.resources[' });
  const pattern = handoff ? handoff.pattern : await patternOfChoice(body);
  if ('error' in pattern && typeof pattern.error === 'string') return respond(event, 400, { code: 'TRIGGER_INVALID', error: pattern.error });
  const p = pattern as EventPattern;
  if (!handoff && namesAProcessSource(p)) return respond(event, 400, PROCESS_SOURCE_ONLY_AS_HANDOFF);
  // ONE SOURCE AND ONE DETAIL TYPE: the router compares the event with them, so a rule that names several could not be checked.
  if (p.source.length !== 1 || p['detail-type'].length !== 1) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'a watch trigger matches exactly one source and one detail type' });
  // THE KIND BELONGS TO ONE SOURCE, the one this type's openers record it from, so another source cannot reach these conversations.
  const kindSource = watchedKindSources(CONVERSATION_TYPES).get(kind);
  const recorded = (CONVERSATION_TYPES[typeKey]?.openedBy ?? []).some((o) => o.watches?.kind === kind);
  if (needsFact && p.source[0] !== CONNECTOR_FACT_SOURCE) {
    return respond(event, 409, { code: 'NEEDS_A_CONNECTOR_FACT', error: `a person or a named conversation is trusted only from a connector fact (${CONNECTOR_FACT_SOURCE}), whose receiver records them` });
  }
  if (!byPattern && !named && !handoff && (!kindSource || !recorded)) return respond(event, 409, { code: 'NO_CONVERSATION_WATCHES_KIND', error: `no opener of "${typeKey}" records a "${kind}" key, so no conversation would receive the event` });
  if (!byPattern && !named && !handoff && kindSource !== `default|${p.source[0]}`) return respond(event, 409, { code: 'KIND_OF_ANOTHER_SOURCE', error: `a "${kind}" key belongs to the source ${(kindSource ?? '').split('|')[1]}` });
  // A PLATFORM SOURCE'S EVENTS MATCH THIS DEPLOYMENT'S INSTANCE, as the kind's opener does (`matchInstance`), so another
  // deployment in the account never reaches this one's conversations. The instance is fixed here, never taken from the caller.
  if (!handoff && (CONVERSATION_TYPES[typeKey]?.openedBy ?? []).some((o) => o.watches?.kind === kind && o.matchInstance)) {
    if (!INSTANCE_NAME) return respond(event, 503, { error: 'this deployment names no instance, so a platform event cannot be matched to it' });
    p.detail = { ...(p.detail ?? {}), instance: [INSTANCE_NAME] };
  }
  const policy = await readEventPolicy();
  if (!policy.enabled) return respond(event, 409, { code: 'TRIGGERS_OFF', error: 'event triggers are switched off in this deployment\'s policy' });
  if (!patternAllowed(policy, p)) return respond(event, 409, { code: 'EVENT_TYPE_NOT_ALLOWED', error: 'this deployment\'s policy does not allow that event type' });
  const id = watchRuleId({ typeKey, workflow, pattern: p, kind, keyPath, assistant });
  const existing = await watchTriggersOf(typeKey, classification);
  // AN EDIT NAMES THE WATCH TRIGGER IT REPLACES: one of this type's, for the same workflow, attached for the same assistant.
  const replaces = body.replaces === undefined ? undefined : typeof body.replaces === 'string' && RULE_ID.test(body.replaces) ? body.replaces : null;
  if (replaces === null) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'replaces is the id of the trigger the edit replaces' });
  const old = replaces ? existing.find((t) => t.id === replaces) : undefined;
  if (replaces && (!old || old.workflow !== workflow)) return respond(event, 404, { code: 'TRIGGER_NOT_FOUND', error: 'this type holds no such watch trigger for this workflow' });
  if (old && otherAssistantsRule(old.assistant, assistant)) return respond(event, 409, OTHER_ASSISTANT);
  if (!existing.some((t) => t.id === id)) {
    // A REPLACEMENT IS COUNTED ONCE: the trigger it replaces leaves as it arrives.
    const replacing = replaces ? 1 : 0;
    if (existing.length - replacing >= (policy.maxWatchTriggersPerType ?? 0)) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the type holds as many watch triggers as the policy allows' });
    if (await triggerCount() - replacing >= policy.maxTriggers) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the deployment holds as many trigger rules as the policy allows' });
  }
  const relay = (process.env.EVENT_TRIGGER_RELAY_NAME_PATTERN ?? '').replace('{classification}', classification);
  const relayArn = `arn:aws:lambda:${process.env.AWS_REGION}:${event.requestContext.accountId}:function:${relay}`;
  const Name = watchRuleName(RULE_PREFIX, classification, id);
  // AN EDIT OF AN EDIT KEYS ITS RUNS BY THE FIRST RULE OF THE CHAIN, which the replaced rule records (`RUN_ROOT_TAG`).
  const runRoot = replaces ? editRunRoot(replaces, old?.supersedes, RULE_ID) : undefined;
  const supersedes = runRoot && runRoot !== id ? runRoot : undefined;
  const input = watchTargetInput({ rule: id, keyPath, ...(supersedes ? { supersedes } : {}), ...(needsFact ? { connector: true } : {}), ...(handoff ? { handoff: handoff.attached } : {}) });
  if (input.InputTemplate.length > MAX_INPUT_TEMPLATE) return respond(event, 409, { code: 'HANDOFF_TOO_LARGE', error: 'the hand-off declares more than a rule\'s input can record' });
  const rule = await eventbridge.send(new PutRuleCommand({
    Name,
    ...(handoff ? { EventBusName: handoff.bus } : {}),
    Description: `Starts ${workflow} in the ${typeKey} conversation that watches the event's ${kind} key at ${classification}`,
    EventPattern: JSON.stringify(p),
    State: 'ENABLED',
    Tags: watchRuleTags({ classification, workflow, typeKey, kind, source: p.source[0], detailType: p['detail-type'][0], assistant, ...(supersedes ? { supersedes } : {}) }),
  }));
  await eventbridge.send(new PutTargetsCommand({
    Rule: Name,
    ...(handoff ? { EventBusName: handoff.bus } : {}),
    Targets: [{ Id: 'router', Arn: relayArn, InputTransformer: input, RetryPolicy: { MaximumRetryAttempts: policy.retryAttempts, MaximumEventAgeInSeconds: policy.maxEventAgeSeconds } }],
  }));
  // THE TRIGGER IT REPLACED GOES ONCE THE NEW ONE STANDS; an edit that kept every part is the same rule, rewritten above.
  if (replaces && replaces !== id) await deleteTriggerRule(watchRuleName(RULE_PREFIX, classification, replaces));
  return respond(event, 200, { id, ruleArn: rule.RuleArn, target: 'watched', kind, keyPath, pattern: p, ...(assistant ? { assistant } : {}), ...(replaces ? { replaced: replaces } : {}) });
}
