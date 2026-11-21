/**
 * THE WELCOME IS A REQUIRED WORKFLOW, EDITED IN THE ONE BUILDER, AND ITS PREVIEW IS WHAT THE ROOM READS.
 *
 * The welcome is a required workflow, and every critical feature the console shows works. What it proves:
 *
 *  - where a workflow runs and the type an agent step opens are chosen from the declared types the classification
 *    may carry (and, on conversation-opened, those an event opens), never typed;
 *  - a step the assistant takes itself offers only the version's own read tools, and names one it may not use;
 *  - the opening step carries the welcome's preview, which lays the opening's own fields over the deployment's welcome
 *    for the primary, resolves a version variable as the router does, says when a workflow that opens the room greets
 *    it instead, and shows the onboarding question that follows;
 *  - the built-in opening is described as it is: only Opening text mentions an event.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

vi.mock('../../services/eventTriggerService', () => ({
  listEventTriggers: async () => ({ channelArn: 'arn:room', triggers: [] }), attachEventTrigger: vi.fn(), removeEventTrigger: vi.fn(),
  listAccountAlarms: async () => [], listAccountRules: async () => [], listDeclaredHandoffs: async () => [],
  readEventPolicy: async () => ({ allowedEventTypes: [{ source: 'ae.ops', detailType: 'Incident opened' }] }),
}));
import EventWorkflowEditor, { declaredTypesFor, stepReadTools, typesLeftOut } from './EventWorkflowEditor';
import { GreetedWith, previewWelcome, welcomeContextFor } from './WelcomeEditorGuide';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { composeOpening, withDeploymentOpening } from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import { routerHeldVariables } from '../../../../../../backend/lambda/src/lib/variables.ts';
import type { ToolDescriptor } from '../../services/profileService';

const TOOLS: ToolDescriptor[] = [
  { name: 'load_company_context', category: 'context', changesState: false, description: 'reads', requires: '' },
  { name: 'search_documents', category: 'context', changesState: false, description: 'reads', requires: '' },
  { name: 'advance_task_state', category: 'task', changesState: true, description: 'writes', requires: '' },
];
const STRATUM = { companyName: 'Stratum Technologies', accessBlurb: 'You have full internal access.', examples: ['What is our net revenue retention?'] };
const opens = (opening: Record<string, unknown>, types?: string[]): EventWorkflow => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: { opening: { opening, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
});

describe('the types a workflow names are the declared ones', () => {
  it('offers the types this classification may carry, and on conversation-opened only those an event or a workflow opens', () => {
    expect(declaredTypesFor('assistant-joined', 'premium')).toEqual(expect.arrayContaining(['general', 'ops', 'ops-team']));
    expect(declaredTypesFor('assistant-joined', 'premium')).not.toContain('guest-visitor');
    expect(declaredTypesFor('conversation-opened', 'premium')).toEqual(['ops', 'customer-messaging']);
  });

  it('offers an AWS event only the types it reaches, and says why each type is left out', async () => {
    expect(declaredTypesFor('event-received', 'premium')).toEqual(expect.arrayContaining(['ops-team', 'ops']));
    expect(declaredTypesFor('event-received', 'premium')).not.toContain('meeting');
    expect(declaredTypesFor('event-received', 'premium')).not.toContain('general');
    expect(typesLeftOut('event-received', 'premium')).toEqual(expect.arrayContaining([
      { type: 'meeting', reason: 'meeting' },
      { type: 'general', reason: 'noWatchedKey' },
      { type: 'guest-visitor', reason: 'classification' },
    ]));
    render(<EventWorkflowEditor workflows={{ esc: { on: 'event-received', types: ['ops-team'], initial: 'done', states: { done: { disposition: 'success' } } } as never }}
      onChange={vi.fn()} tools={TOOLS} classification="premium" />);
    // Said beside the choice of where it runs, once an event is chosen.
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(screen.getByTestId('trigger-event-select').textContent).toContain('Incident opened'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'platform:ae.ops|Incident opened' } });
    expect(screen.getByTestId('event-workflow-type-left-out-meeting').textContent).toContain('meeting (a meeting\x27s conversation)');
  });

  it('picks where it runs from a list, so no name the deployment does not declare can be written', () => {
    const onChange = vi.fn();
    render(<EventWorkflowEditor workflows={{ welcome: opens({}) }} onChange={onChange} tools={TOOLS} classification="premium" />);
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    const where = screen.getByTestId('trigger-where');
    expect(within(where).queryByRole('textbox')).toBeNull();
    fireEvent.change(screen.getByTestId('trigger-where-in-type'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByTestId('trigger-save'));
    expect(onChange).toHaveBeenLastCalledWith({ welcome: opens({}, ['ops']) });
  });
});

describe('a step the assistant takes itself uses the version\'s own tools', () => {
  it('offers only the version\'s read tools, and any read tool where the version sets none', () => {
    expect(stepReadTools(TOOLS, ['search_documents'], true).map((d) => d.name)).toEqual(['search_documents']);
    expect(stepReadTools(TOOLS, undefined, true).map((d) => d.name)).toEqual(['load_company_context', 'search_documents']);
    expect(stepReadTools(TOOLS, ['search_documents'], false).map((d) => d.name)).toEqual(['load_company_context', 'search_documents']);
  });

  it('says when a welcome\'s prompt turn names a tool the version does not allow, which Validate refuses', () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: {
        opening: { opening: {}, onSuccess: 'greet', onFailure: 'done' },
        greet: { prompt: { template: 'welcome-greeting', tools: ['load_company_context'] }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    };
    render(<EventWorkflowEditor workflows={{ welcome: wf }} onChange={vi.fn()} tools={TOOLS} versionTools={['search_documents']} />);
    expect(screen.getByTestId('event-workflow-step-1-tool-dropped-load_company_context')).toHaveTextContent("isn't allowed in this version");
  });
});

describe('the opening step previews what the room reads', () => {
  const primary = welcomeContextFor({ version: { displayName: 'Advisor' }, catalog: { welcomeOrientation: STRATUM, primaryAssistant: 'advisor', classification: 'premium' }, assistant: 'advisor' });

  it('lays suggested prompts set here over the deployment\'s welcome, keeping its company and access line', () => {
    const p = previewWelcome({ welcome: opens({ examples: ['Summarize the Q3 renewals'] }) }, undefined, {}, undefined, primary);
    expect(p.content).toContain('Stratum Technologies');
    expect(p.content).toContain('Summarize the Q3 renewals');
    expect(p.content).not.toContain('What is our net revenue retention?');
    expect(p.deploymentCopy && p.ownFields).toBe(true);
  });

  it('is the opening\'s own alone for an assistant that is not the classification\'s primary', () => {
    const other = welcomeContextFor({ version: {}, catalog: { welcomeOrientation: STRATUM, primaryAssistant: 'advisor' }, assistant: 'ops-premium' });
    expect(previewWelcome({ welcome: opens({}) }, undefined, {}, undefined, other).content).not.toContain('Stratum');
  });

  it('resolves a version variable the opening names, with its fallback where the join holds no value', () => {
    const ctx = { ...primary, variables: { team: { source: 'fact:team', fallback: 'your team' } } } as never;
    const p = previewWelcome({ welcome: opens({ text: 'Hello from {{team}}.' }) }, undefined, {}, undefined, ctx);
    expect(p.content).toBe('Hello from your team.');
  });

  it("reads a variable through the router's own resolver, so a source the join holds no value for says its fallback in both", () => {
    const variables = { team: { source: 'fact:team', fallback: 'your team' }, kind: { source: 'conversation:type' }, desk: { source: 'ctx:desk', fallback: 'the desk' } } as never;
    const text = ['From {{team}}.', 'A {{kind}} room.', 'At {{desk}}.'].join('\n');
    const p = previewWelcome({ w: opens({ text }, ['ops']) }, 'ops', {}, undefined, { ...primary, variables });
    const room = composeOpening(text, withDeploymentOpening(undefined, STRATUM) ?? {}, { name: 'Advisor' }, routerHeldVariables(variables, { classification: 'premium', conversationType: 'ops' }));
    expect(p.content).toBe(room.content);
    expect(p.content).toContain('From your team.');
    expect(p.content).toContain('A ops room.');
  });

  it('says a room a workflow opens is greeted by that workflow, and shows no opening for it', () => {
    const all: Record<string, EventWorkflow> = {
      welcome: opens({}),
      'ops-open': { on: 'conversation-opened', types: ['ops'], initial: 'done', states: { done: { disposition: 'success' } } },
    };
    expect(previewWelcome({ welcome: opens({}) }, 'ops', {}, undefined, { ...primary, allWorkflows: all })).toMatchObject({ applies: 'openedBy', openedBy: 'ops-open' });
  });

  it('shows the deployment\'s onboarding question that follows, for the primary whose version sets none', () => {
    const ctx = welcomeContextFor({ version: {}, catalog: { welcomeOrientation: STRATUM, primaryAssistant: 'advisor', onboardingIntake: { greeting: 'Two quick questions.', questions: ['Which team are you on?'] } }, assistant: 'advisor' });
    render(<GreetedWith workflows={null} classification="premium" context={ctx} />);
    expect(screen.getByTestId('welcome-intake')).toHaveTextContent('Which team are you on?');
  });

  it('carries the preview on the opening step, describing a blank opening for this assistant', () => {
    render(<EventWorkflowEditor workflows={{ welcome: opens({}) }} onChange={vi.fn()} tools={TOOLS} welcomeContext={primary} classification="premium" />);
    const step = screen.getByTestId('event-workflow-step-0-opening');
    expect(within(step).getByTestId('welcome-preview')).toHaveTextContent('Stratum Technologies');
    expect(within(step).getByTestId('welcome-built-in')).toHaveTextContent("Blank fields use the deployment's welcome.");
  });

  it('describes the built-in opening as it is: a greeting with the topic', () => {
    render(<EventWorkflowEditor workflows={{ welcome: opens({}) }} onChange={vi.fn()} tools={TOOLS} />);
    expect(screen.getByTestId('welcome-built-in')).toHaveTextContent('Blank uses a built-in greeting with the topic.');
  });
});
