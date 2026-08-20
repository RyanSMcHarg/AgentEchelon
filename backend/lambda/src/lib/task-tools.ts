/**
 * In-Lambda task tools (SPEC-TASK-STATE-TRANSITIONS §3, §5). The Converse tool loop registers these
 * only when a task is active; a tool call is the ONLY thing that changes task state, and the runtime
 * authorizes it against the task's graph before it persists. Kept separate from the loop so the
 * dispatch logic is unit-testable without a Bedrock round-trip.
 */
import { type Task, advanceTaskStateTo, type AdvanceResult } from './task-tracking.js';
// The shape the delivering check reads back. Imported rather than re-declared so the writer and the
// reader cannot drift into two different ideas of what an agreed size is.
import type { LengthTarget as RecordedLengthTarget } from './deliverable-check.js';
import {
  type TaskStateMachine,
  DEFAULT_TASK_STATE_MACHINES,
  ADVANCE_TASK_STATE_TOOL_NAME,
} from './task-state-machines.js';

// Re-exported from where the machines are declared, so a prompt that names this tool and the loop that
// dispatches it read the same constant. Kept exported here because this is where callers expect it.
export { ADVANCE_TASK_STATE_TOOL_NAME };

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
  /** The assistant running this turn, so a task leaving a waiting state is handed back to it. */
  assistantId?: string;
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
  currentState?: string,
): Array<typeof ADVANCE_TASK_STATE_TOOL_SPEC> {
  if (!taskHasMachine(taskType, machines)) return [];

  // THE STEP'S DECLARED NEEDS RIDE IN THE TOOL ITSELF when it has any (SPEC-TASK-STATE-TRANSITIONS
  // §4). Until now the tool was STATE-BLIND: its inputs were `to_state` and a free-text `reason`, and
  // its description said nothing about what the current step needs - so "I have all the data I need"
  // satisfied `reason` completely, and the checklist rendered in the prompt was the only thing asking.
  // A checklist the caller never has to answer is a checklist the caller can skip.
  //
  // AND THE ANSWERS ARE RECORDED, which is the half that makes this more than a nag. `collected`
  // becomes `task.details.requirements`, so what the person actually said - the audience, the length -
  // is agreed ONCE and readable afterwards by every consumer: the delivering check that compares the
  // document against it, the revision branch, and anyone auditing why a document looks the way it
  // does. The alternative is re-deriving the agreement from prose on every read, which makes a
  // contract out of a sentence someone happened to type.
  const requires = currentState
    ? machines[taskType as string]?.states?.[currentState]?.requires
    : undefined;
  if (!requires?.length) return [ADVANCE_TASK_STATE_TOOL_SPEC];

  const list = requires.map((r) => `"${r}"`).join(', ');
  return [{
    toolSpec: {
      ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec,
      description:
        `${ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.description} This step needs ${list}. Account for `
        + 'each one in `collected`, copying the requirement text verbatim and giving the value the '
        + 'person actually supplied. If something is still missing, do not call this tool - ask them '
        + 'for the missing part instead.',
      inputSchema: {
        json: {
          ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json,
          properties: {
            ...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json.properties,
            collected: {
              type: 'array',
              description: `What the person gave for each of this step's needs (${list}).`,
              items: {
                type: 'object',
                properties: {
                  requirement: { type: 'string', description: 'The requirement text, copied verbatim.' },
                  value: { type: 'string', description: 'What the person actually said for it.' },
                  // THE MODEL NORMALISES, BECAUSE THE MODEL IS WHAT UNDERSTANDS THE ANSWER. A person
                  // says "1-2 pages", "a page or two", "keep it short"; turning any of those into a
                  // number is language work, and doing it downstream with a pattern means the runtime
                  // guessing at English it never saw in context. Recorded once here, every later
                  // reader gets a number instead of a sentence to re-interpret.
                  //
                  // Optional on purpose: absent means no size was agreed, which is a real answer to
                  // "the length or format" (a person may only name the format). Nothing is enforced
                  // then - an absent agreement is not a violation, and a guessed one is worse than none.
                  minWords: {
                    type: 'integer',
                    description: 'Only when this requirement fixes a SIZE: the fewest words that '
                      + 'satisfies what the person asked for. A page is roughly 300-900 words '
                      + 'depending on how much of it is tables and lists. Omit if no size was agreed.',
                  },
                  maxWords: {
                    type: 'integer',
                    description: 'Only when this requirement fixes a SIZE: the most words that still '
                      + 'satisfies it. Omit if no size was agreed.',
                  },
                  // SHOWN TO THE PERSON, so it has to be the size and nothing else. The value of the
                  // requirement is a whole answer - at `drafting_outline` it is "approval of the
                  // outline, or what to change about it", so a size can arrive inside "Looks good, but
                  // can you make it 1-2 pages?". Rendering that back produced "Trimming the report to
                  // Looks good, but can you make it 1-2 pages?...". The label is asked for separately
                  // rather than extracted, because extracting it would be a pattern reading English
                  // (tenet 11); absent, the numbers are shown instead.
                  sizeLabel: {
                    type: 'string',
                    description: 'Only with minWords/maxWords: how to NAME that size to the person, in '
                      + 'their own words and nothing else - "1-2 pages", "a short summary". Not a '
                      + 'sentence, and never the whole of what they said.',
                  },
                },
                required: ['requirement', 'value'],
              },
            },
          },
          required: [...ADVANCE_TASK_STATE_TOOL_SPEC.toolSpec.inputSchema.json.required, 'collected'],
        },
      },
    },
  } as unknown as typeof ADVANCE_TASK_STATE_TOOL_SPEC];
}

/**
 * The `collected` tool input, as the map recorded on the task.
 *
 * Tolerant of shape because a model supplies it: a non-array, a non-object entry, or a blank
 * requirement/value is dropped rather than written. A malformed accounting is worth less than a
 * correct one and is worth more than a rejected transition - the step still advanced for real
 * reasons, and refusing it here would strand the task over bookkeeping.
 */
/** A number, or a numeric string a model sent where an integer was asked for. Anything else is null. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function collectedRequirements(
  input: unknown,
): { requirements: Record<string, string>; lengthTarget?: RecordedLengthTarget } | undefined {
  if (!Array.isArray(input)) return undefined;
  const requirements: Record<string, string> = {};
  let lengthTarget: RecordedLengthTarget | undefined;

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const { requirement, value, minWords, maxWords, sizeLabel } = entry as Record<string, unknown>;
    if (typeof requirement !== 'string' || typeof value !== 'string') continue;
    if (!requirement.trim() || !value.trim()) continue;
    requirements[requirement.trim()] = value.trim();

    // A SIZE IS A PAIR OR IT IS NOTHING. One bound alone cannot say what satisfies the person: a
    // minimum with no maximum admits a document ten times what they asked for, and a maximum alone
    // admits an empty one. Half an agreement is not an agreement, so it is discarded rather than
    // half-enforced. Same for a reversed or non-positive pair - a model produced it, and a bound that
    // makes no sense is noise, not data.
    // A NUMBER MAY ARRIVE AS A NUMERIC STRING. `"600"` is an ordinary model output for an integer
    // field, and discarding it silently threw away a real agreement. Coercing a numeric string is
    // arithmetic, not a language judgement: anything that is not a number after coercion is refused.
    const min = toFiniteNumber(minWords);
    const max = toFiniteNumber(maxWords);
    const boundsOffered = minWords !== undefined || maxWords !== undefined;

    if (min !== null && max !== null && min > 0 && max >= min) {
      // The FIRST size wins if a model marks two requirements as sizes: the alternative is picking by
      // a rule nobody declared. One step, one agreed size.
      const label = typeof sizeLabel === 'string' ? sizeLabel.trim() : '';
      lengthTarget ??= {
        minWords: Math.round(min),
        maxWords: Math.round(max),
        // The LABEL, never the whole answer: this is rendered to the person while the document is
        // being corrected. Bounded, because a model asked for a short phrase can still send a
        // paragraph, and a progress line is not the place to find that out.
        source: label && label.length <= 60 ? label : `${Math.round(min)}-${Math.round(max)} words`,
      };
    } else if (boundsOffered) {
      // BOUNDS WERE OFFERED AND REFUSED, which is not the same as no size being agreed - and at
      // delivery the two look identical (`agreed: 'not recorded'`). Said here, where the discard
      // happens, so a malformed pair is findable instead of looking like a person who named no size.
      console.warn('[TaskTools] size bounds discarded as unusable', {
        requirement: requirement.trim(), minWords, maxWords,
      });
    }
  }
  if (!Object.keys(requirements).length) return undefined;
  return { requirements, ...(lengthTarget ? { lengthTarget } : {}) };
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
  /** The assistant running this turn, so a task can be handed back when it stops awaiting the user. */
  assistantId?: string;
}): Promise<{
  payload: Record<string, unknown>;
  result: AdvanceResult;
  /** What was written to `task.details`, so the caller can refresh its in-memory task. */
  details?: Record<string, unknown>;
}> {
  const toState = typeof args.input.to_state === 'string' ? args.input.to_state.trim() : '';
  const reason = typeof args.input.reason === 'string' ? args.input.reason : undefined;

  if (!toState) {
    const result: AdvanceResult = { ok: false, error: 'unknown_state', from: args.task.taskState };
    return {
      payload: { ok: false, error: 'unknown_state', message: 'to_state is required' },
      result,
    };
  }

  // RECORDED ON THE TRANSITION, not on the turn: the values belong to the step the person answered,
  // and `advanceTaskStateTo` merges them into `task.details` so a later step cannot lose an earlier
  // one's answers. Written under `requirements` so the map is addressable rather than spread across
  // details' top level, where a state-specific key could collide with it.
  const collected = collectedRequirements(args.input.collected);
  // Built once and RETURNED, so the caller can put it back on its in-memory task. A step that
  // collects a requirement and delivers in the SAME turn - `data_extraction.collecting_requirements`
  // goes straight into `extracting`, which delivers - would otherwise check the document against a
  // snapshot taken before the tool ran, find no agreement, and enforce nothing on the very turn the
  // agreement was made. Measured: the live extraction logged `agreed: 'not recorded'` immediately
  // after recording one.
  const mergedDetails = collected
    ? {
      requirements: {
        ...(args.task.details?.requirements as Record<string, string> ?? {}),
        ...collected.requirements,
      },
      // The agreed SIZE, stored as the numbers the model resolved it to. A later step that agrees
      // a new size replaces it; one that agrees none leaves the earlier agreement standing, which
      // is what a person would expect from having said it once.
      ...(collected.lengthTarget ? { lengthTarget: collected.lengthTarget } : {}),
    }
    : undefined;

  const result = await advanceTaskStateTo({
    task: args.task,
    toState,
    by: 'tool',
    reason,
    messageId: args.messageId,
    machines: args.machines ?? DEFAULT_TASK_STATE_MACHINES,
    ...(mergedDetails ? { details: mergedDetails } : {}),
    ...(args.assistantId ? { assistantId: args.assistantId } : {}),
  });

  const payload: Record<string, unknown> = result.ok
    ? { ok: true, from: result.from, to: result.to, ...(result.terminal ? { terminal: result.terminal } : {}) }
    : {
        ok: false,
        error: result.error,
        ...(result.from ? { from: result.from } : {}),
        ...(result.legal ? { legal_transitions: result.legal } : {}),
      };
  return { payload, result, ...(mergedDetails ? { details: mergedDetails } : {}) };
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
