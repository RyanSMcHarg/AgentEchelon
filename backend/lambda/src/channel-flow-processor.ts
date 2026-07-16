/**
 * Channel Flow Processor
 *
 * Invoked by Chime SDK on every message in a channel (before Lex processing).
 *
 * Responsibilities:
 * - Detect @all mentions: bot responds broadcast to everyone (this is a real
 *   processor-side bypass — `@all` is not a Chime CHIME.mentions value, so
 *   AUTO + Lex would not route it; we invoke the async processor directly
 *   and broadcast the bot reply)
 * - Allow other messages through unmodified. The bot's
 *   `StandardMessages: AUTO` + `TargetedMessages: ALL` configuration handles
 *   routing natively:
 *     - 1:1 channels: AUTO routes every message to Lex
 *     - Multi-member: AUTO routes only messages whose CHIME.mentions
 *       attribute carries the bot ARN (set by the frontend on @assistant)
 *     - TargetedMessages: ALL routes any Target-addressed message to Lex
 *       and produces a targeted reply back to the sender
 * - Idempotency for at-least-once delivery
 *
 * IMPORTANT: Must call ChannelFlowCallback for every ASYNC invocation
 * to release the message. Failure to callback blocks the message.
 */

import {
  ChimeSDKMessagingClient,
  ChannelFlowCallbackCommand,
  SendChannelMessageCommand,
  ListChannelMembershipsCommand,
  ListTagsForResourceCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  deriveBattleId,
  initBotState,
  isBattleEnabled,
  setActiveBattle,
  resolveActiveBattleId,
  readBattleRows,
  botRowsOnly,
  planBattleContinuation,
  planBattleResume,
  resumeBotFromWaiting,
  extractTargetedBotArns,
  type BattleStateRow,
} from './lib/battle-state.js';
import {
  extractImageAttachment,
  extractAttachment,
  type BattleImageAttachment,
  type MessageAttachment,
} from './lib/battle-attachment.js';
import { classifyIntent } from './lib/intent-classifier.js';
import {
  resolveBattleImageGenPair,
  resolveBattleVariantBySlotArn,
  resolveBattleControlVariantByAltSlotArn,
} from './lib/experiment-manager.js';
import { planBattleTaskDelivery, DeliveryOption } from './lib/delivery-options.js';
import { createBattleTask, getTask } from './lib/task-tracking.js';
import { parseNotifyDirective, fanOutChannelNotification } from './lib/channel-notify.js';

const messagingClient = new ChimeSDKMessagingClient({});
const lambdaClient = new LambdaClient({});
const ssmClient = new SSMClient({});

const ASYNC_PROCESSOR_ARN = process.env.ASYNC_PROCESSOR_ARN;
// /battle (SPEC-BATTLE.md): premium-tier fan-out routes through
// the premium async processor; the alt-bot slot roster lists which channel
// members are alt-slot bots vs the default bot.
const PREMIUM_ASYNC_PROCESSOR_ARN = process.env.PREMIUM_ASYNC_PROCESSOR_ARN;
const ALT_BOT_SLOTS_ROSTER_PARAM = process.env.ALT_BOT_SLOTS_ROSTER_PARAM || '/agent-echelon/alt-bot-slots/roster';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
// Notification bridge (SPEC-NOTIFICATION-BRIDGE): the PRIMARY IDP pool to resolve recipient email by
// sub when a target carries no issuer. NOTIFY_ALLOWED_POOL_IDS lists the additional trusted pools an
// issuer may resolve to when members come from MULTIPLE IDPs (comma-separated).
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const NOTIFY_ALLOWED_POOL_IDS = (process.env.NOTIFY_ALLOWED_POOL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Read the channel's tier from its IMMUTABLE `classification` tag. This is a SHARED
// flow (one processor for all channels), so it discovers the tier per message and that
// choice decides which per-tier assistant responds and whether premium battles run. We
// must NOT read `metadata.modelTier`: metadata is mutable via the owner rename cap
// (chime:UpdateChannel), so a moderator could tamper it up to make a higher-tier
// assistant respond or open premium battles on a lower-tier channel. The tag cannot be
// changed by UpdateChannel. Fail-closed to basic. (bearerArn is unused for a tag read.)
async function getChannelTier(channelArn: string, _bearerArn: string): Promise<string> {
  const VALID_TIERS = new Set(['basic', 'standard', 'premium']);
  try {
    const resp = await messagingClient.send(
      new ListTagsForResourceCommand({ ResourceARN: channelArn }),
    );
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
    if (tag && VALID_TIERS.has(tag)) return tag;
    console.warn('[ChannelFlow][SecurityEvent] channel missing/invalid classification tag; failing closed to basic', { channelArn, tag });
    return 'basic';
  } catch (err) {
    console.warn('[ChannelFlow] Failed to read channel classification tag; defaulting basic:', err);
    return 'basic';
  }
}

// Resolve the channel's PER-TIER bot (its real creator+member) — the ChimeBearer
// for every bot-attributed action here (@all broadcast, member count, /battle
// default combatant). There is no shared cross-tier bot fallback: a missing
// per-tier SSM key is an error (the tier stack publishes it on deploy).
const tierBotArnCache: Record<string, string> = {};
async function resolveTierBotArn(tier: string): Promise<string> {
  if (tierBotArnCache[tier]) return tierBotArnCache[tier];
  const key = `${SSM_ROOT}/tier/${tier}/bot-arn`;
  const resp = await ssmClient.send(new GetParameterCommand({ Name: key }));
  const arn = resp.Parameter?.Value;
  if (!arn) {
    throw new Error(`[ChannelFlow] per-tier bot param ${key} is empty`);
  }
  tierBotArnCache[tier] = arn;
  return arn;
}

function safeDecodeURIComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

interface ChannelFlowEvent {
  CallbackId: string;
  ChannelMessage: {
    MessageId: string;
    Content: string;
    Metadata?: string;
    Sender?: { Arn: string; Name: string };
    ChannelArn?: string;
    /**
     * Targeted-delivery recipients (Chime `Target`). A battle
     * continuation reply is `Target`-addressed to the waiting bot;
     * channel flows receive targeted messages (else any content filter
     * would be bypassable by targeting), so the processor can read this.
     */
    Target?: { MemberArn?: string }[];
  };
  EventType: string;
  Channel?: {
    ChannelArn: string;
  };
}

// Idempotency gate — Chime channel flows have at-least-once delivery
const processedMessages = new Set<string>();

// Cache channel member counts for 60s (avoids ListChannelMemberships on every message)
interface MemberCacheEntry { humanCount: number; expires: number }
const memberCache = new Map<string, MemberCacheEntry>();
const MEMBER_CACHE_TTL_MS = 60_000;

async function getHumanMemberCount(channelArn: string, botArn: string): Promise<number> {
  const cached = memberCache.get(channelArn);
  if (cached && cached.expires > Date.now()) return cached.humanCount;

  try {
    const resp = await messagingClient.send(
      new ListChannelMembershipsCommand({
        ChannelArn: channelArn,
        ChimeBearer: botArn,
        MaxResults: 50,
      }),
    );
    const humanCount = (resp.ChannelMemberships || []).filter(
      (m) => !(m.Member?.Arn || '').includes('/bot/'),
    ).length;

    memberCache.set(channelArn, { humanCount, expires: Date.now() + MEMBER_CACHE_TTL_MS });
    return humanCount;
  } catch (err) {
    console.warn('[ChannelFlow] Failed to list memberships, assuming 1-on-1:', err);
    return 1;
  }
}

export async function handler(event: ChannelFlowEvent): Promise<void> {
  // Do NOT dump the full event — ChannelMessage.Content is the raw user
  // message body (potential PII) and this runs on every message. Log ids only.
  console.log('ChannelFlowProcessor invoked:', {
    callbackId: event.CallbackId,
    messageId: event.ChannelMessage?.MessageId,
    channelArn: event.ChannelMessage?.ChannelArn || event.Channel?.ChannelArn,
  });

  const { CallbackId, ChannelMessage } = event;
  const { MessageId, Content, Metadata } = ChannelMessage;
  const channelArn = ChannelMessage.ChannelArn || event.Channel?.ChannelArn || '';

  // Always allow bot messages through (don't process our own output)
  const senderArn = ChannelMessage.Sender?.Arn || '';
  const isBotMessage = senderArn.includes('/bot/');

  if (isBotMessage) {
    // Notification bridge (SPEC-NOTIFICATION-BRIDGE P1, outbound): a bot message tagged with
    // `metadata.notify` is fanned out to participants over the requested transport (email v1) — the
    // in-channel message still lands (callbackAllow below); this just reaches members who aren't
    // watching. Best-effort, never blocks the callback. parseNotifyDirective returns null for the
    // common (un-tagged) case, so ordinary bot traffic skips it cheaply.
    const directive = parseNotifyDirective(Metadata);
    if (directive && USER_POOL_ID) {
      try {
        const res = await fanOutChannelNotification({
          channelArn,
          bearerArn: senderArn,
          userPoolId: USER_POOL_ID,
          allowedPoolIds: NOTIFY_ALLOWED_POOL_IDS,
          messageText: safeDecodeURIComponent(Content),
          directive,
        });
        console.log('[ChannelFlow] notify fan-out', res);
      } catch (e) {
        console.warn('[ChannelFlow] notify fan-out failed (non-fatal):', e);
      }
    }
    await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
    return;
  }

  const decodedContent = safeDecodeURIComponent(Content);
  // Detect against BOTH the decoded and raw Content. safeDecodeURIComponent
  // returns the raw string UNCHANGED if decodeURIComponent throws on any
  // malformed %-sequence anywhere in the message — which would leave a
  // percent-encoded leading token and silently defeat the slash-command
  // test, dropping the entire battle fan-out. /battle is the process
  // trigger; a missed detection is unrecoverable, so test both forms.
  const battleRe = /^\s*\/battle\b/i;
  const allRe = /@all\b/i;
  const mentionsAll = allRe.test(decodedContent) || allRe.test(Content);
  // `/battle` is a slash command — a process invocation, parsed only at the
  // start of the (trimmed) message. This is deliberately NOT mention syntax:
  // `@`-tokens target a channel *member*; `/battle` triggers the fan-out
  // process. If both somehow appear, the command wins. See SPEC-BATTLE.md.
  const invokesBattle = battleRe.test(decodedContent) || battleRe.test(Content);
  console.log('[ChannelFlow] routing', {
    invokesBattle,
    mentionsAll,
    decodeChanged: decodedContent !== Content,
    rawHead: JSON.stringify(Content).slice(0, 64),
    decHead: JSON.stringify(decodedContent).slice(0, 64),
  });

  // Resolve the channel's per-tier bot (its real member) for every
  // bot-attributed action below — @all broadcast, member count, and the
  // /battle default combatant. No shared bot is a channel member, so only the
  // per-tier bot can read the channel and send. Tier is read as the SENDER (a
  // member); for a /battle channel that
  // resolves to the premium bot, the correct default combatant.
  const channelTier = await getChannelTier(channelArn, senderArn);
  const botArn = await resolveTierBotArn(channelTier);

  // ═══════════════════════════════════════════════════════════════
  // /battle continuation: a reply Target-addressed to a bot that is
  // WAITING_FOR_USER in this channel's active battle (SPEC-BATTLE.md
  // "Per-bot reply UX"). Resolved BEFORE the universal callback because
  // a continuation must be DENIED (DeleteResource) — not allowed
  // through — so Chime-native TargetedMessages:ALL does not ALSO route
  // it to Lex. The reply is consumed privately; only the targeted bot
  // reply comes back. Cheap-gated on the message actually being
  // bot-targeted so ordinary traffic skips the DDB reads.
  // ═══════════════════════════════════════════════════════════════
  const targetedBotArns = extractTargetedBotArns(ChannelMessage.Target);
  let continuation:
    | { battleId: string; rows: BattleStateRow[]; resumeBotArns: string[] }
    | null = null;
  if (targetedBotArns.length > 0 && !invokesBattle && !mentionsAll) {
    const activeBattleId = await resolveActiveBattleId(channelArn);
    if (activeBattleId) {
      const rows = await readBattleRows(activeBattleId);
      const { resumeBotArns } = planBattleContinuation(rows, targetedBotArns);
      if (resumeBotArns.length > 0) {
        continuation = { battleId: activeBattleId, rows, resumeBotArns };
      }
    }
  }

  // Idempotency for the bypass paths. A continuation is also a bypass; a
  // duplicate must still be DENIED so a redelivery never slips to Lex.
  const usesBypass = mentionsAll || invokesBattle || continuation !== null;
  if (usesBypass && processedMessages.has(MessageId)) {
    console.log('[ChannelFlow] Skipping duplicate invocation for:', MessageId);
    if (continuation) {
      await callbackDeny(CallbackId, channelArn, MessageId);
    } else {
      await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
    }
    return;
  }
  if (usesBypass) {
    processedMessages.add(MessageId);
    if (processedMessages.size > 200) {
      const oldest = processedMessages.values().next().value;
      if (oldest) processedMessages.delete(oldest);
    }
  }

  // Release the original message so all participants can see it —
  // EXCEPT a continuation, which is DENIED (not persisted, not
  // delivered, not routed to Lex; the user's answer stays private).
  if (continuation) {
    await callbackDeny(CallbackId, channelArn, MessageId);
  } else {
    await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
  }

  // ═══════════════════════════════════════════════════════════════
  // /battle: per-bot fan-out for adversarial replies (SPEC-BATTLE.md).
  // Premium-tier only. If Battle Mode isn't enabled on the channel the
  // user gets a one-line "not enabled here" hint (handleBattleMessage) —
  // a no-op command should explain itself, not silently broadcast.
  // ═══════════════════════════════════════════════════════════════
  if (invokesBattle) {
    // Strip /battle from whichever form actually carried it — if only the
    // raw Content matched (decoded form was mangled), stripping the decoded
    // one would leave the prefix and pass a junk prompt to the battle.
    const battleSource = battleRe.test(decodedContent) ? decodedContent : Content;
    const cleanMessage = battleSource.replace(battleRe, '').trim();
    console.log('[ChannelFlow] battle dispatch', {
      source: battleSource === decodedContent ? 'decoded' : 'raw',
      cleanLen: cleanMessage.length,
      willDispatch: cleanMessage.length > 0,
    });
    if (cleanMessage) {
      await handleBattleMessage({
        channelArn,
        userMessageId: MessageId,
        content: cleanMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        defaultBotArn: botArn,
        // Phase-3 vision-in: an image on the `/battle` turn rides the
        // message Metadata (same pipeline as any attachment).
        imageAttachment: extractImageAttachment(Metadata),
      });
    } else {
      console.warn('[ChannelFlow] /battle with empty prompt — no dispatch');
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // /battle continuation: resume the addressed waiting bot(s) with the
  // user's clarification answer (2B-x-b). The message was already
  // DENIED above, so this is the sole responder — like /battle/@all.
  // ═══════════════════════════════════════════════════════════════
  if (continuation) {
    await handleBattleContinuation({
      channelArn,
      battleId: continuation.battleId,
      rows: continuation.rows,
      resumeBotArns: continuation.resumeBotArns,
      userAnswer: decodedContent,
      senderArn,
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // @all: broadcast bot response. This is the only processor-side bypass.
  // `@all` is not a Chime CHIME.mentions value, so AUTO + Lex will not
  // route it — we invoke the async processor directly to produce a bot
  // reply visible to all members.
  // ═══════════════════════════════════════════════════════════════
  if (mentionsAll) {
    const cleanMessage = decodedContent.replace(/@all\b/gi, '').trim();
    // Attachment-in (image/PDF/doc) rides the @all bypass cleanly: @all is not a Chime mention, so
    // AUTO+Lex never also routes it — no double-processing. The async processor reads the file.
    const allAttachment = extractAttachment(Metadata);
    if (cleanMessage || allAttachment) {
      await handleMentionedMessage({
        channelArn,
        content: cleanMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        botArn,
        broadcast: true,
        attachment: allAttachment,
      });
    }
    return;
  }

  // All other messages: AUTO + TargetedMessages: ALL handles routing.
  // - 1:1 channels: AUTO invokes Lex on every message.
  // - Multi-member channels: AUTO invokes Lex only for messages whose
  //   CHIME.mentions attribute carries the bot ARN (set by the frontend on
  //   `@assistant`). Messages addressed via Target also reach the bot via
  //   TargetedMessages: ALL.
  // - No mention in multi-member: bot stays silent. Humans chat freely.
}

/**
 * Allow the message through the channel flow
 */
async function callbackAllow(
  callbackId: string,
  channelArn: string,
  messageId: string,
  content: string,
  metadata?: string
): Promise<void> {
  await messagingClient.send(
    new ChannelFlowCallbackCommand({
      CallbackId: callbackId,
      ChannelArn: channelArn,
      ChannelMessage: {
        MessageId: messageId,
        Content: content,
        Metadata: metadata,
      },
    })
  );
}

/**
 * Deny a message in the channel flow (`DeleteResource: true`). The
 * message is not persisted, not delivered, and — critically — not
 * routed to Lex by Chime-native AUTO / `TargetedMessages: ALL`
 * (channel-flow gating happens before bot invocation). Used for a
 * battle continuation reply: the processor consumes it and resumes the
 * addressed bot directly, so the user's clarification answer never
 * broadcasts and never produces a duplicate Lex reply.
 */
async function callbackDeny(
  callbackId: string,
  channelArn: string,
  messageId: string,
): Promise<void> {
  await messagingClient.send(
    new ChannelFlowCallbackCommand({
      CallbackId: callbackId,
      ChannelArn: channelArn,
      DeleteResource: true,
      ChannelMessage: { MessageId: messageId },
    })
  );
}

interface HandleMentionParams {
  channelArn: string;
  content: string;
  senderArn: string;
  senderName: string;
  botArn: string;
  /** true: broadcast reply visible to everyone. false: targeted reply to sender only. */
  broadcast: boolean;
  /** Attachment-in (image/PDF/doc) from the triggering message Metadata; forwarded to the processor. */
  attachment?: MessageAttachment;
}

/**
 * Handle an @all or @assistant mention.
 *
 * Flow:
 * 1. Quick-path greetings/acknowledgments: respond directly as the bot
 * 2. Non-trivial content: send a placeholder, invoke async processor
 */
async function handleMentionedMessage(params: HandleMentionParams): Promise<void> {
  const { channelArn, content, senderArn, senderName, botArn, broadcast, attachment } = params;
  console.log('[ChannelFlow] Mention detected', { broadcast, senderName, hasAttachment: !!attachment });

  const targetArns = broadcast ? undefined : [senderArn];

  // Fast path: greetings / acknowledgments (no LLM call)
  const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
  const acknowledgments = ['thanks', 'thank you', 'okay', 'got it', 'great', 'perfect', 'cool', 'bye', 'goodbye'];
  const lower = content.toLowerCase();

  if (greetings.includes(lower)) {
    await sendBotMessage(
      channelArn,
      botArn,
      `Hi ${senderName || 'there'}. How can I help?`,
      targetArns,
    );
    return;
  }

  if (acknowledgments.includes(lower)) {
    await sendBotMessage(
      channelArn,
      botArn,
      'Happy to help. Let me know if you need anything else.',
      targetArns,
    );
    return;
  }

  // Non-trivial: send placeholder + invoke async processor
  if (!ASYNC_PROCESSOR_ARN) {
    console.warn('[ChannelFlow] ASYNC_PROCESSOR_ARN unset, cannot process mention');
    return;
  }

  const correlationId = `mention-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  await sendBotMessage(
    channelArn,
    botArn,
    `One moment... <!--corr:${correlationId}-->`,
    targetArns,
  );

  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: ASYNC_PROCESSOR_ARN,
        InvocationType: InvocationType.Event,
        Payload: Buffer.from(JSON.stringify({
          channelArn,
          correlationId,
          userMessage: content,
          userType: 'standard',
          botArn,
          senderArn,
          intent: 'general',
          deliveryOption: 'PLACEHOLDER_UPDATE',
          // Reply visibility is derived from the placeholder's actual Target in
          // the async processor (handleLongResponse) - the placeholder we just
          // sent above already carries the right Target (or none, for @all).
          // Attachment-in: forward the file reference so the processor can attach an
          // image/document Converse block. Undefined ⇒ normal text turn.
          attachment,
        })),
      })
    );
    console.log('[ChannelFlow] Async processor invoked for mention');
  } catch (error) {
    console.error('[ChannelFlow] Failed to invoke async processor:', error);
  }
}

/**
 * Send a message from the bot, optionally targeted to specific member ARNs.
 * When Target is set, the message is only visible to the listed members.
 *
 * Also stamps `targetedSender` into the message metadata when targeted: the
 * Chime WebSocket CREATE event doesn't reliably echo the Target field to
 * recipients, so the frontend's sticky-mention auto-set keys off the
 * metadata flag instead. (Same fields stay in `Target` for server-side
 * visibility enforcement -- this is a delivery-channel signal only.)
 */
async function sendBotMessage(
  channelArn: string,
  botArn: string,
  content: string,
  targetArns?: string[],
): Promise<void> {
  const isTargeted = !!targetArns && targetArns.length > 0;
  const metadata: Record<string, unknown> = { botResponse: true };
  if (isTargeted) metadata.targetedSender = targetArns![0];
  await messagingClient.send(
    new SendChannelMessageCommand({
      ChannelArn: channelArn,
      Content: content,
      Type: ChannelMessageType.STANDARD,
      Persistence: ChannelMessagePersistenceType.PERSISTENT,
      ChimeBearer: botArn,
      Metadata: JSON.stringify(metadata),
      ...(isTargeted && {
        Target: targetArns!.map((arn) => ({ MemberArn: arn })),
      }),
    })
  );
}

// ─────────────────────────────────────────────────────────────────
// /battle (SPEC-BATTLE.md)
// ─────────────────────────────────────────────────────────────────

interface HandleBattleContinuationParams {
  channelArn: string;
  battleId: string;
  rows: BattleStateRow[];
  resumeBotArns: string[];
  /** The user's clarification answer — becomes the resumed bot's prompt. */
  userAnswer: string;
  senderArn: string;
}

/**
 * Resume the addressed waiting bot(s) with the user's clarification
 * answer (SPEC-BATTLE.md "Per-bot reply UX"). Per-bot isolated: each
 * resumed bot re-enters round 1 with the answer as its new prompt; the
 * rival is untouched (it never sees the answer — measured-dimension
 * integrity).
 *
 * Both battle shapes (planBattleResume): a PLACEHOLDER/DIRECT battle
 * re-invokes plain with the answer as the prompt; a TASK_* battle
 * (row.taskId set, 2B-x-b-0) fetches the live task and resumes THAT
 * chain (its deliveryOption + taskType + id — the premium async
 * processor's existing TASK_* path advances the state machine with the
 * answer as the next turn). A TASK_* battle whose task is gone/terminal
 * degrades to a plain re-invoke rather than stranding the bot.
 *
 * The resumed answer rejoins the VISIBLE battle (broadcast placeholder)
 * because round-2 and the scorecard need both bots' answers in the
 * channel — only the Q&A side-channel was private.
 */
async function handleBattleContinuation(
  params: HandleBattleContinuationParams,
): Promise<void> {
  const { channelArn, battleId, rows, resumeBotArns, userAnswer, senderArn } = params;
  if (!PREMIUM_ASYNC_PROCESSOR_ARN) {
    console.warn('[ChannelFlow][battle] PREMIUM_ASYNC_PROCESSOR_ARN unset; cannot resume');
    return;
  }
  const bots = botRowsOnly(rows);
  await Promise.all(
    resumeBotArns.map(async (selfBotArn) => {
      const row = bots.find((r) => r.botArn === selfBotArn);

      // Resolve how this bot resumes: plain re-invoke for a
      // PLACEHOLDER/DIRECT battle; continue the existing task chain for
      // a TASK_* battle (row.taskId set at fan-out by 2B-x-b-0). A
      // missing/terminal task degrades to a plain re-invoke.
      const task = row?.taskId ? await getTask(row.taskId, channelArn) : null;
      const resumePlan = planBattleResume({ rowTaskId: row?.taskId, task });

      const rivalBotArn = bots.find((r) => r.botArn !== selfBotArn)?.botArn || '';
      const correlationId = `battle-r1c-${selfBotArn.split('/').pop()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // WAITING_FOR_USER → INVOKED, banking the wait. If we did not own
      // the transition (redelivery / race / not actually waiting) do NOT
      // invoke — prevents a double resume.
      const resumed = await resumeBotFromWaiting({ battleId, botArn: selfBotArn, correlationId });
      if (!resumed) {
        console.log('[ChannelFlow][battle] continuation no-op (not the WAITING→INVOKED writer)', {
          battleId,
          botArn: selfBotArn,
        });
        return;
      }

      // Reuse the bot's existing "waiting" message (2B-x-d persisted its
      // id): the async processor updates THAT message (battlewaiting
      // marker → final answer), so there is no orphan stale "waiting"
      // message and the marker clearing is the frontend's "waiting
      // ended" signal. Only when the id is somehow absent (older row)
      // do we fall back to creating a fresh placeholder.
      const waitingMsgId = row?.waitingMessageId;
      if (!waitingMsgId) {
        try {
          await sendBotMessage(
            channelArn,
            selfBotArn,
            `One moment... <!--corr:${correlationId}--><!--battle:battleId=${battleId},round=1,total=2,rivalArn=${rivalBotArn}-->`,
          );
        } catch (err) {
          console.warn('[ChannelFlow][battle] continuation placeholder failed for', selfBotArn, err);
          return;
        }
      }

      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: PREMIUM_ASYNC_PROCESSOR_ARN,
            InvocationType: InvocationType.Event,
            Payload: Buffer.from(
              JSON.stringify({
                channelArn,
                correlationId,
                userMessage: userAnswer,
                userType: 'premium',
                botArn: selfBotArn,
                senderArn,
                intent: 'general',
                deliveryOption: resumePlan.deliveryOption,
                ...(resumePlan.taskType && { taskType: resumePlan.taskType }),
                ...(resumePlan.taskId && { taskId: resumePlan.taskId }),
                // Reuse the waiting placeholder when we have it; absent →
                // the async processor polls for the fallback placeholder.
                ...(waitingMsgId && { placeholderMessageId: waitingMsgId }),
                battleContext: {
                  battleId,
                  round: 1,
                  totalRounds: 2,
                  selfBotArn,
                  rivalBotArn,
                  rivalReply: undefined,
                  // Original /battle message id is unrecoverable here;
                  // the round-2 orchestrator tolerates '' (it does
                  // `originatingMessageId || ''`). Persisting it is a
                  // later refinement, out of scope for 2B-x-b.
                  originatingMessageId: '',
                },
              }),
            ),
          }),
        );
      } catch (err) {
        console.error('[ChannelFlow][battle] continuation invoke failed for', selfBotArn, err);
      }
    }),
  );
}

interface HandleBattleParams {
  channelArn: string;
  userMessageId: string;
  content: string;
  senderArn: string;
  senderName: string;
  /** Default bot ARN (always the first bot member of the channel). */
  defaultBotArn: string;
  /** Phase-3 vision-in: image attachment on the `/battle` turn, if any. */
  imageAttachment?: BattleImageAttachment;
}

/**
 * Handle a `/battle` slash command.
 *
 * Flow:
 * 1. Tier gate — premium-tier channels only. Non-premium gets a targeted
 *    bot reply explaining the requirement.
 * 2. Battle-enabled check (ChannelBattleConfig). If Battle Mode is off for
 *    this channel, reply with a one-line "not enabled here — ask a
 *    moderator" hint and stop. A no-op command explains itself.
 * 3. Single-active-battle guard via ChannelBattleConfig (battle-state).
 *    A second `/battle` while one is in flight gets a targeted "already in
 *    progress" reply (best-effort; the gate is a soft lock).
 * 4. List channel memberships, filter to bot ARNs. The <2-bot-members case
 *    is a degenerate internal state (battle was enabled but the alt-bot
 *    slot isn't a member) — fall back to a single broadcast reply.
 * 5. For each bot member: send a per-bot placeholder, write the initial
 *    INVOKED state row, invoke the premium async processor with a
 *    battleContext payload.
 */
async function handleBattleMessage(params: HandleBattleParams): Promise<void> {
  const { channelArn, userMessageId, content, senderArn, defaultBotArn, imageAttachment } = params;
  console.log('[ChannelFlow][battle] Detected', { channelArn, senderArn });

  // 1. Tier gate. Resolve tier from the immutable `classification` tag (not mutable
  //    metadata) so a tampered modelTier cannot open premium battles on a lower channel.
  const channelTier = await getChannelTier(channelArn, defaultBotArn);

  if (channelTier !== 'premium') {
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      "Battles are only available on premium-tier channels. Reply normally and I'll respond as usual.",
      [senderArn],
    );
    return;
  }

  // 2. Battle-enabled check. The ChannelBattleConfig.enabled flag must be
  //    set (admin or moderator toggled Battle Mode on for this channel).
  //    Without this, the alt-bot slot isn't a channel member and there's
  //    no second-bot to fan out to.
  const battleEnabled = await isBattleEnabled(channelArn);
  if (!battleEnabled) {
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      "Battle Mode isn't enabled on this channel. Ask a moderator to flip the toggle in the members panel, then try /battle again.",
      [senderArn],
    );
    return;
  }

  // 3. List bot members of the channel.
  let botMembers: string[] = [];
  try {
    const resp = await messagingClient.send(
      new ListChannelMembershipsCommand({
        ChannelArn: channelArn,
        ChimeBearer: defaultBotArn,
        MaxResults: 50,
      }),
    );
    botMembers = (resp.ChannelMemberships || [])
      .map((m) => m.Member?.Arn || '')
      .filter((arn) => arn.includes('/bot/'));
  } catch (err) {
    console.warn('[ChannelFlow][battle] ListChannelMemberships failed:', err);
    return;
  }

  if (botMembers.length < 2) {
    console.log('[ChannelFlow][battle] <2 bot members, falling back to @all');
    await handleMentionedMessage({
      channelArn,
      content,
      senderArn,
      senderName: params.senderName,
      botArn: defaultBotArn,
      broadcast: true,
    });
    return;
  }

  if (!PREMIUM_ASYNC_PROCESSOR_ARN) {
    console.warn('[ChannelFlow][battle] PREMIUM_ASYNC_PROCESSOR_ARN unset, cannot fan out');
    return;
  }

  // 4. Per-bot fan-out. Deterministic battleId from (channelArn, userMessageId)
  //    so retries are idempotent.
  const battleId = deriveBattleId(channelArn, userMessageId);

  // Classify the prompt once (same for every bot) → decide whether this
  // is a TASK_* battle. Fail-safe to a normal PLACEHOLDER battle so a
  // classifier hiccup never blocks the fan-out.
  let battlePlan: { deliveryOption: DeliveryOption; taskType?: string };
  let classifiedIntent: string;
  try {
    const c = await classifyIntent(content);
    classifiedIntent = c.intent;
    battlePlan = planBattleTaskDelivery(c.intent);
  } catch (err) {
    console.warn('[ChannelFlow][battle] classifyIntent failed; PLACEHOLDER fallback:', err);
    classifiedIntent = 'general';
    battlePlan = { deliveryOption: DeliveryOption.PLACEHOLDER_UPDATE };
  }

  console.log('[ChannelFlow][battle] Fanning out', {
    battleId,
    botCount: botMembers.length,
    intent: classifiedIntent,
    deliveryOption: battlePlan.deliveryOption,
    taskType: battlePlan.taskType,
  });

  // Stamp the channel→battle pointer so a later continuation reply (a
  // new message whose id can't re-derive this battleId) can resolve it.
  // Non-fatal by contract — never blocks the fan-out.
  await setActiveBattle({ channelArn, battleId });

  // Phase-4 generation-out: if the bound experiment marks BOTH variants
  // with an image-gen model, this is an image battle — resolve the
  // per-side model ids once (control = default bot, treatment = alt
  // slot). null ⇒ text battle; the field stays unset and the processor
  // runs a normal text battle (resolveBattleGenerationOutPlan → 'text').
  // Non-fatal: a resolver hiccup must never block the fan-out.
  const altSlotArn = botMembers.find((arn) => arn !== defaultBotArn) || '';
  let imageGenPair: { controlModelId: string; treatmentModelId: string } | null = null;
  try {
    if (altSlotArn) imageGenPair = await resolveBattleImageGenPair(altSlotArn);
  } catch (err) {
    console.warn('[ChannelFlow][battle] resolveBattleImageGenPair failed; text battle:', err);
  }

  // A: working-state placeholders. Resolve variant displayNames (Atlas/
  // Echo) once so each per-bot placeholder marker can carry name= and
  // the frontend can render "<name> is drafting..." instead of a static
  // "One moment...". Best-effort: a resolver hiccup must never block
  // the fan-out - placeholders just fall back to the bot's Chime name.
  let controlName: string | undefined;
  let treatmentName: string | undefined;
  try {
    if (altSlotArn) {
      const [ctrl, treat] = await Promise.all([
        resolveBattleControlVariantByAltSlotArn(altSlotArn),
        resolveBattleVariantBySlotArn(altSlotArn),
      ]);
      controlName = ctrl?.displayName;
      treatmentName = treat?.displayName;
    }
  } catch (err) {
    console.warn('[ChannelFlow][battle] displayName lookup failed; placeholders use generic name:', err);
  }

  await Promise.all(
    botMembers.map(async (thisBotArn) => {
      const rivalBotArn = botMembers.find((arn) => arn !== thisBotArn) || '';
      const correlationId = `battle-r1-${thisBotArn.split('/').pop()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const variantName = thisBotArn === defaultBotArn ? controlName : treatmentName;
      const namePart = variantName ? `,name=${encodeURIComponent(variantName)}` : '';

      // Per-bot placeholder. Sent as that bot (ChimeBearer: thisBotArn) so
      // the channel sees the right author. The marker carries name= so
      // the frontend can render a working-state ("<name> is drafting...")
      // immediately, without waiting for the round-1 battlestats marker.
      try {
        await sendBotMessage(
          channelArn,
          thisBotArn,
          `One moment... <!--corr:${correlationId}--><!--battle:battleId=${battleId},round=1,total=2,rivalArn=${rivalBotArn}${namePart}-->`,
        );
      } catch (err) {
        console.warn('[ChannelFlow][battle] Failed to send placeholder for', thisBotArn, err);
        return;
      }

      // TASK_* battle: give THIS bot its own task, assigned to it
      // (per the owner decision — separate task per assistant). Each
      // bot's chain runs independently; round-1 completes when it's
      // terminal (the gate in the async tail). Created BEFORE the state
      // row so the row can record taskId — the continuation router uses
      // its presence to tell a TASK_* battle from a placeholder one.
      let battleTaskId: string | undefined;
      if (battlePlan.taskType) {
        try {
          const task = await createBattleTask({
            channelArn,
            userArn: senderArn,
            assignedBotArn: thisBotArn,
            battleId,
            userMessage: content,
            taskType: battlePlan.taskType,
            deliveryOption: battlePlan.deliveryOption,
          });
          battleTaskId = task.taskId;
        } catch (err) {
          console.warn('[ChannelFlow][battle] createBattleTask failed for', thisBotArn, err);
        }
      }

      // Record the initial INVOKED state row so the orchestrator can see
      // the bot is in flight; carries taskId for a TASK_* battle so the
      // continuation router can distinguish it. attribute_not_exists
      // makes this idempotent across channel-flow redelivery.
      await initBotState({
        battleId,
        botArn: thisBotArn,
        correlationId,
        ...(battleTaskId && { taskId: battleTaskId }),
      });

      // Invoke the premium async processor with a battleContext.
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: PREMIUM_ASYNC_PROCESSOR_ARN,
            InvocationType: InvocationType.Event,
            Payload: Buffer.from(JSON.stringify({
              channelArn,
              correlationId,
              userMessage: content,
              userType: 'premium',
              botArn: thisBotArn,
              senderArn,
              intent: classifiedIntent,
              deliveryOption: battlePlan.deliveryOption,
              ...(battlePlan.taskType && { taskType: battlePlan.taskType }),
              ...(battleTaskId && { taskId: battleTaskId }),
              battleContext: {
                battleId,
                round: 1,
                totalRounds: 2,
                selfBotArn: thisBotArn,
                rivalBotArn,
                rivalReply: undefined,
                originatingMessageId: userMessageId,
                ...(imageAttachment && { imageAttachment }),
                // Generation-out: control = default bot, treatment =
                // alt slot. Unset for a text battle (imageGenPair null).
                ...(imageGenPair && {
                  imageGenModelId:
                    thisBotArn === defaultBotArn
                      ? imageGenPair.controlModelId
                      : imageGenPair.treatmentModelId,
                }),
              },
            })),
          }),
        );
      } catch (err) {
        console.error('[ChannelFlow][battle] Failed to invoke premium async for', thisBotArn, err);
      }
    }),
  );
}
