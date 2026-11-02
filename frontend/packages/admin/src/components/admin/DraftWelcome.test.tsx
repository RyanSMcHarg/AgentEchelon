/**
 * THE WELCOME IS EDITED AS THE WORKFLOW IT IS (W1), PER KIND OF CONVERSATION.
 *
 * What it proves: the Welcome section lists the conversation types the draft has a welcome for; editing the opening
 * text or the suggested prompts writes the opening step of that type's `assistant-joined` workflow into the draft's
 * `eventWorkflows` and leaves every other workflow as it is; a type with no welcome of its own gets one, naming the type;
 * a prompt turn is chosen from the assistant's prompt templates, with read tools only, and removing it leaves the opening
 * alone; a welcome that greets and then continues is pointed to Event workflows; the preview follows the selected type,
 * through the router's own selection; no `welcome` field is written, and a retired one the draft carries is cleared.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WelcomeFields } from './AssistantConfigFields';
import type { ProfileDefinitionBody, ProfileDraftPatch, ToolDescriptor } from '../../services/profileService';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const GREETING = '---\n{"kind":"prompt","name":"welcome-greeting","description":"d","language":"en","fields":{"topic":"value:text"}}\n---\n# prompt\nGreet the people here.\n';
const list = vi.fn();
vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: (...a: unknown[]) => list(...a),
}));
beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({
    assistant: 'ops-premium', classification: 'premium',
    templates: [{ name: 'welcome-greeting', kind: 'prompt', description: 'd', shipped: GREETING }],
    family: {},
  });
});

const TOOLS: ToolDescriptor[] = [
  { name: 'load_company_context', category: 'context', changesState: false, description: 'reads', requires: '' },
  { name: 'advance_task_state', category: 'task', changesState: true, description: 'writes', requires: '' },
];
const OPS = 'An alert opened this conversation: {{eventSummary}}\nI can read the metrics behind it.';
const opens = (opening: Record<string, unknown>, types?: string[]): EventWorkflow => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: { opening: { opening, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
});
const CONFIG: ProfileDefinitionBody = {
  modelKey: 'claude',
  eventWorkflows: {
    welcome: opens({ examples: ['How did Q3 close?'] }),
    'welcome-ops': opens({ text: OPS }, ['ops']),
    'welcome-ops-team': opens({ text: 'The ops team is here.', accessBlurb: 'You can see alarms.' }, ['ops-team']),
    chase: { on: 'invitation-unredeemed', deadline: { afterMinutes: 60 }, initial: 'd', states: { d: { disposition: 'success' } } },
  },
};

function renderDraft(config: ProfileDefinitionBody = CONFIG) {
  const onPatch = vi.fn<(patch: ProfileDraftPatch) => void>();
  render(<WelcomeFields config={config} onPatch={onPatch} role="primary" profileName="ops-premium" tools={TOOLS} />);
  const lastWorkflows = () => onPatch.mock.calls.filter(([p]) => 'eventWorkflows' in p).at(-1)?.[0].eventWorkflows as Record<string, EventWorkflow> | undefined;
  return { onPatch, lastWorkflows };
}

describe('the draft welcome, per kind of conversation (W1)', () => {
  it('offers every other conversation and each type the draft has a welcome for, and previews the opening', () => {
    renderDraft();
    const select = screen.getByTestId('draft-welcome-type') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'ops', 'ops-team']);
    expect((screen.getByTestId('draft-welcome-template') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByTestId('draft-welcome-examples') as HTMLTextAreaElement).value).toBe('How did Q3 close?');
    expect(screen.getByTestId('draft-welcome-workflow')).toHaveTextContent('welcome');
    expect(screen.getByTestId('welcome-preview').textContent).toContain('- How did Q3 close?');
  });

  it('edits the selected type\'s opening step and leaves every other workflow as it is', () => {
    const { onPatch, lastWorkflows } = renderDraft();
    fireEvent.change(screen.getByTestId('draft-welcome-type'), { target: { value: 'ops' } });
    const box = screen.getByTestId('draft-welcome-template') as HTMLTextAreaElement;
    expect(box.value).toBe(OPS);
    fireEvent.change(box, { target: { value: 'Alert: {{eventSummary}}' } });
    const next = lastWorkflows()!;
    expect(next['welcome-ops'].states.opening.opening).toEqual({ text: 'Alert: {{eventSummary}}' });
    expect(next.welcome).toEqual(CONFIG.eventWorkflows!.welcome);
    expect(next['welcome-ops-team']).toEqual(CONFIG.eventWorkflows!['welcome-ops-team']);
    expect(next.chase).toEqual(CONFIG.eventWorkflows!.chase);
    // The retired field is never written.
    expect(onPatch.mock.calls.some(([p]) => 'welcome' in p)).toBe(false);
  });

  it('a blank text keeps the type\'s other fields, and a type with no welcome of its own gets one naming it', () => {
    const { lastWorkflows } = renderDraft();
    fireEvent.change(screen.getByTestId('draft-welcome-type'), { target: { value: 'ops-team' } });
    fireEvent.change(screen.getByTestId('draft-welcome-template'), { target: { value: ' ' } });
    expect(lastWorkflows()!['welcome-ops-team'].states.opening.opening).toEqual({ accessBlurb: 'You can see alarms.' });
    fireEvent.change(screen.getByTestId('draft-welcome-new-type'), { target: { value: 'general' } });
    fireEvent.click(screen.getByTestId('draft-welcome-add-type'));
    expect((screen.getByTestId('draft-welcome-type') as HTMLSelectElement).value).toBe('general');
    expect(screen.getByTestId('draft-welcome-workflow')).toHaveTextContent(/platform's welcome runs/);
    fireEvent.change(screen.getByTestId('draft-welcome-template'), { target: { value: 'A general conversation.' } });
    expect(lastWorkflows()!['welcome-general']).toEqual(opens({ text: 'A general conversation.' }, ['general']));
  });

  it('previews the selected type\'s opening through the router\'s own selection', () => {
    renderDraft();
    fireEvent.change(screen.getByTestId('draft-welcome-type'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'event' } });
    expect(screen.getByTestId('welcome-preview').textContent).toContain('An alert opened this conversation: p95 latency on the checkout API');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('The opening text for ops applies.');
  });

  it('inserts a field into the selected type\'s opening text', () => {
    const { lastWorkflows } = renderDraft();
    fireEvent.change(screen.getByTestId('draft-welcome-type'), { target: { value: 'ops-team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert {{role}}' }));
    expect(lastWorkflows()!['welcome-ops-team'].states.opening.opening).toMatchObject({ text: 'The ops team is here. {{role}}' });
  });
});

describe('the prompt turn after the opening (SPEC-WELCOME-AND-CONTEXT FR24)', () => {
  it('chooses a prompt template, offers read tools only, and removing it leaves the opening alone', async () => {
    const { lastWorkflows } = renderDraft();
    await waitFor(() => expect(screen.getByTestId('draft-welcome-prompt-template').querySelector('option[value="welcome-greeting"]')).not.toBeNull());
    fireEvent.change(screen.getByTestId('draft-welcome-prompt-template'), { target: { value: 'welcome-greeting' } });
    let wf = lastWorkflows()!.welcome;
    expect(wf.states.opening.onSuccess).toBe('prompt');
    expect(wf.states.prompt).toEqual({ prompt: { template: 'welcome-greeting' }, onSuccess: 'done', onFailure: 'done' });
    expect(screen.queryByTestId('draft-welcome-tool-advance_task_state')).toBeNull();
    fireEvent.click(screen.getByTestId('draft-welcome-tool-load_company_context'));
    expect(lastWorkflows()!.welcome.states.prompt.prompt).toEqual({ template: 'welcome-greeting', tools: ['load_company_context'] });
    fireEvent.change(screen.getByTestId('draft-welcome-prompt-template'), { target: { value: '' } });
    wf = lastWorkflows()!.welcome;
    expect(wf.states.prompt).toBeUndefined();
    expect(wf.states.opening).toEqual({ opening: { examples: ['How did Q3 close?'] }, onSuccess: 'done', onFailure: 'done' });
  });

  it('a welcome that greets and then continues is pointed to Event workflows, with no prompt control', () => {
    const runs: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: {
        opening: { opening: {}, onSuccess: 'greet' },
        greet: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done' },
        done: { disposition: 'success' },
      },
    };
    renderDraft({ modelKey: 'claude', eventWorkflows: { 'greet-then-ask': runs } });
    expect(screen.getByTestId('draft-welcome-runs')).toHaveTextContent('greet-then-ask');
    expect(screen.queryByTestId('draft-welcome-prompt')).toBeNull();
  });
});

describe('a draft cloned from a version that carries the retired welcome', () => {
  it('says so, names the migration, and clears it', () => {
    const { onPatch } = renderDraft({ modelKey: 'claude', welcome: { template: 'Hi.' } });
    expect(screen.getByTestId('draft-retired-welcome')).toHaveTextContent('npm run migrate-legacy-welcome');
    fireEvent.click(screen.getByTestId('draft-retired-welcome-clear'));
    expect(onPatch).toHaveBeenCalledWith({ welcome: null });
    expect(screen.queryByTestId('draft-retired-welcome')).toBeNull();
  });
});
