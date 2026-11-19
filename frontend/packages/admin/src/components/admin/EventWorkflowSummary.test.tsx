/**
 * ONE EVENT WORKFLOW, READ AS THE RUNTIME RUNS IT (SPEC-ADMIN-CONSOLE "Assistants", Workflows).
 *
 * What it proves: a `person-joined` workflow's steps include the join recap the runtime adds after them
 * (`withJoinRecap`); a step no edge reaches is marked as never running; and a welcome names the conversation types a
 * `conversation-opened` workflow greets in its place (`arrivalWelcomeOwner`).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EventWorkflowSummary from './EventWorkflowSummary';
import { SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe('a workflow summary', () => {
  it('lists the join recap the runtime adds after a person-joined workflow\'s own steps', () => {
    const wf: EventWorkflow = {
      on: 'person-joined', initial: 'hi',
      states: { hi: { send: { to: 'joined', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } },
    };
    render(<EventWorkflowSummary name="greet" workflow={wf} />);
    const steps = screen.getByTestId('workflow-steps-greet').textContent ?? '';
    expect(steps).toContain('workflow-opening');
    expect(steps).toContain('join-recap');
    expect(steps.indexOf('workflow-opening')).toBeLessThan(steps.indexOf('join-recap'));
  });

  it('marks a step no edge reaches as never running', () => {
    const wf: EventWorkflow = clone(SHIPPED_EVENT_WORKFLOWS.welcome);
    wf.states.stray = { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' };
    render(<EventWorkflowSummary name="welcome" workflow={wf} />);
    expect(screen.getByTestId('workflow-steps-welcome')).toHaveTextContent('never runs: no edge reaches it');
  });

  it('a welcome names the types a conversation-opened workflow greets in its place', () => {
    const all = { welcome: clone(SHIPPED_EVENT_WORKFLOWS.welcome), 'ops-room': clone(SHIPPED_EVENT_WORKFLOWS['ops-room']) };
    render(<EventWorkflowSummary name="welcome" workflow={all.welcome} all={all} />);
    expect(screen.getByTestId('workflow-greeted-instead-welcome')).toHaveTextContent('ops (ops-room)');
  });

  it('says nothing of the kind where no workflow greets a room in the welcome\'s place', () => {
    const all = { welcome: clone(SHIPPED_EVENT_WORKFLOWS.welcome) };
    render(<EventWorkflowSummary name="welcome" workflow={all.welcome} all={all} />);
    expect(screen.queryByTestId('workflow-greeted-instead-welcome')).toBeNull();
  });
});
