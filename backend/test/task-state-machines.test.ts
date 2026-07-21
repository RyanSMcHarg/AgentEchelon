/**
 * Task state machines as declared graphs (SPEC-TASK-STATE-TRANSITIONS §4).
 * Covers the graph validation (loud, named failures), the regression/branch
 * edges the old linear arrays could not express, and the intent-pack
 * machines-carry with a malformed-override fallback.
 */
import {
  DEFAULT_TASK_STATE_MACHINES,
  validateTaskStateMachine,
  validateTaskStateMachines,
  TaskMachineValidationError,
  isLegalTransition,
  legalTransitionsFrom,
  initialStateFor,
  isDeclaredState,
  terminalKindOf,
  type TaskStateMachine,
} from '../lambda/src/lib/task-state-machines.js';
import { getIntentPack, taskStateMachines, _resetIntentPackCache } from '../lambda/src/lib/intent-pack.js';
import { shouldMarkTaskCompleted } from '../lambda/src/lib/task-tracking.js';

describe('shouldMarkTaskCompleted — lifecycle status follows the machine terminal (AT6)', () => {
  it('is FALSE for a machine-backed task in a non-terminal state (no more Completed-vs-extracting)', () => {
    expect(shouldMarkTaskCompleted('data_extraction', 'extracting')).toBe(false);
    expect(shouldMarkTaskCompleted('data_extraction', 'collecting_requirements')).toBe(false);
    expect(shouldMarkTaskCompleted('report_generation', 'generating')).toBe(false);
  });
  it('is TRUE once the machine reaches a terminal state', () => {
    expect(shouldMarkTaskCompleted('data_extraction', 'completed')).toBe(true);
    expect(shouldMarkTaskCompleted('report_generation', 'completed')).toBe(true);
    expect(shouldMarkTaskCompleted('guided_troubleshooting', 'resolved')).toBe(true);
    expect(shouldMarkTaskCompleted('guided_troubleshooting', 'escalated')).toBe(true);
  });
  it('is TRUE for a task with NO state machine (lightweight/single-turn completes as before)', () => {
    expect(shouldMarkTaskCompleted('general', 'anything')).toBe(true);
    expect(shouldMarkTaskCompleted(undefined, undefined)).toBe(true);
  });
});

describe('task state machine graphs', () => {
  it('the DEFAULT machines all validate', () => {
    expect(() => validateTaskStateMachines(DEFAULT_TASK_STATE_MACHINES)).not.toThrow();
  });

  it('expresses the guided_troubleshooting regression + outcome-branch edges', () => {
    // regression: diagnosing can fall back to collecting_symptoms (need more info)
    expect(legalTransitionsFrom('guided_troubleshooting', 'diagnosing')).toEqual(
      expect.arrayContaining(['proposing_solutions', 'collecting_symptoms']),
    );
    // outcome branch from awaiting_result: worked / didn't / give up
    expect(isLegalTransition('guided_troubleshooting', 'awaiting_result', 'resolved')).toBe(true);
    expect(isLegalTransition('guided_troubleshooting', 'awaiting_result', 'diagnosing')).toBe(true);
    expect(isLegalTransition('guided_troubleshooting', 'awaiting_result', 'escalated')).toBe(true);
    // an edge the graph does not declare
    expect(isLegalTransition('guided_troubleshooting', 'collecting_symptoms', 'resolved')).toBe(false);
    // report_generation revising -> generating loop edge
    expect(isLegalTransition('report_generation', 'revising', 'generating')).toBe(true);
  });

  it('reports initial state and terminal disposition', () => {
    expect(initialStateFor('data_extraction')).toBe('collecting_requirements');
    expect(terminalKindOf('guided_troubleshooting', 'resolved')).toBe('success');
    expect(terminalKindOf('guided_troubleshooting', 'escalated')).toBe('handoff');
    expect(terminalKindOf('guided_troubleshooting', 'diagnosing')).toBeUndefined();
    expect(isDeclaredState('report_generation', 'revising')).toBe(true);
    expect(isDeclaredState('report_generation', 'nope')).toBe(false);
    expect(initialStateFor('unknown_type')).toBeUndefined();
  });
});

describe('validateTaskStateMachine rejects malformed graphs', () => {
  const check = (m: TaskStateMachine) => () => validateTaskStateMachine('x', m);

  it('undeclared transition target', () => {
    expect(check({ initial: 'a', states: { a: { transitions: ['ghost'] }, b: { transitions: [], terminal: 'success' } } }))
      .toThrow(/undeclared state "ghost"/);
  });
  it('initial not declared', () => {
    expect(check({ initial: 'z', states: { a: { transitions: [], terminal: 'success' } } }))
      .toThrow(/initial state "z"/);
  });
  it('no terminal state (a cycle with no exit)', () => {
    expect(check({ initial: 'a', states: { a: { transitions: ['b'] }, b: { transitions: ['a'] } } }))
      .toThrow(/no terminal state/);
  });
  it('terminal state missing its disposition', () => {
    expect(check({ initial: 'a', states: { a: { transitions: [] } } }))
      .toThrow(/missing a terminal disposition/);
  });
  it('unreachable orphan state', () => {
    expect(
      check({
        initial: 'a',
        states: {
          a: { transitions: [], terminal: 'success' },
          orphan: { transitions: [], terminal: 'success' },
        },
      }),
    ).toThrow(/unreachable from initial: orphan/);
  });
  it('carries the machine name on the error', () => {
    expect.assertions(2);
    try {
      validateTaskStateMachine('mymachine', { initial: 'z', states: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(TaskMachineValidationError);
      expect((e as Error).message).toContain('mymachine');
    }
  });
});

describe('intent pack carries and validates machines', () => {
  const OLD = process.env.ASSISTANT_INTENT_PACK;
  afterEach(() => {
    if (OLD === undefined) delete process.env.ASSISTANT_INTENT_PACK;
    else process.env.ASSISTANT_INTENT_PACK = OLD;
    _resetIntentPackCache();
  });

  it('defaults to the platform machines when the pack declares none', () => {
    delete process.env.ASSISTANT_INTENT_PACK;
    _resetIntentPackCache();
    expect(taskStateMachines()).toBe(DEFAULT_TASK_STATE_MACHINES);
  });

  it('merges a valid override over the defaults so work-item machines survive', () => {
    process.env.ASSISTANT_INTENT_PACK = JSON.stringify({
      intents: [{ key: 'guided_troubleshooting', description: 'd', keywords: ['x'], delivery: 'TASK_MULTI_STEP' }],
      machines: {
        guided_troubleshooting: {
          initial: 's',
          states: { s: { transitions: ['done'] }, done: { transitions: [], terminal: 'success' } },
        },
      },
    });
    _resetIntentPackCache();
    const m = taskStateMachines();
    expect(m.guided_troubleshooting.initial).toBe('s'); // override applied
    expect(m.action_item).toBeDefined(); // default survives the partial override
  });

  it('falls back to DEFAULT machines when the override is malformed (loud, non-fatal)', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ASSISTANT_INTENT_PACK = JSON.stringify({
      intents: [{ key: 'data_extraction', description: 'd', keywords: ['x'], delivery: 'TASK_MULTI_STEP' }],
      machines: { data_extraction: { initial: 'a', states: { a: { transitions: ['ghost'] } } } },
    });
    _resetIntentPackCache();
    const pack = getIntentPack();
    expect(pack.intents.length).toBe(1); // classification survives a bad machines block
    expect(pack.machines).toBeUndefined(); // the malformed override is dropped
    expect(taskStateMachines(pack)).toBe(DEFAULT_TASK_STATE_MACHINES);
    expect(spy).toHaveBeenCalled(); // logged loudly
    spy.mockRestore();
  });
});
