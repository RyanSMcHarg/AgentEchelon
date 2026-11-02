/**
 * A WORK ITEM SAYS WHAT IT IS, AND WHAT FINISHING IT NEEDS (maintainer, 2026-09-03).
 *
 * The open-work panel lists what a person still owes. Every row read the name of its TYPE:
 * "Queued request", "Report generation", repeated. Measured on the deployment: 72 rows of one type
 * and 50 of another, all identical, in a list whose entire job is choosing which one to finish.
 *
 * Two causes, and both were data that already existed and was not used.
 *
 *   1. `titleOf` looked only in `details`, which `createTask` initializes EMPTY and which nothing on
 *      the queued-request or report paths ever writes. So it always fell through to the task type.
 *      Meanwhile `requestExcerpt` held the person's own words - "Q3 headcount lookup", "Identify
 *      three tools the onboarding process touches" - and nothing read it.
 *   2. The state machine declares what a step needs - `report_generation.collecting_requirements`
 *      asks for the subject, the audience and the length or format. That reached the model's prompt
 *      and stopped there, so the one party actually being waited on never saw it.
 *
 *      (`data_extraction` starts at a state of the SAME NAME and asks for entirely different things.
 *      The first version of the assertion below hardcoded that one's list under this one's name and
 *      passed on the wrong data, which is why it now reads both from the machines.)
 *
 * The mirror had to carry the excerpt too: the panel reads the MIRROR, not the task, and a field the
 * mirror does not carry is a field the panel cannot show however well the API is written.
 */
import { titleOf, needsOf } from '../../lambda/src/user-tasks-api';
import type { UserTask } from '../../lambda/src/lib/task-tracking';
import { taskStateMachines } from '../../lambda/src/lib/intent-pack';

const machines = taskStateMachines();

const base: UserTask = {
  principalId: 'u1',
  taskId: 't1',
  taskType: 'queued_request',
  channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
  status: 'pending',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
  ttl: 0,
};

describe('a row is named by the request, not by its type', () => {
  it('uses the PERSON\'S OWN WORDS when details carries no title (THE defect)', () => {
    expect(titleOf({ ...base, requestExcerpt: 'Q3 headcount lookup', details: {} }))
      .toBe('Q3 headcount lookup');
  });

  it('an assistant-recorded title still wins, because it describes THIS work', () => {
    expect(titleOf({
      ...base,
      details: { title: 'Draft the onboarding report' },
      requestExcerpt: 'Explain in depth how employee onboarding works',
    })).toBe('Draft the onboarding report');
  });

  it('falls back to the type ONLY when there is nothing better, and never returns empty', () => {
    expect(titleOf({ ...base, details: {} })).toBe('Queued request');
    expect(titleOf({ ...base, taskType: '', details: {} })).toBe('General');
  });

  it('a blank excerpt is not a title', () => {
    // Whitespace is not the person's words. Returning it would produce a row with no visible name,
    // which is worse than the type it replaced.
    expect(titleOf({ ...base, requestExcerpt: '   ', details: {} })).toBe('Queued request');
  });

  it('is bounded, like every other title source here', () => {
    const long = 'x'.repeat(500);
    expect(titleOf({ ...base, requestExcerpt: long, details: {} }).length).toBe(200);
  });
});

describe('a row says what the step needs, when the step declares it', () => {
  it('surfaces the declared requirements of the state the task is IN', () => {
    // Read from the machines themselves rather than restated here: two task types both start at
    // `collecting_requirements` and ask for DIFFERENT things, and a hardcoded copy would pass while
    // showing a person the other workflow's questions. That mistake is what this assertion first did.
    expect(needsOf({ ...base, taskType: 'report_generation', taskState: 'collecting_requirements' }))
      .toEqual(machines.report_generation?.states?.collecting_requirements?.requires);
    expect(needsOf({ ...base, taskType: 'data_extraction', taskState: 'collecting_requirements' }))
      .toEqual(machines.data_extraction?.states?.collecting_requirements?.requires);
  });

  it('the two are genuinely different, so the assertion above is not vacuous', () => {
    expect(needsOf({ ...base, taskType: 'report_generation', taskState: 'collecting_requirements' }))
      .not.toEqual(needsOf({ ...base, taskType: 'data_extraction', taskState: 'collecting_requirements' }));
  });

  it('says nothing for a step that awaits NOBODY', () => {
    // A requirements list for work the assistant owes is not a request, and rendering it as one asks
    // a person for something nobody is waiting on them for.
    expect(needsOf({ ...base, taskType: 'report_generation', taskState: 'extracting' })).toBeUndefined();
  });

  it('says nothing when the state declares no requirements', () => {
    // A confirmation or a single choice: the step IS the answer, so there is nothing to list.
    expect(needsOf({ ...base, taskType: 'queued_request', taskState: 'proposed' })).toBeUndefined();
  });

  it('says nothing for an unknown type or a missing state, rather than guessing', () => {
    expect(needsOf({ ...base, taskType: 'not_a_real_type', taskState: 'proposed' })).toBeUndefined();
    expect(needsOf({ ...base, taskType: 'report_generation' })).toBeUndefined();
  });
});

/**
 * THE MIRROR CARRIES IT, which is the hop that would otherwise make all of the above inert.
 *
 * `getActiveTasksForUser` reads the USER-TASKS MIRROR, not the task table. A `requestExcerpt` written
 * only to the task is a title the panel can never show.
 */
describe('the mirror carries the excerpt', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/lib/task-tracking.ts'),
    'utf8',
  );

  it('the mirror TYPE declares it', () => {
    expect(src).toMatch(/requestExcerpt\?: string;/);
  });

  it('the mirror WRITE populates it, so the field is not declared and left empty', () => {
    expect(src).toContain('...(task.requestExcerpt ? { requestExcerpt: task.requestExcerpt } : {})');
  });
});
