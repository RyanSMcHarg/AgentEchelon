/**
 * THE VISUAL WORKFLOW BUILDER (ADR-061 decision 7): a version's event workflows as a flow of steps on a canvas, a palette of the
 * steps the runtime runs, and an inspector for the selected step.
 *
 * WHAT IT EDITS. The version's `eventWorkflows`, the welcome included, and nothing else: every change goes through the
 * edits in `workflowEdits.ts` and every control in the inspector is the list editor's own (`StepFields`,
 * `WorkflowSettings`, `WorkflowPicker` in `EventWorkflowEditor.tsx`), so the canvas never offers a field the runtime
 * does not run. The list editor is the same controls in order, one switch away.
 *
 * WHERE STEPS SIT (B7). A step is drawn at its saved point, else at a computed one (`workflowGraph.ts`). Dragging a step,
 * or moving it with the arrow keys, saves its point into the version's layout, which the draft stores as its own body
 * beside the persona and which nothing the version does reads.
 *
 * THE RULES ARE THE SERVER'S (B2). The status line is `versionEventWorkflowsErrors`, the function the draft, activation
 * and import refuse with, and each error naming a step is shown on that step and in its inspector; the errors of the
 * last Validate are anchored the same way. Preview run (B4) walks the workflow on the server with sample values and
 * sends nothing.
 *
 * WITHOUT A MOUSE (B5). Each step is a button in a list: Tab reaches it, Enter selects it, the arrow keys move it (Shift
 * moves further). Connecting is a port button under the selected step, then the step it goes to; Escape cancels. A
 * palette button adds its step after the selected one. Every move, connection and addition is announced.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  conditionSources, versionEventWorkflowsErrors, type EventStepDef, type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { layoutFor, type StepPosition, type WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { HelpToggle } from './AdminHelp';
import EventWorkflowEditor, {
  StepFields, WorkflowPicker, WorkflowSettings, audienceKey, templateNames, useAudienceLabel, workflowsWith, type WorkflowOptions,
} from './EventWorkflowEditor';
import {
  addStep, connect, kindOf, kindsFor, removeStep, renameStep, startAt, updateStep, type EdgeName, type Kind,
} from './workflowEdits';
import {
  NODE_H, NODE_W, NUDGE, NUDGE_FAR, anchoredErrors, edgePath, edgesOf, planeSize, positionsOf, snap, triggerAt, withWorkflowLayout,
} from './workflowGraph';
import { previewWorkflowRun, type WorkflowPreview } from '../../services/profileService';
import './WorkflowBuilder.css';

type T = (key: string, opts?: Record<string, unknown>) => string;
type Workflows = Record<string, EventWorkflow>;

/** The palette (mock: Say, Do, Decide), each item a step kind the runtime runs, or a decision the inspector sets. */
const PALETTE: Array<{ group: 'say' | 'do' | 'decide' | 'finish'; items: Array<Kind | 'condition' | 'deadline'> }> = [
  { group: 'say', items: ['send', 'opening', 'agent', 'prompt'] },
  { group: 'do', items: ['task', 'intake'] },
  { group: 'decide', items: ['condition', 'deadline'] },
  { group: 'finish', items: ['end'] },
];
const DRAG_TYPE = 'application/x-ae-workflow-step';
/** A small secondary button, the ports under a selected step. */
const SMALL_BUTTON = ['btn-secondary', 'btn-sm'].join(' ');
const cls = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(' ');

const WorkflowBuilder: React.FC<WorkflowOptions & {
  workflows: Workflows;
  onChange: (next: Workflows | null) => void;
  /** The version's saved layout, every workflow's. */
  layout?: WorkflowLayout;
  onLayoutChange: (next: WorkflowLayout | null) => void;
  /** The assistant whose draft this is, for Preview run. */
  profileName?: string;
  /** The errors of the draft's last Validate, anchored to the steps they name. */
  serverErrors?: readonly string[];
  /** The workflow shown first, when the version holds it; else its first. */
  initialWorkflow?: string;
}> = ({ workflows, onChange, layout, onLayoutChange, profileName, serverErrors = [], templates, tools, published, variables, initialWorkflow }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const audienceLabel = useAudienceLabel();
  const names = Object.keys(workflows);
  const [name, setName] = useState(initialWorkflow && workflows[initialWorkflow] ? initialWorkflow : names[0] ?? '');
  // A workflow chosen on the page after the builder opened is shown too.
  useEffect(() => {
    if (initialWorkflow && workflows[initialWorkflow]) setName(initialWorkflow);
    // Only a new choice moves the selection; an edit to the workflows does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWorkflow]);
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ from: string; edge: EdgeName } | null>(null);
  const [dragAt, setDragAt] = useState<{ key: string; at: StepPosition } | null>(null);
  const [said, setSaid] = useState('');
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [previewError, setPreviewError] = useState<string[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [endings, setEndings] = useState<Record<string, 'success' | 'failure' | 'deadline'>>({});
  const drag = useRef<{ key: string; x0: number; y0: number; from: StepPosition; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const focusNext = useRef<string | null>(null);
  const plane = useRef<HTMLDivElement | null>(null);
  const { messages, prompts } = templateNames(templates);

  const wf = workflows[name];
  const saved = layout?.[name];
  const positions = useMemo(() => (wf ? positionsOf(wf, saved) : {}), [wf, saved]);
  const drawn = (key: string): StepPosition => (dragAt?.key === key ? dragAt.at : positions[key]);
  const errors = useMemo(() => (wf ? [...new Set([...versionEventWorkflowsErrors({ [name]: wf }), ...serverErrors])] : []), [wf, name, serverErrors]);
  const anchored = useMemo(() => anchoredErrors(errors, name, wf), [errors, name, wf]);

  useEffect(() => {
    if (!focusNext.current) return;
    plane.current?.querySelector<HTMLButtonElement>(`[data-step="${focusNext.current}"]`)?.focus();
    focusNext.current = null;
  });

  /** One change to the workflows, and the layout kept to the steps they now declare. */
  const change = (next: Workflows, points?: Record<string, StepPosition> | null) => {
    onChange(Object.keys(next).length ? next : null);
    const merged: WorkflowLayout = { ...(layout ?? {}) };
    if (points && next[name]) merged[name] = { ...(merged[name] ?? {}), ...points };
    const nextLayout = layoutFor(merged, next) ?? null;
    if (JSON.stringify(nextLayout) !== JSON.stringify(layout ?? null)) onLayoutChange(nextLayout);
    setPreview(null);
  };
  const put = (next: EventWorkflow, points?: Record<string, StepPosition> | null) => change({ ...workflows, [name]: next }, points);

  /** Save where a step sits: every step's current point, so the flow stays as the person sees it. */
  const place = (key: string, at: StepPosition) => {
    const point = { x: Math.max(0, snap(at.x)), y: Math.max(0, snap(at.y)) };
    const next = withWorkflowLayout(layout, workflows, name, { ...positions, [key]: point });
    onLayoutChange(next);
    setSaid(t('admin.workflowBuilder.announce_moved', { step: key, x: point.x, y: point.y }));
  };

  const kindLabel = (def: EventStepDef) => t(`admin.workflowEditor.kind_${kindOf(def)}`);
  const toLabel = (to: unknown) => audienceLabel(audienceKey(to as never));
  const detailOf = (def: EventStepDef): string => {
    if (def.send) return t('admin.workflowBuilder.detail_send', { template: def.send.template, to: toLabel(def.send.to) });
    if (def.agent) return t('admin.workflowBuilder.detail_agent', { template: def.agent.prompt, to: toLabel(def.agent.to) });
    if (def.task) return t('admin.workflowBuilder.detail_task', { machine: def.task.machine });
    if (def.action) return t('admin.workflowBuilder.detail_intake', { to: toLabel(def.action.to) });
    if (def.opening) return t('admin.workflowBuilder.detail_opening');
    if (def.prompt) return t('admin.workflowBuilder.detail_prompt', { template: def.prompt.template });
    return t('admin.workflowBuilder.detail_end', { disposition: def.disposition ?? 'success' });
  };
  const edgeText = (value: EventStepDef['onSuccess']): string => (value === undefined ? t('admin.workflowBuilder.edgeEnd')
    : typeof value === 'string' ? value : value.map((a) => a.to).join(', '));

  /** Add a step from the palette: after the selected step, or where it was dropped. */
  const addKind = (kind: Kind, at?: StepPosition) => {
    if (!wf) return;
    const { workflow, key } = addStep(wf, kind, messages, prompts, selected ? { after: selected } : {});
    put(workflow, at ? { [key]: { x: Math.max(0, snap(at.x)), y: Math.max(0, snap(at.y)) } } : undefined);
    setSelected(key);
    focusNext.current = key;
    setSaid(t('admin.workflowBuilder.announce_added', { step: key }));
  };

  /** A step activated: selected, or, while connecting, the step the chosen edge goes to. */
  const activate = (key: string) => {
    if (connecting && wf) {
      if (connecting.from !== key) {
        put(connect(wf, connecting.from, connecting.edge, key));
        setSaid(t('admin.workflowBuilder.announce_connected', { from: connecting.from, to: key, edge: t(`admin.workflowBuilder.port_${connecting.edge}`) }));
      }
      setConnecting(null);
      focusNext.current = connecting.from;
      return;
    }
    setSelected(key);
  };

  const onNodeKey = (e: React.KeyboardEvent, key: string) => {
    if (e.key === 'Escape' && connecting) {
      setConnecting(null);
      setSaid(t('admin.workflowBuilder.announce_cancelled'));
      e.preventDefault();
      return;
    }
    const step = e.shiftKey ? NUDGE_FAR : NUDGE;
    const by: Record<string, StepPosition> = { ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step }, ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 } };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    const at = positions[key];
    place(key, { x: at.x + d.x, y: at.y + d.y });
  };

  const runPreview = async () => {
    if (!wf || !profileName) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const values = Object.fromEntries(Object.entries(sample).filter(([, v]) => v.trim()).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : v.includes(',') ? v.split(',').map((x) => x.trim()) : v]));
      setPreview(await previewWorkflowRun(profileName, name, wf, { values, outcomes: endings }));
    } catch (e) {
      const errs = (e as { body?: { errors?: unknown } }).body?.errors;
      setPreviewError(Array.isArray(errs) ? errs.map(String) : [e instanceof Error ? e.message : String(e)]);
    } finally {
      setPreviewBusy(false);
    }
  };

  const picker = (
    <WorkflowPicker workflows={workflows} selected={name} onSelect={(n) => { setName(n); setSelected(null); setPreview(null); }}
      onAdd={(n, from) => {
        const next = workflowsWith(workflows, n, from, templates);
        if (!next) return false;
        onChange(next);
        setName(n);
        setSelected(null);
        return true;
      }} />
  );

  if (view === 'list') {
    return (
      <div className="admin-wfb" data-testid="workflow-builder">
        <div className="admin-wfb-bar">
          <button type="button" className="btn-secondary" data-testid="wfb-view-canvas" onClick={() => setView('canvas')}>{t('admin.workflowBuilder.viewCanvas')}</button>
        </div>
        <EventWorkflowEditor workflows={workflows} initialSelected={name} onSelect={setName} templates={templates} tools={tools} published={published} variables={variables}
          onChange={(next) => change(next ?? {})} />
      </div>
    );
  }

  const { width, height } = planeSize({ ...positions, ...(dragAt ? { [dragAt.key]: dragAt.at } : {}) });
  const trigger = wf ? triggerAt(wf, positions) : { x: 0, y: 0 };
  const sources = wf ? [...conditionSources(wf, variables)].sort() : [];
  const paused = wf ? Object.entries(wf.states).filter(([, d]) => d.agent || d.task).map(([k, d]) => [k, !!d.task] as const) : [];
  const visited = new Set(preview?.steps.map((s) => s.step) ?? []);
  const selectedDef = selected && wf?.states[selected] ? wf.states[selected] : undefined;

  return (
    <div className="admin-wfb" data-testid="workflow-builder">
      <div className="admin-wfb-bar">
        {picker}
        <div className="admin-wfb-actions">
          <span role="status" data-testid="wfb-status" className={errors.length ? 'admin-wfb-status-bad' : 'admin-wfb-status-ok'}>
            {wf ? (errors.length ? t('admin.workflowBuilder.problems', { count: errors.length }) : t('admin.workflowBuilder.valid')) : ''}
          </span>
          <button type="button" className="btn-secondary" data-testid="wfb-preview" disabled={!wf || !profileName || previewBusy} onClick={runPreview}>
            {t('admin.workflowBuilder.previewRun')}
          </button>
          <button type="button" className="btn-secondary" data-testid="wfb-view-list" onClick={() => setView('list')}>{t('admin.workflowBuilder.viewList')}</button>
          <HelpToggle label={t('admin.workflowBuilder.helpLabel')} testId="wfb-help">
            <p>{t('admin.workflowBuilder.help')}</p>
            <p>{t('admin.workflowBuilder.serverNote')}</p>
          </HelpToggle>
        </div>
      </div>
      <p className="admin-field-hint" id="wfb-keys">{t('admin.workflowBuilder.keysHelp')}</p>
      <p className="admin-wfb-live" aria-live="polite" data-testid="wfb-announce">{said}</p>

      {!wf ? <p className="admin-muted">{t('admin.workflowBuilder.empty')}</p> : (
        <div className="admin-wfb-body">
          <aside className="admin-wfb-palette" aria-label={t('admin.workflowBuilder.palette')}>
            <p className="admin-field-hint">{t('admin.workflowBuilder.paletteHint')}</p>
            {PALETTE.map(({ group, items }) => (
              <div key={group} className="admin-wfb-group">
                <h6>{t(`admin.workflowBuilder.group_${group}`)}</h6>
                {items.map((item) => {
                  if (item === 'condition' || item === 'deadline') {
                    return (
                      <div key={item} className="admin-wfb-explained" data-testid={`wfb-palette-${item}`}>
                        <span>{t(`admin.workflowBuilder.item_${item}`)}</span>
                        <HelpToggle label={t(`admin.workflowBuilder.item_${item}`)} testId={`wfb-palette-${item}-help`}>
                          <p>{t(`admin.workflowBuilder.${item}Help`)}</p>
                          {item === 'condition' && selectedDef && !selectedDef.disposition && (
                            <button type="button" className="btn-link" data-testid="wfb-palette-condition-open"
                              onClick={() => document.getElementById('wfb-step-when')?.scrollIntoView?.({ block: 'center' })}>
                              {t('admin.workflowBuilder.conditionOpen', { step: selected })}
                            </button>
                          )}
                        </HelpToggle>
                      </div>
                    );
                  }
                  if (!kindsFor(wf.on).includes(item)) return null;
                  return (
                    <button key={item} type="button" className={cls('admin-wfb-pal', 'admin-wfb-kind-' + item)} draggable data-testid={'wfb-palette-' + item}
                      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, item)} onClick={() => addKind(item)}>
                      <span className="admin-wfb-dot" aria-hidden="true" />
                      {t(`admin.workflowBuilder.item_${item}`)}
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>

          <div className="admin-wfb-canvas" data-testid="wfb-canvas">
            <div ref={plane} className="admin-wfb-plane" style={{ width, height }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault(); }}
              onDrop={(e) => {
                const kind = e.dataTransfer.getData(DRAG_TYPE) as Kind;
                if (!kind) return;
                e.preventDefault();
                const rect = plane.current!.getBoundingClientRect();
                addKind(kind, { x: e.clientX - rect.left - NODE_W / 2, y: e.clientY - rect.top - NODE_H / 2 });
              }}>
              <svg className="admin-wfb-edges" width={width} height={height} aria-hidden="true">
                <defs>
                  <marker id="wfb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" className="admin-wfb-arrow" />
                  </marker>
                </defs>
                {edgesOf(wf).map((edge, i) => {
                  const { d, mid } = edgePath(drawn(edge.from), drawn(edge.to), edge.edge);
                  return (
                    <g key={i} data-testid={`wfb-edge-${edge.from}-${edge.edge}-${edge.to}`}>
                      <path d={d} markerEnd="url(#wfb-arrow)" className={cls('admin-wfb-edge', `admin-wfb-edge-${edge.edge}`, edge.alternative === 'when' && 'admin-wfb-edge-when')} />
                      {(edge.edge !== 'onSuccess' || edge.alternative) && (
                        <text x={mid.x} y={mid.y} className="admin-wfb-edge-label">
                          {edge.alternative === 'when' ? t('admin.workflowEditor.edgeWhen') : edge.alternative === 'otherwise' ? t('admin.workflowEditor.edgeOtherwise') : t(`admin.workflowBuilder.edge_${edge.edge}`)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              <div className="admin-wfb-trigger" style={{ left: trigger.x, top: trigger.y, width: NODE_W }} data-testid="wfb-trigger">
                <span className="admin-wfb-badge">{wf.on === 'assistant-joined' ? t('admin.workflowBuilder.welcomeBadge') : t('admin.workflowBuilder.trigger', { event: wf.on })}</span>
                <span className="admin-field-hint">{wf.types?.length ? t('admin.workflowBuilder.triggerTypes', { types: wf.types.join(', ') }) : t('admin.workflowBuilder.triggerAll')}</span>
              </div>

              <ul className="admin-wfb-nodes" aria-label={t('admin.workflowBuilder.canvasLabel', { name })}>
                {Object.keys(wf.states).map((key) => {
                  const def = wf.states[key];
                  const at = drawn(key);
                  const own = anchored.steps[key] ?? [];
                  const isSelected = selected === key;
                  return (
                    <li key={key} className="admin-wfb-node-wrap" style={{ left: at.x, top: at.y, width: NODE_W }}>
                      <button type="button" data-step={key} data-testid={`wfb-node-${key}`} aria-pressed={isSelected} aria-describedby="wfb-keys"
                        aria-label={[
                          t('admin.workflowBuilder.stepLabel', { name: key, kind: kindLabel(def), detail: detailOf(def) }),
                          def.disposition ? '' : t('admin.workflowBuilder.edgesLabel', { success: edgeText(def.onSuccess), failure: edgeText(def.onFailure) }),
                          key === wf.initial ? t('admin.workflowBuilder.isStart') : '',
                          own.length ? t('admin.workflowBuilder.problemsOn', { count: own.length }) : '',
                          connecting && connecting.from !== key ? t('admin.workflowBuilder.connectHere') : '',
                        ].filter(Boolean).join(' ')}
                        className={cls('admin-wfb-node', `admin-wfb-kind-${kindOf(def)}`, isSelected && 'admin-wfb-node-selected', own.length > 0 && 'admin-wfb-node-error',
                          visited.has(key) && 'admin-wfb-node-visited', connecting && connecting.from !== key && 'admin-wfb-node-target')}
                        style={{ minHeight: NODE_H }}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || connecting) return;
                          drag.current = { key, x0: e.clientX, y0: e.clientY, from: positions[key], moved: false };
                          e.currentTarget.setPointerCapture?.(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const d = drag.current;
                          if (!d || d.key !== key) return;
                          const dx = e.clientX - d.x0;
                          const dy = e.clientY - d.y0;
                          if (!d.moved && Math.hypot(dx, dy) < 4) return;
                          d.moved = true;
                          setDragAt({ key, at: { x: Math.max(0, d.from.x + dx), y: Math.max(0, d.from.y + dy) } });
                        }}
                        onPointerUp={(e) => {
                          const d = drag.current;
                          drag.current = null;
                          if (!d || !d.moved) return;
                          suppressClick.current = true;
                          setDragAt(null);
                          place(key, { x: d.from.x + e.clientX - d.x0, y: d.from.y + e.clientY - d.y0 });
                        }}
                        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } activate(key); }}
                        onKeyDown={(e) => onNodeKey(e, key)}>
                        <span className="admin-wfb-badge">{kindLabel(def)}{key === wf.initial ? ` · ${t('admin.workflowBuilder.start')}` : ''}</span>
                        <span className="admin-wfb-title">{key}</span>
                        <span className="admin-wfb-detail">{detailOf(def)}</span>
                        {own.length > 0 && <span className="admin-wfb-node-problems" data-testid={`wfb-node-${key}-problems`}>{t('admin.workflowBuilder.problemsOn', { count: own.length })}</span>}
                      </button>
                      {isSelected && !def.disposition && !connecting && (
                        <div className="admin-wfb-ports" role="group" aria-label={t('admin.workflowBuilder.portsLabel', { step: key })}>
                          <button type="button" className={SMALL_BUTTON} data-testid={`wfb-add-after-${key}`}
                            aria-label={t('admin.workflowBuilder.addAfter', { step: key })} onClick={() => addKind('send')}>+</button>
                          {(['onSuccess', 'onFailure', ...(def.task ? ['onDeadline' as const] : [])] as EdgeName[]).map((edge) => (
                            <button key={edge} type="button" className={SMALL_BUTTON} data-testid={`wfb-port-${key}-${edge}`}
                              onClick={() => { setConnecting({ from: key, edge }); setSaid(t('admin.workflowBuilder.connecting', { step: key, edge: t(`admin.workflowBuilder.port_${edge}`) })); }}>
                              {t(`admin.workflowBuilder.port_${edge}`)}
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            {connecting && (
              <p className="admin-wfb-connecting" data-testid="wfb-connecting">
                {t('admin.workflowBuilder.connecting', { step: connecting.from, edge: t(`admin.workflowBuilder.port_${connecting.edge}`) })}
                {' '}<button type="button" className="btn-link" onClick={() => setConnecting(null)}>{t('admin.workflowBuilder.cancel')}</button>
              </p>
            )}
          </div>

          <aside className="admin-wfb-inspector" aria-label={t('admin.workflowBuilder.inspector')} data-testid="wfb-inspector">
            {selectedDef && selected ? (
              <>
                <div className="admin-wfb-inspector-head">
                  <span className={cls('admin-wfb-badge', `admin-wfb-kind-${kindOf(selectedDef)}`)}>{kindLabel(selectedDef)}</span>
                  <h6>{selected}</h6>
                  <button type="button" className="btn-link" data-testid="wfb-deselect" onClick={() => setSelected(null)}>{t('admin.workflowBuilder.deselect')}</button>
                </div>
                {(anchored.steps[selected] ?? []).length > 0 && (
                  <ul role="alert" className="admin-error" data-testid="wfb-step-errors">
                    {anchored.steps[selected].map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}
                <StepFields key={selected} wf={wf} stepKey={selected} testId="wfb-step" templates={templates} tools={tools} published={published} variables={variables}
                  onChange={(def) => put(updateStep(wf, selected, def))}
                  onRename={(to) => {
                    const next = renameStep(wf, selected, to);
                    if (!next) return;
                    const { [selected]: point, ...rest } = positions;
                    put(next, { ...rest, [to]: point });
                    setSelected(to);
                  }} />
                <div className="admin-config-actions">
                  {selected === wf.initial
                    ? <span className="admin-field-hint">{t('admin.workflowBuilder.isStart')}</span>
                    : <button type="button" className="btn-secondary" data-testid="wfb-start-here" onClick={() => put(startAt(wf, selected))}>{t('admin.workflowBuilder.startHere')}</button>}
                  <button type="button" className="btn-danger" data-testid="wfb-remove-step" onClick={() => {
                    put(removeStep(wf, selected), null);
                    setSaid(t('admin.workflowBuilder.announce_removed', { step: selected }));
                    setSelected(null);
                  }}>{t('admin.workflowEditor.removeStep')}</button>
                </div>
              </>
            ) : (
              <>
                <p className="admin-field-hint">{t('admin.workflowBuilder.inspectorNone')}</p>
                <WorkflowSettings wf={wf} onPut={(next) => put(next)} onRemove={() => {
                  const { [name]: _gone, ...rest } = workflows;
                  change(rest, null);
                  setName(Object.keys(rest)[0] ?? '');
                }} />
              </>
            )}
            {anchored.workflow.length > 0 && (
              <ul role="alert" className="admin-error" data-testid="wfb-workflow-errors">
                {anchored.workflow.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </aside>
        </div>
      )}

      {wf && (
        <section className="admin-wfb-preview" aria-labelledby="wfb-preview-title" data-testid="wfb-preview-panel">
          <h6 id="wfb-preview-title">{t('admin.workflowBuilder.previewTitle')}</h6>
          <p className="admin-field-hint">{profileName ? t('admin.workflowBuilder.previewHelp') : t('admin.workflowBuilder.previewUnavailable')}</p>
          <div className="admin-filter-group">
            {sources.map((src) => (
              <label key={src}><span className="admin-field-label">{t('admin.workflowBuilder.previewValue', { source: src })}</span>
                <input type="text" className="input" data-testid={`wfb-sample-${src}`} value={sample[src] ?? ''} onChange={(e) => setSample({ ...sample, [src]: e.target.value })} />
              </label>
            ))}
            {paused.map(([step, isTask]) => (
              <label key={step}><span className="admin-field-label">{t('admin.workflowBuilder.previewEnding', { step })}</span>
                <select className="select" data-testid={`wfb-ending-${step}`} value={endings[step] ?? 'success'}
                  onChange={(e) => setEndings({ ...endings, [step]: e.target.value as 'success' | 'failure' | 'deadline' })}>
                  {(isTask ? ['success', 'failure', 'deadline'] : ['success', 'failure']).map((o) => <option key={o} value={o}>{t(`admin.workflowBuilder.ending_${o}`)}</option>)}
                </select>
              </label>
            ))}
          </div>
          {previewError && (
            <div className="admin-error" role="alert" data-testid="wfb-preview-refused">
              <span>{t('admin.workflowBuilder.previewFailed')}</span>
              <ul>{previewError.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )}
          {preview && (
            <ol data-testid="wfb-preview-result">
              {preview.steps.map((s, i) => {
                const acts = preview.acts.filter((a) => a.step === s.step);
                return (
                  <li key={`${s.step}-${i}`}>
                    <strong>{s.step}</strong>{' '}<span className="admin-badge">{s.outcome}</span>
                    {acts.map((a, j) => (
                      <span key={j} className="admin-wfb-act"> {t(`admin.workflowBuilder.act_${a.fallback ? 'fallback' : a.act}`, {
                        template: a.template ?? '', to: a.to === 'room' || !a.to ? t('admin.workflowBuilder.to_room') : a.to.join(', '),
                      })}</span>
                    ))}
                  </li>
                );
              })}
              <li data-testid="wfb-preview-end">{preview.ended ? t('admin.workflowBuilder.previewEnded', { disposition: preview.ended }) : t('admin.workflowBuilder.previewWaits')}</li>
            </ol>
          )}
        </section>
      )}
    </div>
  );
};

export default WorkflowBuilder;
