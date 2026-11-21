/**
 * AN AWS EVENT STARTS A WORKFLOW IN A TEAM'S ROOM (SPEC-WORKFLOWS-AND-TASKS WT121). Every part is an AWS resource named by convention,
 * so the flow reads off the resources themselves:
 *
 *   EventBridge rule `<prefix>-<classification>-trigger-<id>` (scoped to `source` and `detail-type`, one target: this
 *   classification's relay to its router, with a fixed input naming the room)
 *     -> team room, the Amazon Chime SDK channel `team-<type>-<classification>`, tagged `team-room` and `event-rule:<id>`
 *     -> the workflow the rule names, which declares that type.
 *
 * A trigger is chosen as an event type (a schema), a resource's ARN, or an existing rule, whose pattern is copied so that rule
 * stays its owner's. All three end as one rule of the platform's own. What the rule hands over is references: the event's type,
 * its time and its first resource, never its `detail`.
 */
import { contentHash12 } from './canonical-json.js';
import { ALARM_STATE_CHANGE } from '../../../lib/config/event-openers.js';
import { handoffDetailType, processSource, type AttachedHandoff, type HandoffField } from './event-workflow.js';

/** The tag on a team room saying which type's room it is. */
export const TEAM_ROOM_TAG = 'team-room';
/** The prefix of the tag on a team room naming a rule that starts a workflow in it; its value is the workflow. */
export const EVENT_RULE_TAG_PREFIX = 'event-rule:';
/** One run per rule per this many minutes, so a storm of events is one run and opens one child. */
export const EVENT_TRIGGER_WINDOW_MINUTES = 15;

/** The one room of a type at a classification: the same id every time, so the room is created once and always found. */
export const teamRoomChannelId = (typeKey: string, classification: string): string => `team-${typeKey}-${classification}`;
export const teamRoomArn = (appInstanceArn: string, typeKey: string, classification: string): string =>
  `${appInstanceArn}/channel/${teamRoomChannelId(typeKey, classification)}`;

/**
 * The window an event's time falls in, which its run is keyed on, taken no later than `now`: a time a producer dates ahead
 * keys the window it arrived in, never one of its own. Undefined for a time that cannot be read.
 */
export function eventTriggerWindow(at: unknown, now: number = Date.now()): number | undefined {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? Math.floor(Math.min(ms, now) / (EVENT_TRIGGER_WINDOW_MINUTES * 60_000)) : undefined;
}

export interface EventPattern {
  source: string[];
  'detail-type': string[];
  resources?: string[];
  detail?: Record<string, unknown>;
  [field: string]: unknown;
}

const ALARM_ARN = /^arn:aws[a-z-]*:cloudwatch:[a-z0-9-]+:\d{12}:alarm:.+$/;
const ANY_ARN = /^arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:.+$/;

/**
 * THE PATTERN A CHOICE MEANS. An event type alone, narrowed to one resource where an ARN is given. An alarm's ARN names its own
 * event type, and matches its entering ALARM only, since returning to OK is no reason to open a room.
 */
export function patternFor(input: { source?: string; detailType?: string; resourceArn?: string }): EventPattern | { error: string } {
  const arn = input.resourceArn;
  if (arn !== undefined && !ANY_ARN.test(arn)) return { error: 'resourceArn is an ARN' };
  if (arn && ALARM_ARN.test(arn) && !input.source) {
    return alarmEntersAlarmOnly({ source: ['aws.cloudwatch'], 'detail-type': [ALARM_STATE_CHANGE], resources: [arn] });
  }
  if (!input.source || !input.detailType) return { error: 'an event type names its source and detail type; only an alarm\'s ARN implies one' };
  return alarmEntersAlarmOnly({ source: [input.source], 'detail-type': [input.detailType], ...(arn ? { resources: [arn] } : {}) });
}


/**
 * A PATTERN ON AN ALARM'S STATE CHANGE MATCHES ITS ENTERING ALARM, and nothing else, whichever way it was chosen (an alarm's ARN,
 * the event type, or a copied rule): returning to OK or to INSUFFICIENT_DATA is no reason to open a room. No deployment changes it.
 */
export function alarmEntersAlarmOnly(pattern: EventPattern): EventPattern {
  if (!pattern['detail-type'].includes(ALARM_STATE_CHANGE)) return pattern;
  const detail = pattern.detail && typeof pattern.detail === 'object' ? pattern.detail : {};
  const state = detail.state && typeof detail.state === 'object' ? detail.state as Record<string, unknown> : {};
  return { ...pattern, detail: { ...detail, state: { ...state, value: ['ALARM'] } } };
}

/** The pattern of an existing rule, copied, or why it cannot be: a precise pattern names one source and detail type at least. */
export function patternFromRule(raw: unknown): EventPattern | { error: string } {
  if (typeof raw !== 'string' || !raw) return { error: 'the rule has no event pattern; a scheduled rule starts no workflow' };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { return { error: 'the rule\'s event pattern is not JSON' }; }
  const named = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
  if (!named(parsed.source) || !named(parsed['detail-type'])) return { error: 'the rule\'s pattern names no exact source and detail type, so it could match events nobody meant' };
  return alarmEntersAlarmOnly(parsed as EventPattern);
}

/**
 * The event type a schema describes, from the extensions the schema registry writes on it: on the `AWSEvent` schema of an
 * OpenAPI document (how the registry writes AWS's own and discovered schemas), or at the document's top level.
 */
export function eventTypeOfSchema(content: unknown): { source: string; detailType: string } | undefined {
  const d = describeSchema(content);
  return d ? { source: d.source, detailType: d.detailType } : undefined;
}

/** How deep a schema's detail is read for the fields an event carries. */
const SCHEMA_DEPTH = 4;
/** The most fields a schema's description lists. */
const SCHEMA_FIELDS = 200;

/**
 * WHAT AN EVENT TYPE CARRIES, read from its schema (DESIGN-EVENT-TARGETS section 7): its source, its detail type, and the plain
 * paths to each scalar field of its detail, so the console offers a key path from what the event declares rather than a guess.
 */
export function describeSchema(content: unknown): { source: string; detailType: string; detailPaths: string[] } | undefined {
  let doc: Record<string, any>;
  try { doc = JSON.parse(String(content)) as Record<string, any>; } catch { return undefined; }
  const schemas = (doc?.components?.schemas ?? {}) as Record<string, any>;
  const event = schemas.AWSEvent ?? {};
  const source = event['x-amazon-events-source'] ?? doc['x-amazon-events-source'];
  const detailType = event['x-amazon-events-detail-type'] ?? doc['x-amazon-events-detail-type'];
  if (typeof source !== 'string' || typeof detailType !== 'string') return undefined;
  const resolve = (node: any): any => {
    const ref = typeof node?.$ref === 'string' ? node.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1] : undefined;
    return ref ? schemas[ref] : node;
  };
  const paths: string[] = [];
  const walk = (node: any, at: string, depth: number) => {
    const n = resolve(node);
    if (!n || paths.length >= SCHEMA_FIELDS) return;
    if (n.type === 'object' && n.properties && depth < SCHEMA_DEPTH) {
      for (const [name, child] of Object.entries(n.properties as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_-]+$/.test(name)) walk(child, `${at}.${name}`, depth + 1);
      }
    } else if (['string', 'number', 'integer'].includes(n.type)) paths.push(at);
  };
  walk(event.properties?.detail, '$.detail', 0);
  return { source, detailType, detailPaths: paths };
}

/**
 * The rule's short id: the same choice in the same room is the same rule, so choosing again changes nothing. The same workflow
 * attached for another assistant is another rule, since another version runs it.
 */
export const triggerRuleId = (channelArn: string, workflow: string, pattern: EventPattern, assistant?: string): string =>
  contentHash12({ channelArn, workflow, pattern, ...(assistant ? { assistant } : {}) });

export const triggerRuleName = (prefix: string, classification: string, id: string): string => `${prefix}${classification}-trigger-${id}`;

/**
 * The rule's one target's input: the room, the workflow and the assistant it was attached for fixed at creation, and the event's
 * references read from the event. The assistant's version runs the workflow (`workflowOwnerOf`).
 */
export function triggerTargetInput(args: {
  rule: string; channelArn: string; workflow: string; assistant?: string;
  /** The trigger an edit replaced: its runs are keyed by that rule, so one event matched by both during the swap starts one run. */
  supersedes?: string;
  /** A hand-off's trigger: the declaration as it stood at attach, which the receiving router checks every event against. */
  handoff?: AttachedHandoff;
}): { InputPathsMap: Record<string, string>; InputTemplate: string } {
  const assistant = (args.assistant ? `"assistant":${JSON.stringify(args.assistant)},` : '') + (args.supersedes ? `"supersedes":${JSON.stringify(args.supersedes)},` : '');
  return {
    InputPathsMap: { at: '$.time', source: '$.source', detailType: '$.detail-type', resource: '$.resources[0]', ...(args.handoff ? HANDOFF_PATHS : {}) },
    InputTemplate: `{"aeRuleEvent":{"rule":${JSON.stringify(args.rule)},"channelArn":${JSON.stringify(args.channelArn)},"workflow":${JSON.stringify(args.workflow)},${assistant}"at":<at>,"source":<source>,"detailType":<detailType>,"resource":<resource>${handoffInput(args.handoff)}}}`,
  };
}

// ── A HAND-OFF'S RULE (DESIGN-PROCESSES sections 4.2 and 12) ─────────────────────────────────────────────────────────

/** The detail paths a hand-off's rule hands on: the process, the hand-off and its fields. Nothing else of the detail. */
const HANDOFF_PATHS = { processId: '$.detail.processId', process: '$.detail.process', handoff: '$.detail.handoff', fields: '$.detail.fields' };

/** The hand-off part of a rule's input: the declaration as it stood at attach, fixed, and the event's hand-off read from it. */
function handoffInput(attached: AttachedHandoff | undefined): string {
  return attached ? `,"handoff":{"attached":${JSON.stringify(attached)},"processId":<processId>,"process":<process>,"handoff":<handoff>,"fields":<fields>}` : '';
}

/** The longest input template EventBridge accepts on a target: a declaration that would not fit is refused at attach. */
export const MAX_INPUT_TEMPLATE = 8192;

/** Where a hand-off's key is read: always the process id, fixed by the trigger service and never taken from a request. */
export const HANDOFF_KEY_PATH = '$.detail.processId';

/**
 * THE PATTERN OF AN ATTACHED HAND-OFF: the sending classification's exact source and the exact `detail-type`, never a prefix
 * or a wildcard, on this deployment's instance.
 */
export function handoffPattern(sender: string, process: string, name: string, instance: string): EventPattern {
  return { source: [processSource(sender)], 'detail-type': [handoffDetailType(process, name)], detail: { instance: [instance] } };
}

/** The declaration a receiving team attaches: the sender's source and `detail-type`, and its declared fields as they stand. */
export function attachedHandoffOf(sender: string, process: string, name: string, fields: Record<string, HandoffField>): AttachedHandoff {
  return { source: processSource(sender), detailType: handoffDetailType(process, name), fields };
}

/**
 * AN EVENT TYPE A SEARCH FINDS: every word of the query appears in its schema name, case, spaces and punctuation aside, so
 * "alarm state" finds `aws.cloudwatch@CloudWatchAlarmStateChange`. An empty query finds every type.
 */
export function eventTypeMatches(schemaName: string, query: string): boolean {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = flat(schemaName);
  return query.split(/[^A-Za-z0-9]+/).map(flat).filter(Boolean).every((w) => name.includes(w));
}

// ── THE WATCHED CONVERSATION (DESIGN-EVENT-TARGETS section 4) ──────────────────────────────────────────────────────────
//
// A watch trigger has no single room to tag, so its rule carries its binding as tags, which only an admin's attach
// writes. The router reads them from the rule whose ARN it builds from the rule id and its own classification.

/** A handle as the assignment records spell it: what a trigger records for the assistant it was attached for. */
export const ASSISTANT_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A trigger rule's id: twelve hex characters, the same for a team-room rule and a watch rule. */
export const TRIGGER_RULE_ID = /^[a-f0-9]{12}$/;

/** The tags a watch rule carries: the binding the router reads before anything runs. */
export const WATCH_TAG = Object.freeze({
  classification: 'classification',
  workflow: 'workflow',
  type: 'conversation-type',
  kind: 'watch-kind',
  source: 'source',
  detailType: 'detail-type',
  /** The assistant the trigger was attached for, whose version runs its workflow. */
  assistant: 'assistant',
});

export const watchRuleName = (prefix: string, classification: string, id: string): string => `${prefix}${classification}-watch-${id}`;

/**
 * THE TAG AN EDITED TRIGGER'S RULE CARRIES: the id of the rule its runs are keyed by, the first rule of the chain of edits. An
 * edit of an edit keys its runs by that same root, so however many times a trigger is edited, one event during a swap runs once.
 */
export const RUN_ROOT_TAG = 'supersedes';

/** The run-key root an edit's new rule takes: the replaced rule's own root where it records one, else the replaced rule. */
export function editRunRoot(replaces: string, replacedRoot: string | undefined, ruleId: RegExp): string {
  return typeof replacedRoot === 'string' && ruleId.test(replacedRoot) ? replacedRoot : replaces;
}

/** The watch rule's short id: the same choice for the same type, workflow, key and assistant is the same rule. */
export const watchRuleId = (args: { typeKey: string; workflow: string; pattern: EventPattern; kind: string; keyPath: string; assistant?: string }): string => {
  const { assistant, ...rest } = args;
  return contentHash12({ target: 'watched', ...rest, ...(assistant ? { assistant } : {}) });
};

/** The watch rule's tags. Its pattern names exactly one source and detail type, which the router compares with the event. */
export function watchRuleTags(args: { classification: string; workflow: string; typeKey: string; kind: string; source: string; detailType: string; assistant?: string; supersedes?: string }): Array<{ Key: string; Value: string }> {
  return [
    { Key: WATCH_TAG.classification, Value: args.classification },
    { Key: WATCH_TAG.workflow, Value: args.workflow },
    { Key: WATCH_TAG.type, Value: args.typeKey },
    { Key: WATCH_TAG.kind, Value: args.kind },
    { Key: WATCH_TAG.source, Value: args.source },
    { Key: WATCH_TAG.detailType, Value: args.detailType },
    ...(args.assistant ? [{ Key: WATCH_TAG.assistant, Value: args.assistant }] : []),
    ...(args.supersedes ? [{ Key: RUN_ROOT_TAG, Value: args.supersedes }] : []),
  ];
}

/**
 * The watch rule's one target's input: its id fixed at creation, and the event's references and key read from the event. Every
 * placeholder is unquoted, so EventBridge writes each as the JSON value it is, and the router accepts the key only as an id.
 */
export function watchTargetInput(args: {
  rule: string; keyPath: string; supersedes?: string;
  /** A connector fact's trigger: its connector, its event id, the person it admitted and the conversation it named go with it. */
  connector?: boolean;
  /** A hand-off's trigger: the declaration as it stood at attach, which the receiving router checks every event against. */
  handoff?: AttachedHandoff;
}): { InputPathsMap: Record<string, string>; InputTemplate: string } {
  const supersedes = args.supersedes ? `"supersedes":${JSON.stringify(args.supersedes)},` : '';
  const fact = args.connector ? ',"fact":{"connectorId":<connectorId>,"eventId":<eventId>,"person":<person>,"conversation":<conversation>}' : '';
  return {
    InputPathsMap: {
      at: '$.time', source: '$.source', detailType: '$.detail-type', resource: '$.resources[0]', key: args.keyPath,
      ...(args.connector ? { connectorId: '$.detail.connectorId', eventId: '$.detail.eventId', person: '$.detail.admitted[0].personArn', conversation: '$.detail.conversation' } : {}),
      ...(args.handoff ? HANDOFF_PATHS : {}),
    },
    InputTemplate: `{"aeWatchEvent":{"rule":${JSON.stringify(args.rule)},${supersedes}"at":<at>,"source":<source>,"detailType":<detailType>,"resource":<resource>,"key":<key>${fact}${handoffInput(args.handoff)}}}`,
  };
}
