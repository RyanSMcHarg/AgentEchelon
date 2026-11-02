/**
 * ONE VARIABLE PICKER, AND THE CONDITIONS BUILT WITH IT (ADR-060 slice 1e).
 *
 * What it proves: the picker lists the version's variables and every source the classification publishes, each with
 * its type, its trust and whether it may decide; a condition refuses member text and, where the room reads what it
 * selects, a fact about a person; the operators offered follow the type; the server's own `whenErrors` is shown inline;
 * and each editor that gates edits its condition in place: a workflow step's `when` and a conditioned edge, a message's
 * `{ template, when }` alternatives, a routing rule over the classification's own models, and a template field bound
 * to a variable. The welcome inserts a version's variable by name.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
  buildSourceTable,
  catalogEntryForVariables,
  publishedVariables,
  type VersionVariable,
  type When,
} from '../../../../../../backend/lambda/src/lib/variables.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { MessageEntry } from '../../../../../../backend/lambda/src/lib/message-template.ts';
import VariablePicker, { pickRefusal, pickerRows } from './VariablePicker';
import ConditionBuilder, { operatorsFor, rowsOf, whenOf } from './ConditionBuilder';
import EventWorkflowEditor, { retarget, routerReads } from './EventWorkflowEditor';
import MessageChoicesEditor, { choicesOf, entryOf } from './MessageChoicesEditor';
import RoutingRulesEditor from './RoutingRulesEditor';
import { withFieldBinding } from './MessageTemplatesEditor';

const PUBLISHED = publishedVariables(buildSourceTable({
  catalog: [catalogEntryForVariables({
    key: 'x-deal', title: 'Deal desk', trust: 'operator', availability: 'always', describesPerson: false,
    fields: { stage: { type: 'string' }, amount: { type: 'number' }, note: { type: 'string', trust: 'member' } },
  })],
  classifications: ['basic', 'standard', 'premium'],
}));
const VARIABLES: Record<string, VersionVariable> = { firstName: { source: 'person:displayName' }, stage: { source: 'ctx:x-deal.stage' } };
const row = (testId: string, name: string) => screen.getByTestId(`${testId}-row-${name}`);

describe('the variable picker', () => {
  it('lists the version\'s variables first, then every published source, with type, trust and whether it decides', () => {
    const rows = pickerRows(PUBLISHED, VARIABLES);
    expect(rows.slice(0, 2).map((r) => r.name)).toEqual(['firstName', 'stage']);
    render(<VariablePicker published={PUBLISHED} variables={VARIABLES} purpose="insert" onPick={() => {}} testId="p" />);
    expect(row('p', 'ctx:x-deal.stage').textContent).toMatch(/string.*Operator.*Yes/);
    expect(row('p', 'ctx:x-deal.note').textContent).toMatch(/Member text.*No, inserted only/);
    expect(row('p', 'person:clearance').textContent).toMatch(/set.*Platform.*A fact about one person/);
    expect(row('p', 'firstName').textContent).toMatch(/person:displayName/);
  });

  it('refuses member text for a condition, and a fact about a person where the room reads it', () => {
    const onPick = vi.fn();
    render(<VariablePicker published={PUBLISHED} purpose="decide" audience="room" onPick={onPick} testId="p" />);
    expect(row('p', 'ctx:x-deal.note').dataset.refused).toBe('true');
    expect(screen.getByTestId('p-row-ctx:x-deal.note-why').textContent).toMatch(/never decides/);
    expect((screen.getByTestId('p-row-ctx:x-deal.note-pick') as HTMLButtonElement).disabled).toBe(true);
    expect(row('p', 'person:clearance').dataset.refused).toBe('true');
    fireEvent.click(screen.getByTestId('p-row-ctx:x-deal.stage-pick'));
    expect(onPick).toHaveBeenCalledWith('ctx:x-deal.stage', expect.objectContaining({ trust: 'operator' }));
    expect(pickRefusal({ mayDecide: true, describesPerson: true }, 'decide', 'addressed')).toBeUndefined();
    expect(pickRefusal({ mayDecide: false, describesPerson: true, mentionable: true }, 'insert', 'room')).toBe('admin.variables.refused.mentionOnly');
  });

  it('says when the classification\'s sources could not be read', () => {
    render(<VariablePicker purpose="insert" onPick={() => {}} testId="p" />);
    expect(screen.getByTestId('p-unread')).toBeTruthy();
  });
});

function Builder({ initial, onChange, selects = 'room' }: { initial?: When; onChange: (w: When | undefined) => void; selects?: 'room' | 'addressed' }) {
  const [value, setValue] = useState<When | undefined>(initial);
  return <ConditionBuilder value={value} selects={selects} published={PUBLISHED} variables={VARIABLES} testId="c"
    onChange={(w) => { onChange(w); setValue(w); }} />;
}

describe('the condition builder', () => {
  it('round-trips a condition: bare values are eq, a list is OR', () => {
    const when: When = [{ 'conversation:type': 'ops', 'ctx:x-deal.amount': { op: 'gt', value: 100 } }, { stage: 'won' }];
    expect(whenOf(rowsOf(when))).toEqual(when);
    expect(whenOf([])).toBeUndefined();
    expect(operatorsFor('set')).toEqual(['has', 'exists']);
    expect(operatorsFor('enum')).not.toContain('gt');
  });

  it('adds a variable through the picker with the operators its type takes, and refuses member text there', () => {
    const onChange = vi.fn();
    render(<Builder onChange={onChange} />);
    expect(screen.getByTestId('c-always')).toBeTruthy();
    expect(screen.getByTestId('c-picker-row-ctx:x-deal.note').dataset.refused).toBe('true');
    fireEvent.click(screen.getByTestId('c-picker-row-ctx:x-deal.amount-pick'));
    expect(onChange).toHaveBeenLastCalledWith({ 'ctx:x-deal.amount': 0 });
    const ops = within(screen.getByTestId('c-alt-0-row-0-op')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(ops).toEqual(['eq', 'ne', 'in', 'gt', 'lt', 'exists']);
    fireEvent.change(screen.getByTestId('c-alt-0-row-0-op'), { target: { value: 'gt' } });
    fireEvent.change(screen.getByTestId('c-alt-0-row-0-value'), { target: { value: '500' } });
    expect(onChange).toHaveBeenLastCalledWith({ 'ctx:x-deal.amount': { op: 'gt', value: 500 } });
    fireEvent.click(screen.getByTestId('c-or-picker-row-conversation:type-pick'));
    expect(onChange).toHaveBeenLastCalledWith([{ 'ctx:x-deal.amount': { op: 'gt', value: 500 } }, { 'conversation:type': expect.any(String) }]);
  });

  it('shows the server\'s refusal inline for a condition stored around the picker', () => {
    render(<Builder initial={{ 'ctx:x-deal.note': 'x', 'person:clearance': { op: 'gt', value: 1 } }} onChange={() => {}} />);
    const errors = screen.getByTestId('c-errors').textContent!;
    expect(errors).toMatch(/member text, which may be inserted but never decides/);
    expect(errors).toMatch(/gt applies to a number only/);
  });
});

const WORKFLOW: EventWorkflow = {
  on: 'assistant-joined', initial: 'opening',
  states: {
    opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'greet', onFailure: 'done' },
    greet: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

function WorkflowHarness({ onChange }: { onChange: (n: Record<string, EventWorkflow> | null) => void }) {
  const [workflows, setWorkflows] = useState<Record<string, EventWorkflow>>({ mine: WORKFLOW });
  return <EventWorkflowEditor workflows={workflows} tools={[]} published={PUBLISHED} variables={VARIABLES}
    templates={[{ name: 'workflow-opening', kind: 'message', source: '', origin: 'shipped' }, { name: 'workflow-subject-welcome', kind: 'message', source: '', origin: 'shipped' }]}
    onChange={(n) => { onChange(n); setWorkflows(n ?? {}); }} />;
}

describe('the event workflow editor edits conditions', () => {
  it('a step gets a when, from what the router reads', () => {
    const onChange = vi.fn();
    render(<WorkflowHarness onChange={onChange} />);
    // The greeting is addressed to the subject, so a fact about that person may gate it.
    expect(screen.getByTestId('event-workflow-step-1-when-builder-picker-row-person:onboarded').dataset.refused).toBe('false');
    // A context source is never read at an event, so it is not offered.
    expect(screen.queryByTestId('event-workflow-step-1-when-builder-picker-row-ctx:x-deal.stage')).toBeNull();
    fireEvent.click(screen.getByTestId('event-workflow-step-1-when-builder-picker-row-person:onboarded-pick'));
    expect(onChange.mock.calls.at(-1)![0].mine.states.greet.when).toEqual({ 'person:onboarded': true });
    // The room opening may not be gated on a fact about a person.
    expect(screen.getByTestId('event-workflow-step-0-when-builder-picker-row-person:onboarded').dataset.refused).toBe('true');
    expect(routerReads({ source: 'pref:length' } as never)).toBe(false);
  });

  it('an edge becomes a list of { to, when } whose last carries no condition', () => {
    const onChange = vi.fn();
    render(<WorkflowHarness onChange={onChange} />);
    fireEvent.change(screen.getByTestId('event-workflow-step-0-success-mode'), { target: { value: '__conditioned' } });
    expect(onChange.mock.calls.at(-1)![0].mine.states.opening.onSuccess).toEqual([{ to: 'greet' }]);
    fireEvent.click(screen.getByTestId('event-workflow-step-0-success-add-alternative'));
    fireEvent.click(screen.getByTestId('event-workflow-step-0-success-alt-0-when-picker-row-conversation:type-pick'));
    fireEvent.change(screen.getByTestId('event-workflow-step-0-success-alt-0-to'), { target: { value: 'done' } });
    const edge = onChange.mock.calls.at(-1)![0].mine.states.opening.onSuccess;
    expect(edge).toEqual([{ to: 'done', when: { 'conversation:type': expect.any(String) } }, { to: 'greet' }]);
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
  });

  it('renaming or removing a step follows it into a conditioned edge', () => {
    const edge = [{ to: 'a', when: { 'conversation:type': 'ops' } }, { to: 'b' }];
    expect(retarget(edge, 'a', 'c')).toEqual([{ to: 'c', when: { 'conversation:type': 'ops' } }, { to: 'b' }]);
    expect(retarget(edge, 'a', undefined)).toEqual([{ to: 'b' }]);
    expect(retarget('a', 'a', undefined)).toBeUndefined();
  });
});

describe('the template a message is said from, part of the Message templates section', () => {
  const OPTIONS = [{ value: '@shipped', label: 'shipped' }, { value: '@classification', label: 'classification' }, { value: 'mine', label: 'mine' }, { value: 'mine-vip', label: 'mine-vip' }];
  function Harness({ onChange }: { onChange: (n: MessageEntry | undefined) => void }) {
    const [entry, setEntry] = useState<MessageEntry | undefined>('mine');
    return <MessageChoicesEditor message="turn-failed" entry={entry} options={OPTIONS}
      published={PUBLISHED} variables={VARIABLES} onChange={(n) => { onChange(n); setEntry(n); }} />;
  }

  it('a message gets { template, when } alternatives, held to who reads it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('message-choice-add-alternative'));
    fireEvent.change(screen.getByTestId('message-choice-alt-0-template'), { target: { value: 'mine-vip' } });
    // The room reads the line, so a fact about the person is not offered; a version's variable on the catalog is.
    expect(screen.getByTestId('message-choice-alt-0-when-picker-row-person:clearance').dataset.refused).toBe('true');
    fireEvent.click(screen.getByTestId('message-choice-alt-0-when-picker-row-stage-pick'));
    expect(onChange).toHaveBeenLastCalledWith([{ template: 'mine-vip', when: { stage: '' } }, { template: 'mine' }]);
    fireEvent.click(screen.getByTestId('message-choice-alt-0-remove'));
    expect(onChange).toHaveBeenLastCalledWith('mine');
    expect(entryOf(choicesOf('x'))).toBe('x');
  });

  it('picks a template or a family for the message, and no choice removes the entry', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByTestId('message-choice-pick'), { target: { value: '@classification' } });
    expect(onChange).toHaveBeenLastCalledWith('@classification');
    fireEvent.change(screen.getByTestId('message-choice-pick'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('routing rules', () => {
  function Harness({ onChange }: { onChange: (n: Array<{ when: When; model: string }> | undefined) => void }) {
    const [rules, setRules] = useState<Array<{ when: When; model: string }>>([]);
    return <RoutingRulesEditor rules={rules} models={['claude_sonnet', 'nova_pro']} published={PUBLISHED}
      onChange={(n) => { onChange(n); setRules(n ?? []); }} />;
  }

  it('offers only the classification\'s models, and a condition the room may read', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByTestId('routing-rule-add'));
    expect(within(screen.getByTestId('routing-rule-0-model')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['claude_sonnet', 'nova_pro']);
    expect(screen.getByTestId('routing-rule-0-when-errors').textContent).toMatch(/names at least one variable/);
    expect(screen.getByTestId('routing-rule-0-when-alt-0-picker-row-person:clearance').dataset.refused).toBe('true');
    fireEvent.click(screen.getByTestId('routing-rule-0-when-alt-0-picker-row-signal:userLanguage-pick'));
    fireEvent.change(screen.getByTestId('routing-rule-0-model'), { target: { value: 'nova_pro' } });
    // The language signal is the deployment's declared languages (ADR-062 decision 4), so its first is the value offered.
    expect(onChange).toHaveBeenLastCalledWith([{ when: { 'signal:userLanguage': 'en' }, model: 'nova_pro' }]);
    fireEvent.click(screen.getByTestId('routing-rule-0-remove'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('a template field reads a variable', () => {
  const SOURCE = ['---', JSON.stringify({ kind: 'message', name: 'turn-failed', description: 'x', fields: { label: 'value:text' } }), '---', '# chat', 'Hello {{label}}.'].join('\n');

  it('binds the field in the front matter and inserts it in the text, numbering a clash', () => {
    const once = withFieldBinding(SOURCE, 'ctx:x-deal.stage');
    expect(once.field).toBe('stage');
    expect(once.source).toContain('"stage":"ctx:x-deal.stage"');
    expect(once.source.endsWith('Hello {{label}}. {{stage}}')).toBe(true);
    expect(withFieldBinding(once.source, 'stage').field).toBe('stage2');
    expect(withFieldBinding('not a template', 'stage').error).toBeTruthy();
  });
});
