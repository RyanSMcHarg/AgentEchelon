/**
 * THE BUILDER'S TASK-MACHINE MODE CHANGES A MACHINE ONLY IN WAYS THE RUNTIME RUNS (ADR-066 build step 3, ADR-067 stage 1).
 *
 * What it proves: adding a step after another connects it and leaves the machine valid; removing or renaming a step
 * keeps every transition, card choice, reopen and action edge that named it in step, so no edit leaves a dangling name;
 * a transition back to an earlier step is allowed (a machine may loop); a step left with no transition becomes an ending;
 * the status line is the runtime's own check, and the draft's errors land on the step they name; and the pack is patched
 * with one machine replaced and every other field kept.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../../../../../backend/lambda/src/lib/task-state-machines.ts';
import {
  addState, anchoredMachineErrors, connectStates, disconnectStates, isStateKey, machineErrors, orderedStates, packWithMachine,
  removeState, renameState, startAtState, withField,
} from './machineEdits';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const SMALL: TaskStateMachine = {
  initial: 'gather',
  states: {
    gather: { transitions: ['confirm'], awaits: { party: 'requester' }, requires: ['what to draw'] },
    confirm: { transitions: ['make', 'gather'], awaits: { party: 'requester' }, choices: ['make', 'gather'] },
    make: { transitions: ['done', 'failed'], produces: 'image', action: { tool: 'generate_image' }, onSuccess: 'done', onFailure: 'failed' },
    done: { transitions: [], terminal: 'success', reopens: ['gather'] },
    failed: { transitions: [], terminal: 'failure' },
  },
};

describe('the task-machine edits', () => {
  it('add a step after the selected one, connected, and the machine stays valid', () => {
    const { machine, key } = addState(clone(SMALL), { after: 'done' });
    expect(key).toBe('step');
    expect(machine.states.done.transitions).toEqual(['step']);
    expect(machine.states.done.terminal).toBeUndefined();
    expect(machine.states.done.reopens).toBeUndefined();
    expect(machine.states.step).toEqual({ transitions: [], terminal: 'success' });
    expect(machineErrors('image_generation', machine)).toEqual([]);
  });

  it('remove a step and every reference to it', () => {
    const next = removeState(clone(SMALL), 'gather');
    expect(next.initial).toBe('confirm');
    expect(next.states.confirm.transitions).toEqual(['make']);
    expect(next.states.confirm.choices).toEqual(['make']);
    expect(next.states.done.reopens).toBeUndefined();
    const noFail = removeState(clone(SMALL), 'failed');
    expect(noFail.states.make.onFailure).toBeUndefined();
    expect(noFail.states.make.transitions).toEqual(['done']);
  });

  it('rename a step everywhere it is named, and refuse a taken or malformed name', () => {
    const next = renameState(clone(SMALL), 'gather', 'collect')!;
    expect(next.initial).toBe('collect');
    expect(next.states.confirm.transitions).toEqual(['make', 'collect']);
    expect(next.states.confirm.choices).toEqual(['make', 'collect']);
    expect(next.states.done.reopens).toEqual(['collect']);
    expect(renameState(clone(SMALL), 'gather', 'confirm')).toBeNull();
    expect(renameState(clone(SMALL), 'gather', 'Not A Key')).toBeNull();
    expect(isStateKey('step_2')).toBe(true);
    const actionRenamed = renameState(clone(SMALL), 'done', 'finished')!;
    expect(actionRenamed.states.make.onSuccess).toBe('finished');
  });

  it('connect a step back to an earlier one, which a machine may do', () => {
    const next = connectStates(clone(SMALL), 'make', 'gather');
    expect(next.states.make.transitions).toEqual(['done', 'failed', 'gather']);
    expect(connectStates(next, 'make', 'gather')).toBe(next);
  });

  it('disconnect the last transition and the step becomes an ending', () => {
    const one = disconnectStates(clone(SMALL), 'gather', 'confirm');
    expect(one.states.gather.transitions).toEqual([]);
    expect(one.states.gather.terminal).toBe('success');
    const choice = disconnectStates(clone(SMALL), 'confirm', 'gather');
    expect(choice.states.confirm.choices).toEqual(['make']);
  });

  it('start at another step, and set or clear a field', () => {
    expect(startAtState(clone(SMALL), 'confirm').initial).toBe('confirm');
    expect(startAtState(clone(SMALL), 'nope').initial).toBe('gather');
    const def = SMALL.states.gather;
    expect(withField(def, 'requiresTool', ['load_company_context']).requiresTool).toEqual(['load_company_context']);
    expect('requires' in withField(def, 'requires', [])).toBe(false);
    expect('presented' in withField({ ...def, presented: true }, 'presented', false)).toBe(false);
    expect(orderedStates(SMALL)[0]).toBe('gather');
  });

  it('say what the runtime says of a machine, and anchor the draft\'s errors to the step they name', () => {
    const broken = clone(SMALL);
    broken.states.done.transitions = [];
    delete broken.states.done.terminal;
    expect(machineErrors('image_generation', broken)[0]).toContain('terminal state "done" is missing a terminal disposition');
    const anchored = anchoredMachineErrors([
      ...machineErrors('image_generation', broken),
      "intentPack.machines['image_generation'].states['gather'] names tool(s) this version does not allow: x.",
      "intentPack.machines['report_generation'].states['gather'] names tool(s) this version does not allow: x.",
      "intentPack.machines['image_generation'] is too large",
    ], 'image_generation', broken);
    expect(Object.keys(anchored.states).sort()).toEqual(['done', 'gather']);
    expect(anchored.machine).toEqual(["intentPack.machines['image_generation'] is too large"]);
  });

  it('patch the pack with one machine replaced and everything else kept', () => {
    const pack = { extends: 'default' as const, intents: [{ key: 'image_generation' }], machines: { report_generation: DEFAULT_TASK_STATE_MACHINES.report_generation } };
    const next = packWithMachine(pack, 'image_generation', SMALL);
    expect(next.intents).toEqual(pack.intents);
    expect(next.extends).toBe('default');
    expect(Object.keys(next.machines).sort()).toEqual(['image_generation', 'report_generation']);
  });

  it('a draft with no pack of its own starts from the pack it serves, so editing a machine keeps every intent', () => {
    const classificationPack = { intents: [{ key: 'report_generation', description: 'd', keywords: [], delivery: 'TASK_MULTI_STEP' }] };
    const fromClassification = packWithMachine(undefined, 'report_generation', SMALL, classificationPack);
    expect(fromClassification.intents).toEqual(classificationPack.intents);
    expect(fromClassification.machines).toEqual({ report_generation: SMALL });
    // On the platform's pack: inherited whole, with no intent of its own, which the pack validator accepts.
    expect(packWithMachine(undefined, 'x', SMALL)).toEqual({ extends: 'default', intents: [], machines: { x: SMALL } });
  });

  it('removing the only step after another leaves that one an ending the validator accepts', () => {
    const chain: TaskStateMachine = { initial: 'a', states: { a: { transitions: ['b'] }, b: { transitions: ['done'] }, done: { transitions: [], terminal: 'success' } } };
    const next = removeState(chain, 'done');
    expect(next.states.b).toEqual({ transitions: [], terminal: 'success' });
    expect(machineErrors('chain', next)).toEqual([]);
  });
});

describe('a state\'s requester moves follow its edits (WT114)', () => {
  const dispatch = (): TaskStateMachine => ({
    initial: 'scheduled',
    states: {
      scheduled: { transitions: ['rescheduled', 'done'], awaits: { party: 'worker' }, requesterMoves: ['rescheduled'] },
      rescheduled: { transitions: ['done'], awaits: { party: 'worker' } },
      done: { transitions: [], terminal: 'success' },
    },
  } as unknown as TaskStateMachine);

  it('a renamed state is renamed among the moves the requester may ask for', () => {
    const next = renameState(dispatch(), 'rescheduled', 'moved')!;
    expect(next.states.scheduled.requesterMoves).toEqual(['moved']);
    expect(machineErrors('dispatch', next)).toEqual([]);
  });

  it('a removed or disconnected state leaves them, and none is left empty', () => {
    expect(removeState(dispatch(), 'rescheduled').states.scheduled.requesterMoves).toBeUndefined();
    expect(disconnectStates(dispatch(), 'scheduled', 'rescheduled').states.scheduled.requesterMoves).toBeUndefined();
  });
});
