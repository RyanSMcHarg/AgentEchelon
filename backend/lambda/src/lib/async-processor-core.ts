/**
 * Async Processor Core
 *
 * Shared utilities for the classification-specific async processors
 * (basic, standard, premium). Extracts common pipeline steps:
 * - Placeholder polling
 * - Channel history loading
 * - Bedrock invocation
 * - Long response handling (multi-message split)
 * - Message updates with analytics metadata
 * - Error handling
 *
 * Each classification-specific processor imports these functions and
 * composes them with its own system prompt, model config, and
 * classification-specific post-processing.
 */

import { stripMessageMarkers, stripGuardrailMaskTokens } from './message-markers.js';
import {
  ChimeSDKMessagingClient,
  ListChannelMessagesCommand,
  GetChannelMessageCommand,
  UpdateChannelMessageCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ApplyGuardrailCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { buildAnalyticsMetadata, pickFrontendMetadata, makeConverseStep, classifyToolError, type ConverseStep, type ToolStepOutcome, type ResponsePhase } from './analytics-metadata.js';
import { writeMessageAnalytics, messageAnalyticsEnabled } from './message-analytics.js';
import { estimateStepCostUsd } from './model-rate-table.js';
import {
  needsAttribution,
  renderContribution,
  safeSpeakerName,
  speakerIdFrom,
  speakerKindFor,
  stripAttribution,
  type Speaker,
} from './transcript-attribution.js';
// Type-only: the event carries a resolved profile VERSION for a profileRef variant (SPEC-PORTABLE §6).
// Erased at compile, so it introduces no module cycle with active-profile.
import type { ProfileDefinition } from './active-profile.js';
import { loadCompanyContext, loadPlatformInfo, loadContextDigest, buildDigestHint } from './company-context.js';
import {
  CORPORATE_TRAVEL_TOOL_SPEC,
  searchCorporateTravel,
  isTravelToolEnabled,
  type TravelSearchArgs,
} from './corporate-travel-tool.js';
import {
  imageGenModelIdToKey,
  IMAGE_GEN_MODELS,
  type ImageGenModelKey,
} from './image-gen-models.js';
import { updateTaskStatus, getTask, recordNoTransitionTurn, shouldMarkTaskCompleted, resolveTaskOwner, TASK_STATE_MACHINES, type TaskStatus, type Task } from './task-tracking.js';
import {
  ADVANCE_TASK_STATE_TOOL_NAME,
  taskToolSpecsFor,
  handleAdvanceTaskStateTool,
  advancePlaceItemOnProposal,
  type TaskLoopContext,
} from './task-tools.js';
import { taskStateMachines } from './intent-pack.js';
import { stateNamesOf, type TaskStateMachine } from './task-state-machines.js';
import { claimCorrelation, capUserMessage, readPlaceholderMapping } from './abuse-controls.js';
import { resolvePlaceholderTarget } from './placeholder-target.js';
import { planResumedChainDelivery, RESUMED_CHAIN_ACKNOWLEDGEMENT } from './resumed-chain-delivery.js';
import { matchAssigneeInRoster, buildAssignmentNotice } from './task-notify.js';
import type { RosterParticipant } from './channel-notify.js';
import {
  transitionBotState,
  markBotWaitingForUser,
  readBattleRows,
  allBotsTerminal,
  getBotRow,
  computeActiveResponseMs,
} from './battle-state.js';
import {
  resolveVisionBattleAction,
  visionRejectMessage,
  type VisionBattleAction,
} from './model-resolver.js';
import { bedrockModelIdToKey } from './model-rate-table.js';
import {
  getModelCatalog,
  type BackendModelKey,
} from '../../../lib/config/model-strategy.js';
import { clearBattleWaitingMarker } from './battle-waiting-marker.js';
import { extractAttachment } from './battle-attachment.js';
import { fetchAttachmentBytes, type S3GetClient } from './attachment-bytes.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
// Chime SDK Messaging hard limits apply to the request parameter length
// (the URL-encoded Content string sent via encodeURIComponent), not the
// raw char count. Markdown/prose roughly doubles when encoded, which is
// why a 4641-char answer split into 5 raw chunks still threw
// BadRequestException Channel Messages size limit exceeded. Content max
// 4096, Metadata max 1024 (encoded). CHIME_CONTENT_SAFE is the working
// budget under the cap; CHUNK0_MARKER_HEADROOM reserves room for the
// battlestats/ACTIVE_TASK marker finalize appends to chunk[0] after split.
const CHIME_CONTENT_MAX = 4096;
export const CHIME_METADATA_MAX = 1024;
const CHIME_CONTENT_SAFE = 3600;
const CHUNK0_MARKER_HEADROOM = 700;

function encodedLen(s: string): number {
  return encodeURIComponent(s).length;
}

// A prefix cut must never fall BETWEEN a UTF-16 surrogate pair (an astral-plane
// char - emoji, math alphanumerics, some CJK extensions - is two code units).
// Slicing there yields a lone surrogate, and encodeURIComponent (used to measure
// and to send the Chime wire Content) throws `URIError: URI malformed` on a lone
// surrogate, which crashed the whole processor on any long reply containing an
// emoji. Snap such an index back by one so the high surrogate stays with its low
// half in the following chunk. ASCII boundaries (space/newline/period) can never
// sit inside a pair, so natural-boundary cuts are already safe.
function surrogateSafeCut(text: string, idx: number): number {
  if (idx <= 0 || idx >= text.length) return idx;
  const hi = text.charCodeAt(idx - 1);
  const lo = text.charCodeAt(idx);
  if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) {
    return idx - 1;
  }
  return idx;
}

// ============================================================
// Bedrock prompt caching (system-prompt prefix)
// ============================================================
//
// The classification processors build `systemPrompt` as a STABLE base (persona +
// standing policy from buildSystemPrompt/BASE_SYSTEM_PROMPT) followed by
// DYNAMIC per-turn appends (retrieved-context hint, conversation summary,
// task hints, the "do NOT repeat" priorAgent note, and — inside
// invokeBedrock — the company-context digest). We insert a Bedrock
// `cachePoint` at the boundary so the stable prefix is billed/processed
// once and reused across tool-loop iterations AND turns. See
// docs/GUIDE-ASSISTANT-CONTEXT.md.

// Minimum stable-prefix size before we bother inserting a cachePoint.
// Bedrock's minimum cacheable prefix for Claude is ~1024 tokens; 4000 chars
// is a conservative floor (~1 token per 4 chars) so we never emit a
// cachePoint the model will reject/ignore.
export const PROMPT_CACHE_MIN_PREFIX_CHARS = 4000;

/**
 * Whether the given Bedrock model supports Converse prompt caching. True for
 * Anthropic Claude 3.5+ / 4.x (and 5.x) families; false for Titan, Claude-3
 * Haiku, and external LLMs.
 */
export function modelSupportsPromptCaching(modelId: string): boolean {
  return /claude-3-5|claude-3\.5|claude-opus-4|claude-sonnet-4|claude-haiku-4|claude-sonnet-5|claude-fable-5/i.test(
    modelId,
  );
}

/**
 * Split a system prompt into Converse `system` blocks, inserting a cachePoint
 * after the stable prefix when it is worth caching. Returns a single text
 * block (no cachePoint) when caching does not apply — a too-short prefix, an
 * unset/out-of-range prefix length, or a model that does not support caching.
 */
export function buildSystemBlocks(
  systemPrompt: string,
  cacheablePrefixLength: number | undefined,
  modelId: string,
): Array<{ text?: string; cachePoint?: { type: 'default' } }> {
  if (
    cacheablePrefixLength !== undefined &&
    cacheablePrefixLength >= PROMPT_CACHE_MIN_PREFIX_CHARS &&
    cacheablePrefixLength < systemPrompt.length &&
    modelSupportsPromptCaching(modelId)
  ) {
    return [
      { text: systemPrompt.slice(0, cacheablePrefixLength) },
      { cachePoint: { type: 'default' } },
      { text: systemPrompt.slice(cacheablePrefixLength) },
    ];
  }
  return [{ text: systemPrompt }];
}

// Chime Metadata is capped at 1024 (encoded). The per-message analytics blob
// can exceed that on a heavy turn (e.g. premium experiment + config identity +
// an active task). This SAME Metadata is the single source for BOTH the
// frontend (modelId/intent/feedback + the experiment thumbs-join keys) AND the
// Aurora archival pipeline (kinesis-archival.ts reads Payload.Metadata for
// tokens/intent/experimentId) — there is no separate analytics emission. So
// dropping the whole blob loses everything for both consumers.
//
// Instead we degrade gracefully: shed lower-priority keys (bulky / UX-only /
// secondary-analytics) one at a time until it fits, PRESERVING the small,
// high-value keys both consumers depend on (experiment join + core analytics +
// model/intent). Only if even the preserved core won't fit (effectively
// impossible) do we drop entirely. The battle scorecard + variant name ride
// the Content battlestats marker, not Metadata, so they are unaffected either way.
//
// Shed order: first-listed dropped first. Everything NOT in this list is
// always kept (the must-survive core).
// A GROUPING KEY SHEDS LAST, AND THAT IS THE ORDERING PRINCIPLE HERE.
//
// Losing an ordinary field costs that field. Losing a field the analytics GROUP BY reads costs the
// whole row: it stops being attributable and lands in an `unknown` bucket, taking its latency and its
// counts with it. `deliveryOption` is exactly that - it is a grouping key in `latency_metrics`, and a
// row without one is indistinguishable from a row the fallback pairer reconstructed. Shedding it to
// save a step metric would manufacture the very population the TTFF partition exists to hold out.
//
// So the step-latency diagnostics go FIRST. They are per-turn detail, individually recoverable from
// the next turn, and worth nothing if the row they describe cannot be attributed to a variant.
const METADATA_SHED_ORDER: readonly string[] = [
  // Step-latency diagnostics — the most droppable thing here. One turn's missing breakdown is a gap
  // in a distribution; a missing grouping key is a mis-attributed row.
  'routerMs', 'classifierMs', 'guardMs', 'placeholderResolveMs', 'pollMs',
  // Secondary analytics / config attribution — useful but reconstructable / low-value per-message.
  'systemPromptHash', 'intentPackVersion', 'personaVersion', 'configId',
  'fallbackReason', 'retryCount', 'wasFallback', 'intentConfidence',
  // LAST of the secondary group: see the grouping-key note above.
  'deliveryOption',
  // Bulky / UX-degrading-but-not-data-losing (battle metadata is droppable by
  // existing design; activeTask/attachment/targetedSender degrade UI, not the join).
  'battleContext', 'activeTask', 'attachment', 'targetedSender',
];

export function safeMetadataString(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  let json = JSON.stringify(metadata);
  if (encodedLen(json) <= CHIME_METADATA_MAX) return json;

  const shed = { ...metadata };
  const dropped: string[] = [];
  for (const key of METADATA_SHED_ORDER) {
    if (encodedLen(json) <= CHIME_METADATA_MAX) break;
    if (key in shed) {
      delete shed[key];
      dropped.push(key);
      json = JSON.stringify(shed);
    }
  }
  if (encodedLen(json) <= CHIME_METADATA_MAX) {
    console.warn(
      '[AsyncProcessor] message Metadata over ' + CHIME_METADATA_MAX +
        ' encoded chars - shed [' + dropped.join(', ') + '] to fit; ' +
        'experiment join + core analytics preserved',
    );
    return json;
  }
  console.warn(
    '[AsyncProcessor] message Metadata still over ' + CHIME_METADATA_MAX +
      ' after shedding [' + dropped.join(', ') + '] - dropping it for this message ' +
      '(Content + battle markers unaffected)',
  );
  return undefined;
}

// Shared SDK clients — instantiated once per Lambda cold start
export const messagingClient = new ChimeSDKMessagingClient({ region: AWS_REGION });
export const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

// Re-export for processors
export { updateTaskStatus };
export { buildAnalyticsMetadata };

// ============================================================
// Types
// ============================================================

export interface BattleContextPayload {
  battleId: string;
  round: 1 | 2;
  totalRounds: 2;
  selfBotArn: string;
  rivalBotArn: string;
  /** Round-1: undefined. Round-2: the rival bot's round-1 reply text. */
  rivalReply?: string;
  /** Round-2: the rival bot's round-1 message id. Referenced (never quoted) in the prompt. */
  rivalReplyMsgId?: string;
  /** Originating /battle user message id — referenced in round-1 prompts. */
  originatingMessageId?: string;
  /**
   * A RESUME only: the message holding this side's clarifying question, whose `<!--battlewaiting-->`
   * marker this turn clears (ADR-029). Never a placeholder id - this turn answers on its own
   * placeholder, like every other turn - so it is deliberately not called one.
   */
  clearWaitingMarkerMessageId?: string;
  /**
   * Phase-3 vision-in: the image attachment on the `/battle` turn (from
   * the user message Metadata's `attachment`). Present only when the
   * triggering message carried an image. Each variant decides via
   * resolveVisionBattleAction whether to send a Converse image block
   * (vision-capable model) or reply with visionRejectMessage (text-only).
   */
  imageAttachment?: {
    fileKey: string;
    contentType: string;
  };
  /**
   * Phase-4 generation-out: the Bedrock image-gen model id this variant
   * generates with (`amazon.titan-image-generator-v2:0` /
   * `amazon.nova-canvas-v1:0`). Present only on a generation-out battle
   * — set per-variant by the fan-out (locked decision #1: Titan v2 vs
   * Nova Canvas is a head-to-head, not a fallback pair). The processor
   * resolves it via `resolveBattleGenerationOutPlan`; an absent/unknown
   * id falls through to a normal text battle (honest, never fabricated).
   * Mutually exclusive with `imageAttachment` (gen-out has no input
   * image): the generation branch is evaluated first.
   */
  imageGenModelId?: string;
  /**
   * Phase-1 resolve-once fields (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "Battle
   * delegates to the normal engine"). The fan-out resolves THIS side's
   * experiment variant exactly once and stamps it here, so the worker runs a
   * normal request for the variant with no second resolution (this removes the
   * two-Lambda divergence the redesign was triggered by). All optional: when a
   * field is unset the worker keeps its normal classification+intent
   * resolution.
   *   - variantModelKey: the resolved model override (a profileRef variant is
   *     already resolved to its modelKey upstream).
   *   - variantAddendum: the variant's persona addendum, layered as NORMAL
   *     persona (not a battle constraint).
   *   - selfDisplayName: this variant's name (drives the scorecard).
   *   - rivalDisplayName: the rival variant's name (woven into the round-2
   *     rebuttal note).
   */
  variantModelKey?: string;
  variantAddendum?: string;
  selfDisplayName?: string;
  rivalDisplayName?: string;
  /**
   * Phase-2 (image generation as a normal capability): this side's IMAGE-generation model key
   * (an `ImageGenModelKey`), stamped by the fan-out from the experiment variant's `imageGenModelKey`.
   * The worker maps it to a Bedrock image-gen id (IMAGE_GEN_MODELS) and PREFERS it over the profile's
   * own `models.image` — so an image battle compares the two variants' image models. Unset ⇒ the worker
   * falls back to the legacy `imageGenModelId` path, then to the profile image model. Because a battle
   * turn now runs the normal image path, there is no battle-specific image branch to keep in sync.
   */
  variantImageModelKey?: string;
}

export interface AsyncProcessorEvent {
  channelArn: string;
  correlationId: string;
  userMessage: string;
  userName?: string;
  /**
   * The sender's resolved display name, forwarded by the router (Cognito, cached). Used ONLY for the
   * first-turn greeting (see firstTurnGreetingDirective); distinct from `userName`, which is a
   * host-stamped metadata field carrying a "do not address by name in normal replies" instruction.
   */
  senderDisplayName?: string;
  userType: 'basic' | 'standard' | 'premium';
  /**
   * Attachment-in (image OR document) on the current turn, from the triggering message
   * Metadata's `attachment`. The standard processor fetches it and attaches a Converse
   * image/document block. Populated on the direct-invoke paths (@all); the Lex path does
   * not carry it.
   */
  attachment?: {
    fileKey: string;
    contentType?: string;
    name?: string;
  };
  taskId?: string;
  taskType?: string;
  /**
   * The router CREATED this task on this turn (as opposed to resuming an active one). This is the
   * task's OPEN edge, declared by the one component that knows it happened: without it the analytics
   * record never carries a from-less transition, `turn_events` never gets a `task_opened` row, and
   * `v_task_resolution.opened_at` is NULL for every task - the row-104 unit tests synthesized the
   * from-less edge that no producer emitted, and the e2e against a live deployment is what caught it.
   */
  taskCreated?: boolean;
  botArn: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  senderArn?: string;
  // NOTE: a reply's visibility is NOT passed in. `handleLongResponse` reads the
  // placeholder message's actual `Target` (what Chime set based on whether the
  // inbound was targeted) and mirrors it onto the continuation chunks. The
  // caller cannot know the inbound's target (Chime does not surface it to Lex),
  // so any caller-supplied target would be a guess - which is exactly the UF-2
  // over-targeting bug. The placeholder is the ground truth.

  /**
   * Domain grounding. Forwarded by
   * router-agent-handler from the channel's Metadata. `domainContext` = the current plan
   * (primary grounding — title + work items); `otherContexts` = the user's other plans/contexts
   * (title/slug only) for disambiguation. Rendered into the system prompt via
   * `formatDomainContextForPrompt`. Absent on non-plan turns ⇒ no injection.
   */
  domainContext?: unknown;
  otherContexts?: unknown;
  /** Participant roster — owner + shared members for a SHARED
   *  plan, so the assistant is multi-participant aware + can assign work items. A per-session snapshot of
   *  the plan's access list, NOT authoritative. Absent for solo plans. */
  participants?: unknown;
  /** Host i18n: the user's chosen site language (e.g. "en"/"zh"); the assistant replies in it. */
  userLanguage?: string;
  /** Free-text participant profile (the user's stated preferences/working style) — personalizes replies. */
  participantProfile?: string;
  /**
   * WHAT CAUSED THIS TURN (`TurnRequest.trigger`), forwarded by the router.
   *
   * 'user' is a person's message; 'orchestrator' is the platform driving a turn - a battle round 2, a
   * repair. It rides the analytics record so the latency ledger can record it, because "how long did
   * this take" means something different for the two: one is a person waiting, the other is not.
   * Absent ⇒ treated as a user turn, which is what every path did before this existed.
   */
  trigger?: 'user' | 'orchestrator';
  /** Geography routing signal (SPEC-CONTEXT-AWARE-MODEL-ROUTING) — the geo segment for this turn;
   *  `segment.country === 'CN'` routes to the Chinese model + reply. Absent ⇒ today's routing. */
  segment?: { country?: string; region?: string; lat?: number; lng?: number };

  // Multi-turn task continuation
  isTaskContinuation?: boolean;

  // /battle resume: update THIS existing placeholder instead of polling
  // for a fresh one by correlationId. Set by the continuation router so
  // a resumed bot reuses its "waiting" message (no orphan; the cleared
  // battlewaiting marker is the frontend's "waiting ended" signal).
  placeholderMessageId?: string;
  /**
   * This turn resumed a chain an assistant was holding, so deliver it as the NORMALIZED PAIR: the
   * answer UNTARGETED, the acknowledgement TARGETED at the person who spoke (owner, 2026-08-14).
   *
   * Set when the turn resumes a chain this assistant owns (`resumedOwnChain` in the handler). Which of
   * the two the placeholder already is depends on how the person's message arrived - Amazon Chime SDK
   * gives a Lex reply the inbound's targeting - so the processor reads the placeholder's real `Target`
   * and posts whichever message is missing. It does NOT mean "post a second message": on an untargeted
   * inbound the placeholder is already the public answer, and it is the receipt that gets one.
   *
   * A duel is a comparison and its answers have to be public to be one; a task step's result belongs to
   * the conversation for the same reason. Continuation chunks follow the message the answer is in, so a
   * long answer does not end up half public.
   */
  broadcastAnswer?: boolean;
  /**
   * Somebody else already gave the person their receipt, so this turn owes only the answer.
   *
   * The handover case (rule 3): the assistant the person ADDRESSED does not own the chain, so it
   * acknowledges with copy of its own - saying the message was passed to the assistant whose work it is
   * - and hands the turn over. The owning assistant then answers. Without this the person gets two
   * receipts for one message, the second of them contradicting the first about who is acting.
   *
   * Only meaningful alongside `broadcastAnswer`: the answer is still untargeted, it is the receipt that
   * is already spoken for.
   */
  suppressAcknowledgement?: boolean;
  /**
   * Text to KEEP above the answer when this turn's placeholder is a real message rather than a
   * throwaway "One moment...".
   *
   * The welcome path is the case that needs it. A drift-spawned conversation quotes the question that
   * started it ("You asked: > …") and then answered nothing, so the person had to retype it. The
   * welcome now IS the placeholder — it carries the `<!--corr:-->` marker and this processor resolves
   * and updates it — but a plain update REPLACES content, which would throw the orientation copy away
   * (company, access line, example prompts) to show the answer. Prepending keeps both: the welcome
   * stays, the answer arrives underneath it.
   *
   * Absent on every ordinary turn, where the placeholder is disposable and replacing it is correct.
   */
  messagePrefix?: string;

  // Intent classification (passed from agent handler for analytics)
  intent?: string;
  intentConfidence?: string;
  /**
   * What the intent classification cost, in ms, as measured by the ROUTER.
   *
   * Carried on the dispatch rather than re-derived because the classifier runs before the
   * placeholder is minted and the processor never sees it. ABSENT on the pre-LLM fast paths and on
   * an orchestrator-dispatched rebuttal, neither of which asks a model for a label - so a null here
   * means "no classification was bought", not "not measured".
   */
  classifierMs?: number;
  /**
   * The ROUTER leg: its handler entry to the moment it handed this turn off, on one clock.
   *
   * The span that sits in front of the placeholder and is therefore inside TTFF. Distinct from
   * exchanges.inbound_ms, which is cross-clock and spans the channel flow, Lex AND this handler as a
   * single figure - useful as a bound, useless for deciding which of them to fix. classifierMs is a
   * SUB-STEP of this, not a sibling.
   */
  routerMs?: number;
  deliveryOption?: string;

  // Per-intent response shaping. Forwarded by the router from the
  // intent pack; the processor clamps `maxTokens` to the classification ceiling + reasoning floor. Absent ⇒
  // the processor's default budget.
  responseSettings?: { maxTokens?: number; verbosity?: 'tight' | 'normal' | 'long' };

  // P4 config attribution. The handler has the intent pack, so it forwards the pack's version (short
  // hash of the raw pack JSON, or 'default'); the processor combines it with the persona it resolves
  // into a `configId`. Absent ⇒ the processor treats the pack as 'default'.
  intentPackVersion?: string;

  // Intent-based model override (resolved by model-resolver or experiment-manager)
  resolvedModel?: string;
  fallbackModel?: string;

  // The resolved experiment variant's IMAGE model (ImageGenModelKey), when an image_generation
  // experiment binds this turn. Serves the variant's image model in the NORMAL (non-battle) flow,
  // parallel to `resolvedModel` for text. Absent ⇒ the profile's models.image is used.
  resolvedImageModelKey?: string;

  // A/B experiment tracking
  experimentId?: string;
  variantId?: string;

  /**
   * The assigned variant's FULL profile version, for a `profileRef` variant (SPEC-PORTABLE §6).
   *
   * A variant is not a model. `resolvedModel` alone cannot express the experiment §6 exists for — two
   * versions differing ONLY in `tools`, or in persona, or in classifier mode — because both sides would
   * resolve to the same model and the comparison would report no difference for a reason that has
   * nothing to do with what was varied. Resolved ONCE by the router (or the battle fan-out) and stamped
   * here, so the worker performs no second resolution.
   *
   * Absent ⇒ the worker resolves the profile's own ACTIVE version exactly as before. Serving this never
   * touches the warm-container profile cache (which is keyed by profile NAME), or the next ordinary turn
   * on the same container would inherit the variant's persona and tools.
   */
  variantProfile?: ProfileDefinition;

  // /battle invocation (SPEC-BATTLE.md). When set, this invocation
  // is part of an /battle fan-out — the system prompt is augmented with
  // battle-mode constraints, the variant config may override the model,
  // and the final state is recorded in BattleStateTable so the
  // orchestrator can fire round-2 once all bots are terminal.
  battleContext?: BattleContextPayload;

  /**
   * RAG retrieved context (ADR-001 + ADR-002).
   * Populated by router-agent-handler.ts (the VPC-attached Lambda with
   * Aurora access) when Aurora mode is enabled. The async processors
   * are NOT VPC-attached, so retrieval happens at the router and the
   * result is forwarded here. Async processors call
   * `buildRetrievedContextHint(retrievedContext)` to fold the chunks +
   * citations into the system prompt. Absent ⇒ no RAG injection.
   */
  retrievedContext?: {
    chunks: Array<{
      sourceId: string;
      sourceType: string;
      title: string | null;
      chunkIndex: number | null;
      content: string;
      similarity: number;
    }>;
    citations: Array<{
      index: number;
      sourceId: string;
      title: string | null;
      similarity: number;
    }>;
    signalAvailable: boolean;
  };
  /**
   * Running conversation summary (ADR-017: summary as consumable context). The
   * router fetches it from the data-plane for long conversations and attaches it
   * here; the async processor folds it into the system prompt via
   * `buildConversationSummaryHint`. Absent ⇒ short conversation, no injection.
   */
  conversationSummary?: string;
}

export interface AsyncProcessorResult {
  success: boolean;
  response?: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  latencyMs?: number;
  error?: string;
}

export interface AsyncProcessorConfig {
  model: string;
  maxTokens: number;
  temperature?: number;
  userType: 'basic' | 'standard' | 'premium';
  /** Per-profile tool ALLOWLIST (the active version's `tools`). Gates WHICH registered tools this
   *  assistant may use, intersected with each tool's runtime availability. `undefined` ⇒ all available
   *  tools (legacy/unset — byte-identical to the pre-allowlist behavior). SPEC-ASSISTANT-CONFIG §4. */
  tools?: string[];
  /** Skip the INPUT guardrail for this turn. Set only for orchestrator-triggered follow-on turns that
   *  carry NO NEW user input (a /battle round-2 rebuttal): the user's prompt was already vetted on the
   *  round-1 turn, and re-guarding the re-sent history would inconsistently block a rebuttal whose prompt
   *  round-1 already allowed. The OUTPUT guardrail still runs. Never set for a real user turn. */
  skipInputGuardrail?: boolean;
  /** THE TEXT THIS TURN'S HUMAN ACTUALLY SUBMITTED, scored by the input guardrail (ADR-027 phase 1).
   *  The guardrail previously scored the last user-ROLE entry in the assembled transcript, which is a
   *  different thing the moment a second assistant is in the channel: `loadChannelHistory` gives every
   *  participant that is not this bot the user role, so a peer's message can occupy that slot. A platform
   *  notice authored by one bot then reaches its rival as an instruction about model behaviour and is
   *  scored as a prompt attack, blocking that side before its model is called - deterministically, and
   *  only for the side that did not write the notice. Scoring the turn's own input is also parity with the
   *  external-provider path, which already passes `event.userMessage`. Absent ⇒ falls back to the
   *  transcript scan, so a caller that cannot name the turn's input keeps the prior behaviour. */
  userTurnText?: string;
  /** The guardrail this assistant SELECTS (SPEC-CONFIGURABLE-ASSISTANTS 4.6), from the resolved profile
   *  version. Applied by applyInput/OutputGuardrail in place of the deployment `GUARDRAIL_ID` env; absent
   *  ⇒ the deployment default. Selection only (an unprovisioned id AccessDenies → fails open). */
  guardrailId?: string;
}

export interface LongResponseResult {
  content: string;
  responseGroup?: string;
  totalParts?: number;
}

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Vision-through-conversation: image attachments carried on THIS message (from the Chime message
   * Metadata's `attachment`), captured by loadChannelHistory and preserved across consolidation. Each
   * entry's `bytes` is filled in later by a bounded fetch (resolveHistoryImageBlocks);
   * buildConverseMessages then renders each as a Converse image block on this message, so the assistant
   * genuinely SEES images shared earlier in the shared channel (e.g. a rival's generated image in an
   * /battle round-2 rebuttal) by reading the conversation itself. Absent on text turns -> byte-identical
   * to before.
   */
  images?: Array<{ fileKey: string; contentType: string; bytes?: Uint8Array }>;
  /**
   * WHO said this (ADR-027 part 1). Resolved during history assembly and no longer discarded: the
   * Converse role is two-valued, so without this every non-self participant - colleagues AND peer
   * assistants - collapses into one `user` voice the moment consolidation merges them. Absent on an
   * entry assembled by a path that has no sender to resolve, which renders exactly as before.
   */
  speaker?: Speaker;
  /** This assistant's own prior turn. Distinct from `role`, which a renderer derives from it. */
  isSelf?: boolean;
};

// ============================================================
// Placeholder Polling
// ============================================================

/**
 * Resolve the placeholder's MessageId by correlation id, from the mapping the channel flow writes.
 *
 * DETERMINISTIC HANDOFF, NOT A SEARCH. Every bot message entering the channel passes through the
 * channel flow, which parses its `<!--corr:{id}-->` marker and records `corr#<id> -> MessageId`
 * (`claimPlaceholderMapping`) before releasing it. That includes placeholders Amazon Chime SDK
 * materialises from a Lex fulfillment return: verified live 2026-08-06, where the flow was invoked for
 * the exact MessageId of a Lex-created placeholder 62ms before the processor resolved it, and the
 * table held `corr#5acfc651103ac6ee -> 8a152788...` while the turn was in flight.
 *
 * WHAT THIS REPLACED, AND WHY. This used to ALSO scan `ListChannelMessages` for the marker across 15
 * attempts. That scan existed because the code believed a Lex-created placeholder "never enters a
 * channel flow" and so could not be mapped. That belief was wrong, and the scan it justified was
 * expensive and unreliable: a best-effort search over an eventually consistent list that cannot
 * distinguish "not yet visible" from "never written", and that burned 22 seconds returning nothing on
 * a turn whose placeholder genuinely did not exist. The mapping answers the same question exactly.
 *
 * Still bounded and still retried: this processor is dispatched BEFORE the placeholder exists, so the
 * mapping appears a moment later. Returning null when it never appears is correct and is handled by
 * the caller.
 */
export async function pollForPlaceholderMessage(correlationId: string): Promise<string | null> {
  // SHORT. The mapping is written before the placeholder is released, so it lands within about a
  // second; waiting 22 for it only delays a turn that is going to fall back anyway. Eight attempts on
  // the existing backoff is a little over three seconds. The channel/bot parameters this once took
  // are gone rather than voided: the mapping needs neither, and a dead parameter advertises a
  // channel-scan contract the function deliberately no longer has.
  const maxAttempts = 8;
  const baseDelay = 150;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const mapped = await readPlaceholderMapping(correlationId);
    if (mapped) {
      console.log('[AsyncProcessor] Resolved placeholder from mapping', { attempt, messageId: mapped });
      return mapped;
    }

    await new Promise(resolve => setTimeout(resolve, Math.min(baseDelay * Math.pow(1.5, attempt - 1), 2000)));
  }

  console.warn('[AsyncProcessor] No placeholder mapping yet; deferring to a scan at answer time', { correlationId });
  return null;
}

/**
 * The message a turn's output (or error notice) should land on: the claimed mapping wins, the
 * dispatched placeholder id is the resolver's own fallback, and only when neither exists yet is the
 * short mapping poll paid. ONE definition, because the success path and the error path used to carry
 * copy-pasted variants of this - each with a dead ternary that re-tested a fallback the resolver had
 * already applied - and an error notice must land on the same message the answer would have.
 */
export async function resolveDeliveryMessageId(
  correlationId: string,
  dispatchedPlaceholderId?: string,
): Promise<string | null> {
  const target = resolvePlaceholderTarget(await readPlaceholderMapping(correlationId), dispatchedPlaceholderId);
  return target.messageId || (await pollForPlaceholderMessage(correlationId));
}

/**
 * LAST RESORT: find the placeholder by scanning the channel.
 *
 * `ListChannelMessages` is a billed API call, so this runs only when the mapping never appeared AND
 * the answer is ready to deliver - never on the happy path, and never before the model call. By then
 * the placeholder has had the whole inference window to land, so a single pass is enough; the old
 * 15-attempt loop existed to cover a race that the mapping now settles.
 *
 * Returns null when the placeholder genuinely does not exist, which the caller reports rather than
 * papering over.
 */
export async function scanForPlaceholderMessage(
  channelArn: string,
  correlationId: string,
  botArn: string
): Promise<string | null> {
  try {
    const response = await messagingClient.send(new ListChannelMessagesCommand({
      ChannelArn: channelArn,
      ChimeBearer: botArn,
      MaxResults: 20,
      SortOrder: 'DESCENDING',
    }));

    for (const message of response.ChannelMessages || []) {
      const messageId = message.MessageId || '';
      const content = message.Content || '';
      if (tryDecode(content).includes(`<!--corr:${correlationId}-->`)) return messageId;

      // A placeholder Chime materialised from a Lex return carries the marker INSIDE the envelope.
      try {
        const inner = JSON.parse(content)?.Messages?.[0]?.Content || '';
        if (tryDecode(inner).includes(`<!--corr:${correlationId}-->`)) return messageId;
      } catch {
        // Not JSON - not an envelope-wrapped placeholder.
      }
    }
  } catch (error) {
    console.error('[AsyncProcessor] Placeholder scan failed:', error);
  }
  return null;
}

// ============================================================
// Channel History
// ============================================================

/**
 * Is this bot message a PLACEHOLDER (the "One moment..." bubble awaiting its answer) rather than a
 * real assistant turn?
 *
 * Every placeholder is posted as `${copy} <!--corr:${correlationId}-->` - router-agent-handler,
 * channel-flow-processor and battle-orchestrator all build it that way, and `getTaskPlaceholder`
 * supplies the copy - so the marker is a complete and exact discriminator. The answer arrives as an
 * UpdateChannelMessage whose Content carries no `corr` marker, so a placeholder that has been
 * answered correctly stops matching.
 *
 * This USED to be `content.includes('thinking') || content.includes('...')`, which silently deleted
 * genuine assistant turns from the model's context: every placeholder copy ends in an ellipsis, but
 * so does ordinary prose, and Haiku in particular uses them freely. The drop is invisible (the turn
 * simply is not in the array) and intermittent (it depends on whether that one reply happened to
 * contain "..."), which is exactly the shape of the reported "the assistant forgot the previous
 * turn" defect. Matching the marker instead of the punctuation costs nothing and cannot misfire on
 * prose.
 */
export function isPlaceholderMessage(content: string): boolean {
  return content.includes('<!--corr:');
}

/**
 * Load conversation history from Chime channel.
 */
export async function loadChannelHistory(
  channelArn: string,
  botArn: string,
  currentMessage: string
): Promise<ConversationMessage[]> {
  const MAX_HISTORY_PAIRS = 5;

  try {
    const response = await messagingClient.send(new ListChannelMessagesCommand({
      ChannelArn: channelArn,
      ChimeBearer: botArn,
      MaxResults: 20,
      SortOrder: 'DESCENDING',
    }));

    const messages = response.ChannelMessages || [];
    if (messages.length === 0) return [];

    const history: ConversationMessage[] = [];

    for (const msg of messages.reverse()) {
      const senderArn = msg.Sender?.Arn || '';
      const rawContent = msg.Content || '';
      const content = tryDecode(rawContent);

      if (!content.trim()) continue;

      const isBot = senderArn.includes('/bot/') || senderArn === botArn;
      // Perspective-based role: assistants are first-class PEERS, so from the model's own vantage only
      // ITS OWN prior turns are `assistant`; every OTHER participant - the human AND any other assistant
      // (e.g. a battle rival) - is the `user` side. This is what lets another assistant's image ride a
      // valid `user` turn (Bedrock permits image blocks only on user turns) and be perceived naturally,
      // rather than being an invalid image block on an `assistant` turn.
      const isSelfBot = senderArn === botArn;

      // Skip the current user message (it's added separately)
      if (!isBot && content.trim() === currentMessage.trim()) continue;

      // Skip placeholder messages (see isPlaceholderMessage: matched on the `corr` marker every
      // placeholder carries, NOT on its punctuation).
      if (isBot && isPlaceholderMessage(content)) continue;

      // Vision-through-conversation: capture an IMAGE attachment carried on this message (from the
      // message Metadata's `attachment` - the same shape a generated image rides on, see
      // buildImageGenAttachment). Metadata-only here (no S3 fetch): a later bounded step resolves the
      // bytes. Non-image attachments (documents) are ignored. Best-effort - a parse miss just omits it.
      const att = extractAttachment(msg.Metadata);
      const images =
        att && imageFormatFromContentType(att.contentType)
          ? [{ fileKey: att.fileKey, contentType: att.contentType }]
          : undefined;

      // ADR-027 part 1: keep the identity this loop already resolved. `isBot` and `isSelfBot` were
      // both computed and then thrown away, which is why a peer assistant reached the model shaped
      // exactly like a human instruction. The display name is the one the channel already returns on
      // the message - no extra lookup, and no IdP call on the hot path.
      const speaker: Speaker = {
        // The PRINCIPAL id, not the raw ARN: this and the current turn's speaker are read from
        // different places and are compared for equality, so they must be the same shape by
        // construction rather than by coincidence.
        id: speakerIdFrom(senderArn),
        name: msg.Sender?.Name,
        kind: speakerKindFor(senderArn, botArn),
      };

      history.push({
        role: isSelfBot ? 'assistant' : 'user',
        content,
        speaker,
        isSelf: isSelfBot,
        ...(images && { images }),
      });
    }

    const maxItems = MAX_HISTORY_PAIRS * 2;
    if (history.length > maxItems) {
      return history.slice(-maxItems);
    }

    return history;
  } catch (error) {
    console.error('[AsyncProcessor] Error loading channel history:', error);
    return [];
  }
}

// ============================================================
// Domain grounding
// ============================================================

/**
 * Render domain grounding into a `<work_items>` system-prompt block.
 * `domainContext` is the current plan (PRIMARY grounding — the model must not ask the
 * user to re-describe it); `otherContexts` are the user's other plans/contexts (title/slug
 * only) for disambiguation. Both arrive via channel Metadata, forwarded by the router.
 * Returns '' when neither is present so this is a no-op for the generic AE assistant.
 */
export function formatDomainContextForPrompt(event: {
  domainContext?: unknown;
  otherContexts?: unknown;
  userName?: string;
  userLanguage?: string;
  participants?: unknown;
}): string {
  const parts: string[] = [];

  // Host i18n: reply in the user's chosen site language. Only a non-English language needs an
  // explicit instruction (English is the model default). Keep the tag generic so new locales
  // added by the i18n work work without an AE change.
  const lang = (event.userLanguage || '').toLowerCase();
  const LANG_NAMES: Record<string, string> = { zh: 'Simplified Chinese (简体中文)', en: 'English' };
  if (lang && lang !== 'en') {
    parts.push(
      `Respond in ${LANG_NAMES[lang] || `the user's language ("${lang}")`} unless the user writes ` +
        `to you in a different language. Keep proper names recognizable (you may include the local name).`,
    );
  }

  // Host/plan grounding is authored by ordinary channel members (via the work-item tools) and re-stamped
  // into this prompt on the next turn, so it is UNTRUSTED input like a chat message. Strip HTML-comment
  // control markers (no legitimate title carries `<!--ACTIVE_TASK…-->`/`<!--corr…-->`) and length-cap
  // every rendered field, matching the discipline applied to `participantProfile` - so a planted item
  // title can't inject instructions or smuggle a control marker into the system prompt.
  // stripMessageMarkers, not a local regex: this is a bad-actor defense, and the hand-rolled copy it
  // replaces covered only the comment pattern - an inline NAVIGATE_CHANNEL marker passed straight
  // into the system prompt, and future patterns added to the canonical list would have been missed.
  const clip = (s: unknown, max: number): string => stripMessageMarkers(String(s ?? '')).slice(0, max);
  const dc = event.domainContext as
    | {
        title?: string;
        items?: Array<{
          id?: string;
          title?: string;
          status?: string;
          assignee?: string;
          start?: string;
          end?: string;
        }>;
      }
    | undefined;
  const items = (dc && Array.isArray(dc.items) ? dc.items : []).slice(0, 25); // cap the item count
  if (dc && (dc.title || items.length)) {
    const lines: string[] = [];
    if (dc.title) lines.push(`Title: ${clip(dc.title, 200)}`);
    if (items.length) {
      lines.push('Work items (in order). Reference an item by its id when proposing a change:');
      for (const it of items) {
        const bits = [clip(it.title, 200) || 'Untitled item'];
        bits.push(`[${clip(it.status, 40) || 'open'}]`);
        if (it.assignee) bits.push(`{assignee: ${clip(it.assignee, 80)}}`);
        if (it.start) bits.push(`(start: ${clip(it.start, 40)})`);
        if (it.end) bits.push(`(end: ${clip(it.end, 40)})`);
        if (it.id) bits.push(`{id: ${clip(it.id, 100)}}`);
        lines.push(`  - ${bits.join(' ')}`);
      }
    }
    parts.push(
      `This conversation is about a CURRENT plan. Treat it as your primary grounding — ` +
        `do not ask the user to re-describe it.\n${lines.join('\n')}\n\n` +
        `You can PROPOSE changes with the work-item tools (add_item, update_item, ` +
        `remove_item, reorder_items, assign_item). When the user asks to change the plan, CALL the ` +
        `matching tool rather than only describing the change — each proposal is shown to the user ` +
        `to confirm before anything is saved. Reference existing items by id.`,
    );
  }

  const others = (Array.isArray(event.otherContexts)
    ? (event.otherContexts as Array<{ title?: string; slug?: string }>)
    : []).slice(0, 15); // cap the count; same untrusted-grounding treatment as the items above
  if (others.length) {
    const list = others
      .map((t) => `  - ${clip(t.title, 120) || 'Untitled'}${t.slug ? ` (${clip(t.slug, 60)})` : ''}`)
      .join('\n');
    parts.push(
      `The user also has these OTHER plans/contexts. If they clearly reference one by name, switch ` +
        `context to it; otherwise assume they mean the current plan.\n${list}`,
    );
  }

  // Participant roster — present only for SHARED plans. The roster
  // is membership + role only ({sub, role}); identity (names) is the IDP's source of truth and is NOT in
  // the prompt. So the assistant is told the group SHAPE (count + roles) and to confirm who owns an item
  // — it asks rather than assuming, and learns the specific person from the user's answer.
  const roster = Array.isArray(event.participants)
    ? (event.participants as Array<{ role?: string }>).filter(Boolean)
    : [];
  if (roster.length > 1) {
    const counts = new Map<string, number>();
    for (const p of roster) counts.set(p.role || 'participant', (counts.get(p.role || 'participant') || 0) + 1);
    const shape = Array.from(counts.entries()).map(([r, n]) => `${n} ${r}${n === 1 ? '' : 's'}`).join(', ');
    parts.push(
      `This plan is SHARED among ${roster.length} participants (${shape}). Plan for the group. When an ` +
        `action needs a specific owner, ASK who should handle it or assign it to the assistant; don't guess.`,
    );
  }

  if (!parts.length) return '';
  // The user's name is available for the rare moment it helps (e.g. a warm first greeting), but
  // repeating it sounds condescending — so the default is NOT to use it. Address the user as "you".
  const who = event.userName
    ? `\nThe user's name is ${event.userName}. Do NOT address them by name in normal replies — using it ` +
      `more than once in a conversation reads as condescending. Default to "you"; reserve the name for ` +
      `at most an occasional first greeting.`
    : '';
  return `\n\n<work_items>\n${parts.join('\n\n')}${who}\n</work_items>`;
}

/**
 * First-turn greeting directive. On the user's FIRST message in a conversation, tell the model to open
 * with a warm, one-time greeting BY NAME, then answer. Name personalization lives HERE, not in the
 * creation-time welcome: the WelcomeIntent fires before the user's membership/metadata settle, so a
 * name there races (see welcome-orientation + the router WelcomeIntent branch). This runs on the first
 * real turn, when the sender's identity is settled and the router has resolved their display name.
 * Returns '' when there is no usable name (empty, or the router's 'there' fallback) so a normal turn,
 * or an unresolved name, adds nothing. Distinct from `event.userName`, which carries a "do NOT address
 * by name in normal replies" instruction for host-stamped plan channels.
 */
export function firstTurnGreetingDirective(senderDisplayName?: string): string {
  // SANITISED, for the same reason the transcript label is: this name is the self-writable Cognito
  //  claim, and it lands inside a system-prompt block the model is told to trust.
  const name = safeSpeakerName(senderDisplayName);
  if (!name || name === 'there') return '';
  return (
    `\n\nThis is the user's FIRST message in this conversation. Open your reply by greeting them warmly ` +
    `by name exactly once ("Hi ${name}, ..."), then answer their message directly. Use their name only ` +
    `in this opening greeting, not again.`
  );
}

/**
 * State WHO the user is, on every turn, so a name asserted in conversation cannot silently replace the
 * one their identity carries.
 *
 * The assistant resolves the signed-in user's name from their authenticated identity and greets them
 * with it. Nothing then told it that name was authoritative, so a user who wrote "My name is TestBot"
 * was answered "Hi TestBot, it's nice to meet you!" - by an assistant that had opened the same
 * conversation addressing them as someone else. It neither adopted the claim knowingly nor flagged the
 * conflict; it simply had no idea there was one.
 *
 * That matters beyond politeness. This is an authenticated enterprise assistant, not a guest flow: who
 * the user is, is established at sign-in, and a claim typed into a message is not evidence about it. An
 * assistant that answers to whatever name it is handed is one that will also repeat that name back into
 * summaries, tasks and anything else downstream that reads the transcript.
 *
 * GUEST FLOWS ARE THE EXCEPTION, and they fall out for free rather than needing a branch: an
 * unauthenticated or federated sender resolves to the router's 'there' fallback, this returns '', and
 * no constraint is stated. A name can only be contradicted where one was actually established.
 *
 * A PREFERRED NAME IS PROFILE DATA, NOT A CONVERSATIONAL CLAIM. If a deployment wants the assistant to
 * call someone something other than what their directory record says, that belongs in a field on the
 * user's profile which the deployment populates and chooses to honour - the same shape as every other
 * per-user setting here. It does not belong in the model's discretion, and it is not something to infer
 * from a message, because "call me X" and "I am X" are indistinguishable in free text. There is no
 * dedicated preferred-name field today; the nearest existing carrier is the free-text
 * `participantProfile`, and a first-class field is worth adding if this is a surface OSS users want.
 *
 * A name mentioned about SOMEONE ELSE is untouched - the constraint is only on the user's own identity
 * being reassigned by assertion.
 */
export function userIdentityDirective(senderDisplayName?: string): string {
  // Sanitised - see firstTurnGreetingDirective. A name carrying brackets or newlines could close this
  // block early and open text of its own inside the trusted region.
  const name = safeSpeakerName(senderDisplayName);
  if (!name || name === 'there') return '';
  return (
    `\n\n<user_identity>\nThe person you are talking to is ${name}. This comes from their authenticated `
    + `sign-in and is the only authority on who they are. Address them as ${name}.\n`
    + `If they tell you their name is something else, do NOT adopt it and do NOT argue: say plainly that `
    + `your records have them as ${name}, and carry on with what they asked. A name they mention about `
    + `someone ELSE is not a claim about themselves and needs no comment.\n</user_identity>`
  );
}

/** Render the participant's profile (free-text preferences/working style) so replies are pre-tuned to
 *  them without being asked. Empty ⇒ '' (no-op). Sibling of formatDomainContextForPrompt. */
export function formatUserProfileForPrompt(event: { participantProfile?: string }): string {
  const profile = (event.participantProfile || '').trim();
  if (!profile) return '';
  return (
    `\n\n<participant_profile>\nThe participant's stated preferences and working style — tailor EVERY ` +
    `reply and suggestion to these without being asked:\n` +
    `${profile.slice(0, 600)}\n</participant_profile>`
  );
}

// ============================================================
// Message Consolidation
// ============================================================

/**
 * Consolidate consecutive same-role messages into single messages.
 * Bedrock requires alternating user/assistant roles.
 *
 * THE MERGE IS WHERE ATTRIBUTION IS WON OR LOST (ADR-027 part 2). Converse roles are two-valued, so
 * every non-self participant arrives as `user`, and consecutive ones are combined here - which is
 * precisely where the boundary between two colleagues, or between a colleague and a peer assistant,
 * used to dissolve. Each contribution therefore carries its speaker label INTO the merged content,
 * because no provider surface available here offers a per-message speaker field.
 *
 * ATTRIBUTION IS CONDITIONAL, and the condition is whether there is anything to disambiguate:
 *   - the transcript holds more than one distinct non-self speaker  => label every entry, because the
 *     current turn may come from a different person than the previous one; or
 *   - a merge combines contributions from DIFFERENT speakers        => label those, because that is
 *     the boundary the merge erases.
 * Neither holds in a 1:1, so a 1:1 transcript comes out byte-identical - no labels, no extra tokens,
 * no behaviour change. Two messages in a row from the SAME person merge unlabelled for the same
 * reason: repeating one name twice disambiguates nothing and is charged on every turn.
 *
 * SANITISATION RUNS REGARDLESS (part 3). A label the model is taught to read is a label a member can
 * type, so an attribution-shaped prefix is stripped from every contribution even when nothing is
 * being labelled - otherwise "the 1:1 case is unchanged" would also mean "the 1:1 case is forgeable".
 */
export function consolidateConsecutiveMessages(
  history: ConversationMessage[]
): ConversationMessage[] {
  if (history.length === 0) return [];

  const attributeAll = needsAttribution(history);
  const consolidated: ConversationMessage[] = [];
  /** Per consolidated entry: has a label already been applied to its first contribution? */
  const labelled: boolean[] = [];

  for (const msg of history) {
    const idx = consolidated.length - 1;
    const last = consolidated[idx];
    if (last && last.role === msg.role) {
      const sameSpeaker = !!last.speaker && !!msg.speaker && last.speaker.id === msg.speaker.id;
      const attribute = attributeAll || !sameSpeaker;
      // Relabel the FIRST contribution now that it is no longer alone, or the merged turn reads as
      // one speaker who was interrupted mid-thought.
      if (attribute && !labelled[idx]) {
        last.content = renderContribution(last.content, last.speaker, true);
        labelled[idx] = true;
      }
      last.content += '\n\n' + renderContribution(msg.content, msg.speaker, attribute);
      // Preserve image attachments from every merged message (e.g. both bots' round-1 images in an
      // image battle are consecutive assistant messages that consolidate into one block), so no
      // shared-conversation image is lost when consecutive same-role turns are combined.
      if (msg.images?.length) last.images = [...(last.images ?? []), ...msg.images];
    } else {
      consolidated.push({
        ...msg,
        content: renderContribution(msg.content, msg.speaker, attributeAll),
        ...(msg.images ? { images: [...msg.images] } : {}),
      });
      labelled.push(attributeAll);
    }
  }

  return consolidated;
}

// ============================================================
// Bedrock Invocation
// ============================================================

/** Bedrock Converse image formats (Phase-3 vision-in). */
export type ConverseImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

/** Image to attach to the current turn's user message (vision-in). */
export interface BedrockImageInput {
  format: ConverseImageFormat;
  bytes: Uint8Array;
}

/** Bedrock Converse document formats (attachment-in: PDFs, office docs, text). */
export type ConverseDocFormat = 'pdf' | 'csv' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'html' | 'txt' | 'md';

/** Document to attach to the current turn's user message (attachment-in: PDFs/office files/text). */
export interface BedrockDocumentInput {
  format: ConverseDocFormat;
  /** Converse requires a name; keep it simple (alphanumerics/space/hyphen) — caller sanitizes. */
  name: string;
  bytes: Uint8Array;
}

/** Map a content type to a Converse document format, or undefined if Converse can't take it. */
export function docFormatFromContentType(contentType: string | undefined): ConverseDocFormat | undefined {
  switch ((contentType || '').toLowerCase()) {
    case 'application/pdf':
      return 'pdf';
    case 'text/csv':
      return 'csv';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.ms-excel':
      return 'xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'text/html':
      return 'html';
    case 'text/plain':
      return 'txt';
    case 'text/markdown':
      return 'md';
    // JSON is text Converse has no format tag for. Served as 'txt' rather than dropped: the upload
    // allowlists (client + presigner) both admit application/json, so a silent undefined here meant
    // the user's .json uploaded to S3 and the assistant answered as if nothing was sent - the
    // three-way contract drift the mime-contract test now pins.
    case 'application/json':
      return 'txt';
    default:
      return undefined;
  }
}

/**
 * Map an attachment content type to a Converse image format. Returns
 * undefined for anything Converse can't take as an image — the caller
 * treats that as "no usable image" (so we never send a malformed block).
 */
export function imageFormatFromContentType(
  contentType: string | undefined,
): ConverseImageFormat | undefined {
  switch ((contentType || '').toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return undefined;
  }
}

/**
 * Build the Converse `messages` array. Pure (no SDK) so the
 * vision-in content-block shaping is unit-testable on its own. When an
 * image is supplied it is appended to the LAST user message as a
 * Converse image content block (the current turn's prompt); if there
 * is no user message the image is dropped rather than sent malformed.
 */
export function buildConverseMessages(
  messages: ConversationMessage[],
  imageInput?: BedrockImageInput,
  documentInput?: BedrockDocumentInput,
): Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> {
  // Vision-through-conversation: render each RESOLVED image attachment carried on a history message as a
  // Converse image block. Bedrock permits image blocks ONLY on USER turns - and with perspective-based
  // roles (loadChannelHistory) a USER turn is any OTHER participant (the human OR another assistant, e.g.
  // a battle rival), while an ASSISTANT turn is THIS model's own prior output (it need not re-perceive
  // its own image). So images render on user turns only; an image on an assistant turn is skipped, never
  // a malformed block.
  const out = messages.map(msg => {
    const content: Array<Record<string, unknown>> = [{ text: msg.content }];
    const role = msg.role as 'user' | 'assistant';
    if (role === 'user') {
      for (const img of msg.images ?? []) {
        const fmt = img.bytes ? imageFormatFromContentType(img.contentType) : undefined;
        if (img.bytes && fmt) {
          content.push({ image: { format: fmt, source: { bytes: img.bytes } } });
        }
      }
    }
    return { role, content };
  });
  // Append the current-turn attachment (image OR document) to the LAST user message. If there is no user
  // message it is dropped rather than sent malformed.
  const block = imageInput
    ? { image: { format: imageInput.format, source: { bytes: imageInput.bytes } } }
    : documentInput
      ? { document: { format: documentInput.format, name: documentInput.name, source: { bytes: documentInput.bytes } } }
      : undefined;
  if (block) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === 'user') {
        out[i].content.push(block);
        break;
      }
    }
  }
  return out;
}

/**
 * Vision-through-conversation: resolve image attachments carried on RECENT history messages into
 * Converse image blocks, by fetching their bytes from the attachments bucket. This is how an assistant
 * perceives an image shared earlier in the SHARED channel (e.g. a rival's round-1 generated image in an
 * /battle round-2 rebuttal) - the image is read straight from the conversation, not an out-of-band side
 * channel. Mutates the passed messages in place (sets `bytes` on each resolved image entry) so
 * buildConverseMessages then renders them.
 *
 * Bounded for cost/latency: only the last `windowSize` messages are considered and at most `maxImages`
 * images are attached, newest-first (so the most recent images - the rival's round-1 output - win the
 * cap). Each fetch is guarded: a miss is skipped, never thrown, so a fetch failure degrades to a
 * text-only turn rather than crashing. Returns the number of images actually attached.
 */
export async function resolveHistoryImageBlocks(args: {
  messages: ConversationMessage[];
  s3: S3GetClient;
  bucket: string;
  /** How many trailing messages to scan for images. Default 6. */
  windowSize?: number;
  /** Hard cap on images attached (cost/latency guard). Default 2. */
  maxImages?: number;
}): Promise<number> {
  const { messages, s3, bucket } = args;
  if (!bucket) return 0;
  const windowSize = args.windowSize ?? 6;
  const maxImages = args.maxImages ?? 2;
  const start = Math.max(0, messages.length - windowSize);
  let attached = 0;
  // Newest-first so the most recent images win the cap.
  for (let i = messages.length - 1; i >= start && attached < maxImages; i--) {
    for (const img of messages[i].images ?? []) {
      if (attached >= maxImages) break;
      if (img.bytes) continue; // already resolved
      if (!imageFormatFromContentType(img.contentType)) continue; // unusable format
      try {
        img.bytes = await fetchAttachmentBytes(s3, bucket, img.fileKey);
        attached++;
      } catch (err) {
        console.warn('[AsyncProcessor] history image fetch failed (skipping):', err);
      }
    }
  }
  return attached;
}

// Guards a runaway tool loop; a normal company question resolves in 1 round.
const MAX_TOOL_ITERATIONS = 3;

// Converse tool spec for the self-hosted (in-Lambda) agent loop.
const COMPANY_CONTEXT_TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: 'load_company_context',
        description:
          'Retrieve specific company/product/pricing/plan/financial document(s) this assistant is allowed ' +
          'to read, to answer a question about the company. Prefer naming the exact document(s) you need in ' +
          '`documents` (filenames from the AVAILABLE COMPANY CONTEXT list) so you load only what the task ' +
          'needs, not the whole corpus. Omit `documents` only for a genuinely broad question that spans many ' +
          'docs. Returns only the documents this classification is permitted to access.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What the user is asking about.' },
              documents: {
                type: 'array',
                items: { type: 'string' },
                description: 'The specific document FILENAME(s) to load (from AVAILABLE COMPANY CONTEXT), e.g. ["financial-data.json"]. Omit to load all permitted docs (broad questions only).',
              },
            },
            required: [],
          },
        },
      },
    },
  ],
};

// Converse tool spec for platform self-knowledge — the AgentEchelon product
// itself, kept separate from company/business context so a business question
// never loads platform docs (and vice-versa).
const PLATFORM_INFO_TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: 'load_platform_info',
        description:
          'Retrieve documentation about the AgentEchelon platform ITSELF — what ' +
          'it is, how it works, its architecture, features, and capabilities. Call ' +
          'this ONLY when the user asks about this platform/product/assistant. Do ' +
          'NOT call it for questions about the company, its products, pricing, or ' +
          'financials — use load_company_context for those.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What the user is asking about the platform.' },
            },
            required: [],
          },
        },
      },
    },
  ],
};

// Work-item tools (propose-and-confirm).
// The model CALLS one of these to PROPOSE a change to the plan's work items; the in-Lambda loop
// does NOT execute it — it captures {op,args} and emits a <!--proposal:…--> marker the widget
// renders as a confirm card. The actual write happens only when the user taps Apply (host apply
// endpoint). Item ids come from <work_items>.
export const WORK_ITEM_TOOL_NAMES = new Set([
  'add_item', 'update_item', 'remove_item', 'reorder_items', 'assign_item',
]);

/** The tool name out of a Bedrock Converse `toolSpec` wrapper (for per-profile allowlist filtering). */
function toolSpecName(spec: unknown): string {
  return (spec as { toolSpec?: { name?: string } })?.toolSpec?.name ?? '';
}

/**
 * Restrict runtime-available Converse toolSpecs to a profile's tool ALLOWLIST (SPEC-ASSISTANT-CONFIG §4).
 * `undefined` allowlist ⇒ all available (legacy/unset — byte-identical to the pre-allowlist path); otherwise
 * only specs whose tool name is in the allowlist survive. This is the INTERSECTION of "runtime available"
 * (the caller already gated `specs` by availability) and "profile permits". Exported for unit testing.
 */
export function filterToolSpecsByProfile<T>(specs: T[], allow: string[] | undefined): T[] {
  if (allow === undefined) return specs;
  const permitted = new Set(allow);
  return specs.filter((t) => permitted.has(toolSpecName(t)));
}
const WORK_ITEM_STATUS_ENUM = ['open', 'in_progress', 'blocked', 'done'];
const WORK_ITEM_TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: 'add_item',
        description:
          'Propose ADDING a work item to the plan. Does not take effect until the user confirms.',
        inputSchema: { json: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            notes: { type: 'string' },
            status: { type: 'string', enum: WORK_ITEM_STATUS_ENUM },
            assignee: { type: 'string', description: 'Participant who owns this item, or "assistant" to assign it to the AI.' },
            start: { type: 'string', description: 'YYYY-MM-DD optional start/due date.' },
            end: { type: 'string' },
            afterItemId: { type: 'string', description: 'Insert after this existing item id; omit to append.' },
          },
          required: ['title'],
        } },
      },
    },
    {
      toolSpec: {
        name: 'update_item',
        description:
          'Propose EDITING an existing item (rename, re-status, reschedule, reassign, or change ' +
          'notes). Identify it by id. Does not take effect until the user confirms.',
        inputSchema: { json: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            patch: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                notes: { type: 'string' },
                status: { type: 'string', enum: WORK_ITEM_STATUS_ENUM },
                assignee: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
              },
            },
          },
          required: ['id', 'patch'],
        } },
      },
    },
    {
      toolSpec: {
        name: 'remove_item',
        description: 'Propose REMOVING an item from the plan. Identify it by id.',
        inputSchema: { json: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        } },
      },
    },
    {
      toolSpec: {
        name: 'reorder_items',
        description: 'Propose REORDERING the items. Provide every existing item id exactly once, in the new order.',
        inputSchema: { json: {
          type: 'object',
          properties: { orderedIds: { type: 'array', items: { type: 'string' } } },
          required: ['orderedIds'],
        } },
      },
    },
    {
      toolSpec: {
        name: 'assign_item',
        description: 'Propose ASSIGNING an item to a participant or to the assistant.',
        inputSchema: { json: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            assignee: { type: 'string', description: 'Participant who owns this item, or "assistant".' },
          },
          required: ['id', 'assignee'],
        } },
      },
    },
  ],
};

/** Short human-readable summary for the confirm card (the host apply endpoint produces the
 *  authoritative one on apply; this is just the pre-apply preview). */
function summarizeProposal(op: string, args: Record<string, unknown>): string {
  const a = args || {};
  switch (op) {
    case 'add_item': return `Add "${String(a.title ?? 'item')}"`;
    case 'update_item': return 'Update an item';
    case 'remove_item': return 'Remove an item';
    case 'reorder_items': return 'Reorder items';
    case 'assign_item': return `Assign an item to ${String(a.assignee ?? 'someone')}`;
    default: return 'Update the plan';
  }
}

/** The work-item tools in OpenAI function-calling format (DeepSeek/Qwen). The Converse
 *  `inputSchema.json` is already JSON Schema, so this is a near-direct map — both providers
 *  describe the SAME propose-and-confirm tools, so a CN turn proposes edits the same way. */
export const WORK_ITEM_OPENAI_TOOLS = WORK_ITEM_TOOL_CONFIG.tools.map((t) => ({
  type: 'function' as const,
  function: {
    name: t.toolSpec.name,
    description: t.toolSpec.description,
    parameters: t.toolSpec.inputSchema.json,
  },
}));

/** Encode a proposed edit as a marker the widget parses into a confirm card. Base64 so the
 *  JSON can never contain a comment-closing `-->`. Mirrors the corr/battlestats marker pattern. */
export function proposalMarker(op: string, args: Record<string, unknown>): string {
  const payload = JSON.stringify({ op, args, summary: summarizeProposal(op, args) });
  return `<!--proposal:${Buffer.from(payload, 'utf8').toString('base64')}-->`;
}

// ── Suggestions (suggest → review → accept/reject) ──────────────────────────────────────────
// A reviewable set of suggested items the assistant offers, rendered as cards the user accepts or
// rejects. Unlike the single propose-and-confirm edit, this is MODEL-AGNOSTIC and tool-FREE: the
// model emits a fenced ```suggestions JSON block in its TEXT (so a reasoning model like
// DeepSeek-R1, which cannot use Converse tools, can still produce structured suggestions). The
// processor extracts + validates the block, strips it from the visible reply, and re-encodes it as
// a `<!--suggestions:-->` marker the widget parses. The persona instructs the format.

export interface SuggestedItem {
  title: string;
  why?: string;
  category?: string;
  link?: string;
}

/** Encode validated suggestions as a marker the widget parses into review cards. */
export function suggestionsMarker(items: SuggestedItem[]): string {
  const payload = JSON.stringify({ items });
  return `<!--suggestions:${Buffer.from(payload, 'utf8').toString('base64')}-->`;
}

// Matches a fenced block: ```suggestions\n[ ... ]\n``` (the language tag is optional/loose).
const SUGGESTIONS_FENCE = /```(?:json\s*)?suggestions?\s*\n([\s\S]*?)\n?```/i;

/** Coerce one parsed entry into a SuggestedItem, or null if it lacks a usable title. */
function coerceSuggestedItem(raw: unknown): SuggestedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 120)
    : typeof r.name === 'string' ? r.name.trim().slice(0, 120) : '';
  if (!title) return null;
  const out: SuggestedItem = { title };
  if (typeof r.why === 'string') out.why = r.why.slice(0, 400);
  if (typeof r.category === 'string') out.category = r.category.slice(0, 60);
  if (typeof r.link === 'string' && /^https?:\/\//i.test(r.link)) out.link = r.link.slice(0, 500);
  return out;
}

/**
 * Extract a suggestions block from a model reply. Returns the reply with the fenced block removed
 * plus a `<!--suggestions:-->` marker appended (so the widget renders cards), or the text unchanged
 * when there's no valid block. Defensive: a malformed/empty block is simply dropped (the prose
 * still shows). Cap at 12 items to bound the payload + UI.
 */
export function extractSuggestions(text: string): string {
  const m = SUGGESTIONS_FENCE.exec(text);
  if (!m) return text;
  let items: SuggestedItem[] = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [];
    items = (list as unknown[]).map(coerceSuggestedItem).filter((p): p is SuggestedItem => p !== null).slice(0, 12);
  } catch {
    items = [];
  }
  const cleaned = text.replace(SUGGESTIONS_FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
  if (items.length === 0) return cleaned || text;
  return `${cleaned}\n\n${suggestionsMarker(items)}`;
}

function firstText(message: { content?: Array<Record<string, unknown>> } | undefined): string {
  for (const block of message?.content ?? []) {
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return '';
}

/**
 * Apply the configured guardrail to model OUTPUT out-of-band — the PII,
 * content-filter, and metadata-marker enforcement the managed agent path gets
 * automatically. (Prompt-injection is NOT an output concern — Bedrock evaluates
 * PROMPT_ATTACK only on input; that is handled by {@link applyInputGuardrail}.)
 * No-op unless GUARDRAIL_ID/GUARDRAIL_VERSION are set. On an intervention,
 * returns the masked/blocked text; on a guardrail error it fails OPEN (returns
 * the original text with a warning) so a transient guardrail outage never
 * silently drops a reply.
 */
/** Minimal shape of the ApplyGuardrail response the callers read. */
type GuardrailResult = { action?: string; outputs?: Array<{ text?: string }> } | null;

/**
 * Apply a guardrail with a FALLBACK CHAIN (SPEC-CONFIGURABLE-ASSISTANTS 4.6). A profile may SELECT a
 * deployment-provisioned guardrail (applied as its live DRAFT); absent ⇒ the deployment default
 * (GUARDRAIL_ID/GUARDRAIL_VERSION env). The IAM ApplyGuardrail grant is per provisioned guardrail, so a
 * SELECTED id that isn't provisioned for THIS classification (e.g. a valid id from the wrong
 * classification's catalog) AccessDenies. That is a persistent MISCONFIGURATION, not a transient outage,
 * so we do NOT fail open on it: we fall back to the deployment default and re-apply, and log LOUD so the
 * bad selection surfaces. Only a genuine error of the DEFAULT itself (or no guardrail configured) fails
 * open (returns null → the caller passes the turn through), preserving "a guardrail outage never drops a
 * reply / bricks input".
 */
async function runGuardrail(source: 'INPUT' | 'OUTPUT', text: string, guardrailId?: string): Promise<GuardrailResult> {
  const attempts: Array<{ id?: string; version?: string; selected: boolean }> = [];
  if (guardrailId) attempts.push({ id: guardrailId, version: 'DRAFT', selected: true });
  if (process.env.GUARDRAIL_ID) attempts.push({ id: process.env.GUARDRAIL_ID, version: process.env.GUARDRAIL_VERSION, selected: false });
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (!a.id || !a.version) continue;
    try {
      return await bedrockClient.send(new ApplyGuardrailCommand({
        guardrailIdentifier: a.id,
        guardrailVersion: a.version,
        source,
        content: [{ text: { text } }],
      }));
    } catch (err) {
      const hasFallback = i + 1 < attempts.length;
      if (a.selected && hasFallback) {
        // ANY failure of a SELECTED guardrail falls back to the deployment default. Narrowing this
        // to AccessDenied left every other failure mode silently UNFILTERED: nothing validates a
        // selected id beyond "non-empty string", and the published catalog exposes selection KEYS
        // ('default', 'strict') next to resolved ids, so a profile or an imported bundle carrying a
        // key raises ValidationException / ResourceNotFoundException - which fell straight through
        // to the fail-open return without ever trying the default. A selected guardrail that cannot
        // be applied is a persistent MISCONFIGURATION whatever the error name; the deployment
        // default is still there and must be applied. Only a failure of the DEFAULT itself (below)
        // fails open, which is what keeps "a guardrail outage never drops a reply / bricks input".
        const name = String((err as { name?: string })?.name || 'Error');
        console.error(`[AsyncProcessor] selected ${source} guardrail "${a.id}" failed to apply (${name}); falling back to the deployment default`, err);
        continue; // re-apply with the default rather than failing open
      }
      console.warn(`[AsyncProcessor] ${source} ApplyGuardrail failed; failing open`, err);
      return null;
    }
  }
  return null;
}

export async function applyOutputGuardrail(text: string, guardrailId?: string): Promise<string> {
  if (!text) return text;
  const resp = await runGuardrail('OUTPUT', text, guardrailId);
  if (resp?.action === 'GUARDRAIL_INTERVENED') {
    const masked = (resp.outputs ?? []).map((o) => o.text ?? '').join('').trim();
    // THE MASK IS ITSELF A LEAK when the filter exists to hide an internal marker: Bedrock
    // substitutes `{FILTER_NAME}`, so a masked ACTIVE_TASK/corr marker reaches the human as the
    // literal `{MetadataMarkerFilter}` (live). This is the one point in the system where such a
    // token can be created, so it is where it is removed - before the reply is posted, archived, or
    // scored. PII masks (`{EMAIL}`) are left alone; there the mask is the intended output.
    // AND THE FALLBACK MUST NOT UNDO THE MASK. `masked || text` was safe while the mask token was
    // left in place, because the token itself kept the string non-empty. Stripping it makes an empty
    // result reachable for the first time, and it is reachable in exactly one case: the reply was
    // NOTHING BUT the thing the filter matched. Falling back to `text` there hands back the raw
    // marker the filter exists to hide - a worse outcome than the leak this whole change fixes, since
    // the channel flow reads a `<!--corr:-->` marker back out of posted content.
    //
    // So the fallback strips the markers instead, and a reply that is empty after that gets the
    // block copy. A guardrail outcome still never drops a reply; it just never returns unmasked text.
    const cleaned = stripGuardrailMaskTokens(masked);
    if (cleaned) return cleaned;
    return stripMessageMarkers(text).trim() || GUARDRAIL_BLOCK_FALLBACK;
  }
  return text;
}

/**
 * Apply the configured guardrail to USER INPUT out-of-band, BEFORE the model is
 * called. THIS is what engages the PROMPT_ATTACK (prompt-injection) filter and
 * the input content filters — Bedrock only scores those on input, so
 * {@link applyOutputGuardrail} cannot catch a prompt injection; this closes that
 * gap (docs/IDENTITY-AND-ACCESS-MODEL.md §8). Returns `{ blocked, message }`:
 * on `GUARDRAIL_INTERVENED` the caller must short-circuit and return `message`
 * (the guardrail's blockedInputMessaging) WITHOUT invoking the model. No-op
 * (blocked:false) unless GUARDRAIL_ID/GUARDRAIL_VERSION are set. Fails OPEN on a
 * guardrail outage (allows the turn) so a transient guardrail failure never
 * bricks input — the output guardrail remains a backstop.
 */
/**
 * What a blocked turn says when the guardrail supplies no masked output of its own.
 *
 * Exported because a REPLY IS NOT AN ANSWER when it is this, and that distinction has to be
 * assertable. A duel side blocked at input still posts an attributed reply carrying this text, so the
 * duel looks complete - two replies, a scorecard, a countable human pick - while the experiment
 * records a loss against a model that never ran. Tests that check "the side answered" match on this
 * constant rather than re-typing the sentence, so a copy change cannot quietly disarm them.
 */
export const GUARDRAIL_BLOCK_FALLBACK = 'I cannot process that request. Please rephrase your message.';

/**
 * Does this reply text look like a guardrail block rather than an answer?
 *
 * Matches the fallback copy above and the leading clause of a masked variant. Deliberately a PREFIX
 * test on the recognisable sentence rather than a keyword search: an answer may legitimately contain
 * "cannot process" in the middle of a sentence about something else.
 */
export function isGuardrailBlockReply(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return t.startsWith(GUARDRAIL_BLOCK_FALLBACK) || /^I cannot process that request\b/i.test(t);
}

export async function applyInputGuardrail(text: string, guardrailId?: string): Promise<{ blocked: boolean; message: string }> {
  // Profile-selected guardrail (4.6) via the shared fallback chain: a bad SELECTION falls back to the
  // deployment default (never silently unfiltered); a genuine outage of the default fails OPEN (allows
  // the turn) - the output guardrail remains a backstop.
  if (!text) return { blocked: false, message: '' };
  const resp = await runGuardrail('INPUT', text, guardrailId);
  if (resp?.action === 'GUARDRAIL_INTERVENED') {
    const masked = (resp.outputs ?? []).map((o) => o.text ?? '').join('').trim();
    return { blocked: true, message: masked || GUARDRAIL_BLOCK_FALLBACK };
  }
  return { blocked: false, message: '' };
}

/**
 * Invoke Bedrock Converse with the given system prompt and messages.
 *
 * `imageInput` (Phase-3 vision-in) attaches an image to the current turn;
 * only pass it for vision-capable models (see resolveVisionBattleAction).
 *
 * `enableCompanyContextTool` (ADR-011) exposes the
 * `load_company_context` tool and runs a self-hosted, in-Lambda tool loop
 * (reason → tool_use → observe → answer). Only normal text turns enable it;
 * vision and /battle turns leave it off. Classification isolation is enforced by the
 * caller Lambda's S3 IAM via `loadCompanyContext`.
 */
export async function invokeBedrock(
  systemPrompt: string,
  messages: ConversationMessage[],
  config: AsyncProcessorConfig,
  imageInput?: BedrockImageInput,
  enableCompanyContextTool = false,
  enableEditTools = false,
  documentInput?: BedrockDocumentInput,
  cacheableSystemPrefixLength?: number,
  taskContext?: TaskLoopContext,
): Promise<{ response: string; inputTokens: number; outputTokens: number; bedrockTime: number; modelMs: number; toolMs: number; steps: ConverseStep[]; inputGuardBlocked?: boolean }> {
  const bedrockStart = Date.now();
  const convMessages = buildConverseMessages(messages, imageInput, documentInput) as Array<Record<string, unknown>>;
  // ADR-011: company-context bucket (attachments bucket, context/{classification}/);
  // classification isolation is enforced by this Lambda's own scoped S3 IAM. Read at call
  // time so the env is always current (and testable).
  const companyContextBucket = process.env.CONTEXT_BUCKET || '';
  const companyToolOn = enableCompanyContextTool && !!companyContextBucket;
  // Company-context DIGEST (ADR-017): when the company-context tool is on, prepend
  // the always-present per-classification manifest (titles + one-line descriptions of the
  // documents this classification may read) so the model knows WHAT company context exists
  // and can fetch specifics, instead of guessing. Warm-cached + classification-scoped like
  // the documents themselves; empty string when no digest is present.
  if (companyToolOn) {
    try {
      const digestHint = buildDigestHint(
        await loadContextDigest(companyContextBucket, config.userType),
      );
      if (digestHint) systemPrompt += digestHint;
    } catch (err) {
      console.warn('[async-core] context digest failed (non-fatal):', err);
    }
  }
  // Mock corporate-travel API tool (executed in-loop). OFF unless the deployment sets
  // ENABLE_TRAVEL_TOOL=true, so the platform stays domain-neutral by default. Read at
  // call time (like CONTEXT_BUCKET) so the env is always current and testable.
  const travelToolOn = isTravelToolEnabled();
  // SPEC-TASK-STATE-TRANSITIONS §3: register advance_task_state only when a machine-backed task is
  // active (one fewer distractor tool off-task). The tool result is the ONLY thing that changes
  // task state — the loop authorizes it against the graph and persists in-loop.
  // The STATE is passed so the tool can carry the step's declared needs and require an accounting for
  // them (§4). `initialState` is the state the model saw when the turn began, which is the one whose
  // needs it was answering - `task.taskState` can already have moved if the tool ran earlier in this
  // same loop, and a tool spec that changed mid-loop would describe a step the model is no longer on.
  const taskToolSpecs = taskContext
    ? taskToolSpecsFor(
      taskContext.task.taskType,
      taskContext.machines,
      taskContext.initialState ?? taskContext.task.taskState,
    )
    : [];
  // Combined tool surface: company-context + corporate-travel (both executed in-loop) + work-item tools
  // (intercepted as proposals, never executed here) + task tools. Each is gated by its RUNTIME availability
  // (companyToolOn / travelToolOn / enableEditTools / an active task).
  const rawToolSpecs = [
    ...(companyToolOn ? COMPANY_CONTEXT_TOOL_CONFIG.tools : []),
    ...(companyToolOn ? PLATFORM_INFO_TOOL_CONFIG.tools : []),
    ...(travelToolOn ? [CORPORATE_TRAVEL_TOOL_SPEC] : []),
    ...(enableEditTools ? WORK_ITEM_TOOL_CONFIG.tools : []),
    ...taskToolSpecs,
  ];
  // SPEC-ASSISTANT-CONFIG §4 — tools are PER-PROFILE: the active version's `tools` allowlist gates which of
  // the runtime-available tools this assistant may actually use. The allowlist INTERSECTS availability (a
  // tool the profile permits is still only offered when its precondition holds). `undefined` ⇒ all available
  // (legacy/unset), so an unconfigured profile behaves exactly as before.
  const offeredToolSpecs = filterToolSpecsByProfile(rawToolSpecs, config.tools);
  const useTools = offeredToolSpecs.length > 0;
  const toolConfig = useTools ? { tools: offeredToolSpecs } : undefined;

  let inputTokens = 0;
  let outputTokens = 0;
  let response = '';
  // Per-step telemetry (SPEC-MESSAGE-METADATA-CODEBOOK.md "tracking each step";
  // ADR-016): one ConverseStep per Converse iteration of the self-hosted tool loop
  // (generate / tool-use / answer). Persisted out-of-band only — never on the
  // size-capped Chime Metadata. estCostUsd is resolved by makeConverseStep.
  const steps: ConverseStep[] = [];

  // Input-side guardrail — engages the PROMPT_ATTACK (prompt-injection) filter and
  // the input content filters, which Bedrock evaluates ONLY on input. Runs before
  // any model call and short-circuits on a prompt attack (no tokens spent). Fails
  // OPEN on a guardrail outage. Pairs with applyOutputGuardrail below (input +
  // output = full coverage). See docs/IDENTITY-AND-ACCESS-MODEL.md §8.
  // WHAT GETS SCORED: this turn's own human input when the caller can name it, and only otherwise the
  // last user-role entry in the transcript. Those two stop being the same thing once a channel holds a
  // second assistant - see `AsyncProcessorConfig.userTurnText` and ADR-027.
  // The FALLBACK reads a consolidated entry, which since ADR-027 may carry speaker labels. Strip them
  // before scoring: a label is platform text, not something the sender submitted, and letting it reach
  // the filter would mean a participant's display name could influence whether a turn is blocked.
  const latestUserText = config.userTurnText
    ?? stripAttribution([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  // A /battle round-2 rebuttal is orchestrator-triggered with no new user input (the prompt was already
  // guardrail-checked on round 1), so skipping the INPUT guardrail here avoids inconsistently blocking a
  // rebuttal whose prompt round-1 already allowed. The output guardrail still runs. See AsyncProcessorConfig.
  const inputGuard = config.skipInputGuardrail
    ? { blocked: false, message: '' }
    : await applyInputGuardrail(latestUserText, config.guardrailId);
  if (inputGuard.blocked) {
    console.warn('[AsyncProcessor] input guardrail intervened; blocking turn before model call');
    // The STRUCTURAL fact rides the result. Flattening it into text made a blocked turn
    // indistinguishable from an answer to every consumer once the guardrail carried custom
    // blockedInputMessaging (the prefix test below only ever matched the default copy).
    return { response: inputGuard.message, inputTokens: 0, outputTokens: 0, bedrockTime: Date.now() - bedrockStart, modelMs: 0, toolMs: 0, steps, inputGuardBlocked: true };
  }

  // model_ms / tool_ms split (LATENCY-TARGETS.md): iterStart->iterEnd brackets ONLY the Converse
  // model call; tool execution runs after iterEnd and is timed separately below. Their sum plus the
  // guardrails reconciles to bedrockTime (latency_ms).
  let modelMs = 0;
  let toolMs = 0;
  for (let iter = 0; ; iter++) {
    const iterStart = Date.now();
    const bedrockResponse = await bedrockClient.send(new ConverseCommand({
      modelId: config.model,
      system: buildSystemBlocks(systemPrompt, cacheableSystemPrefixLength, config.model) as unknown as ConverseCommandInput['system'],
      messages: convMessages as unknown as ConverseCommandInput['messages'],
      inferenceConfig: {
        maxTokens: config.maxTokens,
        temperature: config.temperature ?? 0.7,
      },
      ...(useTools
        ? { toolConfig: toolConfig as unknown as ConverseCommandInput['toolConfig'] }
        : {}),
    }));
    const iterEnd = Date.now();
    modelMs += iterEnd - iterStart; // this iteration's model-inference time (the ConverseCommand)

    const callIn = bedrockResponse.usage?.inputTokens ?? 0;
    const callOut = bedrockResponse.usage?.outputTokens ?? 0;
    inputTokens += callIn;
    outputTokens += callOut;
    const outMessage = bedrockResponse.output?.message as
      | { content?: Array<Record<string, unknown>> }
      | undefined;
    // Label this step by what the model did: a generation that answers vs. a
    // tool-use round. Refined below once we know which branch we take.
    const pushStep = (stepLabel: string, tools?: ToolStepOutcome[]) =>
      steps.push(makeConverseStep({
        stepLabel,
        modelId: config.model,
        startedAt: new Date(iterStart).toISOString(),
        endedAt: new Date(iterEnd).toISOString(),
        tokensIn: callIn,
        tokensOut: callOut,
        tools,
      }));

    if (useTools && bedrockResponse.stopReason === 'tool_use' && iter < MAX_TOOL_ITERATIONS) {
      // Propose-and-confirm: if the model called a work-item tool, DO NOT execute it.
      // Capture the proposed {op,args}, emit it as a marker beside the model's text, and end the
      // turn — the user confirms in the widget, which then calls the host apply endpoint.
      let proposal: { name: string; input: Record<string, unknown> } | undefined;
      for (const block of outMessage?.content ?? []) {
        const tu = (block as { toolUse?: { name?: string; input?: Record<string, unknown> } }).toolUse;
        if (tu?.name && WORK_ITEM_TOOL_NAMES.has(tu.name)) { proposal = { name: tu.name, input: tu.input ?? {} }; break; }
      }
      if (proposal) {
        const lead = firstText(outMessage) || "Here's the change I'd make — review and apply it when you're ready.";
        response = `${lead}\n\n${proposalMarker(proposal.name, proposal.input)}`;
        // SPEC-TASK-STATE-TRANSITIONS §5: the proposal itself drives place_item collecting->confirming
        // via the authorized path (coupled to the tool success, not the marker). No-op for other tasks.
        await advancePlaceItemOnProposal(taskContext);
        pushStep(`tool-propose:${proposal.name}`);
        break;
      }
      // Otherwise: execute company-context tool(s) and let the model continue.
      // Echo the assistant turn (carries the toolUse blocks), then answer each
      // tool call with a toolResult and let the model continue.
      convMessages.push(bedrockResponse.output!.message as unknown as Record<string, unknown>);
      const toolResults: Array<Record<string, unknown>> = [];
      // P2 (SPEC-ADMIN-CONSOLE-EFFECTIVENESS): per-tool outcome for this iteration — name + success +
      // bounded error class, no payloads — so tool-error rate is queryable off the step, not greppable.
      const toolOutcomes: ToolStepOutcome[] = [];
      const toolExecStart = Date.now(); // time the tool-execution block (runs after the model call)
      for (const block of outMessage?.content ?? []) {
        const toolUse = (block as { toolUse?: { toolUseId?: string; name?: string } }).toolUse;
        if (!toolUse) continue;
        let payload: Record<string, unknown>;
        try {
          const toolInput = (block as { toolUse?: { input?: Record<string, unknown> } }).toolUse?.input ?? {};
          if (toolUse.name === 'load_company_context') {
            // Honor the model's document selection (filenames) so we load only what the task needs.
            const docs = Array.isArray(toolInput.documents) ? (toolInput.documents as unknown[]).filter((d): d is string => typeof d === 'string') : undefined;
            payload = (await loadCompanyContext(companyContextBucket, config.userType, docs?.length ? { documents: docs } : undefined)) as unknown as Record<string, unknown>;
          } else if (toolUse.name === 'load_platform_info') {
            payload = (await loadPlatformInfo(companyContextBucket)) as unknown as Record<string, unknown>;
          } else if (toolUse.name === 'search_corporate_travel') {
            payload = searchCorporateTravel(toolInput as unknown as TravelSearchArgs) as unknown as Record<string, unknown>;
          } else if (taskContext && toolUse.name === ADVANCE_TASK_STATE_TOOL_NAME) {
            // SPEC-TASK-STATE-TRANSITIONS §3: authorize + persist the requested transition. On
            // success reflect the new state so later iterations see it, and record the applied
            // transition on the shared context (for analytics + the shadow comparison). An
            // unauthorized request returns an error the model can read and recover from in-loop.
            const { payload: taskPayload, result, details: writtenDetails } = await handleAdvanceTaskStateTool({
              task: taskContext.task,
              input: toolInput,
              machines: taskContext.machines,
              messageId: taskContext.messageId,
              // Who to hand the task BACK to when it stops awaiting the user: this assistant. Without
              // it, an item that the person has answered stays in their queue looking unfinished.
              assistantId: taskContext.assistantId,
            });
            if (result.ok) {
              taskContext.task.taskState = result.to;
              // AND WHAT THE TOOL WROTE, or a later reader in THIS turn sees a snapshot taken before
              // it ran. The delivering check is such a reader: a step that collects a requirement and
              // delivers in the same turn (`data_extraction.collecting_requirements` goes straight
              // into `extracting`, which delivers) found no agreement and enforced nothing on the very
              // turn the agreement was made. Measured live before this line existed.
              if (writtenDetails) taskContext.task.details = writtenDetails;
              (taskContext.transitions ??= []).push({ from: result.from, to: result.to });
            }
            payload = taskPayload;
          } else {
            payload = { error: `unknown tool: ${toolUse.name}` };
          }
        } catch (err) {
          payload = { error: err instanceof Error ? err.message : 'tool execution failed' };
        }
        // Observability: which tool the model chose and what it returned (documentCount +
        // classificationsAccessible for the context tools). Tool decisions previously lived only in
        // the analytics steps; this makes them visible in the Lambda logs for diagnosis.
        console.log('[AsyncProcessor] tool call', {
          tool: toolUse.name,
          documentCount: (payload as { documentCount?: number }).documentCount,
          classificationsAccessible: (payload as { classificationsAccessible?: unknown }).classificationsAccessible,
          error: (payload as { error?: string }).error,
        });
        const toolError = (payload as { error?: string }).error;
        toolOutcomes.push({
          name: toolUse.name ?? 'unknown',
          ok: !toolError,
          ...(toolError ? { errorClass: classifyToolError(toolError) } : {}),
        });
        toolResults.push({
          toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: payload }] },
        });
      }
      toolMs += Date.now() - toolExecStart; // accumulate this iteration's tool-execution time
      convMessages.push({ role: 'user', content: toolResults });
      const toolNames = (outMessage?.content ?? [])
        .map((b) => (b as { toolUse?: { name?: string } }).toolUse?.name)
        .filter(Boolean) as string[];
      pushStep(toolNames.length ? `tool:${toolNames.join('+')}` : 'tool-use', toolOutcomes);
      continue;
    }

    response = firstText(outMessage) || 'I processed your request but got an unexpected response format.';
    pushStep('generate');
    break;
  }

  // Guardrail parity (ADR-011): enforce the guardrail out-of-band on
  // the final output, matching what the managed-agent path does automatically.
  response = await applyOutputGuardrail(response, config.guardrailId);

  const bedrockTime = Date.now() - bedrockStart;
  console.log('[AsyncProcessor] Bedrock response received', {
    model: config.model,
    inputTokens,
    outputTokens,
    latencyMs: bedrockTime,
    responseLength: response.length,
    toolsEnabled: useTools,
  });

  return { response, inputTokens, outputTokens, bedrockTime, modelMs, toolMs, steps };
}

// ============================================================
// Long Response Handling
// ============================================================

// Largest raw cut index of `text` whose encodeURIComponent length stays
// within `budget`, preferring a natural boundary (paragraph > sentence >
// word) in the back half. Encoded length is monotonic in prefix length so
// a binary search on the raw index is exact. Guarantees >= 1 char of
// progress so the caller can never loop forever.
function cutIndexByEncoded(text: string, budget: number): number {
  if (encodedLen(text) <= budget) return text.length;
  let lo = 1;
  let hi = text.length;
  let fit = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    // Measure a surrogate-safe prefix so encodeURIComponent never throws on a
    // mid-pair slice; the <=1-char difference is immaterial against the budget.
    if (encodeURIComponent(text.slice(0, surrogateSafeCut(text, mid))).length <= budget) {
      fit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const window = text.slice(0, fit);
  const para = window.lastIndexOf('\n\n');
  if (para > fit * 0.5) return para;
  const sentence = window.lastIndexOf('. ');
  if (sentence > fit * 0.5) return sentence + 1;
  const word = window.lastIndexOf(' ');
  if (word > fit * 0.5) return word;
  // Never return a cut that splits a surrogate pair. If snapping the only
  // fitting index to 0 (a single leading astral char under a tiny budget),
  // include the whole pair so we still make forward progress.
  const safe = surrogateSafeCut(text, fit);
  return safe > 0 ? safe : Math.min(2, text.length);
}

/**
 * Split a response into chunks each of which stays within its ENCODED
 * Content budget (Chime caps the on-the-wire URL-encoded length, not the
 * raw char count). chunk[0] gets a smaller budget because finalize
 * appends the battlestats/ACTIVE_TASK marker to it after the split;
 * continuation chunks use the full budget. Trimming only removes
 * whitespace so a trimmed chunk is still within budget.
 */
export function splitIntoChunks(
  response: string,
  firstBudget: number,
  restBudget: number = firstBudget,
): string[] {
  if (encodedLen(response) <= firstBudget) return [response];

  const chunks: string[] = [];
  let pos = 0;
  let budget = firstBudget;
  while (pos < response.length) {
    const rest = response.slice(pos);
    if (encodedLen(rest) <= budget) {
      const tail = rest.trim();
      if (tail.length > 0) chunks.push(tail);
      break;
    }
    const cut = cutIndexByEncoded(rest, budget);
    const safeCut = cut > 0 ? cut : 1;
    const piece = rest.slice(0, safeCut).trim();
    if (piece.length > 0) chunks.push(piece);
    pos += safeCut;
    budget = restBudget;
  }

  return chunks;
}

/**
 * Handle long responses by splitting into multiple messages.
 * Returns the first chunk (for updating placeholder), sends additional chunks as new messages.
 */
// When the full deliverable is delivered as an ATTACHMENT, the inline
// message must NOT duplicate the whole report (Chime multi-chunk wall +
// an unreadable side-by-side). Show only a concise lede: the model's
// lead approach summary (the long-form prompt instructs it to open with
// a 1-2 sentence summary), bounded so a non-compliant model still can
// not wall the channel. The full content is verifiably in the attachment.
export function buildAttachmentLede(response: string): string {
  const firstPara = (response.split(/\n\s*\n/)[0] || response).trim();
  const MAX = 400;
  if (firstPara.length <= MAX) return firstPara;
  const cut = firstPara.slice(0, MAX);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return (stop > MAX * 0.5 ? cut.slice(0, stop + 1) : cut).trim() + '...';
}

export async function handleLongResponse(
  response: string,
  userType: string,
  channelArn?: string,
  botArn?: string,
  parentMessageId?: string,
): Promise<LongResponseResult> {
  // chunk[0] is the placeholder UPDATE; finalize appends the
  // battlestats/ACTIVE_TASK marker to it AFTER this split, so its budget
  // is the safe Content budget minus reserved marker headroom.
  const firstBudget = CHIME_CONTENT_SAFE - CHUNK0_MARKER_HEADROOM;
  if (encodedLen(response) <= firstBudget) {
    return { content: response };
  }

  const chunks = splitIntoChunks(response, firstBudget, CHIME_CONTENT_SAFE);
  console.log(`Long response split into ${chunks.length} chunks`);

  if (!channelArn || !botArn) {
    const note = '\n\n*(Response truncated due to length)*';
    const cut = cutIndexByEncoded(response, firstBudget - encodedLen(note));
    return { content: response.slice(0, cut).trim() + note };
  }

  const responseGroup = `rg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Mirror the placeholder's ACTUAL visibility onto the continuation chunks.
  // The placeholder's `Target` is what Chime set based on whether the inbound
  // was targeted (an `@assistant`/`@human` message) or a broadcast (1:1, `@all`).
  // Reading it here - rather than trusting a caller-passed target - keeps a
  // broadcast reply's tail public (so every member, including anyone added
  // later, sees the whole answer) and a targeted reply's tail private. If it
  // cannot be read, default to broadcast (never leak a private tail is handled
  // by the placeholder being private too; the safe default here is untargeted).
  let chunkTarget: { MemberArn: string }[] | undefined;
  if (parentMessageId) {
    try {
      const ph = await messagingClient.send(new GetChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: parentMessageId,
        ChimeBearer: botArn,
      }));
      const t = ph.ChannelMessage?.Target;
      if (Array.isArray(t) && t.length > 0) {
        chunkTarget = t
          .filter((x) => x.MemberArn)
          .map((x) => ({ MemberArn: x.MemberArn as string }));
      }
    } catch (err) {
      console.warn('[AsyncProcessor] Could not read placeholder target; sending continuation chunks untargeted:', err);
    }
  }

  for (let i = 1; i < chunks.length; i++) {
    try {
      await messagingClient.send(new SendChannelMessageCommand({
        ChannelArn: channelArn,
        Content: encodeURIComponent(chunks[i]),
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ChimeBearer: botArn,
        // Same visibility as the placeholder (see chunkTarget above).
        ...(chunkTarget ? { Target: chunkTarget } : {}),
        Metadata: JSON.stringify({
          parentMessageId,
          responseGroup,
          continuation: true,
          part: i + 1,
          totalParts: chunks.length,
        }),
      }));
      console.log(`Sent continuation message ${i + 1}/${chunks.length}`);
    } catch (error) {
      console.error(`Failed to send continuation message ${i + 1}:`, error);
      return {
        content: chunks[0] + '\n\n*(Additional content could not be delivered)*',
      };
    }
  }

  return {
    content: chunks[0],
    responseGroup,
    totalParts: chunks.length,
  };
}

// ============================================================
// Message Updates
// ============================================================

/**
 * Update the placeholder message with actual response.
 */
export async function updateMessage(
  channelArn: string,
  messageId: string,
  content: string,
  botArn: string,
  /**
   * WHICH STEP OF THE ANSWER THIS UPDATE IS, and it is REQUIRED.
   *
   * Required rather than defaulted, because the whole point is that a future update path cannot
   * forget to say. A default would be a second inference wearing a different name: whichever value it
   * carried would silently become the claim for every path nobody thought about, which is exactly how
   * `total_ms IS NOT NULL` came to mean "this is the final answer".
   *
   * Only `final` closes the turn. Archival gates `agent_final_at` on it, so an interim update that
   * happens to carry telemetry no longer freezes the completion instant at the wrong moment.
   */
  phase: ResponsePhase,
  metadata?: Record<string, unknown>
): Promise<void> {
  const encodedContent = encodeURIComponent(content);

  // Belt-and-suspenders: callers size Content via handleLongResponse, but
  // a marker-augmented chunk[0] should still never exceed the hard cap.
  if (encodedContent.length > CHIME_CONTENT_MAX) {
    console.error(
      '[AsyncProcessor] encoded Content ' + encodedContent.length + ' over ' +
        CHIME_CONTENT_MAX + ' for message ' + messageId +
        ' - this should not happen after handleLongResponse sizing',
    );
  }

  // A MESSAGE JUST POSTED INTO A FLOW-ASSOCIATED CHANNEL CANNOT BE UPDATED YET. It is `PENDING` until
  // the channel flow returns its callback, and Amazon Chime SDK refuses the update outright:
  // `BadRequestException: No operations allowed for messages in processing`. Every channel here has a
  // flow, so any post-then-update - the broadcast answer is the first - hits this on the first try and
  // would otherwise lose the answer entirely, leaving the placeholder reading "...".
  //
  // Bounded, and only for THAT condition: anything else throws on the first attempt as before.
  // THE PHASE IS MERGED HERE, not at the call sites, so it cannot be lost by one of them assembling
  // its metadata differently - and so it is stamped exactly once, on the same call that performs the
  // update it describes. It is deliberately outside `METADATA_SHED_ORDER`: shedding it would turn a
  // heavy turn into an unclosable one, silently.
  const declaredMetadata = { ...(metadata ?? {}), respPhase: phase };

  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await messagingClient.send(new UpdateChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: messageId,
        Content: encodedContent,
        ChimeBearer: botArn,
        Metadata: safeMetadataString(declaredMetadata),
      }));
      return;
    } catch (err) {
      const inProcessing = /No operations allowed for messages in processing/i.test(
        (err as Error)?.message ?? '',
      );
      if (!inProcessing || Date.now() - startedAt > 10_000) throw err;
      console.log('[AsyncProcessor] message still in flow processing; retrying the update', {
        messageId, attempt,
      });
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

/**
 * The waiting-affordance clear now lives in `battle-waiting-marker.ts` and is re-exported here.
 *
 * It moved because the RESUME stopped being its only caller: a duel that ENDS while a side is still
 * waiting has to take the affordance down too, or an ended duel goes on inviting an answer (DESIGN-BATTLE
 * 2a-i). That caller runs in an API Lambda, which cannot import this module without pulling the entire
 * generation stack along for forty lines of code.
 *
 * Re-exported rather than relocated outright so every existing importer, and the generated `.d.ts`,
 * keeps working. Imported as well as re-exported because the resume path below still calls it, and
 * `export ... from` alone creates no local binding.
 */
export { clearBattleWaitingMarker };

// ============================================================
// Error Handling
// ============================================================

/**
 * Handle processing errors: update placeholder with error message, mark task failed.
 */
export async function handleProcessingError(
  event: AsyncProcessorEvent,
  error: unknown
): Promise<void> {
  console.error('[AsyncProcessor] Error:', error);

  try {
    // Same resolution order as the success path: the placeholder that survived the flow's duplicate
    // guard owns the correlation, and an error notice belongs on the message the user can still see.
    // Honors an explicit /battle-resume placeholder when nothing has claimed the correlation, so an
    // error on a resumed turn lands on the reused "waiting" message rather than a new one.
    const messageId = await resolveDeliveryMessageId(event.correlationId, event.placeholderMessageId)
      // The SAME last resort the success path keeps: when the mapping write failed or was throttled
      // but the placeholder message exists in the channel, the mapping-only poll returns null and,
      // without this scan, the guard below skipped the update entirely - the person's "One moment..."
      // bubble sat forever with no error text, violating this function's own contract that a notice
      // lands on the message the answer would have.
      ?? await scanForPlaceholderMessage(event.channelArn, event.correlationId, event.botArn);
    if (messageId) {
      await updateMessage(
        event.channelArn,
        messageId,
        'Sorry, I encountered an issue processing your request. Please try again.',
        event.botArn,
        // TERMINAL FOR THE PERSON, and deliberately not `final`. Their wait ended, but no answer was
        // produced - counting this as a completion would fold a failure's duration into the average
        // time-to-answer and make a broken turn look like a fast one.
        'error',
      );
    }
  } catch (updateError) {
    console.error('[AsyncProcessor] Failed to update with error message:', updateError);
  }

  if (event.taskId) {
    await updateTaskStatus(
      event.taskId,
      event.channelArn,
      'failed',
      undefined,
      error instanceof Error ? error.message : 'Unknown error'
    );
  }

  // Surface the failure to operators (best-effort; never masks the original error).
  await sendProcessorErrorAlert(event, error);
}

/**
 * Post a processor failure to a configured admin alert channel and, via the channel
 * flow's notify fan-out (channel-flow-processor `parseNotifyDirective`), email the admin
 * roster. Mirrors the membership-audit alert path (`alertAdmins`).
 *
 * Best-effort and NEVER throws: an alerting failure must not mask the original error.
 * Log-only when `ADMIN_ERROR_ALERT_CHANNEL_ARN` / `ADMIN_ALERT_BEARER_ARN` are unset (the
 * default), so a deployment opts in by pointing them at an admin conversation channel and
 * the app-instance-admin ARN (same bearer the membership audit uses). The `notify` directive
 * in Metadata is what the channel flow fans out to email; `analytics.userType=admin` keeps
 * the alert out of classification metrics.
 */
export async function sendProcessorErrorAlert(
  event: AsyncProcessorEvent,
  error: unknown,
): Promise<void> {
  const channelArn = process.env.ADMIN_ERROR_ALERT_CHANNEL_ARN || '';
  const bearerArn = process.env.ADMIN_ALERT_BEARER_ARN || '';
  if (!channelArn || !bearerArn) return; // not configured -> log-only (console.error above)
  try {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const detail = error instanceof Error ? error.message : String(error);
    const truncated = detail.length > 200 ? `${detail.slice(0, 200)}...` : detail;
    const timestamp = new Date().toISOString();
    const subject = `Assistant error: ${errorName} (${event.userType} tier)`;
    const content =
      `**Assistant error** (${event.userType} tier)\n\n` +
      `**Error:** ${errorName}\n` +
      `**Detail:** ${truncated}\n` +
      (event.taskType ? `**Task:** ${event.taskType}\n` : '') +
      `**Channel:** ${event.channelArn}\n` +
      `**Time:** ${timestamp}`;
    await messagingClient.send(new SendChannelMessageCommand({
      ChannelArn: channelArn,
      Content: encodeURIComponent(content),
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      ChimeBearer: bearerArn,
      Metadata: JSON.stringify({
        messageType: 'assistant_error',
        errorType: errorName,
        userType: event.userType,
        timestamp,
        notify: { email: true },
        subject,
        analytics: { userType: 'admin' },
      }),
    }));
    console.log('[AsyncProcessor] Admin error alert sent');
  } catch (alertError) {
    console.error('[AsyncProcessor] Failed to send admin error alert:', alertError);
  }
}

// ============================================================
// Common Pipeline Steps
// ============================================================

/**
 * Shared pipeline: validate event, poll placeholder, load history, consolidate.
 * Returns the common context needed by all classification processors.
 */
export async function runSharedPipeline(event: AsyncProcessorEvent): Promise<{
  messageId: string | null;
  /** Admission: the dedup claim and the task-status write, before any lookup begins. */
  guardMs: number;
  /** What locating the placeholder cost: the mapping read, plus the scan when one was needed. */
  placeholderResolveMs: number;
  /** The scan only, and UNDEFINED when none ran - so a count of these is the fallback RATE. */
  pollMs?: number;
  consolidatedHistory: ConversationMessage[];
  priorAgentContext: string;
  bedrockMessages: ConversationMessage[];
  userSub: string;
  /**
   * First-turn channel rename (title derivation) promise, or undefined when
   * this is not the first user turn. The classification handler MUST await this after
   * posting the reply: it's a separate chain of network calls (DescribeChannel
   * + Haiku InvokeModel + UpdateChannel), and an async Lambda freezes the
   * moment the handler resolves, so an un-awaited rename often never lands.
   */
  titleRename?: Promise<unknown>;
  /** True when this is the user's first message in the channel (drives the first-turn greeting). */
  isFirstUserTurn: boolean;
} | null> {
  const startTime = Date.now();
  const { channelArn, correlationId, userMessage, botArn } = event;

  if (!channelArn || !correlationId || !botArn) {
    console.error('[AsyncProcessor] Missing required fields');
    return null;
  }

  // Dedup guard (SPEC-ABUSE-CONTROLS): claim the correlationId so a duplicate at-least-once
  // delivery of the same message is processed exactly once. The losing invocation returns null
  // (no-op) rather than double-calling Bedrock and clobbering task state (completed -> failed).
  // Paired with the router keying correlationId on the stable CHIME.message.id. Fails open (unset).
  if (!(await claimCorrelation(correlationId))) {
    console.warn('[AsyncProcessor] Duplicate invocation, skipping correlationId:', correlationId);
    return null;
  }

  // Update task status to in_progress if task-based
  if (event.taskId && channelArn) {
    await updateTaskStatus(event.taskId, channelArn, 'in_progress').catch(e =>
      console.error('[AsyncProcessor] Failed to update task status:', e)
    );
  }

  // Step 1: Resolve the placeholder. A /battle resume hands us the existing "waiting" message id
  // explicitly — reuse it (one clean message lifecycle, no orphan) instead of polling for a fresh one.
  //
  // THE CLAIMED OWNER WINS OVER THE HANDED ID, and that is not a detail. Two things race on a
  // duplicate delivery of the same turn, and until now nothing tied them together:
  //  - the channel flow's duplicate-placeholder guard claims `corr#<id>` for the FIRST placeholder to
  //    reach it and DENIES every other, so one placeholder survives in the channel;
  //  - `claimCorrelation` picks one processor, whichever got there first.
  // Nothing made those two the same delivery. When they diverged, this processor wrote the answer
  // over the placeholder its own dispatch created — the one the flow had already denied — and the
  // user watched the surviving "One moment..." forever while a completed answer landed on a message
  // that was no longer in the channel.
  //
  // Reading the claim makes both races resolve to the same message: whatever survived the guard IS
  // the placeholder the answer belongs on. One extra GetItem on the dispatch path, on a table this
  // turn already touches.
  //
  // A miss is normal and means only "not claimed yet" (this processor is dispatched before the
  // placeholder exists), so the handed id still stands.
  //
  // WHERE LOCATING THE PLACEHOLDER STARTS. The clock for it opens HERE and not at handler entry,
  // which is the whole correction: the span above this line is the dedup claim and the task-status
  // write, work that happens whether or not there is a placeholder to find. Timing from entry
  // charged both of them to "polling", so the figure could never reach zero however well the
  // handoff worked - and the ~100ms by which task turns exceeded the rest was updateTaskStatus
  // showing through a metric that claimed to be measuring a scan.
  // ADMISSION ENDS HERE. Everything between handler entry and this instant is the dedup claim and
  // the task-status write - work a turn pays whether or not there is a placeholder to find - and
  // charging it to the lookup is exactly what made the old poll figure unable to reach zero.
  const resolveStart = Date.now();
  const guardMs = resolveStart - startTime;
  const target = resolvePlaceholderTarget(await readPlaceholderMapping(correlationId), event.placeholderMessageId);
  if (target.overrodeHandedId) {
    console.warn('[AsyncProcessor] dispatched placeholder lost the duplicate guard; answering on the claimed one', {
      correlationId, dispatched: event.placeholderMessageId, claimed: target.messageId,
    });
  }
  // THE SCAN IS THE EXCEPTION, AND IS TIMED AS ONE. `pollMs` is left UNDEFINED when the mapping or
  // the handed id already named the target, rather than being written as 0.
  //
  // That distinction is what makes the aggregate readable. A poll is rare and expensive, so a column
  // holding 0 for the common case and seconds for the rare one has a MEAN THAT DESCRIBES NO TURN -
  // it sits in the gap between two populations. Left null, the same column answers both questions
  // the owner asked of it without further arithmetic: COUNT(poll_ms) is how often a scan was needed,
  // and AVG(poll_ms) is what a scan costs WHEN it happens, because AVG skips nulls.
  let messageId: string | null = target.messageId ?? null;
  let pollMs: number | undefined;
  if (!messageId) {
    const pollStart = Date.now();
    messageId = await pollForPlaceholderMessage(correlationId);
    pollMs = Date.now() - pollStart;
  }
  // NOT RESOLVED YET IS NOT A FAILURE. This used to abort the turn here, which was right when the
  // only way to find a placeholder was to search for it: if 22 seconds of scanning found nothing, the
  // placeholder did not exist. The mapping changes that. It is written before the placeholder is
  // released, so a miss after ~3s means only that Chime has not created it YET - and the most common
  // reason is that this processor was dispatched by the router BEFORE the fulfillment response was
  // materialised.
  //
  // So carry on with `messageId` unresolved and let inference run. The placeholder lands during the
  // model call, and the caller resolves it once the answer is ready (`scanForPlaceholderMessage`),
  // which is both later and cheaper: `ListChannelMessages` is billed, and on the happy path it is
  // never called at all.
  //
  // A DUPLICATE DISPATCH DOES NOT REACH HERE. `claimCorrelation(correlationId)` above already
  // collapsed it, so continuing past this point is not duplicate Bedrock spend - that guard, not this
  // one, is what stops a second answer.
  if (!messageId) {
    console.warn(
      '[AsyncProcessor] Placeholder unresolved at dispatch; continuing and resolving at answer time',
      { correlationId },
    );
  } else {
    console.log('[AsyncProcessor] Found placeholder message:', messageId);
  }
  // WHAT IT COST TO LOCATE THE PLACEHOLDER - the mapping read, plus the scan when there was one.
  // This is the number that answers "how long before the turn knew which message to answer on", and
  // it is a SUPERSET of pollMs by exactly the mapping read. Reported alongside rather than instead:
  // the resolve cost is what the turn pays, and the poll rate is the reason it ever moves.
  const placeholderResolveMs = Date.now() - resolveStart;

  // A RESUMED duel side ends its waiting affordance here (ADR-029), as early as it can: the user has
  // answered, this turn is generating, and the question message must stop rendering as "Replying to:"
  // while the answer is produced on the placeholder posted above. The question text is left in place.
  //
  // Awaited rather than fired and forgotten. It is one Chime call against a turn that runs for seconds,
  // and an async Lambda freezes its environment the moment the handler resolves, so a loose promise here
  // is a coin flip. It cannot fail the turn: the helper swallows its own errors.
  if (event.battleContext?.clearWaitingMarkerMessageId) {
    const clearedMarker = await clearBattleWaitingMarker(
      channelArn,
      event.battleContext.clearWaitingMarkerMessageId,
      event.botArn,
    );
    console.log('[AsyncProcessor][battle] resumed side: waiting marker', {
      messageId: event.battleContext.clearWaitingMarkerMessageId,
      cleared: clearedMarker,
    });
  }

  // Step 2: Load conversation history
  let conversationHistory = event.conversationHistory || [];
  if (conversationHistory.length === 0 && channelArn) {
    conversationHistory = await loadChannelHistory(channelArn, event.botArn, userMessage);
    // Role SHAPE alongside the count, because a bare count cannot diagnose a context-loss report:
    // "2" is healthy as `ua` but broken as `aa` (a welcome plus a reply, with the user's own turn
    // missing), and `aa` is promoted wholesale into priorAgentContext below, leaving the model
    // nothing but the current message. The shape distinguishes them; the message CONTENT is
    // deliberately not logged.
    console.log(
      `[AsyncProcessor] Loaded ${conversationHistory.length} messages from channel history`,
      { roles: conversationHistory.map(m => (m.role === 'assistant' ? 'a' : 'u')).join('') },
    );
  }

  // Step 2b: Title rename on the first user turn into a channel still named
  // "New conversation" (no-ops otherwise). Kicked off HERE so it runs
  // concurrently with inference, but the promise is RETURNED so the classification
  // handler can await it after the reply is posted. It must not block the
  // reply, but it must also outlive the reply: an async Lambda freezes the
  // execution environment once the handler resolves, so a purely
  // fire-and-forget rename races and is often suspended before the
  // UpdateChannel lands. See lambda/src/lib/channel-title.ts.
  const isFirstUserTurn = conversationHistory.filter(m => m.role === 'user').length === 0;
  let titleRename: Promise<unknown> | undefined;
  if (isFirstUserTurn) {
    titleRename = (async () => {
      try {
        const { maybeDeriveAndRenameChannel } = await import('./channel-title.js');
        await maybeDeriveAndRenameChannel(channelArn, userMessage, event.botArn);
      } catch (err) {
        console.warn('[AsyncProcessor] Title rename invocation failed:', err);
      }
    })();
  }

  // Step 3: Prepare for Bedrock
  let priorAgentContext = '';
  while (conversationHistory.length > 0 && conversationHistory[0].role === 'assistant') {
    priorAgentContext += conversationHistory.shift()!.content + '\n';
  }

  const consolidatedHistory = consolidateConsecutiveMessages(conversationHistory);

  if (priorAgentContext) {
    console.log('[AsyncProcessor] Promoted leading assistant messages to context');
  }

  const userSub = event.senderArn?.split('/user/').pop() || '';

  // Consolidated INCLUDING the current turn. Consolidation exists because Bedrock requires
  // alternating roles, so appending the current user message to an ALREADY-consolidated history
  // re-introduced the exact adjacency it removes whenever the history ends on a user turn - which is
  // routine, not exotic: it is what remains once the trailing bot message is a placeholder still
  // awaiting its answer, or an assistant turn that was filtered out.
  // The CURRENT turn carries its speaker too (ADR-027 part 1). Without this the person now typing is
  // the one contribution in the transcript with no name on it, and - worse - they would not COUNT
  // toward the "more than one distinct speaker" test, so a turn from a second colleague could go
  // unattributed precisely when attribution started to matter. `senderDisplayName` is the name the
  // router already resolved from the IdP for this turn.
  const currentSpeaker: Speaker | undefined = event.senderArn
    ? {
        id: speakerIdFrom(event.senderArn),
        name: event.senderDisplayName,
        kind: speakerKindFor(event.senderArn, event.botArn || ''),
      }
    : undefined;

  const bedrockMessages = consolidateConsecutiveMessages([
    ...conversationHistory,
    // Length cap (SPEC-ABUSE-CONTROLS): clamp an over-long user turn before the model call.
    // No-op unless MAX_USER_MESSAGE_LENGTH is set.
    // The cap runs BEFORE sanitisation renders it: a forged attribution prefix must not survive by
    // sitting inside a message that was truncated after the strip.
    {
      role: 'user' as const,
      content: capUserMessage(userMessage),
      ...(currentSpeaker && { speaker: currentSpeaker }),
    },
  ]);

  return {
    messageId,
    guardMs,
    placeholderResolveMs,
    pollMs,
    consolidatedHistory,
    priorAgentContext,
    bedrockMessages,
    userSub,
    titleRename,
    isFirstUserTurn,
  };
}

// ============================================================
// Shared Post-Processing
// ============================================================

/**
 * Finalize placeholder mode: handle long response, build analytics, update message.
 */
export async function finalizePlaceholderResponse(params: {
  event: AsyncProcessorEvent;
  response: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  bedrockTime: number;
  messageId: string;
  guardMs: number;
  placeholderResolveMs: number;
  pollMs?: number;
  conversationHistoryLength: number;
  startTime: number;
  activeTaskInfo?: { type: string; status: string; label: string; taskId: string };
  /** SPEC-TASK-STATE-TRANSITIONS: the active-task context, so finalize can stamp taskState +
   *  the net transition applied this turn onto the analytics. Absent on non-task turns. */
  taskContext?: TaskLoopContext;
  attachment?: GeneratedDocument;
  /** The INPUT guardrail blocked this turn before the model ran (structural fact, not text-shape). */
  guardrailBlocked?: boolean;
  wasFallback?: boolean;
  fallbackReason?: string;
  retryCount?: number;
  /**
   * Phase-4 generation-out: images produced this step. Threaded into
   * the battlestats cost so it uses the per-image rate (Titan/Nova)
   * not the token rate. Undefined on every text/vision caller →
   * estimateStepCostUsd keeps its existing token-based behavior.
   */
  imageCount?: number;
  /**
   * /battle: this bot's resolved variant displayName (e.g. "Atlas" /
   * "Echo"), resolved once in the fan-out and passed via
   * battleContext.selfDisplayName. Rides the <!--battlestats:-->
   * marker as `name=` so the frontend scorecard + variant chip show the
   * configured variant name rather than the bot's generic Chime
   * AppInstanceUser name ("Assistant" / "AltSlot0"). Absent on the
   * clarification (WAITING_FOR_USER) path — no scorecard emitted there.
   */
  battleSelfDisplayName?: string;
  /**
   * P4 config attribution — the deployment-config fingerprint (lib/config-identity.ts) the caller
   * resolved (it holds the persona + the forwarded pack version). Stamped onto the turn's analytics
   * so quality is sliceable by config. Absent ⇒ the turn carries no config fingerprint.
   */
  configIdentity?: {
    configId: string;
    personaVersion: string;
    intentPackVersion: string;
    systemPromptHash: string;
  };
  /** Portable-profile attribution: the assistant/profile + version that served this turn (SPEC-ASSISTANT-CONFIG §4). */
  profileAttribution?: { profileName: string; profileConfigId: string; profileVersion?: number };
  /**
   * Per-step telemetry for this turn (one ConverseStep per Converse iteration),
   * from invokeBedrock. Persisted into the out-of-band analytics record ONLY
   * (never the size-capped Chime Metadata) — SPEC-MESSAGE-METADATA-CODEBOOK.md.
   */
  steps?: ConverseStep[];
  /** model_ms / tool_ms split from invokeBedrock (LATENCY-TARGETS.md). Out-of-band only; archival
   *  folds them onto messages.model_ms / messages.tool_ms. Absent on paths that don't run the loop. */
  modelMs?: number;
  toolMs?: number;
}): Promise<void> {
  const {
    event, response, model, inputTokens, outputTokens, bedrockTime,
    messageId, guardMs, placeholderResolveMs, pollMs, conversationHistoryLength, startTime, activeTaskInfo,
    attachment,
  } = params;

  // ============================================================
  // /battle: round-2 NO_REBUTTAL short-circuit
  // ============================================================
  // Per SPEC-BATTLE.md: when a bot opts out of round 2 by emitting the NO_REBUTTAL sentinel, RESOLVE its
  // placeholder to a clear "No rebuttal." state — an UPDATE, not a delete. Updating (via the already-held
  // chime:UpdateChannelMessage) means the opt-out is shown honestly, nothing appears-then-vanishes, and
  // there is NO dependency on chime:DeleteChannelMessage (which the processor role isn't granted — a
  // delete here failed silently and left the placeholder orphaned as a stale "waiting" bubble). The state
  // transition still records terminal status so analytics has the opt-out signal.
  if (event.battleContext?.round === 2 && isNoRebuttal(response)) {
    console.log('[AsyncProcessor][battle] Round-2 NO_REBUTTAL — resolving placeholder to a no-rebuttal state', {
      battleId: event.battleContext.battleId,
      botArn: event.botArn,
    });
    try {
      // A side declining to rebut IS its answer for round 2 - the duel is over for it, and the
      // placeholder resolves to the outcome rather than to a step on the way to one.
      await updateMessage(event.channelArn, messageId, 'No rebuttal.', event.botArn, 'final');
    } catch (err) {
      // Loud: a silently-swallowed failure here is exactly what hid the orphaned-placeholder bug.
      console.error('[AsyncProcessor][battle] Failed to resolve the NO_REBUTTAL placeholder:', err);
    }
    // Record terminal state so analytics has the opt-out signal. No
    // orchestrator fire on round-2 transitions.
    if (event.battleContext) {
      await recordBattleTerminalAndFireOrchestrator({
        battleContext: event.battleContext,
        channelArn: event.channelArn,
        selfBotArn: event.botArn,
        senderArn: event.senderArn,
        response: null, // null → recorded as opt-out (we use FAILED but only for accounting)
        round1MessageId: messageId,
        correlationId: event.correlationId,
        userMessage: event.userMessage,
        classification: event.userType,
        intent: event.intent,
      });
    }
    return;
  }

  // Sticky-mention signal. The frontend's sticky @-mention chip keys off metadata.targetedSender
  // (Chime's WebSocket CREATE does not reliably echo the message Target). Derive it from the
  // placeholder's ACTUAL Chime Target — the SAME authoritative signal handleLongResponse mirrors onto
  // continuation chunks — so it can never drift from the reply's real visibility. A 1:1 AUTO reply is
  // untargeted (the placeholder has no Target) and must NOT be stamped, so no sticky chip appears; a
  // targeted @-mention reply in a multi-party channel is stamped and the chip sets. The signal is
  // DERIVED from the placeholder, never set independently, so it is not mutable out from under the reply.
  let replyIsTargeted = false;
  try {
    const phForTarget = await messagingClient.send(new GetChannelMessageCommand({
      ChannelArn: event.channelArn,
      MessageId: messageId,
      ChimeBearer: event.botArn,
    }));
    const phTarget = phForTarget.ChannelMessage?.Target;
    replyIsTargeted = Array.isArray(phTarget) && phTarget.length > 0;
  } catch (err) {
    console.warn('[AsyncProcessor] Could not read placeholder Target for the sticky-mention signal; treating the reply as untargeted:', err);
  }

  // D: when the deliverable is an attachment, do NOT chunk the full
  // report inline (duplicated wall). Inline = a bounded lede; the full
  // content lives only in the attachment chip.
  // KEEP the placeholder's own text above the answer when the caller asked for it (`messagePrefix` —
  // today, the welcome). Applied to the DELIVERED text only: `response` stays the model's answer alone,
  // so analytics, evals and the battle scorecard are not polluted with copy the model never produced.
  //
  // Prefixed BEFORE sizing, not after, so `handleLongResponse` chunks against what will actually be
  // sent. Prepending to an already-sized chunk would push the first message past the Chime limit.
  const deliverable = event.messagePrefix ? `${event.messagePrefix}\n\n${response}` : response;
  // WHERE THE ANSWER LANDS, AND WHERE THE RECEIPT LANDS. The rule and its reasoning live in
  // `planResumedChainDelivery`; this is the half that talks to Amazon Chime SDK.
  //
  // The answer's message is posted BEFORE sizing so continuation chunks hang off the message the answer
  // is actually in, and inherit ITS target rather than the placeholder's - otherwise a long answer ends
  // up half public.
  const delivery = planResumedChainDelivery({
    resumedChain: event.broadcastAnswer,
    receiptAlreadyGiven: event.suppressAcknowledgement,
    placeholderIsTargeted: replyIsTargeted,
  });
  let deliveryMessageId = messageId;
  /** The message carrying the receipt, when it is the placeholder and still owes its final copy. */
  let acknowledgementMessageId: string | undefined;
  if (delivery.broadcastTheAnswer) {
    // The placeholder is private, so it IS the receipt. The answer needs a public message of its own.
    try {
      const posted = await messagingClient.send(new SendChannelMessageCommand({
        ChannelArn: event.channelArn,
        Content: encodeURIComponent('...'),
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ChimeBearer: event.botArn,
        // No Target. That is the entire point of this branch.
      }));
      if (posted.MessageId) {
        deliveryMessageId = posted.MessageId;
        // Only once the answer HAS somewhere public to go. Re-labelling the placeholder as a receipt
        // when the post failed would replace the person's answer with a note pointing at a message
        // that was never written.
        if (!event.suppressAcknowledgement) acknowledgementMessageId = messageId;
      }
    } catch (err) {
      // Fall back to the placeholder rather than losing the answer. It stays private, which is a
      // degraded duel rather than a missing one.
      console.warn('[AsyncProcessor] could not post the broadcast answer message; answering in place:', err);
    }
  }
  if (delivery.targetTheReceipt) {
    // The placeholder is already public, so it IS the answer. The receipt needs a message of its own,
    // and this is the half that cannot be inherited: there is no inbound target to inherit FROM, so the
    // code names the recipient. Sent with its final copy rather than a placeholder to update later,
    // because a receipt has nothing to wait for.
    //
    // Best-effort: a missing receipt costs the person a confirmation, and losing the answer to protect
    // one would be the worse trade.
    if (event.senderArn) {
      try {
        await messagingClient.send(new SendChannelMessageCommand({
          ChannelArn: event.channelArn,
          Content: encodeURIComponent(RESUMED_CHAIN_ACKNOWLEDGEMENT),
          Type: 'STANDARD',
          Persistence: 'PERSISTENT',
          ChimeBearer: event.botArn,
          Target: [{ MemberArn: event.senderArn }],
        }));
      } catch (err) {
        console.warn('[AsyncProcessor] could not post the private receipt (the answer still lands):', err);
      }
    } else {
      console.warn('[AsyncProcessor] no sender to acknowledge to; the answer lands untargeted with no receipt');
    }
  }

  /**
   * Close out the private placeholder once this turn's output has moved to a message of its own.
   *
   * ONE helper, because both of the turn's exits owe it: the answer, and the clarifying question that
   * asks for more before an answer exists. The exit that forgot is how a person was left watching a
   * "..." bubble that never resolved, beside a message they were never told to look at.
   *
   * The phase is the caller's to declare (`updateMessage` requires one for exactly this reason): the
   * answer ends the person's wait and closes the turn, a question does not.
   *
   * No-op unless the answer actually moved, so an ordinary turn - which answers on the placeholder
   * itself - writes nothing extra.
   */
  const closeOutAcknowledgement = async (phase: ResponsePhase): Promise<void> => {
    if (!acknowledgementMessageId || acknowledgementMessageId === deliveryMessageId) return;
    try {
      await updateMessage(
        event.channelArn,
        acknowledgementMessageId,
        RESUMED_CHAIN_ACKNOWLEDGEMENT,
        event.botArn,
        phase,
      );
    } catch (err) {
      console.warn('[AsyncProcessor] could not close out the private acknowledgement:', err);
    }
  };

  const longResponseResult = attachment
    ? { content: buildAttachmentLede(response) }
    : await handleLongResponse(
        deliverable,
        event.userType,
        event.channelArn,
        event.botArn,
        deliveryMessageId,
      );

  const totalTime = Date.now() - startTime;

  // /battle: surface the clarification measured dimension
  // (project-battle-clarification-measured-dimension) into analytics —
  // how often this bot asked vs. forged ahead, and its active response
  // time (elapsed − time blocked on the user, banked on the row by
  // resumeBotFromWaiting across separate invocations). Analytical only,
  // NOT a user scorecard axis. Best-effort: getBotRow fails open so a
  // telemetry read can never block the bot's reply.
  let battleClarificationMetrics:
    | { clarificationCount: number; activeResponseMs: number }
    | undefined;
  if (event.battleContext) {
    const selfRow = await getBotRow(event.battleContext.battleId, event.botArn);
    battleClarificationMetrics = {
      clarificationCount: selfRow?.clarificationCount ?? 0,
      activeResponseMs: computeActiveResponseMs(totalTime, selfRow?.waitedMs),
    };
  }

  // A non-battle task turn force-completes the task at finalize (see the updateTaskStatus below),
  // but activeTaskInfo was built from the mid-turn taskState. Reflect the terminal status in the
  // stamp so the archived exchange - and the admin Tasks tab, which reads task_status - shows
  // 'completed' rather than the intermediate state. Battle tasks keep their state-machine
  // progression (the force-complete is skipped for a battle mid-chain), so they are excluded here.
  if (activeTaskInfo && event.taskId && !event.battleContext) {
    // AT6: only mark 'completed' once the MACHINE reached a terminal state (or there is no machine); a
    // machine-backed task mid-flow stays 'in_progress' so status never contradicts task_state (e.g.
    // Completed vs still-extracting). Mirrors the DB update below.
    // THE PACK-MERGED MACHINES, not the platform defaults. Omitted, the helper fell back to
    // DEFAULT_TASK_STATE_MACHINES, and a task type declared only by a deployment pack or a profile
    // resolved to no machine at all - which the helper reads as "nothing to progress" and reports
    // COMPLETE. A mid-chain turn then closed the task. The mirror case is as bad: a pack that renames
    // a terminal state leaves the task in_progress for ever.
    const done = shouldMarkTaskCompleted(
      activeTaskInfo.type, params.taskContext?.task.taskState, taskStateMachines(),
    );
    activeTaskInfo.status = done ? 'completed' : 'in_progress';
    activeTaskInfo.label = getTaskLabel(activeTaskInfo.type, activeTaskInfo.status);
  }

  // SPEC-TASK-STATE-TRANSITIONS §6: stamp the machine state after this turn + the net transition
  // (first from → last to) applied this turn, so exchanges are sliceable by state and transitions
  // are countable. Distinct from activeTask.status (the task lifecycle) — this is the machine state.
  const taskTx = params.taskContext?.transitions;
  // A task the router CREATED this turn carries the OPEN edge: `from` is empty, because nothing
  // preceded the initial state. That empty `from` is what the turn-events projection reads as
  // `task_opened` - it is a declared signal (the router set taskCreated when createTask ran), never
  // inferred here. When the model ALSO advanced the machine on its first turn, the open edge wins the
  // `from` slot and the final state wins `to`: opened_at is the fact this record must not lose, and
  // the same-turn advance is still visible as taskState.
  const taskAnalytics = {
    taskState: params.taskContext?.task.taskState,
    taskTransition:
      taskTx && taskTx.length
        ? { from: event.taskCreated ? '' : taskTx[0].from, to: taskTx[taskTx.length - 1].to }
        : event.taskCreated && params.taskContext?.task.taskState
          ? { from: '', to: params.taskContext.task.taskState }
          : undefined,
  };

  // Build analytics metadata
  const analyticsMetadata = buildAnalyticsMetadata({
    messageNumber: conversationHistoryLength + 1,
    userType: event.userType,
    role: 'assistant',
    agentType: event.userType,
    intent: event.intent,
    intentConfidence: event.intentConfidence,
    ...(event.classifierMs !== undefined && { classifierMs: event.classifierMs }),
    ...(event.routerMs !== undefined && { routerMs: event.routerMs }),
    deliveryOption: event.deliveryOption,
    // Forwarded, not inferred. The router declares it; the ledger records it; nothing in between
    // guesses, which is the property that makes a repaired turn distinguishable from a slow one.
    ...(event.trigger && { trigger: event.trigger }),
    bedrockResponse: {
      model,
      inputTokens,
      outputTokens,
      latencyMs: bedrockTime,
    },
    // Image (generation-out) turns: persist the image count so the Effectiveness
    // cost path can price per-image (an image model reports 0 tokens).
    ...(params.imageCount != null && { imageCount: params.imageCount }),
    totalMs: totalTime,
    guardMs,
    placeholderResolveMs,
    ...(pollMs !== undefined && { pollMs }),
    ...(activeTaskInfo && { activeTask: activeTaskInfo }),
    ...(taskAnalytics.taskState && { taskState: taskAnalytics.taskState }),
    ...(taskAnalytics.taskTransition && { taskTransition: taskAnalytics.taskTransition }),
    ...(params.guardrailBlocked && { guardrailBlocked: true }),
    ...(params.wasFallback !== undefined && { wasFallback: params.wasFallback }),
    ...(params.fallbackReason && { fallbackReason: params.fallbackReason }),
    ...(params.retryCount !== undefined && { retryCount: params.retryCount }),
    ...(event.experimentId && { experimentId: event.experimentId }),
    ...(event.variantId && { variantId: event.variantId }),
    // P4 config attribution — stamp the config fingerprint resolved by the caller.
    ...(params.configIdentity && { configIdentity: params.configIdentity }),
    ...(params.profileAttribution && { profileAttribution: params.profileAttribution }),
    // /battle: pass the typed AnalyticsBattleContext.
    // buildAnalyticsMetadata enforces the rollup-safety invariant
    // (battleContext present ⇒ assignmentMode='battle'), so we do NOT
    // hand-set assignmentMode here. steps[] is intentionally NOT put on
    // the Metadata (≤1KB cap; the compact summary rides the Content
    // marker below; large multi-step persistence is a Phase-2 concern).
    ...(event.battleContext
      ? {
          battleContext: {
            battleId: event.battleContext.battleId,
            round: event.battleContext.round,
            selfBotArn: event.battleContext.selfBotArn,
            rivalBotArn: event.battleContext.rivalBotArn,
            ...(battleClarificationMetrics ?? {}),
          },
        }
      // A present experimentId means an active experiment assigned the model, so the turn
      // is probabilistic; otherwise the model came deterministically from classification+intent resolution.
      // Don't mislabel a deterministic turn as an experiment (there may be none on this deployment).
      : { assignmentMode: event.experimentId ? 'probabilistic' : 'deterministic' }),
  });

  // Embed active task indicator for frontend
  let finalContent = longResponseResult.content;
  if (activeTaskInfo) {
    finalContent += `<!--ACTIVE_TASK:${JSON.stringify(activeTaskInfo)}-->`;
  }

  // /battle: compact per-variant scorecard summary. Appended to the
  // Content marker (NOT the ≤1KB Chime Metadata). The placeholder's
  // <!--battle:--> marker is gone after this updateMessage; the chime
  // provider merges these summary fields into the placeholder-derived
  // battle. estCostUsd is null-honest (rate table returns null when it
  // can't estimate → marker emits an empty value → scorecard shows "—").
  if (event.battleContext) {
    const isImageGen = params.imageCount != null;
    const battleCost = estimateStepCostUsd({
      modelId: model,
      tokensIn: inputTokens,
      tokensOut: outputTokens,
      ...(isImageGen && { imageCount: params.imageCount }),
    });
    // Transparency: thread variant displayName + the underlying model's
    // provider + human label (e.g. Claude Sonnet 4.6, Amazon Nova Canvas)
    // + token / image counts. The frontend renders these as a subtitle
    // under the variant name (e.g. Atlas / Claude Sonnet 4.6), with
    // provider in a tooltip, so alt-slot aliases like Pixel and Echo aren't
    // opaque. URI-encoded for values that may carry spaces. Absent or
    // unknown is honest empty (never fabricated).
    let modelLabel = '';
    let providerLabel = '';
    if (isImageGen) {
      const k = imageGenModelIdToKey(model);
      if (k && IMAGE_GEN_MODELS[k]) {
        modelLabel = IMAGE_GEN_MODELS[k].displayName;
        providerLabel = 'amazon';
      }
    } else {
      const k = bedrockModelIdToKey(model);
      if (k) {
        const def = getModelCatalog('us-east-1', '000000000000')[k];
        modelLabel = def?.displayName ?? '';
        providerLabel = def?.provider ?? '';
      }
    }
    const namePart =
      params.battleSelfDisplayName != null && params.battleSelfDisplayName !== ''
        ? `,name=${encodeURIComponent(params.battleSelfDisplayName)}`
        : '';
    const providerPart = providerLabel ? `,provider=${providerLabel}` : '';
    const labelPart = modelLabel ? `,modelLabel=${encodeURIComponent(modelLabel)}` : '';
    const tokensInPart = isImageGen ? '' : `,tokensIn=${inputTokens ?? 0}`;
    const tokensOutPart = isImageGen ? '' : `,tokensOut=${outputTokens ?? 0}`;
    const imageCountPart = isImageGen ? `,imageCount=${params.imageCount}` : '';
    finalContent +=
      `<!--battlestats:battleId=${event.battleContext.battleId}` +
      `,round=${event.battleContext.round}` +
      `,responseMs=${bedrockTime}` +
      `,estCostUsd=${battleCost ?? ''}` +
      `,modelId=${model}` +
      `${providerPart}${labelPart}${tokensInPart}${tokensOutPart}${imageCountPart}` +
      `${namePart}-->`;
  }

  // Build final metadata with optional attachment.
  //
  // `targetedSender`: the frontend's sticky-mention auto-set keys off metadata.targetedSender
  // (Chime's WebSocket CREATE event does NOT reliably echo payload.Target). Stamp it ONLY when the
  // reply is genuinely targeted (replyIsTargeted, derived above from the placeholder's real Target):
  // a 1:1 AUTO reply is untargeted, so it is NOT stamped and no sticky chip appears; a targeted
  // @-mention reply in a multi-party channel is stamped and the chip sets. An @all broadcast
  // placeholder is untargeted too, so nothing is stamped -- correct, a broadcast is not a directed
  // reply to any one member. (This is the piece the earlier Target-mirroring fix missed.)
  // Out-of-band analytics (SPEC-MESSAGE-METADATA-CODEBOOK.md Phase 1; ADR-016).
  // The full analytics blob is the durable record; the Chime Metadata only needs
  // the small set the frontend renders. When the out-of-band store is
  // provisioned (Aurora mode), slim the Metadata and persist the full blob there
  // keyed by this message's id — freeing the 1024 budget and making analytics
  // robust against the cap. When it is NOT provisioned (Athena mode, which has no
  // archival consumer for these fields), keep the full Metadata exactly as before
  // (plus the Phase-0 shedding backstop in safeMetadataString). messageId here is
  // the placeholder id this finalize updates, i.e. the Chime MessageId archival
  // will key on.
  const fullAnalytics = analyticsMetadata as unknown as Record<string, unknown>;
  const messageMetadata: Record<string, unknown> = {
    ...(messageAnalyticsEnabled() ? pickFrontendMetadata(fullAnalytics) : fullAnalytics),
    ...(attachment && { attachment }),
    // AND the answer actually stayed on the targeted message: on a broadcast resume the final moves
    // to a NEW public message (delivery.broadcastTheAnswer), and stamping targetedSender there made
    // the public answer render a directed-reply chip and archive as targeted - contradicting its
    // actual visibility. The stamp describes the message the metadata lands ON, not the placeholder
    // the turn started with.
    ...(replyIsTargeted && !delivery.broadcastTheAnswer && event.senderArn
      && { targetedSender: event.senderArn }),
  };

  // Out-of-band analytics (Phase 1): persist the FULL analytics blob keyed by
  // this message id BEFORE the Chime update, so the row is in place before the
  // (slimmed) message can reach archival via Chime's Kinesis mirror. No-op when
  // the store is unavailable (Athena mode) — see messageMetadata above.
  // steps[] (per-Converse-iteration telemetry) lives ONLY here, never inline:
  // it would blow the 1024 Metadata cap and only archival/admin consume it.
  //
  // ABOVE THE CLARIFICATION BRANCH, AND THAT PLACEMENT IS THE POINT. That branch RETURNS, so while
  // this write sat below it a round-1 clarification produced no analytics row at all: a turn that ran
  // a full Converse loop to compose a question archived with no tokens, no cost, no steps[] and no
  // latency, and the dimension the question is measured FOR (asked vs. forged ahead) lost its cost
  // half. Every delivery branch burns the same compute, so every delivery branch records it - the
  // write belongs to the TURN, not to the shape of its delivery.
  //
  // IT CANNOT FORGE A FINISH, which is the thing to check before moving a telemetry write earlier.
  // Finality is DECLARED (`respPhase`), and the clarification update declares 'interim'; archival
  // merges this record OVER the inline metadata but adds no `respPhase` of its own, so 'interim'
  // stands and `agent_final_at` stays unset. The legacy `total_ms IS NOT NULL` fallback fires only
  // when NO phase was declared, and `clearBattleWaitingMarker` re-sends the message's existing
  // Metadata, so the later marker-clearing update re-declares 'interim' too. A turn that asked a
  // question is now measured without being mistaken for one that answered.
  await writeMessageAnalytics({
    // The message the ANSWER is in, which on a broadcast resume is not the placeholder. Keyed on the
    // wrong id, the analytics row would describe a message carrying an acknowledgement, and the
    // archive would hold the answer with no telemetry attached to it. On the clarification branch it
    // is the message the QUESTION is in, by the same rule: this turn's output.
    messageId: deliveryMessageId,
    channelArn: event.channelArn,
    // steps + the latency split (model_ms/tool_ms) + processorEntryMs (server-clock handler entry, for
    // inbound_ms) ride the out-of-band record only, never the size-capped Chime Metadata (LATENCY-TARGETS.md).
    analytics: {
      ...fullAnalytics,
      ...(params.steps?.length ? { steps: params.steps } : {}),
      ...(params.modelMs !== undefined ? { modelMs: params.modelMs } : {}),
      ...(params.toolMs !== undefined ? { toolMs: params.toolMs } : {}),
      processorEntryMs: startTime,
    },
  });

  // /battle round-1 clarification (SPEC-BATTLE.md "Clarification
  // Routing"). Whether a model asks a clarifying question vs. wrongly
  // forges ahead is a MEASURED battle dimension (see
  // project-battle-clarification-measured-dimension): detection is the
  // explicit NEED_CLARIFICATION sentinel, never substring inference.
  //
  // ONE message, broadcast (ADR-029): this side's public message becomes the QUESTION and stays that
  // way. The second, `Target`-ed question message is gone, and with it the case where a clarification
  // with no resolvable sender left the user with a waiting bubble and no question in it.
  //
  // A clarifying round-1 reply is NOT round-1 completion — the asking bot enters WAITING_FOR_USER so
  // the round-2 orchestrator stays suppressed until this bot later completes (we return BEFORE the
  // task-complete and terminal/orchestrator blocks). Idempotent under retry: markBotWaitingForUser is
  // conditional on state=INVOKED, so a re-delivery returns false and clarificationCount is not
  // double-counted.
  if (event.battleContext?.round === 1) {
    const clarification = parseBattleClarification(longResponseResult.content);
    if (clarification.needsClarification) {
      const clarificationDelivery = planBattleClarificationDelivery({
        battleId: event.battleContext.battleId,
        botArn: event.botArn,
        question: clarification.question,
      });
      // No battlestats scorecard on this branch: the bot has not completed round 1, so `finalContent`
      // above is intentionally unused.
      //
      // THE QUESTION GOES WHERE THE ANSWER WOULD HAVE GONE (`deliveryMessageId`), which on a resumed
      // chain is the public message posted above and on every other turn is the placeholder itself.
      // A question is this turn's output, so it lands on the turn's output message - the same rule
      // ADR-029 states for a first clarification, applied to a resumed side that asks again. Sending it
      // to the placeholder instead left two things wrong at once on a resumed chain: the public "..."
      // was never resolved, and the question was buried in a private message the rival cannot read,
      // which is the concealment ADR-029 reverses.
      await updateMessage(
        event.channelArn,
        deliveryMessageId,
        clarificationDelivery.waitingPlaceholderContent,
        event.botArn,
        // THE UPDATE THAT MOTIVATES THIS WHOLE CHANGE. A side asking the person a clarifying question
        // posts a real, visible update - and it carries worker telemetry, so the old
        // `total_ms IS NOT NULL` proxy read it as the final answer and froze `e2e_ms` at a moment the
        // duel had not finished. The turn continues after this; the person has not been answered.
        'interim',
        messageMetadata,
      );
      // `interim` for the receipt too, and deliberately not `final`: the person's message was picked
      // up and answered with a question, so the turn is a step on the way to an answer rather than the
      // answer. Stamping it `final` here would close the turn on a message carrying no answer.
      await closeOutAcknowledgement('interim');
      const marked = await markBotWaitingForUser({
        battleId: event.battleContext.battleId,
        botArn: event.botArn,
        question: clarification.question,
        correlationId: event.correlationId,
        // The message now HOLDING THE QUESTION. The resume does not answer onto it - it posts its own
        // placeholder (ADR-029) - it only clears this message's `<!--battlewaiting-->` marker so the
        // frontend's waiting affordance ends while the question text stays in the transcript.
        waitingMessageId: deliveryMessageId,
      });
      console.log(
        '[AsyncProcessor][battle] Round-1 clarification — WAITING_FOR_USER (question posted, orchestrator suppressed)',
        {
          battleId: event.battleContext.battleId,
          botArn: event.botArn,
          transitioned: marked,
        },
      );
      return;
    }
  }

  // Update the message the answer lands in (non-clarification path). On a broadcast resume that is the
  // new untargeted message, and the private placeholder is then closed out with a one-line
  // acknowledgement - leaving it saying "one moment" forever, next to an answer it never received,
  // is how a person concludes their reply went nowhere.
  await updateMessage(event.channelArn, deliveryMessageId, finalContent, event.botArn, 'final', messageMetadata);
  // `final` FOR THIS MESSAGE, though the answer is in the other one. This closes the placeholder the
  // person has been watching, at the moment their wait actually ended - which is what its `e2e_ms`
  // should say. Calling it a notice would leave that placeholder measured as never resolved, reporting
  // a measurement gap on a turn that answered correctly.
  await closeOutAcknowledgement('final');

  console.log('[AsyncProcessor] Message updated successfully', {
    placeholderResolveMs,
    pollMs,
    bedrockTime,
    totalTime,
  });

  // Update task status if task-based — but NEVER force-complete a machine-backed task mid-flow (AT6):
  // a task only becomes 'completed' once its state machine reaches a TERMINAL state; before that it
  // stays 'in_progress' so the lifecycle status never contradicts the machine state.
  //
  // NO BATTLE GATE HERE ANY MORE (ADR-023, DESIGN-BATTLE §2a). A battle is not a task: whether a duel
  // side has finished its ROUND is a battle question, and whether a task has reached a terminal state
  // is a task question. This used to skip the update entirely mid-chain on a battle turn, which meant
  // a duel's task progressed differently from an identical non-duel task. `shouldMarkTaskCompleted`
  // already refuses to force-complete a machine-backed task, so the ordinary rule is sufficient and
  // the battle-specific one only made the two paths diverge.
  // `taskStillRunning` is read by the battle block below: a duel side whose chain has more legs to go is
  // BUSY, not finished (ADR-026).
  let taskStillRunning = false;
  if (event.taskId) {
    const machineState = params.taskContext?.task.taskState;
    // Same machine set as the label above, for the same reason - these two decide the SAME fact and
    // must not be able to disagree about which machines exist.
    const taskComplete = shouldMarkTaskCompleted(
      event.taskType ?? params.taskContext?.task.taskType, machineState, taskStateMachines(),
    );
    const status: TaskStatus = taskComplete ? 'completed' : 'in_progress';
    await updateTaskStatus(event.taskId, event.channelArn, status, response.substring(0, 500));
    taskStillRunning = !taskComplete;
  }

  // /battle: record the per-bot terminal state row. On the LAST writer's
  // round-1 transition this also fires round 2. Round-2 transitions are
  // recorded but never refire round-2 (guarded inside the helper).
  //
  // A SIDE'S ROUND IS DONE WHEN IT HAS PRODUCED ITS RESPONSE (ADR-023), and a side still working WITH
  // THE USER has not produced it yet (ADR-026).
  //
  // Those are the same rule, not two. The separation ADR-023 made was that battle completion is never
  // DEFINED BY task terminality - `isBattleRound1Complete` asked a task question to answer a battle one,
  // which gave a task-shaped duel a different completion rule from any other. That stands: there is no
  // such predicate here and a guard test keeps it that way.
  //
  // What a task-shaped side needs is not a different completion rule but the RIGHT STATE between legs.
  // `WAITING_FOR_USER` is already non-terminal and `allBotsTerminal` already ignores it, so the machinery
  // that suspends round 2 for a clarifying question suspends it for a task step too. A side mid-chain is
  // BUSY, not incomplete, and the state machine already had a word for that.
  //
  // Why it matters: a rebuttal of a half-collected report is not a rebuttal. Round 2 firing while one
  // side sat at `collecting_requirements` compared a finished answer against an unfinished one and called
  // it a duel.
  if (event.battleContext) {
    if (event.battleContext.round === 1 && taskStillRunning) {
      const marked = await markBotWaitingForUser({
        battleId: event.battleContext.battleId,
        botArn: event.botArn,
        correlationId: event.correlationId,
        // NOT a clarification: the side did not choose to ask, its state machine needs the next input.
        // Counting these would inflate the measured clarification rate by the task's step count.
        reason: 'task-step',
        // Deliberately NO `waitingMessageId`. The message just updated carries this leg's real answer and
        // the user should keep seeing it; the next leg posts its own. Reusing it would overwrite the step
        // the user is reading in order to say "one moment" again.
      });
      console.log('[AsyncProcessor][battle] round-1 task leg done, chain still running — WAITING_FOR_USER', {
        battleId: event.battleContext.battleId,
        botArn: event.botArn,
        taskId: event.taskId,
        taskState: params.taskContext?.task.taskState,
        transitioned: marked,
      });
      return;
    }
    const fired = await recordBattleTerminalAndFireOrchestrator({
      battleContext: event.battleContext,
      channelArn: event.channelArn,
      selfBotArn: event.botArn,
      senderArn: event.senderArn,
      response: longResponseResult.content,
      round1MessageId: messageId,
      correlationId: event.correlationId,
      userMessage: event.userMessage,
      classification: event.userType,
      intent: event.intent,
    });
    if (fired) {
      console.log('[AsyncProcessor][battle] Fired orchestrator for round 2', {
        battleId: event.battleContext.battleId,
      });
    }
  }
}

// ============================================================
// Document Generation
// ============================================================

/**
 * Detect if user explicitly asked for a document/file attachment.
 */
export function isDocumentRequest(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  const patterns = [
    'write this as a document',
    'save as a file',
    'save this as a file',
    'save as a document',
    'create a document',
    'create a file',
    'generate a document',
    'generate a report',
    'write a report',
    'as a markdown file',
    'as an md file',
    'as a .md file',
    'export as',
    'download as',
    'save to file',
    'write to a file',
    'attach as a file',
    'provide as an attachment',
    'as an attachment',
    'give me a file',
  ];
  return patterns.some(p => lower.includes(p));
}

/**
 * Deterministic check: is THIS assistant response an actual deliverable document (a finished report
 * or a formatted data extraction) — as opposed to a short clarifying question or an outline-for-approval?
 *
 * File delivery for document-producing tasks (report_generation, data_extraction) is gated on THIS
 * (the output), not on the task's machine state, because the model reliably PRODUCES the deliverable
 * but does NOT reliably advance the state machine to its delivery state on the turn it writes it
 * (verified live: reports frequently emit in full while the task is still in `drafting_outline`, so a
 * start-state gate silently dropped the file). Keying on the output makes delivery reliable. A short
 * clarifying/outline turn fails the substance+structure bar, so a few-line follow-up is never turned
 * into a file (the originally reported bug).
 *
 * A deliverable document is SUBSTANTIAL (a clarifying question is never this long) AND STRUCTURED like a
 * document: a markdown heading, a markdown table (an extraction's natural shape), or several list items
 * in a long body — AND it must not be SOLICITING input (see solicitsInput).
 */
export function isDeliverableDocument(response: string | null | undefined): boolean {
  const text = (response || '').trim();
  if (text.length < 500) return false; // a clarifying question / one-liner never reaches this
  const hasHeading = /(^|\n)#{1,6}\s+\S/.test(text); // "# Title" / "## Section"
  const hasTable = /(^|\n)\s*\|.+\|\s*\n\s*\|[-:\s|]+\|/.test(text); // markdown table w/ header rule
  const listItems = (text.match(/(^|\n)\s*(?:[-*]\s+|\d+\.\s+)\S/g) || []).length;
  // A requirements-gathering turn is ASKING, never delivering, however long and tidy it looks.
  // Length + structure alone cannot tell the two apart, so veto on intent first.
  if (solicitsInput(text)) return false;
  // A heading or a table is a strong document signal; a plain list needs several items AND a long
  // body so a 3-bullet answer doesn't masquerade as a deliverable.
  return hasHeading || hasTable || (listItems >= 4 && text.length >= 800);
}

// Phrases a requirements-gathering turn opens with. Matched only in the OPENING window: a turn that
// asks for input announces it up front ("to get started, please provide the following details"),
// whereas a delivered report may legitimately use the same words deep in its body (a recommendations
// section saying "let me know"), so an anywhere-match would suppress real deliverables.
const SOLICITATION_OPENERS = [
  'please provide', 'please share', 'please confirm', 'please specify', 'please answer',
  'could you provide', 'could you share', 'could you confirm', 'could you clarify',
  'can you provide', 'can you share', 'can you confirm', 'can you clarify',
  'let me know', 'to get started', 'before i can', 'before i begin', 'before i start',
  'i need the following', "i'll need", 'i will need', 'i need a few', 'need some details',
  'gathering the requirements', 'gather the requirements', 'a few questions', 'some questions',
  'the following details', 'the following information', 'to tailor', 'to better tailor',
];
const SOLICITATION_WINDOW = 400;

/**
 * Is THIS response asking the user for information rather than delivering content?
 *
 * The structural bar (substantial + structured) cannot separate a finished report from a long,
 * well-formatted questionnaire: a verbose model answering a `collecting_requirements` turn writes
 * "Please provide the following details:" followed by a numbered list, which clears both the length
 * and the list-item bar. Live-verified on the standard classification, where such a turn was uploaded
 * as `report-*.md` AND completed the task while it was still asking (the completion gate keys on
 * isDeliverableDocument, so a false positive here both attaches the wrong thing and closes the task).
 *
 * Two signals, each scoped to keep real deliverables safe:
 *  1. A solicitation phrase in the opening window (see SOLICITATION_OPENERS).
 *  2. Two or more questions in a body with NO heading and NO table. A heading or a table is a strong
 *     document signal, so this only ever vetoes the WEAK list-only branch — which is precisely the
 *     shape a requirements questionnaire takes.
 */
export function solicitsInput(response: string | null | undefined): boolean {
  const text = (response || '').trim();
  if (!text) return false;
  const opening = text.slice(0, SOLICITATION_WINDOW).toLowerCase();
  if (SOLICITATION_OPENERS.some(p => opening.includes(p))) return true;
  const hasHeading = /(^|\n)#{1,6}\s+\S/.test(text);
  const hasTable = /(^|\n)\s*\|.+\|\s*\n\s*\|[-:\s|]+\|/.test(text);
  if (!hasHeading && !hasTable && (text.match(/\?/g) || []).length >= 2) return true;
  return false;
}

export interface GeneratedDocument {
  fileKey: string;
  name: string;
  size: number;
  type: string;
}

const s3Client = new S3Client({ region: AWS_REGION });

/**
 * Generate a markdown document from content and upload to S3.
 * Used by standard/premium processors for report_generation tasks.
 */
export async function generateAndUploadDocument(
  content: string,
  channelArn: string,
  taskType: string,
  bucketName: string,
): Promise<GeneratedDocument> {
  const channelId = channelArn.split('/').pop() || 'unknown';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Name the file for the task that produced it (report-*, extract-*), else a neutral document-*.
  const prefix = taskType === 'data_extraction' ? 'extract' : taskType === 'report_generation' ? 'report' : 'document';
  const fileName = `${prefix}-${timestamp}.md`;
  const fileKey = `generated-docs/${channelId}/${fileName}`;

  const bodyBuffer = Buffer.from(content, 'utf-8');

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
    Body: bodyBuffer,
    // The charset is declared, or a viewer decodes these UTF-8 bytes as windows-1252 and every
    // em-dash renders as mojibake (reported live 2026-08-18 on a delivered report).
    ContentType: 'text/markdown; charset=utf-8',
    ServerSideEncryption: 'AES256',
    Metadata: {
      channelArn,
      taskType,
      generatedAt: new Date().toISOString(),
    },
  }));

  console.log('[AsyncProcessor] Document uploaded:', fileKey);

  return {
    fileKey,
    name: fileName,
    size: bodyBuffer.length,
    type: 'text/markdown',
  };
}

// ============================================================
// Shared Task Utilities
// ============================================================

/**
 * Human-readable labels for task type + state combinations.
 * Used by standard and premium processors for ACTIVE_TASK metadata.
 */
const TASK_LABELS: Record<string, Record<string, string>> = {
  guided_troubleshooting: {
    collecting_symptoms: 'Collecting symptoms',
    diagnosing: 'Diagnosing issue',
    proposing_solutions: 'Proposing solutions',
    awaiting_result: 'Awaiting result',
    resolved: 'Resolved',
    escalated: 'Escalated',
  },
  data_extraction: {
    collecting_requirements: 'Collecting requirements',
    extracting: 'Extracting data',
    validating: 'Validating results',
    formatting: 'Formatting output',
    completed: 'Completed',
  },
  report_generation: {
    collecting_requirements: 'Collecting requirements',
    drafting_outline: 'Drafting outline',
    generating: 'Generating report',
    revising: 'Revising report',
    completed: 'Completed',
  },
  place_item: {
    collecting: 'Choosing where it goes',
    confirming: 'Confirming the add',
    placed: 'Added',
  },
  action_item: {
    gathering: 'Gathering details',
    options_presented: 'Reviewing options',
    awaiting_completion: 'Awaiting completion',
    completed: 'Done',
  },
};

export function getTaskLabel(
  taskType: string,
  taskState: string,
  machines?: Record<string, TaskStateMachine>,
): string {
  // 1. WHAT THE MACHINE SAYS. A task machine is per-deployment configuration, so its author is the one
  //    who can name their own states. `TASK_LABELS` below cannot: it is a hardcoded table keyed by the
  //    SHIPPED task types, so a pack-declared type or a renamed state never had a label at all - the
  //    same hardcoded-list shape the delivery gate already retired for exactly this reason.
  const declared = machines?.[taskType]?.states?.[taskState]?.label;
  if (declared?.trim()) return declared.trim();

  // 2. The shipped table, which still names the five default machines' states.
  const known = TASK_LABELS[taskType]?.[taskState];
  if (known) return known;

  // 3. DERIVED FROM THE STATE, never the bare task type. The old fallback returned `taskType`, so a
  //    state the table did not know showed the person a key: "report_generation" in the status chip
  //    (owner, measured in the live app). A state name is a key we chose, so reshaping it is
  //    presentation rather than a language judgement: `drafting_outline` -> "Drafting outline".
  const source = taskState?.trim() || taskType?.trim() || '';
  if (!source) return '';
  const words = source.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Detect if the LLM response indicates a state transition should happen.
 * Uses keyword heuristics per task type. The keywords list can be extended
 * by passing additional patterns.
 */
export function detectStateTransition(
  response: string,
  taskType: string,
  currentState: string,
  stateMachine: Record<string, string[]>,
): boolean {
  const states = stateMachine[taskType];
  if (!states) return false;

  const currentIndex = states.indexOf(currentState);
  if (currentIndex === -1 || currentIndex >= states.length - 1) return false;

  const lower = response.toLowerCase();

  if (taskType === 'guided_troubleshooting') {
    if (currentState === 'collecting_symptoms' && (lower.includes('based on') || lower.includes('likely cause') || lower.includes('root cause') || lower.includes('likely'))) return true;
    if (currentState === 'diagnosing' && (lower.includes('suggest') || lower.includes('recommend') || lower.includes('solution') || lower.includes('try'))) return true;
    if (currentState === 'proposing_solutions' && (lower.includes('did that work') || lower.includes('did that') || lower.includes('let me know') || lower.includes('result'))) return true;
  }

  if (taskType === 'data_extraction') {
    if (currentState === 'collecting_requirements' && lower.includes('extract')) return true;
    if (currentState === 'extracting' && (lower.includes('validat') || lower.includes('verify'))) return true;
    if (currentState === 'validating' && lower.includes('format')) return true;
  }

  if (taskType === 'report_generation') {
    if (currentState === 'collecting_requirements' && lower.includes('outline')) return true;
    if (currentState === 'drafting_outline' && (lower.includes('generat') || lower.includes('draft'))) return true;
    if (currentState === 'generating' && (lower.includes('revis') || lower.includes('feedback'))) return true;
  }

  // place_item: advance on the PROPOSAL, not prose — `collecting` →
  // `confirming` once the assistant emits the add_item proposal marker (the robust signal, not a keyword).
  if (taskType === 'place_item') {
    if (currentState === 'collecting' && response.includes('<!--proposal:')) return true;
  }

  // action_item: a tracked action item progresses by conversation.
  // Heuristic (the value is the tracked task; the persona drives quality): present options (a deep-link
  // appears) → hand off → confirm done.
  if (taskType === 'action_item') {
    if (currentState === 'gathering' && (/https?:\/\//.test(response) || lower.includes('option') || lower.includes('to complete') || lower.includes('deep-link'))) return true;
    if (currentState === 'options_presented' && (lower.includes('once you') || lower.includes('after you complete') || lower.includes('let me know'))) return true;
    if (currentState === 'awaiting_completion' && (lower.includes('completed') || lower.includes('done') || lower.includes('all set') || lower.includes('confirmed'))) return true;
  }

  return false;
}

/**
 * Build the active-task context for the Converse loop (SPEC-TASK-STATE-TRANSITIONS). Returns
 * undefined unless the turn belongs to a machine-backed task with a current state — only then are
 * the task tools registered. Captures `initialState` (the pre-turn state) for the shadow comparison.
 */
export async function buildTaskLoopContext(args: {
  taskId?: string;
  taskType?: string;
  channelArn: string;
  messageId?: string;
  /** Per-assistant task machines from the resolved profile (SPEC-CONFIGURABLE-ASSISTANTS 4.5). When
   *  present they are PREFERRED over the deployment pack, MERGED per taskType so a profile can override a
   *  subset and inherit the rest. Absent ⇒ the deployment pack alone (byte-identical to before 4.5). */
  machines?: Record<string, TaskStateMachine>;
  /** The bot answering this turn, as a principal id (see TaskLoopContext.assistantId). */
  assistantId?: string;
}): Promise<TaskLoopContext | undefined> {
  if (!args.taskId || !args.taskType) return undefined;
  const base = taskStateMachines();
  const machines = args.machines ? { ...base, ...args.machines } : base;
  if (!machines[args.taskType]) return undefined;
  const task = await getTask(args.taskId, args.channelArn);
  if (!task || !task.taskState) return undefined;
  return {
    task, machines, messageId: args.messageId, initialState: task.taskState, transitions: [],
    ...(args.assistantId ? { assistantId: args.assistantId } : {}),
  };
}

/**
 * Shadow-mode comparison (SPEC-TASK-STATE-TRANSITIONS §8). The authoritative advance now happens via
 * the advance_task_state tool inside the loop; here the LEGACY keyword detector runs in LOG-ONLY mode
 * against the pre-turn state, emitting `keyword_would_have_advanced` so the old race rate is
 * measurable on real traffic. It NEVER mutates state. Logs only when either signal fired, to keep the
 * shadow log sparse.
 */
export function shadowKeywordTransition(response: string, ctx: TaskLoopContext, tag: string): void {
  const taskType = ctx.task.taskType;
  const from = ctx.initialState;
  if (!taskType || !from) return;
  // Detect against the RESOLVED machines this loop is running (per-assistant, 4.5), derived to the
  // state-name shape — not the deployment-default const — so the shadow measures the real graph.
  const keywordWouldAdvance = detectStateTransition(response, taskType, from, stateNamesOf(ctx.machines));
  const toolAdvanced = (ctx.transitions?.length ?? 0) > 0;
  if (keywordWouldAdvance || toolAdvanced) {
    console.log(
      '[task-state][shadow] ' +
        JSON.stringify({
          tag,
          taskType,
          from,
          keyword_would_have_advanced: keywordWouldAdvance,
          tool_advanced: toolAdvanced,
          tool_transitions: ctx.transitions ?? [],
        }),
    );
  }
}

/**
 * SPEC-TASK-STATE-TRANSITIONS §7 stall telemetry. On an active-task turn that applied NO transition,
 * bump the task's `turnsInState` (and emit `task_state_stalled` past the threshold). A no-op when the
 * tool advanced this turn — a transition resets the counter in advanceTaskStateTo. Best-effort.
 */
export async function recordStallIfNoTransition(ctx: TaskLoopContext | undefined): Promise<void> {
  if (!ctx || (ctx.transitions?.length ?? 0) > 0) return;
  await recordNoTransitionTurn(ctx.task);
}

/**
 * Post the "you're set to handle this" hand-off notice for a work item assigned to ANOTHER participant
 * Fires e.g. when an `action_item` task enters `awaiting_completion`.
 * The assignee is recovered from the channel roster (matchAssigneeInRoster) and the bot message is
 * tagged with a `notify` directive so the channel-flow processor fans it out to their email. Skips
 * silently when the assignee is the person currently chatting (they need no email), when the assignee
 * can't be matched in the roster, or when there's no assignee. Best-effort; never throws.
 */
export async function postTaskHandoffNotice(args: {
  channelArn: string;
  botArn: string;
  task: Task;
  roster: RosterParticipant[];
  senderArn?: string;
}): Promise<boolean> {
  const senderSub = args.senderArn?.split('/user/').pop();
  const owner = resolveTaskOwner(args.task);
  // An ASSISTANT owner is not notified, and this is now a branch rather than a fallthrough (ADR-024).
  // It used to fall out of `matchAssigneeInRoster` returning null, which also happens when the human
  // owner has LEFT the conversation — so a dropped notification and a bot owner were indistinguishable.
  if (!owner || owner.type !== 'user') return false;
  // Only notify a hand-off to SOMEONE ELSE — the owner chatting right now needs no email.
  if (owner.id === senderSub) return false;
  const target = matchAssigneeInRoster(owner.id, args.roster);
  if (!target) return false;
  const notice = buildAssignmentNotice(args.task);
  try {
    await messagingClient.send(new SendChannelMessageCommand({
      ChannelArn: args.channelArn,
      Content: notice.content,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      ChimeBearer: args.botArn,
      Metadata: JSON.stringify({
        botResponse: true,
        systemAnnouncement: 'task_assignment',
        notify: { email: true },
        notifyTargets: [target],
        notifySubject: notice.subject,
      }),
    }));
    return true;
  } catch (err) {
    console.warn('[postTaskHandoffNotice] failed (non-fatal):', err);
    return false;
  }
}

// ============================================================
// /battle (SPEC-BATTLE.md)
// ============================================================

const NO_REBUTTAL_PATTERN = /^\s*NO[_\s]?REBUTTAL\s*[.!]*\s*$/i;
// /battle TASK_* clarification sentinel. SPEC-BATTLE.md: a battle bot
// that genuinely needs input asks exactly ONE concise question and
// emits this token on its OWN line. Like NO_REBUTTAL it is an explicit
// model signal, NOT keyword/substring inference (see the
// project_battle_clarification + no-string-matching rules): the line
// anchors (^…$ with /m) mean prose that merely mentions "clarification"
// can never false-positive. Horizontal-whitespace classes only (never
// \s) so the /m anchors stay line-scoped.
const NEED_CLARIFICATION_LINE = /^[ \t]*NEED[_ \t]?CLARIFICATION[ \t]*[.!:]*[ \t]*$/im;
const lambdaClient = new LambdaClient({ region: AWS_REGION });
const BATTLE_ORCHESTRATOR_ARN = process.env.BATTLE_ORCHESTRATOR_ARN;

// SPEC-BATTLE.md "Clarification Routing": whether a model asks vs. forges
// ahead is a MEASURED dimension (project-battle-clarification-measured-
// dimension), detected from an explicit model signal, NOT keyword/substring
// inference. The NEED_CLARIFICATION sentinel above is what
// parseBattleClarification detects to drive WAITING_FOR_USER; a round-1 turn is
// now a fully normal request (no battle-specific prompt constraints), so a
// model that genuinely needs input still emits the sentinel and is routed.

/**
 * Round-2 rebuttal context (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "Battle
 * delegates to the normal engine"). A battle round-2 turn is a NORMAL request
 * with a minimal, non-adversarial note appended: the rival's round-1 reply plus
 * an invitation to build on / correct / extend it, or opt out with the
 * NO_REBUTTAL sentinel (still detected by isNoRebuttal). This is coordination
 * context the worker cannot derive itself, not a battle prompt constraint.
 * Pure.
 */
export function buildRebuttalContext(rivalDisplayName: string, rivalReply: string): string {
  const rival = rivalDisplayName || 'the other assistant';
  const reply = rivalReply || '(no reply)';
  return `\n\n[This is your REBUTTAL turn in a head-to-head battle. You and ${rival} have ALREADY answered the same prompt - your answer is above in the conversation, and ${rival}'s answer is shown below. This turn is a short written rebuttal ABOUT the two answers: do NOT produce a fresh answer, do NOT restate yours, and do NOT run any tools or generate anything new. Make the case for why YOUR answer is the better one - be specific about where yours is stronger, more accurate, or more useful, and where ${rival}'s falls short or missed something. Be pointed but fair; do not be gratuitously dismissive. If ${rival}'s answer is genuinely better or equal and you have nothing to add, respond with the single token NO_REBUTTAL.]\n<other_reply>\n${reply}\n</other_reply>`;
}

/**
 * Image-battle round-2 addendum. Appended to buildRebuttalContext ONLY when the rival's round-1
 * output was an image that has been resolved into a Converse vision block on the conversation (so the
 * model can actually see it). Points the assistant at the image it now perceives in the shared
 * conversation. buildRebuttalContext's wording is unchanged; this is an additive one-liner. Pure.
 */
export function buildRebuttalImageNote(rivalDisplayName?: string): string {
  const rival = rivalDisplayName || 'the other assistant';
  return `\n\n[This is an IMAGE battle. You have ALREADY generated your own image - do NOT generate another one and do NOT say you are unable to generate images. ${rival}'s image is shown to you above in the conversation. Look at ${rival}'s image and critique it specifically, then argue why YOUR image answered the prompt better - be concrete about what theirs gets wrong or leaves out.]`;
}

/**
 * Round-1 battle awareness. A light note so the assistant knows it is in
 * battle mode and that a rebuttal turn follows, WITHOUT the old adversarial
 * constraints or length caps (round-1 content and length stay normal). The
 * rebuttal turn itself is coached separately by buildRebuttalContext.
 */
export function buildBattleAwareness(rivalDisplayName: string): string {
  const rival = rivalDisplayName || 'another assistant';
  return `\n\n[You are in battle mode: ${rival} is answering the same prompt at the same time. Answer normally, in your own style. After both replies are posted you will get a turn to respond to theirs.]`;
}

/**
 * Phase-3 vision-in: consolidate "which model is this battle variant +
 * does the turn have a usable image + can the model read it" into one
 * pure decision, so the in-flight classification processor just branches on the
 * result. Pure (catalog via placeholder region/account — visionCapable
 * is region-independent).
 *
 *   - text             → no image; normal text battle.
 *   - vision           → send a Converse image block. `imageFormat` is
 *                        the validated Converse format.
 *   - reject-text-only → the variant posts `rejectMessage` (no Bedrock
 *                        call). Triggered by: text-only model, an
 *                        unresolvable model key, OR an image whose
 *                        content type Converse can't take (we never
 *                        send a malformed image block).
 */
export interface BattleVisionPlan {
  action: VisionBattleAction;
  modelKey: BackendModelKey | null;
  imageFormat?: ConverseImageFormat;
  rejectMessage?: string;
}

export function resolveBattleVisionPlan(input: {
  /** Alt-slot variant key (e.g. 'opus'); undefined on the default-bot side. */
  variantModelKey?: string;
  /** The effective Bedrock model id for this invocation (default side / fallback). */
  baseModelId: string;
  hasImageAttachment: boolean;
  imageContentType?: string;
}): BattleVisionPlan {
  const catalog = getModelCatalog('us-east-1', '000000000000');
  const key =
    (input.variantModelKey && input.variantModelKey in catalog
      ? (input.variantModelKey as BackendModelKey)
      : bedrockModelIdToKey(input.baseModelId)) || null;

  if (!input.hasImageAttachment) {
    return { action: 'text', modelKey: key };
  }

  // Image present but we can't confirm a vision-capable model → reject
  // rather than risk sending an image to a model that can't read it.
  if (!key) {
    return {
      action: 'reject-text-only',
      modelKey: null,
      rejectMessage: visionRejectMessage(input.baseModelId),
    };
  }

  const action = resolveVisionBattleAction(key, catalog, true);
  if (action === 'reject-text-only') {
    return { action, modelKey: key, rejectMessage: visionRejectMessage(key) };
  }

  // action === 'vision' — but only if Converse can actually take the
  // image format; otherwise reject (no malformed block).
  const imageFormat = imageFormatFromContentType(input.imageContentType);
  if (!imageFormat) {
    return { action: 'reject-text-only', modelKey: key, rejectMessage: visionRejectMessage(key) };
  }
  return { action: 'vision', modelKey: key, imageFormat };
}

/**
 * Generation-out plan (pure; the gen-out analogue of resolveBattleVisionPlan).
 * `'generation'` ONLY when `imageGenModelId` resolves to a registered image model
 * (IMAGE_GEN_MODELS); absent or unknown → `'text'` so the turn proceeds as a
 * normal text turn rather than fabricating or crashing. The unknown-but-present
 * case is a deployer misconfig — the planner stays pure; the processor logs that
 * visibly (no silent string-matching inference).
 *
 * Source-agnostic (DESIGN-MULTI-ASSISTANT-TURN-ENGINE, "image generation must become a normal
 * capability"): the caller resolves `imageGenModelId` from EITHER a battle variant's image model OR
 * the active profile's `models.image` on an `image_generation` turn, then hands the resolved id here.
 * This function only validates the id against the registry — it does not know or care about the source.
 */
export interface GenerationOutPlan {
  action: 'generation' | 'text';
  /** The validated Bedrock image-gen model id (generation only). */
  modelId?: string;
  modelKey?: ImageGenModelKey;
  displayName?: string;
}

export function resolveGenerationOutPlan(input: {
  imageGenModelId?: string;
}): GenerationOutPlan {
  const key = imageGenModelIdToKey(input.imageGenModelId);
  if (!key) return { action: 'text' };
  const def = IMAGE_GEN_MODELS[key];
  return {
    action: 'generation',
    modelId: def.bedrockModelId,
    modelKey: key,
    displayName: def.displayName,
  };
}

/** Back-compat alias (the plan is no longer battle-specific — image gen is a normal capability now).
 *  Kept so existing callers/tests importing the old name keep working. */
export const resolveBattleGenerationOutPlan = resolveGenerationOutPlan;
/** @deprecated Use {@link GenerationOutPlan}. */
export type BattleGenerationOutPlan = GenerationOutPlan;

/** Map an `ImageGenModelKey` to its Bedrock image-gen id, or undefined for an absent/unknown key. */
function imageGenKeyToBedrockId(key: string | undefined): string | undefined {
  const k = key as ImageGenModelKey | undefined;
  return k && IMAGE_GEN_MODELS[k] ? IMAGE_GEN_MODELS[k].bedrockModelId : undefined;
}

/**
 * Pure. Resolve the Bedrock image-gen model id for THIS turn (the normal-turn generation trigger), in
 * precedence (DESIGN-MULTI-ASSISTANT-TURN-ENGINE "Modality follows the profile"):
 *   1. the battle variant's image model (`variantImageModelKey`) — an image battle compares the two
 *      variants' image models; preferred over the profile so each side runs its assigned image model;
 *   2. the legacy battle `imageGenModelId` (resolveBattleImageGenPair path) — kept working, unchanged;
 *   3. the NON-battle experiment variant's image model (`experimentImageModelKey`), ONLY on an
 *      `image_generation` turn — an image experiment A/Bs its variants' image models on normal traffic,
 *      so the assigned variant's image model wins over the profile default (battle is just UI+scoring on
 *      top; the resolved model is the same either way);
 *   4. the active profile's `models.image` (`profileImageModelKey`), ONLY on an `image_generation` turn
 *      — this is the NORMAL, no-experiment image path.
 * Battle-sourced ids (1, 2) apply only when `battleOn`; the experiment and profile paths are
 * intent-gated. Returns undefined ⇒ a text turn. The caller feeds the result to
 * {@link resolveGenerationOutPlan} for registry validation, so an unknown key here still resolves to a
 * `'text'` plan (honest, never fabricated).
 */
export function resolveTurnImageGenModelId(input: {
  battleOn: boolean;
  intent?: string;
  variantImageModelKey?: string;
  battleImageGenModelId?: string;
  experimentImageModelKey?: string;
  profileImageModelKey?: string;
}): string | undefined {
  const variantId = input.battleOn ? imageGenKeyToBedrockId(input.variantImageModelKey) : undefined;
  const legacyBattleId = input.battleOn ? input.battleImageGenModelId : undefined;
  const isImageTurn = input.intent === 'image_generation';
  const experimentId = isImageTurn ? imageGenKeyToBedrockId(input.experimentImageModelKey) : undefined;
  const profileId = isImageTurn ? imageGenKeyToBedrockId(input.profileImageModelKey) : undefined;
  return variantId ?? legacyBattleId ?? experimentId ?? profileId;
}

/**
 * After a battle invocation's Bedrock call completes, write the per-bot
 * terminal state row and (if last writer) fire the orchestrator. Caller
 * provides the response text — null/undefined indicates a failure that
 * should be recorded as state=FAILED.
 *
 * Returns true iff this caller's transition write claimed the row
 * (i.e., the bot just reached terminal state) AND all bots are now
 * terminal AND this caller successfully claimed the orchestrator-fire
 * sentinel. The caller can use this to log "I fired round 2."
 */

export async function recordBattleTerminalAndFireOrchestrator(args: {
  battleContext: BattleContextPayload;
  channelArn: string;
  selfBotArn: string;
  senderArn?: string;
  response: string | null;
  round1MessageId?: string;
  correlationId: string;
  /** Original /battle user message text — passed through to the orchestrator's round-2 payload. */
  userMessage: string;
  /** The channel's classification, so round 2 answers where round 1 did rather than on premium. */
  classification?: string;
  /**
   * The intent this turn was CLASSIFIED as, persisted so round 2 can inherit it.
   *
   * A duel's two rounds answer the same user question, so they share an intent - but only round 1
   * ever runs a classifier, because round 2 is dispatched straight to the worker by the orchestrator.
   * Without carrying it, every rebuttal archived a hardcoded 'general' that nobody derived, which
   * split a duel across two intent buckets and reported one of them wrongly.
   */
  intent?: string;
}): Promise<boolean> {
  const { battleContext, response, selfBotArn, correlationId } = args;

  const terminalState = response !== null ? 'COMPLETED' : 'FAILED';

  const claimed = await transitionBotState({
    battleId: battleContext.battleId,
    botArn: selfBotArn,
    state: terminalState,
    round1Reply: response || undefined,
    round1MessageId: args.round1MessageId,
    // Recorded on the ROW rather than threaded through the orchestrator's arguments, because the
    // orchestrator fires from a timer as well as from this call and would otherwise have no source
    // for it on the timer path.
    intent: args.intent,
    correlationId,
  });
  if (!claimed) return false;

  // Round-2 invocations also call this; they shouldn't refire round 2.
  if (battleContext.round !== 1) return false;

  const rows = await readBattleRows(battleContext.battleId);
  if (!allBotsTerminal(rows)) return false;

  // Invoke the orchestrator (it is the single exactly-once authority via its
  // own tryClaimOrchestratorFire sentinel). Do NOT claim the sentinel here —
  // doing so pre-consumed it so the orchestrator's claim ALWAYS lost and round-2
  // never fired (the sentinel can only be claimed once). In the normal flow
  // only the last bot to reach terminal sees allBotsTerminal===true, so it
  // invokes once; in the rare simultaneous-finish race both bots invoke and the
  // orchestrator's claim dedups to one fan-out.
  if (!BATTLE_ORCHESTRATOR_ARN) {
    console.warn('[battle-core] BATTLE_ORCHESTRATOR_ARN unset; round-2 will not fire');
    return false;
  }

  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: BATTLE_ORCHESTRATOR_ARN,
        InvocationType: InvocationType.Event,
        Payload: Buffer.from(JSON.stringify({
          battleId: battleContext.battleId,
          channelArn: args.channelArn,
          userMessage: args.userMessage,
          senderArn: args.senderArn,
          originatingMessageId: battleContext.originatingMessageId || '',
          // The duel's classification, so ROUND 2 answers where round 1 did. Without it the
          // orchestrator had nothing to route on and answered every rebuttal on the premium
          // processor - an escalation for any duel a `battleEligible` profile enabled below premium.
          classification: args.classification,
        })),
      }),
    );
    return true;
  } catch (err) {
    console.error('[battle-core] orchestrator invoke failed:', err);
    return false;
  }
}

/**
 * Round-2 NO_REBUTTAL handling. When the bot's response is the
 * NO_REBUTTAL sentinel (case-insensitive, trimmed, optional trailing
 * punctuation), delete the round-2 placeholder rather than updating it.
 * Returns true iff the response was a NO_REBUTTAL and the placeholder
 * was deleted; the caller should skip the normal finalize path.
 */
export function isNoRebuttal(response: string): boolean {
  return NO_REBUTTAL_PATTERN.test(response);
}

export interface BattleClarification {
  needsClarification: boolean;
  /** The single question to put to the user, sentinel stripped. */
  question?: string;
}

/**
 * Pure. SPEC-BATTLE.md "Clarification Routing": is a battle round-1
 * reply a clarifying question (bot emitted the NEED_CLARIFICATION
 * sentinel) or its complete answer? Whether a model asks vs. forges
 * ahead is a *measured* battle dimension, so detection must be an
 * explicit model signal — never substring inference (see
 * project_battle_clarification + the no-string-matching rule). Two
 * accepted forms, mirroring the NO_REBUTTAL design + its JSON
 * future-proofing note:
 *
 *  - Token form: NEED_CLARIFICATION on its OWN line anywhere in the
 *    reply; the question is the rest of the reply, that line removed.
 *  - JSON form: {"needsClarification": true, "question": "..."} or
 *    {"clarification": "..."}.
 *
 * No sentinel / unparseable → needsClarification:false (the reply IS
 * the bot's complete answer; the no-clarification path then drives the
 * per-bot task terminal so round-2 can fire). Pure → unit-test.
 */
export function parseBattleClarification(response: string): BattleClarification {
  const trimmed = (response ?? '').trim();
  if (!trimmed) return { needsClarification: false };

  // JSON form first — only when it actually looks like a JSON object,
  // so normal prose never reaches JSON.parse.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const q =
        typeof obj.question === 'string' && obj.question.trim()
          ? obj.question.trim()
          : typeof obj.clarification === 'string' && obj.clarification.trim()
            ? obj.clarification.trim()
            : undefined;
      if (obj.needsClarification === true || typeof obj.clarification === 'string') {
        return { needsClarification: true, question: q };
      }
      return { needsClarification: false };
    } catch {
      // Not valid JSON after all — fall through to the token form.
    }
  }

  if (NEED_CLARIFICATION_LINE.test(trimmed)) {
    const question = trimmed
      .replace(NEED_CLARIFICATION_LINE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { needsClarification: true, question: question || undefined };
  }

  return { needsClarification: false };
}

export interface BattleClarificationDelivery {
  /**
   * What replaces this side's placeholder: the QUESTION ITSELF, broadcast like every other duel
   * message, plus the `<!--battlewaiting-->` marker the frontend renders as the "Replying to:"
   * affordance. The marker shape is a contract; keep it parallel to `<!--battlestats-->` /
   * `<!--battle-->`.
   */
  waitingPlaceholderContent: string;
}

/**
 * Pure. What a round-1 clarification puts on the channel (ADR-029).
 *
 * THE QUESTION IS PUBLIC AND PERMANENT. It replaces this side's placeholder and stays there, so the
 * duel reads as a conversation: question, the user's reply, then the answer on a placeholder of its
 * own. This REVERSES the previous rule, which showed a neutral "Assistant is waiting for your
 * response." and sent the real question as a second, `Target`-ed message.
 *
 * WHY THE REVERSAL. The privacy rule existed for a measurement reason - a side that did not think to
 * ask should not free-ride on its rival's clarification - and it survives a far smaller mechanism. The
 * rival seeing the QUESTION learns what the asker found ambiguous; it does not learn the ANSWER, which
 * is where the information the user supplied lives, and which stays targeted at the asking assistant.
 * Concealing the question additionally cost the transcript, the event archive and the end-of-battle
 * summary, which is why SPEC-BATTLE could not retain the verbatim exchange: the answer half was never
 * written down anywhere.
 *
 * It also earns something. A round-2 rebuttal can now see whether its rival asked a useful clarifying
 * question or a needless one, and say so - a dimension of the comparison that was invisible.
 *
 * `senderArn` is no longer an input: nothing is targeted here, so a clarification with no resolvable
 * sender is no longer a question that silently fails to arrive.
 */
export function planBattleClarificationDelivery(args: {
  battleId: string;
  botArn: string;
  question?: string;
}): BattleClarificationDelivery {
  const waitingMarker = `<!--battlewaiting:battleId=${args.battleId},botArn=${args.botArn}-->`;
  const question =
    (args.question ?? '').trim() ||
    'Could you clarify your request so I can give you the best answer?';
  return {
    waitingPlaceholderContent: `${question}${waitingMarker}`,
  };
}

// ============================================================
// Utilities
// ============================================================

/**
 * Try to decode URL-encoded content.
 */
export function tryDecode(content: string): string {
  try {
    if (content.includes('%')) {
      return decodeURIComponent(content);
    }
  } catch {
    // Not encoded
  }
  return content;
}
