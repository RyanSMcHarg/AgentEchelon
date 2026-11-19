/**
 * A WELCOME THE VERSION DOES NOT HAVE YET OPENS ON THE WORDS THE CLASSIFICATION GREETS WITH.
 *
 * What it proves: the opening text is filled from the classification's setting, its prompts as a bulleted list; those words
 * render what the assembled opening says, and name the topic where a room has one; nothing reaches the draft until a person
 * changes something; the first change saves them as the assistant's own; and the form offers no step name or kind.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventWorkflowsFields } from './AssistantConfigFields';
import { composeWelcome, composeOpening, openingTextOf } from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { ProfileDefinitionBody, ClassificationCatalog } from '../../services/profileService';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: async () => ({ assistant: 'a', classification: 'premium', templates: [], family: {} }),
}));

const ORIENTATION = {
  companyName: 'Stratum Technologies',
  companyBlurb: 'an enterprise SaaS company',
  accessBlurb: 'You have full internal access.',
  examples: ['What is our net revenue retention?', 'Compile a report on Q2 ARR'],
  platformNote: 'I also know the platform that powers this demo.',
};
const TEXT_ID = 'welcome-mode-step-opening-opening-text';

const renderForm = () => {
  const onPatch = vi.fn();
  const catalog = { welcomeOrientation: ORIENTATION, primaryAssistant: 'advisor', classification: 'premium' } as unknown as ClassificationCatalog;
  render(<EventWorkflowsFields config={{} as unknown as ProfileDefinitionBody} catalog={catalog} onPatch={onPatch} profileName="advisor" focusWorkflow="welcome" />);
  return onPatch;
};

describe('the words a welcome opens on', () => {
  it('render exactly what the assembled opening says', () => {
    const text = openingTextOf(ORIENTATION);
    expect(composeOpening(text, ORIENTATION).content).toBe(composeWelcome(ORIENTATION).content);
    expect(composeOpening(text, { ...ORIENTATION, topic: 'quarterly planning' }).content).toContain('I can help with quarterly planning.');
  });

  it('fill the form, and reach the draft only when a person changes something', () => {
    const onPatch = renderForm();
    const area = screen.getByTestId(TEXT_ID) as HTMLTextAreaElement;
    expect(area.value).toContain("I'm your assistant at Stratum Technologies");
    expect(area.value).toContain('- Compile a report on Q2 ARR');
    expect((screen.getByTestId('welcome-mode-template') as HTMLInputElement).checked).toBe(true);
    expect(onPatch).not.toHaveBeenCalled();

    fireEvent.change(area, { target: { value: `${area.value}\n\nWelcome aboard.` } });
    const saved = onPatch.mock.calls.at(-1)![0].eventWorkflows as Record<string, EventWorkflow>;
    expect(saved.welcome.states.opening.opening?.text).toContain('Welcome aboard.');
  });

  it('gives a conversation type its own welcome, created only when something changes', () => {
    const onPatch = renderForm();
    fireEvent.change(screen.getByTestId('welcome-for-type'), { target: { value: 'general' } });
    expect(onPatch).not.toHaveBeenCalled();
    const area = screen.getByTestId(TEXT_ID) as HTMLTextAreaElement;
    expect(area.value).toContain("I'm your assistant at Stratum Technologies");
    fireEvent.change(area, { target: { value: 'Hello, general room.' } });
    const saved = onPatch.mock.calls.at(-1)![0].eventWorkflows as Record<string, EventWorkflow>;
    expect(saved['welcome-general'].types).toEqual(['general']);
    expect(saved['welcome-general'].states.opening.opening?.text).toBe('Hello, general room.');
    expect(saved.welcome).toBeUndefined();
  });

  it('offers one list to insert from, with the built-in fields first, and no next-step controls', () => {
    renderForm();
    const row = screen.getByTestId('welcome-mode-step-opening-opening-variable-row-topic');
    expect(row).toHaveTextContent('topic');
    fireEvent.click(screen.getByTestId('welcome-mode-step-opening-opening-variable-row-topic-pick'));
    expect((screen.getByTestId(TEXT_ID) as HTMLTextAreaElement).value).toContain('{{topic}}');
    expect(screen.queryByTestId('welcome-tokens')).toBeNull();
    expect(screen.queryByTestId('welcome-mode-step-opening-success')).toBeNull();
  });

  it('opens a shipped workflow that is running on the builder, and writes nothing until something changes', () => {
    const onPatch = vi.fn();
    render(<EventWorkflowsFields config={{} as unknown as ProfileDefinitionBody} onPatch={onPatch} profileName="advisor" focusWorkflow="join-recap" />);
    expect(screen.getAllByText('join-recap').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('welcome-mode-editor')).toBeNull();
    expect(screen.queryByTestId('draft-welcome-required')).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('shows the welcome alone, with no other workflow beside it', () => {
    renderForm();
    expect(screen.queryByTestId('wfb-view-list')).toBeNull();
    expect(screen.queryByTestId('draft-welcome-required')).toBeNull();
  });

  it('offers no step name, kind or condition, because those are the workflow builder\'s', () => {
    renderForm();
    expect(screen.queryByTestId('welcome-mode-step-opening-kind')).toBeNull();
    expect(screen.queryByTestId('welcome-mode-step-opening-name')).toBeNull();
    expect(screen.queryByTestId('welcome-mode-step-opening-when')).toBeNull();
  });
});
