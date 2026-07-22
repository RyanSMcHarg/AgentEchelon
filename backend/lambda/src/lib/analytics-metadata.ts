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

export type AgentType = 'basic' | 'standard' | 'premium';

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
 *  a fixed vocabulary so tool-error rate is queryable without persisting any tool input/output/PII. */
export type ToolErrorClass = 'timeout' | 'not_found' | 'unauthorized' | 'bad_input' | 'error';

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
  chosenByUserSub: string;
  chosenAt: string; // ISO
  // Config attribution — the config fingerprints of the two sides
  // that fought (A = control, B = treatment), so a pick is attributable to the configs, not just the
  // variant aliases. Absent when the producing path didn't resolve them (older rows, fail-open).
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
 * Map a tool error payload to a bounded ToolErrorClass (P2). Heuristic over the error MESSAGE only,
 * and only the CLASS is retained — the raw text is never persisted. Unknown shapes fall to 'error'.
 */
export function classifyToolError(message: unknown): ToolErrorClass {
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
 * Analytics metadata attached to each message
 */
export interface AnalyticsMetadata {
  // Message context
  messageNumber: number;
  userType: string;
  role: 'user' | 'assistant';

  // Agent and intent classification
  agentType?: AgentType;
  intent?: string;
  intentConfidence?: string;
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

  // Timestamp for analytics
  timestamp: string;
}

/**
 * Context needed to build analytics metadata
 */
export interface AnalyticsContext {
  messageNumber: number;
  userType: string;
  role: 'user' | 'assistant';

  agentType?: AgentType;
  intent?: string;
  intentConfidence?: string;
  deliveryOption?: string;

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
  pollMs?: number;

  activeTask?: {
    type: string;
    status: string;
    label: string;
  };

  taskState?: string;
  taskTransition?: { from: string; to: string };

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
  /** Portable-profile attribution (SPEC-ASSISTANT-CONFIG §4): the ASSISTANT/PROFILE that answered this turn
   *  and its VERSION. Distinct from `configIdentity` (a persona/intent-pack hash) and from `agentType` (the
   *  classification/tier) — so a turn attributes to the EXACT profile version, not just its tier. This is
   *  what makes analytics per-assistant + per-version once multiple assistants serve one classification. */
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
 * systemPromptHash, messageNumber/timestamp/role/userType, and battleContext
 * (the user-facing battle scorecard rides the Content marker, not Metadata).
 */
export const FRONTEND_METADATA_KEYS = [
  'bedrockModel',
  'intent',
  'experimentId',
  'variantId',
  'assignmentMode',
  'activeTask',
  // imageCount rides the slim frontend Metadata too, so an image turn's per-image
  // cost survives Aurora-mode slimming (kept even if the out-of-band write fails open).
  'imageCount',
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
    userType: context.userType,
    role: context.role,
    timestamp: new Date().toISOString(),
  };

  if (context.agentType) metadata.agentType = context.agentType;
  if (context.intent) metadata.intent = context.intent;
  if (context.intentConfidence) metadata.intentConfidence = context.intentConfidence;
  if (context.deliveryOption) metadata.deliveryOption = context.deliveryOption;

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
  if (context.pollMs !== undefined) metadata.pollMs = context.pollMs;

  if (context.activeTask) {
    metadata.activeTask = context.activeTask;
  }

  if (context.taskState) metadata.taskState = context.taskState;
  if (context.taskTransition) metadata.taskTransition = context.taskTransition;

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
  } else if (context.assignmentMode) {
    metadata.assignmentMode = context.assignmentMode;
  }

  return metadata;
}
