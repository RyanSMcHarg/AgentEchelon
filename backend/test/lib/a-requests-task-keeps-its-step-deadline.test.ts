/**
 * A REQUEST'S TASK KEEPS ITS STEP'S DEADLINE, AND IS AS PRIVATE AS ITS MESSAGE (ADR-067 G9, G15; WT21, WT26, WT106, WT118).
 *
 * What it proves: every task step's deadline is read once (`taskStepDeadline`), the request's own included, so a timeout
 * keeps its row a day past the deadline, a due time and a reminder keep it 45 days, and a time the run does not hold fails
 * the step; the request's own step declares a time from now and never a recorded time or a reminder (DENY); the request's
 * task opens once and a failed open takes the step's failure edge; a request whose task already exists takes the due time
 * and the row's lifetime too; a task handed to a role is known by the step's declaration; and a request opened mid-task is
 * private unless its stored message was sent to the room.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

jest.mock('../../lambda/src/lib/private-command', () => ({
  ...jest.requireActual('../../lambda/src/lib/private-command'),
  inboundTarget: jest.fn(),
}));

import { inboundTarget } from '../../lambda/src/lib/private-command';
import { taskStepDeadline } from '../../lambda/src/router-agent-handler';
import { requestVisibility } from '../../lambda/src/lib/task-visibility';
import { canonicalIntentWorkflow, intentWorkflowErrors, type IntentWorkflow } from '../../lambda/src/lib/intent-workflow';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const read = (f: string) => readFileSync(resolve(__dirname, '../../lambda/src', f), 'utf8');
const NOW = 1_800_000_000;
const DAY = 24 * 3600;

describe('a task step\'s deadline, read once for every task step', () => {
  it('a timeout ends the task and its row outlives it by a day', () => {
    expect(taskStepDeadline({ deadline: { afterMinutes: 3 * 24 * 60 } } as never, {}, NOW))
      .toEqual({ kind: 'timeout', dueAt: NOW + 3 * DAY, deadlineAt: NOW + 3 * DAY, ttlSeconds: 4 * DAY });
  });

  it('a due time is shown on the task and its row is kept 45 days', () => {
    const d = taskStepDeadline({ deadline: { kind: 'due', afterMinutes: 60 } } as never, {}, NOW);
    expect(d).toMatchObject({ kind: 'due', dueBy: new Date((NOW + 3600) * 1000).toISOString(), ttlSeconds: 45 * DAY });
    expect(d).not.toHaveProperty('deadlineAt');
  });

  it('a reminder repeats, and a step with no deadline leaves the row to its default', () => {
    expect(taskStepDeadline({ deadline: { kind: 'remind', afterMinutes: 30, times: 2 } } as never, {}, NOW))
      .toMatchObject({ remind: { everyMinutes: 30, times: 2 }, ttlSeconds: 45 * DAY });
    expect(taskStepDeadline({} as never, {}, NOW)).toEqual({ kind: 'timeout' });
  });

  it('a recorded time is read from the run, and one it does not hold fails the step', () => {
    const at = new Date((NOW + 2 * DAY) * 1000).toISOString();
    expect(taskStepDeadline({ deadline: { at: 'task:value:visit' } } as never, { 'task:value:visit': at }, NOW)).toMatchObject({ deadlineAt: NOW + 2 * DAY });
    expect(taskStepDeadline({ deadline: { at: 'task:value:visit' } } as never, {}, NOW)).toBe('unreadable');
  });
});

describe('the request\'s own step', () => {
  const opts = { multiStepIntents: ['report_generation'], intents: ['report_generation'], machines: DEFAULT_TASK_STATE_MACHINES };
  const withDeadline = (deadline: Record<string, unknown>): IntentWorkflow => {
    const wf = canonicalIntentWorkflow('report_generation');
    return { ...wf, states: { ...wf.states, work: { ...wf.states.work, task: { ...(wf.states.work as unknown as { task: object }).task, deadline } } } } as unknown as IntentWorkflow;
  };

  it('declares a time from now, a timeout or a due time', () => {
    expect(intentWorkflowErrors('report_generation', withDeadline({ afterMinutes: 60 }), opts)).toEqual([]);
    expect(intentWorkflowErrors('report_generation', withDeadline({ kind: 'due', afterMinutes: 60 }), opts)).toEqual([]);
  });

  it.each([
    ['a recorded time, which no earlier task recorded', { at: 'task:value:visit' }, /task\.deadline\.at/],
    ['a reminder, which goes only to a person who holds a task', { kind: 'remind', afterMinutes: 60 }, /task\.deadline\.kind is timeout or due/],
  ])('DENY: %s', (_label, deadline, message) => {
    expect(intentWorkflowErrors('report_generation', withDeadline(deadline), opts).join('\n')).toMatch(message);
  });

  it('opens its task once, keeps the step\'s due time and row lifetime on either door, and a failed open abandons the run, taking no edge', () => {
    const router = read('router-agent-handler.ts');
    expect(router).not.toMatch(/openOnce/);
    expect(router).toMatch(/const deadline = taskStepDeadline\(def, \{\}\);/);
    expect(router).not.toMatch(/the request\\'s task did not open; the step takes its failure edge/);
    expect(router).toMatch(/AN OPEN THAT FAILS ABANDONS THE RUN, taking no edge/);
    expect(router).toMatch(/ttlSeconds: Math\.max\(extra\.ttlSeconds, taskOpts\?\.ttlSeconds \?\? 0\)/);
    expect(router).toMatch(/attachRequestRun\(\{[^}]*\.\.\.extra \}\)\);/);
    expect(read('lib/task-tracking.ts')).toMatch(/\$\{extra\.dueBy \? ', dueBy = :due' : ''\}\$\{ttlSeconds \? ', #ttl = :ttl' : ''\}/);
  });
});

describe('a request opened mid-task is as private as its message', () => {
  const target = inboundTarget as jest.MockedFunction<typeof inboundTarget>;

  it('a message sent to the room opens a request the room sees', async () => {
    target.mockResolvedValueOnce('public');
    await expect(requestVisibility({} as never, 'arn:c', 'm1', 'arn:b')).resolves.toBe('conversation');
  });

  it.each([
    ['a targeted message', 'targeted'],
    ['a message that cannot be read', 'unreadable'],
  ] as const)('%s opens a private request', async (_label, read) => {
    target.mockResolvedValueOnce(read);
    await expect(requestVisibility({} as never, 'arn:c', 'm1', 'arn:b')).resolves.toBe('private');
  });

  it('a failed read and a message with no id open a private request', async () => {
    target.mockRejectedValueOnce(new Error('throttled'));
    await expect(requestVisibility({} as never, 'arn:c', 'm1', 'arn:b')).resolves.toBe('private');
    await expect(requestVisibility({} as never, 'arn:c', undefined, 'arn:b')).resolves.toBe('private');
  });

  it('the turn opens the request with that visibility', () => {
    expect(read('assistant-async-processor.ts')).toMatch(/visibility: await requestVisibility\(messagingClient, event\.channelArn, event\.userMessageId, event\.botArn\),/);
  });
});
