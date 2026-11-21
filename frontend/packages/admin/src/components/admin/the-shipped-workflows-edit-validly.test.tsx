/**
 * THE PLATFORM'S WORKFLOWS, COPIED INTO A VERSION, ARE SHOWN AS THEY RUN AND STAY VALID UNDER EVERY EDIT THE CONSOLE MAKES.
 *
 * What it proves:
 *   - removing any step but the start of any shipped workflow, or inserting a step after any step, leaves a workflow the
 *     server accepts;
 *     a workflow already at the step limit takes no further step, and both views say so;
 *   - a conditioned edge whose unconditioned alternative went to a removed step goes to the end step, so the edge keeps its
 *     conditions and still ends on an alternative a failed read takes;
 *   - a wait on the conversation the run opens (`wait: { child }`) goes with the last step that opens one, whether that
 *     step is removed or becomes another kind;
 *   - a wait on the tasks the run goes on alongside (`wait: { alongside }`) goes with the last such task (WT129);
 *   - a task the run goes on alongside (`continue: 'alongside'`) and a wait on the opened conversation are shown and edited
 *     as they are: the editor selects each, keeps the deadline an alongside task needs, and the builder's nodes say them.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
  MAX_EVENT_WORKFLOW_STEPS, SHIPPED_EVENT_WORKFLOWS, versionEventWorkflowsErrors, type EventWorkflow,
} from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { TASK_STEP_ALONGSIDE } from '../../../../../../backend/lambda/src/lib/task-step.ts';
import { addStep, atStepLimit, changeStepKind, removeStep } from './workflowEdits';
import EventWorkflowEditor from './EventWorkflowEditor';
import WorkflowBuilder from './WorkflowBuilder';
import type { WorkflowLayout } from '../../../../../../backend/lambda/src/lib/workflow-layout.ts';

vi.mock('../../services/profileService', async (orig) => ({
  ...(await orig<typeof import('../../services/profileService')>()),
  listMessageTemplates: async () => ({ assistant: 'a', classification: 'premium', templates: [], family: {} }),
  previewWorkflowRun: vi.fn(),
}));

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const shipped = (name: string): EventWorkflow => clone(SHIPPED_EVENT_WORKFLOWS[name]);
import { TRIAGE_FIRST_WORKFLOWS } from './__tests__/processChainFixture';
const errorsOf = (name: string, wf: EventWorkflow) => versionEventWorkflowsErrors({ [name]: wf });
/** `ops-room` padded with sends to the step limit, which no shipped workflow reaches since the bound rose to 32 (WT129). */
function atLimit(): EventWorkflow {
  const wf = shipped('ops-room');
  const states = { ...wf.states } as Record<string, any>;
  for (let i = 0; Object.keys(states).length < MAX_EVENT_WORKFLOW_STEPS; i++) states[`pad-${i}`] = { send: { template: 'workflow-opening', to: 'room' }, onSuccess: 'done', onFailure: 'done' };
  states.done = { disposition: 'success' };
  states['runbook-verify'] = { ...states['runbook-verify'], onSuccess: 'pad-0', onFailure: 'pad-0' };
  return { ...wf, states } as EventWorkflow;
}
const TEMPLATES = [{ name: 'workflow-opening', kind: 'message' as const, source: '', origin: 'shipped' as const }];

describe('an edit on a shipped workflow keeps it valid', () => {
  it('every shipped workflow is valid as it ships', () => {
    for (const name of Object.keys(SHIPPED_EVENT_WORKFLOWS)) expect([name, errorsOf(name, shipped(name))]).toEqual([name, []]);
  });

  it('removing any step but the start leaves a workflow the server accepts', () => {
    // Removing the start makes the next step listed the start, which the person then sees checked against the rules for a
    // first step (a welcome's opens with a send or an opening); every other removal keeps the workflow valid by itself.
    for (const name of Object.keys(SHIPPED_EVENT_WORKFLOWS)) {
      for (const step of Object.keys(SHIPPED_EVENT_WORKFLOWS[name].states).filter((k) => k !== SHIPPED_EVENT_WORKFLOWS[name].initial)) {
        expect([name, step, errorsOf(name, removeStep(shipped(name), step))]).toEqual([name, step, []]);
      }
    }
  });

  it('a step inserted after any step is valid, and a workflow at the step limit takes none', () => {
    for (const name of Object.keys(SHIPPED_EVENT_WORKFLOWS)) {
      const wf = shipped(name);
      if (atStepLimit(wf)) {
        expect(Object.keys(wf.states)).toHaveLength(MAX_EVENT_WORKFLOW_STEPS);
        continue;
      }
      for (const after of Object.keys(wf.states)) {
        const { workflow } = addStep(wf, 'send', ['workflow-opening'], [], { after });
        expect([name, after, errorsOf(name, workflow)]).toEqual([name, after, []]);
      }
    }
    expect(atStepLimit(atLimit())).toBe(true);
  });

  it('a conditioned edge that loses its otherwise step goes to the end, keeping its conditions', () => {
    const wf = removeStep(shipped('ops-room'), 'greet-lead');
    expect(wf.states.opening.onSuccess).toEqual([{ to: 'lead-task', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }]);
    expect(wf.states.opening.onFailure).toEqual([{ to: 'lead-task', when: { 'event:openedBy': 'workflow' } }, { to: 'done' }]);
  });

  it('a wait on the opened conversation goes with the step that opens it, removed or changed to another kind', () => {
    // A TEAM'S OWN SHAPE, with a step in front of the open step (the shipped incident opens first).
    const removed = removeStep(clone(TRIAGE_FIRST_WORKFLOWS['incident-triage']), 'open');
    expect(Object.keys(removed.states)).toEqual(['triage', 'tell', 'report-timed-out', 'report-ended', 'tell-not-opened', 'done', 'failed']);
    expect(removed.states.tell).not.toHaveProperty('onSuccess');
    expect(removed.states.triage).not.toHaveProperty('onSuccess');
    expect(errorsOf('incident-triage', removed)).toEqual([]);
    const changed = changeStepKind(shipped('incident-triage'), 'open', 'send', ['workflow-opening'], []);
    expect(changed.states.hold).toBeUndefined();
    expect(changed.states.open.send).toBeTruthy();
    expect(errorsOf('incident-triage', changed)).toEqual([]);
  });
});

function Editor({ initial, onChange }: { initial: Record<string, EventWorkflow>; onChange: (n: Record<string, EventWorkflow> | null) => void }) {
  const [workflows, setWorkflows] = useState(initial);
  return <EventWorkflowEditor workflows={workflows} templates={TEMPLATES} tools={[]} onChange={(n) => { onChange(n); setWorkflows(n ?? {}); }} />;
}

function renderEditor(workflows: Record<string, EventWorkflow>) {
  const onChange = vi.fn<(next: Record<string, EventWorkflow> | null) => void>();
  render(<Editor initial={workflows} onChange={onChange} />);
  return () => onChange.mock.calls.at(-1)?.[0];
}

function Builder({ initial }: { initial: Record<string, EventWorkflow> }) {
  const [workflows, setWorkflows] = useState(initial);
  const [layout, setLayout] = useState<WorkflowLayout | undefined>(undefined);
  return (
    <WorkflowBuilder workflows={workflows} templates={TEMPLATES} tools={[]} profileName="ops-premium"
      layout={layout} onLayoutChange={(l) => setLayout(l ?? undefined)} onChange={(n) => setWorkflows(n ?? {})} />
  );
}

describe('the editor and the builder show and edit what the shipped workflows declare', () => {
  it('a task the run goes on alongside is selected as such, keeps its deadline, and can be set back', () => {
    const last = renderEditor({ 'ops-room': atLimit() });
    const step = screen.getByTestId('event-workflow-step-2');
    expect(within(step).getByTestId('event-workflow-step-2-task-continue')).toHaveValue(TASK_STEP_ALONGSIDE);
    expect(within(step).getByTestId('event-workflow-step-2-task-alongside')).toHaveTextContent('Only for a task this assistant runs');
    fireEvent.change(within(step).getByTestId('event-workflow-step-2-task-continue'), { target: { value: '' } });
    expect(last()!['ops-room'].states['lead-task'].task).not.toHaveProperty('continue');
    fireEvent.change(screen.getByTestId('event-workflow-step-2-task-continue'), { target: { value: TASK_STEP_ALONGSIDE } });
    expect(last()!['ops-room'].states['lead-task'].task).toMatchObject({ continue: TASK_STEP_ALONGSIDE, deadline: { afterMinutes: 43_200 } });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
    expect(screen.getByTestId('event-workflow-step-limit')).toHaveTextContent(`This workflow has ${MAX_EVENT_WORKFLOW_STEPS} steps`);
    expect(screen.getByTestId('event-workflow-add-send')).toBeDisabled();
  });

  it('a request to another assistant\'s role is not offered alongside', () => {
    renderEditor({ 'ops-room': shipped('ops-room') });
    const at = Object.keys(shipped('ops-room').states).indexOf('first-look');
    const firstLook = screen.getByTestId(`event-workflow-step-${at}`);
    const options = [...(within(firstLook).getByTestId(`event-workflow-step-${at}-task-continue`) as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['', 'opened']);
  });

  it('a wait on the opened conversation is selected as such, and can become a wait for a time', () => {
    const last = renderEditor({ 'incident-triage': shipped('incident-triage') });
    const id = `event-workflow-step-${Object.keys(shipped('incident-triage').states).indexOf('hold')}`;
    const hold = screen.getByTestId(id);
    expect(within(hold).getByTestId(`${id}-wait-for`)).toHaveValue('child');
    expect(within(hold).getByTestId(`${id}-wait-child`)).toHaveTextContent("Goes on once that conversation's own workflow ends");
    expect(within(hold).queryByTestId(`${id}-wait-minutes`)).toBeNull();
    expect(within(hold).queryByTestId(`${id}-wait-until`)).toBeNull();
    fireEvent.change(within(hold).getByTestId(`${id}-wait-for`), { target: { value: 'time' } });
    expect(last()!['incident-triage'].states.hold.wait).toEqual({ minutes: 60 });
    fireEvent.change(screen.getByTestId(`${id}-wait-for`), { target: { value: 'child' } });
    expect(last()!['incident-triage'].states.hold.wait).toEqual({ child: 'ended' });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
  });

  it('a wait on the tasks the run goes on alongside is selected as such, and can become a wait for a time', () => {
    const last = renderEditor({ 'ops-room': shipped('ops-room') });
    const i = Object.keys(shipped('ops-room').states).indexOf('investigation-complete');
    const id = `event-workflow-step-${i}`;
    const wait = screen.getByTestId(id);
    expect(within(wait).getByTestId(`${id}-wait-for`)).toHaveValue('alongside');
    expect(within(wait).getByTestId(`${id}-wait-alongside`)).toHaveTextContent('Goes on once each task kept open beside the work has ended');
    expect(within(wait).queryByTestId(`${id}-wait-minutes`)).toBeNull();
    expect(within(wait).queryByTestId(`${id}-wait-until`)).toBeNull();
    fireEvent.change(within(wait).getByTestId(`${id}-wait-for`), { target: { value: 'time' } });
    expect(last()!['ops-room'].states['investigation-complete'].wait).toEqual({ minutes: 60 });
    fireEvent.change(screen.getByTestId(`${id}-wait-for`), { target: { value: 'alongside' } });
    expect(last()!['ops-room'].states['investigation-complete'].wait).toEqual({ alongside: 'settled' });
    expect(screen.queryByTestId('event-workflow-errors')).toBeNull();
  });

  it('removing the last task the run goes on alongside removes the wait on it', () => {
    const one = removeStep(shipped('ops-room'), 'investigation');
    expect(one.states['investigation-complete']).toBeTruthy();
    const none = removeStep(one, 'lead-task');
    expect(none.states['investigation-complete']).toBeUndefined();
    expect(errorsOf('ops-room', none)).toEqual([]);
  });

  it('the builder says a wait on the tasks the run goes on alongside', () => {
    render(<Builder initial={{ 'ops-room': shipped('ops-room') }} />);
    expect(screen.getByTestId('wfb-node-investigation-complete')).toHaveTextContent('Waits for the tasks kept open beside the work to settle');
  });

  it('a send in the conversation that opened this one is said as such, in the editor and the builder (O24)', () => {
    renderEditor({ 'ops-room': shipped('ops-room') });
    const i = Object.keys(shipped('ops-room').states).indexOf('tell-team');
    expect(screen.getByTestId(`event-workflow-step-${i}-in-opener`)).toHaveTextContent('Said in the conversation that opened this one');
    render(<Builder initial={{ 'ops-room': shipped('ops-room') }} />);
    expect(screen.getByTestId('wfb-node-tell-team')).toHaveTextContent('incident-resolved-team in the conversation that opened this one');
  });

  it('a send in the conversation this run opened is said as such, in the editor and the builder (O33)', () => {
    renderEditor({ 'ops-room': shipped('ops-room') });
    const i = Object.keys(shipped('ops-room').states).indexOf('tell-messaging-resolved');
    expect(screen.getByTestId(`event-workflow-step-${i}-in-opened`)).toHaveTextContent('Said in the conversation this run opened');
    render(<Builder initial={{ 'ops-room': shipped('ops-room') }} />);
    expect(screen.getByTestId('wfb-node-tell-messaging-resolved')).toHaveTextContent('customer-messaging-resolved in the conversation this run opened');
  });

  it('the customer messaging workflow edits validly, and its approvals are told in the conversation that opened it (WT130)', () => {
    expect(errorsOf('customer-messaging', shipped('customer-messaging'))).toEqual([]);
    render(<Builder initial={{ 'customer-messaging': shipped('customer-messaging') }} />);
    expect(screen.getByTestId('wfb-node-tell-initial')).toHaveTextContent('customer-notice-approved in the conversation that opened this one');
    expect(screen.getByTestId('wfb-status')).toHaveTextContent("Meets the server's rules");
  });

  it('the builder says a wait on the opened conversation', () => {
    render(<Builder initial={{ 'incident-triage': shipped('incident-triage') }} />);
    expect(screen.getByTestId('wfb-node-hold')).toHaveTextContent('Waits for the conversation it opened to end');
    expect(screen.getByTestId('wfb-status')).toHaveTextContent("Meets the server's rules");
  });

  it('the builder says a task goes on alongside, and adds no step past the limit', () => {
    render(<Builder initial={{ 'ops-room': atLimit() }} />);
    expect(screen.getByTestId('wfb-node-lead-task')).toHaveTextContent('A incident_ownership task, alongside the run');
    expect(screen.getByTestId('wfb-step-limit')).toHaveTextContent(`${MAX_EVENT_WORKFLOW_STEPS} steps`);
    expect(screen.getByTestId('wfb-palette-send')).toBeDisabled();
    fireEvent.click(screen.getByTestId('wfb-node-opening'));
    expect(screen.getByTestId('wfb-add-after-opening')).toBeDisabled();
    expect(screen.getByTestId('wfb-status')).toHaveTextContent("Meets the server's rules");
  });
});
