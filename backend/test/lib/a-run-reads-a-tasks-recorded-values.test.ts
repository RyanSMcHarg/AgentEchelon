/**
 * A RUN READS THE VALUES ITS TASK RECORDED (ADR-067 G4, G5, G6; WT20, WT21, WT22).
 *
 * What it proves: a machine may record a need as a time, beside a number and a yes-or-no, and a time is never a
 * condition's source; a settled task hands its run each value it recorded, as text in the run's values; the task step's
 * edges compare a number or a yes-or-no it recorded; a wait may wait until a recorded time and a later task step's deadline
 * fall at one, each refused where no task of the run records that time (DENY), and a deadline at a time is never a
 * reminder's; and the router merges the values at settlement and schedules from them.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { continueAfter, eventWorkflowErrors, type EventRunContext, type EventRunDeps, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import {
  recordedRunValues, withRecordedRunValues, taskSourceLookup, typedRunValue, validateTaskStateMachine, DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';

const QUOTE: TaskStateMachine = {
  initial: 'asking',
  states: {
    asking: {
      transitions: ['agreed'], awaits: { party: 'requester' },
      requires: ['the budget', 'the visit time', 'fragile'],
      records: { 'the budget': 'number', 'the visit time': 'time', fragile: 'boolean' },
    },
    agreed: { transitions: [], terminal: 'success' },
  },
} as unknown as TaskStateMachine;
const MACHINES = { ...DEFAULT_TASK_STATE_MACHINES, quote: QUOTE };

const run = (over: Record<string, unknown> = {}): EventWorkflow => ({
  on: 'person-joined',
  initial: 'hello',
  states: {
    hello: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'ask', onFailure: 'ask' },
    ask: {
      task: { machine: 'quote', for: 'joined', deadline: { afterMinutes: 60 } },
      onSuccess: [{ to: 'big', when: { 'task:value:the budget': { op: 'gt', value: 999 } } }, { to: 'small' }],
      onFailure: 'done',
    },
    big: { wait: { until: 'task:value:the visit time' }, onSuccess: 'confirm', onFailure: 'done' },
    small: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
    confirm: { task: { machine: 'acknowledgement', by: 'joined', deadline: { at: 'task:value:the visit time' } }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
    ...over,
  },
} as unknown as EventWorkflow);

describe('a time a task records', () => {
  it('is a recorded type beside a number and a yes-or-no, and never a condition\'s source', () => {
    expect(() => validateTaskStateMachine('quote', QUOTE)).not.toThrow();
    const lookup = taskSourceLookup(QUOTE, () => undefined);
    expect(lookup('task:value:the budget')).toMatchObject({ type: 'number' });
    expect(lookup('task:value:the visit time')).toBeUndefined();
  });

  it('is handed to the run as text, with each number and yes-or-no, and nothing it does not declare', () => {
    const values = recordedRunValues({ details: { typed: { 'the budget': 2500, 'the visit time': '2026-11-09T15:00:00-05:00', fragile: true, other: 1 } } }, QUOTE);
    expect(values).toEqual({
      'task:value:the budget': '2500', 'task:value:the visit time': '2026-11-09T20:00:00.000Z', 'task:value:fragile': 'true',
    });
    expect(typedRunValue('2500', 'number')).toBe(2500);
    expect(typedRunValue('true', 'boolean')).toBe(true);
    expect(typedRunValue('x', 'number')).toBeUndefined();
  });

  it('replaces what the run held for each need its machine records, so an earlier task\'s value never stands in for this one', () => {
    const held = { 'task:value:the budget': '500', 'task:value:other': 'kept', subject: 's' };
    expect(withRecordedRunValues(held, { details: { typed: { fragile: false } } }, QUOTE))
      .toEqual({ 'task:value:other': 'kept', subject: 's', 'task:value:fragile': 'false' });
    expect(withRecordedRunValues(held, { details: { typed: { 'the budget': 900 } } }, QUOTE)['task:value:the budget']).toBe('900');
  });
});

describe('the run reads them', () => {
  it('validates a step edge on a recorded number, a wait until a recorded time and a deadline at one', () => {
    expect(eventWorkflowErrors('quote-run', run(), { machines: MACHINES })).toEqual([]);
  });

  it.each([
    ['a wait until a time no task records', { big: { wait: { until: 'task:value:nope' }, onSuccess: 'done', onFailure: 'done' } }, /wait\.until names a time a task of this run records/],
    ['a deadline at a time no task records', { confirm: { task: { machine: 'acknowledgement', by: 'joined', deadline: { at: 'task:value:nope' } }, onSuccess: 'done', onFailure: 'done' } }, /deadline\.at names a time an earlier task of this run records/],
    ['a reminder at a time', { confirm: { task: { machine: 'acknowledgement', by: 'joined', deadline: { at: 'task:value:the visit time', kind: 'remind' } }, onSuccess: 'done', onFailure: 'done' } }, /deadline\.at is not on a remind deadline/],
    ['a wait with both a time and minutes', { big: { wait: { until: 'task:value:the visit time', minutes: 5 }, onSuccess: 'done', onFailure: 'done' } }, /wait is \{ until \}/],
  ])('DENY: %s', (_label, over, message) => {
    expect(eventWorkflowErrors('quote-run', run(over), { machines: MACHINES }).join('\n')).toMatch(message);
  });

  it('a task step\'s edge compares the number its task recorded', async () => {
    const taken: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true,
      send: async ({ step }) => { taken.push(step); return true; },
      wait: async (step) => { taken.push(step); return 'waiting'; },
    };
    const ctx = (budget: string): EventRunContext => ({
      event: 'person-joined', channelArn: 'arn:c', eventPerson: 'arn:x/user/p', values: { 'task:value:the budget': budget },
      gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
    });
    await continueAfter('quote-run', run(), ctx('2500'), { step: 'ask', outcome: 'task:success:agreed' }, d, MACHINES);
    expect(taken).toEqual(['big']);
    taken.length = 0;
    await continueAfter('quote-run', run(), ctx('300'), { step: 'ask', outcome: 'task:success:agreed' }, d, MACHINES);
    expect(taken).toEqual(['small']);
  });

  it('the router merges the values at settlement, and schedules a wait and a deadline from them', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    // The task's own run takes what it recorded; the run that asked for the work is handed only its own values (WT118).
    expect(router).toMatch(/own && ownOutcome && !own\.holdsEnd \? continueRunOn\(own, ownOutcome, withRecordedRunValues\(own\.values, task, settledMachine\)/);
    expect(router).toMatch(/asker && askerOutcome \? continueRunOn\(asker, askerOutcome, \{ \.\.\.\(asker\.values \?\? \{\}\) \}/);
    expect(router).toMatch(/const fireAt = def\.until !== undefined \? Date\.parse\(ctx\.values\[def\.until\] \?\? ''\)/);
    expect(router).toMatch(/const recordedAt = def\.deadline\.at !== undefined \? Date\.parse\(values\[def\.deadline\.at\] \?\? ''\)/);
    expect(router).toMatch(/const deadline = taskStepDeadline\(def, ctx\.values\);/);
  });
});
