import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import WorkflowBuilder, { type TaskMachineSource } from './WorkflowBuilder';

/**
 * THE BUILDER'S TWO MODES ARE ONE BUILDER (ADR-067 stage 4).
 *
 * A selected task step on a run offers its machine's steps, which open on the same builder in its task-machine mode with
 * a way back to the run; an edit there reaches the machine source, which patches the draft's pack; and a platform
 * machine, which no version edits, is said rather than opened.
 */
const report: EventWorkflow = {
  on: 'person-joined',
  initial: 'work',
  states: {
    work: { task: { machine: 'incident_first_look', for: { people: 'event:person' }, deadline: { afterMinutes: 60 } }, onSuccess: 'approve', onFailure: 'done' },
    approve: { task: { machine: 'approval', by: { people: 'event:person' }, deadline: { afterMinutes: 60 } }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as EventWorkflow;

const source = (onChange = vi.fn()): TaskMachineSource => ({
  of: (key) => (key === 'approval' ? undefined : (DEFAULT_TASK_STATE_MACHINES as Record<string, TaskStateMachine>)[key]),
  onChange,
});

describe('a task step\'s own steps open on the run\'s builder', () => {
  it('opens the machine from the task step, and goes back to the run', () => {
    render(<WorkflowBuilder workflows={{ report }} tools={[]} onChange={vi.fn()} onLayoutChange={vi.fn()} taskMachines={source()} />);
    fireEvent.click(screen.getByTestId('wfb-node-work'));
    fireEvent.click(screen.getByTestId('wfb-open-machine'));
    expect(screen.getByTestId('workflow-builder-machine')).toBeTruthy();
    expect(screen.queryByTestId('workflow-builder')).toBeNull();
    fireEvent.click(screen.getByTestId('wfb-machine-back'));
    expect(screen.getByTestId('workflow-builder')).toBeTruthy();
  });

  it('a platform machine is said, not opened', () => {
    render(<WorkflowBuilder workflows={{ report }} tools={[]} onChange={vi.fn()} onLayoutChange={vi.fn()} taskMachines={source()} />);
    fireEvent.click(screen.getByTestId('wfb-node-approve'));
    expect(screen.queryByTestId('wfb-open-machine')).toBeNull();
    expect(screen.getByTestId('wfb-machine-not-held').textContent).toContain('approval');
  });

  it('without a machine source, a task step opens nothing', () => {
    render(<WorkflowBuilder workflows={{ 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] }} tools={[]} onChange={vi.fn()} onLayoutChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('wfb-node-first-look'));
    expect(screen.queryByTestId('wfb-open-machine')).toBeNull();
    expect(screen.queryByTestId('wfb-machine-not-held')).toBeNull();
  });
});
