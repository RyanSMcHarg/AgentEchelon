/**
 * THE WELCOME'S EDIT FORM SWITCHES TEMPLATE, PROMPT AND WORKFLOW, AND A SWITCH LOSES NOTHING (ADR-067 stage 1, WT112).
 *
 * What it proves: the form opens on the mode the welcome runs today; Template and Prompt show only their steps and no
 * builder, and Workflow shows the builder on this welcome; a switch writes the welcome's new shape to the draft patch;
 * and switching from Workflow to Template and back restores every step the workflow had, for the session.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventWorkflowsFields } from './AssistantConfigFields';
import { welcomeModeOf, withWelcomeMode } from './welcomeWorkflow';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { ProfileDefinitionBody } from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: async () => ({ assistant: 'a', classification: 'premium', templates: [], family: {} }),
}));

const WORKFLOW_WELCOME: EventWorkflow = {
  on: 'assistant-joined', initial: 'opening',
  states: {
    opening: { opening: { text: 'Hello from the team.' }, onSuccess: 'tell-lead', onFailure: 'tell-lead' },
    'tell-lead': { send: { to: 'room', template: 'welcome-room-note' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as EventWorkflow;
const TEMPLATE_WELCOME: EventWorkflow = {
  on: 'assistant-joined', initial: 'opening',
  states: { opening: { opening: { text: 'Hello.' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
} as EventWorkflow;

const renderWith = (welcome: EventWorkflow) => {
  const onPatch = vi.fn();
  render(<EventWorkflowsFields config={{ eventWorkflows: { welcome } } as unknown as ProfileDefinitionBody} onPatch={onPatch}
    profileName="advisor" focusWorkflow="welcome" />);
  return onPatch;
};
const lastWorkflows = (onPatch: ReturnType<typeof vi.fn>) => onPatch.mock.calls.at(-1)![0].eventWorkflows as Record<string, EventWorkflow> | null;

describe('the welcome edit form', () => {
  it('opens on the mode the welcome runs today', () => {
    expect(welcomeModeOf(WORKFLOW_WELCOME)).toBe('workflow');
    expect(welcomeModeOf(TEMPLATE_WELCOME)).toBe('template');
    renderWith(TEMPLATE_WELCOME);
    expect((screen.getByTestId('welcome-mode-template') as HTMLInputElement).checked).toBe(true);
    // Template shows its opening step and no builder.
    expect(screen.getByTestId('welcome-mode-steps-template')).toBeTruthy();
    expect(screen.queryByTestId('wfb-node-opening')).toBeNull();
  });

  it('shows the builder only in Workflow, and switching to Template hides it and writes the opening alone', () => {
    const onPatch = renderWith(WORKFLOW_WELCOME);
    expect((screen.getByTestId('welcome-mode-workflow') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('wfb-node-tell-lead')).toBeTruthy();
    fireEvent.click(screen.getByTestId('welcome-mode-template'));
    expect(screen.queryByTestId('wfb-node-tell-lead')).toBeNull();
    const welcome = lastWorkflows(onPatch)!.welcome;
    expect(Object.keys(welcome.states).sort()).toEqual(['done', 'opening']);
    expect(welcome.states.opening.opening).toEqual({ text: 'Hello from the team.' });
    expect(screen.getByTestId('welcome-mode-held')).toBeTruthy();
  });

  it('switching back to Workflow restores every step the workflow had', () => {
    const onPatch = renderWith(WORKFLOW_WELCOME);
    fireEvent.click(screen.getByTestId('welcome-mode-template'));
    fireEvent.click(screen.getByTestId('welcome-mode-workflow'));
    expect(lastWorkflows(onPatch)!.welcome).toEqual(WORKFLOW_WELCOME);
    expect(screen.getByTestId('wfb-node-tell-lead')).toBeTruthy();
  });

  it('Prompt adds one prompt turn after the opening, and Template removes it again', () => {
    const prompt = withWelcomeMode({ welcome: TEMPLATE_WELCOME }, 'welcome', 'prompt', 'welcome-greeting');
    expect(welcomeModeOf(prompt.welcome)).toBe('prompt');
    const promptStep = Object.values(prompt.welcome.states).find((d) => d.prompt);
    expect(promptStep?.prompt?.template).toBe('welcome-greeting');
    const back = withWelcomeMode(prompt, 'welcome', 'template', 'welcome-greeting');
    expect(welcomeModeOf(back.welcome)).toBe('template');
    expect(Object.values(back.welcome.states).some((d) => d.prompt)).toBe(false);
  });
});

describe('a version with no welcome of its own', () => {
  it('edits the built-in welcome, and the first change copies it into the draft', () => {
    const onPatch = vi.fn();
    render(<EventWorkflowsFields config={{ eventWorkflows: {} } as unknown as ProfileDefinitionBody} onPatch={onPatch}
      profileName="advisor" focusWorkflow="welcome" />);
    expect((screen.getByTestId('welcome-mode-template') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('welcome-mode-workflow'));
    const welcome = lastWorkflows(onPatch)!.welcome;
    expect(welcome.on).toBe('assistant-joined');
    expect(screen.getByTestId('workflow-builder')).toBeTruthy();
  });
});

describe('the kept welcome rides the draft', () => {
  it('a switch from Workflow keeps the workflow in keptWelcomeWorkflow, outside the workflows that run', () => {
    const onPatch = renderWith(WORKFLOW_WELCOME);
    fireEvent.click(screen.getByTestId('welcome-mode-template'));
    const keptCall = onPatch.mock.calls.find((c) => 'keptWelcomeWorkflow' in c[0]);
    expect(keptCall![0].keptWelcomeWorkflow).toEqual(WORKFLOW_WELCOME);
    expect(lastWorkflows(onPatch)!.welcome).not.toEqual(WORKFLOW_WELCOME);
  });

  it('a draft that kept one restores it on Workflow, after the page was closed, and clears the field', () => {
    const onPatch = vi.fn();
    render(<EventWorkflowsFields config={{ eventWorkflows: { welcome: TEMPLATE_WELCOME } } as unknown as ProfileDefinitionBody} onPatch={onPatch}
      profileName="advisor" focusWorkflow="welcome" keptWelcome={WORKFLOW_WELCOME} />);
    fireEvent.click(screen.getByTestId('welcome-mode-workflow'));
    expect(onPatch.mock.calls.some((c) => c[0].keptWelcomeWorkflow === null)).toBe(true);
    expect(lastWorkflows(onPatch)!.welcome).toEqual(WORKFLOW_WELCOME);
  });
});
