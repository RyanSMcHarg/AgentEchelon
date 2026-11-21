/**
 * WHAT STARTS A WORKFLOW AND WHERE IT RUNS, IN ONE SECTION (DESIGN-EVENT-TARGETS 11.1).
 *
 * What it proves: each configured trigger is one line (its type, its name, an alarm's state, where it runs); the account's
 * rules and alarms, and the AgentEchelon events, are each one select listed as soon as their type is chosen, with a filter
 * above that narrows once three characters are typed; Edit opens the form with the trigger's type, its choice and where it
 * runs already chosen, for every type, and Save replaces the trigger it edits; a team sees its lines and changes none; a
 * pattern type's id pattern is shown and never edited; a lifecycle event is the workflow's own `on` and types; every list
 * and field fits its column; and the event policy is not in the editor but on the Alerts tab.
 */
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@ae/shared';
import WorkflowTriggers, { FILTER_MIN_CHARS, formOfTrigger, platformEventsOf, summarizePattern, arnName, whereOfTrigger } from './EventTriggerPanel';
import { declaredTypesFor } from './EventWorkflowEditor';
import { CapabilityTestProvider } from '../../capabilities';
import { CONVERSATION_TYPES } from '../../../../../../backend/lib/config/conversation-types.ts';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const svc = vi.hoisted(() => ({
  listEventTriggers: vi.fn(), attachEventTrigger: vi.fn(), removeEventTrigger: vi.fn(),
  listAccountAlarms: vi.fn(), listAccountRules: vi.fn(), readEventPolicy: vi.fn(), listDeclaredHandoffs: vi.fn(),
}));
vi.mock('../../services/eventTriggerService', () => svc);

const ALARM = 'arn:aws:cloudwatch:us-east-1:1:alarm:Customer-API-availability';
const QUEUE = 'arn:aws:cloudwatch:us-east-1:1:alarm:Orders-queue-depth';
const ALARM_PATTERN = JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: [ALARM], detail: { state: { value: ['ALARM'] } } });
const STEPS = { initial: 'done', states: { done: { disposition: 'success' } } } as const;
const onEvent = (types: string[]): EventWorkflow => ({ on: 'event-received', types, ...STEPS } as unknown as EventWorkflow);
const DECLARED = [{ assistant: 'accounts', classification: 'standard', process: 'customer-request', name: 'security-review', fields: { accountId: { type: 'id' }, requestKind: { type: 'enum', values: ['data-export', 'access-change'] }, dueBy: { type: 'time' } } }];
const listed = (...triggers: unknown[]) => svc.listEventTriggers.mockResolvedValue({ channelArn: 'arn:room', triggers });
const value = (testId: string) => (screen.getByTestId(testId) as HTMLSelectElement | HTMLInputElement).value;
const optionValues = (testId: string) => [...(screen.getByTestId(testId) as HTMLSelectElement).options].filter((o) => o.value).map((o) => o.value);

function renderSection(wf: EventWorkflow, opts: { assistant?: string; wrap?: (ui: React.ReactElement) => React.ReactElement } = {}) {
  const onPut = vi.fn();
  const ui = <WorkflowTriggers name="w" wf={wf} onPut={onPut} classification="premium" assistant={opts.assistant} typesFor={(on) => declaredTypesFor(on, 'premium')} />;
  render(opts.wrap ? opts.wrap(ui) : ui);
  return { onPut };
}

beforeEach(() => {
  vi.clearAllMocks();
  listed({ id: 'abc', workflow: 'w', ruleArn: 'arn:aws:events:us-east-1:1:rule/ae-premium-trigger-abc', pattern: ALARM_PATTERN }, { id: 'zzz', workflow: 'other', ruleArn: 'arn:other', pattern: null });
  svc.attachEventTrigger.mockResolvedValue({ id: 'n', ruleArn: 'arn:n' });
  svc.removeEventTrigger.mockResolvedValue({ removed: 'abc' });
  svc.listAccountAlarms.mockResolvedValue([
    { name: 'Customer-API-availability', arn: ALARM, state: 'OK', kind: 'metric' },
    { name: 'Orders-queue-depth', arn: QUEUE, state: 'ALARM', kind: 'metric' },
  ]);
  svc.listAccountRules.mockResolvedValue([
    { name: 'ticket-escalated', arn: 'arn:r1', pattern: JSON.stringify({ source: ['example.support'], 'detail-type': ['Ticket escalated'], detail: { ticketId: [{ exists: true }] } }), state: 'ENABLED', attached: false },
    { name: 'ae-premium-trigger-abc', arn: 'arn:r2', pattern: '{}', state: 'ENABLED', attached: true },
  ]);
  svc.readEventPolicy.mockResolvedValue({ allowedEventTypes: [{ source: 'ae.ops', detailType: 'Incident opened' }, { source: 'ae.alert', detailType: 'Admin alert' }, { source: 'ae.connector', detailType: 'app.order.shipped' }] });
  svc.listDeclaredHandoffs.mockResolvedValue(DECLARED);
});

describe('each configured trigger is one line', () => {
  it('names an attached alarm, its state and its team conversation, and lists only this workflow\'s triggers', async () => {
    renderSection(onEvent(['ops-team']));
    const line = await screen.findByTestId('trigger-line-abc');
    expect(within(line).getByTestId('trigger-line-abc-type')).toHaveTextContent('CloudWatch alarm');
    expect(within(line).getByTestId('trigger-line-abc-name')).toHaveTextContent('Customer-API-availability');
    expect(within(line).getByTestId('trigger-line-abc-when')).toHaveTextContent('When it goes into ALARM');
    expect(within(line).getByTestId('trigger-line-abc-runs-in')).toHaveTextContent('Runs in: the team conversation of ops-team');
    expect(screen.queryByTestId('trigger-line-zzz')).toBeNull();
    expect(svc.listEventTriggers).toHaveBeenCalledWith('ops-team', 'premium');
    expect(screen.getByTestId('trigger-add')).toHaveTextContent('+ Add another trigger');
  });

  it('lists no other assistant\'s trigger for a workflow of the same name', async () => {
    listed({ id: 'mine', workflow: 'w', ruleArn: null, pattern: ALARM_PATTERN, assistant: 'advisor' }, { id: 'theirs', workflow: 'w', ruleArn: null, pattern: ALARM_PATTERN, assistant: 'concierge' });
    renderSection(onEvent(['ops-team']), { assistant: 'advisor' });
    await screen.findByTestId('trigger-line-mine');
    expect(screen.queryByTestId('trigger-line-theirs')).toBeNull();
  });

  it('a lifecycle event is the workflow\'s own: one line, said as what happens, with where it runs', () => {
    renderSection({ on: 'person-joined', types: ['ops'], ...STEPS } as unknown as EventWorkflow);
    expect(screen.getByTestId('trigger-line-on-type')).toHaveTextContent('AgentEchelon event');
    expect(screen.getByTestId('trigger-line-on-name')).toHaveTextContent('A person is added to a conversation');
    expect(screen.getByTestId('trigger-line-on-runs-in')).toHaveTextContent('Runs in: ops conversations');
    expect(screen.queryByTestId('trigger-add')).toBeNull();
    expect(svc.listEventTriggers).not.toHaveBeenCalled();
  });
});

describe('each list is one select, listed as soon as its type is chosen', () => {
  it('the alarms, with their state; an alarm starts on entering ALARM only', async () => {
    renderSection(onEvent(['ops-team']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-alarm'));
    await waitFor(() => expect(svc.listAccountAlarms).toHaveBeenCalledWith(''));
    await waitFor(() => expect(optionValues('trigger-alarm-select')).toEqual(expect.arrayContaining([`alarm:${ALARM}`, `alarm:${QUEUE}`])));
    expect(screen.getByTestId('trigger-alarm-select').textContent).toContain('Orders-queue-depth (ALARM)');
    expect(screen.getByTestId('trigger-which').querySelectorAll('input[type="radio"]')).toHaveLength(0);
    fireEvent.change(screen.getByTestId('trigger-alarm-select'), { target: { value: `alarm:${QUEUE}` } });
    expect(screen.getByTestId('trigger-alarm-state')).toHaveTextContent('When it goes into ALARM');
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', { resourceArn: QUEUE }, undefined, undefined, undefined));
  });

  it('the rules, with source and detail type; one already a trigger cannot be chosen', async () => {
    renderSection(onEvent(['ops-team']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-eventbridge'));
    await waitFor(() => expect(svc.listAccountRules).toHaveBeenCalledWith(''));
    const select = await screen.findByTestId('trigger-rule-select') as HTMLSelectElement;
    expect(select.textContent).toContain('ticket-escalated: example.support · Ticket escalated');
    expect([...select.options].find((o) => o.value === 'rule:ae-premium-trigger-abc')!.disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'rule:ticket-escalated' } });
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', { rule: 'ticket-escalated' }, undefined, undefined, undefined));
  });

  it(`a filter above narrows a list only once ${FILTER_MIN_CHARS} characters are typed`, async () => {
    renderSection(onEvent(['ops-team']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-alarm'));
    await waitFor(() => expect(optionValues('trigger-alarm-select')).toHaveLength(2));
    fireEvent.change(screen.getByTestId('trigger-list-filter'), { target: { value: 'or' } });
    expect(optionValues('trigger-alarm-select')).toHaveLength(2);
    fireEvent.change(screen.getByTestId('trigger-list-filter'), { target: { value: 'ord' } });
    expect(optionValues('trigger-alarm-select')).toEqual([`alarm:${QUEUE}`]);
  });

  it('the AgentEchelon events in one select: the lifecycle events, the policy\'s platform events (never an admin notice), the hand-offs', async () => {
    renderSection({ on: 'person-joined', ...STEPS } as unknown as EventWorkflow);
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toContain('handoff:standard|customer-request|security-review|accounts'));
    const values = optionValues('trigger-event-select');
    expect(values.slice(0, 5)).toEqual(['on:person-joined', 'on:conversation-opened', 'on:assistant-joined', 'on:invitation-sent', 'on:invitation-unredeemed']);
    expect(values).toContain('platform:ae.ops|Incident opened');
    expect(values).not.toContain('platform:ae.alert|Admin alert');
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'on:conversation-opened' } });
    expect(screen.getByTestId('trigger-event-hint')).toHaveTextContent('Once, when the platform creates a conversation of this type.');
  });
});

describe('Edit opens the form with the trigger as it is', () => {
  it('a CloudWatch alarm: its type, the alarm, and its team conversation', async () => {
    renderSection(onEvent(['ops-team']), { assistant: 'ops-premium' });
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    expect(screen.getByTestId('trigger-source-alarm').getAttribute('aria-pressed')).toBe('true');
    expect(value('trigger-alarm-select')).toBe(`alarm:${ALARM}`);
    expect((screen.getByTestId('trigger-where-team') as HTMLInputElement).checked).toBe(true);
    expect(value('trigger-where-team-type')).toBe('ops-team');
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'w', { resourceArn: ALARM }, undefined, 'ops-premium', 'abc'));
  });

  it('an EventBridge rule: its type and the rule, which stays choosable as the one being replaced', async () => {
    listed({ id: 'abc', workflow: 'w', ruleArn: 'arn:aws:events:us-east-1:1:rule/ae-premium-trigger-abc', pattern: JSON.stringify({ source: ['aws.ec2'], 'detail-type': ['X'] }) });
    renderSection(onEvent(['ops-team']));
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    expect(screen.getByTestId('trigger-source-eventbridge').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(value('trigger-rule-select')).toBe('rule:ae-premium-trigger-abc'));
    const own = [...(screen.getByTestId('trigger-rule-select') as HTMLSelectElement).options].find((o) => o.value === 'rule:ae-premium-trigger-abc')!;
    expect(own.disabled).toBe(false);
  });

  it('a platform event: its type and the event', async () => {
    listed({ id: 'abc', workflow: 'w', ruleArn: null, pattern: JSON.stringify({ source: ['ae.ops'], 'detail-type': ['Incident opened'] }) });
    renderSection(onEvent(['ops-team']));
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    expect(screen.getByTestId('trigger-source-ae').getAttribute('aria-pressed')).toBe('true');
    expect(value('trigger-event-select')).toBe('platform:ae.ops|Incident opened');
  });

  it('a lifecycle event: the event, its deadline and its type', () => {
    renderSection({ on: 'invitation-unredeemed', types: ['ops'], deadline: { afterMinutes: 90 }, ...STEPS } as unknown as EventWorkflow);
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    expect(screen.getByTestId('trigger-source-ae').getAttribute('aria-pressed')).toBe('true');
    expect(value('trigger-event-select')).toBe('on:invitation-unredeemed');
    expect(value('event-workflow-deadline-after')).toBe('90');
    expect(value('trigger-where-in-type')).toBe('ops');
  });

  it('the conversation\'s watched alarm: the alarm type, the watched alarm and its type', () => {
    renderSection({ on: 'alarm-state-changed', types: ['ops'], ...STEPS } as unknown as EventWorkflow);
    expect(screen.getByTestId('trigger-line-on-name')).toHaveTextContent("The conversation's watched alarm");
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    expect(screen.getByTestId('trigger-source-alarm').getAttribute('aria-pressed')).toBe('true');
    expect(value('trigger-alarm-select')).toBe('on:alarm-state-changed');
    expect(value('trigger-where-in-type')).toBe('ops');
    for (const s of ['ae', 'eventbridge', 'alarm']) expect(screen.getByTestId(`trigger-source-${s}`)).toBeTruthy();
  });

  it('a watched conversation: the kind and the key path it reads', async () => {
    listed({ id: 'abc', workflow: 'w', ruleArn: null, pattern: JSON.stringify({ source: ['ae.ops'], 'detail-type': ['Incident updated'] }), kind: 'ops-incident', keyPath: '$.detail.incidentId' });
    renderSection(onEvent(['ops']));
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    expect((screen.getByTestId('trigger-where-watched') as HTMLInputElement).checked).toBe(true);
    expect(value('trigger-where-watched-type')).toBe('ops');
    expect(value('trigger-kind')).toBe('ops-incident');
    expect(value('trigger-key-path')).toBe('$.detail.incidentId');
  });

  it('a lifecycle event saves as the workflow\'s own event and types, with an unaccepted invitation\'s deadline', () => {
    const { onPut } = renderSection({ on: 'person-joined', ...STEPS } as unknown as EventWorkflow);
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'on:invitation-unredeemed' } });
    fireEvent.change(screen.getByTestId('event-workflow-deadline-after'), { target: { value: '90' } });
    fireEvent.change(screen.getByTestId('trigger-where-in-type'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByTestId('trigger-save'));
    expect(onPut).toHaveBeenLastCalledWith({ on: 'invitation-unredeemed', types: ['ops'], deadline: { afterMinutes: 90 }, ...STEPS });
  });

  it('an attached trigger on a lifecycle workflow moves it to event-received, in the type its target names', async () => {
    const { onPut } = renderSection({ on: 'person-joined', types: ['ops'], ...STEPS } as unknown as EventWorkflow);
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    fireEvent.click(screen.getByTestId('trigger-source-alarm'));
    await waitFor(() => expect(optionValues('trigger-alarm-select')).toContain(`alarm:${QUEUE}`));
    fireEvent.change(screen.getByTestId('trigger-alarm-select'), { target: { value: `alarm:${QUEUE}` } });
    fireEvent.change(screen.getByTestId('trigger-where-team-type'), { target: { value: 'ops-team' } });
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(onPut).toHaveBeenLastCalledWith({ on: 'event-received', types: ['ops-team'], ...STEPS }));
  });

  it('the only attached trigger, edited to a lifecycle event, changes the draft only: its rule stands, listed, until it is removed', async () => {
    listed({ id: 'abc', workflow: 'w', ruleArn: null, pattern: ALARM_PATTERN });
    let wf = onEvent(['ops-team']);
    const onPut = vi.fn((next: EventWorkflow) => { wf = next; });
    const ui = () => <WorkflowTriggers name="w" wf={wf} onPut={onPut} classification="premium" typesFor={(on) => declaredTypesFor(on, 'premium')} />;
    const { rerender } = render(ui());
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'on:person-joined' } });
    expect(screen.getByTestId('trigger-rule-kept')).toHaveTextContent('This trigger\'s rule keeps starting the active version');
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(onPut).toHaveBeenLastCalledWith({ on: 'person-joined', ...STEPS }));
    rerender(ui());
    // The active version still runs on the rule, so nothing is removed until a person removes it here.
    expect(svc.removeEventTrigger).not.toHaveBeenCalled();
    expect(screen.getByTestId('trigger-line-on')).toBeTruthy();
    expect(screen.getByTestId('trigger-line-abc-runs-in')).toHaveTextContent('Still starts the active version. Activating the draft removes it.');
    expect(screen.queryByTestId('trigger-edit-abc')).toBeNull();
    fireEvent.click(screen.getByTestId('trigger-remove-abc'));
    fireEvent.click(screen.getByTestId('trigger-remove-abc-confirm-button'));
    await waitFor(() => expect(svc.removeEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'abc', undefined));
    await waitFor(() => expect(screen.queryByTestId('trigger-line-abc')).toBeNull());
  });

  it('a lifecycle event is not offered where other rules start the workflow', async () => {
    renderSection(onEvent(['ops-team']));
    await screen.findByTestId('trigger-line-abc');
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    expect(optionValues('trigger-event-select')).not.toContain('on:person-joined');
    expect(screen.getByTestId('trigger-own-event-held')).toBeTruthy();
  });

  it('removes a trigger as the assistant whose version this editor holds', async () => {
    renderSection(onEvent(['ops-team']), { assistant: 'ops-premium' });
    fireEvent.click(await screen.findByTestId('trigger-remove-abc'));
    // Nothing is removed until it is confirmed.
    expect(screen.getByTestId('trigger-remove-abc-confirm')).toHaveTextContent('Remove this trigger?');
    expect(svc.removeEventTrigger).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('trigger-remove-abc-confirm-button'));
    await waitFor(() => expect(svc.removeEventTrigger).toHaveBeenCalledWith('ops-team', 'premium', 'abc', 'ops-premium'));
  });

  it('says every refusal in the console\'s own words, and never the server\'s English', async () => {
    renderSection(onEvent(['ops-team']));
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    svc.attachEventTrigger.mockRejectedValueOnce(new ApiError(409, 'server text in English', { code: 'PATTERN_NO_LEAD_ROLE', error: 'server text in English' }));
    fireEvent.click(screen.getByTestId('trigger-save'));
    expect((await screen.findByTestId('trigger-error')).textContent).toBe('This type declares no role with one holder, and its pattern names no person, so a conversation this event opens has no one to open for.');
    svc.attachEventTrigger.mockRejectedValueOnce(new ApiError(500, 'server text in English', { error: 'server text in English' }));
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(screen.getByTestId('trigger-error').textContent).toBe('The trigger service refused the request (status 500). Nothing was changed.'));
  });

  it('says a throttled attach in the console\'s own words', async () => {
    svc.attachEventTrigger.mockRejectedValue(new ApiError(429, 'server text in English', { code: 'TRIGGER_THROTTLED', error: 'server text in English' }));
    renderSection(onEvent(['ops-team']));
    fireEvent.click(await screen.findByTestId('trigger-edit-abc'));
    fireEvent.click(screen.getByTestId('trigger-save'));
    expect((await screen.findByTestId('trigger-error')).textContent).toContain('Nothing was attached');
  });
});

describe('a team sees its own triggers and changes none', () => {
  it('without manage-event-triggers: the lines, with no Edit, Remove or Add', async () => {
    renderSection(onEvent(['ops-team']), {
      assistant: 'ops-premium',
      wrap: (ui) => <CapabilityTestProvider role="team-members" capabilities={['view-event-triggers', 'edit-profiles']} assistants={['ops-premium']}>{ui}</CapabilityTestProvider>,
    });
    expect(await screen.findByTestId('trigger-line-abc')).toBeTruthy();
    expect(screen.queryByTestId('trigger-edit-abc')).toBeNull();
    expect(screen.queryByTestId('trigger-remove-abc')).toBeNull();
    expect(screen.queryByTestId('trigger-add')).toBeNull();
    expect(screen.getByTestId('trigger-read-only')).toBeTruthy();
  });
});

describe('a pattern type\'s id pattern is shown where one conversation per value is offered, never edited', () => {
  const types = CONVERSATION_TYPES as Record<string, unknown>;
  // A pattern conversation an event opens is opened for the type's one-holder role, so each type here declares one.
  const LEAD = { participants: { participantRoles: { lead: { from: [{ group: 'test-leads' }], holders: 'one' } } } };
  beforeAll(() => {
    types['test-ticket'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'ticket:{key}', ...LEAD };
    types['test-process-review'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'process:{key}', ...LEAD };
    types['test-leaderless'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'case:{key}' };
    types['test-person'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'desk:{person}' };
    types['test-process-leaderless'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'process:{key}' };
  });
  afterAll(() => { for (const k of ['test-ticket', 'test-process-review', 'test-leaderless', 'test-person', 'test-process-leaderless']) delete types[k]; });
  beforeEach(() => { svc.listEventTriggers.mockResolvedValue({ channelArn: null, triggers: [] }); });

  it('says the pattern read-only, asks for the key\'s field, and attaches a pattern trigger', async () => {
    renderSection(onEvent(['test-ticket']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-eventbridge'));
    await screen.findByTestId('trigger-rule-select');
    fireEvent.change(screen.getByTestId('trigger-rule-select'), { target: { value: 'rule:ticket-escalated' } });
    expect((screen.getByTestId('trigger-where-pattern') as HTMLInputElement).checked).toBe(true);
    const named = screen.getByTestId('trigger-where-pattern-name');
    expect(named).toHaveTextContent('Named ticket:{key}');
    expect(within(named).queryByRole('textbox')).toBeNull();
    fireEvent.change(screen.getByTestId('trigger-key-path'), { target: { value: '$.detail.ticketId' } });
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('test-ticket', 'premium', 'w', { rule: 'ticket-escalated' }, { kind: 'pattern', keyPath: '$.detail.ticketId' }, undefined, undefined));
  });

  it('Edit of a pattern trigger has its pattern target and key path chosen', async () => {
    svc.listEventTriggers.mockResolvedValue({ channelArn: null, triggers: [{ id: 'p1', workflow: 'w', ruleArn: null, pattern: JSON.stringify({ source: ['ae.ops'], 'detail-type': ['Incident opened'] }), kind: 'pattern', keyPath: '$.detail.ticketId' }] });
    renderSection(onEvent(['test-ticket']));
    fireEvent.click(await screen.findByTestId('trigger-edit-p1'));
    expect((screen.getByTestId('trigger-where-pattern') as HTMLInputElement).checked).toBe(true);
    expect(value('trigger-where-pattern-type')).toBe('test-ticket');
    expect(value('trigger-key-path')).toBe('$.detail.ticketId');
  });

  it('a hand-off arrives with its typed fields, and runs in a conversation per process', async () => {
    renderSection(onEvent(['test-process-review']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toContain('handoff:standard|customer-request|security-review|accounts'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'handoff:standard|customer-request|security-review|accounts' } });
    const fields = screen.getByTestId('trigger-handoff-fields');
    expect(fields).toHaveTextContent('It arrives with');
    expect(fields).toHaveTextContent('requestKind data-export · access-change');
    expect(screen.getByTestId('trigger-where')).toHaveTextContent('One conversation per customer-request, of type');
    fireEvent.click(screen.getByTestId('trigger-save'));
    await waitFor(() => expect(svc.attachEventTrigger).toHaveBeenCalledWith('test-process-review', 'premium', 'w', { handoff: { classification: 'standard', process: 'customer-request', name: 'security-review' } }, { kind: 'pattern', keyPath: '$.detail.processId' }, undefined, undefined));
  });

  it('Edit of a hand-off has the hand-off chosen', async () => {
    svc.listEventTriggers.mockResolvedValue({ channelArn: null, triggers: [{ id: 'h1', workflow: 'w', ruleArn: null, pattern: JSON.stringify({ source: ['ae.process.standard'], 'detail-type': ['customer-request.security-review'] }), kind: 'pattern', keyPath: '$.detail.processId' }] });
    renderSection(onEvent(['test-process-review']));
    fireEvent.click(await screen.findByTestId('trigger-edit-h1'));
    await waitFor(() => expect(value('trigger-event-select')).toBe('handoff:standard|customer-request|security-review|accounts'));
    expect((screen.getByTestId('trigger-where-pattern') as HTMLInputElement).checked).toBe(true);
  });

  it('a hand-off two assistants of one classification declare is two options, neither chosen, and the server\'s refusal is said in the console\'s words', async () => {
    svc.listDeclaredHandoffs.mockResolvedValue([...DECLARED, { ...DECLARED[0], assistant: 'billing' }]);
    renderSection(onEvent(['test-process-review']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toEqual(expect.arrayContaining(['handoff:standard|customer-request|security-review|accounts', 'handoff:standard|customer-request|security-review|billing'])));
    const options = [...(screen.getByTestId('trigger-event-select') as HTMLSelectElement).options].filter((o) => o.value.startsWith('handoff:'));
    expect(options).toHaveLength(2);
    expect(options.every((o) => o.disabled)).toBe(true);
    expect(options[0].textContent).toContain('declared by more than one standard assistant');
    // The server refuses such a hand-off too, and says so in the console's words.
    svc.listDeclaredHandoffs.mockResolvedValue(DECLARED);
    svc.attachEventTrigger.mockRejectedValueOnce(new ApiError(409, 'server text in English', { code: 'HANDOFF_AMBIGUOUS', error: 'server text in English' }));
    cleanup();
    renderSection(onEvent(['test-process-review']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toContain('handoff:standard|customer-request|security-review|accounts'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'handoff:standard|customer-request|security-review|accounts' } });
    fireEvent.click(screen.getByTestId('trigger-save'));
    expect((await screen.findByTestId('trigger-error')).textContent).toContain('More than one assistant of that classification declares this hand-off');
  });

  it('offers a hand-off only the pattern types the service accepts for one, and says why the rest are not offered', async () => {
    svc.listEventTriggers.mockResolvedValue({ channelArn: null, triggers: [] });
    const onPut = vi.fn();
    render(<WorkflowTriggers name="w" wf={onEvent(['test-process-review'])} onPut={onPut} classification="premium"
      typesFor={() => ['test-process-review', 'test-ticket', 'test-process-leaderless']} />);
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toContain('handoff:standard|customer-request|security-review|accounts'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'handoff:standard|customer-request|security-review|accounts' } });
    expect(optionValues('trigger-where-pattern-type')).toEqual(['test-process-review']);
    expect(screen.getByTestId('trigger-pattern-left-out-test-ticket')).toHaveTextContent('a hand-off runs only where the pattern is process:{key}');
    expect(screen.getByTestId('trigger-pattern-left-out-test-process-leaderless')).toHaveTextContent('it declares no role with one holder');
  });

  it('offers an event a pattern type only where it has a one-holder role, or names a person and the event is a connector fact', async () => {
    svc.listEventTriggers.mockResolvedValue({ channelArn: null, triggers: [] });
    render(<WorkflowTriggers name="w" wf={onEvent(['test-ticket'])} onPut={vi.fn()} classification="premium"
      typesFor={() => ['test-ticket', 'test-leaderless', 'test-person']} />);
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toContain('platform:ae.ops|Incident opened'));
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'platform:ae.ops|Incident opened' } });
    expect(optionValues('trigger-where-pattern-type')).toEqual(['test-ticket']);
    expect(screen.getByTestId('trigger-pattern-left-out-test-leaderless')).toHaveTextContent('it declares no role with one holder');
    expect(screen.getByTestId('trigger-pattern-left-out-test-person')).toHaveTextContent('its pattern names a person, trusted only from a connector fact');
    fireEvent.change(screen.getByTestId('trigger-event-select'), { target: { value: 'platform:ae.connector|app.order.shipped' } });
    expect(optionValues('trigger-where-pattern-type')).toEqual(['test-ticket', 'test-person']);
  });
});

describe('the form fits its column', () => {
  const css = fs.readFileSync(path.join(__dirname, 'AdminDashboard.css'), 'utf8');
  const rule = (selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[2] ?? '';

  it('every select and input in the form carries the class that holds it to its column', async () => {
    renderSection({ on: 'person-joined', ...STEPS } as unknown as EventWorkflow);
    fireEvent.click(screen.getByTestId('trigger-edit-on'));
    await waitFor(() => expect(optionValues('trigger-event-select').length).toBeGreaterThan(5));
    const form = screen.getByTestId('trigger-form');
    const fields = [...form.querySelectorAll('select, input:not([type="radio"])')];
    expect(fields.length).toBeGreaterThan(2);
    for (const f of fields) expect(f.className).toContain('admin-event-trigger-select');
    expect(form.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('that class is never wider than its column, the section is fluid, and its rows wrap', () => {
    expect(rule('.admin-event-trigger-select')).toMatch(/max-width: 100%/);
    expect(rule('.admin-event-trigger')).toMatch(/max-width: 100%/);
    expect(rule('.admin-event-trigger')).toMatch(/min-width: 0/);
    expect(rule('.admin-event-trigger')).not.toMatch(/max-width: \d+px/);
    expect(rule('.admin-event-trigger-row')).toMatch(/flex-wrap: wrap/);
  });

  it('the Workflows section alone takes the widest column, still fluid to the window', () => {
    expect(css).toMatch(/\.admin-tab\.admin-assistant-page-wide \{ max-width: min\(1680px, 100%\); \}/);
    const page = fs.readFileSync(path.join(__dirname, 'AssistantPage.tsx'), 'utf8');
    expect(page).toMatch(/section === 'workflows' && 'admin-assistant-page-wide'/);
  });
});

describe('the event policy is the deployment\'s, on the Alerts tab', () => {
  it('is not in the workflow\'s trigger section', async () => {
    renderSection(onEvent(['ops-team']));
    fireEvent.click(screen.getByTestId('trigger-add'));
    fireEvent.click(screen.getByTestId('trigger-source-ae'));
    await waitFor(() => expect(optionValues('trigger-event-select')).toContain('platform:ae.ops|Incident opened'));
    expect(screen.queryByTestId('event-policy-panel')).toBeNull();
  });

  it('is on the Alerts tab beside the admin notices, for a session that may change it', () => {
    const dashboard = fs.readFileSync(path.join(__dirname, 'AdminDashboard.tsx'), 'utf8');
    expect(dashboard).toMatch(/shownTab === 'alerts' && can\('manage-event-policy'\) && <EventPolicyPanel \/>/);
    const section = fs.readFileSync(path.join(__dirname, 'EventTriggerPanel.tsx'), 'utf8');
    expect(section).not.toMatch(/EventPolicyPanel/);
  });
});

describe('what a trigger listens for', () => {
  it('reads the event, source, resources, states and detail fields from the pattern', () => {
    expect(summarizePattern(ALARM_PATTERN)).toMatchObject({ detailTypes: ['CloudWatch Alarm State Change'], sources: ['aws.cloudwatch'], resources: [ALARM], states: ['ALARM'], detailPaths: ['$.detail.state'] });
    expect(summarizePattern('not json')).toBeUndefined();
    expect(arnName('arn:aws:events:us-east-1:1:rule/r1')).toBe('r1');
  });

  it('reads how an edit starts from the trigger: its alarm, its hand-off, its AgentEchelon event, or its own rule', () => {
    expect(formOfTrigger({ id: 'a', ruleArn: null, pattern: JSON.stringify({ resources: [ALARM] }) })).toEqual({ source: 'alarm', choice: `alarm:${ALARM}` });
    expect(formOfTrigger({ id: 'a', ruleArn: null, pattern: JSON.stringify({ source: ['ae.ops'], 'detail-type': ['Incident opened'] }) })).toEqual({ source: 'ae', choice: 'platform:ae.ops|Incident opened' });
    expect(formOfTrigger({ id: 'a', ruleArn: null, pattern: JSON.stringify({ source: ['ae.process.standard'], 'detail-type': ['customer-request.security-review'] }) })).toEqual({ source: 'ae', choice: 'handoff:standard|customer-request|security-review' });
    expect(formOfTrigger({ id: 'a', ruleArn: 'arn:aws:events:us-east-1:1:rule/ae-x', pattern: JSON.stringify({ source: ['aws.ec2'] }) })).toEqual({ source: 'eventbridge', choice: 'rule:ae-x' });
    expect(whereOfTrigger({ kind: 'ops-incident', keyPath: '$.detail.incidentId' }, 'ops')).toEqual({ mode: 'watched', type: 'ops', kind: 'ops-incident', keyPath: '$.detail.incidentId' });
    expect(whereOfTrigger({}, 'ops-team')).toEqual({ mode: 'team', type: 'ops-team' });
  });

  it('DENY: a process source or an admin notice is never offered as an AgentEchelon event', () => {
    expect(platformEventsOf({ allowedEventTypes: [{ source: 'ae.ops', detailType: 'Incident opened' }, { source: 'ae.alert', detailType: 'A' }, { source: 'ae.process.standard', detailType: 'x.y' }] })).toEqual([{ source: 'ae.ops', detailType: 'Incident opened' }]);
    expect(platformEventsOf(null)).toEqual([]);
  });
});
