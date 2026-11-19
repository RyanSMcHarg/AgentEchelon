/**
 * A VARIABLE IS OFFERED WHERE IT IS READ, AND ONLY THERE.
 *
 * What it proves: the picker lists a `fact:` variable as the lookup reads it; a `ctx:` field of a context source the
 * version does not read is shown and refused; the welcome opening's picker offers only variables the join can say; an
 * opening field that names nothing is flagged; and a workflow condition offers only what the router holds at its event.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import VariablePicker, { pickerRows } from './VariablePicker';
import EventWorkflowEditor, { unknownOpeningFields } from './EventWorkflowEditor';
import type { PublishedVariables } from '../../../../../../backend/lambda/src/lib/variables.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const PUBLISHED: PublishedVariables = {
  sources: [
    { source: 'conversation:type', type: 'string', trust: 'platform', describesPerson: false, availability: 'conversation', insertAs: 'text', origin: 'the conversation', mayDecide: true },
    { source: 'ctx:crm.desk', type: 'string', trust: 'platform', describesPerson: false, availability: 'turn', insertAs: 'text', origin: 'crm', mayDecide: true },
  ] as never,
  facts: ['team'],
};

describe('the picker', () => {
  it('lists a fact variable, which the intake publishes apart from the sources', () => {
    const rows = pickerRows(PUBLISHED, { team: { source: 'fact:team' } } as never);
    expect(rows.find((r) => r.variable === 'team')?.src.source).toBe('fact:team');
  });

  it('refuses a field of a context source the version does not read, and says why', () => {
    render(<VariablePicker published={PUBLISHED} purpose="insert" contextSources={['other']} onPick={vi.fn()} testId="p" />);
    expect(screen.getByTestId('p-row-ctx:crm.desk')).toHaveAttribute('data-refused', 'true');
    expect(screen.getByTestId('p-row-ctx:crm.desk-why')).toHaveTextContent('does not read that context source');
  });
});

describe('the welcome opening', () => {
  const opens = (text: string): EventWorkflow => ({
    on: 'assistant-joined', initial: 'opening',
    states: { opening: { opening: { text }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
  });

  it('flags a field that names no welcome field and no variable, whose line is always dropped', () => {
    expect(unknownOpeningFields('Hi {{topic}} and {{tpoic}} and {{team}}.', { team: { source: 'fact:team' } } as never)).toEqual(['tpoic']);
    render(<EventWorkflowEditor workflows={{ welcome: opens('Hello {{tpoic}}.') }} onChange={vi.fn()} tools={[]} />);
    expect(screen.getByTestId('event-workflow-step-0-opening-unknown')).toHaveTextContent('{{tpoic}}');
  });

  it('offers only variables the join can say: one it holds, or one with a fallback', () => {
    const variables = { kind: { source: 'conversation:type' }, team: { source: 'fact:team' }, named: { source: 'fact:team', fallback: 'your team' } } as never;
    render(<EventWorkflowEditor workflows={{ welcome: opens('Hi.') }} onChange={vi.fn()} tools={[]} published={PUBLISHED} variables={variables} />);
    const picker = screen.getByTestId('event-workflow-step-0-opening-variable');
    expect(within(picker).queryByTestId('event-workflow-step-0-opening-variable-row-kind')).not.toBeNull();
    expect(within(picker).queryByTestId('event-workflow-step-0-opening-variable-row-named')).not.toBeNull();
    expect(within(picker).queryByTestId('event-workflow-step-0-opening-variable-row-team')).toBeNull();
  });
});

describe('a workflow condition', () => {
  it('offers only what the router holds at the workflow\'s event', () => {
    const wf: EventWorkflow = {
      on: 'alarm-state-changed', initial: 'say',
      states: { say: { send: { to: 'room', template: 'workflow-opening' } as never, onSuccess: 'done' }, done: { disposition: 'success' } },
    } as never;
    render(<EventWorkflowEditor workflows={{ watch: wf }} onChange={vi.fn()} tools={[]} published={PUBLISHED} />);
    fireEvent.click(screen.getAllByText(/conditioned|condition/i)[0]);
    const pickers = document.querySelectorAll('[data-testid$="-row-ctx:crm.desk"]');
    expect(pickers.length).toBe(0);
  });
});

describe('the assistant\'s own name in a welcome', () => {
  it('keeps the line that says it in the workflow summary, as the name\'s placeholder', async () => {
    const { previewOpening } = await import('./eventWorkflowPreview');
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: { opening: { opening: { text: "Hi, I'm {{assistantName}}.\nAsk me anything." }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    };
    const p = previewOpening(wf, (f) => `<${f}>`);
    expect(p.content).toContain("Hi, I'm <assistantName>.");
    expect(p.placeholders).toContain('assistantName');
  });

  it('is the provisioned name when the version names none, and the version\'s variables reach the preview', async () => {
    const { welcomeContextFor } = await import('./WelcomeEditorGuide');
    const variables = { team: { source: 'fact:team', fallback: 'your team' } } as never;
    const ctx = welcomeContextFor({ version: { variables }, assistant: 'advisor', provisionedName: 'Advisor' });
    expect(ctx.assistantName).toBe('Advisor');
    expect(ctx.variables).toBe(variables);
    expect(welcomeContextFor({ version: { displayName: 'Ye Olde Advisor' }, assistant: 'advisor', provisionedName: 'Advisor' }).assistantName).toBe('Ye Olde Advisor');
  });
});
