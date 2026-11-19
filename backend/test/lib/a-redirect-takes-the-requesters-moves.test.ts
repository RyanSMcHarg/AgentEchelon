/**
 * A REDIRECT TO A TASK THE PERSON ONLY ASKED FOR TAKES THAT TASK'S REQUESTER MOVES (ADR-067 G8, WT114).
 *
 * What it proves: when a turn names another task (ADR-024 D7), the moves it may take there are read from that
 * task's row and the person writing. A task the person holds, or an assistant holds for them, takes its step's own
 * moves. A task the person asked for that another person holds takes only the moves its step declares for the
 * requester, and none where it declares none (DENY). A task the person neither holds nor asked for takes no move
 * (DENY), and so does an ambiguous task when the turn cannot say who is writing (DENY). The router keeps a request
 * another person holds out of the redirect candidates, and the processor hands the redirected task's limit to the
 * advance.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { redirectRequesterMoves } from '../../lambda/src/lib/async-processor-core';
import { handleAdvanceTaskStateTool } from '../../lambda/src/lib/task-tools';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import type { Task } from '../../lambda/src/lib/task-tracking';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
const DISPATCH = {
  initial: 'scheduled',
  states: {
    scheduled: { transitions: ['rescheduled', 'cancelled', 'done'], awaits: { party: 'worker' }, requesterMoves: ['rescheduled', 'cancelled'] },
    rescheduled: { transitions: ['done'], awaits: { party: 'worker' } },
    cancelled: { transitions: [], terminal: 'failure' },
    done: { transitions: [], terminal: 'success' },
  },
} as unknown as TaskStateMachine;
const MACHINES = { dispatch: DISPATCH };

const task = (over: Record<string, unknown> = {}) => ({
  taskId: 'evt-1', channelArn: `${I}/channel/c`, userArn: `${I}/user/customer`, status: 'in_progress',
  taskType: 'dispatch', taskState: 'scheduled', assigneeId: 'driver', assigneeType: 'user', stateHistory: [], details: {}, ...over,
}) as unknown as Task;

describe('the moves a redirect may take on the task it named', () => {
  it('a request of theirs another person holds takes only its requester moves', () => {
    expect(redirectRequesterMoves(task(), MACHINES, 'customer')).toEqual(['rescheduled', 'cancelled']);
  });

  it('DENY: a request of theirs another person holds, on a step that offers the requester nothing, takes no move', () => {
    expect(redirectRequesterMoves(task({ taskState: 'rescheduled' }), MACHINES, 'customer')).toEqual([]);
  });

  it('a task the person holds takes its step\'s own moves', () => {
    expect(redirectRequesterMoves(task(), MACHINES, 'driver')).toBeUndefined();
  });

  it('a task an assistant holds for them takes its step\'s own moves', () => {
    expect(redirectRequesterMoves(task({ assigneeId: 'concierge', assigneeType: 'assistant' }), MACHINES, 'customer')).toBeUndefined();
  });

  it('DENY: a task the person neither holds nor asked for takes no move', () => {
    expect(redirectRequesterMoves(task(), MACHINES, 'stranger')).toEqual([]);
  });

  it('DENY: with no person named, a task held by someone other than its requester takes no move', () => {
    expect(redirectRequesterMoves(task(), MACHINES, undefined)).toEqual([]);
  });

  it('with no person named, a task its own requester holds takes its step\'s own moves', () => {
    expect(redirectRequesterMoves(task({ assigneeId: 'customer' }), MACHINES, undefined)).toBeUndefined();
  });

  it('DENY: the advance refuses a move outside the redirected task\'s requester moves before anything is written', async () => {
    const moves = redirectRequesterMoves(task(), MACHINES, 'customer');
    const out = await handleAdvanceTaskStateTool({ task: task(), input: { to_state: 'done', reason: 'they say it is done' }, machines: MACHINES, requesterMoves: moves });
    expect(out.result).toMatchObject({ ok: false, error: 'illegal_transition' });
  });
});

describe('the limit reaches the advance, and the router keeps such a request out of the redirect set', () => {
  const core = readFileSync(resolve(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('the processor hands a redirected task its own limit, and the turn\'s own task the turn\'s', () => {
    expect(core).toMatch(/const moves = redirected\s*\? redirectRequesterMoves\(targetTask, taskContext\.machines, \(taskContext as TurnTaskLoopContext\)\.turnPersonId\)\s*: taskContext\.requesterMoves;/);
    expect(core).not.toContain('...(!redirected && taskContext.requesterMoves ? { requesterMoves: taskContext.requesterMoves } : {}),');
  });

  it('the router offers as redirect candidates only work the person holds or an assistant holds for them', () => {
    expect(router).toContain("const heldForThem = (o: UserTask): boolean => o.principalId === personId || o.principalId === self || o.assigneeType === 'assistant';");
    expect(router).toContain('...ownedHere.filter((o) => !heldByPerson.some((h) => h.taskId === o.taskId) && heldForThem(o)),');
  });
});
