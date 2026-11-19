/**
 * THE BUILDER'S TASK-MACHINE MODE DRAWS AND EDITS AN INTENT'S STEPS (ADR-067 stage 1).
 *
 * What it proves: every step and transition of the machine is drawn, a loop back to an earlier step included; adding a
 * step after the selected one connects it; Connect then another step adds a transition, and Remove takes it away; a
 * step that waits on a person offers the choices on its card, an ending offers how it ends and what it may reopen, and
 * a step offers and requires the version's tools; and the status line is the runtime's check.
 */
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import { TaskMachineBuilder } from './WorkflowBuilder';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
let latest: TaskStateMachine | null = null;

function Harness({ initial, emailConfigured }: { initial: TaskStateMachine; emailConfigured?: boolean }) {
  const [m, setM] = useState(initial);
  return <TaskMachineBuilder name="image_generation" machine={m} tools={[]} versionTools={['load_company_context', 'search_context']}
    emailConfigured={emailConfigured} participantRoles={['on-call:ops', 'reviewer']} templates={[{ name: 'step-update', kind: 'message', source: '', origin: 'shipped' }]}
    onChange={(next) => { latest = next; setM(next); }} />;
}
const IMAGE = clone(DEFAULT_TASK_STATE_MACHINES.image_generation);

describe('a-task-machine-is-edited-on-the-builder', () => {
  it('draws every step and transition, a loop back included, and says the machine passes the runtime check', () => {
    render(<Harness initial={clone(IMAGE)} />);
    for (const key of Object.keys(IMAGE.states)) expect(screen.getByTestId(`mb-node-${key}`)).toBeTruthy();
    for (const [from, def] of Object.entries(IMAGE.states)) {
      for (const to of def.transitions) expect(screen.getByTestId(`mb-edge-${from}-${to}`)).toBeTruthy();
    }
    expect(screen.getByTestId('mb-status').className).toContain('ok');
  });

  it('an update reaches the room from a listed template, and is emailed where email is configured', () => {
    latest = null;
    render(<Harness initial={clone(IMAGE)} emailConfigured />);
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    fireEvent.change(screen.getByTestId('mb-notice-to'), { target: { value: 'room' } });
    fireEvent.change(screen.getByTestId('mb-notice-template'), { target: { value: 'step-update' } });
    fireEvent.click(screen.getByTestId('mb-notice-email'));
    expect(latest!.states.gather.notice).toEqual({ to: 'room', template: 'step-update', email: true });
  });

  it('an update to a role picks a declared role and stays valid until its template is chosen', () => {
    latest = null;
    render(<Harness initial={clone(IMAGE)} />);
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    fireEvent.change(screen.getByTestId('mb-notice-to'), { target: { value: 'role' } });
    expect((screen.getByTestId('mb-notice-role') as HTMLSelectElement).value).toBe('on-call:ops');
    expect(screen.getByTestId('mb-status').className).toContain('ok');
    expect(latest).toBeNull();
    fireEvent.change(screen.getByTestId('mb-notice-role'), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByTestId('mb-notice-template'), { target: { value: 'step-update' } });
    expect(latest!.states.gather.notice).toEqual({ to: { participantRole: 'reviewer' }, template: 'step-update' });
  });

  it('offers no email where the deployment has none', () => {
    render(<Harness initial={clone(IMAGE)} />);
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    fireEvent.change(screen.getByTestId('mb-notice-to'), { target: { value: 'room' } });
    expect(screen.queryByTestId('mb-notice-email')).toBeNull();
  });

  it('adds a step after the selected one, connects a transition and removes it', () => {
    latest = null;
    render(<Harness initial={clone(IMAGE)} />);
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    fireEvent.click(screen.getByTestId('mb-add-after-gather'));
    expect(latest!.states.gather.transitions).toContain('step');
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    fireEvent.click(screen.getByTestId('mb-port-gather'));
    fireEvent.click(screen.getByTestId('mb-node-failed'));
    expect(latest!.states.gather.transitions).toContain('failed');
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    fireEvent.click(screen.getByTestId('mb-disconnect-failed'));
    expect(latest!.states.gather.transitions).not.toContain('failed');
  });

  it('offers the choices on a waiting step\'s card, and how an ending ends and what it reopens', () => {
    latest = null;
    render(<Harness initial={clone(IMAGE)} />);
    fireEvent.click(screen.getByTestId('mb-node-confirm'));
    const firstChoice = IMAGE.states.confirm.transitions[0];
    fireEvent.click(screen.getByTestId(`mb-choice-${firstChoice}`));
    expect(latest!.states.confirm.choices).toContain(firstChoice);
    fireEvent.click(screen.getByTestId('mb-node-failed'));
    fireEvent.change(screen.getByTestId('mb-terminal'), { target: { value: 'handoff' } });
    expect(latest!.states.failed.terminal).toBe('handoff');
    fireEvent.click(screen.getByTestId('mb-reopen-gather'));
    expect(latest!.states.failed.reopens).toEqual(['gather']);
  });

  it('offers and requires only the version\'s tools on a step', () => {
    latest = null;
    render(<Harness initial={clone(IMAGE)} />);
    fireEvent.click(screen.getByTestId('mb-node-gather'));
    expect(screen.queryByTestId('mb-tool-generate_image')).toBeNull();
    fireEvent.click(screen.getByTestId('mb-requires-tool-load_company_context'));
    expect(latest!.states.gather.requiresTool).toEqual(['load_company_context']);
    fireEvent.click(screen.getByTestId('mb-tool-search_context'));
    expect(latest!.states.gather.tools).toEqual(['search_context']);
  });

  it('says when the runtime refuses the machine, on the step it names', () => {
    const broken = clone(IMAGE);
    broken.states.done = { transitions: [] };
    render(<Harness initial={broken} />);
    expect(screen.getByTestId('mb-status').className).toContain('bad');
    expect(screen.getByTestId('mb-node-done-problems')).toBeTruthy();
  });

  it('shows an ending with no disposition as unset, so choosing done is a change that fixes it', () => {
    latest = null;
    const broken = clone(IMAGE);
    const { terminal: _t, ...noDisposition } = broken.states.done;
    broken.states.done = noDisposition;
    render(<Harness initial={broken} />);
    fireEvent.click(screen.getByTestId('mb-node-done'));
    expect((screen.getByTestId('mb-terminal') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByTestId('mb-terminal'), { target: { value: 'success' } });
    expect(latest!.states.done.terminal).toBe('success');
    expect(screen.getByTestId('mb-status').className).toContain('ok');
  });

  it('a step set to wait on nobody drops what it asked of a person, so the runtime check still passes', () => {
    latest = null;
    const m = clone(IMAGE);
    m.states.confirm = { ...m.states.confirm, requires: ['subject'], presented: true, confirm: 'always', brief: ['subject'] };
    render(<Harness initial={m} />);
    fireEvent.click(screen.getByTestId('mb-node-confirm'));
    fireEvent.change(screen.getByTestId('mb-awaits'), { target: { value: '' } });
    const def = latest!.states.confirm;
    for (const f of ['awaits', 'awaitsUser', 'choices', 'requires', 'presented', 'confirm', 'brief'] as const) expect(def[f]).toBeUndefined();
  });
});

describe('where a task step sits', () => {
  it('draws a step at its saved point, and an arrow key hands every step\'s point on, the moved one nudged', () => {
    const moves: Array<Record<string, { x: number; y: number }>> = [];
    render(<TaskMachineBuilder name="image_generation" machine={clone(IMAGE)} tools={[]} onChange={() => undefined}
      layout={{ gather: { x: 400, y: 320 } }} onLayoutChange={(p) => moves.push(p)} />);
    const wrap = screen.getByTestId('mb-node-gather').parentElement as HTMLElement;
    expect(wrap.style.left).toBe('400px');
    fireEvent.keyDown(screen.getByTestId('mb-node-gather'), { key: 'ArrowRight' });
    expect(moves).toHaveLength(1);
    expect(moves[0].gather.x).toBeGreaterThan(400);
    expect(Object.keys(moves[0]).sort()).toEqual(Object.keys(IMAGE.states).sort());
  });

  it('moves nothing when the page gives it nowhere to save', () => {
    render(<TaskMachineBuilder name="image_generation" machine={clone(IMAGE)} tools={[]} onChange={() => undefined} />);
    fireEvent.keyDown(screen.getByTestId('mb-node-gather'), { key: 'ArrowRight' });
    expect(screen.getByTestId('mb-announce').textContent).toBe('');
  });
});
