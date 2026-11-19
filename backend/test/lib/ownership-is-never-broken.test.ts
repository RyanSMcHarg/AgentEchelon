/**
 * OWNERSHIP IS NEVER BROKEN (DESIGN-WORKFLOWS-AND-TASKS section 1, SPEC-WORKFLOWS-AND-TASKS WT118).
 *
 * What it proves, for the parts built: a task given to another assistant's role hands the asking run its ending only.
 * Its edges may read how it ended and nothing it recorded, and a wait or deadline may not read a time it recorded (DENY);
 * a task of the run's own assistant still hands back what it recorded; and the router merges recorded values only from a
 * task the run's own assistant worked.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { eventWorkflowErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

const QUOTE = {
  initial: 'asking',
  states: {
    asking: { transitions: ['agreed'], requires: ['the cost', 'the visit time'], records: { 'the cost': 'number', 'the visit time': 'time' } },
    agreed: { transitions: [], terminal: 'success' },
  },
} as unknown as TaskStateMachine;
const MACHINES = { ...DEFAULT_TASK_STATE_MACHINES, quote: QUOTE };

const run = (by: Record<string, unknown>): EventWorkflow => ({
  on: 'conversation-opened', types: ['ops'], initial: 'hello',
  states: {
    hello: { send: { to: 'room', template: 'ops-room-opening' }, onSuccess: 'ask', onFailure: 'ask' },
    ask: {
      task: { machine: 'quote', by, deadline: { afterMinutes: 60 } },
      onSuccess: [{ to: 'big', when: { 'task:value:the cost': { op: 'gt', value: 1000 } } }, { to: 'done' }],
      onFailure: 'done',
    },
    big: { wait: { until: 'task:value:the visit time' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as unknown as EventWorkflow);

describe('a task given to another assistant hands back its ending only', () => {
  it('DENY: its edges read nothing it recorded, and nothing waits on a time it recorded', () => {
    const errs = eventWorkflowErrors('ops-room', run({ assistantRole: 'ops' }), { machines: MACHINES }).join('\n');
    expect(errs).toMatch(/task:value:the cost/);
    expect(errs).toMatch(/wait\.until names a time a task of this run records/);
  });

  it('a task of the run\'s own assistant hands back what it recorded', () => {
    const errs = eventWorkflowErrors('ops-room', run({ participantRole: 'lead' }), { machines: MACHINES });
    expect(errs.filter((e) => /task:value|wait\.until/.test(e))).toEqual([]);
  });

  it('the router merges recorded values only into the task\'s own run, never the run that asked for the work', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    // The task's own run takes what it recorded; the run that asked for the work is handed only its own values (WT118).
    expect(router).toMatch(/own && ownOutcome && !own\.holdsEnd \? continueRunOn\(own, ownOutcome, withRecordedRunValues\(own\.values, task, settledMachine\)/);
    expect(router).toMatch(/asker && askerOutcome \? continueRunOn\(asker, askerOutcome, \{ \.\.\.\(asker\.values \?\? \{\}\) \}/);
  });
});
