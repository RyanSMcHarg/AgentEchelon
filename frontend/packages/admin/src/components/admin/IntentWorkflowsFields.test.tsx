import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import IntentWorkflowsFields, { assignedTasksOf, fromRun, multiStepIntentsOf, toRun } from './IntentWorkflowsFields';
import { canonicalIntentWorkflow, intentWorkflowErrors } from '../../../../../../backend/lambda/src/lib/intent-workflow.ts';
import { DEFAULT_TASK_STATE_MACHINES } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import type { ClassificationCatalog, ProfileDefinitionBody } from '../../services/profileService';

/**
 * EACH INTENT'S WORKFLOW IS DECLARED AND SHOWN WITH THE TASKS IT ASSIGNS (ADR-067 stages 3 and 4).
 *
 * A multi-step intent always has its workflow, shown with each task it assigns and that task's states, and edited on the
 * visual builder by the intent's rules; one stored before every workflow was declared offers to declare it from what it
 * runs today, and Restore puts its starting steps back. A single-turn intent is answered in one turn and may be given a
 * workflow, which opens no task of the request's own and which Remove takes away.
 */
const catalog = {
  intents: [
    { key: 'report_generation', description: 'a report', multiStep: true },
    { key: 'general_question', description: 'a question', multiStep: false },
  ],
} as unknown as ClassificationCatalog;
const DECLARED = { intentWorkflows: { report_generation: canonicalIntentWorkflow('report_generation') } } as unknown as ProfileDefinitionBody;

describe('the intents and their workflows', () => {
  it('multi-step intents are the classification\'s and the version\'s own', () => {
    const config = { intentPack: { intents: [{ key: 'ticket', delivery: 'TASK_MULTI_STEP' }, { key: 'chat', delivery: 'DIRECT' }] } } as unknown as ProfileDefinitionBody;
    expect(multiStepIntentsOf(catalog, config)).toEqual(['report_generation', 'ticket']);
  });

  it('a workflow round-trips between the stored shape and the builder\'s, and its tasks are read with their states', () => {
    const wf = canonicalIntentWorkflow('report_generation');
    expect(fromRun('report_generation', toRun(wf))).toEqual(wf);
    const [task] = assignedTasksOf(wf, DEFAULT_TASK_STATE_MACHINES);
    expect(task.step).toBe('work');
    expect(task.machine).toBe('report_generation');
    expect(task.states[0]).toBe(DEFAULT_TASK_STATE_MACHINES.report_generation.initial);
    expect(task.states.length).toBeGreaterThan(1);
    expect(intentWorkflowErrors('report_generation', wf, { multiStepIntents: ['report_generation'] })).toEqual([]);
  });
});

describe('the intent workflows field', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows a multi-step intent\'s workflow with the task it assigns and that task\'s states', () => {
    render(<IntentWorkflowsFields config={DECLARED} catalog={catalog} onPatch={vi.fn()} />);
    expect(screen.getByTestId('intent-workflow-report_generation').textContent).toContain('opens a task');
    const task = screen.getByTestId('intent-workflow-task-report_generation-work');
    expect(task.textContent).toContain('report_generation');
    expect(task.textContent).toContain('→');
  });

  it('a multi-step intent with no declared workflow offers to declare it from what it runs today', () => {
    const onPatch = vi.fn();
    render(<IntentWorkflowsFields config={{} as ProfileDefinitionBody} catalog={catalog} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId('intent-workflow-declare-report_generation'));
    expect(onPatch).toHaveBeenCalledWith({ intentWorkflows: { report_generation: canonicalIntentWorkflow('report_generation') } });
    expect(screen.getByTestId('intent-workflow-builder-report_generation')).toBeTruthy();
  });

  it('Restore puts a multi-step intent\'s starting steps back, never removing its workflow', () => {
    const onPatch = vi.fn();
    render(<IntentWorkflowsFields config={DECLARED} catalog={catalog} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId('intent-workflow-reset-report_generation'));
    fireEvent.click(screen.getByTestId('intent-workflow-reset-report_generation-confirm-button'));
    expect(onPatch).toHaveBeenCalledWith({ intentWorkflows: { report_generation: canonicalIntentWorkflow('report_generation') } });
  });

  it('a single-turn intent may be given a workflow that assigns no task, and have it removed', () => {
    const onPatch = vi.fn();
    render(<IntentWorkflowsFields config={DECLARED} catalog={catalog} onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId('intent-workflow-add-general_question'));
    const added = onPatch.mock.calls.at(-1)![0].intentWorkflows.general_question;
    expect(added).toEqual({ on: { intent: 'general_question' }, initial: 'done', states: { done: { disposition: 'success' } } });
    expect(screen.getByTestId('intent-workflow-no-task-general_question')).toBeTruthy();
    fireEvent.click(screen.getByTestId('intent-workflow-reset-general_question'));
    fireEvent.click(screen.getByTestId('intent-workflow-reset-general_question-confirm-button'));
    expect(onPatch.mock.calls.at(-1)![0].intentWorkflows).toEqual({ report_generation: canonicalIntentWorkflow('report_generation') });
  });
});
