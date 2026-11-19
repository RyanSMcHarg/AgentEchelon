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
  MAX_EVENT_WORKFLOW_STEPS, conditionSources, isMeetingAction, versionEventWorkflowsErrors, type EventStepDef, type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { TASK_STEP_ALONGSIDE } from '../../../../../../backend/lambda/src/lib/task-step.ts';
import { layoutFor, type StepPosition, type WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { HelpToggle, InfoTooltip } from './AdminHelp';
import type { WelcomePromptOption } from './welcomeWorkflow';
import EventWorkflowEditor, {
  StepFields, WorkflowPicker, WorkflowSettings, audienceKey, templateNames, useAudienceLabel, workflowsWith, type WorkflowOptions,
} from './EventWorkflowEditor';
import {
  addStep, atStepLimit, connect, kindOf, kindsFor, removeStep, renameStep, startAt, unreachableSteps, updateStep, type EdgeName, type Kind,
} from './workflowEdits';
import {
  NODE_H, NODE_W, NUDGE, NUDGE_FAR, anchoredErrors, edgePath, edgesOf, planeSize, positionsOf, snap, triggerAt, withWorkflowLayout,
} from './workflowGraph';
import { previewWorkflowRun, type ToolDescriptor, type WorkflowPreview } from '../../services/profileService';
import {
  AWAITED_PARTIES, CONFIRM_POLICIES, awaitedPartyOf, type TaskStateDef, type TaskStateMachine,
} from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import {
  addState, anchoredMachineErrors, connectStates, disconnectStates, machineErrors, orderedStates, removeState, renameState,
  startAtState, updateState, withField,
} from './machineEdits';
import { machineEdgesOf, machinePositionsOf, transitionPath } from './workflowGraph';

type Awaits = TaskStateDef['awaits'];
type Produces = TaskStateDef['produces'];
type Confirm = TaskStateDef['confirm'];
type Terminal = TaskStateDef['terminal'];
type Action = TaskStateDef['action'];
/** A step action as the inspector's JSON box gives it back: an object naming its tool. */
const isAction = (v: unknown): v is Action =>
  !!v && typeof v === 'object'
  && typeof (v as { tool?: unknown }).tool === 'string';
/** How an ending ends: `TerminalKind` in `task-state-machines.ts`, which exports the type and not a list. */
const TERMINAL_KINDS = ['success', 'failure', 'handoff'] as const satisfies readonly NonNullable<Terminal>[];
/** What a step produces when it declares nothing, and who it waits on when it waits on nobody. */
const TEXT_OUTPUT = 'text';
const NO_PARTY = '';
import { routerHeldVariables } from '../../../../../../backend/lambda/src/lib/variables.ts';
import './WorkflowBuilder.css';

type T = (key: string, opts?: Record<string, unknown>) => string;
type Workflows = Record<string, EventWorkflow>;

/** The machines a run's task steps open, as the builder edits them in its task-machine mode. */
export interface TaskMachineSource {
  /** The machine to edit, where the version holds it to edit; undefined for one it does not (a platform machine). */
  of: (key: string) => TaskStateMachine | undefined;
  onChange: (key: string, next: TaskStateMachine) => void;
  /** The deployment can send email, so a step's update can be emailed too. */
  emailConfigured?: boolean;
  /** The participant roles the deployment declares, which an update can address. */
  participantRoles?: readonly string[];
}

/** The palette (mock: Say, Do, Decide), each item a step kind the runtime runs, or a decision the inspector sets. */
export const PALETTE: Array<{ group: 'say' | 'do' | 'decide' | 'finish'; items: Array<Kind | 'condition' | 'deadline'> }> = [
  { group: 'say', items: ['send', 'opening', 'agent', 'prompt'] },
  { group: 'do', items: ['task', 'intake', 'wait', 'meeting'] },
  { group: 'decide', items: ['condition', 'deadline'] },
  { group: 'finish', items: ['end'] },
];
const DRAG_TYPE = 'application/x-ae-workflow-step';
/** A small secondary button, the ports under a selected step. */
const SMALL_BUTTON = ['btn-secondary', 'btn-sm'].join(' ');
type NoticeTo = NonNullable<TaskStateDef['notice']>['to'];
/** The audience select's value for a participant role. */
const ROLE_AUDIENCE = 'role';
/** The audience select's value for an update's audience. */
function noticeAudienceKey(to: NoticeTo | undefined): string {
  if (!to) return '';
  return typeof to === 'string' ? to : ROLE_AUDIENCE;
}
/** The role an update names, or none yet. */
function noticeRoleOf(to: NoticeTo | undefined): string {
  if (!to || typeof to === 'string') return '';
  return to.participantRole;
}

/**
 * How Preview run ends an agent or task step: `absent` only for a task step that names who does the work, who may not be
 * here. An agent step is the run's own assistant's turn (WT118), so it is never absent.
 */
type Ending = 'success' | 'failure' | 'deadline' | 'absent';
const endingsOf = (def: EventStepDef): Ending[] => (def.task ? ['success', 'failure', 'deadline', ...(def.task.by !== undefined ? ['absent' as const] : [])] : ['success', 'failure']);
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
  /**
   * The rules a workflow is held to, where they are not an event workflow's: an intent's workflow (ADR-067 decision 1) is
   * checked by `intentWorkflowErrors`. Absent, `versionEventWorkflowsErrors`.
   */
  validate?: (name: string, wf: EventWorkflow) => string[];
  /**
   * THE TASKS' OWN STEPS, ON THE SAME BUILDER (ADR-067 stage 4): the machine a task step opens, where the version holds it
   * to edit. A selected task step offers its steps, which open on this builder in the task-machine mode, and a way back to
   * the run. Absent, a task step names its machine and nothing opens.
   */
  taskMachines?: TaskMachineSource;
}> = ({ workflows, onChange, layout, onLayoutChange, profileName, serverErrors = [], templates, tools, published, variables, versionTools, classification, welcomeContext, initialWorkflow, validate, taskMachines }) => {
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
  const [view, setView] = useState<'canvas' | 'list'>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches ? 'list' : 'canvas'));
  const [selected, setSelected] = useState<string | null>(null);
  /** The task machine open on the builder, opened from a task step of this run. */
  const [openMachine, setOpenMachine] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ from: string; edge: EdgeName } | null>(null);
  const [dragAt, setDragAt] = useState<{ key: string; at: StepPosition } | null>(null);
  const [said, setSaid] = useState('');
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [previewError, setPreviewError] = useState<string[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [endings, setEndings] = useState<Record<string, Ending>>({});
  const drag = useRef<{ key: string; x0: number; y0: number; from: StepPosition; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const focusNext = useRef<string | null>(null);
  const plane = useRef<HTMLDivElement | null>(null);
  const { messages, prompts } = templateNames(templates);

  const wf = workflows[name];
  const saved = layout?.[name];
  const positions = useMemo(() => (wf ? positionsOf(wf, saved) : {}), [wf, saved]);
  const drawn = (key: string): StepPosition => (dragAt?.key === key ? dragAt.at : positions[key]);
  const errors = useMemo(() => (wf ? [...new Set([...(validate ? validate(name, wf) : versionEventWorkflowsErrors({ [name]: wf }, { lookup: routerHeldVariables(variables).lookup })), ...serverErrors])] : []), [wf, name, serverErrors, variables, validate]);
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
    if (def.send?.in === 'opener') return t('admin.workflowBuilder.detail_sendInOpener', { template: def.send.template });
    if (def.send?.in === 'opened') return t('admin.workflowBuilder.detail_sendInOpened', { template: def.send.template });
    if (def.send) return t('admin.workflowBuilder.detail_send', { template: def.send.template, to: toLabel(def.send.to) });
    if (def.agent) return t('admin.workflowBuilder.detail_agent', { template: def.agent.prompt, to: toLabel(def.agent.to) });
    if (def.task) return t(def.task.continue === TASK_STEP_ALONGSIDE ? 'admin.workflowBuilder.detail_taskAlongside' : 'admin.workflowBuilder.detail_task', { machine: def.task.machine });
    if (def.wait?.child !== undefined) return t('admin.workflowBuilder.detail_waitChild');
    if (def.wait?.alongside !== undefined) return t('admin.workflowBuilder.detail_waitAlongside');
    if (def.wait?.join) return t(def.wait.join.when === 'any' ? 'admin.workflowBuilder.detail_waitJoinAny' : 'admin.workflowBuilder.detail_waitJoinAll', { parts: def.wait.join.of.join(', ') });
    if (def.wait?.until !== undefined) return t('admin.workflowBuilder.detail_waitUntil', { until: def.wait.until });
    if (def.wait) return t('admin.workflowBuilder.detail_wait', { minutes: def.wait.minutes });
    if (isMeetingAction(def.action)) {
      return def.action.ringSeconds === undefined
        ? t('admin.workflowBuilder.detail_meetingDefault')
        : t('admin.workflowBuilder.detail_meeting', { seconds: def.action.ringSeconds });
    }
    if (def.action) return t('admin.workflowBuilder.detail_intake', { to: toLabel(def.action.to) });
    if (def.open) return t('admin.workflowBuilder.detail_open', { type: def.open.type });
    if (def.opening) return t('admin.workflowBuilder.detail_opening');
    if (def.prompt) return t('admin.workflowBuilder.detail_prompt', { template: def.prompt.template });
    return t('admin.workflowBuilder.detail_end', { disposition: def.disposition ?? 'success' });
  };
  const edgeText = (value: EventStepDef['onSuccess']): string => (value === undefined ? t('admin.workflowBuilder.edgeEnd')
    : typeof value === 'string' ? value : value.map((a) => a.to).join(', '));

  /** Add a step from the palette: after the selected step, or where it was dropped. */
  const addKind = (kind: Kind, at?: StepPosition) => {
    if (!wf || atStepLimit(wf)) return;
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
        <EventWorkflowEditor workflows={workflows} initialSelected={name} onSelect={setName} templates={templates} tools={tools} published={published} variables={variables} versionTools={versionTools} classification={classification} welcomeContext={welcomeContext} assistant={profileName}
          onChange={(next) => change(next ?? {})} />
      </div>
    );
  }

  const { width, height } = planeSize({ ...positions, ...(dragAt ? { [dragAt.key]: dragAt.at } : {}) });
  const trigger = wf ? triggerAt(wf, positions) : { x: 0, y: 0 };
  const sources = wf ? [...conditionSources(wf, variables)].sort() : [];
  const paused = wf ? Object.entries(wf.states).filter(([, d]) => d.agent || d.task).map(([k, d]) => [k, endingsOf(d)] as const) : [];
  const visited = new Set(preview?.steps.map((s) => s.step) ?? []);
  // A STEP NO EDGE FROM THE START REACHES never runs: flagged on its node and in its inspector, and never refused.
  const unreached = new Set(wf ? unreachableSteps(wf) : []);
  const selectedDef = selected && wf?.states[selected] ? wf.states[selected] : undefined;

  // A TASK'S OWN STEPS, OPENED FROM ITS STEP (ADR-067 stage 4): the same builder in its task-machine mode, and back.
  const machineOpen = openMachine ? taskMachines?.of(openMachine) : undefined;
  if (openMachine && machineOpen && taskMachines) {
    return (
      <div className="admin-wfb" data-testid="workflow-builder-machine">
        <button type="button" className="btn-link" data-testid="wfb-machine-back" onClick={() => setOpenMachine(null)}>
          ← {t('admin.workflowBuilder.backToRun', { workflow: name })}
        </button>
        <h4>{t('admin.workflowBuilder.machineTitle', { machine: openMachine })}</h4>
        <TaskMachineBuilder name={openMachine} machine={machineOpen} tools={tools} versionTools={versionTools} serverErrors={serverErrors}
          templates={templates} emailConfigured={taskMachines?.emailConfigured} participantRoles={taskMachines?.participantRoles}
          onChange={(next) => taskMachines.onChange(openMachine, next)} />
      </div>
    );
  }

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
            {/* A WORKFLOW AT ITS STEP LIMIT TAKES NO MORE (MAX_EVENT_WORKFLOW_STEPS), so no addition makes it one the server refuses. */}
            {atStepLimit(wf) && <p className="admin-field-hint" role="status" data-testid="wfb-step-limit">{t('admin.workflowBuilder.atStepLimit', { max: MAX_EVENT_WORKFLOW_STEPS })}</p>}
            {PALETTE.map(({ group, items }) => (
              <div key={group} className="admin-wfb-group">
                <h5>{t(`admin.workflowBuilder.group_${group}`)}</h5>
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
                  if (!kindsFor(wf.on, wf.types).includes(item)) return null;
                  return (
                    <button key={item} type="button" className={cls('admin-wfb-pal', 'admin-wfb-kind-' + item)} draggable={!atStepLimit(wf)} disabled={atStepLimit(wf)} data-testid={'wfb-palette-' + item}
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
                          unreached.has(key) ? t('admin.workflowEditor.unreached', { step: key }) : '',
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
                        {unreached.has(key) && <span className="admin-wfb-node-problems" data-testid={`wfb-node-${key}-unreached`}>{t('admin.workflowBuilder.unreached')}</span>}
                        {own.length > 0 && <span className="admin-wfb-node-problems" data-testid={`wfb-node-${key}-problems`}>{t('admin.workflowBuilder.problemsOn', { count: own.length })}</span>}
                      </button>
                      {isSelected && !def.disposition && !connecting && (
                        <div className="admin-wfb-ports" role="group" aria-label={t('admin.workflowBuilder.portsLabel', { step: key })}>
                          <button type="button" className={SMALL_BUTTON} data-testid={`wfb-add-after-${key}`}
                            aria-label={t('admin.workflowBuilder.addAfter', { step: key })} disabled={atStepLimit(wf)} onClick={() => addKind('send')}>+</button>
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
                  <h5>{selected}</h5>
                  <button type="button" className="btn-link" data-testid="wfb-deselect" onClick={() => setSelected(null)}>{t('admin.workflowBuilder.deselect')}</button>
                </div>
                {(anchored.steps[selected] ?? []).length > 0 && (
                  <ul role="alert" className="admin-error" data-testid="wfb-step-errors">
                    {anchored.steps[selected].map((e) => <li key={e}>{e}</li>)}
                  </ul>
                )}
                {unreached.has(selected) && (
                  <p role="note" className="admin-field-hint" data-testid="wfb-step-unreached">{t('admin.workflowEditor.unreached', { step: selected })}</p>
                )}
                <StepFields key={selected} wf={wf} stepKey={selected} testId="wfb-step" templates={templates} tools={tools} published={published} variables={variables} versionTools={versionTools} classification={classification} welcomeContext={welcomeContext}
                  onChange={(def) => put(updateStep(wf, selected, def))} onWorkflow={put}
                  onRename={(to) => {
                    const next = renameStep(wf, selected, to);
                    if (!next) return;
                    const { [selected]: point, ...rest } = positions;
                    put(next, { ...rest, [to]: point });
                    setSelected(to);
                  }} />
                {selectedDef.task && taskMachines && (
                  taskMachines.of(selectedDef.task.machine)
                    ? (
                      <button type="button" className="btn-secondary" data-testid="wfb-open-machine" onClick={() => setOpenMachine(selectedDef.task!.machine)}>
                        {t('admin.workflowBuilder.openMachine', { machine: selectedDef.task.machine })}
                      </button>
                    )
                    : <p className="admin-field-hint" data-testid="wfb-machine-not-held">{t('admin.workflowBuilder.machineNotHeld', { machine: selectedDef.task.machine })}</p>
                )}
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
                <WorkflowSettings name={name} wf={wf} onPut={(next) => put(next)} classification={classification} assistant={profileName} onRemove={() => {
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
          <h5 id="wfb-preview-title">{t('admin.workflowBuilder.previewTitle')}</h5>
          <p className="admin-field-hint">{profileName ? t('admin.workflowBuilder.previewHelp') : t('admin.workflowBuilder.previewUnavailable')}</p>
          <div className="admin-filter-group">
            {sources.map((src) => (
              <label key={src}><span className="admin-field-label">{t('admin.workflowBuilder.previewValue', { source: src })}</span>
                <input type="text" className="input" data-testid={`wfb-sample-${src}`} value={sample[src] ?? ''} onChange={(e) => setSample({ ...sample, [src]: e.target.value })} />
              </label>
            ))}
            {paused.map(([step, offered]) => (
              <label key={step}><span className="admin-field-label">{t('admin.workflowBuilder.previewEnding', { step })}</span>
                <select className="select" data-testid={`wfb-ending-${step}`} value={endings[step] ?? 'success'}
                  onChange={(e) => setEndings({ ...endings, [step]: e.target.value as Ending })}>
                  {offered.map((o) => <option key={o} value={o}>{t(`admin.workflowBuilder.ending_${o}`)}</option>)}
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

/**
 * THE BUILDER'S TASK-MACHINE MODE (ADR-066 build step 3, ADR-067 stage 1): an intent's task steps on the same canvas, with
 * the same nodes, ports, announcements and inspector layout as an event workflow, editing a `TaskStateMachine` rather
 * than an `EventWorkflow`.
 *
 * WHAT IT OFFERS is what `TaskStateDef` declares and the runtime runs: who a step waits on and the choices on its card,
 * what it needs recorded, the tools it may use and must use, what it produces, whether it is put to the person, whether
 * it rests, and how an ending ends and what it may reopen. A step's `action` is drawn and kept, and edited as JSON (its
 * arguments bind to recorded requirements, which the inspector cannot check). A machine may loop, so a transition back
 * to an earlier step is drawn around the side and never refused.
 *
 * THE RULES ARE THE RUNTIME'S: the status line is `validateTaskStateMachine`, the check a deployed machine is held to,
 * and the errors of the draft's last Validate are anchored to the step they name.
 *
 * WHERE A STEP SITS is its saved point, else computed from its distance from the first step. Dragging a step, or moving
 * it with the arrow keys, hands every step's current point to `onLayoutChange`, which the page saves with the machine
 * into the version's layout under `machine:<intent>` (`machineLayoutKey`), never part of what the version does.
 */
export const TaskMachineBuilder: React.FC<{
  /** The intent the machine is keyed by. */
  name: string;
  machine: TaskStateMachine;
  onChange: (next: TaskStateMachine) => void;
  tools: ToolDescriptor[];
  /** The version's own tools: a step may offer or require only these (Validate refuses any other). Absent, any. */
  versionTools?: readonly string[];
  /** The errors of the draft's last Validate. */
  serverErrors?: readonly string[];
  /** This machine's saved points, by state. */
  layout?: Readonly<Record<string, StepPosition>>;
  /** Every state's point after a step is moved. Absent, steps are not moved. */
  onLayoutChange?: (points: Record<string, StepPosition>) => void;
  /** The templates a step's update can say. */
  templates?: WelcomePromptOption[];
  /** The deployment can send email, so a step's update can be emailed too. */
  emailConfigured?: boolean;
  /** The participant roles the deployment declares, which an update can address. */
  participantRoles?: readonly string[];
  /**
   * The model a step runs on, as the page edits it on the version's route (`models.byIntent[<intent>].steps`), shown
   * beside what the step produces. The route is not part of the machine, so the page owns the control and its save.
   */
  renderStepModel?: (state: string, def: TaskStateDef) => React.ReactNode;
  /** The step shown selected when the builder opens, as a link to one step opens it. */
  initialStep?: string;
}> = ({ name, machine, onChange, tools, versionTools, serverErrors = [], layout, onLayoutChange, templates, emailConfigured, participantRoles = [], initialStep, renderStepModel }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  /** A field's label with its tooltip. */
  const fieldLabel = (field: string) => {
    const label = t(`admin.machineBuilder.field.${field}`);
    const tip = t(`admin.machineBuilder.tip.${field}`);
    return <>{label} <InfoTooltip label={label} content={tip} /></>;
  };
  const [selected, setSelected] = useState<string | null>(initialStep && machine.states[initialStep] ? initialStep : null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [rename, setRename] = useState('');
  // AN UPDATE ENTERS THE MACHINE WHOLE: its audience is held here until a template is chosen, so the steps stay valid while it is filled in.
  const [pendingNotice, setPendingNotice] = useState<{ state: string | null; to: NoticeTo } | null>(null);
  const [actionText, setActionText] = useState('');
  const plane = useRef<HTMLDivElement | null>(null);
  const focusNext = useRef<string | null>(null);
  const [dragAt, setDragAt] = useState<{ key: string; at: StepPosition } | null>(null);
  const drag = useRef<{ key: string; x0: number; y0: number; from: StepPosition; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const positions = useMemo(() => {
    const auto = machinePositionsOf(machine);
    return Object.fromEntries(Object.keys(machine.states).map((k) => [k, layout?.[k] ?? auto[k]]));
  }, [machine, layout]);
  const drawn = (key: string): StepPosition => (dragAt?.key === key ? dragAt.at : positions[key]);
  /** Save where a step sits: every state's current point, so the machine stays as the person sees it. */
  const place = (key: string, at: StepPosition) => {
    if (!onLayoutChange) return;
    const point = { x: Math.max(0, snap(at.x)), y: Math.max(0, snap(at.y)) };
    onLayoutChange({ ...positions, [key]: point });
    setSaid(t('admin.workflowBuilder.announce_moved', { step: key, x: point.x, y: point.y }));
  };
  const onNodeKey = (e: React.KeyboardEvent, key: string) => {
    if (e.key === 'Escape' && connecting) { setConnecting(null); setSaid(t('admin.workflowBuilder.announce_cancelled')); e.preventDefault(); return; }
    const step = e.shiftKey ? NUDGE_FAR : NUDGE;
    const by: Record<string, StepPosition> = { ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step }, ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 } };
    const d = by[e.key];
    if (!d || !onLayoutChange) return;
    e.preventDefault();
    const at = positions[key];
    place(key, { x: at.x + d.x, y: at.y + d.y });
  };
  const errors = useMemo(() => [...new Set([...machineErrors(name, machine), ...serverErrors])], [name, machine, serverErrors]);
  const anchored = useMemo(() => anchoredMachineErrors(errors, name, machine), [errors, name, machine]);
  const toolNames = useMemo(() => (versionTools ? [...versionTools] : tools.map((x) => x.name)).sort(), [tools, versionTools]);
  const def = selected ? machine.states[selected] : undefined;
  const noticeTo = def?.notice?.to ?? (pendingNotice?.state === selected ? pendingNotice?.to : undefined);
  const noticeRole = noticeRoleOf(noticeTo);

  useEffect(() => {
    if (!focusNext.current) return;
    plane.current?.querySelector<HTMLButtonElement>(`[data-step="${focusNext.current}"]`)?.focus();
    focusNext.current = null;
  });
  useEffect(() => {
    setRename(selected ?? '');
    setActionText(def?.action ? JSON.stringify(def.action, null, 2) : '');
    // Re-seeded when another step is selected, not on every edit of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const add = () => {
    const { machine: next, key } = addState(machine, selected ? { after: selected } : {});
    onChange(next);
    setSelected(key);
    focusNext.current = key;
    setSaid(t('admin.workflowBuilder.announce_added', { step: key }));
  };
  const activate = (key: string) => {
    if (connecting) {
      onChange(connectStates(machine, connecting, key));
      setSaid(t('admin.machineBuilder.announce_connected', { from: connecting, to: key }));
      focusNext.current = connecting;
      setConnecting(null);
      return;
    }
    setSelected(key);
  };
  const put = (next: TaskStateDef) => { if (selected) onChange(updateState(machine, selected, next)); };
  const set = <K extends keyof TaskStateDef>(field: K, value: TaskStateDef[K] | undefined) => { if (def) put(withField(def, field, value)); };
  const lines = (v: string): string[] => v.split('\n').map((s) => s.trim()).filter(Boolean);
  const toggle = (list: readonly string[] | undefined, item: string, on: boolean): string[] => (on ? [...new Set([...(list ?? []), item])] : (list ?? []).filter((x) => x !== item));
  const isEnding = (d: TaskStateDef) => !d.transitions.length;
  const partyOf = (d: TaskStateDef): string => awaitedPartyOf(d)?.party ?? NO_PARTY;
  const detailOf = (key: string, d: TaskStateDef): string => {
    if (isEnding(d)) return t('admin.machineBuilder.detail_end', { disposition: t(`admin.machineBuilder.terminal_${d.terminal ?? 'success'}`) });
    const party = partyOf(d);
    if (party) return t('admin.machineBuilder.detail_awaits', { party: t(`admin.machineBuilder.party_${party}`) });
    if (d.action) return t('admin.machineBuilder.detail_action', { tool: d.action.tool });
    return t('admin.machineBuilder.detail_assistant', { step: key });
  };
  const { width, height } = planeSize({ ...positions, ...(dragAt ? { [dragAt.key]: dragAt.at } : {}) });

  return (
    <div className="admin-wfb" data-testid="machine-builder">
      <div className="admin-wfb-bar">
        <span className="admin-wfb-badge">{t('admin.machineBuilder.title', { name })}</span>
        <div className="admin-wfb-actions">
          <span role="status" data-testid="mb-status" className={errors.length ? 'admin-wfb-status-bad' : 'admin-wfb-status-ok'}>
            {errors.length ? t('admin.workflowBuilder.problems', { count: errors.length }) : t('admin.machineBuilder.valid')}
          </span>
          <button type="button" className="btn-secondary" data-testid="mb-add" onClick={add}>{t('admin.machineBuilder.addStep')}</button>
          <HelpToggle label={t('admin.machineBuilder.helpLabel')} testId="mb-help">
            <p>{t('admin.machineBuilder.help')}</p>
          </HelpToggle>
        </div>
      </div>
      <p className="admin-field-hint" id="mb-keys">{t('admin.machineBuilder.keysHelp')}</p>
      <p className="admin-wfb-live" aria-live="polite" data-testid="mb-announce">{said}</p>
      {anchored.machine.length > 0 && (
        <ul role="alert" className="admin-error" data-testid="mb-machine-errors">{anchored.machine.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      <div className={cls('admin-wfb-body', 'admin-wfb-body-two')}>
        <div className="admin-wfb-canvas" data-testid="mb-canvas">
          <div ref={plane} className="admin-wfb-plane" style={{ width: width + 64, height }}>
            <svg className="admin-wfb-edges" width={width + 64} height={height} aria-hidden="true">
              <defs>
                <marker id="mb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="admin-wfb-arrow" />
                </marker>
              </defs>
              {machineEdgesOf(machine).map((edge) => {
                const { d } = transitionPath(drawn(edge.from), drawn(edge.to));
                const choice = machine.states[edge.from].choices?.includes(edge.to);
                return (
                  <path key={`${edge.from}-${edge.to}`} d={d} markerEnd="url(#mb-arrow)" data-testid={`mb-edge-${edge.from}-${edge.to}`}
                    className={cls('admin-wfb-edge', choice ? 'admin-wfb-edge-when' : 'admin-wfb-edge-onSuccess')} />
                );
              })}
            </svg>
            <ul className="admin-wfb-nodes" aria-label={t('admin.machineBuilder.canvasLabel', { name })}>
              {orderedStates(machine).map((key) => {
                const d = machine.states[key];
                const at = drawn(key);
                const own = anchored.states[key] ?? [];
                const isSelected = selected === key;
                return (
                  <li key={key} className="admin-wfb-node-wrap" style={{ left: at.x, top: at.y, width: NODE_W }}>
                    <button type="button" data-step={key} data-testid={`mb-node-${key}`} aria-pressed={isSelected} aria-describedby="mb-keys"
                      aria-label={[
                        t('admin.machineBuilder.stepLabel', { name: key, detail: detailOf(key, d) }),
                        d.transitions.length ? t('admin.machineBuilder.goesTo', { steps: d.transitions.join(', ') }) : '',
                        key === machine.initial ? t('admin.workflowBuilder.isStart') : '',
                        own.length ? t('admin.workflowBuilder.problemsOn', { count: own.length }) : '',
                        connecting && connecting !== key ? t('admin.workflowBuilder.connectHere') : '',
                      ].filter(Boolean).join(' ')}
                      className={cls('admin-wfb-node', isEnding(d) ? 'admin-wfb-kind-end' : partyOf(d) ? 'admin-wfb-kind-task' : 'admin-wfb-kind-agent',
                        isSelected && 'admin-wfb-node-selected', own.length > 0 && 'admin-wfb-node-error', connecting && connecting !== key && 'admin-wfb-node-target')}
                      style={{ minHeight: NODE_H }}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || connecting || !onLayoutChange) return;
                        drag.current = { key, x0: e.clientX, y0: e.clientY, from: positions[key], moved: false };
                        e.currentTarget.setPointerCapture?.(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const g = drag.current;
                        if (!g || g.key !== key) return;
                        const dx = e.clientX - g.x0;
                        const dy = e.clientY - g.y0;
                        if (!g.moved && Math.hypot(dx, dy) < 4) return;
                        g.moved = true;
                        setDragAt({ key, at: { x: Math.max(0, g.from.x + dx), y: Math.max(0, g.from.y + dy) } });
                      }}
                      onPointerUp={(e) => {
                        const g = drag.current;
                        drag.current = null;
                        if (!g || !g.moved) return;
                        suppressClick.current = true;
                        setDragAt(null);
                        place(key, { x: g.from.x + e.clientX - g.x0, y: g.from.y + e.clientY - g.y0 });
                      }}
                      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } activate(key); }}
                      onKeyDown={(e) => onNodeKey(e, key)}>
                      <span className="admin-wfb-badge">{d.label ?? key}{key === machine.initial ? ` · ${t('admin.workflowBuilder.start')}` : ''}</span>
                      <span className="admin-wfb-title">{key}</span>
                      <span className="admin-wfb-detail">{detailOf(key, d)}</span>
                      {own.length > 0 && <span className="admin-wfb-node-problems" data-testid={`mb-node-${key}-problems`}>{t('admin.workflowBuilder.problemsOn', { count: own.length })}</span>}
                    </button>
                    {isSelected && !connecting && (
                      <div className="admin-wfb-ports" role="group" aria-label={t('admin.workflowBuilder.portsLabel', { step: key })}>
                        <button type="button" className={SMALL_BUTTON} data-testid={`mb-add-after-${key}`} aria-label={t('admin.workflowBuilder.addAfter', { step: key })} onClick={add}>+</button>
                        <button type="button" className={SMALL_BUTTON} data-testid={`mb-port-${key}`}
                          onClick={() => { setConnecting(key); setSaid(t('admin.machineBuilder.connecting', { step: key })); }}>
                          {t('admin.machineBuilder.connect')}
                        </button>
                        {d.transitions.map((to) => (
                          <button key={to} type="button" className={SMALL_BUTTON} data-testid={`mb-disconnect-${to}`}
                            aria-label={t('admin.machineBuilder.disconnectFrom', { step: to })}
                            onClick={() => onChange(disconnectStates(machine, key, to))}>
                            × {to}
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
            <p className="admin-wfb-connecting" data-testid="mb-connecting">
              {t('admin.machineBuilder.connecting', { step: connecting })}
              {' '}<button type="button" className="btn-link" onClick={() => setConnecting(null)}>{t('admin.workflowBuilder.cancel')}</button>
            </p>
          )}
        </div>

        <aside className="admin-wfb-inspector" aria-label={t('admin.workflowBuilder.inspector')} data-testid="mb-inspector">
          {!def || !selected ? <p className="admin-field-hint">{t('admin.machineBuilder.inspectorNone')}</p> : (
            <>
              <div className="admin-wfb-inspector-head">
                <h5>{selected}</h5>
                <button type="button" className="btn-link" data-testid="mb-deselect" onClick={() => setSelected(null)}>{t('admin.workflowBuilder.deselect')}</button>
              </div>
              {(anchored.states[selected] ?? []).length > 0 && (
                <ul role="alert" className="admin-error" data-testid="mb-step-errors">{anchored.states[selected].map((e) => <li key={e}>{e}</li>)}</ul>
              )}
              <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('name')}</span>
                <input className="input" data-testid="mb-name" value={rename} onChange={(e) => setRename(e.target.value)}
                  onBlur={() => {
                    const next = renameState(machine, selected, rename.trim());
                    if (next && rename.trim() !== selected) { onChange(next); setSelected(rename.trim()); } else setRename(selected);
                  }} />
              </label>
              <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('label')}</span>
                <input className="input" data-testid="mb-label" value={def.label ?? ''} onChange={(e) => set('label', e.target.value)} />
              </label>
              {/* AN UPDATE ON ENTRY (WT23): a message template said to the room, the requester, the worker or a role, once per entry. */}
              <fieldset className="admin-wfb-field" data-testid="mb-notice">
                <legend className="admin-field-label">{fieldLabel('notice')}</legend>
                <select className="select" data-testid="mb-notice-to" value={noticeAudienceKey(noticeTo)}
                  onChange={(e) => {
                    const key = e.target.value;
                    const to: NoticeTo | null = !key ? null : key === ROLE_AUDIENCE ? { participantRole: noticeRoleOf(noticeTo) || participantRoles[0] } : key as NoticeTo;
                    setPendingNotice(to && !def.notice ? { state: selected, to } : null);
                    if (!to) set('notice', undefined);
                    else if (def.notice) set('notice', { ...def.notice, to });
                  }}>
                  <option value="">{t('admin.machineBuilder.notice_none')}</option>
                  <option value="room">{t('admin.machineBuilder.notice_room')}</option>
                  <option value="requester">{t('admin.machineBuilder.party_requester')}</option>
                  <option value="worker">{t('admin.machineBuilder.party_worker')}</option>
                  {participantRoles.length > 0 && <option value={ROLE_AUDIENCE}>{t('admin.machineBuilder.notice_role')}</option>}
                </select>
                {noticeRole && (
                  <select className="select" data-testid="mb-notice-role" aria-label={t('admin.machineBuilder.noticeRole')} value={noticeRole}
                    onChange={(e) => {
                      const to = { participantRole: e.target.value };
                      if (def.notice) set('notice', { ...def.notice, to });
                      else setPendingNotice({ state: selected, to });
                    }}>
                    {[...new Set([...participantRoles, noticeRole])].sort().map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                )}
                {noticeTo && (
                  <select className="select" data-testid="mb-notice-template" aria-label={t('admin.machineBuilder.noticeTemplate')} value={def.notice?.template ?? ''}
                    onChange={(e) => {
                      const template = e.target.value;
                      setPendingNotice(template ? null : { state: selected, to: noticeTo });
                      set('notice', template ? { ...(def.notice ?? {}), to: noticeTo, template } : undefined);
                    }}>
                    <option value="">{t('admin.machineBuilder.noticeTemplate')}</option>
                    {[...new Set([...templateNames(templates).messages, ...(def.notice?.template ? [def.notice.template] : [])])].sort().map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                )}
                {def.notice && emailConfigured && (
                  <label><input type="checkbox" data-testid="mb-notice-email" checked={!!def.notice.email}
                    onChange={(e) => {
                      const { email: _email, ...rest } = def.notice!;
                      set('notice', e.target.checked ? { ...rest, email: true } : rest);
                    }} /> {t('admin.machineBuilder.noticeEmail')}</label>
                )}
              </fieldset>
              <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('prompt')}</span>
                <textarea className="textarea" rows={3} data-testid="mb-prompt" value={def.prompt ?? ''} onChange={(e) => set('prompt', e.target.value)} />
              </label>

              {!isEnding(def) && (
                <>
                  <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('awaits')}</span>
                    <select className="select" data-testid="mb-awaits" value={partyOf(def)} onChange={(e) => {
                      const { awaitsUser: _u, ...rest } = def;
                      const party = e.target.value;
                      // Waiting on somebody means the step no longer rests or moves on its own: the person's answer moves it.
                      const waiting = { ...withField(withField(rest, 'rests', undefined), 'auto', undefined), awaits: { party } as Awaits };
                      // A step nobody waits on is worked by the assistant, so what is asked of a person goes with the waiting: its card's
                      // choices, what it requires, and its presentation (confirmation and brief), which the validator refuses on it.
                      const working = (['awaits', 'choices', 'requires', 'presented', 'confirm', 'brief'] as const)
                        .reduce<TaskStateDef>((d, f) => withField(d, f, undefined), rest);
                      put(party ? waiting : working);
                    }}>
                      <option value="">{t('admin.machineBuilder.party_none')}</option>
                      {AWAITED_PARTIES.map((p) => <option key={p} value={p}>{t(`admin.machineBuilder.party_${p}`)}</option>)}
                    </select>
                  </label>
                  {partyOf(def) ? (
                    <fieldset className="admin-wfb-field" data-testid="mb-choices">
                      <legend className="admin-field-label">{fieldLabel('choices')}</legend>
                      {def.transitions.map((to) => (
                        <label key={to}><input type="checkbox" data-testid={`mb-choice-${to}`} checked={!!def.choices?.includes(to)}
                          onChange={(e) => set('choices', toggle(def.choices, to, e.target.checked))} /> <code>{to}</code></label>
                      ))}
                    </fieldset>
                  ) : (
                    <>
                      <label><input type="checkbox" data-testid="mb-rests" checked={!!def.rests}
                        onChange={(e) => put(e.target.checked ? { ...withField(def, 'auto', undefined), rests: true } : withField(def, 'rests', undefined))} /> {t('admin.machineBuilder.field.rests')}</label>
                      {/* THE DECLARED MOVE (G39): taken by the runtime once this step's turn answers, on one of its own edges. */}
                      {!def.rests && (
                        <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('auto')}</span>
                          <select className="select" data-testid="mb-auto" value={def.auto ?? ''} onChange={(e) => set('auto', e.target.value || undefined)}>
                            <option value="">{t('admin.machineBuilder.auto_none')}</option>
                            {def.transitions.map((to) => <option key={to} value={to}>{to}</option>)}
                          </select>
                        </label>
                      )}
                    </>
                  )}
                  <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('requires')}</span>
                    <textarea className="textarea" rows={2} data-testid="mb-requires" value={(def.requires ?? []).join('\n')} onChange={(e) => {
                      // A need no longer required is no longer recorded as a typed value either.
                      const requires = lines(e.target.value);
                      const records = Object.fromEntries(Object.entries(def.records ?? {}).filter(([n]) => requires.includes(n)));
                      put(withField(withField(def, 'requires', requires), 'records', Object.keys(records).length ? records : undefined));
                    }} />
                  </label>
                  {/* A NEED RECORDED AS A TYPED VALUE (WT22), which a condition compares: as text, a number, or yes or no. */}
                  {(def.requires ?? []).length > 0 && (
                    <fieldset className="admin-wfb-field" data-testid="mb-records">
                      <legend className="admin-field-label">{fieldLabel('records')}</legend>
                      {(def.requires ?? []).map((need) => (
                        <label key={need} className="admin-filter-group"><code>{need}</code>
                          <select className="select" data-testid={`mb-record-${need}`} value={def.records?.[need] ?? ''}
                            onChange={(e) => {
                              const { [need]: _dropped, ...rest } = def.records ?? {};
                              const type = e.target.value as 'number' | 'boolean' | 'time' | '';
                              const next = type ? { ...rest, [need]: type } : rest;
                              set('records', Object.keys(next).length ? next : undefined);
                            }}>
                            <option value="">{t('admin.machineBuilder.record_text')}</option>
                            <option value="number">{t('admin.machineBuilder.record_number')}</option>
                            <option value="boolean">{t('admin.machineBuilder.record_boolean')}</option>
                            <option value="time">{t('admin.machineBuilder.record_time')}</option>
                          </select>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <fieldset className="admin-wfb-field" data-testid="mb-tools">
                    <legend className="admin-field-label">{fieldLabel('tools')}</legend>
                    {toolNames.map((tool) => (
                      <div key={tool} className="admin-filter-group">
                        <code>{tool}</code>
                        <label><input type="checkbox" data-testid={`mb-tool-${tool}`} checked={!!def.tools?.includes(tool)}
                          onChange={(e) => set('tools', toggle(def.tools, tool, e.target.checked))} /> {t('admin.machineBuilder.offered')}</label>
                        <label><input type="checkbox" data-testid={`mb-requires-tool-${tool}`} checked={!!def.requiresTool?.includes(tool)}
                          onChange={(e) => set('requiresTool', toggle(def.requiresTool, tool, e.target.checked))} /> {t('admin.machineBuilder.required')}</label>
                      </div>
                    ))}
                  </fieldset>
                  <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('produces')}</span>
                    <select className="select" data-testid="mb-produces" value={def.produces ?? 'text'} onChange={(e) => set('produces', e.target.value === TEXT_OUTPUT ? undefined : e.target.value as Produces)}>
                      {(['text', 'document', 'image'] as const).map((p) => <option key={p} value={p}>{t(`admin.machineBuilder.produces_${p}`)}</option>)}
                    </select>
                  </label>
                  {renderStepModel && selected && (
                    <div className="admin-wfb-field" data-testid="mb-step-model">
                      <span className="admin-field-label">{fieldLabel('model')}</span>
                      {renderStepModel(selected, def)}
                    </div>
                  )}
                  <label><input type="checkbox" data-testid="mb-presented" checked={!!def.presented} onChange={(e) => {
                    put(e.target.checked ? { ...def, presented: true } : withField(withField(withField(def, 'presented', undefined), 'confirm', undefined), 'brief', undefined));
                  }} /> {t('admin.machineBuilder.field.presented')}</label>
                  {def.presented && (
                    <>
                      <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('confirm')}</span>
                        <select className="select" data-testid="mb-confirm" value={def.confirm ?? ''} onChange={(e) => set('confirm', (e.target.value || undefined) as Confirm)}>
                          <option value="">{t('admin.machineBuilder.confirm_none')}</option>
                          {CONFIRM_POLICIES.map((c) => <option key={c} value={c}>{t(`admin.machineBuilder.confirm_${c}`)}</option>)}
                        </select>
                      </label>
                      {def.confirm && (
                        <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('brief')}</span>
                          <textarea className="textarea" rows={2} data-testid="mb-brief" value={(def.brief ?? []).join('\n')} onChange={(e) => set('brief', lines(e.target.value))} />
                        </label>
                      )}
                    </>
                  )}
                </>
              )}

              {isEnding(def) && (
                <>
                  <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('terminal')}</span>
                    <select className="select" data-testid="mb-terminal" value={def.terminal ?? ''} onChange={(e) => set('terminal', (e.target.value || undefined) as Terminal)}>
                      {/* AN ENDING WITH NO DISPOSITION SHOWS AS UNSET, so choosing one is a change the validator then accepts. */}
                      {!def.terminal && <option value="" className="select-placeholder" disabled hidden>{t('admin.machineBuilder.terminal_unset')}</option>}
                      {TERMINAL_KINDS.map((k) => <option key={k} value={k}>{t(`admin.machineBuilder.terminal_${k}`)}</option>)}
                    </select>
                  </label>
                  <fieldset className="admin-wfb-field" data-testid="mb-reopens">
                    <legend className="admin-field-label">{fieldLabel('reopens')}</legend>
                    {orderedStates(machine).filter((k) => k !== selected && !isEnding(machine.states[k])).map((k) => (
                      <label key={k}><input type="checkbox" data-testid={`mb-reopen-${k}`} checked={!!def.reopens?.includes(k)}
                        onChange={(e) => set('reopens', toggle(def.reopens, k, e.target.checked))} /> <code>{k}</code></label>
                    ))}
                  </fieldset>
                </>
              )}

              {def.action && (
                <label className="admin-wfb-field"><span className="admin-field-label">{fieldLabel('action')}</span>
                  <textarea className="textarea" rows={4} data-testid="mb-action" value={actionText} onChange={(e) => setActionText(e.target.value)}
                    onBlur={() => {
                      try {
                        const parsed: unknown = JSON.parse(actionText);
                        if (isAction(parsed)) set('action', parsed);
                        else setActionText(JSON.stringify(def.action, null, 2));
                      } catch { setActionText(JSON.stringify(def.action, null, 2)); }
                    }} />
                  <span className="admin-field-hint">{t('admin.machineBuilder.actionHelp', { success: def.onSuccess ?? '-', failure: def.onFailure ?? '-' })}</span>
                </label>
              )}

              <div className="admin-config-actions">
                {selected === machine.initial
                  ? <span className="admin-field-hint">{t('admin.workflowBuilder.isStart')}</span>
                  : <button type="button" className="btn-secondary" data-testid="mb-start-here" onClick={() => onChange(startAtState(machine, selected))}>{t('admin.workflowBuilder.startHere')}</button>}
                <button type="button" className="btn-danger" data-testid="mb-remove-step" disabled={Object.keys(machine.states).length < 2} onClick={() => {
                  onChange(removeState(machine, selected));
                  setSaid(t('admin.workflowBuilder.announce_removed', { step: selected }));
                  setSelected(null);
                }}>{t('admin.workflowEditor.removeStep')}</button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
};
