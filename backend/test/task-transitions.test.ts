/**
 * Authorized task transitions (SPEC-TASK-STATE-TRANSITIONS §3): the runtime authorizes what the
 * model requests. Covers the pure authorizeTransition decision and advanceTaskStateTo's result
 * shapes without a persistence backend (TASKS_TABLE unset ⇒ the authorization decision still stands,
 * no DynamoDB call). The persist path (stateHistory append) is exercised by the wiring tests.
 */
import { authorizeTransition } from '../lambda/src/lib/task-state-machines.js';
import { advanceTaskStateTo, type Task } from '../lambda/src/lib/task-tracking.js';
import { DeliveryOption } from '../lambda/src/lib/delivery-options.js';

const baseTask = (over: Partial<Task> = {}): Task => ({
  taskId: 't1',
  channelArn: 'arn:chan',
  userArn: 'arn:user',
  userMessage: 'help',
  status: 'in_progress',
  deliveryOption: DeliveryOption.TASK_MULTI_STEP,
  taskType: 'guided_troubleshooting',
  taskState: 'collecting_symptoms',
  details: {},
  createdAt: 'x',
  updatedAt: 'x',
  ttl: 0,
  ...over,
});

describe('authorizeTransition (pure §3 checks 2-3)', () => {
  it('authorizes a declared edge', () => {
    const a = authorizeTransition('guided_troubleshooting', 'collecting_symptoms', 'diagnosing');
    expect(a).toEqual({ ok: true, from: 'collecting_symptoms', to: 'diagnosing', terminal: undefined });
  });

  it('rejects an undeclared target as unknown_state, echoing the legal set', () => {
    const a = authorizeTransition('guided_troubleshooting', 'collecting_symptoms', 'teleport');
    expect(a).toMatchObject({ ok: false, error: 'unknown_state', from: 'collecting_symptoms', legal: ['diagnosing'] });
  });

  it('rejects a declared-but-illegal edge as illegal_transition, echoing the legal set', () => {
    // 'resolved' is a real state, but not reachable directly from collecting_symptoms
    const a = authorizeTransition('guided_troubleshooting', 'collecting_symptoms', 'resolved');
    expect(a).toMatchObject({ ok: false, error: 'illegal_transition', from: 'collecting_symptoms', legal: ['diagnosing'] });
  });

  it('reports the terminal disposition when the target is terminal', () => {
    expect(authorizeTransition('guided_troubleshooting', 'awaiting_result', 'resolved'))
      .toEqual({ ok: true, from: 'awaiting_result', to: 'resolved', terminal: 'success' });
    expect(authorizeTransition('guided_troubleshooting', 'awaiting_result', 'escalated'))
      .toEqual({ ok: true, from: 'awaiting_result', to: 'escalated', terminal: 'handoff' });
  });
});

describe('advanceTaskStateTo (authorization result, no persistence backend)', () => {
  it('returns no_active_task when the task has no machine state', async () => {
    const r = await advanceTaskStateTo({ task: baseTask({ taskType: undefined, taskState: undefined }), toState: 'diagnosing' });
    expect(r).toEqual({ ok: false, error: 'no_active_task' });
  });

  it('rejects an illegal transition with the legal set and changes nothing', async () => {
    const r = await advanceTaskStateTo({ task: baseTask({ taskState: 'collecting_symptoms' }), toState: 'resolved' });
    expect(r).toMatchObject({ ok: false, error: 'illegal_transition', from: 'collecting_symptoms', legal: ['diagnosing'] });
  });

  it('authorizes a legal transition', async () => {
    const r = await advanceTaskStateTo({ task: baseTask({ taskState: 'collecting_symptoms' }), toState: 'diagnosing' });
    expect(r).toEqual({ ok: true, from: 'collecting_symptoms', to: 'diagnosing', terminal: undefined });
  });

  it('authorizes the regression edge (a failed fix returns to diagnosing)', async () => {
    const r = await advanceTaskStateTo({ task: baseTask({ taskState: 'awaiting_result' }), toState: 'diagnosing' });
    expect(r).toEqual({ ok: true, from: 'awaiting_result', to: 'diagnosing', terminal: undefined });
  });
});
