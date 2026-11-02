/**
 * DECLARED STEP ACTIONS: what the platform runs when a task enters a state, with no model call
 * (SPEC-TASK-STATE-TRANSITIONS FR17, FR29).
 *
 * The owner's division of labor is the reason this exists. An assistant uses model judgment; a manager
 * who needs a fixed step, or a deterministic outcome, declares it in the workflow; and the platform runs
 * what the workflow DECLARES, for the workflow the turn's derived intent selected. A state that declares
 * `action: { tool, args }` is such a step: entering it runs the tool with its arguments bound to what the
 * task recorded, and the runtime takes the declared `onSuccess` or `onFailure` edge on the outcome.
 *
 * THIS IS THE AUTHORIZED EXCEPTION TO "THE RUNTIME NEVER FORCE-ADVANCES" (§3). It is bounded by the same
 * things that make that rule worth having: the edge is declared by the workflow (validation refuses an
 * outcome edge that is not a transition), it is authorized against the graph like any other move, it is
 * logged as runtime-driven with the action that caused it (`by: 'system'`, `action`), and a turn takes at
 * most `MAX_RUNTIME_MOVES_PER_TURN` of them, so two action states pointing at each other cannot loop.
 *
 * WHO IT RUNS AS. The tool runs through the same handler a model's call reaches, under the assistant's own
 * vended session, and only when the turn's allowlist (the profile's narrowed by the intent's) permits it
 * and its runtime precondition holds. An action is never a way to reach a tool the assistant could not
 * call (tenets D1, D4).
 *
 * EXACTLY ONCE PER ENTRY. The run is claimed first (`claimStateAction`), keyed on the task, the state and
 * how many times the task has entered it, with a conditional write, so a retried model call or a
 * redelivered turn on the same entry does not run the tool again. The result, the edge and the log entry
 * are then one conditional write. A claim that cannot be made is not run around: the task rests in the
 * state, whose outcome edges are ordinary transitions the model can take.
 */
import { claimStateAction, advanceTaskStateTo } from './task-store.js';
import {
  type TaskStateDef,
  actionEdgesOf,
  DELIVER_DOCUMENT_TOOL_NAME,
  GENERATE_IMAGE_ACTION,
} from './task-state-machines.js';
import {
  type TaskLoopContext,
  bindActionArgs,
  turnConditionValues,
  handleDeliverDocumentTool,
} from './task-tools.js';
import { classifyToolError, type PlatformActionOutcome, type ConverseStep } from './analytics-metadata.js';

/**
 * THE MOST RUNTIME-DRIVEN MOVES ONE TURN TAKES. A deterministic workflow takes one per action state it
 * passes through (run the search, then deliver the filled document), so four leaves room for a short chain
 * and stops a cycle of action states on its fifth step. Counted across the turn, retries included.
 */
export const MAX_RUNTIME_MOVES_PER_TURN = 4;

/** The largest action result recorded on the task, as JSON. A larger one is recorded as truncated. */
export const MAX_RECORDED_RESULT_CHARS = 8000;

/** What the turn gives the runner: how to run a registered tool, and whether this turn may. */
export interface StepActionEnv {
  /** Run a registered tool exactly as a model's call would (same handler, same session). */
  runTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The turn's allowlist permits the tool AND its runtime precondition holds this turn. */
  toolAvailable(name: string): boolean;
  /**
   * GENERATE THE STEP'S IMAGE (ADR-064 decision E), on the image model of the task intent's route, under the image
   * guardrail, persisted and attached to the turn's reply. Absent where this turn cannot generate one (no image model
   * selected, no attachments bucket), and the action then fails, taking `onFailure`.
   */
  generateImage?(prompt: string, task: { taskType?: string; details?: Record<string, unknown> }): Promise<ImageStepResult>;
}

/** What generating a step's image produced: whether it did, on which model, and what it cost. */
export interface ImageStepResult {
  ok: boolean;
  modelId?: string;
  imageCount?: number;
  estCostUsd?: number;
  /** Why it produced nothing: a bounded class, never the provider's text. */
  errorClass?: string;
}

/** What `details.actions[state]` holds once an entry's action ran. */
export interface RecordedStepAction {
  tool: string;
  ok: boolean;
  /** The idempotency key of the entry it ran on (`<state>#<entry>`). */
  key: string;
  at: string;
  /** The tool's result, when it succeeded and is no larger than `MAX_RECORDED_RESULT_CHARS` as JSON. */
  result?: unknown;
  resultTruncated?: true;
  /** A bounded class when it failed, never the raw error text. */
  errorClass?: string;
  /** The platform's refusal code when the action was refused by a declared rule rather than failing. */
  refusal?: string;
}

/** One action the runner ran or declined, for the turn's steps and the advance's answer. */
export interface StepActionRun extends PlatformActionOutcome {
  startedAt: string;
  endedAt: string;
  /** The model a `generate_image` action ran on, and what it cost, so the turn's steps price it (ADR-064 decision 4). */
  modelId?: string;
  estCostUsd?: number;
  imageCount?: number;
  /** The state the runtime moved the task to on the outcome, when it moved it. */
  movedTo?: string;
}

function boundedResult(payload: Record<string, unknown>): { result?: unknown; resultTruncated?: true } {
  try {
    const json = JSON.stringify(payload);
    return json.length <= MAX_RECORDED_RESULT_CHARS ? { result: JSON.parse(json) } : { resultTruncated: true };
  } catch {
    return { resultTruncated: true };
  }
}

/** A refusal code the action produced itself, kept to the bounded snake_case vocabulary. */
const REFUSAL = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Run the declared action of the state the task is in, take its outcome edge, and keep going while the
 * landed state declares one too, up to the turn's bound. Returns what ran, in order. A no-op for a state
 * with no action, so callers invoke it wherever a task may have entered a state: before the model runs,
 * and after every advance the model makes.
 */
export async function runStepActions(ctx: TaskLoopContext, env: StepActionEnv): Promise<StepActionRun[]> {
  const runs: StepActionRun[] = [];
  for (;;) {
    const task = ctx.task;
    const state = task.taskState ?? '';
    const machine = ctx.machines[task.taskType ?? ''];
    const def: TaskStateDef | undefined = machine?.states?.[state];
    const edges = def?.action ? actionEdgesOf(machine, state) : null;
    if (!def?.action || !edges) break;
    const tool = def.action.tool;
    const startedAt = new Date().toISOString();

    if ((ctx.runtimeMoves ?? 0) >= MAX_RUNTIME_MOVES_PER_TURN) {
      console.warn('[task-state][action] the turn reached its bound on runtime moves; the task rests here', {
        taskId: task.taskId, state, bound: MAX_RUNTIME_MOVES_PER_TURN,
      });
      runs.push({ state, tool, ok: false, errorClass: 'workflow_refusal', refusal: 'runtime_move_bound', startedAt, endedAt: startedAt });
      break;
    }

    const claim = await claimStateAction(task, state);
    if (!claim.claimed) {
      console.warn('[task-state][action] the entry could not be claimed; the action does not run', {
        taskId: task.taskId, state, key: claim.key, reason: claim.reason,
      });
      runs.push({ state, tool, ok: false, errorClass: 'workflow_refusal', refusal: `action_${claim.reason}`, startedAt, endedAt: new Date().toISOString() });
      break;
    }

    // ── RUN IT, AS THE MODEL'S CALL WOULD ────────────────────────────────────────────────────────
    let record: RecordedStepAction;
    let imageRun: ImageStepResult | undefined;
    const at = () => new Date().toISOString();
    if (tool === DELIVER_DOCUMENT_TOOL_NAME) {
      // THE PLATFORM DELIVERS THE STEP'S DOCUMENT: its platform-filled template, rendered from what the
      // task recorded, or a `document` argument bound to a recorded value. Declared for the delivery gate
      // exactly as the model's own call would declare it.
      const bound = bindActionArgs(def.action, task.details, ctx.variables);
      const declared = bound.ok
        ? handleDeliverDocumentTool({
          task, input: bound.args, machines: ctx.machines,
          ...(ctx.templates ? { templates: ctx.templates } : {}),
        })
        : null;
      if (declared?.document) {
        ctx.declaredDocument = declared.document;
        ctx.declaredTemplate = declared.template;
        record = { tool, ok: true, key: claim.key, at: at(), result: { document_declared: true, ...(declared.template?.filled ? { filled_by_platform: true } : {}) } };
      } else {
        const code = !bound.ok ? 'action_unbound_arg' : String((declared?.payload as { error?: unknown })?.error ?? 'document_required');
        record = { tool, ok: false, key: claim.key, at: at(), errorClass: 'workflow_refusal', ...(REFUSAL.test(code) ? { refusal: code } : {}) };
      }
    } else if (tool === GENERATE_IMAGE_ACTION) {
      // THE PLATFORM DRAWS THE STEP'S IMAGE from the recorded brief, never the raw message (ADR-064 decision E).
      const bound = bindActionArgs(def.action, task.details, ctx.variables);
      const prompt = bound.ok ? String(bound.args.prompt ?? '').trim() : '';
      if (!bound.ok || !prompt) {
        record = { tool, ok: false, key: claim.key, at: at(), errorClass: 'workflow_refusal', refusal: 'action_unbound_arg' };
      } else if (!env.generateImage) {
        record = { tool, ok: false, key: claim.key, at: at(), errorClass: 'workflow_refusal', refusal: 'image_model_unavailable' };
      } else {
        let out: ImageStepResult;
        try {
          out = await env.generateImage(prompt, task);
        } catch {
          out = { ok: false, errorClass: 'model_error' };
        }
        imageRun = out;
        record = out.ok
          ? { tool, ok: true, key: claim.key, at: at(), result: { image_generated: true, images: out.imageCount ?? 1, ...(out.modelId ? { model: out.modelId } : {}) } }
          : { tool, ok: false, key: claim.key, at: at(), errorClass: out.errorClass ?? 'model_error' };
      }
    } else if (!env.toolAvailable(tool)) {
      // NOT A WAY AROUND THE ALLOWLIST. A tool this turn could not offer the model is not run for it.
      record = { tool, ok: false, key: claim.key, at: at(), errorClass: 'workflow_refusal', refusal: 'action_tool_not_allowed' };
    } else {
      const bound = bindActionArgs(def.action, task.details, ctx.variables);
      if (!bound.ok) {
        record = { tool, ok: false, key: claim.key, at: at(), errorClass: 'workflow_refusal', refusal: 'action_unbound_arg' };
      } else {
        let payload: Record<string, unknown>;
        try {
          payload = await env.runTool(tool, bound.args);
        } catch (err) {
          payload = { error: err instanceof Error ? err.message : 'tool execution failed' };
        }
        const failure = payload.error ?? payload.unavailable;
        record = failure
          ? { tool, ok: false, key: claim.key, at: at(), errorClass: classifyToolError(failure) }
          : { tool, ok: true, key: claim.key, at: at(), ...boundedResult(payload) };
      }
    }

    // ── RECORD IT AND TAKE THE DECLARED EDGE, IN ONE WRITE ───────────────────────────────────────
    const edge = record.ok ? edges.onSuccess : edges.onFailure;
    const run: StepActionRun = {
      state, tool, ok: record.ok,
      ...(imageRun?.modelId ? { modelId: imageRun.modelId } : {}),
      ...(imageRun?.estCostUsd !== undefined ? { estCostUsd: imageRun.estCostUsd } : {}),
      ...(imageRun?.imageCount !== undefined ? { imageCount: imageRun.imageCount } : {}),
      ...(record.errorClass ? { errorClass: record.errorClass as StepActionRun['errorClass'] } : {}),
      ...(record.refusal ? { refusal: record.refusal } : {}),
      startedAt, endedAt: record.at,
    };
    if (!edge) {
      runs.push(run);
      break;
    }
    const details = {
      actions: { ...((task.details?.actions as Record<string, unknown> | undefined) ?? {}), [state]: record },
    };
    const moved = await advanceTaskStateTo({
      task,
      toState: edge,
      by: 'system',
      reason: `${tool} ${record.ok ? 'succeeded' : 'failed'}`,
      ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
      machines: ctx.machines,
      details,
      ...(ctx.assistantId ? { assistantId: ctx.assistantId } : {}),
      action: { tool, outcome: record.ok ? 'success' : 'failure' },
      // The outcome edge is held to the machine's conditions like any move (ADR-060 decision 6).
      conditionValues: turnConditionValues(ctx),
    });
    if (!moved.ok) {
      console.warn('[task-state][action] the outcome edge was not taken', {
        taskId: task.taskId, state, edge, error: moved.error,
      });
      runs.push(run);
      break;
    }
    task.taskState = moved.to;
    task.details = { ...(task.details ?? {}), ...details };
    // The in-memory log learns the edge too, so a later claim on this row in this turn reads the entry
    // it is on. The service re-reads the row and does not depend on this.
    task.stateHistory = [...(task.stateHistory ?? []), { from: moved.from, to: moved.to, at: record.at, by: 'system' }];
    (ctx.transitions ??= []).push({ from: moved.from, to: moved.to });
    ctx.runtimeMoves = (ctx.runtimeMoves ?? 0) + 1;
    runs.push({ ...run, movedTo: moved.to });
  }
  return runs;
}

/**
 * One action as a step of the turn: `platform-action:<tool>`, run by no model, so it carries no tokens and
 * no model cost, and its outcome sits under `action` rather than `tools` so the tool-error rate, which
 * counts what a MODEL called, never counts it (analytics-metadata.ts).
 */
export function stepActionStep(run: StepActionRun): ConverseStep {
  return {
    stepLabel: `platform-action:${run.tool}`,
    // A generated image is the one action a model runs; its step names that model and its cost (ADR-064 decision 4).
    modelId: run.modelId ?? 'platform',
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    action: {
      state: run.state, tool: run.tool, ok: run.ok,
      ...(run.errorClass ? { errorClass: run.errorClass } : {}),
      ...(run.refusal ? { refusal: run.refusal } : {}),
    },
    estCostUsd: run.estCostUsd ?? 0,
    ...(run.imageCount !== undefined ? { imageCount: run.imageCount } : {}),
  };
}

/** What the model is told about the actions an advance set off, beside the advance's own answer. */
export function actionsSummary(runs: StepActionRun[]): Array<Record<string, unknown>> {
  return runs.map((r) => ({
    state: r.state, tool: r.tool, ok: r.ok,
    ...(r.refusal ? { refusal: r.refusal } : r.errorClass ? { error_class: r.errorClass } : {}),
    ...(r.movedTo ? { moved_to: r.movedTo } : {}),
  }));
}
