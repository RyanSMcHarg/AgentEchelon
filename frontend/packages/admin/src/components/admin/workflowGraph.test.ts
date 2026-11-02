/**
 * A WORKFLOW AS THE CANVAS DRAWS IT, AND THE ONE SET OF EDITS BOTH VIEWS MAKE (ADR-061 decision 7).
 *
 * What it proves: every edge is drawn, a conditioned edge's alternatives each their own; a step with no saved point is
 * placed in rows by its distance from the first step, an unreached one below, and a saved point wins; the server's
 * errors land on the step they name; and the edits keep a workflow valid: insert after a step puts the new step on its
 * path, connect replaces a plain edge and the otherwise branch of a conditioned one, rename and remove carry every edge,
 * the deadline edge included.
 */
import { describe, it, expect } from 'vitest';
import { PLATFORM_EVENT_WORKFLOWS, versionEventWorkflowsErrors, type EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { GAP_Y, MARGIN, NODE_H, TRIGGER_H, anchoredErrors, autoLayout, edgesOf, positionsOf, triggerAt } from './workflowGraph';
import { addStep, connect, disconnect, removeStep, renameStep, startAt } from './workflowEdits';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const OPS: EventWorkflow = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
const TASK: EventWorkflow = {
  on: 'assistant-joined', initial: 'ask',
  states: {
    ask: { task: { machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 5 } }, onSuccess: 'thanks', onFailure: 'done', onDeadline: 'chase' },
    thanks: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
    chase: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

describe('the graph', () => {
  it('draws every edge, and a conditioned edge as one line per alternative', () => {
    const wf = clone(OPS);
    wf.states.opening.onSuccess = [{ to: 'first-look', when: { 'conversation:type': 'ops' } }, { to: 'greet-lead' }];
    const edges = edgesOf(wf).filter((e) => e.from === 'opening');
    expect(edges).toEqual([
      { from: 'opening', to: 'first-look', edge: 'onSuccess', alternative: 'when' },
      { from: 'opening', to: 'greet-lead', edge: 'onSuccess', alternative: 'otherwise' },
      { from: 'opening', to: 'greet-lead', edge: 'onFailure' },
    ]);
    expect(edgesOf(TASK).filter((e) => e.edge === 'onDeadline')).toEqual([{ from: 'ask', to: 'chase', edge: 'onDeadline' }]);
  });

  it('places steps in rows by their distance from the first, an unreached step below, and a saved point wins (B7)', () => {
    const wf = clone(TASK);
    wf.states.orphan = { disposition: 'failure' };
    const at = autoLayout(wf);
    const row = (k: string) => (at[k].y - (MARGIN + TRIGGER_H + GAP_Y / 2)) / (NODE_H + GAP_Y);
    expect([row('ask'), row('thanks'), row('done'), row('chase'), row('orphan')]).toEqual([0, 1, 1, 1, 2]);
    expect(new Set([at.thanks.x, at.done.x, at.chase.x]).size).toBe(3);
    const placed = positionsOf(wf, { thanks: { x: 500, y: 40 } });
    expect(placed.thanks).toEqual({ x: 500, y: 40 });
    expect(placed.ask).toEqual(at.ask);
    expect(triggerAt(wf, placed).y).toBeLessThan(placed.ask.y);
  });

  it('anchors the server\'s errors to the step they name, and leaves another workflow\'s alone (B2)', () => {
    const wf = clone(OPS);
    wf.states['first-look'].agent!.deadlineMs = 600_000;
    wf.initial = 'nowhere';
    const errors = [...versionEventWorkflowsErrors({ ops: wf }), 'eventWorkflows.other.states.x: not ours', 'eventWorkflows.ops-two.initial names a declared step'];
    const { steps, workflow } = anchoredErrors(errors, 'ops', wf);
    expect(Object.keys(steps)).toEqual(['first-look']);
    expect(steps['first-look'][0]).toMatch(/deadlineMs/);
    expect(workflow).toEqual(['eventWorkflows.ops.initial names a declared step']);
  });
});

describe('the edits', () => {
  it('a step added after another sits on its path, and the workflow stays valid (B3)', () => {
    const { workflow, key } = addStep(OPS, 'send', ['workflow-opening'], [], { after: 'opening' });
    expect(workflow.states.opening.onSuccess).toBe(key);
    expect(workflow.states[key].onSuccess).toBe('greet-lead');
    expect(versionEventWorkflowsErrors({ ops: workflow })).toEqual([]);
    const appended = addStep(OPS, 'end', [], []);
    expect(appended.workflow.states[appended.key]).toEqual({ disposition: 'success' });
  });

  it('connect replaces a plain edge, and the otherwise branch of a conditioned one; an end and a self-loop are refused', () => {
    expect(connect(OPS, 'opening', 'onFailure', 'done').states.opening.onFailure).toBe('done');
    const wf = clone(OPS);
    wf.states.opening.onSuccess = [{ to: 'first-look', when: { 'conversation:type': 'ops' } }, { to: 'greet-lead' }];
    expect(connect(wf, 'opening', 'onSuccess', 'done').states.opening.onSuccess).toEqual([{ to: 'first-look', when: { 'conversation:type': 'ops' } }, { to: 'done' }]);
    expect(connect(OPS, 'done', 'onSuccess', 'opening')).toBe(OPS);
    expect(connect(OPS, 'opening', 'onSuccess', 'opening')).toBe(OPS);
    expect(connect(OPS, 'opening', 'onDeadline', 'done')).toBe(OPS);
    expect(connect(TASK, 'ask', 'onDeadline', 'thanks').states.ask.onDeadline).toBe('thanks');
    expect(disconnect(TASK, 'ask', 'onDeadline').states.ask).not.toHaveProperty('onDeadline');
  });

  it('rename and remove carry every edge, the deadline edge included; removing the first step starts at the next', () => {
    const renamed = renameStep(TASK, 'chase', 'remind')!;
    expect(renamed.states.ask.onDeadline).toBe('remind');
    expect(renameStep(TASK, 'chase', 'thanks')).toBeNull();
    expect(renameStep(TASK, 'chase', 'Bad Name')).toBeNull();
    const removed = removeStep(TASK, 'chase');
    expect(removed.states.ask).not.toHaveProperty('onDeadline');
    expect(removeStep(TASK, 'ask').initial).toBe('thanks');
    expect(startAt(TASK, 'thanks').initial).toBe('thanks');
  });
});
