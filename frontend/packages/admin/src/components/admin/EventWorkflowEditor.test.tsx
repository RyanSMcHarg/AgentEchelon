/**
 * A VERSION'S OWN EVENT WORKFLOWS ARE EDITED STEP BY STEP (ADR-061 decision 1, as built).
 *
 * What it proves: a workflow is added empty or copied from a platform one; steps are added, reordered and removed,
 * the start listed first and moved only by Start here, and a step no edge reaches flagged as never running; each step
 * offers only the kinds, audiences and mentions validation accepts at its event; edges are chosen from the other steps; the server's own rules are
 * shown inline (a deadline past the maximum, a missing type on conversation-opened); and the draft is patched with
 * exactly the workflows shown. A welcome (assistant-joined) alone takes an opening and a prompt turn (W1), and in the
 * draft the Welcome section names the welcome that greets and then continues.
 */
import { agentStepOpsRoom } from '../../test/agentStepOpsRoom';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import EventWorkflowEditor, { convertStep } from './EventWorkflowEditor';
import { shippedMessageTemplates } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';
import { EventWorkflowsFields } from './AssistantConfigFields';
import { type EventWorkflow, type IntakeAction, versionEventWorkflowsErrors } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { MAX_TASK_DEADLINE_MINUTES, MIN_TASK_DEADLINE_MINUTES } from '../../../../../../backend/lambda/src/lib/task-step.ts';
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

  it('copies a platform workflow under a new name, whose re-read is a request to the ops assistant saying what it needs', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'watch-mine' } });
    fireEvent.change(screen.getByTestId('event-workflow-copy-from'), { target: { value: 'incident-watch' } });
    fireEvent.click(screen.getByTestId('event-workflow-copy'));
    expect(Object.keys(last()!)).toEqual(['watch-mine']);
    expect(last()!['watch-mine'].on).toBe('alarm-state-changed');
    // A REQUEST (WT118): what is needed is this assistant's to say, and the rest is the owning assistant's.
    expect((screen.getByTestId('event-workflow-step-2-task-ask') as HTMLSelectElement).value).toBe('incident-recheck-ask');
    expect(screen.getByTestId('event-workflow-step-2-task-owner-decides')).toBeTruthy();
    expect(screen.queryByTestId('event-workflow-step-2-task-deadline')).toBeNull();
  });

  it('adds, reorders and removes steps; reordering never moves the start, and Start here does', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'w' } });
    fireEvent.click(screen.getByTestId('event-workflow-add'));
    fireEvent.click(screen.getByTestId('event-workflow-add-agent'));
    expect(Object.keys(last()!.w.states)).toEqual(['opening', 'done', 'step-3']);
    expect(last()!.w.states['step-3']).toMatchObject({ agent: { prompt: 'ops-first-look', deadlineMs: 20000 }, onSuccess: 'done' });
    // A step added to the end is one no edge reaches: flagged as never running, and not refused.
    expect(screen.getByTestId('event-workflow-step-2-unreached')).toHaveTextContent('step-3 never runs. Connect a step to it, or make it the start.');
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    fireEvent.click(screen.getByTestId('event-workflow-step-2-up'));
    expect(Object.keys(last()!.w.states)).toEqual(['opening', 'step-3', 'done']);
    expect(last()!.w.initial).toBe('opening');
    // The start is listed first, cannot be moved down or another step moved above it, and is moved only by Start here.
    expect(screen.getByTestId('event-workflow-step-0-is-start')).toBeTruthy();
    expect((screen.getByTestId('event-workflow-step-0-down') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('event-workflow-step-1-up') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('event-workflow-step-1-start'));
    expect(last()!.w.initial).toBe('step-3');
    // The server's rule is shown inline: an agent step may not open the run.
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/initial must be a send/);
    fireEvent.click(screen.getByTestId('event-workflow-step-0-remove'));
    expect(last()!.w.initial).toBe('opening');
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
  });

  it('a request changes only what it asks for, and a step of the run\'s own takes back its own controls (WT118)', () => {
    const { last } = renderEditor();
    fireEvent.change(screen.getByTestId('event-workflow-new-name'), { target: { value: 'watch' } });
    fireEvent.change(screen.getByTestId('event-workflow-copy-from'), { target: { value: 'incident-watch' } });
    fireEvent.click(screen.getByTestId('event-workflow-copy'));
    fireEvent.change(screen.getByTestId('event-workflow-step-2-task-ask'), { target: { value: '' } });
    expect(last()!.watch.states.recheck.task).toEqual({ machine: 'deployment_health', by: { assistantRole: 'ops' } });
    // A request names any intent its owner advertises, typed, because this version's machines say nothing about the owner's.
    expect((screen.getByTestId('event-workflow-step-2-task-intent') as HTMLInputElement).value).toBe('deployment_health');
    const role = screen.getByTestId('event-workflow-step-2-task-assistant-role');
    fireEvent.change(role, { target: { value: '' } });
    fireEvent.blur(role);
    expect(last()!.watch.states.recheck.task!.by).toBeUndefined();
    expect(screen.queryByTestId('event-workflow-step-2-task-ask')).toBeNull();
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

  it('in the draft, the welcome is a workflow in the builder, and the default one is required: removed, the built-in one runs and can be copied back', () => {
    const onPatch = vi.fn();
    const own: EventWorkflow = { on: 'assistant-joined', initial: 'opening', states: { opening: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    const config = { modelKey: 'm', eventWorkflows: { 'my-welcome': own } };
    render(<EventWorkflowsFields config={config} onPatch={onPatch} profileName="a" tools={TOOLS} />);
    expect(screen.queryByTestId('draft-welcome-required')).toBeNull();
    fireEvent.click(screen.getByTestId('wfb-view-list'));
    expect(screen.getByTestId('event-workflow-required')).toHaveTextContent('The default welcome. Removing it uses the built-in one.');
    fireEvent.click(screen.getByTestId('event-workflow-remove'));
    expect(onPatch).toHaveBeenLastCalledWith({ eventWorkflows: null });
    expect(screen.getByTestId('draft-welcome-required')).toHaveTextContent('the built-in one is used');
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

  it('EVERY WORKFLOW, THE WELCOME INCLUDED, IS EDITED IN THE ONE BUILDER, which says what they are behind its help', () => {
    const own: EventWorkflow = { on: 'invitation-unredeemed', deadline: { afterMinutes: 4320 }, initial: 'nudge', states: { nudge: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    const config = { modelKey: 'm', eventWorkflows: { chase: own } };
    render(<EventWorkflowsFields config={config} onPatch={vi.fn()} profileName="a" tools={TOOLS} />);
    const section = screen.getByTestId('draft-event-workflows');
    expect(section.querySelector('h4')?.textContent).toContain('Event workflows');
    // Edited on the visual builder (ADR-061 decision 7), whose list view is this editor.
    expect(within(section).getByTestId('workflow-builder')).toBeTruthy();
    // No second editor for the welcome: it is edited here with every other workflow.
    expect(screen.queryByTestId('draft-welcome')).toBeNull();
    fireEvent.click(within(section).getByTestId('wfb-view-list'));
    expect(within(section).getByTestId('event-workflow-editor')).toBeTruthy();
    // What an event workflow is, and that joining a conversation (the welcome) is one: behind its help control.
    fireEvent.focus(within(section.querySelector('h4') as HTMLElement).getByRole('button'));
    const help = screen.getByRole('tooltip').textContent ?? '';
    expect(help).toMatch(/Steps this assistant runs when something happens/);
    expect(help).toMatch(/joining a conversation/);
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
  const ops = (): EventWorkflow => agentStepOpsRoom();
  function renderWith(initial: Record<string, EventWorkflow>) {
    const onChange = vi.fn<(next: Record<string, EventWorkflow> | null) => void>();
    render(<Harness2 initial={initial} onChange={onChange} />);
    return () => onChange.mock.calls.at(-1)?.[0];
  }

  it('shows a send\'s mention binding, and previews the template with the name rendered inert', () => {
    renderWith({ mine: ops() });
    expect((screen.getByTestId('event-workflow-step-0-mention-lead') as HTMLSelectElement).value).toBe('participantRole:lead');
    expect(screen.getByTestId('event-workflow-step-0-mention-preview').textContent).toContain('Dana Lee is leading.');
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

  it('binds a template field to the person the event names, and removes a binding', () => {
    const wf = ops();
    wf.states.opening.send = { to: 'room', template: 'workflow-subject-welcome' };
    const last = renderWith({ mine: wf });
    fireEvent.change(screen.getByTestId('event-workflow-step-0-mention-add'), { target: { value: 'name' } });
    expect(last()!.mine.states.opening.send).toEqual({ to: 'room', template: 'workflow-subject-welcome', mention: { name: 'event:person' } });
    // The subject is known where the assistant joins, and only there, so conversation-opened does not offer it.
    const sources = [...(screen.getByTestId('event-workflow-step-0-mention-name') as HTMLSelectElement).options].map((o) => o.value);
    expect(sources).toContain('event:person');
    expect(sources).not.toContain('subject');
    fireEvent.click(screen.getByTestId('event-workflow-step-0-mention-name-remove'));
    expect(last()!.mine.states.opening.send).toEqual({ to: 'room', template: 'workflow-subject-welcome' });
  });

  it('binds a template field to the subject on assistant-joined, the one event that knows them', () => {
    const wf: EventWorkflow = { on: 'assistant-joined', initial: 'opening', states: { opening: { send: { to: 'room', template: 'workflow-subject-welcome' }, onSuccess: 'done' }, done: { disposition: 'success' } } };
    const last = renderWith({ mine: wf });
    fireEvent.change(screen.getByTestId('event-workflow-step-0-mention-add'), { target: { value: 'name' } });
    expect(last()!.mine.states.opening.send!.mention).toEqual({ name: 'subject' });
    const sources = [...(screen.getByTestId('event-workflow-step-0-mention-name') as HTMLSelectElement).options].map((o) => o.value);
    expect(sources).not.toContain('event:person');
    const audiences = [...(screen.getByTestId('event-workflow-step-0-audience') as HTMLSelectElement).options].map((o) => o.value).filter((v) => !v.startsWith('participantRole:'));
    expect(audiences).toEqual(['room', 'subject']);
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
    expect((convertStep(send, 'intake', ['m'], ['p'], 'assistant-joined').action as IntakeAction).to).toBe('subject');
    expect((convertStep(send, 'intake', ['m'], ['p'], 'conversation-opened').action as IntakeAction).to).toEqual({ people: 'event:person' });
    // A meeting keeps the step's edges, and emails its join link unless it is turned off.
    expect(convertStep(send, 'meeting', ['m'], ['p'], 'conversation-opened')).toEqual({ action: { tool: 'start_meeting', email: true }, onSuccess: 'a', onFailure: 'b' });
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
    expect(screen.getByTestId('event-workflow-errors').textContent).toMatch(/every task a run waits on has an end/);
    const machines = [...(screen.getByTestId('event-workflow-step-' + i + '-task-machine') as HTMLSelectElement).options].map((o) => o.value);
    expect(machines).toContain('approval');
    expect(machines).not.toContain('queue_drain');
  });

  it('says when the message template list could not be read, rather than offering an empty list', async () => {
    listing.refuse = true;
    try {
      render(<EventWorkflowsFields config={{ modelKey: 'm' }} onPatch={vi.fn()} profileName="a" tools={TOOLS} />);
      expect((await screen.findByTestId('draft-event-templates-unreadable')).textContent).toMatch(/Couldn't load message templates/);
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

describe('each step offers only what validation accepts at its event (ADR-061 decision 3)', () => {
  function Harness3({ initial }: { initial: Record<string, EventWorkflow> }) {
    const [workflows, setWorkflows] = useState(initial);
    return <EventWorkflowEditor workflows={workflows} templates={TEMPLATES} tools={TOOLS} onChange={(n) => setWorkflows(n ?? {})} />;
  }
  const one = (on: EventWorkflow['on'], first: EventWorkflow['states'][string], extra: Partial<EventWorkflow> = {}): Record<string, EventWorkflow> => ({
    w: { on, ...extra, initial: 'first', states: { first: { ...first, onSuccess: 'done' }, done: { disposition: 'success' } } },
  });
  // The participant roles every registered type declares are offered beside these, where a workflow names no types.
  const options = (id: string) => [...(screen.getByTestId(id) as HTMLSelectElement).options].map((o) => o.value).filter((v) => !v.startsWith('participantRole:'));

  it('a send offers the subject on assistant-joined alone, joined on person-joined, the inviter at an invitation', () => {
    render(<Harness3 initial={one('person-joined', { send: { to: 'room', template: 'workflow-opening' } })} />);
    expect(options('event-workflow-step-0-audience')).toEqual(['room', 'joined', 'event:person']);
  });

  it('an agent step at an invitation never addresses the invitee and never reads the room', () => {
    const agent = { agent: { prompt: 'ops-first-look', tools: [], to: 'room' as const, deadlineMs: 20_000, fallback: { send: { to: 'room' as const, template: 'workflow-opening' } } } };
    render(<Harness3 initial={one('invitation-sent', agent)} />);
    expect(options('event-workflow-step-0-agent-audience')).toEqual(['room', 'invitation:inviter']);
    expect(screen.queryByTestId('event-workflow-step-0-reads')).toBeNull();
  });

  it('an alarm offers no intake, and no task where no role of its types has one holder', () => {
    render(<Harness3 initial={one('alarm-state-changed', { send: { to: 'room', template: 'workflow-opening' } })} />);
    expect(screen.queryByTestId('event-workflow-add-intake')).toBeNull();
    expect(screen.queryByTestId('event-workflow-add-task')).toBeNull();
    expect(options('event-workflow-step-0-kind')).not.toContain('intake');
    expect(options('event-workflow-step-0-audience')).toEqual(['room']);
  });

  it('an invitation offers no intake, and its task is for the person the event names', () => {
    render(<Harness3 initial={one('invitation-sent', { send: { to: 'room', template: 'workflow-opening' } })} />);
    expect(screen.queryByTestId('event-workflow-add-intake')).toBeNull();
    fireEvent.click(screen.getByTestId('event-workflow-add-task'));
    expect(options('event-workflow-step-2-task-for')).toEqual(['', 'event:person', 'invitation:inviter']);
  });
});

describe('a meeting step\'s start', () => {
  const OPS = {
    'ops-meeting': {
      on: 'event-received', types: ['ops-team'], initial: 'tell',
      states: {
        tell: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'meet', onFailure: 'meet' },
        meet: { action: { tool: 'start_meeting', email: true }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    },
  } as unknown as Record<string, EventWorkflow>;

  it('asks the on-call first, with a card to start or decline, and goes back to starting automatically', () => {
    const { last } = renderEditor(OPS);
    expect((screen.getByTestId('event-workflow-step-1-meeting-start') as HTMLSelectElement).value).toBe('auto');
    fireEvent.change(screen.getByTestId('event-workflow-step-1-meeting-start'), { target: { value: 'ask' } });
    const asked = last()!['ops-meeting'];
    expect(asked.states.tell.onSuccess).toBe('meet-offer');
    expect(asked.states['meet-offer'].task).toEqual(expect.objectContaining({ machine: 'meeting_offer', by: { participantRole: 'on-call:ops' } }));
    // The offer is listed before the meeting, which now shows who is asked.
    expect((screen.getByTestId('event-workflow-step-2-meeting-start') as HTMLSelectElement).value).toBe('ask');
    expect((screen.getByTestId('event-workflow-step-2-meeting-ask-by') as HTMLSelectElement).value).toBe('participantRole:on-call:ops');
    fireEvent.change(screen.getByTestId('event-workflow-step-2-meeting-start'), { target: { value: 'auto' } });
    expect(last()!['ops-meeting'].states).toEqual(OPS['ops-meeting'].states);
  });

  it('gives the person asked only minutes a task deadline accepts, and the field can be cleared while typing', () => {
    const { last } = renderEditor(OPS);
    fireEvent.change(screen.getByTestId('event-workflow-step-1-meeting-start'), { target: { value: 'ask' } });
    const minutes = screen.getByTestId('event-workflow-step-2-meeting-ask-minutes') as HTMLInputElement;
    expect(minutes.min).toBe(String(MIN_TASK_DEADLINE_MINUTES));
    expect(minutes.max).toBe(String(MAX_TASK_DEADLINE_MINUTES));
    const offerMinutes = () => last()!['ops-meeting'].states['meet-offer'].task!.deadline!.afterMinutes;
    fireEvent.change(minutes, { target: { value: '' } });
    expect(minutes.value).toBe('');
    fireEvent.change(minutes, { target: { value: String(MIN_TASK_DEADLINE_MINUTES - 1) } });
    fireEvent.change(minutes, { target: { value: String(MAX_TASK_DEADLINE_MINUTES + 1) } });
    expect(minutes.getAttribute('aria-invalid')).toBe('true');
    expect(offerMinutes()).toBe(15);
    fireEvent.change(minutes, { target: { value: '30' } });
    expect(offerMinutes()).toBe(30);
    expect(versionEventWorkflowsErrors(last()!)).toEqual([]);
  });

  it('changing a meeting that asks first to another kind removes its offer', () => {
    const { last } = renderEditor(OPS);
    fireEvent.change(screen.getByTestId('event-workflow-step-1-meeting-start'), { target: { value: 'ask' } });
    fireEvent.change(screen.getByTestId('event-workflow-step-2-kind'), { target: { value: 'send' } });
    const states = last()!['ops-meeting'].states;
    expect(Object.keys(states)).toEqual(['tell', 'meet', 'done']);
    expect(states.tell.onSuccess).toBe('meet');
    expect(states.meet.send).toBeDefined();
  });
});
