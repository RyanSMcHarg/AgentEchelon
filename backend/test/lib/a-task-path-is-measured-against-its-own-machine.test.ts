/**
 * A task's path is measured against the machine it ran under (SPEC-EVALUATION Appendix C2): the outcome
 * and the route are read from the recorded log, and a valid detour is a longer path, never a mismatch.
 */
import { trajectoryOf, shortestPathToSuccess } from '../../lambda/src/lib/task-trajectory';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import type { StateTransition } from '../../lambda/src/lib/task-tracking';

const report: TaskStateMachine = {
  initial: 'collecting',
  states: {
    collecting: { transitions: ['drafting', 'cancelled'] },
    drafting: { transitions: ['review', 'collecting'] },
    review: { transitions: ['drafting', 'delivered', 'escalated'] },
    delivered: { transitions: [], terminal: 'success' },
    cancelled: { transitions: [], terminal: 'failure' },
    escalated: { transitions: [], terminal: 'handoff' },
  },
};

const edge = (from: string, to: string, by: 'tool' | 'system' = 'tool', extra: Partial<StateTransition> = {}): StateTransition =>
  ({ from, to, by, at: '2026-10-26T00:00:00Z', ...extra });

const of = (history: StateTransition[], taskState: string, turnsInState = 0, machines = { report }) =>
  trajectoryOf({ taskType: 'report', taskState, stateHistory: history, turnsInState, machines });

describe('a task path is measured against its own machine', () => {
  it('the direct path to success is as long as the shortest one', () => {
    const t = of([edge('collecting', 'drafting'), edge('drafting', 'review'), edge('review', 'delivered')], 'delivered');
    expect(t).toMatchObject({ edges: 3, shortestEdges: 3, regressions: 0, platformMoves: 0, terminal: 'success' });
  });

  it('a valid detour is a longer path that still reaches success, and the step back is a regression', () => {
    const t = of([
      edge('collecting', 'drafting'), edge('drafting', 'review'), edge('review', 'drafting'),
      edge('drafting', 'review'), edge('review', 'delivered'),
    ], 'delivered');
    expect(t).toMatchObject({ edges: 5, shortestEdges: 3, terminal: 'success' });
    expect(t!.regressions).toBe(2);
  });

  it('a task sitting in one state carries its turns in state, and has no terminal', () => {
    const t = of([edge('collecting', 'drafting')], 'drafting', 7);
    expect(t!.terminal).toBeUndefined();
    expect(t!.turnsInState).toBe(7);
  });

  it('counts the platform\'s moves apart from the model\'s, and ignores ownership and ending entries', () => {
    const t = of([
      { at: 'x', by: 'system', ownerFrom: 'user:a', ownerTo: 'user:b' },
      edge('collecting', 'drafting'),
      edge('drafting', 'review', 'system', { action: { tool: 'render', outcome: 'success' } }),
      edge('review', 'escalated', 'system'),
      { at: 'y', by: 'system', terminal: 'handoff' },
    ], 'escalated');
    expect(t).toMatchObject({ edges: 3, platformMoves: 2, terminal: 'handoff' });
  });

  it('ignores the open edge, whose empty from means nothing preceded the initial state', () => {
    const t = of([edge('', 'collecting'), edge('collecting', 'cancelled')], 'cancelled');
    expect(t).toMatchObject({ edges: 1, terminal: 'failure', regressions: 0 });
  });

  it('takes the shortest path from the task\'s own machine, including a pack-declared one', () => {
    const quick: TaskStateMachine = {
      initial: 'collecting',
      states: { collecting: { transitions: ['delivered'] }, delivered: { transitions: [], terminal: 'success' } },
    };
    const t = trajectoryOf({
      taskType: 'report', taskState: 'delivered', stateHistory: [edge('collecting', 'delivered')],
      turnsInState: 0, machines: { report: quick },
    });
    expect(t!.shortestEdges).toBe(1);
    expect(shortestPathToSuccess(report)).toBe(3);
  });

  it('follows a step action\'s outcome edges as declared edges', () => {
    const acting: TaskStateMachine = {
      initial: 'running',
      states: {
        running: { transitions: [], action: { tool: 'lookup' }, onSuccess: 'done', onFailure: 'failed' },
        done: { transitions: [], terminal: 'success' },
        failed: { transitions: [], terminal: 'failure' },
      },
    };
    expect(shortestPathToSuccess(acting)).toBe(1);
  });

  it('has no shortest path when no success terminal is reachable, and no trajectory without a machine', () => {
    const dead: TaskStateMachine = { initial: 'a', states: { a: { transitions: ['b'] }, b: { transitions: [], terminal: 'failure' } } };
    expect(shortestPathToSuccess(dead)).toBeUndefined();
    expect(trajectoryOf({ taskType: 'lightweight', taskState: undefined, stateHistory: [], turnsInState: 0, machines: { report } })).toBeUndefined();
  });

  it('the processor stamps it from the persisted row and the turn\'s own machines, never the in-memory task', () => {
    // The in-memory task learns a platform move's edge and not a model's, so a trajectory built from it
    // would count one kind twice and the other not at all.
    const core = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8') as string;
    const block = core.slice(core.indexOf('let taskTrajectory'), core.indexOf('const taskAnalytics'));
    expect(block).toMatch(/await getTask\(event\.taskId, event\.channelArn\)/);
    expect(block).toMatch(/stateHistory: persisted\.stateHistory/);
    expect(block).toMatch(/machines: taskStateMachines\(\)/);
    expect(core).toMatch(/\.\.\.\(taskTrajectory && \{ taskTrajectory \}\)/);
  });

  it('marks a task reopened from a terminal state', () => {
    const t = of([
      edge('collecting', 'drafting'), edge('drafting', 'review'), edge('review', 'delivered'),
      edge('delivered', 'drafting', 'tool', { reopen: true }),
    ], 'drafting');
    expect(t!.reopened).toBe(true);
    expect(t!.terminal).toBeUndefined();
  });
});
