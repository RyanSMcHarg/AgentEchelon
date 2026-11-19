/**
 * A TASK'S CONDITIONS READ ITS OWN HISTORY AND ITS TYPED VALUES (ADR-067 G6, WT22).
 *
 * What it proves: a machine may bound a loop by how often the task entered a state (`task:entries:<state>`), and decide
 * on a value the model recorded once as data (`task:value:<need>`), of the type the state declares in `records`; a need a
 * state records is one it requires; and the values come from the task, never from the person's words.
 */
import { authorizeTransition, taskConditionValues, validateTaskStateMachine, type TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { collectedRequirements } from '../../lambda/src/lib/task-tools';

/** Three billable redraws at most: from `revise`, back to `generate` while it was entered fewer than three times. */
const REDRAWS: TaskStateMachine = {
  initial: 'gather',
  states: {
    gather: { transitions: ['generate'], awaits: { party: 'requester' }, requires: ['quantity'], records: { quantity: 'number' } },
    generate: { transitions: ['revise', 'done'] },
    revise: { transitions: ['generate', 'refused'], edgeWhen: { generate: { 'task:entries:generate': { op: 'lt', value: 3 } } } },
    done: { transitions: [], terminal: 'success', edgeWhen: undefined } as never,
    refused: { transitions: [], terminal: 'failure' },
  },
} as TaskStateMachine;

describe('a condition on the task itself', () => {
  it('validates entry counts and typed values, and refuses a record the state does not require or a third type', () => {
    expect(() => validateTaskStateMachine('redraws', REDRAWS)).not.toThrow();
    const bad = JSON.parse(JSON.stringify(REDRAWS));
    bad.states.gather.records = { colour: 'number' };
    expect(() => validateTaskStateMachine('redraws', bad)).toThrow(/records "colour", which it does not require/);
    bad.states.gather.records = { quantity: 'text' };
    expect(() => validateTaskStateMachine('redraws', bad)).toThrow(/a typed value is number, boolean or time/);
  });

  it('bounds a loop by how often the task entered a state', () => {
    const task = (entries: number) => ({ stateHistory: Array.from({ length: entries }, () => ({ to: 'generate' })) });
    const machines = { redraws: REDRAWS };
    const at = (n: number) => authorizeTransition('redraws', 'revise', 'generate', machines, { by: 'tool', conditionValues: taskConditionValues(task(n), REDRAWS) });
    expect(at(2).ok).toBe(true);
    expect(at(3)).toMatchObject({ ok: false, error: 'condition_not_met' });
  });

  it('reads a typed value only where the machine records that need as that type', () => {
    expect(taskConditionValues({ details: { typed: { quantity: 4 } } }, REDRAWS)['task:value:quantity']).toBe(4);
    expect(taskConditionValues({ details: { typed: { quantity: 'four' } } }, REDRAWS)['task:value:quantity']).toBeUndefined();
    expect(taskConditionValues({ details: { typed: { other: 1 } } }, REDRAWS)['task:value:other']).toBeUndefined();
  });

  it('the model records the typed value beside the answer, as data', () => {
    const got = collectedRequirements([{ need: 'quantity', value: 'four of them', number: 4, source: 'message', evidence: 'four of them' }]);
    expect(got?.requirements.quantity).toBe('four of them');
    expect(got?.typed).toEqual({ quantity: 4 });
  });
});
