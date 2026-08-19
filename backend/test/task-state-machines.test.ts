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
  stateNamesOf,
  awaitedPartyOf,
  type TaskStateMachine,
} from '../lambda/src/lib/task-state-machines.js';
import { TASK_STATE_MACHINES } from '../lambda/src/lib/task-tracking.js';
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

describe('stateNamesOf — the derived state-name shape (retires the shadow const)', () => {
  it('projects each machine to its ordered state names', () => {
    const m: Record<string, TaskStateMachine> = {
      t: { initial: 'a', states: { a: { transitions: ['b'] }, b: { transitions: [], terminal: 'success' } } },
    };
    expect(stateNamesOf(m)).toEqual({ t: ['a', 'b'] });
  });

  it('the module-level TASK_STATE_MACHINES is DERIVED from the authoritative graph (no drift)', () => {
    // It equals stateNamesOf(DEFAULT) exactly — the hand-maintained shadow is gone.
    expect(TASK_STATE_MACHINES).toEqual(stateNamesOf(DEFAULT_TASK_STATE_MACHINES));
    // And it follows the authoritative report_generation order (…revising, completed) — the old shadow
    // had completed before revising, so its terminal-last check treated 'revising' as terminal.
    expect(TASK_STATE_MACHINES.report_generation[TASK_STATE_MACHINES.report_generation.length - 1]).toBe('completed');
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

/**
 * WORK DOES NOT BEGIN UNTIL THE PERSON HAS ANSWERED.
 *
 * A PROPERTY over the machines rather than an assertion about one state name, because the bug it
 * catches is a family bug and the family is configurable: a pack or a per-assistant profile may
 * rename every state here (SPEC-CONFIGURABLE-ASSISTANTS 4.5), and a check spelled `drafting_outline`
 * would pass while the machine it was written for no longer exists.
 *
 * The shape it pins: the LAST state before a workflow starts producing its deliverable is the one the
 * assistant is asking about, so it must be blocked on the person. `report_generation.drafting_outline`
 * was not, so the report stayed with the assistant while the person was the one being waited on -
 * which cost the owner-keyed drift suppression its answer and turned a reply to the assistant's own
 * question ("Can you make it 1-2 pages?") into an offer to split the conversation.
 *
 * Deliberately scoped to the edge INTO production from outside it. Delivering states legitimately
 * transition among themselves without asking anyone (extracting -> validating, generating -> revising);
 * it is the boundary that has to have been answered.
 */
describe('a machine does not start producing before the person has answered', () => {
  const boundaryEdges = (machine: TaskStateMachine): Array<{ from: string; to: string; awaits: boolean }> => {
    const edges: Array<{ from: string; to: string; awaits: boolean }> = [];
    for (const [from, def] of Object.entries(machine.states)) {
      if (def.delivers) continue; // delivering -> delivering is production continuing, not starting
      for (const to of def.transitions) {
        // Through the normalizer, so the property holds for a machine authored in either form. Read
        // off `awaitsUser` this check passed vacuously the moment the shipped machines moved to
        // `awaits`, which is the failure this whole change is about.
        if (machine.states[to]?.delivers) edges.push({ from, to, awaits: awaitedPartyOf(def) !== null });
      }
    }
    return edges;
  };

  it('every shipped machine only enters production from a state that awaits the person', () => {
    for (const [name, machine] of Object.entries(DEFAULT_TASK_STATE_MACHINES)) {
      for (const edge of boundaryEdges(machine)) {
        expect({ machine: name, ...edge }).toEqual({ machine: name, from: edge.from, to: edge.to, awaits: true });
      }
    }
  });

  it('the property has something to check (it is not vacuously true)', () => {
    // A `delivers` flag that nobody set, or a machine set with none, would leave the assertion above
    // passing over an empty list forever.
    const edges = Object.values(DEFAULT_TASK_STATE_MACHINES).flatMap(boundaryEdges);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.map((e) => e.from)).toEqual(expect.arrayContaining(['drafting_outline', 'collecting_requirements']));
  });

  it('catches a machine that starts producing on an unanswered step', () => {
    // The exact shape the live defect had: one exit, straight into the work, nobody asked.
    const broken: TaskStateMachine = {
      initial: 'outline',
      states: {
        outline: { transitions: ['writing'] }, // awaits nobody
        writing: { transitions: ['done'], delivers: true },
        done: { transitions: [], terminal: 'success' },
      },
    };
    expect(boundaryEdges(broken)).toEqual([{ from: 'outline', to: 'writing', awaits: false }]);
  });

  it('a step that ends its turn asking the person is held by the person', () => {
    // The two states with no separate waiting state to hold their pause: each exits only into the
    // assistant working, so the wait has nowhere else to live. `validating` carries no `delivers`
    // boundary of its own (it is already a delivering state), so the property above cannot reach it.
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.report_generation.states.drafting_outline))
      .toEqual({ party: 'requester' });
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.data_extraction.states.validating))
      .toEqual({ party: 'requester' });
    // And neither may advance on whatever arrives: "make it 1-2 pages" and "row 3 is wrong" are
    // replies, not approvals, and one exit plus any reply would produce the wrong document.
    expect(DEFAULT_TASK_STATE_MACHINES.report_generation.states.drafting_outline.resolvedByOneResponse)
      .toBeUndefined();
    expect(DEFAULT_TASK_STATE_MACHINES.data_extraction.states.validating.resolvedByOneResponse)
      .toBeUndefined();
  });

  it('leaves the states a machine passes through within a turn alone', () => {
    // The other half, and the one that makes this a judgement rather than a sweep. Each of these
    // produces something and hands on to a state that IS the wait, so marking them would move
    // ownership twice and put a step nobody is blocked on into a person's queue.
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.guided_troubleshooting.states.proposing_solutions))
      .toBeNull();
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.place_item.states.collecting)).toBeNull();
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.action_item.states.gathering)).toBeNull();
    // ...and each of those waits is declared, or the states above would be resting on nothing.
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.guided_troubleshooting.states.awaiting_result))
      .toEqual({ party: 'requester' });
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.place_item.states.confirming))
      .toEqual({ party: 'requester' });
    expect(awaitedPartyOf(DEFAULT_TASK_STATE_MACHINES.action_item.states.options_presented))
      .toEqual({ party: 'requester' });
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
