/**
 * WHAT STARTS A WORKFLOW AND WHERE IT RUNS (SPEC-WORKFLOWS-AND-TASKS WT121, DESIGN-EVENT-TARGETS 11.1): one section of the
 * workflow editor, and the only place either is set.
 *
 * Each configured trigger is one line: its type, its name, an alarm's state, and where it runs. Edit opens the form filled
 * from the line, and Add opens it empty. The form asks three things in order: what starts it (an AgentEchelon event, an
 * EventBridge event or a CloudWatch alarm), which one (listed from the platform or the account as soon as the type is
 * chosen), and where it runs.
 *
 * Two kinds of trigger stand behind one form. An AgentEchelon lifecycle event (and the conversation's watched alarm) is the
 * workflow's own `on`, saved with the version, and "where it runs" is its `types`. A hand-off, a platform event from the event
 * policy, an EventBridge rule and a CloudWatch alarm are attached triggers: a rule in this deployment (`attachEventTrigger`),
 * on a workflow that runs on `event-received` in the one type its target names. An edit of an attached trigger names the
 * trigger it replaces, which the server removes once the new one stands, so the workflow is never without a trigger. An
 * attached trigger edited into the workflow's own event changes only the draft: its rule keeps starting the active version,
 * and stays listed beside the new event, to be removed here once the draft is activated.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@ae/shared';
import { CONNECTOR_FACT_SOURCE, CONVERSATION_TYPES, PROCESS_CONVERSATION_PATTERN, classificationAllowedForType, isPatternType, isTeamRoomType, patternVariables } from '../../../../../../backend/lib/config/conversation-types.ts';
import { groupSourcedRoles } from '../../../../../../backend/lib/config/participant-roles.ts';
import { consoleUrlForArn } from '../../services/awsConsole';
import { useCan } from '../../capabilities';
import { ConfirmAction } from './ConfirmAction';
import { attachEventTrigger, listAccountAlarms, listAccountRules, listDeclaredHandoffs, listEventTriggers, readEventPolicy, removeEventTrigger, type AccountAlarm, type AccountRule, type DeclaredHandoff, type EventTrigger, type EventTriggerChoice } from '../../services/eventTriggerService';
import { CLOUDWATCH_SOURCE, watchedKindSources } from '../../../../../../backend/lib/config/event-openers.ts';
import { MAX_DEADLINE_MINUTES, MIN_DEADLINE_MINUTES, isDeadlineEvent, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

/** Every refusal the trigger routes answer with, each said in the console's own words (`admin.eventTrigger.errors`). */
export const CODED_REFUSALS: readonly string[] = [
  'TRIGGER_INVALID', 'TRIGGER_OTHER_ASSISTANT', 'TRIGGER_THROTTLED', 'TRIGGER_NOT_FOUND', 'TRIGGERS_OFF', 'TOO_MANY_TRIGGERS',
  'EVENT_TYPE_NOT_ALLOWED', 'NOT_A_TRIGGER_TYPE', 'NO_TEAM_ROOM', 'NO_INSTANCE', 'NO_PROCESS_BUS', 'NO_SUCH_HANDOFF',
  'HANDOFF_AMBIGUOUS', 'HANDOFF_ONLY', 'HANDOFF_PATTERN', 'HANDOFF_NO_LEAD_ROLE', 'HANDOFF_TOO_LARGE', 'PATTERN_NO_LEAD_ROLE', 'NAMED_TARGET_TYPE',
  'NEEDS_A_CONNECTOR_FACT', 'NO_CONVERSATION_WATCHES_KIND', 'KIND_OF_ANOTHER_SOURCE', 'LIST_INVALID',
];

/**
 * WHAT A FAILED TRIGGER REQUEST SAYS: a coded refusal its own copy, and any other answer of the service its status in the
 * console's words, so the server's English is never shown. An error that never reached the service keeps its own message.
 */
export function triggerErrorText(e: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!(e instanceof ApiError)) return (e as Error).message;
  const code = (e.body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && CODED_REFUSALS.includes(code) ? t(`admin.eventTrigger.errors.${code}`) : t('admin.eventTrigger.errors.unknown', { status: e.status });
}

/** The role with one holder a pattern conversation is opened for when its event names no person, as the trigger service reads it. */
export const leadRoleOf = (type: string): string | undefined => groupSourcedRoles((k) => k === type).find((r) => r.decl.holders === 'one')?.role;

/** Why the trigger service refuses a pattern type as where an event runs, or undefined where it accepts it. */
export type PatternRefusal = 'notProcessPattern' | 'noLeadRole' | 'needsConnectorFact';
export function patternTargetRefusal(type: string, handoff: boolean, source: string | undefined): PatternRefusal | undefined {
  const pattern = CONVERSATION_TYPES[type]?.conversationPattern ?? '';
  // A HAND-OFF names no person: its conversation is one per process, opened for the type's one-holder role.
  if (handoff) return pattern !== PROCESS_CONVERSATION_PATTERN ? 'notProcessPattern' : leadRoleOf(type) ? undefined : 'noLeadRole';
  // A PERSON IS TRUSTED ONLY FROM A CONNECTOR FACT, whose receiver records them; a pattern without one opens for the lead role.
  if ((patternVariables(pattern) ?? []).includes('person')) return source === CONNECTOR_FACT_SOURCE ? undefined : 'needsConnectorFact';
  return leadRoleOf(type) ? undefined : 'noLeadRole';
}

/** What starts a workflow, the form's first question. */
export type TriggerSource = 'ae' | 'eventbridge' | 'alarm';
/** The platform's admin notices, never a trigger: they reach the admin channel by their own rule. */
const ADMIN_NOTICE_SOURCE = 'ae.alert';
/** Every process source starts so: its events are hand-offs, chosen as a hand-off and never as a platform event. */
const PROCESS_SOURCE_PREFIX = 'ae.process.';
/** Where a hand-off's key is read, fixed by the trigger service: the process id. */
const HANDOFF_KEY_PATH = '$.detail.processId';
/** A pattern that reads no key reads the event's first resource, as the trigger service fixes it. */
const RESOURCE_PATH = '$.resources[0]';
/** The workflow event an attached trigger starts. */
const EVENT_RECEIVED: EventWorkflow['on'] = 'event-received';
/** The CloudWatch alarm the conversation watches, a workflow's own event rather than a rule. */
const WATCHED_ALARM: EventWorkflow['on'] = 'alarm-state-changed';
/** The AgentEchelon lifecycle events a workflow runs on, in the order the form lists them. */
export const LIFECYCLE_EVENTS: ReadonlyArray<EventWorkflow['on']> = ['person-joined', 'conversation-opened', 'assistant-joined', 'invitation-sent', 'invitation-unredeemed'];
/** Every select and input of the form is held to its column (`admin-event-trigger-select`). */
const FITS = 'admin-event-trigger-select';
const SELECT_FIELD = ['select', FITS].join(' ');
const INPUT_FIELD = ['input', FITS].join(' ');
/** A filter narrows a list once this many characters are typed; fewer show the whole list. */
export const FILTER_MIN_CHARS = 3;
/** The default deadline of a deadline event, three days, until the person sets one. */
const DEFAULT_DEADLINE_MINUTES = 3 * 24 * 60;

/**
 * A declared hand-off as the form's choice value: its sending classification, its process, its name and, where it is known,
 * the assistant that declares it, so two assistants declaring one hand-off are two options. The request names the first three.
 */
export const handoffValue = (h: Pick<DeclaredHandoff, 'classification' | 'process' | 'name'> & { assistant?: string }): string =>
  [h.classification, h.process, h.name, ...(h.assistant ? [h.assistant] : [])].join('|');

/** Whether a declared hand-off is the one a choice value names: the same hand-off, and the same assistant where the value names one. */
export function isHandoffOf(value: string, h: DeclaredHandoff): boolean {
  const [classification, process, name, assistant] = value.split('|');
  return h.classification === classification && h.process === process && h.name === name && (!assistant || h.assistant === assistant);
}

const isText = (v: unknown): v is string => typeof v === 'string';

/** The AgentEchelon events a trigger may start on: the policy's allowed types whose source is the platform's, never an admin notice or a hand-off. */
export function platformEventsOf(policy: unknown): Array<{ source: string; detailType: string }> {
  const types = (policy as { allowedEventTypes?: unknown } | null)?.allowedEventTypes;
  return (Array.isArray(types) ? types : [])
    .filter((x): x is { source: string; detailType: string } => isText(x?.source) && isText(x?.detailType))
    .filter((x) => x.source.startsWith('ae.') && x.source !== ADMIN_NOTICE_SOURCE && !x.source.startsWith(PROCESS_SOURCE_PREFIX));
}

/** What a rule's pattern listens for, read from its fields: the event, its source, the resources it names and the states it matches. */
export interface PatternSummary {
  detailTypes: string[];
  sources: string[];
  resources: string[];
  states: string[];
  /** The fields under `detail` the pattern names, as key paths. */
  detailPaths: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The pattern as stored on the rule, summarized. Undefined for a pattern that is not JSON. */
export function summarizePattern(pattern: string | null | undefined): PatternSummary | undefined {
  if (!pattern) return undefined;
  try {
    const p = JSON.parse(pattern) as Record<string, unknown>;
    const detail = (p.detail && typeof p.detail === 'object' ? p.detail : {}) as Record<string, unknown> & { state?: { value?: unknown } };
    return {
      detailTypes: strings(p['detail-type']),
      sources: strings(p.source),
      resources: strings(p.resources),
      states: strings(detail.state?.value),
      detailPaths: Object.keys(detail).filter((k) => /^[A-Za-z0-9_-]+$/.test(k)).map((k) => `$.detail.${k}`),
    };
  } catch {
    return undefined;
  }
}

const ALARM_ARN = /^arn:aws[a-z-]*:cloudwatch:[a-z0-9-]*:\d*:alarm:.+$/;

/** The last segment of an ARN, the name a person knows the resource by. */
export const arnName = (arn: string): string => arn.split(/[:/]/).pop() || arn;

/** The kinds of key a type's conversations record that an event from this source may carry: a kind belongs to one source. */
export function kindsTheEventCanCarry(typeKey: string, source: string | undefined): string[] {
  const bound = watchedKindSources(CONVERSATION_TYPES);
  const recorded = [...new Set((CONVERSATION_TYPES[typeKey]?.openedBy ?? []).map((o) => o.watches?.kind).filter((k): k is string => !!k))];
  return source ? recorded.filter((k) => bound.get(k) === `default|${source}`) : recorded;
}

/** The path a kind's openers read the key from, the first guess for where a later event carries it. */
export function openerPathOf(typeKey: string, kind: string): string | undefined {
  return (CONVERSATION_TYPES[typeKey]?.openedBy ?? []).find((o) => o.watches?.kind === kind)?.watches?.path;
}

/**
 * WHETHER A LISTED TRIGGER IS THIS EDITOR'S: it starts this workflow, and it was attached for this assistant or for none.
 * Another assistant's trigger for a workflow of the same name runs that assistant's version, so it is never listed (and
 * never offered for removal) here.
 */
export function belongsTo(trigger: Pick<EventTrigger, 'workflow' | 'assistant'>, workflow: string, assistant: string | undefined): boolean {
  if (trigger.workflow !== workflow) return false;
  return !trigger.assistant || !assistant || trigger.assistant === assistant;
}

/**
 * WHAT STARTS IT, AS THE FORM HOLDS IT: `on:<event>` a workflow event, `handoff:<classification>|<process>|<name>` a declared
 * hand-off, `platform:<source>|<detail type>` a platform event, `rule:<name>` an account rule to copy, `alarm:<arn>` one alarm.
 */
export type Choice = string;

/** Where the run starts: a team room, a conversation per pattern value, the watching conversation, the process's, the named one, or the workflow's own types. */
export type WhereMode = 'team' | 'pattern' | 'watched' | 'process' | 'named' | 'in';
export interface Where { mode: WhereMode; type: string; kind?: string; keyPath?: string }

/** How an edit's form starts, read from the trigger it edits: its alarm, its hand-off, its AgentEchelon event, or its own rule to copy. */
export function formOfTrigger(x: Pick<EventTrigger, 'pattern' | 'ruleArn' | 'id'>): { source: TriggerSource; choice: Choice } {
  const summary = summarizePattern(x.pattern);
  const alarm = summary?.resources.find((r) => ALARM_ARN.test(r));
  if (alarm) return { source: 'alarm', choice: `alarm:${alarm}` };
  const src = summary?.sources[0];
  // A HAND-OFF'S RULE: its sending classification from the source, its process and name from the detail type.
  const detailType = summary?.detailTypes[0] ?? '';
  if (src && src.startsWith(PROCESS_SOURCE_PREFIX) && detailType.includes('.')) {
    const dot = detailType.indexOf('.');
    return { source: 'ae', choice: `handoff:${handoffValue({ classification: src.slice(PROCESS_SOURCE_PREFIX.length), process: detailType.slice(0, dot), name: detailType.slice(dot + 1) })}` };
  }
  if (src && src.startsWith('ae.') && detailType && summary?.sources.length === 1 && summary.detailTypes.length === 1) {
    return { source: 'ae', choice: `platform:${src}|${detailType}` };
  }
  return { source: 'eventbridge', choice: `rule:${x.ruleArn ? arnName(x.ruleArn) : x.id}` };
}

/** Where an attached trigger runs, read from its listing: a team room's has no kind, a watch rule's kind names its target. */
export function whereOfTrigger(x: Pick<EventTrigger, 'kind' | 'keyPath'>, typeKey: string): Where {
  if (!x.kind) return { mode: 'team', type: typeKey };
  if (x.kind === 'pattern' || x.kind === 'process' || x.kind === 'named') return { mode: x.kind, type: typeKey, ...(x.keyPath ? { keyPath: x.keyPath } : {}) };
  return { mode: 'watched', type: typeKey, kind: x.kind, keyPath: x.keyPath ?? '' };
}

/** The event a choice carries, as far as the form knows it before attaching: its source, for the kinds of key it may carry. */
function sourceOfChoice(choice: Choice, rules: AccountRule[]): string | undefined {
  if (choice.startsWith('alarm:')) return CLOUDWATCH_SOURCE;
  if (choice.startsWith('platform:')) return choice.slice('platform:'.length).split('|')[0];
  if (choice.startsWith('handoff:')) return `${PROCESS_SOURCE_PREFIX}${choice.slice('handoff:'.length).split('|')[0]}`;
  if (choice.startsWith('rule:')) return summarizePattern(rules.find((r) => r.name === choice.slice('rule:'.length))?.pattern)?.sources[0];
  return undefined;
}

/** The request body's choice for an attached trigger. */
export function choiceBody(choice: Choice): EventTriggerChoice | undefined {
  if (choice.startsWith('alarm:')) return { resourceArn: choice.slice('alarm:'.length) };
  if (choice.startsWith('rule:')) return { rule: choice.slice('rule:'.length) };
  if (choice.startsWith('platform:')) {
    const [source, detailType] = choice.slice('platform:'.length).split('|');
    return { platformEvent: { source, detailType: detailType ?? '' } };
  }
  if (choice.startsWith('handoff:')) {
    const [classification, process, name] = choice.slice('handoff:'.length).split('|');
    return { handoff: { classification, process: process ?? '', name: name ?? '' } };
  }
  return undefined;
}

/** The target the attach request names, or none for a team room. */
export function whereBody(where: Where, handoff: boolean): { kind: string; keyPath: string; target?: 'named' } | undefined {
  const pattern = CONVERSATION_TYPES[where.type]?.conversationPattern ?? '';
  if (where.mode === 'team') return undefined;
  if (where.mode === 'named') return { kind: 'named', keyPath: RESOURCE_PATH, target: 'named' };
  if (where.mode === 'process') return { kind: 'process', keyPath: HANDOFF_KEY_PATH };
  if (where.mode === 'pattern') return { kind: 'pattern', keyPath: handoff ? HANDOFF_KEY_PATH : pattern.includes('{key}') ? where.keyPath ?? '' : RESOURCE_PATH };
  return { kind: where.kind ?? '', keyPath: where.keyPath ?? '' };
}

const ArnName: React.FC<{ arn: string; testId: string }> = ({ arn, testId }) => {
  const url = consoleUrlForArn(arn);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" title={arn} data-testid={testId}>{arnName(arn)} ↗</a>
    : <span title={arn} data-testid={testId}>{arnName(arn)}</span>;
};

/** One attached trigger as listed, with the type and the classification whose route lists it. */
interface Listed { trigger: EventTrigger; type: string; classification: string }

export interface WorkflowTriggersProps {
  /** The workflow's key on the version, which an attached trigger names. */
  name: string;
  wf: EventWorkflow;
  onPut: (next: EventWorkflow) => void;
  /** The assistant whose version holds it, recorded on an attached trigger so its version runs it. */
  assistant?: string;
  /** The assistant's classification, which narrows the types offered and is where its triggers are attached. */
  classification?: string;
  /** The conversation types a workflow on this event may name here. */
  typesFor: (on: EventWorkflow['on']) => string[];
  /** The declared types left out for this event, with why, said beside the choice. */
  leftOut?: (on: EventWorkflow['on']) => React.ReactNode;
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** A workflow event without its deadline and types, so a change of event never carries either across. */
const bare = (wf: EventWorkflow): EventWorkflow => { const { deadline: _d, types: _t, ...rest } = wf; return rest as EventWorkflow; };

export const WorkflowTriggers: React.FC<WorkflowTriggersProps> = ({ name, wf, onPut, assistant, classification, typesFor, leftOut }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  // ATTACHING, EDITING AND REMOVING AN ATTACHED TRIGGER IS AN ADMIN'S (`manage-event-triggers`); a team sees its own assistant's
  // (`view-event-triggers`). The workflow's own event is part of the version, edited wherever the version is.
  const can = useCan();
  const manage = can('manage-event-triggers');
  const attachedType = wf.on === EVENT_RECEIVED ? wf.types?.[0] : undefined;
  /** The classifications an attached trigger of a type is listed and attached at: the assistant's, else each the type permits. */
  const classificationsOf = useCallback((type: string): string[] => {
    const all = CONVERSATION_TYPES[type]?.classifications ?? [];
    return classification && classificationAllowedForType(type, classification) ? [classification] : [...all];
  }, [classification]);

  const [listed, setListed] = useState<Listed[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!attachedType) { setListed([]); return; }
    const out: Listed[] = [];
    for (const c of classificationsOf(attachedType)) {
      const res = await listEventTriggers(attachedType, c);
      for (const x of res.triggers) if (belongsTo(x, name, assistant)) out.push({ trigger: x, type: attachedType, classification: c });
    }
    setListed(out);
  }, [attachedType, classificationsOf, name, assistant]);
  useEffect(() => { refresh().catch((e: unknown) => setError(triggerErrorText(e, t))); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  // THE RULES LEFT STANDING when an attached trigger was edited into the workflow's own event: the active version still runs
  // on them until the draft is activated, so they are listed until they are removed here.
  const [kept, setKept] = useState<Listed[]>([]);

  // THE FORM IS CLOSED UNTIL IT IS ASKED FOR: Add opens it empty, Edit opens it filled from the line.
  const [open, setOpen] = useState<null | { editing: Listed | 'on' | null }>(null);
  const [source, setSource] = useState<TriggerSource | null>(null);
  // WHAT STARTS IT, AS A LIST: one choice is saved per trigger today, and the list shape is where several would go.
  const [chosen, setChosen] = useState<Choice[]>([]);
  const choice: Choice = chosen[0] ?? '';
  const setChoice = (c: Choice) => setChosen(c ? [c] : []);
  const [where, setWhere] = useState<Where>({ mode: 'in', type: '' });
  const [deadline, setDeadline] = useState<number>(DEFAULT_DEADLINE_MINUTES);
  // WHAT THE ACCOUNT AND THE PLATFORM HOLD, listed as soon as the type is chosen.
  const [rules, setRules] = useState<AccountRule[] | null>(null);
  const [alarms, setAlarms] = useState<AccountAlarm[] | null>(null);
  const [platform, setPlatform] = useState<Array<{ source: string; detailType: string }>>([]);
  const [handoffs, setHandoffs] = useState<DeclaredHandoff[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open || !manage || !source) return;
    let live = true;
    const fail = (e: unknown) => { if (live) setError(triggerErrorText(e, t)); };
    if (source === 'eventbridge' && rules === null) listAccountRules('').then((r) => { if (live) setRules(r); }).catch(fail);
    if (source === 'alarm' && alarms === null) listAccountAlarms('').then((a) => { if (live) setAlarms(a); }).catch(fail);
    if (source === 'ae') {
      readEventPolicy().then((p) => { if (live) setPlatform(platformEventsOf(p)); }).catch(fail);
      listDeclaredHandoffs().then((h) => { if (live) setHandoffs(h); }).catch(fail);
    }
    return () => { live = false; };
  }, [open, manage, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const editing = open?.editing ?? null;
  const editingAttached = editing && editing !== 'on' ? editing : null;
  // A WORKFLOW'S OWN EVENT REPLACES EVERY ATTACHED TRIGGER, so it is offered only where no other attached trigger stands.
  const othersAttached = listed.filter((l) => l !== editingAttached).length > 0;
  const ownEventOffered = !othersAttached;
  // AN ATTACHED TRIGGER RUNS IN THE WORKFLOW'S ONE TYPE: an edit keeps its type (the route replaces within it), and an added one
  // joins the type the others run in.
  const fixedType = editingAttached ? attachedType : othersAttached ? attachedType : undefined;

  const isOwnEvent = choice.startsWith('on:');
  const ownEvent = isOwnEvent ? choice.slice(3) as EventWorkflow['on'] : undefined;
  const isHandoff = choice.startsWith('handoff:');
  const chosenHandoff = isHandoff ? handoffs.find((h) => isHandoffOf(choice.slice('handoff:'.length), h)) : undefined;
  const handoffParts = isHandoff ? choice.slice('handoff:'.length).split('|') : [];
  const connectorFact = choice.startsWith('platform:ae.connector|');
  const eventSource = sourceOfChoice(choice, rules ?? []);
  // AN ALARM WHOSE NAME A CONVERSATION'S ID CANNOT CARRY is said, and not saved, for a pattern that names `{resource}`.
  const resourceUnusable = where.mode === 'pattern' && (CONVERSATION_TYPES[where.type]?.conversationPattern ?? '').includes('{resource}')
    && choice.startsWith('alarm:') && !/^[A-Za-z0-9:._-]{1,128}$/.test(arnName(choice.slice('alarm:'.length)));

  /** The targets this attached choice may run in, each with the types it offers; a target with no type is not offered. */
  const targets = useMemo(() => {
    if (!choice || isOwnEvent) return [] as Array<{ mode: WhereMode; types: string[] }>;
    const offered = (fixedType ? [fixedType] : typesFor(EVENT_RECEIVED)).filter((x) => CONVERSATION_TYPES[x]);
    const team = offered.filter((x) => isTeamRoomType(x));
    const patternTypes = offered.filter((x) => isPatternType(x));
    // ONLY A PATTERN TYPE THE SERVICE ACCEPTS FOR THIS EVENT is offered (`patternTargetRefusal`); the rest are said beside it.
    const pattern = patternTypes.filter((x) => !patternTargetRefusal(x, isHandoff, eventSource));
    const other = offered.filter((x) => !isTeamRoomType(x) && !isPatternType(x));
    const watched = isHandoff ? [] : other.filter((x) => kindsTheEventCanCarry(x, eventSource).length > 0);
    const out: Array<{ mode: WhereMode; types: string[] }> = [
      { mode: 'team', types: team },
      { mode: 'pattern', types: pattern },
      { mode: 'watched', types: watched },
      { mode: 'process', types: isHandoff ? other : [] },
      { mode: 'named', types: connectorFact ? [...patternTypes, ...other] : [] },
    ];
    return out.filter((x) => x.types.length > 0);
  }, [choice, isOwnEvent, fixedType, typesFor, isHandoff, eventSource, connectorFact]);
  /** The pattern types this choice may not run in, each with why. */
  const patternLeftOut = useMemo(() => {
    if (!choice || isOwnEvent) return [] as Array<{ type: string; why: PatternRefusal }>;
    const offered = (fixedType ? [fixedType] : typesFor(EVENT_RECEIVED)).filter((x) => isPatternType(x));
    return offered.flatMap((type) => { const why = patternTargetRefusal(type, isHandoff, eventSource); return why ? [{ type, why }] : []; });
  }, [choice, isOwnEvent, fixedType, typesFor, isHandoff, eventSource]);

  // AN EDITED HAND-OFF, read from its rule, names no assistant: once the hand-offs are listed, the one declaration it names is chosen.
  useEffect(() => {
    if (!isHandoff) return;
    const value = choice.slice('handoff:'.length);
    if (value.split('|').length !== 3) return;
    const named = handoffs.filter((h) => isHandoffOf(value, h));
    if (named.length === 1) setChoice(`handoff:${handoffValue(named[0])}`);
  }, [choice, handoffs]); // eslint-disable-line react-hooks/exhaustive-deps

  // THE TARGET FOLLOWS THE CHOICE: one the choice no longer offers moves to the first it does, with its first type.
  useEffect(() => {
    if (!choice) return;
    if (isOwnEvent) {
      // A CONVERSATION-OPENED WORKFLOW NAMES THE TYPES AN EVENT OPENS (`eventWorkflowErrors`), so it is never offered "any".
      const first = ownEvent === 'conversation-opened' ? typesFor(ownEvent).find((x) => x) ?? '' : '';
      if (where.mode !== 'in') setWhere({ mode: 'in', type: first });
      else if (first && !where.type) setWhere({ mode: 'in', type: first });
      return;
    }
    const target = targets.find((x) => x.mode === where.mode);
    if (!target) {
      // THE WORKFLOW'S OWN TYPE FIRST, where a target offers it: a new trigger joins where the workflow already runs.
      const current = wf.types?.length === 1 ? wf.types[0] : undefined;
      const first = targets.find((x) => current && x.types.includes(current)) ?? targets[0];
      if (first) setWhere(defaultWhere(first.mode, current && first.types.includes(current) ? current : first.types[0]));
      return;
    }
    if (!target.types.includes(where.type)) setWhere(defaultWhere(target.mode, target.types[0]));
  }, [choice, targets]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A target with its type, and for a watched one the first kind the event may carry and where its openers read it. */
  function defaultWhere(mode: WhereMode, type: string): Where {
    if (mode !== 'watched') return { mode, type };
    const kind = kindsTheEventCanCarry(type, eventSource)[0] ?? '';
    return { mode, type, kind, keyPath: openerPathOf(type, kind) ?? '' };
  }

  const reset = () => { setError(''); setFilter(''); };
  const chooseSource = (next: TriggerSource) => { setSource(next); setChoice(''); reset(); };
  const openAdd = () => {
    setOpen({ editing: null });
    setSource(null);
    setChoice('');
    setWhere({ mode: 'in', type: '' });
    reset();
  };
  const startEditOwn = () => {
    setOpen({ editing: 'on' });
    setSource(wf.on === WATCHED_ALARM ? 'alarm' : 'ae');
    // AN EVENT THE FORM DOES NOT LIST (a reopened task, a meeting's) stays as it is until another is chosen.
    setChoice(wf.on === WATCHED_ALARM || LIFECYCLE_EVENTS.includes(wf.on) ? `on:${wf.on}` : '');
    setWhere({ mode: 'in', type: (wf.types ?? []).join(',') });
    setDeadline(wf.deadline?.afterMinutes ?? DEFAULT_DEADLINE_MINUTES);
    reset();
  };
  const startEditAttached = (l: Listed) => {
    const f = formOfTrigger(l.trigger);
    setOpen({ editing: l });
    setSource(f.source);
    setChoice(f.choice);
    setWhere(whereOfTrigger(l.trigger, attachedType ?? ''));
    reset();
  };
  const close = () => { setOpen(null); setSource(null); setChoice(''); reset(); };

  const save = async () => {
    if (!choice) { setError(t('admin.triggerForm.needEvent')); return; }
    setBusy(true);
    setError('');
    try {
      if (isOwnEvent) {
        // THE WORKFLOW'S OWN EVENT IS A DRAFT CHANGE: the attached trigger it replaces keeps starting the active version, so
        // its rule stands, listed beside the new event, until it is removed here once the draft is activated.
        if (editingAttached) setKept((k) => [...k.filter((x) => x.trigger.id !== editingAttached.trigger.id), editingAttached]);
        const types = where.type ? where.type.split(',') : [];
        onPut({ ...bare(wf), on: ownEvent!, ...(types.length ? { types } : {}), ...(isDeadlineEvent(ownEvent!) ? { deadline: { afterMinutes: deadline } } : {}) });
      } else {
        const body = choiceBody(choice)!;
        const target = whereBody(where, isHandoff);
        if (target && !target.keyPath) { setError(t('admin.triggerForm.needKeyPath')); return; }
        const at = editingAttached ? editingAttached.classification : classificationsOf(where.type)[0];
        if (!where.type || !at) { setError(t('admin.triggerForm.needWhere')); return; }
        await attachEventTrigger(where.type, at, name, body, target, assistant, editingAttached ? editingAttached.trigger.id : undefined);
        if (wf.on !== EVENT_RECEIVED || wf.types?.length !== 1 || wf.types[0] !== where.type) onPut({ ...bare(wf), on: EVENT_RECEIVED, types: [where.type] });
      }
      close();
      if (!isOwnEvent) await refresh();
    } catch (e) { setError(triggerErrorText(e, t)); } finally { setBusy(false); }
  };

  const remove = async (l: Listed) => {
    setBusy(true);
    setError('');
    try {
      await removeEventTrigger(l.type, l.classification, l.trigger.id, assistant);
      setKept((k) => k.filter((x) => x.trigger.id !== l.trigger.id));
      await refresh();
    } catch (e) { setError(triggerErrorText(e, t)); } finally { setBusy(false); }
  };

  /** Where an attached trigger runs, said on its line. */
  const runsIn = (w: Where): string => {
    const pattern = CONVERSATION_TYPES[w.type]?.conversationPattern ?? '';
    if (w.mode === 'team') return t('admin.triggerForm.runsIn_team', { type: w.type });
    if (w.mode === 'pattern') return t('admin.triggerForm.runsIn_pattern', { type: w.type, pattern });
    if (w.mode === 'process') return t('admin.triggerForm.runsIn_process', { type: w.type });
    if (w.mode === 'named') return t('admin.triggerForm.runsIn_named', { type: w.type });
    return t('admin.triggerForm.runsIn_watched', { type: w.type, kind: w.kind ?? '' });
  };
  const typesSaid = (types: readonly string[] | undefined): string => (types?.length ? t('admin.triggerForm.runsIn_types', { types: types.join(', ') }) : t('admin.triggerForm.runsIn_any'));

  const line = (id: string, badge: string, title: React.ReactNode, when: string | null, runs: string, actions: { edit?: () => void; remove?: () => void }) => (
    <li key={id} className="admin-event-trigger-item" data-testid={`trigger-line-${id}`}>
      <div className="admin-event-trigger-row">
        <span className="admin-chip" data-testid={`trigger-line-${id}-type`}>{badge}</span>
        <strong data-testid={`trigger-line-${id}-name`}>{title}</strong>
        {when && <span className="admin-muted" data-testid={`trigger-line-${id}-when`}>{when}</span>}
      </div>
      <div className="admin-event-trigger-row">
        <span className="admin-field-hint" data-testid={`trigger-line-${id}-runs-in`}>{runs}</span>
        {actions.edit && <button type="button" className="btn-secondary" disabled={busy || !!open} data-testid={`trigger-edit-${id}`} onClick={actions.edit}>{t('admin.triggerForm.edit')}</button>}
        {actions.remove && <ConfirmAction testId={`trigger-remove-${id}`} className="btn-secondary" disabled={busy || !!open} label={t('admin.triggerForm.remove')}
          title={t('admin.confirm.triggerRemove')} body={t('admin.confirm.triggerRemoveBody')} confirmLabel={t('admin.confirm.remove')} cancelLabel={t('admin.confirm.cancel')} onConfirm={actions.remove} />}
      </div>
    </li>
  );

  const attachedLine = (l: Listed) => {
    const x = l.trigger;
    const s = summarizePattern(x.pattern);
    const f = formOfTrigger(x);
    const w = whereOfTrigger(x, l.type);
    const standing = kept.includes(l);
    const alarm = f.choice.startsWith('alarm:') ? f.choice.slice('alarm:'.length) : '';
    const [hc, hp, hn] = f.choice.startsWith('handoff:') ? f.choice.slice('handoff:'.length).split('|') : [];
    const badge = alarm ? t('admin.triggerForm.source_alarm') : f.source === 'ae' ? t('admin.triggerForm.source_ae') : t('admin.triggerForm.source_eventbridge');
    const title: React.ReactNode = alarm ? <ArnName arn={alarm} testId={`trigger-line-${x.id}-link`} />
      : hn ? t('admin.triggerForm.handoffFrom', { name: hn, process: hp, from: hc })
        : s?.detailTypes.length ? `${s.detailTypes.join(', ')}${s.sources.length ? ` (${s.sources.join(', ')})` : ''}` : x.id;
    const states = s?.states.length ? s.states : alarm ? ['ALARM'] : [];
    return line(x.id, badge, title, states.length ? t('admin.triggerForm.whenState', { state: states.join(', ') }) : null, standing ? t('admin.triggerForm.keptRunsIn', { where: runsIn(w) }) : runsIn(w),
      manage ? { ...(standing ? {} : { edit: () => startEditAttached(l) }), remove: () => { void remove(l); } } : {});
  };

  const ownLine = () => {
    const watchedAlarm = wf.on === WATCHED_ALARM;
    const lifecycle = LIFECYCLE_EVENTS.includes(wf.on);
    const title = watchedAlarm ? t('admin.triggerForm.watchedAlarm') : lifecycle ? t(`admin.triggerForm.event_${wf.on}`) : wf.on;
    const when = isDeadlineEvent(wf.on) && wf.deadline ? t('admin.triggerForm.afterMinutes', { minutes: wf.deadline.afterMinutes }) : null;
    return line('on', watchedAlarm ? t('admin.triggerForm.source_alarm') : t('admin.triggerForm.source_ae'), title, when, typesSaid(wf.types), { edit: startEditOwn });
  };

  /** One option of a list: its value, what a person reads, the group it sits in, and whether it may be chosen. */
  interface ListOption { value: Choice; label: string; group?: string; disabled?: boolean }
  /** What a choice is called before its list has loaded, so an edit's own choice is shown chosen at once. */
  const labelOfChoice = (c: Choice): string => (c.startsWith('alarm:') ? arnName(c.slice('alarm:'.length))
    : c.startsWith('rule:') ? c.slice('rule:'.length)
      : c.startsWith('handoff:') ? t('admin.triggerForm.handoff', { name: c.split('|')[2] ?? '' })
        : c.startsWith('platform:') ? c.slice('platform:'.length).split('|')[1] ?? ''
          : c.startsWith('on:') ? (c === `on:${WATCHED_ALARM}` ? t('admin.triggerForm.watchedAlarm') : t(`admin.triggerForm.event_${c.slice(3)}`)) : c);

  const editingRule = editingAttached && formOfTrigger(editingAttached.trigger).choice;
  /** The options the chosen type lists, from the platform or the account. */
  const optionsOf = (): ListOption[] => {
    if (source === 'ae') {
      return [
        ...(ownEventOffered ? LIFECYCLE_EVENTS.map((e) => ({ value: `on:${e}`, label: t(`admin.triggerForm.event_${e}`), group: t('admin.triggerForm.group_lifecycle') })) : []),
        ...(manage ? platform.map((p) => ({ value: `platform:${p.source}|${p.detailType}`, label: `${p.detailType} (${p.source})`, group: t('admin.triggerForm.group_platform') })) : []),
        // A HAND-OFF TWO ASSISTANTS OF ONE CLASSIFICATION DECLARE puts events the receiver cannot tell apart: listed, never chosen.
        ...(manage ? handoffs.map((h) => {
          const ambiguous = handoffs.filter((o) => o.classification === h.classification && o.process === h.process && o.name === h.name).length > 1;
          const label = t('admin.triggerForm.handoffFrom', { name: h.name, process: h.process, from: h.assistant });
          return { value: `handoff:${handoffValue(h)}`, label: ambiguous ? `${label} (${t('admin.triggerForm.handoffAmbiguous', { classification: h.classification })})` : label, group: t('admin.triggerForm.group_handoff'), disabled: ambiguous };
        }) : []),
      ];
    }
    if (source === 'eventbridge') {
      return (rules ?? []).map((r) => {
        const s = summarizePattern(r.pattern);
        const taken = r.attached && editingRule !== `rule:${r.name}`;
        const what = [s?.sources.join(', '), s?.detailTypes.join(', ')].filter(Boolean).join(' · ');
        return { value: `rule:${r.name}`, label: taken ? `${r.name} (${t('admin.triggerForm.ruleAttached')})` : what ? `${r.name}: ${what}` : r.name, disabled: taken };
      });
    }
    if (source === 'alarm') {
      return [
        ...(ownEventOffered ? [{ value: `on:${WATCHED_ALARM}`, label: t('admin.triggerForm.watchedAlarm') }] : []),
        ...(manage ? (alarms ?? []).map((a) => ({ value: `alarm:${a.arn}`, label: `${a.name} (${a.state})` })) : []),
      ];
    }
    return [];
  };
  /** A filter narrows a list once it holds enough letters to mean something; the chosen option always stays listed. */
  const narrowed = (all: ListOption[]): ListOption[] => {
    const q = filter.trim().toLowerCase();
    const shown = q.length >= FILTER_MIN_CHARS ? all.filter((o) => chosen.includes(o.value) || o.label.toLowerCase().includes(q)) : all;
    const missing = chosen.filter((c) => c && !all.some((o) => o.value === c)).map((c) => ({ value: c, label: labelOfChoice(c) }));
    return [...missing, ...shown];
  };

  /** The list as one select, grouped where its options name a group, with its filter above it. */
  const listSelect = (testId: string, all: ListOption[]) => {
    const shown = narrowed(all);
    const groups = [...new Set(shown.map((o) => o.group ?? ''))];
    const optionsOfGroup = (g: string) => shown.filter((o) => (o.group ?? '') === g).map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>);
    return (
      <div className="admin-stacked-field">
        <input type="search" className={INPUT_FIELD} data-testid="trigger-list-filter" aria-label={t('admin.triggerForm.filter')}
          placeholder={t('admin.triggerForm.filterHint', { count: FILTER_MIN_CHARS })} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select className={SELECT_FIELD} data-testid={testId} aria-label={t(`admin.triggerForm.step2_${source}`)} value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="" disabled>{t('admin.triggerForm.choose')}</option>
          {groups.map((g) => (g ? <optgroup key={g} label={g}>{optionsOfGroup(g)}</optgroup> : optionsOfGroup(g)))}
        </select>
      </div>
    );
  };

  const stepWhich = () => {
    if (source === 'ae') {
      return (
        <>
          {listSelect('trigger-event-select', optionsOf())}
          {ownEvent === 'conversation-opened' && <span className="admin-field-hint" data-testid="trigger-event-hint">{t('admin.triggerForm.hint_conversation-opened')}</span>}
          {!ownEventOffered && <span className="admin-field-hint" data-testid="trigger-own-event-held">{t('admin.triggerForm.ownEventHeld')}</span>}
          {ownEvent && isDeadlineEvent(ownEvent) && (
            <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.workflowEditor.deadlineAfter', { min: MIN_DEADLINE_MINUTES, max: MAX_DEADLINE_MINUTES })}</span>
              <input type="number" className={INPUT_FIELD} min={MIN_DEADLINE_MINUTES} max={MAX_DEADLINE_MINUTES} data-testid="event-workflow-deadline-after"
                value={deadline} onChange={(e) => setDeadline(Math.round(Number(e.target.value)))} />
              <span className="admin-field-hint">{t('admin.workflowEditor.deadlineAfterHelp')}</span>
            </label>
          )}
          {chosenHandoff && (
            <div className="admin-event-trigger-why" data-testid="trigger-handoff-fields">
              <span className="admin-field-label">{t('admin.triggerForm.arrivesWith')}</span>
              <ul className="admin-plain-list">
                {Object.entries(chosenHandoff.fields).map(([field, f]) => (
                  <li key={field}><code>{field}</code> <span className="admin-muted">{f.values?.length ? f.values.join(' · ') : f.type}{f.store ? ` ${t('admin.triggerForm.fieldStore', { store: f.store })}` : ''}</span></li>
                ))}
              </ul>
            </div>
          )}
        </>
      );
    }
    if (source === 'eventbridge') {
      if (!rules) return <span className="admin-field-hint" role="status">{t('admin.triggerForm.loading')}</span>;
      if (!rules.length) return <span className="admin-field-hint" data-testid="trigger-rules-none">{t('admin.triggerForm.rulesNone')}</span>;
      return listSelect('trigger-rule-select', optionsOf());
    }
    if (source === 'alarm') {
      return (
        <>
          {manage && !alarms && <span className="admin-field-hint" role="status">{t('admin.triggerForm.loading')}</span>}
          {manage && alarms && !alarms.length && <span className="admin-field-hint" data-testid="trigger-alarms-none">{t('admin.triggerForm.alarmsNone')}</span>}
          {listSelect('trigger-alarm-select', optionsOf())}
          {choice.startsWith('alarm:') && (
            <span className="admin-field-hint" data-testid="trigger-alarm-state">{t('admin.triggerForm.whenState', { state: 'ALARM' })}</span>
          )}
        </>
      );
    }
    return null;
  };

  const typeSelect = (types: string[], value: string, onPick: (type: string) => void, testId: string, any = false) => (
    <select className={SELECT_FIELD} data-testid={testId} value={value} onChange={(e) => onPick(e.target.value)}>
      {any && <option value="">{t('admin.triggerForm.anyType')}</option>}
      {types.map((x) => <option key={x} value={x}>{x.includes(',') ? x.split(',').join(', ') : x}</option>)}
    </select>
  );
  const keyPathInput = (paths: string[]) => (
    <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.triggerForm.keyFrom')}</span>
      <input type="text" className={INPUT_FIELD} list={`trigger-key-paths-${name}`} data-testid="trigger-key-path" value={where.keyPath ?? ''}
        placeholder={t('admin.triggerForm.keyPathPlaceholder')} onChange={(e) => setWhere({ ...where, keyPath: e.target.value.trim() })} />
      <datalist id={`trigger-key-paths-${name}`}>{paths.map((p) => <option key={p} value={p} />)}</datalist>
    </label>
  );

  const stepWhere = () => {
    if (isOwnEvent) {
      const offered = typesFor(ownEvent!);
      const current = (wf.types ?? []).length > 1 && editing === 'on' && ownEvent === wf.on ? [(wf.types ?? []).join(',')] : [];
      const types = [...current, ...offered, ...(where.type && !where.type.includes(',') && !offered.includes(where.type) ? [where.type] : [])];
      return (
        <div className="admin-event-trigger-row" data-testid="trigger-where-in">
          <span>{t(`admin.triggerForm.in_${ownEvent === WATCHED_ALARM ? 'alarm' : ownEvent}`)}</span>
          {typeSelect(types, where.type, (type) => setWhere({ mode: 'in', type }), 'trigger-where-in-type', ownEvent !== 'conversation-opened')}
          <span>{t('admin.triggerForm.conversation')}</span>
        </div>
      );
    }
    const rulePaths = choice.startsWith('rule:') ? summarizePattern(rules?.find((r) => `rule:${r.name}` === choice)?.pattern)?.detailPaths ?? [] : [];
    const radio = (mode: WhereMode, types: string[], label: React.ReactNode, extra?: React.ReactNode) => (
      <div key={mode} className="admin-event-trigger-why">
        <label className="admin-check">
          <input type="radio" name={`trigger-where-${name}`} checked={where.mode === mode} data-testid={`trigger-where-${mode}`}
            onChange={() => setWhere(defaultWhere(mode, types.includes(where.type) ? where.type : types[0]))} />
          {label}
          {typeSelect(types, where.mode === mode ? where.type : types[0], (type) => setWhere(defaultWhere(mode, type)), `trigger-where-${mode}-type`)}
        </label>
        {where.mode === mode && extra}
      </div>
    );
    const pattern = CONVERSATION_TYPES[where.type]?.conversationPattern ?? '';
    return (
      <>
        {targets.map(({ mode, types }) => {
          if (mode === 'team') return radio(mode, types, t('admin.triggerForm.where_team'));
          if (mode === 'pattern') {
            return radio(mode, types, isHandoff ? t('admin.triggerForm.where_patternProcess', { process: handoffParts[1] ?? '' }) : t('admin.triggerForm.where_pattern'), (
              <>
                <span className="admin-field-hint" data-testid="trigger-where-pattern-name">{t('admin.triggerForm.patternNamed')} <code>{pattern}</code></span>
                {!isHandoff && pattern.includes('{key}') && keyPathInput(rulePaths)}
                {resourceUnusable && <span className="admin-field-hint" role="alert" data-testid="trigger-resource-unusable">{t('admin.triggerForm.resourceUnusable')}</span>}
              </>
            ));
          }
          if (mode === 'watched') {
            const kinds = kindsTheEventCanCarry(where.type, eventSource);
            return radio(mode, types, t('admin.triggerForm.where_watched'), (
              <>
                <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.triggerForm.kind')}</span>
                  <select className={SELECT_FIELD} data-testid="trigger-kind" value={where.kind ?? ''} onChange={(e) => setWhere({ ...where, kind: e.target.value, keyPath: openerPathOf(where.type, e.target.value) ?? where.keyPath })}>
                    {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
                {keyPathInput(rulePaths)}
              </>
            ));
          }
          if (mode === 'process') return radio(mode, types, t('admin.triggerForm.where_process', { process: handoffParts[1] ?? '' }));
          return radio(mode, types, t('admin.triggerForm.where_named'), <span className="admin-field-hint">{t('admin.triggerForm.namedHelp')}</span>);
        })}
        {!targets.length && <span className="admin-field-hint" role="alert" data-testid="trigger-where-none">{t('admin.triggerForm.whereNone')}</span>}
        {patternLeftOut.length > 0 && (
          <span className="admin-field-hint" data-testid="trigger-pattern-left-out">
            {t('admin.triggerForm.patternLeftOut')}{' '}
            {patternLeftOut.map((x, i) => (
              <span key={x.type} data-testid={`trigger-pattern-left-out-${x.type}`}>{i > 0 ? '; ' : ''}<code>{x.type}</code> ({t(`admin.triggerForm.patternLeftOut_${x.why}`)})</span>
            ))}
          </span>
        )}
      </>
    );
  };

  const ownSaid = wf.on !== EVENT_RECEIVED;
  return (
    <fieldset className="admin-event-trigger" data-testid="workflow-triggers">
      <legend className="admin-field-label">{t('admin.triggerForm.title')}</legend>
      <ul className="admin-event-trigger-list" data-testid="trigger-lines">
        {ownSaid ? <>{ownLine()}{kept.map(attachedLine)}</> : listed.map(attachedLine)}
        {!ownSaid && !listed.length && <li className="admin-muted" data-testid="trigger-none">{t('admin.triggerForm.none')}</li>}
      </ul>
      {!ownSaid && manage && !open && (
        <div><button type="button" className="btn-secondary" data-testid="trigger-add" onClick={openAdd}>{listed.length ? t('admin.triggerForm.addAnother') : t('admin.triggerForm.add')}</button></div>
      )}
      {!manage && !ownSaid && <span className="admin-field-hint" data-testid="trigger-read-only">{t('admin.triggerForm.readOnly')}</span>}

      {open && (
        <div className="admin-event-trigger" data-testid="trigger-form">
          <span className="admin-field-label">{t('admin.triggerForm.step1')}</span>
          <div className="admin-event-trigger-row" role="group" aria-label={t('admin.triggerForm.step1')}>
            {(['ae', 'eventbridge', 'alarm'] as const).filter((s) => manage || s !== 'eventbridge').map((s) => (
              <button key={s} type="button" className={source === s ? 'btn-primary' : 'btn-secondary'} aria-pressed={source === s} data-testid={`trigger-source-${s}`} onClick={() => chooseSource(s)}>
                {t(`admin.triggerForm.source_${s}`)}
              </button>
            ))}
          </div>
          {source && (
            <>
              <span className="admin-field-label">{t(`admin.triggerForm.step2_${source}`)}</span>
              <div className="admin-filter-group" data-testid="trigger-which">{stepWhich()}</div>
            </>
          )}
          {source && choice && (
            <>
              <span className="admin-field-label">{t('admin.triggerForm.step3')}</span>
              <div className="admin-filter-group" data-testid="trigger-where">{stepWhere()}</div>
              {leftOut?.(isOwnEvent ? ownEvent! : EVENT_RECEIVED)}
              {isOwnEvent && editingAttached && <span className="admin-field-hint" role="note" data-testid="trigger-rule-kept">{t('admin.triggerForm.ruleKept')}</span>}
            </>
          )}
          <div className="admin-event-trigger-row">
            <button type="button" className="btn-primary" data-testid="trigger-save" disabled={busy || !choice || (!isOwnEvent && !targets.length) || resourceUnusable} onClick={() => { void save(); }}>{busy ? t('admin.triggerForm.saving') : t('admin.triggerForm.save')}</button>
            <button type="button" className="btn-secondary" data-testid="trigger-cancel" disabled={busy} onClick={close}>{t('admin.triggerForm.cancel')}</button>
          </div>
        </div>
      )}
      {error && <span className="error-message" role="alert" data-testid="trigger-error">{error}</span>}
    </fieldset>
  );
};

export default WorkflowTriggers;
