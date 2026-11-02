/**
 * THE OPENING SAYS HOW IT IS MADE, AND THE PREVIEW IS WHAT THE ROUTER POSTS.
 *
 * What it proves: the guide says what the built-in opening is made of and lists every field Opening text may name,
 * inserting one on a click; the preview renders the built-in opening itself when no opening text applies; a
 * template's line naming a field the sample lacks is dropped; a conversation type's own welcome replaces the one for
 * every other room in that type and the guide says which one applies (W1, the router's `welcomeWorkflowOf`); and on
 * several inputs the preview equals what the server's renderer produces from the same opening and conversation.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import WelcomeEditorGuide, { previewWelcome, WELCOME_TOKENS } from './WelcomeEditorGuide';
import {
  composeWelcome,
  renderWelcomeTemplate,
  type WelcomeOpeningStep,
  type WelcomeOrientation,
} from '../../../../../../backend/lambda/src/lib/welcome-orientation.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const TEMPLATE = "Hi, I'm the {{role}} assistant.\nI opened this conversation because {{eventSummary}}\nHappy to help with {{topic}}.\nA few things to try:\n{{examples}}";
const OPS = 'An alert opened this conversation: {{eventSummary}}\nI can read the metrics behind it.';
const opens = (opening: WelcomeOpeningStep, types?: string[]): EventWorkflow => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: { opening: { opening, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
});
/** An assistant whose own openings are for its conversation types, beside a welcome for every other room with prompts only. */
const BY_TYPE: Record<string, EventWorkflow> = {
  welcome: opens({ examples: ['Summarize the Q3 renewals'] }),
  'welcome-ops': opens({ text: OPS }, ['ops']),
  'welcome-ops-team': opens({ text: 'The ops team is here. {{eventSummary}}', examples: ['Summarize the Q3 renewals'] }, ['ops-team']),
};

describe('the welcome guide', () => {
  it('says what the built-in opening is made of, and shows a conditional line and a per-type example', () => {
    render(<WelcomeEditorGuide workflows={null} onInsert={vi.fn()} />);
    expect(screen.getByTestId('welcome-built-in')).toHaveTextContent('A few things you can try:');
    expect(screen.getByTestId('welcome-example').textContent).toContain('\nI opened this conversation because {{eventSummary}}\n');
    expect(screen.getByTestId('welcome-type-example').textContent).toContain('{{eventSummary}}');
  });

  it('lists every field Opening text may name, with what it holds, and inserts one', () => {
    const onInsert = vi.fn();
    render(<WelcomeEditorGuide workflows={null} onInsert={onInsert} />);
    const tokens = screen.getByTestId('welcome-tokens');
    for (const token of WELCOME_TOKENS) expect(within(tokens).getByRole('button', { name: `Insert {{${token}}}` })).toBeTruthy();
    expect(tokens).toHaveTextContent('What happened, when an event such as an alert opened the conversation.');
    fireEvent.click(within(tokens).getByRole('button', { name: 'Insert {{topic}}' }));
    expect(onInsert).toHaveBeenCalledWith('{{topic}}');
  });

  it('renders the built-in opening itself when no opening text applies', () => {
    render(<WelcomeEditorGuide workflows={BY_TYPE} onInsert={vi.fn()} />);
    const preview = screen.getByTestId('welcome-preview');
    expect(preview.textContent).toBe(composeWelcome({ examples: ['Summarize the Q3 renewals'], topic: 'the Q3 renewal forecast' }).content);
    expect(preview.textContent).toContain('I can help with the Q3 renewal forecast.');
    expect(preview.textContent).toContain('- Summarize the Q3 renewals');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('No opening text applies, so the built-in opening is used.');
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'continued' } });
    expect(preview.textContent).toContain('This conversation picks up the Q3 renewal forecast');
  });

  it('previews a template for a sample conversation, dropping a line naming a field the sample lacks', () => {
    render(<WelcomeEditorGuide workflows={{ welcome: opens({ text: TEMPLATE, examples: ['Summarize the Q3 renewals'] }) }} role="primary" onInsert={vi.fn()} />);
    const preview = screen.getByTestId('welcome-preview');
    expect(preview.textContent).toBe("Hi, I'm the primary assistant.\nHappy to help with the Q3 renewal forecast.\nA few things to try:\n- Summarize the Q3 renewals");
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('The opening text of the welcome for every other conversation applies.');
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'event' } });
    expect(preview.textContent).toContain('I opened this conversation because p95 latency on the checkout API');
    expect(preview.textContent).not.toContain('Happy to help with');
  });

  it('follows the selected conversation type: its own welcome replaces the one for every other room, and says so', () => {
    const own = { ...BY_TYPE, welcome: opens({ text: 'Default for {{topic}}.', examples: ['Summarize the Q3 renewals'] }) };
    const { rerender } = render(<WelcomeEditorGuide workflows={own} conversationType="ops" onInsert={vi.fn()} />);
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'event' } });
    expect(screen.getByTestId('welcome-preview').textContent)
      .toBe('An alert opened this conversation: p95 latency on the checkout API crossed its target for 10 minutes.\nI can read the metrics behind it.');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('The opening text for ops applies.');
    rerender(<WelcomeEditorGuide workflows={own} conversationType="incident" onInsert={vi.fn()} />);
    fireEvent.change(screen.getByTestId('welcome-sample'), { target: { value: 'topic' } });
    expect(screen.getByTestId('welcome-preview').textContent).toBe('Default for the Q3 renewal forecast.');
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('incident has no welcome of its own, so the welcome for every other conversation applies.');
  });

  it('names the deployment parameter when the welcome that applies says nothing of its own', () => {
    render(<WelcomeEditorGuide workflows={{ 'welcome-ops': opens({ text: OPS }, ['ops']) }} classification="premium" onInsert={vi.fn()} />);
    expect(screen.getByTestId('welcome-applies')).toHaveTextContent('/agent-echelon/assistant/premium/welcome-orientation');
  });
});

describe('the preview and the server renderer agree', () => {
  const event: WelcomeOrientation = { eventSummary: 'Checkout p95 crossed its SLA.' };
  const topic: WelcomeOrientation = { topic: 'the board deck' };
  const continued: WelcomeOrientation = { priorSubject: 'the board deck', priorMessage: 'Can you draft slide 3 with the ARR bridge?' };

  const templated: Array<[string, WelcomeOpeningStep, string | undefined, WelcomeOrientation]> = [
    ['a template, a topic', { text: TEMPLATE, examples: ['Draft the update'] }, undefined, topic],
    ['a template, an event', { text: TEMPLATE, examples: ['Draft the update'] }, undefined, event],
    ['a type\'s own, an event', { text: OPS, examples: ['Draft the update'] }, 'ops', event],
    ['a type\'s own, a topic', { text: 'The ops team is here. {{eventSummary}}', examples: ['Draft the update'] }, 'ops-team', topic],
  ];
  it.each(templated)('%s', (_name, opening, type, conversation) => {
    const orientation: WelcomeOrientation = { ...conversation, examples: opening.examples };
    const server = renderWelcomeTemplate(opening.text!, orientation, { role: 'ops' });
    const expected = server.content.trim() ? server.content : composeWelcome(orientation).content;
    expect(previewWelcome({ w: opens(opening, type ? [type] : undefined) }, type, conversation, 'ops').content).toBe(expected);
  });

  const builtIn: Array<[string, WelcomeOpeningStep, WelcomeOrientation]> = [
    ['the built-in opening, a topic', { examples: ['Draft the update'], companyName: 'Stratum', accessBlurb: 'You have standard access.' }, topic],
    ['the built-in opening, a continuation', { examples: ['Draft the update'], companyName: 'Stratum' }, continued],
    ['the built-in opening, nothing configured', {}, event],
  ];
  it.each(builtIn)('%s', (_name, opening, conversation) => {
    const orientation: WelcomeOrientation = { ...opening, ...conversation };
    expect(previewWelcome({ w: opens(opening) }, undefined, conversation).content).toBe(composeWelcome(orientation).content);
  });
});
