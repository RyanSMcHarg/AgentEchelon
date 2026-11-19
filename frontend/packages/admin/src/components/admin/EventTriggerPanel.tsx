/**
 * WHAT STARTS AN EVENT WORKFLOW (SPEC-WORKFLOWS-AND-TASKS WT121): an EventBridge event chosen from a list of event types, or named by
 * pasting a schema name, a resource's ARN or an existing rule. Attaching is an admin action on AWS resources, separate from
 * saving the version: it makes one rule, in this deployment, for the workflow and its team's room.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@ae/shared';
import { CONVERSATION_TYPES, isTeamRoomType } from '../../../../../../backend/lib/config/conversation-types.ts';
import EventPolicyPanel from './EventPolicyPanel';
import { consoleUrlForArn } from '../../services/awsConsole';
import { attachEventTrigger, describeEventType, listEventTriggers, listEventTypes, removeEventTrigger, type DescribedEventType, type EventTrigger, type EventTriggerChoice } from '../../services/eventTriggerService';
import { ALARM_STATE_CHANGE, CLOUDWATCH_SOURCE, watchedKindSources } from '../../../../../../backend/lib/config/event-openers.ts';

/** The refusals the trigger routes answer with a code this panel says in the console's own words. */
const CODED_REFUSALS: readonly string[] = ['TRIGGER_OTHER_ASSISTANT', 'TRIGGER_THROTTLED'];

/** A coded refusal's own copy; anything else keeps the message the request raised. */
export function triggerErrorKey(e: unknown): string | null {
  const code = e instanceof ApiError ? (e.body as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === 'string' && CODED_REFUSALS.includes(code) ? `admin.eventTrigger.errors.${code}` : null;
}

type Mode = 'eventType' | 'resourceArn' | 'rule';
/** How a list of event types, sources or states reads in a row. */
const LIST = ', ';

/** What a rule's pattern listens for, read from its fields: the event, its source, the resources it names and the states it matches. */
export interface PatternSummary {
  detailTypes: string[];
  sources: string[];
  resources: string[];
  states: string[];
  pretty: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The pattern as stored on the rule, summarized. Undefined for a pattern that is not JSON. */
export function summarizePattern(pattern: string | null | undefined): PatternSummary | undefined {
  if (!pattern) return undefined;
  try {
    const p = JSON.parse(pattern) as Record<string, unknown>;
    const detail = (p.detail ?? {}) as { state?: { value?: unknown } };
    return {
      detailTypes: strings(p['detail-type']),
      sources: strings(p.source),
      resources: strings(p.resources),
      states: strings(detail.state?.value),
      pretty: JSON.stringify(p, null, 2),
    };
  } catch {
    return undefined;
  }
}

/** What the chosen event carries, as far as the form can know it before attaching. */
export interface ChosenEvent { source: string; detailType: string; detailPaths: string[] }

const ALARM_ARN = /^arn:aws[a-z-]*:cloudwatch:[a-z0-9-]*:\d*:alarm:.+$/;

/** The event an alarm's ARN means: a CloudWatch alarm's change, which names its resource and no conversation. */
export function eventOfAlarmArn(arn: string): ChosenEvent | undefined {
  return ALARM_ARN.test(arn) ? { source: CLOUDWATCH_SOURCE, detailType: ALARM_STATE_CHANGE, detailPaths: [] } : undefined;
}

/** The declared types an event opens its own conversation of (`openedBy`), by its exact source and detail type. */
export function typesTheEventOpens(event: Pick<ChosenEvent, 'source' | 'detailType'>): string[] {
  return Object.entries(CONVERSATION_TYPES)
    .filter(([, type]) => (type.openedBy ?? []).some((o) => !o.eventBus && o.source === event.source && o.detailType === event.detailType))
    .map(([key]) => key);
}

/** The kinds of key a type's conversations record that this event's source may carry: a kind belongs to one source. */
export function kindsTheEventCanCarry(typeKey: string, event: Pick<ChosenEvent, 'source'> | undefined): string[] {
  const bound = watchedKindSources(CONVERSATION_TYPES);
  const recorded = [...new Set((CONVERSATION_TYPES[typeKey]?.openedBy ?? []).map((o) => o.watches?.kind).filter((k): k is string => !!k))];
  return event ? recorded.filter((k) => bound.get(k) === `default|${event.source}`) : recorded;
}

/** The path a kind's openers read the key from, the first guess for where a later event carries it. */
export function openerPathOf(typeKey: string, kind: string): string | undefined {
  return (CONVERSATION_TYPES[typeKey]?.openedBy ?? []).find((o) => o.watches?.kind === kind)?.watches?.path;
}

/** The last segment of an ARN, the name a person knows the resource by. */
export const arnName = (arn: string): string => arn.split(/[:/]/).pop() || arn;

const ArnLink: React.FC<{ arn: string; testId: string }> = ({ arn, testId }) => {
  const url = consoleUrlForArn(arn);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" title={arn} data-testid={testId}><code>{arnName(arn)}</code> ↗</a>
    : <code title={arn} data-testid={testId}>{arn}</code>;
};

/**
 * WHETHER A LISTED TRIGGER IS THIS EDITOR'S: it starts this workflow, and it was attached for this assistant or for none.
 * Another assistant's trigger for a workflow of the same name runs that assistant's version, so it is never listed (and
 * never offered for removal) here.
 */
export function belongsTo(trigger: Pick<EventTrigger, 'workflow' | 'assistant'>, workflow: string, assistant: string | undefined): boolean {
  if (trigger.workflow !== workflow) return false;
  return !trigger.assistant || !assistant || trigger.assistant === assistant;
}

/** `assistant`: the assistant whose version holds the workflow, recorded on the trigger so its version runs it. */
export const EventTriggerPanel: React.FC<{ workflow: string; typeKey?: string; assistant?: string }> = ({ workflow, typeKey, assistant }) => {
  const { t } = useTranslation();
  // ONE TEAM ROOM PER CLASSIFICATION THE TYPE PERMITS: each is listed, attached to and detached from on its own.
  const classifications = typeKey ? CONVERSATION_TYPES[typeKey]?.classifications ?? [] : [];
  const [picked, setPicked] = useState('');
  const classification = classifications.includes(picked) ? picked : classifications[0];
  // WHERE IT RUNS (DESIGN-EVENT-TARGETS section 7): a team room type's one room, or the conversation of any other type that
  // watches the event's key. The type decides; the kinds offered are those the type's openers record.
  const watched = !!typeKey && !isTeamRoomType(typeKey);
  const recordedKinds = watched ? kindsTheEventCanCarry(typeKey!, undefined) : [];
  const [kind, setKind] = useState('');
  // WHAT THE CHOSEN EVENT CARRIES (DESIGN-EVENT-TARGETS section 7): read from its schema once an event type is chosen, known from an
  // alarm's ARN, and unknown for a copied rule. The form adjusts step 2 to it.
  const [described, setDescribed] = useState<DescribedEventType | null>(null);
  const [keyPath, setKeyPath] = useState('');
  const [mode, setMode] = useState<Mode>('eventType');
  const [value, setValue] = useState('');
  const [resourceArn, setResourceArn] = useState('');
  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  // WHAT A SEARCH FOUND, said beside it: searching, how many, or that nothing matched.
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'done'>('idle');
  const [triggers, setTriggers] = useState<EventTrigger[]>([]);
  const [roomArn, setRoomArn] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen: ChosenEvent | undefined = mode === 'resourceArn' ? eventOfAlarmArn(value)
    : mode === 'eventType' && described && described.name === value ? described : undefined;
  // AN ALARM NAMES A RESOURCE AND NO CONVERSATION, which step 2 says when the workflow's type is not a team room's.
  const alarmChosen = chosen?.source === CLOUDWATCH_SOURCE && chosen.detailType === ALARM_STATE_CHANGE;
  const opens = chosen ? typesTheEventOpens(chosen) : [];
  const kinds = watched ? kindsTheEventCanCarry(typeKey!, chosen) : [];
  const chosenKind = kinds.includes(kind) ? kind : kinds[0] ?? '';
  const keyChoices = chosen?.detailPaths.length ? [...chosen.detailPaths, '$.resources[0]'] : [];

  // A CHOSEN EVENT TYPE IS DESCRIBED, so step 2 offers its fields as the key's path and the kinds its source may carry.
  // A pasted name waits for typing to stop, so a name is described once, not once a keystroke.
  useEffect(() => {
    if (mode !== 'eventType' || !value) return;
    let live = true;
    const timer = setTimeout(() => {
      describeEventType(value).then((d) => { if (live) setDescribed(d); }).catch(() => { if (live) setDescribed(null); });
    }, types.includes(value) ? 0 : 600);
    return () => { live = false; clearTimeout(timer); };
  }, [mode, value]); // eslint-disable-line react-hooks/exhaustive-deps
  // A NEW EVENT, A NEW KEY PATH: the path chosen for one event is never sent with another.
  useEffect(() => { setKeyPath(''); }, [mode, value]);
  // THE KEY PATH FOLLOWS THE EVENT: where the kind's openers read it, when the chosen event declares that field.
  useEffect(() => {
    const guess = chosenKind ? openerPathOf(typeKey!, chosenKind) : undefined;
    if (guess && keyChoices.includes(guess) && !keyPath) setKeyPath(guess);
  }, [chosenKind, keyChoices.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  // WHAT AN ATTACH DID, said where the person clicked: the rule now in the list.
  const [attached, setAttached] = useState('');

  const refresh = useCallback(async () => {
    if (!typeKey || !classification) return;
    const out = await listEventTriggers(typeKey, classification);
    setTriggers(out.triggers.filter((x) => belongsTo(x, workflow, assistant)));
    setRoomArn(out.channelArn ?? '');
  }, [typeKey, classification, workflow, assistant]);

  useEffect(() => { refresh().catch((e: Error) => setError(e.message)); }, [refresh]);

  const search = async () => {
    setError('');
    setSearchState('searching');
    try {
      const names = (await listEventTypes(query.trim())).map((x) => x.name);
      setTypes(names);
      // ONE MATCH IS THE CHOICE: chosen for the person rather than left behind a closed list.
      if (names.length === 1) setValue(names[0]);
      else if (!names.includes(value)) setValue('');
    } catch (e) { setError((e as Error).message); } finally { setSearchState('done'); }
  };

  const attach = async () => {
    if (!typeKey || !classification) return;
    setAttached('');
    // NOTHING TO ATTACH IS SAID, never a click that does nothing: the field the chosen kind reads is named.
    if (!value) { setError(t('admin.eventTrigger.needValue', { field: t(`admin.eventTrigger.paste_${mode}`) })); return; }
    if (watched && (!keyPath || (keyChoices.length > 0 && !keyChoices.includes(keyPath)))) { setError(t('admin.eventTrigger.needValue', { field: t('admin.eventTrigger.keyPath') })); return; }
    setBusy(true);
    setError('');
    try {
      const choice: EventTriggerChoice = mode === 'eventType'
        ? { eventType: value, ...(resourceArn ? { resourceArn } : {}) }
        : mode === 'resourceArn' ? { resourceArn: value } : { rule: value };
      // THE ASSISTANT WHOSE VERSION HOLDS THE WORKFLOW goes with the attach, so its version runs it when the event arrives.
      const where = watched ? { kind: chosenKind, keyPath } : undefined;
      const out = assistant
        ? await attachEventTrigger(typeKey, classification, workflow, choice, where, assistant)
        : where ? await attachEventTrigger(typeKey, classification, workflow, choice, where) : await attachEventTrigger(typeKey, classification, workflow, choice);
      setAttached(t('admin.eventTrigger.attached', { rule: (out as { ruleArn?: string; id?: string })?.ruleArn ?? (out as { id?: string })?.id ?? '' }));
      setValue('');
      setResourceArn('');
      setKeyPath('');
      await refresh();
    } catch (e) { const key = triggerErrorKey(e); setError(key ? t(key) : (e as Error).message); } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!typeKey || !classification) return;
    setBusy(true);
    setError('');
    try {
      await removeEventTrigger(typeKey, classification, id, assistant);
      await refresh();
    } catch (e) { const key = triggerErrorKey(e); setError(key ? t(key) : (e as Error).message); } finally { setBusy(false); }
  };

  if (!typeKey || !classification) {
    return <span className="admin-field-hint" data-testid="event-trigger-no-room">{t('admin.eventTrigger.noRoom')}</span>;
  }

  return (
    <fieldset className="admin-event-trigger" data-testid="event-trigger-panel">
      <legend className="admin-field-label">{t('admin.eventTrigger.title')}</legend>
      <span className="admin-field-hint">{t('admin.eventTrigger.help')}</span>

      <ul className="admin-event-trigger-list" data-testid="event-trigger-list">
        {triggers.map((x) => {
          const summary = summarizePattern(x.pattern);
          return (
            <li key={x.id} className="admin-event-trigger-item" data-testid={`event-trigger-${x.id}`}>
              <table className="admin-kv-table">
                <tbody>
                  {summary?.detailTypes.length ? (
                    <tr><td className="admin-kv-key">{t('admin.eventTrigger.event')}</td>
                      <td className="admin-kv-val">{summary.detailTypes.join(LIST)}{summary.sources.length ? <span className="admin-muted"> ({summary.sources.join(LIST)})</span> : null}</td></tr>
                  ) : null}
                  {summary?.resources.length ? (
                    <tr><td className="admin-kv-key">{t('admin.eventTrigger.resource')}</td>
                      <td className="admin-kv-val">{summary.resources.map((arn, i) => <div key={arn}><ArnLink arn={arn} testId={`event-trigger-${x.id}-resource-${i}`} /></div>)}</td></tr>
                  ) : null}
                  {summary?.states.length ? (
                    <tr><td className="admin-kv-key">{t('admin.eventTrigger.state')}</td>
                      <td className="admin-kv-val">{summary.states.join(LIST)}</td></tr>
                  ) : null}
                  {x.kind ? (
                    <tr><td className="admin-kv-key">{t('admin.eventTrigger.key')}</td>
                      <td className="admin-kv-val"><code>{x.kind}</code>{x.keyPath ? <span className="admin-muted"> {t('admin.eventTrigger.keyFrom')} <code>{x.keyPath}</code></span> : null}</td></tr>
                  ) : null}
                  <tr><td className="admin-kv-key">{t('admin.eventTrigger.rule')}</td>
                    <td className="admin-kv-val">{x.ruleArn ? <ArnLink arn={x.ruleArn} testId={`event-trigger-${x.id}-rule`} /> : <code>{x.id}</code>}</td></tr>
                </tbody>
              </table>
              {x.pattern && (
                <details>
                  <summary className="admin-field-hint">{t('admin.eventTrigger.pattern')}</summary>
                  <pre className="admin-event-trigger-pattern" data-testid={`event-trigger-${x.id}-pattern`}>{summary?.pretty ?? x.pattern}</pre>
                </details>
              )}
              <div>
                <button type="button" className="btn-secondary" disabled={busy} data-testid={`event-trigger-remove-${x.id}`} onClick={() => { void remove(x.id); }}>
                  {t('admin.eventTrigger.remove')}
                </button>
              </div>
            </li>
          );
        })}
        {!triggers.length && <li className="admin-muted" data-testid="event-trigger-none">{t('admin.eventTrigger.none')}</li>}
      </ul>

      <h4 className="admin-field-label" data-testid="event-trigger-step-event">{t('admin.eventTrigger.step1')}</h4>
      <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.eventTrigger.choose')}</span>
        <select className="select" data-testid="event-trigger-mode" value={mode} onChange={(e) => { setMode(e.target.value as Mode); setError(''); }}>
          <option value="eventType">{t('admin.eventTrigger.mode_eventType')}</option>
          <option value="resourceArn">{t('admin.eventTrigger.mode_resourceArn')}</option>
          <option value="rule">{t('admin.eventTrigger.mode_rule')}</option>
        </select>
      </label>
      {mode === 'eventType' && (
        <>
          <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.eventTrigger.search')}</span>
            <span className="admin-event-trigger-row">
              <input type="search" className="input" data-testid="event-trigger-search" value={query} placeholder={t('admin.eventTrigger.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
              <button type="button" className="btn-secondary" data-testid="event-trigger-search-go" disabled={searchState === 'searching'} onClick={() => { void search(); }}>{t('admin.eventTrigger.searchGo')}</button>
            </span>
          </label>
          {searchState !== 'idle' && (
            <span className="admin-field-hint" role="status" data-testid="event-trigger-search-status">
              {searchState === 'searching' ? t('admin.eventTrigger.searching')
                : types.length ? t('admin.eventTrigger.found', { count: types.length })
                  : t('admin.eventTrigger.foundNone', { q: query.trim() })}
            </span>
          )}
          {types.length > 0 && (
            <select className="select" data-testid="event-trigger-types" aria-label={t('admin.eventTrigger.typePick')} value={types.includes(value) ? value : ''} onChange={(e) => setValue(e.target.value)}>
              <option value="" className="select-placeholder" disabled hidden>{t('admin.eventTrigger.typePick')}</option>
              {types.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
        </>
      )}
      <label className="admin-stacked-field"><span className="admin-field-label">{t(`admin.eventTrigger.paste_${mode}`)}</span>
        <input type="text" className="input" data-testid="event-trigger-value" value={value} onChange={(e) => setValue(e.target.value.trim())} />
      </label>
      {mode === 'eventType' && (
        <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.eventTrigger.narrow')}</span>
          <input type="text" className="input" data-testid="event-trigger-resource" value={resourceArn} onChange={(e) => setResourceArn(e.target.value.trim())} />
        </label>
      )}
      <h4 className="admin-field-label" data-testid="event-trigger-step-target">{t('admin.eventTrigger.step2')}</h4>
      <div className="admin-event-trigger-why" data-testid="event-trigger-target">
        <strong>{watched ? t('admin.eventTrigger.target_watched') : t('admin.eventTrigger.target_team')}</strong>
        <span className="admin-field-hint">{watched ? t('admin.eventTrigger.why_watched', { type: typeKey }) : t('admin.eventTrigger.why_team')}</span>
        {watched && alarmChosen && <span className="admin-field-hint" role="note" data-testid="event-trigger-alarm-note">{t('admin.eventTrigger.alarmNamesNoConversation', { type: typeKey })}</span>}
        {opens.length > 0 && <span className="admin-field-hint" role="note" data-testid="event-trigger-opens-note">{t('admin.eventTrigger.eventOpensItsOwn', { types: opens.join(', ') })}</span>}
        {watched && chosen && recordedKinds.length > 0 && !kinds.length && (
          <span className="admin-field-hint" role="alert" data-testid="event-trigger-wrong-source">{t('admin.eventTrigger.sourceCarriesNoKey', { source: chosen.source, type: typeKey, kinds: recordedKinds.join(', ') })}</span>
        )}
      </div>
      {classifications.length > 1 && (
        <label className="admin-stacked-field"><span className="admin-field-label">{t(watched ? 'admin.eventTrigger.classificationWatched' : 'admin.eventTrigger.classification')}</span>
          <select className="select" data-testid="event-trigger-classification" value={classification} onChange={(e) => setPicked(e.target.value)}>
            {classifications.map((c) => <option key={c} value={c}>{watched ? c : `team-${typeKey}-${c}`}</option>)}
          </select>
        </label>
      )}
      {!watched && roomArn && (
        <span className="admin-field-hint" data-testid="event-trigger-room">
          {t('admin.eventTrigger.room')} <code title={roomArn}>{arnName(roomArn)}</code>
        </span>
      )}
      {watched && !recordedKinds.length && <span className="admin-field-hint" role="alert" data-testid="event-trigger-no-kind">{t('admin.eventTrigger.noKind', { type: typeKey })}</span>}
      {watched && kinds.length > 0 && (
        <>
          <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.eventTrigger.kind')}</span>
            <select className="select" data-testid="event-trigger-kind" value={chosenKind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <span className="admin-field-hint">{t('admin.eventTrigger.kindHelp', { type: typeKey })}</span>
          </label>
          <label className="admin-stacked-field"><span className="admin-field-label">{t('admin.eventTrigger.keyPath')}</span>
            {keyChoices.length > 0 ? (
              <select className="select" data-testid="event-trigger-key-path" value={keyChoices.includes(keyPath) ? keyPath : ''} onChange={(e) => setKeyPath(e.target.value)}>
                <option value="" className="select-placeholder" disabled hidden>{t('admin.eventTrigger.keyPathPick')}</option>
                {keyChoices.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <input type="text" className="input" data-testid="event-trigger-key-path" value={keyPath} placeholder={t('admin.eventTrigger.keyPathPlaceholder')} onChange={(e) => setKeyPath(e.target.value.trim())} />
            )}
            <span className="admin-field-hint">{keyChoices.length ? t('admin.eventTrigger.keyPathFromSchema', { type: chosen?.detailType ?? '' }) : t('admin.eventTrigger.keyPathHelp')}</span>
          </label>
        </>
      )}
      <h4 className="admin-field-label" data-testid="event-trigger-step-inputs">{t('admin.eventTrigger.step3')}</h4>
      <ul className="admin-field-hint" data-testid="event-trigger-inputs">
        <li>{t('admin.eventTrigger.input_type')}</li>
        <li>{t('admin.eventTrigger.input_resource')}</li>
        {watched && <li>{t('admin.eventTrigger.input_key', { kind: chosenKind || t('admin.eventTrigger.key') })}</li>}
        <li>{t('admin.eventTrigger.input_label', { from: watched ? t('admin.eventTrigger.key') : t('admin.eventTrigger.resource') })}</li>
        <li className="admin-muted">{t('admin.eventTrigger.input_noDetail')}</li>
      </ul>
      <div>
        <button type="button" className="btn-primary" data-testid="event-trigger-attach" disabled={busy || (watched && !kinds.length)} onClick={() => { void attach(); }}>{busy ? t('admin.eventTrigger.attaching') : t('admin.eventTrigger.attach')}</button>
      </div>
      {error && <span className="error-message" role="alert" data-testid="event-trigger-error">{error}</span>}
      {attached && <span className="admin-field-hint" role="status" data-testid="event-trigger-attached">{attached}</span>}
      <EventPolicyPanel />
    </fieldset>
  );
};

export default EventTriggerPanel;
