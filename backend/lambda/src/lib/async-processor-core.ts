/**
 * Async Processor Core
 *
 * Shared utilities for the tier-specific async processors
 * (basic, standard, premium). Extracts common pipeline steps:
 * - Placeholder polling
 * - Channel history loading
 * - Bedrock invocation
 * - Long response handling (multi-message split)
 * - Message updates with analytics metadata
 * - Error handling
 *
 * Each tier-specific processor imports these functions and
 * composes them with its own system prompt, model config, and
 * tier-specific post-processing.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelMessagesCommand,
  GetChannelMessageCommand,
  UpdateChannelMessageCommand,
  SendChannelMessageCommand,
  DeleteChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ApplyGuardrailCommand,
  type ConverseCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { buildAnalyticsMetadata, pickFrontendMetadata, makeConverseStep, classifyToolError, type ConverseStep, type ToolStepOutcome } from './analytics-metadata.js';
import { writeMessageAnalytics, messageAnalyticsEnabled } from './message-analytics.js';
import { estimateStepCostUsd } from './model-rate-table.js';
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
import { updateTaskStatus, getTask, recordNoTransitionTurn, TASK_STATE_MACHINES, type TaskStatus, type Task } from './task-tracking.js';
import {
  ADVANCE_TASK_STATE_TOOL_NAME,
  taskToolSpecsFor,
  handleAdvanceTaskStateTool,
  advancePlaceItemOnProposal,
  type TaskLoopContext,
} from './task-tools.js';
import { taskStateMachines } from './intent-pack.js';
import { claimCorrelation, capUserMessage } from './abuse-controls.js';
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
  resolveBattleVariantBySlotArn,
  resolveBattleControlVariantByAltSlotArn,
} from './experiment-manager.js';
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

// ============================================================
// Bedrock prompt caching (system-prompt prefix)
// ============================================================
//
// The tier processors build `systemPrompt` as a STABLE base (persona +
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
const METADATA_SHED_ORDER: readonly string[] = [
  // Secondary analytics / config attribution — useful but reconstructable / low-value per-message.
  'systemPromptHash', 'intentPackVersion', 'personaVersion', 'configId',
  'fallbackReason', 'retryCount', 'wasFallback', 'deliveryOption', 'intentConfidence', 'pollMs',
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
}

export interface AsyncProcessorEvent {
  channelArn: string;
  correlationId: string;
  userMessage: string;
  userName?: string;
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

  // Intent classification (passed from agent handler for analytics)
  intent?: string;
  intentConfidence?: string;
  deliveryOption?: string;

  // Per-intent response shaping. Forwarded by the router from the
  // intent pack; the processor clamps `maxTokens` to the tier ceiling + reasoning floor. Absent ⇒
  // the processor's default budget.
  responseSettings?: { maxTokens?: number; verbosity?: 'tight' | 'normal' | 'long' };

  // P4 config attribution. The handler has the intent pack, so it forwards the pack's version (short
  // hash of the raw pack JSON, or 'default'); the processor combines it with the persona it resolves
  // into a `configId`. Absent ⇒ the processor treats the pack as 'default'.
  intentPackVersion?: string;

  // Intent-based model override (resolved by model-resolver or experiment-manager)
  resolvedModel?: string;
  fallbackModel?: string;

  // A/B experiment tracking
  experimentId?: string;
  variantId?: string;

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
}

export interface LongResponseResult {
  content: string;
  responseGroup?: string;
  totalParts?: number;
}

export type ConversationMessage = { role: 'user' | 'assistant'; content: string };

// ============================================================
// Placeholder Polling
// ============================================================

/**
 * Poll for placeholder message by correlation ID.
 * Correlation ID is embedded in message content as <!--corr:uuid-->
 */
export async function pollForPlaceholderMessage(
  channelArn: string,
  correlationId: string,
  botArn: string
): Promise<string | null> {
  const maxAttempts = 15;
  const baseDelay = 150;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[AsyncProcessor] Polling attempt ${attempt}/${maxAttempts}`);

    try {
      const response = await messagingClient.send(new ListChannelMessagesCommand({
        ChannelArn: channelArn,
        ChimeBearer: botArn,
        MaxResults: 20,
        SortOrder: 'DESCENDING',
      }));

      const messages = response.ChannelMessages || [];

      for (const message of messages) {
        const messageId = message.MessageId || '';
        const content = message.Content || '';
        const decodedContent = tryDecode(content);

        if (decodedContent.includes(`<!--corr:${correlationId}-->`)) {
          return messageId;
        }

        // Check Lex JSON wrapper format
        try {
          const parsed = JSON.parse(content);
          const innerContent = parsed.Messages?.[0]?.Content || '';
          const decodedInner = tryDecode(innerContent);
          if (decodedInner.includes(`<!--corr:${correlationId}-->`)) {
            return messageId;
          }
        } catch {
          // Not JSON, continue
        }
      }
    } catch (error) {
      console.error(`[AsyncProcessor] Poll attempt ${attempt} failed:`, error);
    }

    const delay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), 2000);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  return null;
}

// ============================================================
// Channel History
// ============================================================

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

      // Skip the current user message (it's added separately)
      if (!isBot && content.trim() === currentMessage.trim()) continue;

      // Skip placeholder messages
      if (isBot && (content.includes('thinking') || content.includes('...'))) continue;

      history.push({
        role: isBot ? 'assistant' : 'user',
        content,
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
  const items = dc && Array.isArray(dc.items) ? dc.items : [];
  if (dc && (dc.title || items.length)) {
    const lines: string[] = [];
    if (dc.title) lines.push(`Title: ${dc.title}`);
    if (items.length) {
      lines.push('Work items (in order). Reference an item by its id when proposing a change:');
      for (const it of items) {
        const bits = [it.title || 'Untitled item'];
        bits.push(`[${it.status || 'open'}]`);
        if (it.assignee) bits.push(`{assignee: ${it.assignee}}`);
        if (it.start) bits.push(`(start: ${it.start})`);
        if (it.end) bits.push(`(end: ${it.end})`);
        if (it.id) bits.push(`{id: ${it.id}}`);
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

  const others = Array.isArray(event.otherContexts)
    ? (event.otherContexts as Array<{ title?: string; slug?: string }>)
    : [];
  if (others.length) {
    const list = others
      .map((t) => `  - ${t.title || 'Untitled'}${t.slug ? ` (${t.slug})` : ''}`)
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
 */
export function consolidateConsecutiveMessages(
  history: ConversationMessage[]
): ConversationMessage[] {
  if (history.length === 0) return [];

  const consolidated: ConversationMessage[] = [];

  for (const msg of history) {
    const last = consolidated[consolidated.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n\n' + msg.content;
    } else {
      consolidated.push({ ...msg });
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
  const out = messages.map(msg => ({
    role: msg.role as 'user' | 'assistant',
    content: [{ text: msg.content }] as Array<Record<string, unknown>>,
  }));
  // Append the attachment block to the LAST user message (the current turn). Image OR document;
  // if there's no user message it's dropped rather than sent malformed.
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

// Guards a runaway tool loop; a normal company question resolves in 1 round.
const MAX_TOOL_ITERATIONS = 3;

// Converse tool spec for the self-hosted (in-Lambda) agent loop.
const COMPANY_CONTEXT_TOOL_CONFIG = {
  tools: [
    {
      toolSpec: {
        name: 'load_company_context',
        description:
          'Retrieve the company, product, pricing, plan/FAQ, and (tier-permitting) ' +
          'financial documents this assistant is allowed to read. Call this before ' +
          'answering ANY question about the company, its products, pricing, plans, or ' +
          'financials. Returns only the documents this tier is permitted to access.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What the user is asking about.' },
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
export async function applyOutputGuardrail(text: string): Promise<string> {
  const guardrailIdentifier = process.env.GUARDRAIL_ID;
  const guardrailVersion = process.env.GUARDRAIL_VERSION;
  if (!guardrailIdentifier || !guardrailVersion || !text) return text;
  try {
    const resp = await bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier,
      guardrailVersion,
      source: 'OUTPUT',
      content: [{ text: { text } }],
    }));
    if (resp.action === 'GUARDRAIL_INTERVENED') {
      const masked = (resp.outputs ?? []).map((o) => o.text ?? '').join('').trim();
      return masked || text;
    }
    return text;
  } catch (err) {
    console.warn('[AsyncProcessor] ApplyGuardrail failed; passing output through', err);
    return text;
  }
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
export async function applyInputGuardrail(text: string): Promise<{ blocked: boolean; message: string }> {
  const guardrailIdentifier = process.env.GUARDRAIL_ID;
  const guardrailVersion = process.env.GUARDRAIL_VERSION;
  if (!guardrailIdentifier || !guardrailVersion || !text) return { blocked: false, message: '' };
  try {
    const resp = await bedrockClient.send(new ApplyGuardrailCommand({
      guardrailIdentifier,
      guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text } }],
    }));
    if (resp.action === 'GUARDRAIL_INTERVENED') {
      const masked = (resp.outputs ?? []).map((o) => o.text ?? '').join('').trim();
      return { blocked: true, message: masked || 'I cannot process that request. Please rephrase your message.' };
    }
  } catch (err) {
    console.warn('[AsyncProcessor] input ApplyGuardrail failed; allowing input', err);
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
 * vision and /battle turns leave it off. Tier isolation is enforced by the
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
): Promise<{ response: string; inputTokens: number; outputTokens: number; bedrockTime: number; steps: ConverseStep[] }> {
  const bedrockStart = Date.now();
  const convMessages = buildConverseMessages(messages, imageInput, documentInput) as Array<Record<string, unknown>>;
  // ADR-011: company-context bucket (attachments bucket, context/{tier}/);
  // tier isolation is enforced by this Lambda's own scoped S3 IAM. Read at call
  // time so the env is always current (and testable).
  const companyContextBucket = process.env.CONTEXT_BUCKET || '';
  const companyToolOn = enableCompanyContextTool && !!companyContextBucket;
  // Company-context DIGEST (ADR-017): when the company-context tool is on, prepend
  // the always-present per-tier manifest (titles + one-line descriptions of the
  // documents this tier may read) so the model knows WHAT company context exists
  // and can fetch specifics, instead of guessing. Warm-cached + tier-scoped like
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
  const taskToolSpecs = taskContext ? taskToolSpecsFor(taskContext.task.taskType, taskContext.machines) : [];
  const taskToolsOn = taskToolSpecs.length > 0;
  const useTools = companyToolOn || enableEditTools || travelToolOn || taskToolsOn;
  // Combined tool config: company-context + corporate-travel (both executed in-loop) +
  // work-item tools (intercepted as proposals, never executed here) + task tools. Each defaults off.
  const toolConfig = useTools
    ? { tools: [
        ...(companyToolOn ? COMPANY_CONTEXT_TOOL_CONFIG.tools : []),
        ...(companyToolOn ? PLATFORM_INFO_TOOL_CONFIG.tools : []),
        ...(travelToolOn ? [CORPORATE_TRAVEL_TOOL_SPEC] : []),
        ...(enableEditTools ? WORK_ITEM_TOOL_CONFIG.tools : []),
        ...taskToolSpecs,
      ] }
    : undefined;

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
  const latestUserText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const inputGuard = await applyInputGuardrail(latestUserText);
  if (inputGuard.blocked) {
    console.warn('[AsyncProcessor] input guardrail intervened; blocking turn before model call');
    return { response: inputGuard.message, inputTokens: 0, outputTokens: 0, bedrockTime: Date.now() - bedrockStart, steps };
  }

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
      for (const block of outMessage?.content ?? []) {
        const toolUse = (block as { toolUse?: { toolUseId?: string; name?: string } }).toolUse;
        if (!toolUse) continue;
        let payload: Record<string, unknown>;
        try {
          const toolInput = (block as { toolUse?: { input?: Record<string, unknown> } }).toolUse?.input ?? {};
          if (toolUse.name === 'load_company_context') {
            payload = (await loadCompanyContext(companyContextBucket)) as unknown as Record<string, unknown>;
          } else if (toolUse.name === 'load_platform_info') {
            payload = (await loadPlatformInfo(companyContextBucket)) as unknown as Record<string, unknown>;
          } else if (toolUse.name === 'search_corporate_travel') {
            payload = searchCorporateTravel(toolInput as unknown as TravelSearchArgs) as unknown as Record<string, unknown>;
          } else if (taskContext && toolUse.name === ADVANCE_TASK_STATE_TOOL_NAME) {
            // SPEC-TASK-STATE-TRANSITIONS §3: authorize + persist the requested transition. On
            // success reflect the new state so later iterations see it, and record the applied
            // transition on the shared context (for analytics + the shadow comparison). An
            // unauthorized request returns an error the model can read and recover from in-loop.
            const { payload: taskPayload, result } = await handleAdvanceTaskStateTool({
              task: taskContext.task,
              input: toolInput,
              machines: taskContext.machines,
              messageId: taskContext.messageId,
            });
            if (result.ok) {
              taskContext.task.taskState = result.to;
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
        // tiersAccessible for the context tools). Tool decisions previously lived only in
        // the analytics steps; this makes them visible in the Lambda logs for diagnosis.
        console.log('[AsyncProcessor] tool call', {
          tool: toolUse.name,
          documentCount: (payload as { documentCount?: number }).documentCount,
          tiersAccessible: (payload as { tiersAccessible?: unknown }).tiersAccessible,
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
  response = await applyOutputGuardrail(response);

  const bedrockTime = Date.now() - bedrockStart;
  console.log('[AsyncProcessor] Bedrock response received', {
    model: config.model,
    inputTokens,
    outputTokens,
    latencyMs: bedrockTime,
    responseLength: response.length,
    toolsEnabled: useTools,
  });

  return { response, inputTokens, outputTokens, bedrockTime, steps };
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
    if (encodeURIComponent(text.slice(0, mid)).length <= budget) {
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
  return fit;
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

  await messagingClient.send(new UpdateChannelMessageCommand({
    ChannelArn: channelArn,
    MessageId: messageId,
    Content: encodedContent,
    ChimeBearer: botArn,
    Metadata: safeMetadataString(metadata),
  }));
}

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
    // Honor an explicit /battle-resume placeholder so an error on a
    // resumed turn lands on the reused "waiting" message, not a new one.
    const messageId = event.placeholderMessageId
      ? event.placeholderMessageId
      : await pollForPlaceholderMessage(
          event.channelArn,
          event.correlationId,
          event.botArn
        );
    if (messageId) {
      await updateMessage(
        event.channelArn,
        messageId,
        'Sorry, I encountered an issue processing your request. Please try again.',
        event.botArn
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
 * the alert out of tier metrics.
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
 * Returns the common context needed by all tier processors.
 */
export async function runSharedPipeline(event: AsyncProcessorEvent): Promise<{
  messageId: string | null;
  pollTime: number;
  consolidatedHistory: ConversationMessage[];
  priorAgentContext: string;
  bedrockMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  userSub: string;
  /**
   * First-turn channel rename (title derivation) promise, or undefined when
   * this is not the first user turn. The tier handler MUST await this after
   * posting the reply: it's a separate chain of network calls (DescribeChannel
   * + Haiku InvokeModel + UpdateChannel), and an async Lambda freezes the
   * moment the handler resolves, so an un-awaited rename often never lands.
   */
  titleRename?: Promise<unknown>;
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

  // Step 1: Resolve the placeholder. A /battle resume hands us the
  // existing "waiting" message id explicitly — reuse it (one clean
  // message lifecycle, no orphan) instead of polling for a fresh one.
  const messageId = event.placeholderMessageId
    ? event.placeholderMessageId
    : await pollForPlaceholderMessage(channelArn, correlationId, botArn);
  if (!messageId) {
    console.error('[AsyncProcessor] Could not find placeholder message with correlationId:', correlationId);
    if (event.taskId) {
      await updateTaskStatus(event.taskId, channelArn, 'failed', undefined, 'Placeholder message not found');
    }
    return null;
  }
  console.log('[AsyncProcessor] Found placeholder message:', messageId);
  const pollTime = Date.now() - startTime;

  // Step 2: Load conversation history
  let conversationHistory = event.conversationHistory || [];
  if (conversationHistory.length === 0 && channelArn) {
    conversationHistory = await loadChannelHistory(channelArn, event.botArn, userMessage);
    console.log(`[AsyncProcessor] Loaded ${conversationHistory.length} messages from channel history`);
  }

  // Step 2b: Title rename on the first user turn into a channel still named
  // "New conversation" (no-ops otherwise). Kicked off HERE so it runs
  // concurrently with inference, but the promise is RETURNED so the tier
  // handler can await it after the reply is posted. It must not block the
  // reply, but it must also outlive the reply: an async Lambda freezes the
  // execution environment once the handler resolves, so a purely
  // fire-and-forget rename races and is often suspended before the
  // UpdateChannel lands. See lambda/src/lib/channel-title.ts.
  let titleRename: Promise<unknown> | undefined;
  if (conversationHistory.filter(m => m.role === 'user').length === 0) {
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

  const bedrockMessages = [
    ...consolidatedHistory,
    // Length cap (SPEC-ABUSE-CONTROLS): clamp an over-long user turn before the model call.
    // No-op unless MAX_USER_MESSAGE_LENGTH is set.
    { role: 'user' as const, content: capUserMessage(userMessage) },
  ];

  return {
    messageId,
    pollTime,
    consolidatedHistory,
    priorAgentContext,
    bedrockMessages,
    userSub,
    titleRename,
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
  pollTime: number;
  conversationHistoryLength: number;
  startTime: number;
  activeTaskInfo?: { type: string; status: string; label: string; taskId: string };
  /** SPEC-TASK-STATE-TRANSITIONS: the active-task context, so finalize can stamp taskState +
   *  the net transition applied this turn onto the analytics. Absent on non-task turns. */
  taskContext?: TaskLoopContext;
  attachment?: GeneratedDocument;
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
   * "Echo"), from prepareBattleInvocation. Rides the <!--battlestats:-->
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
  /**
   * Per-step telemetry for this turn (one ConverseStep per Converse iteration),
   * from invokeBedrock. Persisted into the out-of-band analytics record ONLY
   * (never the size-capped Chime Metadata) — SPEC-MESSAGE-METADATA-CODEBOOK.md.
   */
  steps?: ConverseStep[];
}): Promise<void> {
  const {
    event, response, model, inputTokens, outputTokens, bedrockTime,
    messageId, pollTime, conversationHistoryLength, startTime, activeTaskInfo,
    attachment,
  } = params;

  // ============================================================
  // /battle: round-2 NO_REBUTTAL short-circuit
  // ============================================================
  // Per SPEC-BATTLE.md: when a bot opts out of round 2 by emitting
  // the NO_REBUTTAL sentinel, we delete its placeholder rather than
  // updating it. The state transition still records terminal status so
  // analytics has the opt-out signal.
  if (event.battleContext?.round === 2 && isNoRebuttal(response)) {
    console.log('[AsyncProcessor][battle] Round-2 NO_REBUTTAL — deleting placeholder', {
      battleId: event.battleContext.battleId,
      botArn: event.botArn,
    });
    try {
      await deleteRound2Placeholder({
        channelArn: event.channelArn,
        messageId,
        botArn: event.botArn,
      });
    } catch (err) {
      console.warn('[AsyncProcessor][battle] DeleteChannelMessage failed:', err);
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
  const longResponseResult = attachment
    ? { content: buildAttachmentLede(response) }
    : await handleLongResponse(
        response,
        event.userType,
        event.channelArn,
        event.botArn,
        messageId,
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
    activeTaskInfo.status = 'completed';
    activeTaskInfo.label = getTaskLabel(activeTaskInfo.type, 'completed');
  }

  // SPEC-TASK-STATE-TRANSITIONS §6: stamp the machine state after this turn + the net transition
  // (first from → last to) applied this turn, so exchanges are sliceable by state and transitions
  // are countable. Distinct from activeTask.status (the task lifecycle) — this is the machine state.
  const taskTx = params.taskContext?.transitions;
  const taskAnalytics = {
    taskState: params.taskContext?.task.taskState,
    taskTransition:
      taskTx && taskTx.length ? { from: taskTx[0].from, to: taskTx[taskTx.length - 1].to } : undefined,
  };

  // Build analytics metadata
  const analyticsMetadata = buildAnalyticsMetadata({
    messageNumber: conversationHistoryLength + 1,
    userType: event.userType,
    role: 'assistant',
    agentType: event.userType,
    intent: event.intent,
    intentConfidence: event.intentConfidence,
    deliveryOption: event.deliveryOption,
    bedrockResponse: {
      model,
      inputTokens,
      outputTokens,
      latencyMs: bedrockTime,
    },
    totalMs: totalTime,
    pollMs: pollTime,
    ...(activeTaskInfo && { activeTask: activeTaskInfo }),
    ...(taskAnalytics.taskState && { taskState: taskAnalytics.taskState }),
    ...(taskAnalytics.taskTransition && { taskTransition: taskAnalytics.taskTransition }),
    ...(params.wasFallback !== undefined && { wasFallback: params.wasFallback }),
    ...(params.fallbackReason && { fallbackReason: params.fallbackReason }),
    ...(params.retryCount !== undefined && { retryCount: params.retryCount }),
    ...(event.experimentId && { experimentId: event.experimentId }),
    ...(event.variantId && { variantId: event.variantId }),
    // P4 config attribution — stamp the config fingerprint resolved by the caller.
    ...(params.configIdentity && { configIdentity: params.configIdentity }),
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
      // is probabilistic; otherwise the model came deterministically from tier+intent resolution.
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
    ...(replyIsTargeted && event.senderArn && { targetedSender: event.senderArn }),
  };

  // /battle round-1 clarification (SPEC-BATTLE.md "Clarification
  // Routing"). Whether a model asks a clarifying question vs. wrongly
  // forges ahead is a MEASURED battle dimension (see
  // project-battle-clarification-measured-dimension): detection is the
  // explicit NEED_CLARIFICATION sentinel, never substring inference.
  //
  // Detected BEFORE the visible placeholder is touched so the question
  // is NEVER broadcast: the channel + rival see only a neutral waiting
  // state; the question is sent targeted to the invoking user; the
  // user's exchange stays private until the end-of-battle summary. A
  // clarifying round-1 reply is NOT round-1 completion — the asking bot
  // enters WAITING_FOR_USER so the round-2 orchestrator stays suppressed
  // until this bot later completes (we return BEFORE the task-complete
  // and terminal/orchestrator blocks). Idempotent under retry:
  // markBotWaitingForUser is conditional on state=INVOKED, so a
  // re-delivery returns false and clarificationCount is not double-counted.
  if (event.battleContext?.round === 1) {
    const clarification = parseBattleClarification(longResponseResult.content);
    if (clarification.needsClarification) {
      const delivery = planBattleClarificationDelivery({
        battleId: event.battleContext.battleId,
        botArn: event.botArn,
        senderArn: event.senderArn,
        question: clarification.question,
      });
      // Visible placeholder: neutral waiting state ONLY — no question,
      // no battlestats scorecard (the bot has not completed round 1, so
      // `finalContent` above is intentionally unused on this branch).
      await updateMessage(
        event.channelArn,
        messageId,
        delivery.waitingPlaceholderContent,
        event.botArn,
        messageMetadata,
      );
      // Clarifying question: targeted to the invoking user only.
      if (delivery.targetedQuestion) {
        try {
          await messagingClient.send(
            new SendChannelMessageCommand({
              ChannelArn: event.channelArn,
              Content: encodeURIComponent(delivery.targetedQuestion.content),
              Type: 'STANDARD',
              Persistence: 'PERSISTENT',
              ChimeBearer: event.botArn,
              Target: [{ MemberArn: delivery.targetedQuestion.targetMemberArn }],
              Metadata: JSON.stringify({
                battleClarification: true,
                battleId: event.battleContext.battleId,
                botArn: event.botArn,
              }),
            }),
          );
        } catch (err) {
          console.warn('[AsyncProcessor][battle] targeted clarification send failed:', err);
        }
      } else {
        console.warn(
          '[AsyncProcessor][battle] clarification but no senderArn — question not delivered',
          { battleId: event.battleContext.battleId, botArn: event.botArn },
        );
      }
      const marked = await markBotWaitingForUser({
        battleId: event.battleContext.battleId,
        botArn: event.botArn,
        question: clarification.question,
        correlationId: event.correlationId,
        // Persist the placeholder we just turned into the waiting state
        // so the resume path reuses THIS message (no orphan; the marker
        // clearing is the frontend's "waiting ended" signal).
        waitingMessageId: messageId,
      });
      console.log(
        '[AsyncProcessor][battle] Round-1 clarification — WAITING_FOR_USER (targeted question, orchestrator suppressed)',
        {
          battleId: event.battleContext.battleId,
          botArn: event.botArn,
          transitioned: marked,
          questionDelivered: !!delivery.targetedQuestion,
        },
      );
      return;
    }
  }

  // Out-of-band analytics (Phase 1): persist the FULL analytics blob keyed by
  // this message id BEFORE the Chime update, so the row is in place before the
  // (slimmed) message can reach archival via Chime's Kinesis mirror. No-op when
  // the store is unavailable (Athena mode) — see messageMetadata above.
  // steps[] (per-Converse-iteration telemetry) lives ONLY here, never inline:
  // it would blow the 1024 Metadata cap and only archival/admin consume it.
  await writeMessageAnalytics({
    messageId,
    channelArn: event.channelArn,
    analytics: { ...fullAnalytics, ...(params.steps?.length ? { steps: params.steps } : {}) },
  });

  // Update the placeholder message (non-clarification path)
  await updateMessage(event.channelArn, messageId, finalContent, event.botArn, messageMetadata);

  console.log('[AsyncProcessor] Message updated successfully', {
    pollTime,
    bedrockTime,
    totalTime,
  });

  // Battle TASK_* round-1 gate. premium-async-processor has already
  // advanced the state machine for this turn before finalize, so the
  // task's REAL state tells us whether round-1 is actually done.
  const isBattleTaskInvocation =
    !!event.battleContext &&
    (event.deliveryOption === 'TASK_UPDATE_IN_PLACE' ||
      event.deliveryOption === 'TASK_MULTI_STEP');

  let roundComplete:
    | { deliveryOption?: string; taskType?: string; taskState?: string; taskStatus?: string }
    | undefined;
  if (isBattleTaskInvocation && event.taskId) {
    const t = await getTask(event.taskId, event.channelArn);
    roundComplete = {
      deliveryOption: event.deliveryOption,
      taskType: event.taskType || t?.taskType,
      taskState: t?.taskState,
      taskStatus: t?.status,
    };
  }
  const battleRoundDone = !roundComplete || isBattleRound1Complete(roundComplete);

  // Update task status to completed if task-based — EXCEPT a battle
  // TASK_* task mid-chain: don't force-complete it; let the state
  // machine progress across turns until it's genuinely terminal.
  if (event.taskId && !(isBattleTaskInvocation && !battleRoundDone)) {
    await updateTaskStatus(event.taskId, event.channelArn, 'completed', response.substring(0, 500));
  }

  // /battle: record the per-bot terminal state row. On the LAST writer's
  // round-1 transition this also fires the orchestrator for round 2.
  // Round-2 transitions are recorded but never refire round-2 (guarded
  // inside the helper). The roundComplete gate (when set) makes a
  // mid-chain TASK_* update a no-op here.
  if (event.battleContext) {
    const fired = await recordBattleTerminalAndFireOrchestrator({
      battleContext: event.battleContext,
      channelArn: event.channelArn,
      selfBotArn: event.botArn,
      senderArn: event.senderArn,
      response: longResponseResult.content,
      round1MessageId: messageId,
      correlationId: event.correlationId,
      userMessage: event.userMessage,
      ...(roundComplete && { roundComplete }),
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
 * in a long body.
 */
export function isDeliverableDocument(response: string | null | undefined): boolean {
  const text = (response || '').trim();
  if (text.length < 500) return false; // a clarifying question / one-liner never reaches this
  const hasHeading = /(^|\n)#{1,6}\s+\S/.test(text); // "# Title" / "## Section"
  const hasTable = /(^|\n)\s*\|.+\|\s*\n\s*\|[-:\s|]+\|/.test(text); // markdown table w/ header rule
  const listItems = (text.match(/(^|\n)\s*(?:[-*]\s+|\d+\.\s+)\S/g) || []).length;
  // A heading or a table is a strong document signal; a plain list needs several items AND a long
  // body so a 3-bullet answer doesn't masquerade as a deliverable.
  return hasHeading || hasTable || (listItems >= 4 && text.length >= 800);
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
    ContentType: 'text/markdown',
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

export function getTaskLabel(taskType: string, taskState: string): string {
  return TASK_LABELS[taskType]?.[taskState] || taskType;
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
}): Promise<TaskLoopContext | undefined> {
  if (!args.taskId || !args.taskType) return undefined;
  const machines = taskStateMachines();
  if (!machines[args.taskType]) return undefined;
  const task = await getTask(args.taskId, args.channelArn);
  if (!task || !task.taskState) return undefined;
  return { task, machines, messageId: args.messageId, initialState: task.taskState, transitions: [] };
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
  const keywordWouldAdvance = detectStateTransition(response, taskType, from, TASK_STATE_MACHINES);
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
  // Only notify a hand-off to SOMEONE ELSE — the assignee chatting right now needs no email.
  if (!args.task.assigneeUserSub || args.task.assigneeUserSub === senderSub) return false;
  const target = matchAssigneeInRoster(args.task.assigneeUserSub, args.roster);
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

// SPEC-BATTLE.md "Clarification Routing": clarification is a MEASURED
// dimension (project-battle-clarification-measured-dimension), so the
// prompt PERMITS exactly one sentinel-gated question rather than
// forbidding it — but does not encourage it (we measure genuine
// ask-vs-forge-ahead behavior). Round 2 still forbids it (rebuttal
// turn; round-2 WAITING is not wired). The NEED_CLARIFICATION sentinel
// is what parseBattleClarification detects to drive WAITING_FOR_USER.
const BATTLE_CONSTRAINTS_ROUND1 = (rivalName: string, longForm = false, outlineFirst = false) => `\n\nYou are in a battle with ${rivalName}. If the user's request is genuinely ambiguous in a way that materially changes your answer, you may ask exactly ONE concise clarifying question — and only then; otherwise state your assumptions clearly and produce your best answer in a single reply. ${longForm ? (outlineFirst ? 'Produce a CONCISE 3-5 sentence APPROACH/OUTLINE only describing what you would cover in the full deliverable. Do NOT write the full report yet - the user will review your approach side-by-side with the rival and steer before the full deliverable is generated. Keep the outline focused so it is easy to compare with the rival.' : 'Produce the COMPLETE deliverable in full: it will be delivered to the user as a downloadable attachment, so do not abbreviate, summarize, or drop sections to save length. Open with a one or two sentence summary of your approach so the side-by-side comparison stays scannable, then give the full content.') : 'Be concise and high-signal: the human is comparing your reply side by side with the rival, so give a focused answer of roughly 150 words (a tight paragraph or a short list) and stop. Do not pad or exhaustively cover every angle; prefer the single strongest recommendation.'} When you do ask, put the token NEED_CLARIFICATION on its own line. Do not propose starting a separate conversation or suggest the user is off-topic — the user invoked /battle intentionally; divergence is the point.`;

const BATTLE_CONSTRAINTS_ROUND2 = (rivalName: string, rivalReply: string) => `\n\nYou are in a battle with ${rivalName}. This is the rebuttal turn. The original user prompt is above. Your own round-1 reply has been posted to the channel. Your rival ${rivalName} replied with:

<rival_reply>
${rivalReply}
</rival_reply>

You may rebut, build on, or concede to the rival's reply. You may also choose not to add anything — respond with the single token NO_REBUTTAL if so. The human is reading both replies; they do not need filler. Keep your rebuttal to a few sentences focused on the single most important point of difference. Do not ask clarifying questions or suggest starting a separate conversation.`;

/**
 * Assemble the system prompt for a battle invocation using the 3-layer
 * ordering from SPEC-BATTLE.md "Prompt Addendum Sanitization":
 *
 *   1. Tier base system prompt
 *   2. <persona_addendum>{sanitized variant.systemPromptAddendum}</persona_addendum>
 *   3. Battle-mode constraints (LAST, so they override any contradictory
 *      addendum)
 *
 * Returns the assembled prompt + the variant's modelKey override (or
 * undefined when this is the default-bot side of the battle).
 */
export async function prepareBattleInvocation(args: {
  baseSystemPrompt: string;
  battleContext: BattleContextPayload;
  defaultBotArn: string;
  selfBotArn: string;
  rivalDisplayName?: string;
  /** Conversational battles cap to ~150 words for a fast, readable
   *  side-by-side; long-form battles (report/document, delivered as an
   *  attachment) must NOT be capped. Set by the caller from taskType. */
  longForm?: boolean;
  /** B: outline-first overrides the one-shot long-form clause with a propose-outline-only clause (round-1); the full deliverable is gated to a subsequent steered turn. */
  longFormMode?: 'one-shot' | 'outline-first';
}): Promise<{ systemPrompt: string; variantModelKey?: string; selfDisplayName: string; longFormMode: 'one-shot' | 'outline-first' }> {
  const isAltSlot = args.selfBotArn !== args.defaultBotArn;

  // Resolve this bot's bound variant config:
  //  - alt-slot side  → treatment (variants[1]), keyed by its own ARN.
  //  - default-bot side → control (variants[0]); the experiment is keyed
  //    by the alt-slot ARN, which from the default bot's invocation is
  //    battleContext.rivalBotArn.
  // Both sides now honor the experiment's configured variant (model +
  // displayName + addendum) so /battle is a faithful head-to-head of the
  // two configured variants (SPEC-BATTLE Design Anchor; generalizes the
  // stale §413). When the battle/variant can't be resolved, the fields
  // stay unset and the caller keeps its normal tier+intent resolution
  // (graceful fall-back to the old §413 behavior).
  let variantModelKey: string | undefined;
  let addendum: string | undefined;
  let selfDisplayName = 'the default assistant';
  // B: experiment-row longFormMode (one-shot default). When set to
  // outline-first, ROUND1 produces an approach/outline only.
  let longFormMode: 'one-shot' | 'outline-first' = args.longFormMode ?? 'one-shot';
  try {
    const variant = isAltSlot
      ? await resolveBattleVariantBySlotArn(args.selfBotArn)
      : await resolveBattleControlVariantByAltSlotArn(args.battleContext.rivalBotArn);
    if (variant) {
      variantModelKey = variant.modelKey;
      addendum = variant.systemPromptAddendum;
      selfDisplayName = variant.displayName;
      if (variant.longFormMode) longFormMode = variant.longFormMode;
    }
  } catch (err) {
    console.warn('[battle-core] battle variant resolution failed:', err);
  }

  const rivalName = args.rivalDisplayName || 'the other assistant';
  const constraints = args.battleContext.round === 1
    ? BATTLE_CONSTRAINTS_ROUND1(rivalName, !!args.longForm, longFormMode === 'outline-first')
    : BATTLE_CONSTRAINTS_ROUND2(rivalName, args.battleContext.rivalReply || '(no reply)');

  let systemPrompt = args.baseSystemPrompt;
  if (addendum) {
    systemPrompt += `\n\n<persona_addendum>${addendum}</persona_addendum>`;
  }
  systemPrompt += constraints;

  return { systemPrompt, variantModelKey, selfDisplayName, longFormMode };
}

/**
 * Phase-3 vision-in: consolidate "which model is this battle variant +
 * does the turn have a usable image + can the model read it" into one
 * pure decision, so the in-flight tier processor just branches on the
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
 * Phase-4 generation-out plan (pure; the gen-out analogue of
 * resolveBattleVisionPlan). `'generation'` ONLY when `imageGenModelId`
 * resolves to a registered image model (Titan v2 / Nova Canvas);
 * absent or unknown → `'text'` so the turn proceeds as a normal text
 * battle rather than fabricating or crashing. The unknown-but-present
 * case is a deployer misconfig — the planner stays pure; the processor
 * logs that visibly (no silent string-matching inference).
 */
export interface BattleGenerationOutPlan {
  action: 'generation' | 'text';
  /** The validated Bedrock image-gen model id (generation only). */
  modelId?: string;
  modelKey?: ImageGenModelKey;
  displayName?: string;
}

export function resolveBattleGenerationOutPlan(input: {
  imageGenModelId?: string;
}): BattleGenerationOutPlan {
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
/**
 * Round-1 completion semantics (SPEC-BATTLE.md). Round-2 must not fire
 * until each bot has FULLY completed the round-1 intent — for a TASK_*
 * battle that means the bot's task chain reached a terminal state, NOT
 * merely that the first async UpdateChannelMessage landed.
 *
 *   DIRECT / PLACEHOLDER_UPDATE → complete when the async update lands
 *   TASK_UPDATE_IN_PLACE / TASK_MULTI_STEP → complete only when the
 *     task chain is terminal (status completed|failed, OR taskState is
 *     a terminal state / the last state of the taskType machine)
 *
 * Unknown/absent deliveryOption falls back to "complete" so an
 * unrecognised path can never strand a battle (preserves the prior
 * unconditional behaviour for non-TASK invocations). Pure → unit-test.
 */
const TERMINAL_TASK_STATES = new Set(['completed', 'resolved', 'escalated', 'failed']);

export function isBattleRound1Complete(input: {
  deliveryOption?: string;
  taskType?: string;
  taskState?: string;
  taskStatus?: TaskStatus | string;
}): boolean {
  const d = input.deliveryOption;
  if (d === 'TASK_UPDATE_IN_PLACE' || d === 'TASK_MULTI_STEP') {
    if (input.taskStatus === 'completed' || input.taskStatus === 'failed') return true;
    if (input.taskState && TERMINAL_TASK_STATES.has(input.taskState)) return true;
    if (input.taskType && input.taskState) {
      const states = TASK_STATE_MACHINES[input.taskType];
      if (states && input.taskState === states[states.length - 1]) return true;
    }
    return false;
  }
  // DIRECT, PLACEHOLDER_UPDATE, or anything unrecognised → complete.
  return true;
}

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
  /**
   * Phase-2 TASK_* gate. When provided AND this is NOT a failure
   * (response !== null), the per-bot terminal write is skipped unless
   * isBattleRound1Complete() says round-1 is actually done — so a
   * mid-chain TASK_* async update doesn't prematurely mark the bot
   * COMPLETED and fire round-2. Omitted (current callers) → the prior
   * unconditional behaviour, so this is zero-regression until a caller
   * opts in (next brick). A hard failure is always terminal.
   */
  roundComplete?: {
    deliveryOption?: string;
    taskType?: string;
    taskState?: string;
    taskStatus?: string;
  };
}): Promise<boolean> {
  const { battleContext, response, selfBotArn, correlationId } = args;

  // TASK_* round-1 gate: a mid-chain (non-terminal) task update is not
  // round-1 completion. Failures (response === null) are always
  // terminal — a failed bot can't continue its chain.
  if (
    response !== null &&
    args.roundComplete &&
    !isBattleRound1Complete(args.roundComplete)
  ) {
    return false;
  }

  const terminalState = response !== null ? 'COMPLETED' : 'FAILED';

  const claimed = await transitionBotState({
    battleId: battleContext.battleId,
    botArn: selfBotArn,
    state: terminalState,
    round1Reply: response || undefined,
    round1MessageId: args.round1MessageId,
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
   * What the channel + rival bot see in the placeholder — a neutral
   * waiting state ONLY, never the question. Carries the
   * `<!--battlewaiting-->` marker the frontend (brick 2B-xii) renders
   * as the "Replying to:" affordance — this marker shape is a contract;
   * keep it parallel to `<!--battlestats-->` / `<!--battle-->`.
   */
  waitingPlaceholderContent: string;
  /**
   * The clarifying question, addressed to the invoking user ONLY. null
   * when there is no senderArn to target — the caller still enters
   * WAITING_FOR_USER (a lost question is recoverable by re-prompting; a
   * wrongly-fired round-2 is not), but logs that the question wasn't
   * delivered.
   */
  targetedQuestion: { content: string; targetMemberArn: string } | null;
}

/**
 * Pure. SPEC-BATTLE.md "Clarification Routing": shape the two outputs
 * of a round-1 clarification so the channel + rival see ONLY a neutral
 * waiting state while the question goes targeted to the invoking user.
 * The user's clarification exchange stays private until the
 * end-of-battle summary (project-battle-clarification-measured-
 * dimension — broadcasting it would let a bot that failed to ask
 * free-ride on its rival's clarification). Pure → unit-test.
 */
export function planBattleClarificationDelivery(args: {
  battleId: string;
  botArn: string;
  senderArn?: string;
  question?: string;
}): BattleClarificationDelivery {
  const waitingMarker = `<!--battlewaiting:battleId=${args.battleId},botArn=${args.botArn}-->`;
  const question =
    (args.question ?? '').trim() ||
    'Could you clarify your request so I can give you the best answer?';
  return {
    waitingPlaceholderContent: `Assistant is waiting for your response.${waitingMarker}`,
    targetedQuestion: args.senderArn
      ? { content: question, targetMemberArn: args.senderArn }
      : null,
  };
}

export async function deleteRound2Placeholder(args: {
  channelArn: string;
  messageId: string;
  botArn: string;
}): Promise<void> {
  await messagingClient.send(
    new DeleteChannelMessageCommand({
      ChannelArn: args.channelArn,
      MessageId: args.messageId,
      ChimeBearer: args.botArn,
    }),
  );
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
