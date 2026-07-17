/**
 * In-Lambda task tools (SPEC-TASK-STATE-TRANSITIONS §3, §5). The Converse tool loop registers these
 * only when a task is active; a tool call is the ONLY thing that changes task state, and the runtime
 * authorizes it against the task's graph before it persists. Kept separate from the loop so the
 * dispatch logic is unit-testable without a Bedrock round-trip.
 */
import { type Task, advanceTaskStateTo, type AdvanceResult } from './task-tracking.js';
import { type TaskStateMachine, DEFAULT_TASK_STATE_MACHINES } from './task-state-machines.js';

export const ADVANCE_TASK_STATE_TOOL_NAME = 'advance_task_state';

/**
 * The active-task context threaded into the Converse loop. Passing it registers the task tools and
 * lets the loop dispatch a tool call to the authorized transition. `transitions` is populated BY the
 * loop with the transitions it applied this turn, so the caller can record them for analytics and
 * compare against the shadow keyword detector — no return-value threading through the fallback paths.
 */
export interface TaskLoopContext {
  task: Task;
  machines?: Record<string, TaskStateMachine>;
  messageId?: string;
  /** The task state BEFORE this turn (captured at build), so the shadow keyword detector can be
   *  compared against the same state the model saw even after the tool mutates task.taskState. */
  initialState?: string;
  transitions?: Array<{ from: string; to: string }>;
}

/**
 * The advance_task_state tool spec (Converse `toolSpec`, JSON Schema input). The description carries
 * the calling contract — call only at the real milestone, and `resolved` only after the user
 * confirms — so a user-gated transition happens naturally on the assistant's next turn (§3).
 */
export const ADVANCE_TASK_STATE_TOOL_SPEC = {
  toolSpec: {
    name: ADVANCE_TASK_STATE_TOOL_NAME,
    description:
      'Move the active task to a new state. Call this when the conversation has actually reached the ' +
      "milestone — e.g. 'diagnosing' only once you have enough symptoms to analyze, 'resolved' only " +
      'after the user confirms the fix worked. If unsure, do not call it; the task stays where it is.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          to_state: { type: 'string', description: 'Target state (must be reachable from the current state).' },
          reason: { type: 'string', description: 'One sentence: what in the conversation justifies this transition.' },
        },
        required: ['to_state', 'reason'],
      },
    },
  },
} as const;

/** The set of task tool names, so the loop can recognize a task-tool call cheaply. */
export const TASK_TOOL_NAMES = new Set<string>([ADVANCE_TASK_STATE_TOOL_NAME]);

/** True if the task type has a machine (i.e. task tools should be registered this turn). */
export function taskHasMachine(
  taskType: string | undefined,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): boolean {
  return Boolean(taskType && machines[taskType]);
}

/**
 * The tool specs to register in the Converse loop for an active task. advance_task_state is offered
 * for every machine-backed task; place_item swaps its work-item proposal for propose_item (§5,
 * migrated in a later step). Returns [] when the task type has no machine.
 */
export function taskToolSpecsFor(
  taskType: string | undefined,
  machines: Record<string, TaskStateMachine> = DEFAULT_TASK_STATE_MACHINES,
): Array<typeof ADVANCE_TASK_STATE_TOOL_SPEC> {
  if (!taskHasMachine(taskType, machines)) return [];
  return [ADVANCE_TASK_STATE_TOOL_SPEC];
}

/**
 * Handle an advance_task_state tool call: authorize + persist via advanceTaskStateTo, then format
 * the JSON the model reads back. On `illegal_transition` / `unknown_state` the legal set is echoed
 * as `legal_transitions` so the model can self-correct in the same loop iteration without any state
 * change (§3). Returns the structured `result` too, so the loop can update its local task state and
 * record the transition for analytics.
 */
export async function handleAdvanceTaskStateTool(args: {
  task: Task;
  input: Record<string, unknown>;
  machines?: Record<string, TaskStateMachine>;
  messageId?: string;
}): Promise<{ payload: Record<string, unknown>; result: AdvanceResult }> {
  const toState = typeof args.input.to_state === 'string' ? args.input.to_state.trim() : '';
  const reason = typeof args.input.reason === 'string' ? args.input.reason : undefined;

  if (!toState) {
    const result: AdvanceResult = { ok: false, error: 'unknown_state', from: args.task.taskState };
    return {
      payload: { ok: false, error: 'unknown_state', message: 'to_state is required' },
      result,
    };
  }

  const result = await advanceTaskStateTo({
    task: args.task,
    toState,
    by: 'tool',
    reason,
    messageId: args.messageId,
    machines: args.machines ?? DEFAULT_TASK_STATE_MACHINES,
  });

  const payload: Record<string, unknown> = result.ok
    ? { ok: true, from: result.from, to: result.to, ...(result.terminal ? { terminal: result.terminal } : {}) }
    : {
        ok: false,
        error: result.error,
        ...(result.from ? { from: result.from } : {}),
        ...(result.legal ? { legal_transitions: result.legal } : {}),
      };
  return { payload, result };
}

/**
 * Pure decision (SPEC-TASK-STATE-TRANSITIONS §5): does a work-item proposal emitted this turn drive
 * place_item's `collecting -> confirming` transition? The proposal (add_item etc.) IS the structured
 * signal that the task has gathered enough to propose a placement, so the advance couples to the
 * tool's SUCCESS — not to the `<!--proposal:-->` marker or a prose keyword. True only for a place_item
 * task currently in `collecting`.
 */
export function proposalAdvancesPlaceItem(ctx: TaskLoopContext | undefined): boolean {
  return Boolean(ctx && ctx.task.taskType === 'place_item' && ctx.task.taskState === 'collecting');
}

/**
 * Couple place_item's `collecting -> confirming` transition to a work-item proposal (§5). When a
 * proposal is emitted for a place_item task in `collecting`, advance via the SANCTIONED authorized
 * path (advanceTaskStateTo) and, on success, reflect the new state + record the transition on the
 * shared context — the same bookkeeping the in-loop advance_task_state dispatch does. No-op returning
 * null otherwise. The `<!--proposal:-->` marker still renders the widget confirm card; only its role
 * as the transition SIGNAL is retired.
 */
export async function advancePlaceItemOnProposal(
  ctx: TaskLoopContext | undefined,
): Promise<AdvanceResult | null> {
  if (!proposalAdvancesPlaceItem(ctx) || !ctx) return null;
  const result = await advanceTaskStateTo({
    task: ctx.task,
    toState: 'confirming',
    by: 'tool',
    reason: 'work-item proposal emitted',
    messageId: ctx.messageId,
    machines: ctx.machines,
  });
  if (result.ok) {
    ctx.task.taskState = result.to;
    (ctx.transitions ??= []).push({ from: result.from, to: result.to });
  }
  return result;
}
