/**
 * In-Lambda task tools (SPEC-TASK-STATE-TRANSITIONS §3). Verifies which specs get registered for a
 * task type and the advance_task_state dispatch: a legal call is authorized, an illegal one echoes
 * the legal set for self-correction, and a missing target is rejected — all without a persistence
 * backend (TASKS_TABLE unset).
 */
import {
  ADVANCE_TASK_STATE_TOOL_NAME,
  ADVANCE_TASK_STATE_TOOL_SPEC,
  taskHasMachine,
  taskToolSpecsFor,
  handleAdvanceTaskStateTool,
  proposalAdvancesPlaceItem,
  advancePlaceItemOnProposal,
  type TaskLoopContext,
} from '../lambda/src/lib/task-tools.js';
import { type Task } from '../lambda/src/lib/task-tracking.js';
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

describe('task tool registration', () => {
  it('registers advance_task_state only for a machine-backed task', () => {
    expect(taskHasMachine('guided_troubleshooting')).toBe(true);
    expect(taskHasMachine('nope')).toBe(false);
    expect(taskHasMachine(undefined)).toBe(false);

    expect(taskToolSpecsFor('guided_troubleshooting')).toEqual([ADVANCE_TASK_STATE_TOOL_SPEC]);
    expect(taskToolSpecsFor(undefined)).toEqual([]);
    expect(ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.name).toBe(ADVANCE_TASK_STATE_TOOL_NAME);
  });
});

describe('handleAdvanceTaskStateTool dispatch', () => {
  it('authorizes a legal transition and reports from/to', async () => {
    const { payload, result } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'collecting_symptoms' }),
      input: { to_state: 'diagnosing', reason: 'enough symptoms gathered' },
    });
    expect(result.ok).toBe(true);
    expect(payload).toEqual({ ok: true, from: 'collecting_symptoms', to: 'diagnosing' });
  });

  it('reports the terminal disposition when reaching a terminal state', async () => {
    const { payload } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'awaiting_result' }),
      input: { to_state: 'resolved', reason: 'user confirmed the fix worked' },
    });
    expect(payload).toEqual({ ok: true, from: 'awaiting_result', to: 'resolved', terminal: 'success' });
  });

  it('rejects an illegal transition and echoes the legal set for self-correction', async () => {
    const { payload, result } = await handleAdvanceTaskStateTool({
      task: baseTask({ taskState: 'collecting_symptoms' }),
      input: { to_state: 'resolved', reason: 'skip ahead' },
    });
    expect(result.ok).toBe(false);
    expect(payload).toMatchObject({ ok: false, error: 'illegal_transition', from: 'collecting_symptoms', legal_transitions: ['diagnosing'] });
  });

  it('rejects a missing to_state', async () => {
    const { payload } = await handleAdvanceTaskStateTool({
      task: baseTask(),
      input: { reason: 'no target given' },
    });
    expect(payload).toMatchObject({ ok: false, error: 'unknown_state' });
  });
});

describe('place_item proposal coupling (§5)', () => {
  const ctxFor = (over: Partial<Task> = {}): TaskLoopContext => ({
    task: baseTask({ taskType: 'place_item', taskState: 'collecting', ...over }),
    transitions: [],
  });

  it('proposalAdvancesPlaceItem is true only for a place_item task in collecting', () => {
    expect(proposalAdvancesPlaceItem(ctxFor())).toBe(true);
    expect(proposalAdvancesPlaceItem(ctxFor({ taskState: 'confirming' }))).toBe(false);
    expect(proposalAdvancesPlaceItem(ctxFor({ taskType: 'guided_troubleshooting', taskState: 'collecting_symptoms' }))).toBe(false);
    expect(proposalAdvancesPlaceItem(undefined)).toBe(false);
  });

  it('advances place_item collecting->confirming and records the transition on the context', async () => {
    const ctx = ctxFor();
    const result = await advancePlaceItemOnProposal(ctx);
    expect(result).toMatchObject({ ok: true, from: 'collecting', to: 'confirming' });
    expect(ctx.task.taskState).toBe('confirming');
    expect(ctx.transitions).toEqual([{ from: 'collecting', to: 'confirming' }]);
  });

  it('is a no-op (null, no state change) when the task is not a collecting place_item', async () => {
    const ctx = ctxFor({ taskType: 'guided_troubleshooting', taskState: 'collecting_symptoms' });
    const result = await advancePlaceItemOnProposal(ctx);
    expect(result).toBeNull();
    expect(ctx.task.taskState).toBe('collecting_symptoms');
    expect(ctx.transitions).toEqual([]);
  });
});
