import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmAction } from './ConfirmAction';
import WorkflowBuilder, { type TaskMachineSource } from './WorkflowBuilder';
import { useTaskMachineSource } from './useTaskMachineSource';
import { InfoTooltip } from './AdminHelp';
import type { ClassificationCatalog, ProfileDefinitionBody, ProfileDraftPatch, ToolDescriptor } from '../../services/profileService';
import {
  asRun, canonicalIntentWorkflow, intentWorkflowErrors, type IntentWorkflow,
} from '../../../../../../backend/lambda/src/lib/intent-workflow.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { intentLayoutKey, type WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import { routerHeldVariables } from '../../../../../../backend/lambda/src/lib/variables.ts';
import type { WelcomePromptOption } from './welcomeWorkflow';

type T = (key: string, opts?: Record<string, unknown>) => string;
type IntentWorkflows = Record<string, IntentWorkflow>;

/**
 * The multi-step intents this version answers, in the order the console lists them: the classification's pack as the
 * catalog reads it, then any the version's own pack adds. A single-turn intent has no workflow.
 */
export function multiStepIntentsOf(
  catalog: Pick<ClassificationCatalog, 'intents'> | undefined,
  config: Pick<ProfileDefinitionBody, 'intentPack'> | null,
): string[] {
  const fromCatalog = (catalog?.intents ?? []).filter((i) => i.multiStep).map((i) => i.key);
  const own = ((config?.intentPack?.intents ?? []) as Array<{ key: string; delivery?: string }>)
    .filter((i) => i.delivery === 'TASK_MULTI_STEP').map((i) => i.key);
  return [...new Set([...fromCatalog, ...own])];
}

/**
 * THE TASKS A WORKFLOW ASSIGNS, EACH WITH ITS STATES: every task step, in the workflow's order, with the
 * machine it opens, who it is for or worked by, and that machine's states from its first, so a workflow is read with the
 * work it creates under it.
 */
export function assignedTasksOf(
  wf: Pick<IntentWorkflow, 'initial' | 'states'>,
  machines: Readonly<Record<string, TaskStateMachine>>,
  /** A machine's states where only a listing of it is held (the classification catalog's), in its listed order. */
  listed?: (machine: string) => readonly string[] | undefined,
): Array<{ step: string; machine: string; states: string[] }> {
  return Object.entries(wf.states ?? {})
    .filter(([, d]) => (d as { task?: unknown }).task)
    .map(([step, d]) => {
      const machine = (d as { task: { machine: string } }).task.machine;
      const m = machines[machine];
      // The machine's states from its first, in the order its transitions reach them.
      const order: string[] = [];
      const visit = (s: string) => { if (!m?.states[s] || order.includes(s)) return; order.push(s); for (const n of m.states[s].transitions) visit(n); };
      if (m) visit(m.initial);
      return { step, machine, states: order.length ? order : [...(listed?.(machine) ?? [])] };
    });
}

/** The intent's workflow as the builder edits it (the run shape), and back as the version stores it. */
export const toRun = (wf: IntentWorkflow): EventWorkflow => asRun(wf);
export const fromRun = (intent: string, wf: EventWorkflow): IntentWorkflow => ({ ...(wf as unknown as IntentWorkflow), on: { intent } });

/**
 * INTENTS: the workflow each multi-step intent runs (ADR-067 decision 1). An intent the version declares none for runs the
 * standard workflow, one task on the intent's machine for the person who asked; customizing it starts from that and adds
 * what comes before and after (a send, an approval, a second task). Edited on the same visual builder as the event
 * workflows, validated by the rules the draft and activation apply (`intentWorkflowErrors`). Where its steps sit is
 * saved with the version's layout under `intent:<intent>`, beside the event workflows' and the machines'.
 */
export const IntentWorkflowsFields: React.FC<{
  config: ProfileDefinitionBody | null;
  catalog?: ClassificationCatalog;
  onPatch: (patch: ProfileDraftPatch) => void;
  profileName?: string;
  tools?: ToolDescriptor[];
  prompts?: WelcomePromptOption[];
  serverErrors?: readonly string[];
  /** The intent the field opens on. */
  focusIntent?: string;
  /** The machines its task steps open, shared with the event workflows' builder so one draft edit holds both. */
  taskMachines?: TaskMachineSource;
  /** The version's whole layout, which the event workflows' builder holds; an intent's points are keyed `intent:<intent>`. */
  layout?: WorkflowLayout;
  onLayoutChange?: (next: WorkflowLayout | null) => void;
}> = ({ config, catalog, onPatch, profileName, tools = [], prompts, serverErrors = [], focusIntent, taskMachines: shared, layout, onLayoutChange }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const intents = useMemo(() => multiStepIntentsOf(catalog, config), [catalog, config]);
  // Every intent the version answers, so a single-turn one's workflow is offered too (the author decides what it does).
  const allIntents = useMemo(() => [...new Set([...intents, ...(catalog?.intents ?? []).map((i) => i.key),
    ...((config?.intentPack?.intents ?? []) as Array<{ key: string }>).map((i) => i.key)])], [intents, catalog, config]);
  const [declared, setDeclared] = useState<IntentWorkflows>(() => ({ ...((config?.intentWorkflows ?? {}) as IntentWorkflows) }));
  const [open, setOpen] = useState<string | undefined>(focusIntent && intents.includes(focusIntent) ? focusIntent : undefined);
  // The intent's own task steps open on the same builder (ADR-067 stage 4).
  const own = useTaskMachineSource(config, catalog, onPatch);
  const taskMachines = shared ?? own;
  const machines = useMemo<Record<string, TaskStateMachine>>(() => ({
    ...DEFAULT_TASK_STATE_MACHINES,
    ...(catalog?.storedPack?.machines ?? {}),
    ...(((config?.intentPack as { machines?: Record<string, TaskStateMachine> } | undefined)?.machines) ?? {}),
  }), [catalog, config]);

  const save = (next: IntentWorkflows) => {
    setDeclared(next);
    onPatch({ intentWorkflows: Object.keys(next).length ? next : null });
  };
  const lookup = routerHeldVariables(config?.variables).lookup;
  const validate = (intent: string) => (_name: string, wf: EventWorkflow) =>
    intentWorkflowErrors(intent, fromRun(intent, wf), { multiStepIntents: intents, intents: allIntents, machines, lookup });
  /** The workflow a new one starts from: a multi-step intent's opens its task, a single-turn intent's only ends. */
  const startingWorkflow = (intent: string): IntentWorkflow => (intents.includes(intent) ? canonicalIntentWorkflow(intent)
    : { on: { intent }, initial: 'done', states: { done: { disposition: 'success' } } } as unknown as IntentWorkflow);
  const shown = allIntents.filter((i) => intents.includes(i) || declared[i]);
  const unshown = allIntents.filter((i) => !shown.includes(i));

  if (!allIntents.length) return null;
  return (
    <div className="profiles-persona-field" data-testid="draft-intent-workflows">
      <h4>{t('admin.intentWorkflows.title')} <InfoTooltip label={t('admin.intentWorkflows.title')} content={t('admin.intentWorkflows.help')} /></h4>
      <ul className="admin-plain-list">
        {shown.map((intent) => (
          <li key={intent} data-testid={`intent-workflow-${intent}`}>
            <code>{intent}</code>{' '}
            <span className="admin-muted">{intents.includes(intent) ? t('admin.intentWorkflows.multiStep') : t('admin.intentWorkflows.singleTurn')}</span>{' '}
            {declared[intent] ? (
              <>
                <button type="button" className="btn-link" data-testid={`intent-workflow-edit-${intent}`} onClick={() => setOpen(intent)}>{t('admin.intentWorkflows.edit')}</button>{' '}
                <ConfirmAction testId={`intent-workflow-reset-${intent}`} className="btn-link"
                  label={intents.includes(intent) ? t('admin.intentWorkflows.reset') : t('admin.intentWorkflows.remove')}
                  title={t('admin.intentWorkflows.resetConfirm', { intent })} confirmLabel={t('admin.confirm.reset')} cancelLabel={t('admin.confirm.cancel')}
                  onConfirm={() => {
                    // A multi-step intent always has its workflow, so a reset restores its starting steps; a single-turn
                    // intent's is removed, and it is answered in one turn.
                    if (intents.includes(intent)) save({ ...declared, [intent]: startingWorkflow(intent) });
                    else { const { [intent]: _gone, ...rest } = declared; save(rest); if (open === intent) setOpen(undefined); }
                  }} />
                {/* THE TASKS IT ASSIGNS, EACH WITH ITS STATES. */}
                <ul className="admin-plain-list" data-testid={`intent-workflow-tasks-${intent}`}>
                  {assignedTasksOf(declared[intent], machines).map((task) => (
                    <li key={task.step} data-testid={`intent-workflow-task-${intent}-${task.step}`}>
                      {t('admin.intentWorkflows.assignedTask', { step: task.step })} <code>{task.machine}</code>{' '}
                      <span className="admin-muted">{task.states.join(' → ')}</span>
                    </li>
                  ))}
                  {!assignedTasksOf(declared[intent], machines).length && (
                    <li className="admin-muted" data-testid={`intent-workflow-no-task-${intent}`}>{t('admin.intentWorkflows.noTask')}</li>
                  )}
                </ul>
              </>
            ) : (
              // A multi-step intent with no workflow declared (a version stored before every workflow was): its steps are
              // declared here, starting from what it runs today.
              <button type="button" className="btn-link" data-testid={`intent-workflow-declare-${intent}`} onClick={() => {
                save({ ...declared, [intent]: startingWorkflow(intent) });
                setOpen(intent);
              }}>{t('admin.intentWorkflows.declare')}</button>
            )}
          </li>
        ))}
      </ul>
      {unshown.length > 0 && (
        <p className="admin-field-hint" data-testid="intent-workflow-single-turn">
          {t('admin.intentWorkflows.singleTurnHelp')}{' '}
          {unshown.map((intent) => (
            <button key={intent} type="button" className="btn-link" data-testid={`intent-workflow-add-${intent}`} onClick={() => {
              save({ ...declared, [intent]: startingWorkflow(intent) });
              setOpen(intent);
            }}><code>{intent}</code></button>
          ))}
        </p>
      )}
      {open && declared[open] && (
        <div data-testid={`intent-workflow-builder-${open}`}>
          <WorkflowBuilder
            key={open}
            workflows={{ [open]: toRun(declared[open]) }}
            templates={prompts} tools={tools} published={catalog?.variables} variables={config?.variables}
            versionTools={config?.tools} classification={catalog?.classification}
            profileName={profileName} serverErrors={serverErrors.filter((e) => e.startsWith(`intentWorkflows.${open}`))}
            validate={validate(open)}
            taskMachines={taskMachines}
            layout={layout?.[intentLayoutKey(open)] ? { [open]: layout[intentLayoutKey(open)] } : undefined}
            onLayoutChange={(next) => {
              if (!onLayoutChange) return;
              const { [intentLayoutKey(open)]: _old, ...rest } = layout ?? {};
              const points = next?.[open];
              const merged = points ? { ...rest, [intentLayoutKey(open)]: points } : rest;
              onLayoutChange(Object.keys(merged).length ? merged : null);
            }}
            onChange={(next) => {
              const edited = next?.[open];
              if (!edited) {
                const { [open]: _gone, ...rest } = declared;
                save(rest);
                setOpen(undefined);
                return;
              }
              save({ ...declared, [open]: fromRun(open, edited) });
            }}
          />
        </div>
      )}
    </div>
  );
};

export default IntentWorkflowsFields;
