/**
 * THE WELCOME'S EDIT FORM (ADR-067 stage 1): one welcome, greeting with a template, a template and a prompt turn, or a
 * workflow of its own.
 *
 * The form opens on the mode the welcome runs today (`welcomeModeOf`). Template and Prompt show only the steps they
 * have, edited with the builder's own step controls (`StepFields`), so there is one editor of a step, never two.
 * Workflow hides them and shows the builder on this welcome. A switch writes the welcome's new shape to the draft at
 * once. A switch from Workflow keeps the workflow in the draft's `keptWelcomeWorkflow` (`onKeptChange`), outside
 * `eventWorkflows`, so it never runs and outlives the page; switching back to Workflow restores it and clears the field.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import WorkflowBuilder from './WorkflowBuilder';
import type { WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';
import { StepFields, type WorkflowOptions } from './EventWorkflowEditor';
import { welcomeModeOf, withWelcomeMode, type WelcomeMode, type Workflows } from './welcomeWorkflow';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const MODES: WelcomeMode[] = ['template', 'prompt', 'workflow'];

const WelcomeModeEditor: React.FC<WorkflowOptions & {
  /** The welcome being edited. */
  name: string;
  workflows: Workflows;
  onChange: (next: Workflows | null) => void;
  layout?: WorkflowLayout;
  onLayoutChange: (next: WorkflowLayout | null) => void;
  profileName?: string;
  serverErrors?: readonly string[];
  /** The platform's welcome, edited in place of an own one the version does not have. */
  builtIn?: EventWorkflow;
  /** The draft's kept welcome, restored on a switch back to Workflow. */
  kept?: EventWorkflow;
  /** Keep a welcome workflow in the draft, or clear the kept one (`null`). */
  onKeptChange?: (next: EventWorkflow | null) => void;
}> = ({ name, workflows, onChange, layout, onLayoutChange, profileName, serverErrors, builtIn, kept, onKeptChange, ...options }) => {
  const { t } = useTranslation();
  // A VERSION WITH NO WELCOME OF ITS OWN edits the built-in one: the first change copies it into the draft under this name.
  const own = workflows[name];
  const wf: EventWorkflow | undefined = own ?? builtIn;
  const base: Workflows = own || !builtIn ? workflows : { ...workflows, [name]: builtIn };
  const [mode, setMode] = useState<WelcomeMode>(() => welcomeModeOf(wf));
  /** The welcome as it was in Workflow mode: the one running, else the draft's kept one when it is this kind of room's. */
  const keptHere = kept && (kept.types?.[0] ?? '') === (wf?.types?.[0] ?? '') ? kept : undefined;
  const held = useRef<EventWorkflow | undefined>(welcomeModeOf(wf) === 'workflow' ? wf : keptHere);
  const firstPrompt = (options.templates ?? []).find((x) => x.kind === 'prompt')?.name ?? '';

  const choose = (next: WelcomeMode) => {
    if (next === mode) return;
    if (mode === 'workflow' && wf) {
      held.current = wf;
      // KEPT ON THE DRAFT, outside the workflows that run (ADR-067 G40).
      onKeptChange?.(wf);
    }
    if (next === 'workflow') {
      const restored = held.current ?? wf;
      if (keptHere || held.current) onKeptChange?.(null);
      onChange(restored ? { ...workflows, [name]: restored } : base);
    } else {
      onChange(withWelcomeMode(base, name, next, firstPrompt));
    }
    setMode(next);
  };

  const step = (key: string) => (
    <StepFields key={key} wf={wf!} stepKey={key} testId={`welcome-mode-step-${key}`} fixedIdentity {...options}
      onChange={(def) => onChange({ ...base, [name]: { ...wf!, states: { ...wf!.states, [key]: def } } })}
      onRename={() => undefined} />
  );
  const openingKey = wf ? Object.keys(wf.states).find((k) => wf.states[k].opening) : undefined;
  const promptKey = wf ? Object.keys(wf.states).find((k) => wf.states[k].prompt) : undefined;

  return (
    <div className="admin-welcome-mode" data-testid="welcome-mode-editor">
      <h4>{t('admin.workflowsList.welcomeEdit', { name })}</h4>
      <fieldset className="admin-welcome-mode-choice" data-testid="welcome-mode">
        <legend>{t('admin.workflowsList.greetsWith')}</legend>
        {MODES.map((m) => (
          <label key={m}>
            <input type="radio" name={`welcome-mode-${name}`} value={m} checked={mode === m} data-testid={`welcome-mode-${m}`}
              onChange={() => choose(m)} />
            {' '}{t(`admin.workflowsList.mode.${m}`)}
          </label>
        ))}
        <p className="admin-field-hint">{t(`admin.workflowsList.modeHelp.${mode}`)}</p>
      </fieldset>
      {mode !== 'workflow' && held.current && (
        <p className="admin-field-hint" data-testid="welcome-mode-held">{t(onKeptChange ? 'admin.workflowsList.keptOnDraft' : 'admin.workflowsList.heldForSession')}</p>
      )}
      {mode === 'workflow' ? (
        <WorkflowBuilder workflows={own ? workflows : base} {...options} layout={layout} profileName={profileName} serverErrors={serverErrors}
          initialWorkflow={name} onLayoutChange={onLayoutChange} onChange={onChange} />
      ) : !wf ? (
        <p className="admin-field-hint" data-testid="welcome-mode-built-in">{t('admin.workflowsList.builtInOpening')}</p>
      ) : (
        <div data-testid={`welcome-mode-steps-${mode}`}>
          {openingKey && step(openingKey)}
          {mode === 'prompt' && promptKey && step(promptKey)}
        </div>
      )}
    </div>
  );
};

export default WelcomeModeEditor;
