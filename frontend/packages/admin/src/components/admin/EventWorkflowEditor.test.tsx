/**
 * A VERSION'S OWN EVENT WORKFLOWS ARE EDITED STEP BY STEP (ADR-061 decision 1, as built).
 *
 * What it proves: a workflow is added empty or copied from a platform one; steps are added, reordered and removed,
 * with the first step being where the run starts; edges are chosen from the other steps; the server's own rules are
 * shown inline (a deadline past the maximum, a missing type on conversation-opened); and the draft is patched with
 * exactly the workflows shown. A welcome (assistant-joined) alone takes an opening and a prompt turn (W1), and in the
 * draft the Welcome section names the welcome that greets and then continues.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import EventWorkflowEditor, { convertStep } from './EventWorkflowEditor';
import { shippedMessageTemplates } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';
import { EventWorkflowsFields, WelcomeFields } from './AssistantConfigFields';
import { PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import type { ToolDescriptor } from '../../services/profileService';

const listing = vi.hoisted(() => ({ refuse: false }));
vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: async () => {
    if (listing.refuse) throw new Error('profileName names the assistant whose templates these are');
    return { assistant: 'a', classification: 'premium', templates: [], family: {} };
  },
}));

const TOOLS: ToolDescriptor[] = [
  { name: 'read_deployment_health', category: 'context', changesState: false, description: 'reads', requires: '' },
  { name: 'advance_task_state', category: 'task', changesState: true, description: 'writes', requires: '' },
];
const TEMPLATES = [
  { name: 'workflow-opening', kind: 'message' as const, source: '', origin: 'shipped' as const },
  { name: 'ops-first-look', kind: 'prompt' as const, source: '', origin: 'shipped' as const },
];

function Harness({ initial, onChange }: { initial: Record<string, EventWorkflow>; onChange: (n: Record<string, EventWorkflow> | null) => void }) {
  const [workflows, setWorkflows] = useState(initial);
  return <EventWorkflowEditor workflows={workflows} templates={TEMPLATES} tools={TOOLS} onChange={(n) => { onChange(n); setWorkflows(n ?? {}); }} />;
}

function renderEditor(workflows: Record<string, EventWorkflow> = {}) {
  const onChange = vi.fn<(next: Record<string, EventWorkflow> | null) => void>();
  render(<Harness initial={workflows} onChange={onChange} />);
  const last = () => onChange.mock.calls.at(-1)?.[0];
  return { onChange, last };
}

describe('the event workflow editor', () => {
  it('adds an empty workflow whose opening is a send, valid as it stands', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'my-welcome' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    expect(last()).toEqual({ 'my-welcome': {
      on: 'assistant-joined', initial: 'opening',
      states: { opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    } });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
  });

  it('runs a workflow on person-joined and sends to the person who joined (ADR-061 decision 3)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'greet-joiner' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'person-joined' } });
    expect(last()!['greet-joiner'].on).toBe('person-joined');
    const audience = screen.getByTestId('event-workflow-steps').querySelector('select option[value="joined"]')!.parentElement as HTMLSelectElement;
    fireEvent.change(audience, { target: { value: 'joined' } });
    expect(last()!['greet-joiner'].states.opening.send).toMatchObject({ to: 'joined' });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    // `joined` is refused at an event that names nobody who joined, by the server's own rule.
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'assistant-joined' } });
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/is joined, which only person-joined carries/);
  });

  it('runs a workflow on invitation-sent and sends to the member who sent the invitation (ADR-061 decision 3)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'tell-inviter' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'invitation-sent' } });
    expect(last()!['tell-inviter'].on).toBe('invitation-sent');
    const audience = screen.getByTestId('event-workflow-steps').querySelector('select option[value="invitation:inviter"]')!.parentElement as HTMLSelectElement;
    fireEvent.change(audience, { target: { value: 'invitation:inviter' } });
    expect(last()!['tell-inviter'].states.opening.send).toMatchObject({ to: { people: 'invitation:inviter' } });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    // The inviter exists only at an invitation's events, by the server's own rule.
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'person-joined' } });
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/names invitation:inviter, which only invitation-sent and invitation-unredeemed carry/);
  });

  it('runs a workflow on the deadline invitation-unredeemed, with its deadline, and an agent step proposing a reminder (ADR-061 slice 3d)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'chase' } });
    fireEvent.change(screen.getByTestId('event-workflow-copy-from'), { target: { value: 'chase-unredeemed' } });
    fireEvent.click(screen.getByTestId('event-workflow-copy'));
    expect(last()!.chase).toMatchObject({ on: 'invitation-unredeemed', deadline: { afterMinutes: 4320 } });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    fireEvent.change(screen.getByTestId('event-workflow-deadline-after'), { target: { value: '60' } });
    expect(last()!.chase.deadline).toEqual({ afterMinutes: 60 });
    // The step proposes a reminder; turned off, it only posts.
    expect((screen.getByTestId('event-workflow-step-0-propose') as HTMLSelectElement).value).toBe('send_nudge');
    fireEvent.change(screen.getByTestId('event-workflow-step-0-propose'), { target: { value: '' } });
    expect(last()!.chase.states['draft-nudge'].agent!.propose).toBeUndefined();
    // Moved to an event with no deadline, the workflow drops its deadline, as the server requires.
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'invitation-sent' } });
    expect(last()!.chase.deadline).toBeUndefined();
  });

  it('copies a platform workflow under a new name, and offers only read tools on its agent step', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'ops-mine' } });
    fireEvent.change(screen.getByTestId('event-workflow-copy-from'), { target: { value: 'ops-room' } });
    fireEvent.click(screen.getByTestId('event-workflow-copy'));
    expect(Object.keys(last()!)).toEqual(['ops-mine']);
    expect(last()!['ops-mine'].on).toBe('conversation-opened');
    const steps = screen.getByTestId('event-workflow-steps').textContent ?? '';
    expect(steps).toContain('read_deployment_health');
    expect(steps).not.toContain('advance_task_state');
  });

  it('adds, reorders and removes steps, and the first step is where the run starts', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'w' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.click(screen.getByTestId('event-workflow-add-agent'));
    expect(Object.keys(last()!.w.states)).toEqual(['opening', 'done', 'step-3']);
    expect(last()!.w.states['step-3']).toMatchObject({ agent: { prompt: 'ops-first-look', deadlineMs: 20000 }, onSuccess: 'done' });
    fireEvent.click(screen.getByTestId('event-workflow-step-2-up'));
    expect(Object.keys(last()!.w.states)).toEqual(['opening', 'step-3', 'done']);
    fireEvent.click(screen.getByTestId('event-workflow-step-0-down'));
    expect(last()!.w.initial).toBe('step-3');
    // The server's rule is shown inline: an agent step may not open the run.
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/initial must be a send/);
    fireEvent.click(screen.getByTestId('event-workflow-step-0-remove'));
    expect(last()!.w.initial).toBe('opening');
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
  });

  it('a copied step the ops assistant takes keeps its role and its absent message when its fallback is edited (ADR-061 decision 1)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'watch' } });
    fireEvent.change(screen.getByTestId('event-workflow-copy-from'), { target: { value: 'incident-watch' } });
    fireEvent.click(screen.getByTestId('event-workflow-copy'));
    fireEvent.change(screen.getByTestId('event-workflow-step-1-fallback'), { target: { value: 'workflow-opening' } });
    const recheck = last()!.watch.states.recheck.agent!;
    expect(recheck.fallback.send.template).toBe('workflow-opening');
    expect(recheck.as).toEqual({ role: 'ops' });
    expect(recheck.fallback.absent).toEqual({ to: 'room', template: 'ops-assistant-absent' });
  });

  it('shows a deadline past the maximum and a conversation-opened workflow with no types as the server refuses them', () => {
    renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'w' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.click(screen.getByTestId('event-workflow-add-agent'));
    fireEvent.change(screen.getByTestId('event-workflow-step-2-deadline'), { target: { value: '600' } });
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/deadlineMs is a whole number of milliseconds, at most 60000/);
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'conversation-opened' } });
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/declares the types an event opens/);
  });

  it('in the draft, an assistant-joined workflow is the welcome the Welcome section names, and removing it patches the draft', () => {
    const onPatch = vi.fn();
    const own: EventWorkflow = { on: 'assistant-joined', initial: 'opening', states: { opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    const config = { modelKey: 'm', eventWorkflows: { 'my-welcome': own } };
    render(<><WelcomeFields config={config} onPatch={vi.fn()} profileName="a" tools={TOOLS} /><EventWorkflowsFields config={config} onPatch={onPatch} profileName="a" tools={TOOLS} /></>);
    // It greets and then continues, so the Welcome step points here rather than offering a prompt turn.
    expect(screen.getByTestId('draft-welcome-runs')).toHaveTextContent('my-welcome');
    fireEvent.click(screen.getByTestId('event-workflow-remove'));
    expect(onPatch).toHaveBeenLastCalledWith({ eventWorkflows: null });
  });

  it('a welcome takes an opening and a prompt turn, and no other event offers them (W1)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'greet' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.change(screen.getByTestId('event-workflow-step-0-kind'), { target: { value: 'opening' } });
    expect(last()!.greet.states.opening).toEqual({ opening: {}, onSuccess: 'done', onFailure: 'done' });
    fireEvent.change(screen.getByTestId('event-workflow-step-0-opening-text'), { target: { value: 'Hello about {{topic}}.' } });
    expect(last()!.greet.states.opening.opening).toEqual({ text: 'Hello about {{topic}}.' });
    fireEvent.click(screen.getByTestId('event-workflow-add-prompt'));
    expect(Object.values(last()!.greet.states).some((d) => d.prompt)).toBe(true);
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    // Off assistant-joined the welcome's own steps are not offered, and the server refuses the ones the workflow has.
    fireEvent.change(screen.getByTestId('event-workflow-on'), { target: { value: 'person-joined' } });
    expect(screen.queryByTestId('event-workflow-add-opening')).toBeNull();
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/which only the welcome takes \(on assistant-joined\)/);
  });

  it('EVENT WORKFLOWS ARE THEIR OWN STEP of the draft, not part of the welcome, and say what they are behind their help', () => {
    const own: EventWorkflow = { on: 'invitation-unredeemed', deadline: { afterMinutes: 4320 }, initial: 'nudge', states: { nudge: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    const config = { modelKey: 'm', eventWorkflows: { chase: own } };
    render(<><WelcomeFields config={config} onPatch={vi.fn()} profileName="a" tools={TOOLS} /><EventWorkflowsFields config={config} onPatch={vi.fn()} profileName="a" tools={TOOLS} /></>);
    const section = screen.getByTestId('draft-event-workflows');
    expect(section.querySelector('h5')?.textContent).toContain('Event workflows');
    // Edited on the visual builder (ADR-061 decision 7), whose list view is this editor.
    expect(within(section).getByTestId('workflow-builder')).toBeTruthy();
    expect(within(screen.getByTestId('draft-welcome')).queryByTestId('workflow-builder')).toBeNull();
    fireEvent.click(within(section).getByTestId('wfb-view-list'));
    expect(within(section).getByTestId('event-workflow-editor')).toBeTruthy();
    // What an event workflow is, that the welcome is one of them, and that task machines are elsewhere: behind its help control.
    fireEvent.focus(within(section.querySelector('h5') as HTMLElement).getByRole('button'));
    const help = screen.getByRole('tooltip').textContent ?? '';
    expect(help).toMatch(/steps this assistant runs when a platform event happens/);
    expect(help).toMatch(/it joins a conversation \(its welcome\)/);
    expect(help).toMatch(/Task machines are separate: they are declared in the classification's intent pack and selected under Workflows/);
    // The welcome has no mode picker of its own (W1): it is the assistant-joined workflow.
    expect(screen.queryByTestId('draft-welcome-mode')).toBeNull();
  });
});

describe('mentions and a step\'s kind (ADR-061 decision 2)', () => {
  const shipped = shippedMessageTemplates();
  const WITH_SOURCES = ['ops-room-opening', 'workflow-subject-welcome', 'ops-first-look'].map((name) => ({
    name, kind: shipped.get(name)!.template.kind === 'prompt' ? 'prompt' as const : 'message' as const, source: shipped.get(name)!.source, origin: 'shipped' as const,
  }));
  function Harness2({ initial, onChange }: { initial: Record<string, EventWorkflow>; onChange: (n: Record<string, EventWorkflow> | null) => void }) {
    const [workflows, setWorkflows] = useState(initial);
    return <EventWorkflowEditor workflows={workflows} templates={WITH_SOURCES} tools={TOOLS} onChange={(n) => { onChange(n); setWorkflows(n ?? {}); }} />;
  }
  const ops = (): EventWorkflow => JSON.parse(JSON.stringify(PLATFORM_EVENT_WORKFLOWS['ops-room']));
  function renderWith(initial: Record<string, EventWorkflow>) {
    const onChange = vi.fn<(next: Record<string, EventWorkflow> | null) => void>();
    render(<Harness2 initial={initial} onChange={onChange} />);
    return () => onChange.mock.calls.at(-1)?.[0];
  }

  it('shows a send\'s mention binding, and previews the template with the name rendered inert', () => {
    renderWith({ mine: ops() });
    expect((screen.getByTestId('event-workflow-step-0-mention-lead') as HTMLSelectElement).value).toBe('participantRole:lead');
    expect(screen.getByTestId('event-workflow-step-0-mention-preview').textContent).toContain('Dana Lee is leading it.');
  });

  it('addresses and mentions the participant roles its declared types declare (DESIGN-CONVERSATION-TYPES 6.1)', () => {
    const last = renderWith({ mine: ops() });
    const audience = screen.getByTestId('event-workflow-step-1-audience') as HTMLSelectElement;
    expect(audience.value).toBe('participantRole:lead');
    expect([...audience.options].map((o) => o.value)).toEqual(expect.arrayContaining(['participantRole:lead', 'participantRole:responder']));
    fireEvent.change(audience, { target: { value: 'participantRole:responder' } });
    expect(last()!.mine.states['greet-lead'].send!.to).toEqual({ participantRole: 'responder' });
    fireEvent.change(audience, { target: { value: 'event:person' } });
    expect(last()!.mine.states['greet-lead'].send!.to).toEqual({ people: 'event:person' });
    const mention = screen.getByTestId('event-workflow-step-0-mention-lead') as HTMLSelectElement;
    expect([...mention.options].map((o) => o.value)).toEqual(expect.arrayContaining(['participantRole:lead', 'participantRole:responder']));
  });

  it('binds a template field to the subject and removes a binding', () => {
    const wf = ops();
    wf.states.opening.send = { to: 'room', template: 'workflow-subject-welcome' };
    const last = renderWith({ mine: wf });
    fireEvent.change(screen.getByTestId('event-workflow-step-0-mention-add'), { target: { value: 'name' } });
    expect(last()!.mine.states.opening.send).toEqual({ to: 'room', template: 'workflow-subject-welcome', mention: { name: 'event:person' } });
    fireEvent.change(screen.getByTestId('event-workflow-step-0-mention-name'), { target: { value: 'subject' } });
    expect(last()!.mine.states.opening.send!.mention).toEqual({ name: 'subject' });
    fireEvent.click(screen.getByTestId('event-workflow-step-0-mention-name-remove'));
    expect(last()!.mine.states.opening.send).toEqual({ to: 'room', template: 'workflow-subject-welcome' });
  });

  it('changes a step\'s kind in place, keeping its edges and audience and clearing what the new kind lacks', () => {
    const last = renderWith({ mine: ops() });
    // greet-lead is a send to the room's lead, going on to first-look; the agent step it becomes keeps addressing the lead.
    fireEvent.change(screen.getByTestId('event-workflow-step-1-kind'), { target: { value: 'agent' } });
    const agent = last()!.mine.states['greet-lead'];
    expect(agent.send).toBeUndefined();
    expect(agent).toMatchObject({ agent: { to: { participantRole: 'lead' }, prompt: 'ops-first-look', deadlineMs: 20000 }, onSuccess: 'first-look', onFailure: 'first-look' });
    fireEvent.change(screen.getByTestId('event-workflow-step-1-kind'), { target: { value: 'end' } });
    expect(last()!.mine.states['greet-lead']).toEqual({ disposition: 'success' });
    fireEvent.change(screen.getByTestId('event-workflow-step-1-kind'), { target: { value: 'send' } });
    expect(last()!.mine.states['greet-lead']).toEqual({ send: { to: 'room', template: 'ops-room-opening' } });
  });

  it('convertStep is the same rule on its own', () => {
    const send = { send: { to: 'subject' as const, template: 'x', mention: { n: 'subject' as const } }, onSuccess: 'a', onFailure: 'b' };
    expect(convertStep(send, 'agent', ['m'], ['p'])).toEqual({
      agent: { prompt: 'p', tools: [], to: 'subject', deadlineMs: 20000, fallback: { send: { to: 'room', template: 'm' } } }, onSuccess: 'a', onFailure: 'b',
    });
    expect(convertStep(send, 'send', ['m'], ['p'])).toBe(send);
    // A participant role's audience survives the change, as any other audience does.
    const toLead = { send: { to: { participantRole: 'lead' }, template: 'x' }, onSuccess: 'a' };
    expect(convertStep(toLead, 'agent', ['m'], ['p']).agent!.to).toEqual({ participantRole: 'lead' });
    // An intake is offered to the one person the event names, and keeps the step's edges.
    expect(convertStep(send, 'intake', ['m'], ['p'], 'person-joined')).toEqual({ action: { tool: 'start_intake', to: 'joined' }, onSuccess: 'a', onFailure: 'b' });
    expect(convertStep(send, 'intake', ['m'], ['p'], 'assistant-joined').action!.to).toBe('subject');
    expect(convertStep(send, 'intake', ['m'], ['p'], 'conversation-opened').action!.to).toEqual({ people: 'event:person' });
  });

  it('an agent step may read the room and open a task the room works on', () => {
    const last = renderWith({ mine: ops() });
    const reads = screen.getByTestId('event-workflow-step-2-reads') as HTMLInputElement;
    fireEvent.click(reads);
    expect(last()!.mine.states['first-look'].agent!.reads).toBe('messages');
    const opens = screen.getByTestId('event-workflow-step-2-opens-task') as HTMLSelectElement;
    expect([...opens.options].map((o) => o.value)).toEqual(['', 'incident_first_look']);
    fireEvent.change(opens, { target: { value: '' } });
    expect(last()!.mine.states['first-look'].agent!.workflow).toBeUndefined();
  });

  it('adds a task step that assigns an acknowledgement, valid as it stands, and edits who does it and its deadline (ADR-063)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'ask' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.click(screen.getByTestId('event-workflow-add-task'));
    const task = Object.values(last()!.ask.states).find((d) => d.task)!.task!;
    expect(task).toEqual({ machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 1440 } });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    const i = Object.keys(last()!.ask.states).indexOf(Object.entries(last()!.ask.states).find(([, d]) => d.task)![0]);
    fireEvent.change(screen.getByTestId('event-workflow-step-' + i + '-task-machine'), { target: { value: 'approval' } });
    fireEvent.change(screen.getByTestId('event-workflow-step-' + i + '-task-deadline'), { target: { value: '1' } });
    expect(Object.values(last()!.ask.states).find((d) => d.task)!.task!.machine).toBe('approval');
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/every task a workflow assigns has an end/);
    const machines = [...(screen.getByTestId('event-workflow-step-' + i + '-task-machine') as HTMLSelectElement).options].map((o) => o.value);
    expect(machines).toContain('approval');
    expect(machines).not.toContain('queue_drain');
  });

  it('says when the message template list could not be read, rather than offering an empty list', async () => {
    listing.refuse = true;
    try {
      render(<EventWorkflowsFields config={{ modelKey: 'm' }} onPatch={vi.fn()} profileName="a" tools={TOOLS} />);
      expect((await screen.findByTestId('draft-event-templates-unreadable')).textContent).toMatch(/message template list could not be read/);
    } finally {
      listing.refuse = false;
    }
  });

  it('shows no such notice when the list was read', async () => {
    render(<EventWorkflowsFields config={{ modelKey: 'm' }} onPatch={vi.fn()} profileName="a" tools={TOOLS} />);
    await screen.findByTestId('draft-event-workflows');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('draft-event-templates-unreadable')).toBeNull();
  });
});
