/**
 * Analytics Metadata for Conversation Archive
 *
 * Defines the analytics metadata structure attached to each Chime message.
 * The metadata flows through: Handler -> Chime Message -> Kinesis -> S3
 *
 * Design principle: Channel = Session
 * Each channel represents a distinct conversation session.
 */

import { estimateStepCostUsd } from './model-rate-table.js';
import type { InteractionKind } from './interaction-kinds.js';
import type { TurnEntry } from './turn-declaration.js';
import type { TerminalKind } from './task-state-machines.js';
import type { TaskTrajectory } from './task-trajectory.js';

/**
 * WHICH ASSISTANT ANSWERED - its stable identifier (the `/assistant/{name}` segment), which is what
 * the `agent_type` column has always been FOR and not what it held.
 *
 * IT WAS THE THREE CLASSIFICATION VALUES, and that is the conflation this removes. A classification
 * is a boundary and it has its own column (`conversation_classification`); an assistant is an
 * holder of a role inside that boundary. They were the same three strings because a classification
 * had exactly one assistant named after it, so "scope to this assistant" separated nothing and two
 * assistants in one classification would have averaged into one row.
 *
 * A STRING, NOT A UNION, because the set is a deployment's own: a team names its assistants, and a
 * closed list here would have to be edited every time one is created - which is precisely the
 * self-service the design is for. The boundary stays closed; the list of assistants does not.
 */
export type AgentType = string;

/**
 * How the model variant for this response was chosen. Top-level (NOT
 * nested under battleContext) by design — variant-comparison rollups
 * must be able to filter battle invocations BEFORE per-variant
 * aggregation. See docs/SPEC-BATTLE.md §Analytics.
 *
 * - 'deterministic': the model came straight from classification+intent resolution (no experiment, no battle).
 *   This is the normal case on a deployment that runs no experiments.
 * - 'probabilistic': an active experiment (router resolveExperimentModel → experimentId) assigned it.
 * - 'battle': a /battle turn.
 */
export type AssignmentMode = 'deterministic' | 'probabilistic' | 'battle';

/**
 * General per-turn telemetry: one step is recorded on EVERY Converse
 * iteration of EVERY turn (persisted out-of-band and shown in the
 * dashboard's per-step breakdown), not battle-only. A step captures
 * one instrumented unit of work — e.g. round-1 generation, a TASK_*
 * chain step, a round-2 rebuttal, or an image-gen call — feeding the
 * response-time + est-cost axes and the admin per-step view
 * (SPEC-BATTLE.md §"Battle Scoring & Per-Step Telemetry", Scope
 * Revision decision 4).
 */
/** Bounded tool-error classification (SPEC-ADMIN-CONSOLE-EFFECTIVENESS P2). NEVER raw error text —
 *  a fixed vocabulary so tool-error rate is queryable without persisting any tool input/output/PII.
 *
 *  `workflow_refusal` IS NOT A FAILURE. It is a call the task workflow refused by one of its own
 *  declared rules (an edge the graph does not hold, a `presented` step, an unsourced need, a delivering
 *  move without its document), which the model reads and corrects in the same loop. It is assigned only
 *  from the structured `refusal` marker the tool handler writes, never from the message, and the
 *  tool-error rate excludes it. */
export type ToolErrorClass = 'timeout' | 'not_found' | 'unauthorized' | 'bad_input' | 'error' | 'workflow_refusal';

/**
 * Which step of the answer a message is, DECLARED by the component that posts it.
 *
 * ONLY `final` CLOSES A TURN. Everything else is a step along the way, and an unrecognized value is
 * treated as a step too - the ledger files an unknown phase as `progress_update`, so a phase added
 * later by a component that has not been taught about latency cannot silently close a turn early.
 * Failing closed into "not final" is the forward-looking guarantee this type exists for.
 *
 * `partial` and `stream_chunk` are RESERVED, not implemented: token streaming would produce them, and
 * naming them here keeps a future producer from inventing a synonym that the ledger would file as
 * unknown.
 */
export type ResponsePhase =
  /** The acknowledgment. Sets TTFF; never closes the turn. */
  | 'placeholder'
  /** A step the person can see, mid-answer: a task advancing, a duel side waiting on them.
   *  It is a real message with content they may need to ACT on - a duel's clarifying question is one -
   *  so it ends their wait even though it does not close the turn. */
  | 'interim'
  /**
   * The turn narrating its own work, with nothing for the person to act on: "Trimming the report to
   * 1-2 pages...", posted while a delivering turn corrects a document.
   *
   * DISTINCT FROM `interim`, and the distinction is load-bearing rather than tidy. Both are updates
   * that do not close a turn, but `interim` carries a message the person may be expected to answer,
   * while this one is a progress note that will itself be replaced. Reusing `interim` for it
   * conflated the two immediately: a reader waiting for "the assistant has said something to me"
   * cannot then tell a clarifying question from a status line, and an e2e that treated every
   * non-`final` update as work-in-progress would wait forever on a duel's question.
   */
  | 'progress'
  /** THE ANSWER. The only phase that closes a turn and stamps `agent_final_at`. */
  | 'final'
  /**
   * THE PERSON STOPPED IT (ADR-033). The turn ran, produced an answer, and the answer was discarded
   * because `/stop` arrived while it was working.
   *
   * ITS OWN PHASE, and neither of the two it would otherwise be folded into:
   *
   *   `final` would count a discarded answer as a completion and flatter the latency average with a
   *   wait nobody was served by.
   *   `error` would report a system fault where somebody changed their mind, and would make the
   *   abandonment signal unreadable by mixing choice with failure.
   *
   * It also must NOT read as a measurement gap. The unclosed buckets partition turns that never
   * resolved, and a cancelled turn resolved exactly as it was asked to.
   */
  | 'cancelled'
  /** The turn failed and said so. Terminal for the person, and deliberately NOT `final`: it closes
   *  the conversation's expectation without contributing a completion time to the latency average. */
  | 'error'
  /** A message the assistant volunteered - a welcome, a drift offer. No user message anchors it, so
   *  it has no TTFF and must not be paired with one. */
  | 'notice';

/**
 * Per-tool outcome for one Converse iteration (P2). A single iteration can invoke several tools
 * (`stepLabel` shows `tool:a+b`), so outcome is per-tool, not one boolean for the step — tool-error
 * rate must attribute to the right tool. `name` is the tool, `ok` its success, `errorClass` the bounded
 * failure class (absent when ok). No payloads: name + success + class only (decision D3).
 */
export interface ToolStepOutcome {
  name: string;
  ok: boolean;
  errorClass?: ToolErrorClass;
  /**
   * The platform's own refusal code (`illegal_transition`, `requirement_unsourced`, ...), present only
   * with `errorClass: 'workflow_refusal'`. A constant the tool handler wrote, never model or person
   * text, so it is safe to persist, and it names the rule the model ran into.
   */
  refusal?: string;
}

/**
 * ONE TOOL CALL AS A JUDGE NEEDS TO SEE IT (SPEC-EVALUATION Appendix C3): what the model asked for and
 * an excerpt of what came back, beside the outcome `ToolStepOutcome` already records. Out-of-band only,
 * on the turn's analytics record, and archived under the conversation's classification as the retrieved
 * passages are; never in the size-capped Chime Metadata. Both halves are capped, so one large result
 * cannot grow the record without bound.
 */
export interface ToolCallRecord {
  name: string;
  /** The call's arguments as JSON, cut at `TOOL_ARGS_MAX_CHARS`. */
  args: string;
  /** The tool's result as JSON, cut at `TOOL_RESULT_MAX_CHARS`. */
  result: string;
  ok: boolean;
  errorClass?: ToolErrorClass;
  refusal?: string;
}

export const TOOL_ARGS_MAX_CHARS = 1000;
export const TOOL_RESULT_MAX_CHARS = 1500;

const capped = (value: unknown, max: number): string => {
  let s: string;
  try { s = JSON.stringify(value ?? null) ?? 'null'; } catch { s = '"[unserializable]"'; }
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** A call's record from its input and payload, with the same outcome `toolStepOutcome` records. */
export function toolCallRecord(name: string, input: unknown, payload: unknown): ToolCallRecord {
  const outcome = toolStepOutcome(name, payload);
  return {
    name: outcome.name,
    args: capped(input, TOOL_ARGS_MAX_CHARS),
    result: capped(payload, TOOL_RESULT_MAX_CHARS),
    ok: outcome.ok,
    ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
    ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
  };
}

/**
 * THE OUTCOME OF A DECLARED STEP ACTION (SPEC-TASK-STATE-TRANSITIONS FR29): a tool the PLATFORM ran on a
 * task entering a state, with no model call. Kept apart from `tools`, which records what a MODEL called,
 * so a platform step is never counted as a model tool call or a model tool error. `errorClass` and
 * `refusal` follow `ToolStepOutcome`: a refusal by a declared rule (an unbound argument, a tool the turn
 * does not allow, an entry already claimed) is `workflow_refusal`, apart from a failure.
 */
export interface PlatformActionOutcome {
  /** The state whose declared action this is. */
  state: string;
  tool: string;
  ok: boolean;
  errorClass?: ToolErrorClass;
  refusal?: string;
}

export interface ConverseStep {
  /** e.g. 'round1-generate', 'task:report-section-2', 'round2-rebuttal', 'image-gen' */
  stepLabel: string;
  /** The Bedrock model that actually ran this step (may differ from the variant default on fallback). */
  modelId: string;
  startedAt: string; // ISO
  endedAt: string; // ISO
  tokensIn?: number;
  tokensOut?: number;
  imageCount?: number; // generation-out only
  /**
   * Structured tool outcomes for a tool-use iteration (P2), so tool identity + success/failure are
   * queryable instead of buried in `stepLabel`. Absent on a pure generation step. `stepLabel` is kept
   * for display; this is the machine-readable projection.
   */
  tools?: ToolStepOutcome[];
  /**
   * Present only on a `platform-action:<tool>` step: the declared step action the platform ran, with no
   * model (`modelId: 'platform'`, no tokens, `estCostUsd: 0`).
   */
  action?: PlatformActionOutcome;
  /**
   * USD estimate from MODEL_RATE_TABLE. `null` (NOT 0) when no real
   * estimate is possible — the scorecard renders "—". Honesty contract,
   * see model-rate-table.ts.
   */
  estCostUsd?: number | null;
}

/**
 * Analytics-side battle context (distinct from the async-processor
 * invocation payload). Rides on analyticsMetadata for per-event detail;
 * `assignmentMode` stays top-level for rollup safety.
 */
export interface AnalyticsBattleContext {
  battleId: string;
  round: 1 | 2;
  selfBotArn: string;
  rivalBotArn: string;
  /** true if this row records a NO_REBUTTAL round-2 deletion */
  optedOutOfRound2?: boolean;
  steps?: ConverseStep[];
  /**
   * Clarification measured dimension (project-battle-clarification-
   * measured-dimension): how often this bot asked vs. forged ahead, and
   * its active response time. Analytical only — NOT a user scorecard
   * axis (the scorecard is strictly time/cost/pick). `clarificationCount`
   * is the bot's cumulative ask count this battle; `activeResponseMs` is
   * elapsed − time spent blocked on the user (`waitedMs`).
   */
  clarificationCount?: number;
  activeResponseMs?: number;
}

/**
 * One per battle, written when the user makes the head-to-head pick
 * (Scope Revision decision 3). Descriptive only — never read back into
 * variant/model selection.
 */
export interface BattleOutcome {
  battleId: string;
  /** A = control variant, B = treatment variant */
  winner: 'A' | 'B' | 'tie';
  chosenByPersonId: string;
  chosenAt: string; // ISO
  // Config attribution — the config fingerprints of the two sides
  // that fought (A = control, B = treatment), so a pick is attributable to the configs, not just the
  // sides' names. Absent when the producing path didn't resolve them (older rows, fail-open).
  controlConfigId?: string;
  treatmentConfigId?: string;
  // Feedback join (SPEC-BATTLE "Battle Objectives"):
  // join the pick to the experiment + variant so it aggregates as a per-variant
  // signal, not just a per-battle row. Resolved server-side from the channel's
  // battle config (experimentId) and `winner` (variantId); never client-supplied.
  // Descriptive only — still never read back into model/variant selection.
  experimentId?: string;
  /** Variant the pick credits: 'control' (A), 'treatment' (B), or undefined for a tie. */
  variantId?: 'control' | 'treatment';
  intent?: string;
}

/**
 * WHAT A TURN'S STEPS COST TOGETHER (ADR-064 decision 7): the sum of each step's `estCostUsd`, text and image alike, so
 * a side whose chain asked on a text model and drew on an image model is priced as both. Null when a step's cost is
 * unknown (never a partial sum presented as the whole), or when there are no steps.
 */
export function summedStepCostUsd(steps: readonly Pick<ConverseStep, 'estCostUsd'>[] | undefined): number | null {
  if (!steps?.length) return null;
  let total = 0;
  for (const s of steps) {
    if (typeof s.estCostUsd !== 'number') return null;
    total += s.estCostUsd;
  }
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Build a ConverseStep with estCostUsd resolved from MODEL_RATE_TABLE at
 * construction time (spec: "computed at write time"). Cost is null when
 * the rate table can't estimate — the null propagates honestly.
 */
export function makeConverseStep(input: {
  stepLabel: string;
  modelId: string;
  startedAt: string;
  endedAt: string;
  tokensIn?: number;
  tokensOut?: number;
  imageCount?: number;
  tools?: ToolStepOutcome[];
}): ConverseStep {
  // Pull `tools` out of the base spread so an empty/absent array doesn't land as `tools: []`.
  const { tools, ...rest } = input;
  return {
    ...rest,
    // Include tools only when at least one tool ran, so a pure-generation step stays clean.
    ...(tools && tools.length ? { tools } : {}),
    estCostUsd: estimateStepCostUsd({
      modelId: input.modelId,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      imageCount: input.imageCount,
    }),
  };
}

/**
 * AN IMAGE THE TURN DREW ON ITS IMAGE MODEL, as one step of the turn (ADR-064 decision 4): the model that drew it, the
 * span of the call and its price per image, so an image turn reads its call and its cost like every other step.
 */
export function imageGenerationStep(input: { modelId: string; startedAt: string; endedAt: string; imageCount: number }): ConverseStep {
  return makeConverseStep({ stepLabel: 'image-gen', ...input, tokensIn: 0, tokensOut: 0 });
}

/**
 * A refusal code as the tool payload carries it: a bounded snake_case constant, or nothing. Anything
 * else is ignored rather than persisted, so a malformed marker cannot carry free text onto the step.
 */
function refusalCodeOf(refusal: unknown): string | undefined {
  return typeof refusal === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(refusal) ? refusal : undefined;
}

/**
 * Map a tool error payload to a bounded ToolErrorClass (P2). A STRUCTURED refusal marker (the
 * payload's `refusal`, written by a handler that refused by a declared rule) is `workflow_refusal`
 * and decides the class outright. Otherwise a heuristic over the error MESSAGE, and only the CLASS is
 * retained; the raw text is never persisted. Unknown shapes fall to 'error'.
 */
export function classifyToolError(message: unknown, refusal?: unknown): ToolErrorClass {
  if (refusalCodeOf(refusal)) return 'workflow_refusal';
  const m = (typeof message === 'string' ? message : '').toLowerCase();
  if (!m) return 'error';
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
  if (m.includes('not found') || m.includes('not_found') || m.includes('no such')) return 'not_found';
  if (m.includes('unauthor') || m.includes('forbidden') || m.includes('denied') || m.includes('access')) return 'unauthorized';
  // Bad input covers validation failures and the model calling a tool that doesn't exist.
  if (m.includes('invalid') || m.includes('required') || m.includes('missing') || m.includes('bad ') || m.includes('unknown tool')) return 'bad_input';
  return 'error';
}

/**
 * The step outcome for one tool call, from the payload the model reads back: `ok` when the payload
 * carries no `error`; otherwise the bounded class, plus the refusal code when the handler marked the
 * error as a refusal by a declared rule. `ok` stays false for a refusal, because the move the model
 * asked for did not happen; the class is what separates it from a failure.
 */
export function toolStepOutcome(name: string, payload: unknown): ToolStepOutcome {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { error?: unknown; refusal?: unknown };
  if (!p.error) return { name, ok: true };
  const refusal = refusalCodeOf(p.refusal);
  return {
    name,
    ok: false,
    errorClass: classifyToolError(p.error, refusal),
    ...(refusal ? { refusal } : {}),
  };
}

/**
 * Analytics metadata attached to each message
 */
export interface AnalyticsMetadata {
  // Message context
  messageNumber: number;
  /**
   * THE CONVERSATION'S CLASSIFICATION, from the channel's immutable tag as the router resolved it.
   *
   * A fact about the ROOM. Not the caller's clearance (`userClearance`) and not the classification
   * assigned to the assistant that answered (`agentType`). A person's credential cannot reach a
   * channel above their clearance, so there is no per-person classification a turn could run at
   * other than this one.
   *
   * Optional because a message that is not a turn (an admin alert, a notice) may declare none.
   */
  classification?: string;
  /**
   * THE CALLER CLEARANCE THAT WAS IN FORCE WHEN THIS TURN RAN.
   *
   * POINT IN TIME, AND THAT IS THE WHOLE REASON IT IS RECORDED. A person clearance moves - a tier
   * change rewrites their groups and re-stamps the classification tag on their identity - so reading
   * either of those later answers what they hold NOW, not what they held when this turn happened.
   * An analytics row is a historical fact and must carry its own.
   *
   * DISTINCT FROM `classification`, which is the conversation's: a person cleared above the room
   * holds more than the room is classified at.
   */
  userClearance?: string;
  role: 'user' | 'assistant';

  // Agent and intent classification
  agentType?: AgentType;
  /**
   * WHICH ROLE the answering assistant holds in its classification (DESIGN-SEPARATE-ASSISTANTS 3.0).
   *
   * `primary` today, because one role is declared. It is recorded anyway so the dimension exists
   * BEFORE there is a second role to separate - a dimension added after the fact can only describe
   * traffic from the day it shipped, and the comparison an operator will want is across the change.
   *
   * Not the occupancy (live vs alt): an alt holds the same role, and the turn path cannot tell
   * which of the two answered, so it is not recorded rather than guessed.
   */
  assistantRole?: string;
  /**
   * THE CLASSIFICATION OF A RUNTIME ASSISTANT (ADR-048), stamped by the turn that resolved it from its own
   * assignment record. Archival runs where no record can be read, and the compiled registry does not know a
   * runtime name, so its boundary check reads this. One layer only: the vended session's
   * `classification` tag, which IAM evaluates, is the other. Absent for a deploy-time assistant.
   */
  runtimeClassification?: string;
  intent?: string;
  intentConfidence?: string;
  /**
   * WHAT CHOSE THIS TURN'S MODEL AND WHICH WORK IT IS ATTRIBUTED TO (ADR-064 decision 4): the task's intent (its type
   * where that is an intent, else the intent of the request that opened it, decision I), the state the task was in when
   * the turn started (`taskState` is the state after), whether the model produced text or an image, and which rule chose
   * it. Analytics-only; archival lands them as columns (migrations 092 and 093).
   */
  taskType?: string;
  /** The platform machine a task runs, where it is not the task's intent (`queued_request`, `queue_drain`, ...). */
  taskMachine?: string;
  turnStep?: string;
  modelKind?: 'text' | 'image';
  modelFrom?: string;
  /**
   * AN IMAGE BRIEF THAT LEFT AWS (ADR-064 security posture): the provider and model of a step's image call hosted outside
   * AWS, and whether the brief carried a requirement sourced from the classification's context. Recorded, not blocked.
   */
  imageEgress?: { provider: string; model: string; contextSourced: boolean };
  /**
   * What this turn's subject comparison decided (drift): the same subject as one the conversation has,
   * a new one, or not compared, with the nearest anchor's distance. Per turn, so the record shows when a
   * conversation's subject changed, and `general` or `off_topic` turns can be grouped by subject.
   */
  subjectDecision?: { decision: 'same' | 'new' | 'skipped'; distance?: number };
  /** How the item this message answers was decided (ADR-035): named by reference, or ranked. */
  taskResolution?: 'reference' | 'id' | 'ranked';
  deliveryOption?: string;

  // Bedrock metrics (assistant messages only)
  bedrockModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;

  // Generation-out (image) turns: how many images this turn produced. An image
  // model reports 0 input/output tokens, so per-image cost can only be priced
  // (estimateStepCostUsd) when the count is persisted here — the frontend battle
  // scorecard also carries it in the Content marker, but that is not queryable.
  imageCount?: number;

  // End-to-end pipeline timing (assistant messages only)
  totalMs?: number;
  /**
   * The ROUTER leg: handler entry to hand-off, one clock. classifierMs is a sub-step of it.
   */
  routerMs?: number;
  /**
   * What the intent classification cost, in ms, measured by the router. ABSENT when no model was
   * asked - the pre-LLM fast paths and orchestrator-dispatched rebuttals - so null means "no
   * classification was bought" rather than "not measured".
   */
  classifierMs?: number;
  /**
   * WHERE INSIDE routerMs THE TIME WENT: one instant per boundary of the router's pre-placeholder
   * path (lib/router-steps.ts). Durations are derived at read by subtracting consecutive instants,
   * the way v_turn_latency already derives the outer bracket.
   *
   * Analytics-only, and NOT in FRONTEND_METADATA_KEYS - nothing a person reads is decided by it. It
   * is the only field here that is an array rather than a scalar, which is why it sheds first under
   * the Athena Metadata cap.
   */
  routerSteps?: { step: string; at: number }[];
  /** When the channel flow received the message, on the server clock. Standard path only. */
  flowReceivedAt?: number;
  /**
   * Admission: the dedup claim and the task-status write, before any placeholder lookup begins.
   * Broken out so the processor leg RECONCILES - total_ms less guard, resolve and the model loop is
   * the finalize/update tail, and a residual that will not close is a measurement bug rather than a
   * shrug.
   */
  guardMs?: number;
  /**
   * What locating the placeholder cost: the mapping read plus the scan when one was needed.
   * Always present on a turn that ran the shared pipeline. A SUPERSET of pollMs.
   */
  placeholderResolveMs?: number;
  /**
   * The placeholder SCAN only, and ABSENT when no scan ran - never 0.
   *
   * Absence is the signal. A scan is rare and costs seconds, so a field holding 0 for the common
   * case would have a mean describing no turn at all; left absent, a COUNT of it is the fallback
   * rate and an AVG of it is what a fallback costs when it happens.
   */
  pollMs?: number;

  // Active task indicator (surfaced to frontend for UI status display)
  activeTask?: {
    type: string;
    status: string;
    label: string;
  };

  // Task state machine (SPEC-TASK-STATE-TRANSITIONS §6). Analytics-only (NOT in
  // FRONTEND_METADATA_KEYS): `taskState` is the machine state after this turn; `taskTransition` is
  // present only on turns that transitioned, so quality can be sliced by state, and transition
  // events (regression rate, time-in-state, terminal split) become countable.
  taskState?: string;
  taskTransition?: { from: string; to: string };
  /** The task's path so far against its machine (SPEC-EVALUATION Appendix C2). Analytics-only. */
  taskTrajectory?: TaskTrajectory;
  /** How the task ended when this turn ended it, from the runtime's pack-merged machines (`machineTerminalKind`). */
  taskTerminal?: TerminalKind;

  /**
   * The INPUT guardrail blocked this turn before the model was called; the reply text is the
   * guardrail's block copy, not an answer. STRUCTURAL, so consumers (battle analytics, e2e guards,
   * experiment reads) do not have to recognize deployment-specific blockedInputMessaging by shape -
   * the prefix test on the default English copy is exactly what a custom-copy guardrail defeats.
   */
  guardrailBlocked?: boolean;
  /**
   * WHICH GUARDRAIL POLICIES INTERVENED ON THIS TURN, as stable ids.
   *
   * `guardrail.<input|output>.<policy>.<label>` - the denied topic, content filter, word list, PII
   * entity or grounding check that fired. Enforced findings only: Bedrock reports detections it did
   * not act on, and a detection nobody blocked is not a breach.
   *
   * NEVER THE MATCHED TEXT. A word match or a PII entity is the content the guardrail exists to keep
   * out of the record, so the id names the filter and says nothing about what it saw.
   *
   * This is the deterministic half of the compliance verdict (DESIGN-EVALUATION, Pass C).
   * `guardrailBlocked` says a turn was stopped; this says by what, and covers the OUTPUT side that
   * boolean never reached.
   */
  guardrailFindings?: string[];

  // Bedrock resilience tracking
  wasFallback?: boolean;
  fallbackReason?: string;
  retryCount?: number;

  // A/B experiment tracking
  experimentId?: string;
  variantId?: string;

  // Config attribution. The deployment-config fingerprint that
  // produced this turn, so quality can be sliced by config (persona/pack/system-prompt), not just by
  // model. Computed by lib/config-identity.ts; absent on turns whose producer didn't supply it.
  configId?: string;
  personaVersion?: string;
  intentPackVersion?: string;
  systemPromptHash?: string;

  // Portable-profile attribution (SPEC-ASSISTANT-CONFIG §4): the assistant/profile + version that served
  // this turn, so analytics can slice by the EXACT assistant and version, not just its classification.
  profileName?: string;
  profileConfigId?: string;
  profileVersion?: number;

  // /battle tracking (SPEC-BATTLE.md §Analytics). assignmentMode is
  // top-level on purpose so variant rollups can filter battle traffic
  // before aggregating.
  assignmentMode?: AssignmentMode;
  battleContext?: AnalyticsBattleContext;
  /** WHICH DUEL this message belongs to. Flat so it can ride the slimmed frontend metadata that
   *  reaches the channel event; derived from battleContext so the two cannot disagree. */
  battleId?: string;
  /** WHICH ROUND of that duel: 1 is the answer, 2 the rebuttal. Without it a rebuttal and a
   *  round-1 reply are indistinguishable in the raw log. */
  battleRound?: number;

  /**
   * WHICH STEP OF THE ANSWER THIS MESSAGE IS. Declared by the producer, never inferred.
   *
   * Latency's outer bracket closes when the FINAL answer lands, and until this existed nothing in the
   * event said which update that was. Archival deduced it: an update carrying worker telemetry
   * (`total_ms`) must be the completion, first-such-update-wins. That proxy is correct only by
   * coincidence of the current flow - add any interim update that carries telemetry before the real
   * answer and it silently becomes "the answer", `COALESCE` freezes the wrong instant, `e2e_ms` reads
   * too fast, and nothing errors. A multi-step task is the shape that already breaks it, because its
   * real answer is the LAST update rather than the first.
   *
   * So the producer says so. A new intermediate update is then harmless by construction rather than
   * by nobody having added one yet.
   *
   * IT RIDES MESSAGE METADATA, and that is load-bearing rather than convenient. The out-of-band
   * analytics store has a 7-day TTL, never reaches S3, and is overwritten per MessageId, so a marker
   * there could not survive as evidence on a multi-update turn. Metadata reaches the S3 archive, which
   * is what makes "auditable against the stream" a fact rather than a claim.
   *
   * IT MUST NEVER BE SHED. It is ~18 encoded characters of the 1024 cap, and it is not analytics
   * detail - it is the field that decides whether a turn is closed at all. `METADATA_SHED_ORDER`
   * therefore does not list it, and a test asserts that it survives an overflowing blob.
   */
  respPhase?: ResponsePhase;

  /**
   * WHAT CAUSED THIS TURN: a person's message, or the platform driving one (a battle round 2, a
   * repair). Forwarded from `TurnRequest.trigger`.
   *
   * It is a MEASUREMENT field, not bookkeeping. "How long did this take" means something different
   * for the two - one is a person waiting and the other is not - so a ledger that cannot tell them
   * apart reports a repaired turn as one very slow answer. Absent ⇒ read as a user turn, which is
   * what every path did before this was forwarded.
   *
   * NAMED BY INTERACTION, not by dispatcher (`interaction-kinds.ts`). This was
   * `'user' | 'orchestrator'`, which named who sent the turn rather than what it was, and left a
   * welcome, a drift notice and a briefing declaring nothing at all - so they were read as user
   * turns, i.e. as turns a person was waiting for.
   */
  trigger?: InteractionKind;

  /**
   * WHEN THE THING THAT CAUSED THIS TURN HAPPENED, in epoch ms, declared by the producer that knows.
   *
   * The other half of `trigger`: a kind says which expectation applies, this says what to measure
   * from. Together they give a proactive turn a latency at all - previously only a user message
   * could anchor one, so everything else was structurally unmeasurable.
   *
   * OMITTED RATHER THAN GUESSED. A producer that cannot honestly supply this supplies nothing and
   * the metric stays NULL. Inventing one would report the fastest possible reaction for exactly the
   * turns least understood.
   */
  triggerAtMs?: number;

  /**
   * HOW THE TURN ENTERED: 'lex' when Amazon Chime SDK invoked the assistant's Amazon Lex bot, 'flow'
   * when the channel flow invoked the router directly, 'platform' when no message entered and the
   * platform started the turn (`turnEntryOf`). The paths have different work in front of the first
   * frame, so a latency figure that mixes them is not a figure about any of them.
   *
   * OMITTED RATHER THAN GUESSED, like the cause above. Absent means a producer that predates the
   * field; a default would be indistinguishable from a declaration and would bias the comparison the
   * column exists for.
   */
  entry?: TurnEntry;

  // Timestamp for analytics
  timestamp: string;
}

/**
 * Context needed to build analytics metadata
 */
export interface AnalyticsContext {
  messageNumber: number;
  /** See AnalyticsMetadata.classification - the conversation's classification, from its tag. */
  classification?: string;
  /** See AnalyticsMetadata.userClearance - the clearance in force when the turn ran. */
  userClearance?: string;
  role: 'user' | 'assistant';

  agentType?: AgentType;
  /**
   * WHICH ROLE the answering assistant holds in its classification (DESIGN-SEPARATE-ASSISTANTS 3.0).
   *
   * `primary` today, because one role is declared. It is recorded anyway so the dimension exists
   * BEFORE there is a second role to separate - a dimension added after the fact can only describe
   * traffic from the day it shipped, and the comparison an operator will want is across the change.
   *
   * Not the occupancy (live vs alt): an alt holds the same role, and the turn path cannot tell
   * which of the two answered, so it is not recorded rather than guessed.
   */
  assistantRole?: string;
  /**
   * THE CLASSIFICATION OF A RUNTIME ASSISTANT (ADR-048), stamped by the turn that resolved it from its own
   * assignment record. Archival runs where no record can be read, and the compiled registry does not know a
   * runtime name, so its boundary check reads this. One layer only: the vended session's
   * `classification` tag, which IAM evaluates, is the other. Absent for a deploy-time assistant.
   */
  runtimeClassification?: string;
  intent?: string;
  intentConfidence?: string;
  /**
   * What this turn's subject comparison decided (drift): the same subject as one the conversation has,
   * a new one, or not compared, with the nearest anchor's distance. Per turn, so the record shows when a
   * conversation's subject changed, and `general` or `off_topic` turns can be grouped by subject.
   */
  subjectDecision?: { decision: 'same' | 'new' | 'skipped'; distance?: number };
  /** See AnalyticsMetadata.taskResolution. */
  taskResolution?: 'reference' | 'id' | 'ranked';
  deliveryOption?: string;
  /** What KIND of interaction this turn is. See `AnalyticsMetadata.trigger`. */
  trigger?: InteractionKind;
  /** When the cause happened, epoch ms. See `AnalyticsMetadata.triggerAtMs`. */
  triggerAtMs?: number;
  /** How the turn entered. See `AnalyticsMetadata.entry`. */
  entry?: TurnEntry;

  bedrockResponse?: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  };

  /** Generation-out (image) turns: images produced this turn, so the Effectiveness
   *  cost path can price per-image (token counts are 0 on an image model). */
  imageCount?: number;

  totalMs?: number;
  routerMs?: number;
  classifierMs?: number;
  routerSteps?: { step: string; at: number }[];
  flowReceivedAt?: number;
  guardMs?: number;
  placeholderResolveMs?: number;
  pollMs?: number;

  activeTask?: {
    type: string;
    status: string;
    label: string;
  };

  taskState?: string;
  taskTransition?: { from: string; to: string };
  taskTrajectory?: TaskTrajectory;
  /** How the task ended when this turn ended it, from the runtime's pack-merged machines (`machineTerminalKind`). */
  taskTerminal?: TerminalKind;
  /** See AnalyticsMetadata.modelFrom (ADR-064 decision 4). */
  modelChoice?: { taskType?: string; taskMachine?: string; turnStep?: string; modelKind: 'text' | 'image'; modelFrom: string; imageEgress?: { provider: string; model: string; contextSourced: boolean } };

  /** See AnalyticsMetadata.guardrailFindings - which policies intervened, input and output. */
  guardrailFindings?: string[];
  /** See AnalyticsMetadata.guardrailBlocked - the INPUT guardrail blocked this turn (structural). */
  guardrailBlocked?: boolean;
  wasFallback?: boolean;
  fallbackReason?: string;
  retryCount?: number;
  experimentId?: string;
  variantId?: string;
  /** Config-attribution fingerprint (P4) from lib/config-identity.ts. */
  configIdentity?: {
    configId: string;
    personaVersion: string;
    intentPackVersion: string;
    systemPromptHash: string;
  };
  /** Portable-profile attribution (SPEC-ASSISTANT-CONFIG §4): the profile DEFINITION that served this turn
   *  and its VERSION, so a turn attributes to an exact artifact rather than to a name alone.
   *
   *  Distinct from `configIdentity`, which is a persona/intent-pack content hash. Distinct from `agentType`
   *  in SUBJECT rather than in grain: `agentType` names the ASSISTANT that answered and is what analytics groups
   *  by; `profileName` here names the DEFINITION it served. They are the same string on every ordinary turn
   *  and come apart on a cross-assistant experiment variant — a duel side serving a version of another
   *  assistant's profile — which is exactly the case this field exists to keep visible. `agentType` carried
   *  the classification until migration 055; it carries the assistant's name now. */
  profileAttribution?: { profileName: string; profileConfigId: string; profileVersion?: number };
  assignmentMode?: AssignmentMode;
  battleContext?: AnalyticsBattleContext;
}

/**
 * Build analytics metadata from context
 */
/**
 * The analytics-metadata keys the FRONTEND actually reads off a bot message's
 * Chime `Metadata` (see `chimeService.ts` + `MessagingProvider.tsx` parse paths).
 * Everything else in the blob is analytics-only and, once the out-of-band store
 * is available (Phase 1, SPEC-MESSAGE-METADATA-CODEBOOK.md), moves there instead
 * of riding the size-capped messaging metadata.
 *
 * Notably absent (analytics-only → out of band): inputTokens/outputTokens,
 * latencyMs/totalMs/pollMs, intentConfidence, deliveryOption, wasFallback/
 * fallbackReason/retryCount, configId/personaVersion/intentPackVersion/
 * systemPromptHash, messageNumber/timestamp/role, and battleContext
 * (the user-facing battle scorecard rides the Content marker, not Metadata).
 */
export const FRONTEND_METADATA_KEYS = [
  'bedrockModel',
  'intent',
  'experimentId',
  'variantId',
  'assignmentMode',
  // WHICH DUEL AND WHICH ROUND. Two short scalars, so the channel event can reconstruct a duel on
  // its own - the full battleContext stays out (both bot ARNs and the rival reply, against a ~1KB cap).
  'battleId',
  'battleRound',
  'activeTask',
  // imageCount rides the slim frontend Metadata too, so an image turn's per-image
  // cost survives Aurora-mode slimming (kept even if the out-of-band write fails open).
  'imageCount',
  // CLASSIFICATION RIDES BECAUSE THE S3 ARCHIVE PARTITIONS ON IT, which makes it not
  // analytics-only however it reads. The Firehose sets `user_type` from this key with a JQ
  // expression over the Chime Metadata, and Firehose cannot follow the out-of-band hop to
  // DynamoDB the way the archival Lambda can. Slimming it out sent every record to
  // `user_type=unknown` for the life of Aurora mode: the partition was unusable and the
  // Glue projection's enum matched nothing real. It is one short string, well inside the cap.
  // `a-partition-key-survives-the-slimming.test.ts` fails if it leaves this list again.
  'classification',
] as const;

/**
 * Project an analytics-metadata blob down to just the frontend-read keys, for
 * the slimmed Chime `Metadata`. Pure; the full blob still goes out of band.
 */
export function pickFrontendMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const key of FRONTEND_METADATA_KEYS) {
    if (metadata[key] !== undefined) slim[key] = metadata[key];
  }
  return slim;
}

export function buildAnalyticsMetadata(context: AnalyticsContext): AnalyticsMetadata {
  const metadata: AnalyticsMetadata = {
    messageNumber: context.messageNumber,
    role: context.role,
    timestamp: new Date().toISOString(),
  };

  if (context.classification) metadata.classification = context.classification;
  if (context.guardrailFindings?.length) metadata.guardrailFindings = context.guardrailFindings;
  if (context.userClearance) metadata.userClearance = context.userClearance;
  if (context.agentType) metadata.agentType = context.agentType;
  if (context.assistantRole) metadata.assistantRole = context.assistantRole;
  if (context.runtimeClassification) metadata.runtimeClassification = context.runtimeClassification;
  if (context.intent) metadata.intent = context.intent;
  if (context.intentConfidence) metadata.intentConfidence = context.intentConfidence;
  if (context.subjectDecision) metadata.subjectDecision = context.subjectDecision;
  if (context.taskResolution) metadata.taskResolution = context.taskResolution;
  if (context.deliveryOption) metadata.deliveryOption = context.deliveryOption;
  // Copied through, never derived here: the router declares what caused the turn and this is a
  // carrier. A default invented at this layer would be indistinguishable from a declaration.
  if (context.trigger) metadata.trigger = context.trigger;
  // The cause INSTANT rides beside the cause. Copied through like the kind - this layer is a carrier,
  // and a default invented here would be indistinguishable from a producer declaration.
  if (context.triggerAtMs !== undefined) metadata.triggerAtMs = context.triggerAtMs;
  // The ENTRY rides beside them, and for the same reason: this layer carries what a producer declared
  // and invents nothing, because an invented entry is exactly the bias the dimension exists to remove.
  if (context.entry) metadata.entry = context.entry;

  if (context.bedrockResponse) {
    metadata.bedrockModel = context.bedrockResponse.model;
    metadata.inputTokens = context.bedrockResponse.inputTokens;
    metadata.outputTokens = context.bedrockResponse.outputTokens;
    metadata.latencyMs = context.bedrockResponse.latencyMs;
  }

  // Image (generation-out) turns: persist the image count so per-image cost is
  // priceable at query time (the model reports 0 tokens).
  if (context.imageCount !== undefined) metadata.imageCount = context.imageCount;

  if (context.totalMs !== undefined) metadata.totalMs = context.totalMs;
  if (context.routerMs !== undefined) metadata.routerMs = context.routerMs;
  if (context.classifierMs !== undefined) metadata.classifierMs = context.classifierMs;
  // Length-checked rather than presence-checked: an empty log is a turn that recorded no boundary,
  // and writing `[]` would put a row in the ledger's way that says nothing.
  if (context.routerSteps?.length) metadata.routerSteps = context.routerSteps;
  if (context.flowReceivedAt !== undefined) metadata.flowReceivedAt = context.flowReceivedAt;
  if (context.guardMs !== undefined) metadata.guardMs = context.guardMs;
  if (context.placeholderResolveMs !== undefined) metadata.placeholderResolveMs = context.placeholderResolveMs;
  if (context.pollMs !== undefined) metadata.pollMs = context.pollMs;

  if (context.activeTask) {
    metadata.activeTask = context.activeTask;
  }

  if (context.taskState) metadata.taskState = context.taskState;
  if (context.taskTransition) metadata.taskTransition = context.taskTransition;
  if (context.taskTrajectory) metadata.taskTrajectory = context.taskTrajectory;
  if (context.taskTerminal) metadata.taskTerminal = context.taskTerminal;
  if (context.modelChoice) {
    if (context.modelChoice.taskType) metadata.taskType = context.modelChoice.taskType;
    if (context.modelChoice.taskMachine) metadata.taskMachine = context.modelChoice.taskMachine;
    if (context.modelChoice.turnStep) metadata.turnStep = context.modelChoice.turnStep;
    metadata.modelKind = context.modelChoice.modelKind;
    metadata.modelFrom = context.modelChoice.modelFrom;
    if (context.modelChoice.imageEgress) metadata.imageEgress = context.modelChoice.imageEgress;
  }

  if (context.guardrailBlocked) metadata.guardrailBlocked = true;
  if (context.wasFallback !== undefined) metadata.wasFallback = context.wasFallback;
  if (context.fallbackReason) metadata.fallbackReason = context.fallbackReason;
  if (context.retryCount !== undefined) metadata.retryCount = context.retryCount;
  if (context.experimentId) metadata.experimentId = context.experimentId;
  if (context.variantId) metadata.variantId = context.variantId;

  // Config attribution (P4) — stamp the fingerprint so this turn is sliceable by config.
  if (context.configIdentity) {
    metadata.configId = context.configIdentity.configId;
    metadata.personaVersion = context.configIdentity.personaVersion;
    metadata.intentPackVersion = context.configIdentity.intentPackVersion;
    metadata.systemPromptHash = context.configIdentity.systemPromptHash;
  }

  // Portable-profile attribution — stamp the assistant/profile + version that served the turn, so analytics
  // attributes to the exact profile version (not just its classification / persona-pack hash).
  if (context.profileAttribution) {
    metadata.profileName = context.profileAttribution.profileName;
    metadata.profileConfigId = context.profileAttribution.profileConfigId;
    if (context.profileAttribution.profileVersion !== undefined) metadata.profileVersion = context.profileAttribution.profileVersion;
  }

  // /battle: a battleContext implies the model was chosen by fan-out,
  // so assignmentMode is forced to 'battle' regardless of what the
  // caller passed — this is the rollup-safety invariant from the spec
  // (battle traffic must never be miscounted as probabilistic).
  if (context.battleContext) {
    metadata.battleContext = context.battleContext;
    metadata.assignmentMode = 'battle';
    // ── WHICH DUEL, AND WHICH ROUND, AS TWO FLAT SCALARS ──────────────────────────────────────
    //
    // DERIVED HERE FROM `battleContext` rather than passed separately, so the two can never
    // disagree with the context they describe.
    //
    // WHY THEY ARE FLAT AND NOT JUST `battleContext`. The nested object is deliberately NOT in
    // `FRONTEND_METADATA_KEYS` - it carries both bot ARNs and the rival's reply, and the Metadata
    // has a ~1KB cap. These two are short, so they can ride the slimmed set that reaches the
    // channel event while the full context stays out of it.
    //
    // THE DEFECT THIS FIXES (`conv-1789948530750-b1475e52217c`). Both rounds of
    // that duel ran and the rebuttal is plainly there in the log - and nothing in the event said so.
    // The round was recoverable only from a `<!--battleround:N-->` marker in the content, which is
    // STRIPPED before the events log returns it, so the admin raw log could not tell a rebuttal from
    // a round-1 reply or group a duel at all. Aurora had the column because `kinesis-archival` reads
    // the raw record before stripping; the log read what was left. One fact, two sources, and only
    // one of them had it (tenet D7). Now the event carries it itself.
    metadata.battleId = context.battleContext.battleId;
    metadata.battleRound = context.battleContext.round;
  } else if (context.assignmentMode) {
    metadata.assignmentMode = context.assignmentMode;
  }

  return metadata;
}
