/**
 * Stall telemetry (SPEC-TASK-STATE-TRANSITIONS §7). A machine-backed task turn that applies NO
 * transition bumps `turnsInState`; once it reaches TASK_STALL_TURNS the runtime emits
 * `task_state_stalled` (log + EMF) so a model that can't drive a task forward is visible on the
 * dashboard. The runtime NEVER force-advances. An authorized advance clears the counter. Exercised
 * with no persistence backend (TASKS_TABLE unset) — the increment is in-memory and the signal fires
 * off the resolved count, so both are observable without DynamoDB.
 */
import {
  recordNoTransitionTurn,
  advanceTaskStateTo,
  TASK_STALL_TURNS,
  type Task,
} from '../lambda/src/lib/task-tracking.js';
import * as emf from '../lambda/src/lib/emf-metrics.js';
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

describe('recordNoTransitionTurn (§7 stall counter)', () => {
  let emitSpy: jest.SpyInstance;

  beforeEach(() => {
    emitSpy = jest.spyOn(emf, 'emitEmfMetric').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('increments turnsInState from 0 and reflects it onto the task', async () => {
    const task = baseTask();
    expect(await recordNoTransitionTurn(task)).toBe(1);
    expect(task.turnsInState).toBe(1);
    expect(await recordNoTransitionTurn(task)).toBe(2);
    expect(task.turnsInState).toBe(2);
  });

  it('does NOT emit task_state_stalled below the threshold', async () => {
    const task = baseTask({ turnsInState: TASK_STALL_TURNS - 2 });
    await recordNoTransitionTurn(task); // -> TASK_STALL_TURNS - 1
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('emits task_state_stalled once the counter reaches the threshold', async () => {
    const task = baseTask({ turnsInState: TASK_STALL_TURNS - 1, taskType: 'place_item', taskState: 'confirming' });
    await recordNoTransitionTurn(task); // -> TASK_STALL_TURNS
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'AgentEchelon/Tasks',
        metrics: [{ name: 'task_state_stalled', unit: 'Count' }],
        properties: expect.objectContaining({
          task_state_stalled: 1,
          TaskType: 'place_item',
          TaskState: 'confirming',
          turnsInState: TASK_STALL_TURNS,
        }),
      }),
    );
  });

  it('is a no-op for a task with no machine state', async () => {
    const task = baseTask({ taskType: undefined, taskState: undefined });
    expect(await recordNoTransitionTurn(task)).toBe(0);
    expect(task.turnsInState).toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe('advanceTaskStateTo clears the stall counter (§7)', () => {
  it('resets turnsInState to 0 on an authorized transition', async () => {
    const task = baseTask({ taskState: 'collecting_symptoms', turnsInState: 5 });
    const r = await advanceTaskStateTo({ task, toState: 'diagnosing' });
    expect(r.ok).toBe(true);
    expect(task.turnsInState).toBe(0);
  });

  it('leaves the counter untouched on a rejected (illegal) transition', async () => {
    const task = baseTask({ taskState: 'collecting_symptoms', turnsInState: 5 });
    const r = await advanceTaskStateTo({ task, toState: 'resolved' });
    expect(r.ok).toBe(false);
    expect(task.turnsInState).toBe(5);
  });
});
