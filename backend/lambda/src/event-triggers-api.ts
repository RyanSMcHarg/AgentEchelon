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
import { DeleteRuleCommand, DescribeRuleCommand, EventBridgeClient, ListRulesCommand, ListTagsForResourceCommand, ListTargetsByRuleCommand, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand } from '@aws-sdk/client-eventbridge';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { eventPolicyErrors, forgetEventPolicy, patternAllowed, readEventPolicy } from './lib/event-policy.js';
import { DescribeSchemaCommand, ListSchemasCommand, SchemasClient } from '@aws-sdk/client-schemas';
import { TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { InvocationType, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { requireAdmin } from './lib/auth.js';
import { readChannelTags } from './lib/channel-classification.js';
import { DEV_ORIGIN, originsFrom, requestOrigin, responder } from './lib/http-response.js';
import {
  EVENT_RULE_TAG_PREFIX, describeSchema, patternFor, patternFromRule, teamRoomArn, triggerRuleId, triggerRuleName, triggerTargetInput, type EventPattern, eventTypeMatches,
  ASSISTANT_HANDLE, WATCH_TAG, watchRuleId, watchRuleName, watchRuleTags, watchTargetInput } from './lib/event-triggers.js';
import { REF_KIND, isRefPath, watchedKindSources } from '../../lib/config/event-openers';
import { CONVERSATION_TYPES, classificationAllowedForType, eventReachesType, isTeamRoomType } from '../../lib/config/conversation-types';
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
const TRIGGERS_ROUTE = '/admin/event-triggers/{typeKey}/{classification}';
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
  try {
    const res = await eventbridge.send(new RemoveTargetsCommand({ Rule, Ids: ['router'] }));
    if ((res?.FailedEntryCount ?? 0) > 0) throw new Error(`the target of ${Rule} was not removed: ${res.FailedEntries?.[0]?.ErrorCode ?? 'unknown'}`);
  } catch (err) {
    if (!ruleIsGone(err)) throw err;
  }
  try {
    await eventbridge.send(new DeleteRuleCommand({ Name: Rule }));
  } catch (err) {
    if (!ruleIsGone(err)) throw err;
  }
}

async function triggerCount(): Promise<number> {
  let n = 0;
  let token: string | undefined;
  do {
    const res = await eventbridge.send(new ListRulesCommand({ NamePrefix: RULE_PREFIX, NextToken: token, Limit: 100 }));
    n += (res.Rules ?? []).filter((r) => TRIGGER_RULE.test(r.Name ?? '')).length;
    token = res.NextToken;
  } while (token);
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
  const schema = str('eventType');
  if (schema) {
    if (!NAME.test(schema)) return { error: 'eventType is a schema name' };
    const type = await typeOfSchemaNamed(schema);
    if (!type) return { error: 'no schema of that name in the registry; send the event once, with discovery on, or paste a rule instead' };
    return patternFor({ ...type, ...(str('resourceArn') ? { resourceArn: str('resourceArn') } : {}) });
  }
  if (str('resourceArn')) return patternFor({ resourceArn: str('resourceArn') });
  return { error: 'name an eventType, a resourceArn or a rule' };
}

/** One watch rule this classification holds for a type, as the console lists it: its binding from its tags, its key path from its target. */
interface WatchTrigger { id: string; workflow: string; ruleArn: string | null; pattern: string | null; kind: string; keyPath: string | null; assistant?: string }

/**
 * One listed rule as this type's watch trigger, or undefined when it is another's or is gone before its tags are read. A tag
 * read that fails for any other reason throws, so a list or a count is never short by a rule that still runs.
 */
async function watchTriggerFrom(r: { Name?: string; Arn?: string; EventPattern?: string }, namePrefix: string, typeKey: string, classification: string): Promise<WatchTrigger | undefined> {
  const id = (r.Name ?? '').slice(namePrefix.length);
  if (!RULE_ID.test(id) || !r.Arn) return undefined;
  const tagged = await ruleRead(eventbridge.send(new ListTagsForResourceCommand({ ResourceARN: r.Arn })));
  if (!tagged) return undefined;
  const tags = Object.fromEntries((tagged.Tags ?? []).map((t) => [t.Key, t.Value]));
  if (tags[WATCH_TAG.type] !== typeKey || tags[WATCH_TAG.classification] !== classification) return undefined;
  const target = (await eventbridge.send(new ListTargetsByRuleCommand({ Rule: r.Name })).catch(() => undefined))?.Targets?.[0];
  return { id, workflow: tags[WATCH_TAG.workflow] ?? '', ruleArn: r.Arn, pattern: r.EventPattern ?? null, kind: tags[WATCH_TAG.kind] ?? '', keyPath: target?.InputTransformer?.InputPathsMap?.key ?? null, ...(tags[WATCH_TAG.assistant] ? { assistant: tags[WATCH_TAG.assistant] } : {}) };
}

/** One watch rule by its id, read by itself: this type's at this classification, or undefined. */
async function watchTriggerById(typeKey: string, classification: string, id: string): Promise<WatchTrigger | undefined> {
  const Name = watchRuleName(RULE_PREFIX, classification, id);
  const rule = await eventbridge.send(new DescribeRuleCommand({ Name })).catch(() => undefined);
  return rule?.Arn ? watchTriggerFrom({ Name, Arn: rule.Arn, EventPattern: rule.EventPattern }, watchRuleName(RULE_PREFIX, classification, ''), typeKey, classification) : undefined;
}

/** The watch rules this classification holds for a type (DESIGN-EVENT-TARGETS section 7), read from the rules themselves. */
async function watchTriggersOf(typeKey: string, classification: string): Promise<WatchTrigger[]> {
  const namePrefix = watchRuleName(RULE_PREFIX, classification, '');
  const out: WatchTrigger[] = [];
  let token: string | undefined;
  do {
    const res = await eventbridge.send(new ListRulesCommand({ NamePrefix: namePrefix, NextToken: token, Limit: 100 }));
    const found = await Promise.all((res.Rules ?? []).map((r) => watchTriggerFrom(r, namePrefix, typeKey, classification)));
    out.push(...found.filter((t): t is WatchTrigger => !!t));
    token = res.NextToken;
  } while (token);
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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
    if (route === '/admin/event-types') {
      if (event.httpMethod !== 'GET') return respond(event, 405, { error: 'method not allowed' });
      // ONE EVENT TYPE DESCRIBED (DESIGN-EVENT-TARGETS section 7): what it carries, so the form asks only for what it does not.
      const describe = event.queryStringParameters?.describe;
      if (describe !== undefined) {
        if (!NAME.test(describe)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'describe names a schema' });
        const described = await describedSchemaNamed(describe);
        return described ? respond(event, 200, { eventType: { name: describe, ...described } }) : respond(event, 404, { code: 'NO_SUCH_EVENT_TYPE', error: 'no schema of that name in the registry' });
      }
      return respond(event, 200, { eventTypes: await listEventTypes(event.queryStringParameters?.q ?? '') });
    }
    if (route !== TRIGGERS_ROUTE && route !== REMOVE_ROUTE) return respond(event, 404, { error: 'not found' });
    const typeKey = event.pathParameters?.typeKey ?? '';
    const classification = event.pathParameters?.classification ?? '';
    // ONE RULE FOR WHICH TYPES AN EVENT REACHES, the one the workflow validator and the console read (`eventReachesType`).
    if (!eventReachesType(typeKey) || !classificationAllowedForType(typeKey, classification)) {
      return respond(event, 400, { code: 'NOT_A_TRIGGER_TYPE', error: 'a trigger runs in a conversation type an event reaches (a team conversation type, or one whose opener watches a key), at a classification it permits' });
    }
    // A TYPE THAT IS NOT A TEAM ROOM'S RECEIVES AN EVENT IN THE CONVERSATION THAT WATCHES ITS KEY (DESIGN-EVENT-TARGETS).
    if (!isTeamRoomType(typeKey)) return await watchedTarget(event, route, typeKey, classification);
    const channelArn = teamRoomArn(APP_INSTANCE_ARN, typeKey, classification);
    const prefix = EVENT_RULE_TAG_PREFIX;

    if (route === TRIGGERS_ROUTE && event.httpMethod === 'GET') {
      const tags = await readChannelTags(chime as never, channelArn).catch(() => ({} as Record<string, string>));
      const triggers = await Promise.all(Object.entries(tags).filter(([k]) => k.startsWith(prefix)).map(async ([k, workflow]) => {
        const id = k.slice(prefix.length);
        const rule = await ruleRead(eventbridge.send(new DescribeRuleCommand({ Name: triggerRuleName(RULE_PREFIX, classification, id) })));
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
      const rule = await ruleRead(eventbridge.send(new DescribeRuleCommand({ Name: Rule })));
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
    const pattern = await patternOfChoice(body);
    if ('error' in pattern && typeof pattern.error === 'string') return respond(event, 400, { code: 'TRIGGER_INVALID', error: pattern.error });
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
    if (Object.keys(roomTags).filter((k) => k.startsWith(prefix)).length >= policy.maxTriggersPerRoom) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the conversation holds as many triggers as the policy allows' });
    if (await triggerCount() >= policy.maxTriggers) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the deployment holds as many trigger rules as the policy allows' });
    const relay = (process.env.EVENT_TRIGGER_RELAY_NAME_PATTERN ?? '').replace('{classification}', classification);
    const relayArn = `arn:aws:lambda:${process.env.AWS_REGION}:${event.requestContext.accountId}:function:${relay}`;
    const id = triggerRuleId(channelArn, workflow, pattern as EventPattern, assistant);
    const Name = triggerRuleName(RULE_PREFIX, classification, id);
    const rule = await eventbridge.send(new PutRuleCommand({
      Name,
      Description: `Starts ${workflow} in the ${typeKey} team conversation at ${classification}`,
      EventPattern: JSON.stringify(pattern),
      State: 'ENABLED',
      Tags: [{ Key: 'classification', Value: classification }, { Key: 'team-room', Value: typeKey }, { Key: 'workflow', Value: workflow }, ...(assistant ? [{ Key: 'assistant', Value: assistant }] : [])],
    }));
    // NOTHING IS LEFT HALF-WRITTEN: a rule this attach made, whose target or room tag could not be written, is removed again, so
    // the deployment never holds a rule its room does not name. A trigger the room already named is left as it runs.
    const named = roomTags[`${prefix}${id}`] !== undefined;
    try {
      await eventbridge.send(new PutTargetsCommand({
        Rule: Name,
        Targets: [{ Id: 'router', Arn: relayArn, InputTransformer: triggerTargetInput({ rule: id, channelArn, workflow, assistant }), RetryPolicy: { MaximumRetryAttempts: policy.retryAttempts, MaximumEventAgeInSeconds: policy.maxEventAgeSeconds } }],
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
    return respond(event, 200, { id, ruleArn: rule.RuleArn, channelArn, pattern, ...(assistant ? { assistant } : {}) });
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
  if (body.target !== 'watched') return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'a type that is not a team conversation type runs its trigger in the conversation that watches the event\'s key (target: watched)' });
  const workflow = typeof body.workflow === 'string' ? body.workflow : '';
  if (!WORKFLOW.test(workflow)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'workflow names the workflow the event starts' });
  const attached = attachingAssistant(body);
  if ('error' in attached) return respond(event, 400, { code: 'TRIGGER_INVALID', error: attached.error });
  const { assistant } = attached;
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const keyPath = typeof body.keyPath === 'string' ? body.keyPath : '';
  if (!REF_KIND.test(kind)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'kind names the kind of key the conversation watches' });
  if (!isRefPath(keyPath)) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'keyPath is a plain path under $.detail. or $.resources[' });
  const pattern = await patternOfChoice(body);
  if ('error' in pattern && typeof pattern.error === 'string') return respond(event, 400, { code: 'TRIGGER_INVALID', error: pattern.error });
  const p = pattern as EventPattern;
  // ONE SOURCE AND ONE DETAIL TYPE: the router compares the event with them, so a rule that names several could not be checked.
  if (p.source.length !== 1 || p['detail-type'].length !== 1) return respond(event, 400, { code: 'TRIGGER_INVALID', error: 'a watch trigger matches exactly one source and one detail type' });
  // THE KIND BELONGS TO ONE SOURCE, the one this type's openers record it from, so another source cannot reach these conversations.
  const kindSource = watchedKindSources(CONVERSATION_TYPES).get(kind);
  const recorded = (CONVERSATION_TYPES[typeKey]?.openedBy ?? []).some((o) => o.watches?.kind === kind);
  if (!kindSource || !recorded) return respond(event, 409, { code: 'NO_CONVERSATION_WATCHES_KIND', error: `no opener of "${typeKey}" records a "${kind}" key, so no conversation would receive the event` });
  if (kindSource !== `default|${p.source[0]}`) return respond(event, 409, { code: 'KIND_OF_ANOTHER_SOURCE', error: `a "${kind}" key belongs to the source ${kindSource.split('|')[1]}` });
  // A PLATFORM SOURCE'S EVENTS MATCH THIS DEPLOYMENT'S INSTANCE, as the kind's opener does (`matchInstance`), so another
  // deployment in the account never reaches this one's conversations. The instance is fixed here, never taken from the caller.
  if ((CONVERSATION_TYPES[typeKey]?.openedBy ?? []).some((o) => o.watches?.kind === kind && o.matchInstance)) {
    if (!INSTANCE_NAME) return respond(event, 503, { error: 'this deployment names no instance, so a platform event cannot be matched to it' });
    p.detail = { ...(p.detail ?? {}), instance: [INSTANCE_NAME] };
  }
  const policy = await readEventPolicy();
  if (!policy.enabled) return respond(event, 409, { code: 'TRIGGERS_OFF', error: 'event triggers are switched off in this deployment\'s policy' });
  if (!patternAllowed(policy, p)) return respond(event, 409, { code: 'EVENT_TYPE_NOT_ALLOWED', error: 'this deployment\'s policy does not allow that event type' });
  const id = watchRuleId({ typeKey, workflow, pattern: p, kind, keyPath, assistant });
  const existing = await watchTriggersOf(typeKey, classification);
  if (!existing.some((t) => t.id === id)) {
    if (existing.length >= (policy.maxWatchTriggersPerType ?? 0)) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the type holds as many watch triggers as the policy allows' });
    if (await triggerCount() >= policy.maxTriggers) return respond(event, 409, { code: 'TOO_MANY_TRIGGERS', error: 'the deployment holds as many trigger rules as the policy allows' });
  }
  const relay = (process.env.EVENT_TRIGGER_RELAY_NAME_PATTERN ?? '').replace('{classification}', classification);
  const relayArn = `arn:aws:lambda:${process.env.AWS_REGION}:${event.requestContext.accountId}:function:${relay}`;
  const Name = watchRuleName(RULE_PREFIX, classification, id);
  const rule = await eventbridge.send(new PutRuleCommand({
    Name,
    Description: `Starts ${workflow} in the ${typeKey} conversation that watches the event's ${kind} key at ${classification}`,
    EventPattern: JSON.stringify(p),
    State: 'ENABLED',
    Tags: watchRuleTags({ classification, workflow, typeKey, kind, source: p.source[0], detailType: p['detail-type'][0], assistant }),
  }));
  await eventbridge.send(new PutTargetsCommand({
    Rule: Name,
    Targets: [{ Id: 'router', Arn: relayArn, InputTransformer: watchTargetInput({ rule: id, keyPath }), RetryPolicy: { MaximumRetryAttempts: policy.retryAttempts, MaximumEventAgeInSeconds: policy.maxEventAgeSeconds } }],
  }));
  return respond(event, 200, { id, ruleArn: rule.RuleArn, target: 'watched', kind, keyPath, pattern: p, ...(assistant ? { assistant } : {}) });
}
