/**
 * Channel Flow Processor
 *
 * Invoked by Amazon Chime SDK on every message in a channel, before any Amazon Lex invocation.
 *
 * WHAT THIS DOES AND DOES NOT DECIDE (MESSAGE-FLOW §6.1). This flow decides WHO responds. It does
 * not run the turn: classification, profile resolution, variant resolution, the delivery option and
 * the correlation id all belong to `router-agent-handler.ts`, the same code Lex fulfills into. A
 * decision duplicated here diverges SILENTLY, because the turn still answers either way.
 *
 * Responsibilities:
 * - Route `@all` and `@<assistant>` in a GROUP by handing the turn to the classification's handler,
 *   which posts its own acknowledgment; the reply is broadcast (ADR-034).
 * - Own every turn in a 1:1: `flowOwnsTheTurn` (lib/flow-bypass.ts) returns true there for
 *   every message that is not privately addressed, and a turn that carries no token (`claimedWithoutAToken`) is dispatched to the
 *   primary assistant. The handler reads the same function and stands down exactly when this flow
 *   acts. One responder, one path.
 * - Leave a message that resolves to a private `.` address to Amazon Chime SDK at every size
 *   (`flowOwnsTheTurn` returns false for it); the flow checks its stored `Target` (the
 *   private-address check below) and dispatches the turn itself only when that `Target` is missing
 *   and the address named an assistant. Every assistant carries `StandardMessages: NONE` +
 *   `TargetedMessages: ALL` (`assistant-profile-stack`):
 *     - TargetedMessages: ALL routes any Target-addressed message to Lex and produces a targeted
 *       reply back to the sender. This is how a PRIVATE `.<assistant>` message reaches an assistant.
 *       An `@<assistant>` sets no Target; this flow routes it (above).
 *     - StandardMessages: NONE turns no untargeted message into a Lex turn, a mention included
 *       (`CHIME.mentions` is a message attribute, not a `Target`). This flow is the only entry for
 *       an untargeted message, so one it does not dispatch is answered by nobody.
 * - Allow other messages through unmodified.
 * - Idempotency for at-least-once delivery
 *
 * IMPORTANT: Must call ChannelFlowCallback for every ASYNC invocation
 * to release the message. Failure to callback blocks the message.
 */

import {
  ChimeSDKMessagingClient,
  ChannelFlowCallbackCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
  GetChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { routeHandover, type HandoverDispatch } from './lib/handover-routing.js';
import { parseHandover } from './lib/assistant-handover.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  deriveBattleId,
  tryClaimRound1Fanout,
  initBotState,
  loadChannelBattleConfig,
  battleIsRunnableConfirmed,
  setActiveBattle,
  resolveActiveBattleId,
  resolveActiveBattle,
  readBattleRows,
  extractTargetedBotArns,
  isPastDeadline,
  duelIsLive,
} from './lib/battle-state.js';
import { endBattle } from './lib/battle-end.js';
import { callerIsChannelModerator } from './lib/channel-moderator.js';
import {
  extractImageAttachment,
  extractAttachment,
  type BattleImageAttachment,
  type MessageAttachment,
} from './lib/battle-attachment.js';
// NO intent classifier, NO variant or image-pair resolvers, NO task creation and NO delivery-option
// planner. Every one of those was a second implementation of a decision the handler already makes for
// every Lex turn, and the flow now hands the turn over instead (MESSAGE-FLOW §6.1). They are pinned
// as forbidden in `flow-does-not-run-the-turn.test.ts`, so they cannot come back quietly.
import { chimeStatusArtifactCode, isEmptyLexEnvelope, isNothingToPost, unwrapLexEnvelopeForChannel } from './lib/lex-envelope.js';
import { listExperimentsCached, invalidateExperimentsCache } from './lib/experiment-manager.js';
// NO task imports. Which chain a resumed side continues is a turn question, answered by the handler
// via the owner lookup (ADR-024); the flow asked it here and passed a delivery option down, which is
// how a resumed side lost its variant.
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { readChannelClassificationTag } from './lib/channel-classification.js';
import { battleCorrelationId, correlationMarkerOf } from './lib/correlation.js';
import { resolveChannelSize, type ChannelSize } from './lib/channel-size.js';
import { resolveRouterArn } from './lib/router-arn.js';
import { parseTaskReference } from './lib/task-reference.js';
import { extractTaskAnswerHint } from './lib/task-answer-metadata.js';
import { botMessageMetadata, type BotMessageAttribution } from './lib/bot-message-attribution.js';
import type { NoticeCopyKey } from './lib/assistant-notice.js';
// The bot-to-bot loop guard. Lands BEFORE the coordination feature that needs it (ADR-023 round 2),
// because the nudge would be the first bot-to-bot targeted message this system has ever sent.
import { evaluateBotToBot } from './lib/bot-coordination.js';
// The bypass tokens, shared with the router so the two sides cannot disagree about what one is.
// The private prefix. A separate module from the bypasses on purpose: `.` is routed by Amazon Chime
// SDK from the Target, `@` is routed here, and the two must not be confused for one another.
import { mightAddressPrivately, resolvePrivateTarget, stripPrivatePrefix } from './lib/private-prefix.js';
// A private address whose message carries no `Target` is not private: dropped, and the sender told.
import { enforcePrivateAddressTarget, privateMessageNoticeKind } from './lib/private-command.js';
// A finished answer declares itself final; the placeholder guard must not claim one.
import { declaresFinalAnswer } from './lib/turn-declaration.js';
import {
  flowOwnsTheTurn,
  matchesAtAll,
  matchesBattleCommand,
  matchCommand,
  mightMentionSomeone,
  resolveMentionedAssistant,
  resolveMentionedMember,
  stripAtAll,
  stripBattleCommand,
  stripMentionOf,
} from './lib/flow-bypass.js';
// TYPE-ONLY: the bypass contract, taken from the router itself so the two sides cannot drift. Erased
// at build time, so the router is not pulled into this bundle - the flow reaches it by INVOKE, which
// is the whole point (importing it would run the turn on the flow's IAM role, which holds no Bedrock
// or SSM grants).
import type { TurnRequest, LexResponse } from './router-agent-handler.js';
import { evaluateAbuseGate, claimPlaceholderMapping, claimCorrelation, flowDeliveryKey } from './lib/abuse-controls.js';
import { canRunBattle } from './lib/battle-enablement.js';
// A dispatch that never reached an assistant is recorded for the person it happened to, rather than
// posted as the assistant that never ran.
import { recordDispatchFailure } from './lib/turn-lock.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { primaryAssistantOf, memoizedTagReader } from './lib/conversation-primary.js';
import { turnAssistantProfileForBot, logAssistantDecline } from './lib/turn-assistant.js';
import { liveAssistantsByHandleOrThrow } from './lib/default-agents.js';
import { resolveTaskServiceArn } from './lib/classification-env.js';
import { botIdFromArn, personIdFromArn } from './lib/person-arn.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { decodeContent } from './lib/chime/history.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

/**
 * THE FLOW'S OWN ROLE: the callback, and the reads routing needs. It cannot post or edit as any bot, and it
 * holds no assistant session: the flow never speaks. A notice is said by the router (`sayNotice`), a duel's
 * waiting markers are cleared by the orchestrator (`battle-marker-clear.ts`), and a reply the router could
 * not post is posted by the processor that produced it.
 */
const messagingClient = chimeMessagingClient({});
const lambdaClient = new LambdaClient({});
const ssmClient = new SSMClient({});
// NO PROCESSOR ARNs HERE, and their absence is the point.
//
// The flow's bypass paths (`@all` and the `/battle` fan-out) hand the turn to the ROUTER, which
// dispatches its own worker, so the flow never chooses a worker. The router is resolved by
// `routerArnForClassification` (`lib/router-arn.js`), the only routing table this file has: each
// declared classification resolves to its own router or to nothing, and nothing falls back to another
// classification's router (ADR-046). The processor env vars the CDK still sets on this function are
// unread; removing them from the stack is safe cleanup, not a prerequisite.
//
// The per-classification ROUTER (`router-agent-handler`, the same Lambda Lex fulfills into). `@all`
// hands the turn here instead of running it, so classification, profile resolution, variant
// resolution and delivery-option choice happen ONCE, in the one place that does them for every turn
// (MESSAGE-FLOW §6.1).
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

/**
 * Whether this deployment declares `battle`: the flow is told the conversation battle-setting table at synth exactly
 * then (the capability's attach point on ChannelFlow), so a deployment without it answers `/battle` with no read.
 */
export function battleDeclared(): boolean {
  return Boolean(process.env.CHANNEL_BATTLE_CONFIG_TABLE);
}
// Read the channel's classification from its IMMUTABLE `classification` tag. This is a SHARED
// flow (one processor for all channels), so it discovers the classification per message and that
// choice decides which per-classification assistant responds and whether premium battles run. We
// must NOT read `metadata.modelTier`: metadata is mutable via the owner rename cap
// (chime:UpdateChannel), so a moderator could rewrite it to make another classification's
// assistant respond or open premium battles on a channel not cleared for them. The tag cannot be
// changed by UpdateChannel. Fail-closed to basic. (bearerArn is unused for a tag read.)
//
// MEMOIZED PER CONTAINER, BECAUSE THE TAG CANNOT CHANGE. It is the Layer-1 IAM boundary and the
// deployment treats it as immutable: `chime:UpdateChannel` cannot write it, and nothing in this
// codebase re-tags a channel after creation. So a second addressed message in a busy conversation was
// paying a `ListTagsForResource` for an answer that cannot have moved. Same shape as the SSM memo
// below, for the same reason.
//
// A FAILED OR INVALID READ IS NOT MEMOIZED, and that asymmetry is the whole care in this cache. The
// resolver fails CLOSED to the floor classification, which is the right answer for one turn and the
// wrong thing to pin: a single throttled tag read would otherwise answer every later message in a
// premium conversation at `basic` for the life of the container - a fail-closed value turned into a
// fail-closed conversation. Only a tag that was actually read, and that the registry recognizes, is
// kept.
//
// BOUNDED, because the key is a CHANNEL and a warm container sees unboundedly many of them. A miss
// costs one read and nothing else, so eviction is safe here in a way it explicitly was not for the
// delivery dedup this file replaced with a durable claim: that was a CONTROL wearing a cache's
// clothes, and this is a cache.
const CLASSIFICATION_MEMO_LIMIT = 1000;
const classificationMemo = new Map<string, string>();

/** One tag read per conversation, shared by the classification read above and the room's primary. */
const memoTagReader = memoizedTagReader(messagingClient);

async function getChannelClassification(channelArn: string, _bearerArn: string): Promise<string | undefined> {
  const memoized = classificationMemo.get(channelArn);
  if (memoized) return memoized;
  // AN UNREADABLE TAG IS UNDEFINED, NOT THE FLOOR (ADR-045 decision 2). This read was already honest
  // and then threw the honesty away on the next line. Substituting the floor here dispatched a turn
  // in a conversation whose classification nobody had read, as the floor classification's assistant -
  // and with every classification now battle-eligible, it also decided duels. The caller degrades
  // through the SAME path it already takes when there is no bearer: release the message, dispatch
  // nothing, say so.
  const tag = await readChannelClassificationTag(memoTagReader as unknown as ChimeSDKMessagingClient, channelArn, '[ChannelFlow]');
  if (tag === undefined) return undefined;
  if (classificationMemo.size >= CLASSIFICATION_MEMO_LIMIT) {
    // Oldest insertion first - a Map iterates in insertion order, so this is FIFO without a second
    // structure to keep in step with the first.
    const oldest = classificationMemo.keys().next().value;
    if (oldest !== undefined) classificationMemo.delete(oldest);
  }
  classificationMemo.set(channelArn, tag);
  return tag;
}

// THE ROOM'S PRIMARY ASSISTANT is resolved by `primaryAssistantOf` (lib/conversation-primary.ts), the one
// resolver every path that speaks for the room uses (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8, ADR-030).

// THE APP-INSTANCE ADMIN BEARER IS GONE FROM THIS FLOW. It was
// resolved for exactly one purpose: deleting a person's message whose private address disagreed with
// its stored `Target`, which the assistant itself may not do (measured 2026-09-15,
// `ForbiddenException`). Neither disagreement deletes any more - the message is kept and the sender is
// told - so the flow removes nothing, reads no admin parameter, and holds no delete permission. See
// `lib/private-command.ts`.

interface ChannelFlowEvent {
  CallbackId: string;
  ChannelMessage: {
    MessageId: string;
    Content: string;
    Metadata?: string;
    Sender?: { Arn: string; Name: string };
    ChannelArn?: string;
    /**
     * Targeted-delivery recipients (Amazon Chime SDK `Target`). Declared for completeness: measured, the
     * flow callback does NOT carry it (ADR-029), so nothing may route on it. Logged as `targets`.
     */
    Target?: { MemberArn?: string }[];
  };
  EventType: string;
  Channel?: {
    ChannelArn: string;
  };
}

/**
 * How a flow delivery is recognized as one already handled (SPEC-ABUSE-CONTROLS dedup, ADR-022).
 *
 * The same derived-key-plus-conditional-write control the rest of the codebase uses for at-least-once
 * delivery, and for the same reason `lib/correlation.ts` gives: a duplicate is not a symptom of a slow
 * handler that a faster one would remove, so idempotency is the whole answer rather than a stopgap.
 *
 * `MessageId` IS the derived key here, and it needs no hashing: Amazon Chime SDK replays it verbatim
 * on a redelivery. Measured - two invocations 139ms apart, different Lambda request ids, carrying one
 * `MessageId` and one `CallbackId`.
 *
 * WHAT THIS REPLACES, because the shape is the lesson. It was an in-memory `Set`, per warm container,
 * capped at 200 and evicting by insertion order. Two deliveries landing on two containers both missed
 * it, which is exactly what happened, and the name said "idempotency gate" the whole time. A dedup
 * that lives in a process is a same-container optimization wearing the label of a control.
 */
// Defined in `abuse-controls.ts` beside the claim itself: the task answer repair competes for this
// same key off the message stream to learn whether this flow already dispatched the message.

/**
 * Whether this invocation is an EDIT of a message rather than a send.
 *
 * Named against the events that are NOT a create, so an absent or unfamiliar `EventType` reads as a
 * send and behaves exactly as it did before this predicate existed. The vocabulary is the one the
 * archive already uses (`kinesis-archival.ts`), which is where the same events land.
 */
const NON_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'UPDATE_CHANNEL_MESSAGE',
  'REDACT_CHANNEL_MESSAGE',
  'DELETE_CHANNEL_MESSAGE',
]);

export const isMessageEdit = (eventType: string | undefined): boolean =>
  !!eventType && NON_TURN_EVENT_TYPES.has(eventType);

// `@all` is answered by this flow at every size, 1:1 included (`flowOwnsTheTurn` returns true for a
// 1:1 unconditionally). The one `@all` it does not own is a privately addressed one, which Amazon
// Chime SDK routes from its `Target`; see the `@all` branch far below. The agent handler reads the
// same function, so the two decisions stay exact complements. The message is always ALLOWED through;
// denying would drop the person's own message from the channel.

/**
 * WHEN THIS INVOCATION RECEIVED THE MESSAGE, on the server clock. The first instant of a standard turn
 * that the platform itself records: it splits the hop in front of the router (the message reaching the
 * flow, then the flow handing to the router), which TTFF could only report as one remainder. Held per
 * invocation rather than threaded through every hand-off site, so a hand-off cannot forget it.
 */
const flowReceipt = new AsyncLocalStorage<number>();

export async function handler(event: ChannelFlowEvent): Promise<void> {
  return flowReceipt.run(Date.now(), () => handleFlowEvent(event));
}

async function handleFlowEvent(event: ChannelFlowEvent): Promise<void> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
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
    // ── BOT-TO-BOT LOOP GUARD ──────────────────────────────────────────────────────────────────
    // FIRST, before any I/O. A denied message must not consume a correlation claim or trigger a
    // notify fan-out on its way to being dropped, and this is a pure function on data already in
    // hand, so it costs nothing on the path every bot message crosses.
    //
    // Dropping the message is the ONLY thing that stops the cycle, and only the flow can do it:
    // Chime routes a targeted message to the target bot's Lex before anything else in AE runs, so a
    // handler-side rule cannot prevent the invocation it would be reacting to. This is the flow
    // exercising its one exclusive power - deny - and deliberately not more than that.
    //
    // See `lib/bot-coordination.ts` for the cycle and why the unmarked case is the terminator.
    const coordination = evaluateBotToBot({
      senderArn,
      targetBotArns: extractTargetedBotArns(ChannelMessage.Target),
      content: Content,
    });
    if (coordination.action === 'deny') {
      const detail = {
        messageId: MessageId,
        reason: coordination.reason,
        sender: senderArn.split('/').pop(),
      };
      if (coordination.anomalous) {
        // Error level ON PURPOSE: the e2e backend-error guard greps handler logs for `ERROR`, so
        // this is how a coordination bug fails a run instead of accumulating in a log nobody reads.
        console.error('[ChannelFlow][SecurityEvent] bot-to-bot loop guard dropped a message', detail);
      } else {
        // The healthy end of an exchange. Info level, and worded clear of `ERROR`/`Exception`/
        // `Denied` so the guard above does not fail every duel that completes normally.
        console.log('[ChannelFlow] bot-to-bot exchange complete; dropping the empty reply', detail);
      }
      await callbackDeny(CallbackId, channelArn, MessageId);
      return;
    }

    // ── EMPTY LEX ENVELOPE ─────────────────────────────────────────────────────────────────────
    // An empty envelope is not a message, so it does not become one. Dropped HERE, before the
    // correlation claim and the notify fan-out, for the same reason as the loop guard above: it is a
    // pure function on data already in hand, and a message on its way to being dropped must not
    // consume a claim or fan out a notification.
    //
    // WHY THE FLOW AND NOT THE SENDER. `formatLexSilentResponse` returns `messages: []` deliberately -
    // it is a legitimate Lex reply for a turn that has nothing to say, and returning NO envelope is not
    // the same thing (Amazon Chime SDK materializes one message per turn from the last fulfillment
    // response, which is how the placeholder is created).
    // So the envelope keeps being sent and the flow, which holds the only power to deny, stops it from
    // being persisted. That is the same exclusive power the loop guard exercises, on the same shape of
    // thing: nothing to preserve, no user content lost.
    //
    // WHY DENY IS SAFE HERE, when it was rejected for `@all`. Denying an `@all` would have dropped the
    // USER's own words from the channel and from the assistant's history. An empty bot envelope has no
    // words to lose.
    //
    // THE CLIENT-SIDE GUARDS STAY. `isEmptyLexEnvelope` in the SPA and the archive readers still
    // handle this shape, because envelopes already written to history do not disappear. What changes
    // is that a NEW client does not have to know the shape exists.
    if (isEmptyLexEnvelope(Content)) {
      // Worded clear of `ERROR`/`Exception`/`Denied`: the e2e backend-error guard greps handler logs,
      // and this is the healthy path on every turn a handler fulfils silently.
      console.log('[ChannelFlow] empty Lex envelope; dropping it rather than persisting a non-message', {
        messageId: MessageId,
        sender: senderArn.split('/').pop(),
      });
      await callbackDeny(CallbackId, channelArn, MessageId);
      return;
    }

    // ── A JOIN THAT POSTS NOTHING ──────────────────────────────────────────────────────────────
    // A `WelcomeIntent` whose room a workflow run greets returns `NOTHING_TO_POST` (ADR-061 decision 5), because a
    // join that closes with no message makes Amazon Chime SDK post `{"Code":500}` past this flow. Denied here, so the
    // join leaves nothing in the room. The healthy path, so logged at info level.
    if (isNothingToPost(Content)) {
      console.log('[ChannelFlow] a join with nothing to post; dropping its stand-in', {
        messageId: MessageId,
        sender: senderArn.split('/').pop(),
      });
      await callbackDeny(CallbackId, channelArn, MessageId);
      return;
    }

    // ── AMAZON CHIME SDK STATUS ARTIFACT: A PERSON NEVER READS A STATUS CODE ───────────────────
    // `{"Code":500}` or `{"Code":429}` where an answer belongs. Dropped in the same place and for the
    // same reason as the empty envelope above: it is not a message, it has no user content to lose,
    // and the flow holds the only power to stop it being persisted.
    //
    // A DIFFERENT SHAPE, SO THE GUARD ABOVE CANNOT COVER IT. It carries no `Messages` key, so
    // `parseEnvelope` rejects it. The `500` a silent `WelcomeIntent` produces never reaches this check: it is
    // posted past the flow (measured 2026-10-29), which is why every bot with nothing to say on join omits its
    // WelcomeIntent, and a join that must say nothing returns `NOTHING_TO_POST`, denied above.
    //
    // LOGGED AT ERROR, DELIBERATELY, AND THIS IS THE POINT. These codes are the only outward sign of two
    // real defects: a `500` means a fulfillment was invoked that had nothing to say, and a `429` was how
    // a handler unable to reach its control plane presented itself for a whole debugging session. The
    // e2e backend-error guard greps handler logs for `ERROR`, so dropping one from the channel FAILS THE
    // RUN rather than tidying the symptom away. Hiding it from the person is right; hiding it from us
    // would make this guard the thing that conceals the next occurrence.
    const artifactCode = chimeStatusArtifactCode(Content);
    if (artifactCode !== null) {
      console.error('[ChannelFlow] Amazon Chime SDK status artifact in place of a reply; dropped from the channel', {
        messageId: MessageId,
        code: artifactCode,
        sender: senderArn.split('/').pop(),
        channelArn,
      });
      await callbackDeny(CallbackId, channelArn, MessageId);
      return;
    }

    // ── CARRYING LEX ENVELOPE: STORE THE TEXT, NOT THE WRAPPER ─────────────────────────────────
    // The other half of the same problem. An empty envelope is dropped above; a carrying one is
    // UNWRAPPED here, so what lands in the channel is the message a human would read.
    //
    // This is the case that actually happens on live traffic. The welcome persists today as
    //     {"Messages":[{"Content":"Hi - I'm your assistant at Stratum...","ContentType":"PlainText"}]}
    // and every reader downstream pays for it: the SPA unwraps it, the Athena admin read unwraps it,
    // the Aurora admin read does NOT and shows raw JSON, and an ad-hoc archive query has to know.
    // Unwrapping at the WRITE means each of those is reading text that was never wrapped.
    //
    // The flow is the right place because it is the last point that can still change what is STORED -
    // the callback's `Content` is what Amazon Chime SDK persists. Nothing here invents content: the
    // text written is the exact string the envelope carried.
    //
    // THE READERS ALL STAY. History holds wrapped rows and always will, and a reader that only handles
    // the new shape would break the old one. `unwrapLexEnvelope` on plain text is a no-op, so they
    // cost nothing on the new shape.
    //
    // ContentType is deliberately NOT touched. The flow never receives it and the callback would have
    // to invent one; leaving it means a client that still gates its unwrap on the Lex content type
    // simply finds nothing to unwrap, which is the same outcome by a shorter route.
    // IT MUST NOT SHORT-CIRCUIT THE REST OF THIS BRANCH. The first version of this returned straight
    // to `callbackAllow`, which skipped the duplicate-placeholder claim below - and the Lex-materialized
    // PLACEHOLDER ("One moment... <!--corr:...-->") is itself a carrying envelope, so that would have
    // disabled ADR-022's one-placeholder-per-turn enforcement for exactly the message it exists to
    // protect. The rewrite only changes what is WRITTEN at the end of the branch.
    const unwrapped = unwrapLexEnvelopeForChannel(Content);
    const storedContent = unwrapped ?? Content;
    if (unwrapped !== null) {
      console.log('[ChannelFlow] carrying Lex envelope; storing the text rather than the wrapper', {
        messageId: MessageId,
        sender: senderArn.split('/').pop(),
      });
    }

    // Duplicate-placeholder guard (ADR-022). A bot message carrying `<!--corr:{id}-->` is a placeholder
    // the async processor will update in place. Claiming the correlation against this MessageId keeps
    // the channel to ONE placeholder per turn.
    //
    // WHAT THIS SEES. Every bot message in the channel, INCLUDING ones Amazon Chime SDK materializes
    // from a Lex fulfillment return. This comment previously asserted the opposite - that a
    // Lex-created placeholder "never enters a channel flow" - and that is wrong. Verified live
    // 2026-08-06: a Lex fulfillment returned `{"Messages":[]}`, Chime created message
    // `7f5a1c78...` from it, and this flow was invoked for exactly that MessageId.
    //
    // That matters, because it makes this guard the backstop for the ROUTER's idempotent replay. The
    // router answers a duplicate fulfillment with the SAME placeholder rather than an empty envelope
    // (see `router-agent-handler.ts`), so if both attempts' responses ever materialize, both arrive
    // here carrying one correlation marker - and the second is denied below. One placeholder per turn
    // is enforced HERE, which is why the router is free to be idempotent rather than silent.
    //
    // It also catches a cross-container redelivery of an `@all`, which posts its placeholder before any
    // durable claim is taken; `/battle` is already claimed upstream (`tryClaimRound1Fanout`) and cannot
    // reach here twice.
    //
    // Denying a BOT message is safe; denying the user's own message would remove it from the
    // conversation, which is why the inbound side is never denied.
    //
    // THIS MAPPING IS LOAD-BEARING FOR RESOLUTION, not only a duplicate guard.
    //
    // It used to say the opposite - that the dispatching paths hand the processor
    // `placeholderMessageId` directly from the send, so resolution no longer depends on this - and that
    // stopped being true at ADR-025. The flow no longer sends the placeholder on a bypass at all: the
    // assistant posts its own, and the handler deliberately does NOT pass the id on (it dispatches the
    // worker BEFORE the message exists, and reordering every return path to buy one skipped GetItem was
    // priced and declined). Only the battle CONTINUATION supplies an id, because it answers onto a
    // message that already exists.
    //
    // So for `@all` and `/battle` round 1 this mapping IS how the processor finds the placeholder to
    // update. The stale comment mattered because it invited exactly one wrong edit - deleting a
    // "redundant" claim - which would leave both bypass paths resolving by marker scan or not at all.
    //
    // Compares the OWNER, not merely whether a mapping exists. The processor writes the answer over
    // the placeholder, and an updated message re-invokes this flow, so the same message is seen again
    // with the same correlation. Only a DIFFERENT message holding the same correlation is a duplicate.
    // Read from the UNWRAPPED text. The marker is a substring either way, so this is not a fix - it is
    // so that one string is the message from here down and there is no second definition of "the
    // content" for a later reader to pick the wrong one of.
    const corr = correlationMarkerOf(storedContent);
    // A FINISHED ANSWER IS NOT A PLACEHOLDER, and this guard only governs placeholders.
    //
    // It reads a `<!--corr:-->` marker as "something else will close this response", which held while
    // only placeholders carried one. A DIRECT answer carries one now, and it is complete when it is
    // posted - so it fell into a claim meant for a different kind of message. When the inbound lookup
    // cannot name what the turn answered, the id falls back to a 90-second time bucket: two short
    // greetings inside one window share an id, and the second real answer was DELETED rather than
    // shown. `phase=final` is declared by the turn precisely so finality is never inferred.
    if (corr && !declaresFinalAnswer(storedContent)) {
      const owner = await claimPlaceholderMapping(corr, MessageId);
      if (owner !== MessageId) {
        console.log('[ChannelFlow] duplicate placeholder denied', {
          correlationId: corr, messageId: MessageId, owner,
        });
        await callbackDeny(CallbackId, channelArn, MessageId);
        return;
      }
    }

    // THE NOTIFICATION FAN-OUT IS NOT HERE, AND THIS IS WHERE IT WAS (ADR-041 decision 7).
    //
    // A bot message tagged with `metadata.notify` reaches members who are not watching, over email
    // today and SMS or voice later (SPEC-NOTIFICATION-BRIDGE P1). That fan-out was AWAITED on this
    // line, in front of the `callbackAllow` below. The comment above it read "never blocks the
    // callback", which was true of its failures, because the catch swallowed them, and false of its
    // latency, because the callback was strictly downstream of the awaited call.
    //
    // What it awaited: one `chime:ListTagsForResource`, paid even in the conversations that will send
    // nothing; a paginated `chime:ListChannelMemberships`; then one `cognito-idp:AdminGetUser` and
    // one SES send per recipient, both serial. So a person waited to see the assistant's message
    // while the platform looked up and emailed people who were not in the room.
    //
    // AND IT COULD COST THE TURN RATHER THAN MILLISECONDS. A fan-out slow enough to carry this
    // invocation past the flow's 35 second deadline leaves the message to `FallbackAction: CONTINUE`,
    // which delivers it UNPROCESSED - with the raw Amazon Lex envelope rather than the unwrapped text
    // computed a few lines above. That is the failure direction, and it argues for the move on its
    // own: nothing measures the milliseconds.
    //
    // It now runs on the message stream (`lib/notify-on-delivery.ts`, a rule in
    // `message-post-processing.ts`), which carries `Metadata` intact and carries the STORED content,
    // so it needs nothing this pass could only have handed it. The cost is that the email lands later
    // by the stream's delivery time, which is seconds, and which is the correct trade for a message
    // to somebody who is not in the room. The stack's own invariant for the person pass -
    // `callbackAllow` first, so nothing delays a message reaching the channel - now holds on the
    // assistant pass too.
    await callbackAllow(CallbackId, channelArn, MessageId, storedContent, Metadata);

    // ── AN ASSISTANT HANDING A PERSON'S MESSAGE TO ANOTHER ASSISTANT (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.4)
    //
    // AFTER the release, never before it: the routing reads the roster and the stored message, and the
    // release must not wait on either (ADR-041 point 4). Amazon Chime SDK starts no Amazon Lex turn for an
    // assistant-authored message, so this dispatch is the only one; a handover this cannot route is
    // post-processing's to deliver. Only a message carrying the handover MARKER is considered, so model
    // text that happens to start with `.Name` is never routed.
    if (parseHandover(Metadata)) {
      let decodedForRouting = storedContent;
      try { decodedForRouting = decodeURIComponent(storedContent); } catch { /* keep the raw form */ }
      try {
        await routeHandover({
          source: 'flow',
          channelArn,
          handoverMessageId: MessageId,
          senderArn,
          content: decodedForRouting,
          metadata: Metadata,
        }, flowHandoverDeps);
      } catch (err) {
        console.error('[ChannelFlow] routing a handover failed; post-processing may still deliver it', {
          messageId: MessageId, err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return;
  }

  // ── AN EDIT IS NOT A NEW TURN ────────────────────────────────────────────────────────────────
  //
  // Chime re-invokes this flow when a persistent message is UPDATED (ADR-022), and until now nothing
  // here read `EventType` at all - the flow could not tell an edit from a send, and treated both the
  // same way.
  //
  // WHAT WAS ACTUALLY STOPPING AN EDITED `@all` FROM FANNING OUT AGAIN: nothing that meant to. The
  // bypass paths claim `flow-<MessageId>`, and `MessageId` is stable across an edit, so a re-invoke
  // inside the claim's window read as a duplicate delivery. That window is DEDUP_TTL_SECONDS = 300,
  // chosen to "cover a duplicate delivery burst" when Chime redelivers within seconds. Edit an
  // `@all` six minutes after sending it and the claim has expired: the flow fans the turn out a
  // second time, on the edited text, with a new correlation and no trace that it was an edit.
  //
  // So the guard is stated rather than inherited from a TTL, and it sits above the routing branches
  // for the same reason the bot loop guard sits above the I/O: the cheapest place to decide is before
  // anything is spent.
  //
  // THE MESSAGE IS STILL ALLOWED THROUGH. Returning without a callback leaves Chime holding it until
  // the flow times out, and `FallbackAction: CONTINUE` then delivers it UNPROCESSED - bypassing the
  // mention rules and marker stripping this flow exists to apply. Allowing is the no-op: the edit
  // lands in the channel exactly as the person wrote it, and simply starts no turn.
  //
  // BELOW THE BOT BRANCH, deliberately. A bot's own update carries marker stripping and the
  // loop guard, which must keep running; this rule is about a PERSON editing what they said.
  //
  // FAIL-OPEN ON AN UNRECOGNIZED VALUE. An absent or unfamiliar `EventType` behaves exactly as it
  // did before this existed, because the two directions are not symmetric: a wrong guess that
  // processes costs one unwanted turn, and a wrong guess that skips costs every turn on the
  // deployment. Only an explicitly non-create event stands down.
  if (isMessageEdit(event.EventType)) {
    console.log('[ChannelFlow] an edited message starts no turn', {
      messageId: MessageId, eventType: event.EventType,
    });
    // UNSTAMPED, and deliberately. An edit starts no turn, so there is no correlation to carry - and
    // an edit's content is the person's, already stamped on the CREATE if it was going to be.
    await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
    return;
  }

  const decodedContent = decodeContent(Content);
  // Detect against BOTH the decoded and raw Content. decodeContent
  // returns the raw string UNCHANGED if decodeURIComponent throws on any
  // malformed %-sequence anywhere in the message — which would leave a
  // percent-encoded leading token and silently defeat the slash-command
  // test, dropping the entire battle fan-out. /battle is the process
  // trigger; a missed detection is unrecoverable, so test both forms.
  // The token definitions live in `lib/flow-bypass.ts` and the ROUTER imports the same ones. They
  // used to be declared here and separately in the router's silence guard, and they drifted: this
  // side gained `/battle`, that side kept testing `@all` alone, and a `/battle` in a 2-member channel
  // was answered by both entries. `/battle` remains a slash command (start of the trimmed message
  // only, never mention syntax) and the command still wins if both somehow appear. See SPEC-BATTLE.md.
  const mentionsAll = matchesAtAll(decodedContent) || matchesAtAll(Content);
  const invokesBattle = matchesBattleCommand(decodedContent) || matchesBattleCommand(Content);
  // WHICH COMMAND, IF ANY, THIS MESSAGE INVOKES. Read from the registry in `lib/flow-bypass.ts`
  // rather than tested token by token, so a command added there is routed here without this file
  // changing. `StandardMessages: NONE` invokes no assistant for an unaddressed message, so a command
  // the flow does not route reaches no assistant at all - which is what the registry exists to stop
  // happening once per command.
  //
  // `@all /stop` and `@Atlas /stop` are NOT this shape: they are claimed by the address branches
  // below, which strip the address and dispatch the remainder, so the router sees the same command
  // either way.
  const invokedCommand = matchCommand(decodedContent) || matchCommand(Content);
  console.log('[ChannelFlow] routing', {
    invokesBattle,
    mentionsAll,
    // How many recipients this message is Target-addressed to, AS THE FLOW RECEIVES IT. Logged because
    // its absence is indistinguishable in every other record: a targeted message the flow sees as
    // untargeted looks exactly like one the user never targeted.
    targets: (ChannelMessage.Target ?? []).length,
    // Its counterpart. `Target` does NOT survive into this event and `Metadata` does, which is what
    // makes Metadata the only per-message channel a client has to this code - Lex never sees either.
    metaLen: (Metadata ?? '').length,
    decodeChanged: decodedContent !== Content,
    rawHead: JSON.stringify(Content).slice(0, 64),
    decHead: JSON.stringify(decodedContent).slice(0, 64),
  });

  // The channel's per-classification bot (its real member) is the bearer for every bot-attributed
  // action below - @all broadcast, member count, and the /battle default combatant. No shared bot is a
  // channel member, so only the per-classification bot can read the channel and send.
  //
  // FROM THE CHANNEL'S TAG, not from the sender. An earlier version of this comment said the
  // classification was read as the sender, which it is not: `getChannelClassification` ignores the
  // bearer it is passed and reads the immutable tag, which is what every live classification
  // decision in this codebase reads. Reading it from the person would let one member's tier decide
  // what the room is.
  //
  // AND WHAT IS BEING RESOLVED IS A ROLE (ADR-030). The caller needs the assistant that holds the
  // PRIMARY role - the one that takes a turn nobody addressed, and the one that may hand work to
  // another assistant. The CLASSIFICATION is not that answer; the room's `primaryAssistant` tag is, resolved
  // through the assignment records by `primaryAssistantOf` (§3.8). A room holding two assistants of one
  // classification resolves to the one its tag names.
  //
  // WHAT IS GENUINELY ABSENT IS PER-ROOM PRIMACY. Primacy is recorded per classification, so every
  // room of that classification gets the same primary and a conversation cannot name a different one.
  // That is a missing degree of freedom rather than an ambiguity, and nothing here guesses.
  //
  // ── RESOLVED AT THE FIRST CHECK THAT NEEDS ONE, NOT ABOVE THE PREFILTERS ──────────────────────
  //
  // Both reads used to run right here, before anything had decided whether either answer was wanted.
  // A plain human-to-human message - no `@`, no `.`, no command, which is the overwhelming majority of
  // what a busy conversation carries - paid a `ListTagsForResource` and (on a cold container) an
  // `ssm:GetParameter` for two values that no later check on its path ever read. The prefilters below
  // already exist to keep the roster read off that message; these two sat above them.
  //
  // Every consumer is behind a token. The roster read, the private-address enforcement, the duel, the
  // `@all` and `@<assistant>` dispatches and the unaddressed-command dispatch are all reached only
  // through the gate below, and each of them needs the bearer that gate's read already resolves. The
  // ONE consumer that is not is the leading task reference (`resolveReferenceTarget`), which by
  // definition runs on a message carrying no token - so it takes these as accessors and calls them
  // only after the free test for a reference has passed.
  let classificationOnce: Promise<string | undefined> | null = null;
  /** The honest read: `undefined` when the tag could not be read. Only the bearer gate calls this. */
  const readClassification = (): Promise<string | undefined> => {
    classificationOnce ??= getChannelClassification(channelArn, senderArn);
    return classificationOnce;
  };
  /**
   * The classification, for the consumers that cannot act without one.
   *
   * THE THROW IS A BACKSTOP AND IS UNREACHABLE ON TODAY'S ORDERING. Every consumer below runs only
   * after `resolvePrimaryBearer`, and that returns null for an unreadable tag, which releases the
   * message before any of them is reached. What this guards is a future reordering that puts a
   * consumer ahead of the bearer: it fails loudly there rather than quietly substituting the floor,
   * which is the behavior ADR-045 decision 2 removed and the one worth making hard to reintroduce.
   */
  const resolveClassification = async (): Promise<string> => {
    const classification = await readClassification();
    if (classification === undefined) {
      throw new Error('[ChannelFlow] classification unreadable and a consumer asked for it anyway');
    }
    return classification;
  };
  // THE BEARER, OR NULL - and null is a decision rather than a fault (see the degradation below).
  let primaryBearerOnce: Promise<string | null> | null = null;
  const resolvePrimaryBearer = (): Promise<string | null> => {
    primaryBearerOnce ??= (async () => {
      // AN UNREADABLE CLASSIFICATION TAKES THE BEARER AWAY, and it does so on purpose (ADR-045
      // decision 2). The bearer IS a classification's assistant, so with no classification there is
      // no assistant to act as - exactly the condition the degradation below already describes, and
      // reached the same way: the message is released unprocessed, nothing is dispatched, and one
      // line says why the conversation went quiet. Before this, the floor was substituted and the
      // floor's assistant acted in a room nobody had classified.
      const classification = await readClassification();
      if (classification === undefined) {
        console.error('[ChannelFlow][SecurityEvent] channel classification unreadable; releasing the '
          + 'message and dispatching nothing', { channelArn });
        return null;
      }
      try {
        const primary = await primaryAssistantOf(channelArn, memoTagReader, '[ChannelFlow]');
        if (primary.classification !== classification) throw new Error(`[ChannelFlow] the room's primary is a ${primary.classification} assistant in a ${classification} room`);
        return primary.botArn;
      } catch (err) {
        // ── THE FLOW HAS NO BEARER, SO IT ACTS AS NOBODY ────────────────────────────────────────
        //
        // An empty or unreadable `bot-arn` parameter is a deployment fault, and it takes away every
        // action this flow could still take on the message: the roster read, the private-address
        // read-back, the delete, the notices and the dispatch are all made AS the assistant, and
        // there is no assistant to be. The only thing left that does not need a bearer is the
        // callback itself.
        //
        // SO THE MESSAGE IS RELEASED UNPROCESSED, DELIBERATELY. That is the same outcome the
        // deployment already had - this used to throw, the invocation failed, and Amazon Chime SDK
        // delivered the message unprocessed under `FallbackAction: CONTINUE` when the flow's 35 s
        // deadline passed - but it is reached in milliseconds instead of 35 seconds, it resolves the
        // callback instead of leaving the service holding the message, and it says in one line why
        // the conversation went quiet. The retries the throw bought back nothing: an asynchronous
        // Lambda retry lands minutes later, long after the fallback has already delivered the
        // message and consumed the `CallbackId`, so it could only ever have dispatched a turn onto a
        // message the room had been reading for two minutes.
        //
        // NOT DENIED, EVER. Denying deletes a person's message, and a missing parameter is not a
        // reason to take somebody's words out of their conversation.
        console.error('[ChannelFlow] no primary assistant for this conversation; releasing the message unprocessed', {
          messageId: MessageId,
          channelArn,
          classification,
          err: (err as Error)?.message,
        });
        return null;
      }
    })();
    return primaryBearerOnce;
  };

  // ═══════════════════════════════════════════════════════════════
  // WHO IS IN THE ROOM, AND WHO DOES THIS MESSAGE ADDRESS (ADR-034).
  //
  // Every `@` token is now routed HERE rather than by Amazon Chime SDK. `@all` always was; `@<member>`
  // used to be a client-set `Target`, which restricted who could READ the message as a side effect of
  // saying who it was FOR. Addressing a message and making it private are different acts, so `@`
  // keeps the message readable by the room and `.` (the composer's private prefix) keeps the Target.
  //
  // READ ONCE, HERE, AND PASSED DOWN. The roster answers three questions that must agree with each
  // other - is this a 1:1, does this message name somebody, and is that somebody an assistant - and
  // reading it separately per question would let two of them disagree about who is in the room. It is
  // also the SAME read the size branch already paid for `@all`, so the roster costs nothing new.
  //
  // NOT GATED. The roster is read for every message a person sends (`carriesAToken` below), because
  // the flow starts every standard turn and deciding whether it owns this one needs the room size.
  // The cheap prefilters (`mightMentionSomeone`, `mightAddressPrivately`) do not decide whether the read
  // happens; they are early answers for the branches that key on a specific token, and evidence
  // of an address when the roster read fails (`rosterUnreadableAndAddressed`). `/battle` does not
  // need the roster: the flow owns a duel at every channel size.
  // ═══════════════════════════════════════════════════════════════
  const mightMention = mightMentionSomeone(decodedContent) || mightMentionSomeone(Content);
  // The `.` prefix is resolved from the SAME roster, because it is the same question - who is in this
  // conversation - and two reads could answer it differently. It is NOT a bypass: Amazon Chime SDK
  // routes a `.member` message from the `Target` the composer set, so the flow resolves it to say
  // what the message MEANS and then keeps its hands off the turn. See `lib/private-prefix.ts` for
  // what this side can and cannot enforce about privacy.
  const mightBePrivate = mightAddressPrivately(decodedContent) || mightAddressPrivately(Content);
  // THE FLOW STARTS EVERY STANDARD TURN, so this gate is open for every message a person sends.
  //
  // Every assistant carries `StandardMessages: NONE` (`assistant-profile-stack`), which makes the
  // channel flow the only thing that can start an untargeted turn. Deciding whether it owns THIS one
  // needs the room size, so the token prefilters above stop being a gate and become what they now
  // are: a cheap early answer for the branches below that still key on a specific token.
  //
  // WHAT THIS COSTS, AND WHERE IT WAS PUT. The roster is a live `ListChannelMemberships` on every
  // message. ADR-041 rule 4 places it AFTER `callbackAllow`, so the person sees their own words
  // first and the read is traded against the Amazon Chime SDK to Amazon Lex to Lambda hop it replaces
  // rather than added in front of them.
  //
  // NO CLASSIFICATION READ HAPPENS FOR THE ENTRY. It used to, because the entry was a per-profile
  // field and answering "which entry" meant answering "which profile serves this channel". The field
  // is gone: the entry is one project invariant, so there is nothing to look up.
  const carriesAToken = true;
  let size: ChannelSize | null = null;
  let resolvedBearer: string | null = null;
  let releasedEarly = false;

  if (carriesAToken) {
    // THE FIRST CHECK THAT NEEDS THE BEARER, and so the first that pays for it.
    resolvedBearer = await resolvePrimaryBearer();
    if (!resolvedBearer) {
      // No assistant to act as. `resolvePrimaryBearer` has already logged why; release and stand down.
      await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
      return;
    }
    // ── RULE 4 (ADR-041): THE READ THAT DECIDES WHO ANSWERS GOES AFTER THE RELEASE ───────────────
    //
    // `resolveChannelSize` is a live, paginated `ListChannelMemberships`, and the flow is SYNCHRONOUS:
    // until `callbackAllow` resolves, the person has not seen their own message. Under
    // the channel flow starts every standard turn, the token gate above stops being a gate, so this read is paid on EVERY
    // message rather than on the addressed ones, which is precisely when its placement starts to
    // matter. Releasing first makes the entry change a comparison between this read and the Amazon
    // Chime SDK to Amazon Lex to Lambda hop it replaces, rather than a new cost added in front of the
    // person while the saving lands somewhere else.
    //
    // NOT WHEN THE MESSAGE MIGHT BE PRIVATE. `enforcePrivateAddressTarget` owns the release on that
    // path: it releases and then reads the stored `Target` back, and it needs `privateTo` - which only
    // the roster can resolve - to know whether it runs at all. So the possibly-private message keeps
    // today's order and releases exactly once, inside the check. `mightBePrivate` is the cheap regex
    // prefilter, so this asks a question already answered in memory.
    //
    // THE DISPATCH IS NOT MOVED, only the read. Dispatching before the release is a different and
    // refused proposal (ADR-041 rule 8): it would answer a message that may still be denied or edited.
    // ── AND NOT WHEN THE REPAIR WILL COMPETE FOR THIS MESSAGE ─────────────────────────────────────
    //
    // Releasing puts the message on the stream, and `task-answer-repair` acts on exactly one shape:
    // a person's message whose `Metadata` names an open item. That component competes for
    // `flow-<MessageId>` to decide which of the two dispatches the turn, and it can only be the
    // FLOW's decision if the flow has taken the claim by the time the repair reads it.
    //
    // The claim is taken at the dispatch decision below, which needs the roster, so it cannot move up
    // here. The release can move DOWN instead, and only for this shape: a message carrying a task
    // hint waits the roster read before it lands, and every other message keeps the early release the
    // latency work added.
    //
    // WHAT THE RACE COSTS, WHICH IS WHY IT IS WORTH A READ. Whoever wins dispatches, so there is no
    // double answer either way - but the two dispatch DIFFERENTLY. The repair posts publicly
    // (ADR-030) under the assignee-only rule, and on the `.assistant`-without-`Target` branch the
    // flow standing down also swallows the "that wasn't private" notice it owes the sender. A code
    // review found the comment in `task-answer-repair.ts` asserting the opposite order; it is
    // corrected there.
    // ── A POSSIBLY-PRIVATE MESSAGE RELEASES EARLY TOO ────────────────────────
    //
    // This used to exclude `mightBePrivate`, because `enforcePrivateAddressTarget` owned the release
    // on that path. That was right while the check could DELETE a misdirected message: you cannot
    // un-release. It cannot any more - every outcome now reports and the message proceeds as sent
    // ("now that neither deletes", `lib/private-command.ts`) - so the exclusion outlived its reason.
    //
    // WHAT IT COST. The check runs after the roster read, so a private message waited for
    // `resolveChannelSize` before the person saw their own words, while every other message was
    // already released. A missing or wrong `Target` is an edge case; the normal path was paying its
    // latency.
    //
    // The check still runs and still reports. It is handed a no-op release when the message is already
    // out, so it releases exactly once either way - which is the property the old exclusion was
    // protecting, kept without the wait.
    const mightBeRepaired = !!extractTaskAnswerHint(Metadata)?.taskId;
    if (!mightBeRepaired) {
      await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
      releasedEarly = true;
    }
    size = await resolveChannelSize(messagingClient, channelArn, resolvedBearer);
    // ── AN UNREADABLE ROSTER USED TO DEGRADE TO LEX, AND THERE IS NO LEX (review, 2026-09-17) ─────
    //
    // Everything below reads the roster: `isOneToOne` decides whether the flow owns an unaddressed
    // turn, and `mentioned` / `privateTo` can only resolve an address against members. When the read
    // fails, all three answer "no" - so a plain 1:1 message AND an addressed group message both fall
    // through to no branch at all, the message is released, and nobody answers. The comment below
    // this block still promised "an unreadable channel degrades to the ordinary Lex path answering,
    // never to nobody answering", which stopped being true when `StandardMessages: NONE` made this
    // flow the only entry.
    //
    // RETRIED ONCE, because the usual cause is a transient throttle and the router's own size read
    // makes the same retry for the same reason. A refusal is NOT retried: that is the classification
    // boundary speaking (ADR-045) and asking twice only probes it twice.
    if (size.unknown && !size.refused) {
      size = await resolveChannelSize(messagingClient, channelArn, resolvedBearer);
    }
    if (size.unknown) {
      // STILL UNREADABLE. The flow cannot tell a 1:1 from a group, and cannot resolve any address, so
      // it cannot decide correctly - but standing down is now a guaranteed silence rather than a
      // hand-off. So the fail direction is per SHAPE, the same split `channel-size.ts` reasons about:
      //
      //  - a message that LOOKS addressed (a mention, `@all`, a private prefix, a command) is
      //    dispatched to the primary assistant. It may reach the wrong assistant in a multi-assistant
      //    room, which is visible and recoverable; the alternative is a person addressing an
      //    assistant by name and being ignored with no trace.
      //  - a message that looks unaddressed is left alone. In a real group that is correct, and in a
      //    1:1 it costs one turn during an outage rather than answering every group message.
      //
      // A refusal takes neither branch: it is not an outage and this assistant may not act here.
      console.warn('[ChannelFlow] the roster could not be read; the flow is the only entry, so an '
        + 'addressed message is dispatched to the primary assistant rather than left unanswered', {
        channelArn,
        messageId: MessageId,
        refused: size.refused,
        looksAddressed: mightMention || mentionsAll || mightBePrivate || invokedCommand !== null,
      });
    }
  }
  // THE BEARER, AS THE BRANCHES BELOW READ IT. Empty exactly when this message carried no token at
  // all, and every branch below that reads, posts or dispatches as the assistant is gated on one:
  // `/battle` on `invokesBattle`, `@all` and the unaddressed command on `ownsTheTurn`, the mention and
  // the private-address check on an address that only a roster could have resolved. The reference
  // branch is the exception and resolves its own bearer lazily, because it runs on a message with no
  // token - which is why it takes the accessor rather than this string.
  const botArn = resolvedBearer ?? '';
  const roster = size?.members ?? [];
  // AN ASSISTANT NAMED ANYWHERE IN THE MESSAGE ANSWERS IT, even when a person is named first.
  // `resolveMentionedMember` returns the EARLIEST token, which answers "who is this addressed to" and
  // not "must an assistant answer". Those differ for a message that names both - a shape the composer
  // explicitly allows - and taking the earliest made "@Alice and @Atlas, thoughts?" reach nobody: the
  // flow saw a person and dispatched nothing while the handler stood down because a member WAS named.
  // Reversing the two names worked, which is the kind of difference nobody reproduces on purpose.
  const mentioned = resolveMentionedAssistant(decodedContent, roster)
    ?? resolveMentionedAssistant(Content, roster)
    ?? resolveMentionedMember(decodedContent, roster)
    ?? resolveMentionedMember(Content, roster);
  // FULL NAME OR IT IS NOT A PRIVATE PREFIX. A dot followed by something
  // name-shaped that names nobody here is ordinary text - ".env is missing" is a sentence about a
  // file - and it must not be read as an address on either side of the seam.
  const privateTo = resolvePrivateTarget(decodedContent, roster)
    ?? resolvePrivateTarget(Content, roster);

  // THE ONE ANSWER BOTH SIDES READ. The agent handler asks this same function and stands down when it
  // is true, so the flow acting and the handler declining are complements by construction rather than
  // by two lists agreeing - which is the drift that once answered a `/battle` twice.
  //
  // BOTH FORMS, exactly as every other token test on this path and on the handler's. A single
  // malformed %-sequence anywhere in the message makes `decodeURIComponent` throw, and
  // `decodeContent` then returns the raw string unchanged - so asking the decoded form alone
  // would miss a token the raw form carries. `mentionsAll` and `invokesBattle` above already test
  // both for that reason, and the `@all` branch below now turns on THIS answer rather than on the
  // member count directly - so a decoded-only question here would be a way for the two to disagree,
  // and the disagreement would read as a group `@all` taking the 1:1 stand-aside and being answered
  // by nobody. Cheap to keep aligned; silent when it is not.
  //
  // `isOneToOne` false when the roster could not be read. That used to degrade to the ordinary Amazon
  // Lex path answering; with `StandardMessages: NONE` there is no such path, so this answer alone
  // would degrade to NOBODY answering. `rosterUnreadableAndAddressed` below is what carries an
  // addressed message through instead - see the retry where `size` is resolved.
  const ownsTheTurn = flowOwnsTheTurn({ text: decodedContent, members: roster, isOneToOne: size?.isOneToOne ?? false })
    || flowOwnsTheTurn({ text: Content, members: roster, isOneToOne: size?.isOneToOne ?? false });

  // THE ADDRESSING DECISION, RECORDED. Every outcome below this point is silent in the channel: a
  // mention that named nobody, a mention of a person, and a message with no mention at all all leave
  // the same trace - the message appears and no assistant speaks. Without this line they cannot be
  // told apart from any record the system keeps, which is exactly how a person being ignored in front
  // of the room would go unnoticed. Names are NOT logged; the fields say shape, not identity.
  if (size) {
    console.log('[ChannelFlow] addressing', {
      messageId: MessageId,
      ownsTheTurn,
      mentionsAll,
      namedSomeone: mentioned !== null,
      namedAnAssistant: mentioned?.isBot ?? null,
      // A `.` prefix that RESOLVED. Logged as a shape, never a name: it says the message means to be
      // private and whether the addressee is an assistant, which is what makes an otherwise invisible
      // routing outcome diagnosable. Whether a `Target` was actually set is not in this event; the
      // private-address check below reads it from the stored message.
      privatelyAddressed: privateTo !== null,
      privatelyAddressedAnAssistant: privateTo?.isBot ?? null,
      rosterSize: roster.length,
      isOneToOne: size?.isOneToOne ?? null,
      rosterUnknown: size?.unknown ?? null,
    });
  }

  // ── A PRIVATE ADDRESS MUST CARRY THE `Target` ITS TEXT NAMES ──
  //
  // The text says only the addressee may read this message; the `Target` is what actually decides it,
  // and this callback does not carry one. The stored message does, but a held message cannot be read
  // (measured 2026-09-15), so the check releases the message and reads it back as the assistant. The
  // message is NEVER deleted. When the stored form disagrees with the text, it stays in the
  // conversation and the sender is told, privately, which of the two happened: no `Target` at all
  // (`untargeted`: the room can read it, and when the address named an assistant the turn is still
  // routed and answered privately), or a `Target` naming a member other than the one `.Alice`
  // resolved to (`misdirected`: no turn starts). A message whose `Target` names its addressee, or that
  // the assistant cannot read (the expected case for one targeted at a person), proceeds exactly as
  // sent. See `lib/private-command.ts`.
  //
  // ONLY ON A RESOLVED PRIVATE ADDRESS, so ordinary traffic pays nothing: `privateTo` is null unless
  // the anchored prefix named a real member. NOT WHEN IT NAMES THE SENDER, because the composer never
  // addresses a person to themselves and so never sets a `Target` for it; that message is prose.
  let releasedByPrivateCheck = false;
  if (privateTo && privateTo.arn !== senderArn) {
    const check = await enforcePrivateAddressTarget({
      client: messagingClient,
      channelArn,
      messageId: MessageId,
      botArn,
      // THE MEMBER THE TEXT ADDRESSED, so the check can confirm the `Target` names THAT member rather
      // than merely existing. Already resolved above from the roster this turn already read, so the
      // comparison costs nothing: no second lookup, and none is possible anyway - the roster is the
      // only thing that can say who `.Alice` means.
      addresseeArn: privateTo.arn,
      addresseeIsBot: privateTo.isBot,
      // ALREADY OUT, SO THIS RELEASES NOTHING. The early release above covers this path now; the
      // callback stays a parameter rather than being removed because the check is the only releaser
      // on any path that skips the early one, and a function that sometimes releases and sometimes
      // does not is clearer as one that is handed what to do.
      release: releasedEarly
        ? async () => {}
        : () => callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata),
    });
    releasedByPrivateCheck = true;
    // A MISDIRECTED MESSAGE STARTS NO TURN. It is kept, like the untargeted one, but nothing is routed:
    // the text addressed a member and the message reached a different one, so there is no assistant
    // that was asked anything. The sender is told, and that is the whole of it.
    if (check.outcome === 'misdirected') {
      // CLAIMED, FOR THE REASON THE BRANCH BELOW ALREADY STATES (review, 2026-09-17). This one
      // returns above the shared `dispatchesATurn` claim too, so nothing else covered it: a
      // redelivered message whose `Target` named the wrong member told the sender twice that their
      // private message went to somebody else - the same defect the `untargeted` branch claims to
      // prevent, on the disclosure that is more alarming to receive.
      if (!(await claimCorrelation(flowDeliveryKey(MessageId)))) {
        console.log('[ChannelFlow] duplicate delivery of a misdirected private address; already handled', {
          messageId: MessageId,
        });
        return;
      }
      await sayNotice({
        classification: await resolveClassification(),
        channelArn,
        botArn,
        kind: privateMessageNoticeKind('wrong-target'),
        to: [senderArn],
      });
      return;
    }

    // ── NO `Target`: THE MESSAGE STAYS, AND AN ASSISTANT THAT WAS NAMED STILL ANSWERS ──
    //
    // The sender's client did not set the `Target` their text asked for, so the room can read this.
    // Two things are owed and they are independent: the sender must learn their message was not
    // private, and - if they addressed an ASSISTANT - they must still get the answer they asked for.
    // Dropping the turn would cost them their question for a defect in their client.
    //
    // THE NOTICE GOES FIRST, and deliberately so. It is the half that is true regardless of what
    // happens next, and sending it first means a failure to dispatch still leaves the person informed
    // rather than silent. It is targeted at the sender: the room can already see the message, and
    // announcing "that wasn't private" to everyone would point at it.
    if (check.outcome === 'untargeted') {
      // CLAIMED LIKE EVERY OTHER DISPATCH, and claimed before the notice rather than before the turn.
      // This branch returns above the shared `dispatchesATurn` claim below, so nothing else covers it:
      // a redelivery would otherwise tell the sender twice and answer twice, which is exactly the
      // defect recorded there for a redelivered `/stop`. The notice is inside the claim because two
      // notices for one message is its own bug, and because the two halves are one response to one
      // message. The message is already released by the check above, so a lost claim simply stops.
      if (!(await claimCorrelation(flowDeliveryKey(MessageId)))) {
        console.log('[ChannelFlow] duplicate delivery of a private address with no Target; already handled', {
          messageId: MessageId,
        });
        return;
      }
      await sayNotice({
        classification: await resolveClassification(),
        channelArn,
        botArn,
        kind: privateMessageNoticeKind('not-private', check.disposition),
        to: [senderArn],
      });
      // A PERSON WAS NAMED: there is no turn to run. `.Alice hello` is a message for Alice, and an
      // assistant answering it would be answering a message that was never addressed to it.
      if (!privateTo.isBot) return;

      // AN ASSISTANT WAS NAMED. `requestWasPrivate` addresses the answer at the sender, and the
      // answer inherits that `Target` (`replyTargetAudience`), so the exchange the sender asked to be
      // private IS private from here on even though their own message was not. That is the best
      // available outcome: the question is already public and cannot be unsaid, the answer is the
      // longer and more revealing half, and it is still recoverable.
      //
      // THE PREFIX IS STRIPPED, as `@` is for a mention: `.Atlas what is a feature flag` asks about
      // feature flags, and leaving the address in the text would put the assistant's own name in front
      // of every such question.
      const privateMessage = stripPrivatePrefix(decodedContent, privateTo);
      const privateAttachment = extractAttachment(Metadata);
      if (!privateMessage && !privateAttachment) {
        // A bare `.Atlas` with nothing else: addressed, but with no request in it. Dispatching would
        // strand a placeholder that never resolves, exactly as the `@` branch avoids.
        console.log('[ChannelFlow] a private address named an assistant with no message; nothing to answer', {
          messageId: MessageId,
        });
        return;
      }
      await handOffTurnToRouter({
        channelArn,
        classification: await resolveClassification(),
        content: privateMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        botArn: privateTo.arn,
        // THE ONE DISPATCH THAT IS A PRIVATE REQUEST, and the only one that sets this. The person
        // addressed an assistant with `.`, so the task this opens is theirs alone and the answer is
        // addressed back to them. See `handOffTurnToRouter` for why no other path may claim it.
        requestWasPrivate: true,
        attachment: privateAttachment,
        messageId: MessageId,
      });
      return;
    }
  }

  // A REPLY TO A DUEL SIDE THAT ASKED A QUESTION IS NOT HANDLED HERE. It reaches that side's Lex as an
  // ordinary turn and the handler resumes the side (`resumeDuelSideIfWaiting`), because the flow callback
  // carries no `Target` and so cannot recognize the reply (ADR-029, ADR-030).

  // Idempotency for the bypass paths.
  //
  // A DURABLE CLAIM, so it works across containers. A redelivery of the same message reaches a
  // different Lambda invocation, usually a different container, and the guard this replaces lived in
  // one container's memory - so both attempts believed they were the first. `claimCorrelation` is the
  // same conditional write the processor and the round-1 fan-out already claim with, and it FAILS OPEN:
  // a dedup-table outage degrades to today's duplicate rather than dropping a turn.
  //
  // CLAIM-BEFORE-DISPATCH, AND THE WINDOW THAT LEAVES - stated because it is a decided trade, not an
  // oversight. A winner that dies BETWEEN this claim and its dispatch makes the redelivery no-op, and
  // that turn is lost. Bounded on both sides: the claim carries the dedup TTL (5 minutes - only
  // redeliveries inside it are swallowed, and Chime redelivers within seconds), and the window itself
  // is a hard crash only - every dispatch path that can FAIL (router invoke, membership read, missing
  // router) now notifies the sender instead of throwing through. Claiming after dispatch instead
  // would reopen the double-answer this claim exists to prevent, which is the worse direction: a
  // duplicate is visible and confusing, a rare lost turn is retryable by the person.
  //
  // CLAIMED ONLY WHERE A TURN IS ACTUALLY DISPATCHED, which is narrower than "the flow owns this
  // turn" (ADR-034). Three cases own a turn without starting one, and each must leave the claim
  // unspent:
  //
  //  - `@<person>`. Addressing a colleague starts no turn at all. A claim here would be spent on a
  //    message nothing is processing, and the redelivery it then swallows would be a no-op anyway -
  //    but the claim is the only record that a turn was taken, and spending it on a turn that never
  //    existed makes that record mean two different things.
  //  - `@all` IN A 1:1, where the Lex entry answers instead and this side returns without dispatching.
  //  - An `@` naming nobody, which dispatches nothing by design.
  //
  // `@all` above 1:1, `@<assistant>`, and `/battle` do dispatch, and they claim.
  // ── A MESSAGE THAT ANSWERS AN OPEN ITEM, NAMING NOBODY (ADR-035) ─────────────────────────────
  //
  // `#2 EMEA only`, or a message whose `Metadata` carries the item's id, answers work without
  // addressing anyone - and in a group Amazon Chime SDK delivers only addressed messages to an
  // assistant, so without this it reaches nobody. The flow routes it the way it routes an `@` token,
  // and ONLY when the task service says the sender may answer that item: a member cannot start a turn
  // in a room by naming an item. Everything else about the message is untouched.
  //
  // THE ID IS THE CLIENT'S WAY TO SAY IT, THE REFERENCE IS THE PERSON'S. A client showing the item
  // knows its id and says so out of band, which keeps the routing instruction out of the words the
  // room reads; a reply arriving by SMS or email has only text, so the typed reference stays.
  //
  // IT TAKES THE ACCESSORS, NOT THE VALUES. This is the one branch reachable by a message that
  // carries no token at all, so it is the one place the classification and the bearer are not already
  // resolved - and resolving them for it would put both reads back on every ordinary message, which is
  // the whole cost this gate exists to avoid. Both selectors are free to test - one `JSON.parse`, one
  // regex, over values already in memory - so the accessors are called only for a message that really
  // does name an item.
  const referenceTarget = !ownsTheTurn && !mentionsAll && !invokesBattle && !mentioned && !privateTo
    ? await resolveReferenceTarget({
      text: decodedContent,
      metadata: Metadata,
      channelArn,
      classification: resolveClassification,
      senderArn,
      botArn: resolvePrimaryBearer,
      size,
    })
    : null;

  // An unaddressed command the flow owns dispatches a turn too, so a redelivery of it is claimed like any
  // other; without this a bare `/stop` delivered twice stopped twice and acknowledged twice.
  // A TURN THIS FLOW CLAIMED THAT CARRIES NO TOKEN AT ALL. Computed HERE, above
  // the dedup claim, rather than at the branch that uses it far below: this dispatches a turn, so a
  // redelivery of it has to be claimed like every other dispatch. Left out of `dispatchesATurn` it
  // would answer twice on a redelivered message, which is the defect the `/stop` note above records.
  // The full reasoning for the shape of this predicate is at the branch itself.
  // ── RESOLVED, NOT PREFILTERED, AND THE DIFFERENCE LOSES TURNS ───────────────────────────────────
  //
  // This read `!mightMention` and `!mightBePrivate` - the cheap regex prefilters - while the dispatch
  // decision below reads the RESOLVED `mentioned`. The two disagree for exactly the messages the
  // resolvers exist to separate: text that looks addressed and names nobody here.
  //
  // `install @aws-sdk/client-s3`, `ping @ryan` in a room ryan is not in, `.env is missing`. Each sets
  // a prefilter, so this was false; each resolves to nobody, so `mentioned?.isBot` is false too. No
  // branch fires, the message is released, and with the flow as the only entry (`StandardMessages:
  // NONE`) nothing else was ever going to answer. The person gets silence, and the addressing log
  // above is the only trace - the diagnostic warn further down is gated on `!isOneToOne`.
  //
  // The prefilters keep their job, which is deciding whether to PAY for the roster read. Once it is
  // paid, the resolved answer is the one every other branch uses and this must use it too.
  const claimedWithoutAToken =
    ownsTheTurn && !mentioned && !mentionsAll && !privateTo && !invokesBattle && invokedCommand === null;
  /**
   * AN ADDRESSED MESSAGE THE ROSTER COULD NOT RESOLVE, dispatched to the primary rather than dropped.
   *
   * `ownsTheTurn`, `mentioned` and `privateTo` all answer "no" when the roster read failed, so every
   * branch declines and the message is released unanswered. That was a hand-off while Amazon Lex was
   * a second entry; with `StandardMessages: NONE` it is a guaranteed silence. The prefilters are the
   * only evidence left that somebody addressed somebody, so they decide here - see the retry above
   * for why the fail direction is per shape.
   *
   * NOT ON A REFUSAL. `refused` is the classification boundary, not an outage: this assistant may not
   * act in this conversation at all, so dispatching would be the degradation ADR-045 removes.
   */
  const rosterUnreadableAndAddressed = size?.unknown === true && size.refused !== true
    && (mightMention || mentionsAll || mightBePrivate || invokedCommand !== null);
  const dispatchesATurn =
    invokesBattle || (ownsTheTurn && (mentionsAll || mentioned?.isBot === true || invokedCommand?.dispatch === 'primary'))
    || claimedWithoutAToken
    || rosterUnreadableAndAddressed
    || referenceTarget !== null;
  if (dispatchesATurn && !(await claimCorrelation(flowDeliveryKey(MessageId)))) {
    console.log('[ChannelFlow] duplicate delivery; this message is already handled', { messageId: MessageId });
    // STILL CALL BACK. The claim says the message was handled, not that its callback was resolved: a
    // first attempt that died between claiming and calling back would otherwise leave Chime holding
    // the message until it times out, and `FallbackAction: CONTINUE` then delivers it UNPROCESSED,
    // bypassing the mention rules and marker stripping this flow exists to apply. Resolving a callback
    // the winner already resolved is harmless now that an already-decided callback is not an error.
    if (!releasedEarly) await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
    return;
  }

  // Release the original message so all participants can see it, unless it is already released:
  // either by the private-address check, which releases before reading its `Target` back, or by
  // rule 4 above, which releases before the roster read for a message that cannot be private.
  if (!releasedByPrivateCheck && !releasedEarly) {
    await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
  }

  // ═══════════════════════════════════════════════════════════════
  // /battle: per-bot fan-out for adversarial replies (SPEC-BATTLE.md).
  // Premium-classification only. If Battle Mode isn't enabled on the channel the
  // user gets a one-line "not enabled here" hint (handleBattleMessage) —
  // a no-op command should explain itself, not silently broadcast.
  // ═══════════════════════════════════════════════════════════════
  if (invokesBattle) {
    // Strip /battle from whichever form actually carried it — if only the
    // raw Content matched (decoded form was mangled), stripping the decoded
    // one would leave the prefix and pass a junk prompt to the battle.
    const battleSource = matchesBattleCommand(decodedContent) ? decodedContent : Content;
    const cleanMessage = stripBattleCommand(battleSource);
    console.log('[ChannelFlow] battle dispatch', {
      source: battleSource === decodedContent ? 'decoded' : 'raw',
      cleanLen: cleanMessage.length,
      willDispatch: cleanMessage.length > 0,
    });
    // `/battle end` - the explicit way out, and the reason the refusals above have something to name.
    //
    // A duel is a container: the person who started it, or a moderator, can end it, and the task inside
    // it ends with it (DESIGN-BATTLE 2a-i). Before this there was no such action at all - an unfinished
    // duel ended only when a clock expired - so every path that needed to say "you can leave" had to
    // tell people to wait instead.
    //
    // A COMMAND rather than a yes/no conversation, deliberately. "End it" typed mid-duel is ambiguous
    // between the battle and the report being collected inside it, and a wrong guess destroys work. A
    // literal command cannot be misread, is the same in every language the channel speaks (tenet D11),
    // and is testable without an NLU round trip.
    if (cleanMessage.trim().toLowerCase() === 'end') {
      // ENDING IS THE WAY OUT, so it must not be the thing that throws. `/battle end` needed no
      // classification until the notice copy did, and `resolveClassification` throws on an unreadable
      // tag - which, because the message is already released and its delivery already claimed, left
      // the retry standing down and `end` doing nothing at all, silently. The person's only escape
      // from a duel became the command most likely to fail quietly.
      //
      // ERROR level deliberately: the e2e backend-error guard greps for it, so a deployment where the
      // tag cannot be read fails a run rather than accumulating stuck duels.
      try {
        await handleBattleEnd({ channelArn, classification: await resolveClassification(), senderArn, defaultBotArn: botArn });
      } catch (err) {
        console.error('[ChannelFlow] /battle end failed; the duel is still running', { channelArn, err });
      }
      return;
    }
    if (cleanMessage) {
      await handleBattleMessage({
        channelArn,
        classification: await resolveClassification(),
        userMessageId: MessageId,
        content: cleanMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        defaultBotArn: botArn,
        // THE ROSTER THE ADDRESS PASS ALREADY READ. A duel is a command, so the gate above has read
        // it; the bot-member gate reads it from here rather than making a second, differently
        // paginated call of its own.
        size,
        // Phase-3 vision-in: an image on the `/battle` turn rides the
        // message Metadata (same pipeline as any attachment).
        imageAttachment: extractImageAttachment(Metadata),
      });
    } else {
      // A no-op command explains itself, exactly as the not-enabled and non-premium hints do.
      //
      // This used to log and return, which was survivable only while the Lex entry still answered a
      // bare `/battle` as an ordinary turn. It does not any more: the router now returns silence for
      // EITHER bypass token (`flowBypassToken`), which is what stopped a 2-member `/battle` being
      // answered twice. Correct for a real duel, but it left the no-prompt case with no responder at
      // all - a deterministic silent command, which reads as the assistant being broken.
      //
      // Targeted at the sender: their typo is not the channel's business.
      console.warn('[ChannelFlow] /battle with empty prompt — no dispatch; explaining to the sender');
      // THE CLASSIFICATION READ IS INSIDE THE GUARD: `resolveClassification` throws on an unreadable
      // tag, and that must not escape the handler from the branch that exists to explain a typo.
      try {
        await sayNotice({
          classification: await resolveClassification(),
          channelArn,
          botArn,
          kind: 'battleNeedsPrompt',
          to: [senderArn],
        });
      } catch (err) {
        console.warn('[ChannelFlow] empty-/battle hint failed', err);
      }
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // @all: broadcast bot response. One of the two Lex bypasses (the other is /battle). The reply is
  // visible to all members, and bypassing Lex is the only sanctioned difference from an ordinary turn
  // (MESSAGE-FLOW §6.1).
  //
  // WHO ELSE MIGHT ANSWER: nobody. `StandardMessages: NONE` invokes Lex for no untargeted message, so
  // this dispatch is the only thing that can answer an `@all`, at every size including a 1:1
  // (`flowOwnsTheTurn` returns true for both). The agent handler reads the same function and stands
  // down, so EXACTLY ONE entry answers.
  //
  // The message is still ALLOWED through (never denied). Denying drops the user's own message from
  // the channel - unpersisted, invisible to the other members and absent from the assistant's history.
  // ═══════════════════════════════════════════════════════════════
  if (mentionsAll) {
    // The size was resolved above, with the roster, in the one read that serves every `@` decision
    // this handler makes, so the ownership answer and the mention resolution see the same room.
    if (!ownsTheTurn) {
      // One shape lands here: a privately addressed message, which Amazon Chime SDK routes from its
      // `Target` (`flowOwnsTheTurn` returns false for a resolved private target at every size).
      console.log('[ChannelFlow] @all the flow does not own — deferring to the Lex entry', {
        channelArn,
        memberCount: size?.memberCount ?? null,
        privatelyAddressed: privateTo !== null,
      });
      return;
    }

    const cleanMessage = stripAtAll(decodedContent);
    // Attachment-in (image/PDF/doc) rides the @all bypass: the async processor reads the file. The
    // router's `@all` guard is what keeps a 1:1 from ALSO processing it through Lex.
    const allAttachment = extractAttachment(Metadata);
    if (cleanMessage || allAttachment) {
      await handOffTurnToRouter({
        channelArn,
        classification: await resolveClassification(),
        content: cleanMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        botArn,
        attachment: allAttachment,
        messageId: MessageId,
      });
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // AN UNADDRESSED COMMAND GOES TO THE PRIMARY ASSISTANT.
  //
  // That is the rule, and this is the one place it is carried out. A command with no address means
  // "do this here", at every size, and `StandardMessages: NONE` gives it no other way to an assistant:
  // without this branch the message is persisted, read by everybody, and acted on by nobody. For
  // `/stop` that means the person watches an assistant keep working after they told it to stop, which
  // is the moment the design is most visible.
  //
  // WHICH COMMANDS REACH HERE is the registry's decision, not this branch's: `dispatch: 'primary'`.
  // `/battle` declares `own-handler` and was claimed above, because a duel fans out across two
  // assistants and is not a turn the primary runs. A command added to the registry with `primary`
  // is routed by this branch without it changing.
  //
  // THE PRIMARY ASSISTANT, by the same resolution every other unaddressed turn uses (`primaryAssistantOf`):
  // the room's own `primaryAssistant` tag (§3.8).
  //
  // For a stop, even that is narrower than it looks: `lib/stop-target.ts` asks which assistant is meant
  // again on the other side and REFUSES to guess when the room really does hold several - so an
  // ambiguous stop is asked about rather than silently aimed, and this dispatch is what gets it far
  // enough to be asked.
  //
  // ═══════════════════════════════════════════════════════════════
  if (invokedCommand?.dispatch === 'primary') {
    if (!ownsTheTurn) {
      // ONE SHAPE REACHES HERE, and it is handled elsewhere: a PRIVATELY ADDRESSED command.
      // `flowOwnsTheTurn` returns false for a resolved private target ABOVE the size check, and
      // `TargetedMessages: ALL` holds under every reachable configuration - so Amazon Chime SDK
      // invokes Amazon Lex from the `Target` and for `/stop` the router then REFUSES it.
      //
      // A ONE-TO-ONE CANNOT REACH HERE AT ALL any more: that return is unconditionally true. The
      // comment this replaced justified the deferral with "at 1:1 AUTO always invokes Lex", a premise
      // `StandardMessages: NONE` deleted, and it stayed correct only because the 1:1 case stopped
      // being reachable at the same moment - safe by coincidence of two changes rather than by
      // design. Deleting the per-profile entry is what turned that coincidence into an invariant.
      if (size?.isOneToOne && privateTo === null) {
        console.error('[ChannelFlow][Invariant] deferring a 1:1 command, which nothing else will answer', {
          channelArn,
          command: invokedCommand.token,
          detail: 'flowOwnsTheTurn returns true for every 1:1, so reaching this is a contradiction',
        });
      }
      console.log('[ChannelFlow] command the flow does not own - deferring to the Lex entry', {
        channelArn,
        command: invokedCommand.token,
        memberCount: size?.memberCount ?? null,
        privatelyAddressed: privateTo !== null,
      });
      return;
    }

    console.log('[ChannelFlow] unaddressed command dispatched to the primary assistant', {
      channelArn,
      command: invokedCommand.token,
      memberCount: size?.memberCount ?? null,
    });
    // BROADCAST, because an unaddressed command is not private: it was sent to the room, and for a
    // stop it changes what the room sees an assistant doing, so the room has to be able to see that
    // it happened. That is the same rule the router enforces from the other direction by refusing a
    // privately sent stop.
    //
    // The content is passed through unstripped - there is no address on it to remove, and the
    // command's own parser on the far side expects the command itself.
    await handOffTurnToRouter({
      channelArn,
      classification: await resolveClassification(),
      content: decodedContent,
      senderArn,
      senderName: ChannelMessage.Sender?.Name || '',
      botArn,
      messageId: MessageId,
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // @<member>: the message names ONE member of this conversation (ADR-034).
  //
  // WHY THIS IS ROUTED HERE AND NOT BY THE SERVICE. `@<assistant>` used to be a client-set `Target`,
  // and `TargetedMessages: ALL` delivered it. That worked, and it made addressing a message
  // inseparable from restricting who could read it: everybody in the room saw somebody typing to the
  // assistant and saw no reply, because the reply was visible only to the sender. Addressing and
  // privacy are different acts. `@` now sets no `Target` and the flow routes it, so the exchange
  // stays readable by the room; `.` is what makes a message private, and the service still routes
  // that one from its `Target`.
  //
  // WHAT MAKES THIS SAFE TO DO HERE. `ownsTheTurn` is the same answer the agent handler reads before
  // standing down, so exactly one side acts, and at every size, 1:1 included, that side is this
  // dispatch. A `#<n>` reference (`referenceTarget`) is resolved only when the flow does not own the
  // turn; in a 1:1 the chosen item rides the token-free dispatch below as `answersTaskId` instead.
  // ═══════════════════════════════════════════════════════════════
  if (referenceTarget) {
    // BROADCAST, like an `@<assistant>`: the message is readable by the room, so its answer is too. A
    // private item is not answered here; the router tells the sender to reply privately instead.
    await handOffTurnToRouter({
      channelArn,
      classification: await resolveClassification(),
      content: decodedContent,
      senderArn,
      senderName: ChannelMessage.Sender?.Name || '',
      botArn: referenceTarget.botArn,
      attachment: extractAttachment(Metadata),
      messageId: MessageId,
      // ONLY WHEN THE METADATA NAMED IT. A typed `#<n>` is still in the text the router re-parses, so
      // declaring the id as well would record the turn as client-named and suppress the line that
      // tells a text-only correspondent which reference to type - for the one person who needs it.
      ...(referenceTarget.namedBy === 'metadata' && { answersTaskId: referenceTarget.taskId }),
    });
    return;
  }

  if (ownsTheTurn && mentioned) {
    // A PERSON. Addressing a colleague starts no assistant turn - that is the entire point of being
    // able to address somebody without summoning the assistant, and it is why an assistant must not
    // treat every message in a busy room as its own.
    //
    // NOTHING IS ENQUEUED AND NO CLAIM WAS SPENT (see `dispatchesATurn`). The message was already
    // allowed through above, so it is persisted and delivered to the room exactly as sent, with the
    // `@` token intact - the token is how the addressed person sees that it was meant for them.
    //
    // THE NOTIFICATION IS NOT SENT FROM HERE, and that is the design rather than a gap. Notifying is
    // the COMPOSER's half: `chimeService.sendMessage` carries every ARN the parser resolved in
    // `CHIME.mentions` (`mentionArns`), humans included, so a person named with `@` is mentioned to
    // the platform and not only in the text. A second notification invented on this side would email
    // people for something the platform already surfaces in the room.
    //
    // This comment previously said the composer named assistants only and that a human mention
    // therefore reached nobody. That was true of an earlier composer and is not true of this one; it
    // outlived the code it described and sent a reader looking for a gap that had been closed.
    if (!mentioned.isBot) {
      console.log('[ChannelFlow] a person was addressed; no assistant turn starts', {
        messageId: MessageId,
        rosterSize: roster.length,
      });
      return;
    }

    // AN ASSISTANT. The named ARN is what this flow posts AS - the handed-back placeholder, and the
    // "I couldn't start on that" if the invoke fails - so an addressed assistant's own name is on
    // what appears in the room.
    //
    // IT DOES NOT YET CHOOSE WHICH ASSISTANT RUNS THE TURN, and that limit is worth stating rather
    // than implying. `handOffTurnToRouter` invokes the router for the CHANNEL'S classification, and that
    // router answers an unaddressed turn as the room's primary (`primaryAssistantOf`, §3.8).
    //
    // BROADCAST, which is the change. The reply is visible to the whole room because the request was.
    const mentionMessage = stripMentionOf(decodedContent, mentioned);
    const mentionAttachment = extractAttachment(Metadata);
    if (mentionMessage || mentionAttachment) {
      await handOffTurnToRouter({
        channelArn,
        classification: await resolveClassification(),
        content: mentionMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        botArn: mentioned.arn,
        attachment: mentionAttachment,
        messageId: MessageId,
      });
    } else {
      // A bare `@Atlas` with nothing else in it. Addressed, but there is no request to answer, and
      // dispatching an empty turn would put a placeholder in the room that never resolves.
      console.log('[ChannelFlow] an assistant was addressed with no message; nothing to answer', {
        messageId: MessageId,
      });
    }
    return;
  }

  // AN `@` THAT NAMED NOBODY, SAID OUT LOUD. This is the one outcome with no visible trace at all:
  // the message appears in the room, no assistant answers, and nothing distinguishes it from a
  // message nobody addressed. A typo'd assistant name, a member who has left, and a roster truncated
  // by the page bound all land here, and in a group channel nothing else recovers it -
  // `StandardMessages: NONE` invokes Lex for no untargeted message, so the person is ignored in front
  // of everybody.
  //
  // A WARNING, NOT A REFUSAL. Replying "I don't know who that is" would answer messages between two
  // people who simply typed an `@` at each other, which is worse than silence. The record is what
  // makes the silence diagnosable.
  //
  // NOT IN A 1:1, where it would be false. The flow owns every 1:1 turn, so an unresolvable `@` there
  // is dispatched to the primary by the token-free branch below and nothing is dropped - warning there
  // would put "no turn starts" in the log for turns that ran.
  // ═══════════════════════════════════════════════════════════════
  // A TURN THIS FLOW CLAIMED THAT CARRIES NO TOKEN AT ALL.
  //
  // Every branch above dispatches from something IN the message: `@all`, an `@` that resolved to an
  // assistant, a command, a leading `#<n>`. The flow claims the ordinary 1:1 turn as well, and that
  // message carries none of those - so without this branch `ownsTheTurn` is true, nothing dispatches,
  // the message is released and NOBODY ANSWERS.
  //
  // THE GUARD IS "NO TOKEN". Above a 1:1 every path through `flowOwnsTheTurn` that returns true needs
  // `@all`, a command, or an `@` that resolves, so a claim with no token is the 1:1 case, stated as
  // the property rather than as a size test.
  //
  // AND IT MUST NOT CATCH THE `@<person>` CASE. `@Sam` claims the turn (it resolves against the
  // roster) and deliberately dispatches nothing, which is the "named nobody" outcome warned about
  // just below. That message carries a token, so it is excluded here rather than by a second rule.
  if (claimedWithoutAToken || rosterUnreadableAndAddressed) {
    const attachment = extractAttachment(Metadata);
    if (decodedContent || attachment) {
      console.log('[ChannelFlow] the flow owns this untargeted turn; dispatching to the primary assistant', {
        messageId: MessageId,
        memberCount: size?.memberCount ?? null,
        isOneToOne: size?.isOneToOne ?? null,
      });
      await handOffTurnToRouter({
        channelArn,
        classification: await resolveClassification(),
        content: decodedContent,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        botArn,
        // NOT A PRIVATE REQUEST, so `requestWasPrivate` is left unset. This is an ordinary turn in a
        // conversation that happens to enter through the flow, and it answers exactly as the assistant
        // would have answered had Amazon Lex carried it - which is untargeted. It used to pass
        // `broadcast: false`, meaning only "the answer is for the asker, not the room", and every
        // consumer of that flag read it as "this exchange is private": the task was opened private and
        // the person was told the assistant had replied privately, in a conversation of two.
        attachment,
        messageId: MessageId,
        // ── THE ITEM THE PERSON CHOSE, ON THE PATH A 1:1 ACTUALLY TAKES ──────────────────────────
        //
        // The composer stopped typing `#<n>` into the text and now names the item in `Metadata`
        // (ADR-035, `MessageInput.tsx`). `resolveReferenceTarget` carries that through - but it is
        // computed only when `!ownsTheTurn`, and the flow OWNS an untargeted 1:1 turn, so in a 1:1
        // the choice reached nothing and the turn fell back to ranking what was open and letting the
        // model pick. Click Answer on the second of two open items in a 1:1, type "EMEA only", and it
        // was a guess where it used to be fixed (code review, 2026-09-22).
        //
        // PASSED AS A HINT, NOT AS AN AUTHORIZATION. Unlike the reference path there is no task-service
        // round trip here, because there is no assistant to choose in a 1:1; the processor resolves the
        // id against what this sender may answer (`findAnswerableTaskById`) and ignores it otherwise.
        ...(extractTaskAnswerHint(Metadata)?.taskId
          && { answersTaskId: extractTaskAnswerHint(Metadata)?.taskId }),
      });
    }
    return;
  }

  if (mightMention && !mentioned && !mentionsAll && !invokesBattle && size && !size.isOneToOne) {
    console.warn('[ChannelFlow] an @ token named nobody in this conversation; no turn starts', {
      messageId: MessageId,
      rosterSize: roster.length,
      rosterUnknown: size?.unknown ?? null,
    });
  }

  // All other messages start no turn here. `StandardMessages: NONE` invokes Lex for no untargeted
  // message, so a 1:1 turn and every addressed group turn are dispatched above.
  // - Messages addressed via Target reach the assistant via TargetedMessages: ALL.
  // - No address in a multi-member channel: no assistant answers. Humans chat freely.
}

/**
 * Allow the message through the channel flow
 */
/**
 * A channel-flow callback is ONE-SHOT, and a redelivery is normal.
 *
 * Amazon Chime SDK Messaging delivers at least once, so the same message can reach this flow twice.
 * The second callback finds the first already resolved and is refused:
 *
 *   BadRequestException: Unable to complete processing of non-pending message for callback id …
 *
 * That is the EXPECTED outcome of a duplicate, not a fault — the message was already allowed, which is
 * the state the caller wanted. Letting it propagate inverted the consequence: the invocation failed,
 * Lambda retried, and the retry produced another duplicate callback. Observed live 9 times in 24
 * hours across five conversations (plus `ConflictException`, the service's own "try again" for two
 * callbacks racing), every one of them invisible to the e2e suite because the backend-error guard did
 * not watch this function's log group.
 *
 * Both are therefore treated as idempotent success and logged at info. Every other error still
 * throws: a callback that fails for any other reason means the message did NOT get through, and that
 * has to stay loud.
 */
function isAlreadyResolvedCallback(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  if (name === 'ConflictException') return true;
  // THE THIRD SHAPE, and it is what a resolved callback usually looks like. Amazon Chime SDK answers a
  // second callback on a consumed `CallbackId` with a 403 `ForbiddenException` carrying the generic
  // "you do not have sufficient access" text - not a conflict, and not a bad request. Measured: two
  // invocations 139ms apart on one `CallbackId`, the first denial succeeding and the second 403ing,
  // then retried twice by Lambda because it was rethrown. That trio is the whole of the unexplained
  // `ForbiddenException` noise on this path.
  //
  // WHAT THIS COULD MASK, stated because it is a real trade. A genuine missing `chime:ChannelFlowCallback`
  // grant raises the same error name. It could not hide here: this is the ALREADY-RESOLVED test, and a
  // role that cannot call back at all fails its FIRST callback on every message, so an allow throws,
  // no message is ever released, and the channel is visibly dead rather than quietly degraded. What is
  // being swallowed is strictly the second callback for a message the flow has already decided.
  if (name === 'ForbiddenException') return true;
  return name === 'BadRequestException'
    && /non-pending message/i.test(String((err as { message?: string })?.message || ''));
}

/** Which benign case fired, as a word that carries no "Exception" substring — see the call sites. */
function reasonWord(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'ConflictException') return 'callback-race';
  if (name === 'ForbiddenException') return 'already-consumed';
  return 'non-pending';
}

async function callbackAllow(
  callbackId: string,
  channelArn: string,
  messageId: string,
  content: string,
  metadata?: string
): Promise<void> {
  try {
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
  } catch (err) {
    if (!isAlreadyResolvedCallback(err)) throw err;
    // The reason is a PLAIN WORD, not the SDK's error name. Logging `BadRequestException` here put the
    // substring "Exception" in a success line, and the e2e backend-error guard greps
    // `?ERROR ?Exception ?AccessDenied ?Denied` — so this very message failed a battle turn the first
    // time it fired. The guard's pattern is deliberately broad and should stay that way; a benign line
    // must not look like an error.
    console.log('[ChannelFlow] callback already resolved (duplicate delivery); treating as allowed', {
      callbackId, messageId, reason: reasonWord(err),
    });
  }
}

/**
 * Deny a message in the channel flow (`DeleteResource: true`). The
 * message is not persisted, not delivered, and - critically - not
 * routed to Lex by `TargetedMessages: ALL`
 * (channel-flow gating happens before assistant invocation).
 *
 * WHAT ACTUALLY CALLS IT: the bot-to-bot loop guard, the empty-Lex-envelope guard, the Amazon Chime
 * SDK status-artifact guard and the duplicate-placeholder guard, all inside the `isBotMessage` branch,
 * so every denial drops a message an assistant sent. A reply to a waiting duel side is released like
 * any other message, and the handler resumes the side on the ordinary turn path (ADR-029).
 *
 * A PERSON'S MESSAGE IS NEVER DENIED, and that is the property to preserve if a caller is ever added.
 * The private-address check keeps a person's message whose stored `Target` disagrees with its text and
 * tells the sender instead (`lib/private-command.ts`).
 */
async function callbackDeny(
  callbackId: string,
  channelArn: string,
  messageId: string,
): Promise<void> {
  try {
    await messagingClient.send(
      new ChannelFlowCallbackCommand({
        CallbackId: callbackId,
        ChannelArn: channelArn,
        DeleteResource: true,
        ChannelMessage: { MessageId: messageId },
      })
    );
  } catch (err) {
    // Same one-shot rule as the allow path. A denial whose callback is already resolved means the
    // duplicate-placeholder guard fired twice on the same message; the first denial stands.
    if (!isAlreadyResolvedCallback(err)) throw err;
    console.log('[ChannelFlow] callback already resolved (duplicate delivery); denial already applied', {
      callbackId, messageId, reason: reasonWord(err),
    });
  }
}

/**
 * Invoke a classification router with one turn and return its parsed Lex response.
 *
 * The ONE definition of the router-invoke boilerplate for the bypass paths (@all and the round-1
 * fan-out), so the FunctionError re-throw and the payload parse cannot drift apart per path. A handler that THREW still returns HTTP 200 with an error payload;
 * posting that unchecked would put a stack trace in the channel as the user's answer, which is
 * why the re-throw is part of this contract rather than per-caller etiquette. What legitimately
 * DIFFERS per path - what to tell the user when the invoke fails - stays with each caller.
 */

/**
 * The assistant a message answering an open item should reach, or null to leave the message alone.
 *
 * TWO WAYS TO NAME THE ITEM, ONE PERMISSION. A client that is showing the item names it by id in
 * `Metadata`; a person on any other channel types `#<n>` (ADR-035). Both ask the task service, which
 * applies the same check to either selector, so the metadata path can reach nothing the typed path
 * could not - a forged id belonging to another conversation misses on the table key, and one the
 * sender may not answer is refused exactly as a reference is.
 *
 * Null unless every one of these holds: the message names an item, the conversation is a
 * group (a 1:1 already reaches its assistant, and an unreadable roster is not assumed to be a group),
 * and the task service says the sender may answer that open item. A lookup that fails is null too, so
 * the worst case is today's behavior: the message is delivered and nobody is summoned.
 *
 * THE CHANNEL FACTS ARRIVE AS ACCESSORS, IN COST ORDER. This is the only turn-starting check reachable
 * by a message carrying no `@`, no `.` and no command, so it is the only one whose caller has not
 * already resolved the classification and the bearer - and it runs on EVERY ordinary message. Taking
 * them as values would therefore put both reads back on the path this check exists at the end of.
 * Everything free is tested first (the leading reference, then the sender being a person), and the tag
 * read, the SSM read and the roster read happen only for a message that survives all of it.
 */
async function resolveReferenceTarget(args: {
  text: string;
  /** The message's `Metadata`, where a client names the item by id. */
  metadata?: string;
  channelArn: string;
  classification: () => Promise<string>;
  senderArn: string;
  /** Null when the conversation has no resolvable primary assistant; the reference then starts no turn. */
  botArn: () => Promise<string | null>;
  size: ChannelSize | null;
}): Promise<{ botArn: string; taskId: string; namedBy: 'metadata' | 'reference' } | null> {
  // THE ID FIRST, because a client that has one is not guessing. Both selectors are free to test -
  // one `JSON.parse` of a field already in memory, one regex over text already in memory - so the
  // accessors below are still paid only by a message that really does name an item.
  //
  // THE SAME READER POST-PROCESSING USES (`task-answer-metadata.ts`), deliberately. That module was
  // written for the late repair of an answer that reached nobody, off the message stream, and it reads
  // this exact field. Two readers of one field are free to disagree about what counts as named - and
  // these two decide whether a turn runs, so a disagreement is a message answered twice or not at all.
  const metadataTaskId = extractTaskAnswerHint(args.metadata)?.taskId;
  const reference = metadataTaskId ? null : parseTaskReference(args.text);
  if (!metadataTaskId && !reference) return null;
  // A person's reply only: an assistant's own message naming an item is not an answer.
  const senderSub = personIdFromArn(args.senderArn) || '';
  if (!senderSub) return null;
  const serviceArn = await resolveTaskServiceArn(await args.classification());
  if (!serviceArn) return null;
  const botArn = await args.botArn();
  if (!botArn) return null;
  const size = args.size ?? await resolveChannelSize(messagingClient, args.channelArn, botArn);
  if (size.unknown || size.isOneToOne) return null;
  try {
    const result = await lambdaClient.send(new InvokeCommand({
      FunctionName: serviceArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify(metadataTaskId
        ? {
          op: 'answerableTaskById',
          input: { channelArn: args.channelArn, taskId: metadataTaskId, senderSub },
        }
        : {
          op: 'answerableTaskByRef',
          input: { channelArn: args.channelArn, taskRef: reference!.taskRef, senderSub },
        })),
    }));
    if (result.FunctionError) throw new Error(`task service returned ${result.FunctionError}`);
    const raw = result.Payload ? Buffer.from(result.Payload).toString() : '';
    const found = (raw ? JSON.parse(raw) : null) as { taskId?: string; assistantId?: string } | null;
    console.log('[ChannelFlow] a message named an open item', {
      namedBy: metadataTaskId ? 'metadata' : 'reference',
      ...(reference ? { taskRef: reference.taskRef } : {}),
      answerable: Boolean(found?.taskId),
    });
    if (!found?.taskId) return null;
    // THE ASSISTANT THAT OWNS THE ITEM posts anything the flow must say on this turn's behalf. Which
    // router runs the turn is the classification's, as for an `@<assistant>`, and that router hands a
    // foreign item to its owner.
    //
    // ── AND ONLY IF IT IS STILL IN THE ROOM ────────────────────────────────────────────────────────
    //
    // This identity is SPLICED from a task record rather than resolved from the roster, so unlike an
    // `@<assistant>` it is bounded by task answerability and not by membership. The identity gate
    // admits the live assistant of any role in this classification, so without this check a task owned
    // by an assistant since REMOVED from the conversation would still make the turn adopt that assistant -
    // and an assistant carries its own reach (`ops` reads CloudWatch). The posting leg fails closed on
    // membership anyway, so what this prevents is a tool read under an identity that is no longer here,
    // which is reach without the boundary that justified it (tenet D3: two layers, and membership is the
    // second one).
    //
    // A LOOKUP RATHER THAN A READ. `size.members` is the roster this turn already fetched to count the
    // room, so the check costs nothing and - more importantly - it is the SAME roster the mention path
    // resolves against, so the two producers cannot disagree about who is present.
    const splicedBotArn = found.assistantId
      ? `${botArn.slice(0, botArn.lastIndexOf('/') + 1)}${found.assistantId}`
      : botArn;
    const ownerIsPresent = splicedBotArn === botArn
      || size.members.some((m) => m.arn === splicedBotArn);
    if (!ownerIsPresent) {
      console.warn('[ChannelFlow] the assistant that owns this item is no longer in the conversation; '
        + 'answering as the classification\'s own assistant rather than adopting an absent assistant', {
        taskId: found.taskId, owner: found.assistantId,
      });
    }
    const owningBotArn = ownerIsPresent ? splicedBotArn : botArn;
    return {
      botArn: owningBotArn,
      taskId: found.taskId,
      namedBy: metadataTaskId ? 'metadata' : 'reference',
    };
  } catch (err) {
    console.warn('[ChannelFlow] item lookup failed; the message is delivered without a turn', {
      err: (err as Error)?.message,
    });
    return null;
  }
}

async function invokeRouterTurn(routerArn: string, aeTurn: TurnRequest): Promise<LexResponse> {
  const result = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }),
  );
  if (result.FunctionError) {
    throw new Error(`router returned ${result.FunctionError}: ${Buffer.from(result.Payload || []).toString().slice(0, 300)}`);
  }
  return JSON.parse(Buffer.from(result.Payload || []).toString()) as LexResponse;
}

interface RouterTurnParams {
  channelArn: string;
  /** The channel's classification, resolved ONCE by the main handler from the immutable tag. The
   *  tag cannot change (that is its point), so re-reading it per helper was a second Chime call per
   *  turn for the same answer. */
  classification: string;
  content: string;
  senderArn: string;
  senderName: string;
  botArn: string;
  /**
   * THE PERSON ADDRESSED THIS PRIVATELY (`.assistant ...`).
   *
   * It decides BOTH halves of what private means here: the task this turn opens is private
   * (`TurnRequest.targeted`), and anything this function posts is addressed to the sender alone.
   * Absent on every other path, including an ordinary 1:1 turn - a 1:1 has no third party to
   * withhold from, so targeting there conceals nothing and only records the exchange as private.
   */
  requestWasPrivate?: boolean;
  /** Attachment-in (image/PDF/doc) from the triggering message Metadata; forwarded to the processor. */
  attachment?: MessageAttachment;
  /** The open item this turn answers, when the message named one. See `TurnRequest.answersTaskId`. */
  answersTaskId?: string;
  /** The STABLE inbound Chime message id (F2). Keys the processor's dedup claim so a cross-container
   *  at-least-once redelivery of the same @all collapses to one Bedrock call - matching the router
   *  (CHIME.message.id) and /battle (deriveBattleId).
   *
   *  REQUIRED, because it is what a dispatched turn CARRIES (ADR-043): the router declares it as
   *  `AE.message.id`, the processor stamps it as `answersMessageId`, and no part of the turn has to
   *  reconstruct which message it answers. A dispatch site that omitted it would quietly move its turns
   *  onto the reconstruction path, so the type refuses one. */
  messageId: string;
  /** Set when this turn is a HANDOVER: the handover message the receiving router verifies before acting. */
  handoverMessageId?: string;
}

/**
 * HAND A TURN THE FLOW CLAIMED TO THE CLASSIFICATION'S ROUTER, and post anything handed back.
 *
 * NAMED FOR WHAT IT DOES RATHER THAN FOR ITS FIRST CALLER. It was `handleMentionedMessage`, and that
 * name outlived its accuracy: the callers are now `@all`, an `@<assistant>` in a group (ADR-034), a
 * leading `#<n>` task reference (ADR-035), the `/battle` fallback below two assistants, and a private
 * `.<assistant>` address whose `Target` never arrived. Only two of those are
 * mentions. A reader chasing "why is a mention handler answering a private message" was chasing a
 * stale name, not a defect.
 *
 * NOR DOES EVERY CALLER BROADCAST ANY MORE, which the previous comment asserted. The private-address
 * caller asks for a targeted answer: its question is already public and cannot be unsaid, but the
 * ANSWER is the longer and more revealing half, so it goes to the sender alone.
 *
 * ── THERE IS ONE FLAG NOW, AND IT IS ABOUT THE REQUEST ──────────────────────
 *
 * This took a `broadcast` boolean as well, and the two said the same thing from opposite ends until
 * the flow began owning ordinary 1:1 turns. Those passed `broadcast: false` - the answer is for the
 * person, not the room - and every consumer of that flag then treated the exchange as private: the
 * task was opened private, and the notices and the hand-back fallback were addressed to the sender.
 *
 * **Even in a 1:1, the message and the answer are not private unless the person addressed them that
 * way**. A 1:1 has no third party to withhold from, so targeting there conceals nothing and
 * only marks the exchange as private in the record - and then the platform tells the person it
 * replied privately, in a conversation where there is nobody else.
 *
 * So `broadcast` is gone and `requestWasPrivate` is the whole of the difference. It is set at exactly
 * one dispatch, the `.<assistant>` address, and it decides both halves: whether the task is private
 * (`TurnRequest.targeted`) and whether anything this function posts carries a `Target`.
 */
async function handOffTurnToRouter(params: RouterTurnParams): Promise<void> {
  const { channelArn, classification: turnClassification, content, senderArn, senderName, botArn, attachment, messageId, answersTaskId, requestWasPrivate, handoverMessageId } = params;
  console.log('[ChannelFlow] handing a claimed turn to the router', {
    requestWasPrivate: requestWasPrivate === true, senderName, hasAttachment: !!attachment,
  });

  // ADDRESSED ONLY WHEN THE PERSON ADDRESSED IT. Anything else is visible to the conversation, which
  // in a 1:1 is the same two participants either way - the difference is that it is not RECORDED as
  // private, and the person is not told the assistant replied privately to a room of one.
  const targetArns = requestWasPrivate === true ? [senderArn] : undefined;

  // THE FLOW DECIDES WHO RESPONDS; THE ROUTER RUNS THE TURN (MESSAGE-FLOW §6.1). Everything this
  // function used to do itself - the greeting/acknowledgment fast path, the abuse gate, the
  // correlation id, `intent: 'general'`, `deliveryOption` and the processor dispatch - was a second
  // implementation of decisions the router already makes for every Lex turn, and a second
  // implementation diverges SILENTLY: the turn still answers, so nothing errors.
  //
  // @all is answered at the channel's own classification (matching the per-classification bot it is
  // sent as), never hardwired to standard, and on that classification's own router or not at all: no
  // classification falls back to another's router (ADR-046), because that would answer the turn with
  // another classification's assistant, model and context.
  const routerArn = await resolveRouterArn(turnClassification);
  if (!routerArn) {
    console.error('[ChannelFlow] No router wired for classification; cannot start this turn', { turnClassification });
    // Never a silent no-op: an unwired router is a DEPLOYMENT fault, so say so rather than letting the
    // mention vanish. Nothing has been charged at this point - the router owns the abuse gate now, and
    // it has not run.
    //
    // RECORDED AS STATE, NOT POSTED AS THE ASSISTANT. The assistant did not say this and
    // did not fail; the deployment did. Posting it here put an infrastructure fault in the transcript
    // under the assistant's name, showed it to the whole room rather than to the person it happened
    // to, and was one of the last reasons this function needs to bear a bot identity at all.
    await recordDispatchFailure({
      channelArn,
      senderSub: personIdFromArn(senderArn) || '',
      responderId: botIdFromArn(botArn) || '',
      reason: 'assistant_unreachable',
    });
    return;
  }

  // SYNCHRONOUS, unlike the processor dispatch it replaces, because the placeholder comes BACK from
  // the turn: the router mints the correlation id and returns the text carrying its `<!--corr:-->`
  // marker, exactly as it returns it to Lex. This runs AFTER `callbackAllow`, so the user's own
  // message is already released and this latency sits in front of the placeholder only.
  //
  // The inbound `messageId` is handed over rather than a correlation id derived here: the router
  // declares the id from it, so a cross-container redelivery still collapses (the id is stable), and
  // there is one minting site instead of two that must agree.
  const flowReceivedAt = flowReceipt.getStore();
  const aeTurn: TurnRequest = {
    channelArn,
    senderArn,
    userMessage: content,
    userMessageId: messageId,
    ...(flowReceivedAt !== undefined && { flowReceivedAt }),
    // ── WAS THE REQUEST SENT PRIVATELY? DECLARED, AND NOT THE SAME QUESTION AS `broadcast` ───────
    //
    // The router reads this for ONE thing: whether the task this turn opens is private
    // (`inboundTaskFields`). It cannot work it out for itself on this path, because it matches the
    // turn's text against the stored message and the text handed over here has had its address token
    // stripped.
    //
    // IT USED TO BE `!broadcast`, AND THAT CONFLATED TWO QUESTIONS. `broadcast` answers "where does
    // the ANSWER go" - to the room, or to the person who asked. This answers "was the REQUEST
    // private", which is what decides the task's visibility. They coincide for `@all` (public
    // question, public answer) and for `.assistant` (private both ways), and they come APART for an
    // ordinary message in a 1:1: the flow owns that turn and passes `broadcast: false` because it is
    // not addressed to the room, and that made every 1:1 task private.
    //
    // MEASURED, in `conv-1790010890868-807ae3b58087`: a plainly public "List all the tasks in this
    // conversation and their status" opened a `private` task, and every answer to it was targeted -
    // so the room got four "I have replied to you privately." receipts in a two-person conversation
    // and the person asked why. The rule is that only a message SENT as targeted
    // makes a private task: not a mention, and not an auto-routed one.
    //
    // DECLARED FALSE RATHER THAN LEFT ABSENT on every other path, deliberately. Absent visibility
    // reads as private (`task-visibility.ts`), so staying quiet here is not neutral - it is the same
    // outcome by omission.
    targeted: requestWasPrivate === true,
    ...(handoverMessageId ? { trigger: 'handover' as const, handoverMessageId } : {}),
    // ── WHICH ASSISTANT WAS ADDRESSED, CARRIED TO THE TURN THAT ANSWERS ────────────────────────
    //
    // The mention resolver already decided this, and it used to stop here: the ARN was used for the
    // placeholder and the failure notice, and the ROUTER then resolved its own identity - the
    // classification's primary. So `@Alt-premium-primary answer here` was answered by Advisor, in a
    // room holding both. The comment at the mention branch called that limit out
    // and it is now closed rather than only described.
    //
    // THE SEAM ALREADY EXISTED AND WAS UNUSED FROM HERE. `TurnRequest.botArn` is forwarded as the
    // bypass bot attribute and VALIDATED by the router against its assignment records plus its
    // own bot (`isSanctionedBattleBot`), which is how a duel side posts as itself. The mention path
    // needed to declare the same fact, not a new mechanism.
    //
    // An ARN the router does not sanction falls back to the classification's own bot there rather
    // than failing the turn, so a roster mid-redeploy answers as the primary instead of going silent.
    ...(botArn && { botArn }),
    // Attachment-in: the file reference from message Metadata, which Lex never sees, so the flow is
    // the only component that can carry it to the turn.
    ...(attachment && { attachment }),
    // WHICH OPEN ITEM THIS ANSWERS, for the same reason: the id was named in the message Metadata, so
    // the flow is the only component that ever saw it. Without this the router re-derives the item
    // from the TEXT - which no longer carries a `#<n>` - and falls to ranking work the person already
    // named.
    ...(answersTaskId && { answersTaskId }),
  };

  let response: LexResponse;
  try {
    response = await invokeRouterTurn(routerArn, aeTurn);
  } catch (error) {
    console.error('[ChannelFlow] Router invoke failed for mention:', error);
    // The old shape posted the placeholder FIRST, so a failed dispatch stranded a "One moment..." that
    // never resolved. Nothing has been posted here yet, so say what happened instead of going silent -
    // as STATE the person's own client renders, not as a message from an assistant that never ran.
    // The person's message is untouched: only the answer is missing.
    await recordDispatchFailure({
      channelArn,
      senderSub: personIdFromArn(senderArn) || '',
      responderId: botIdFromArn(botArn) || '',
      reason: 'handoff_failed',
    });
    return;
  }

  // Honor the hand-back half of the contract through the ONE helper every bypass path uses: an empty
  // array posts nothing (the normal ADR-025 outcome, or a silent turn), and a handed-back message is
  // noted rather than posted: the processor posts the answer itself. See `noteHandedBackMessage`.
  noteHandedBackMessage({
    response,
    logPrefix: '[ChannelFlow]',
    logContext: { requestWasPrivate: requestWasPrivate === true },
  });
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
/**
 * A NOTICE IS SAID BY THE ASSISTANT IT CONCERNS, IN ITS OWN WORDS; THE FLOW ONLY NAMES IT.
 *
 * A notice is the flow reporting that the ordinary path is unavailable - a spend was refused, a duel
 * cannot start - or a duel announcing itself. The flow composes no words for one. It names the notice's
 * kind and hands it to the conversation's router (`aeNotice`), which resolves the assistant behind
 * `botArn` from its assignment record and posts the line from that assistant's active copy, under its name and with
 * its attribution (`sayNotice` in `router-agent-handler.ts`, `lib/assistant-notice.ts`).
 *
 * RequestResponse, so a notice the router refused or could not post is logged here with its reason.
 * A failure never throws out of the flow: a notice that is not said leaves the person's message as it
 * was, and the log is the record.
 */
async function sayNotice(params: {
  /** The conversation's classification: its router says the notice. */
  classification: string;
  channelArn: string;
  /** The assistant that says it. */
  botArn: string;
  kind: NoticeCopyKey;
  /** Who sees it; empty for the whole conversation. */
  to: string[];
  vars?: Record<string, string | number>;
}): Promise<void> {
  const { classification, channelArn, botArn, kind, to, vars } = params;
  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) {
    console.error('[ChannelFlow][notice] the classification has no router, so the notice is not said', { kind, classification, channelArn });
    return;
  }
  try {
    const res = await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.RequestResponse,
      Payload: Buffer.from(JSON.stringify({ aeNotice: { kind, channelArn, botArn, to, ...(vars ? { vars } : {}) } })),
    }));
    const outcome = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString() || '{}') as { posted?: boolean; reason?: string } : {};
    if (res.FunctionError || !outcome.posted) {
      console.warn('[ChannelFlow][notice] the assistant did not say the notice', {
        kind, classification, channelArn, functionError: res.FunctionError, reason: outcome.reason,
      });
    }
  } catch (err) {
    console.warn('[ChannelFlow][notice] handing the notice to the router failed', { kind, classification, channelArn, err });
  }
}

/**
 * A reply the router HANDED BACK is noted, never posted (the flow never speaks).
 *
 * An empty `messages` array is the normal outcome (ADR-025): the router posted its own acknowledgment. A
 * non-empty one means the router's send could not run. The processor that answers the turn then finds no
 * placeholder and posts the answer as a new message itself, recording `reply_undeliverable` for the sender
 * only if that also fails, so nothing here posts in the assistant's name or records a failure that may not
 * have happened (a send that timed out client-side can still have landed).
 */
function noteHandedBackMessage(params: {
  response: LexResponse;
  /** Log prefix of the calling path, e.g. `[ChannelFlow][battle]`. */
  logPrefix: string;
  logContext?: Record<string, unknown>;
}): void {
  const { response, logPrefix, logContext = {} } = params;
  if (!response.messages?.[0]?.content) return;
  console.warn(`${logPrefix} the router handed its reply back; the processor posts the answer itself`, logContext);
}

/**
 * Cost/abuse gate for the channel-flow dispatch paths (SPEC-ABUSE-CONTROLS).
 *
 * The Lex router-agent-handler gates the 1:1 tier turn, but @all/@assistant mentions and /battle
 * fan-outs are dispatched HERE (channel-flow forwards or invokes the async/premium processor
 * directly), BEFORE Lex - so without this gate a group channel is a budget-bypass path that reaches
 * the model without ever crossing the router's limits. Enforce the SAME per-user hourly rate limit
 * and per-user+global spend budget the router does, keyed on the sender's sub, right before the
 * expensive dispatch. Over-limit/over-budget replies to the SENDER only (targeted) and returns false
 * so the caller skips the invoke/fan-out (no model cost).
 *
 * isAdmin is intentionally NEVER true here: the router's opt-in admin exemption is a 1:1-tier
 * affordance gated on a server-verified Cognito group; a group @all/battle never carries that
 * exemption, so an admin in a shared channel pays budget like any other member (fail-safe - the
 * global limit that protects the account is admin-inclusive regardless).
 *
 * A control whose limit is 0 is off. A control whose limit is set refuses when ABUSE_CONTROLS_TABLE is
 * unset or its store errors (`lib/abuse-controls.ts`).
 */
async function enforceAbuseGate(
  channelArn: string,
  botArn: string,
  senderArn: string,
  classification: string,
): Promise<boolean> {
  const personId = personIdFromArn(senderArn) || senderArn;
  // METERED AT THE CHANNEL'S CLASSIFICATION, which is the same rule the router now applies to this
  // person's ordinary turns (ADR-033, owner 2026-08-31: one channel, one classification, and IAM
  // decides it).
  //
  // This used to take min(channel, clearance), to stop a basic-clearance member of a premium channel
  // spending premium budget via /battle. That member cannot be here: the channel-scoped Allow is
  // applied to the Cognito USER roles as well as the assistant roles, tag-gated and fail-closed, so
  // they hold no grant on a premium channel and cannot send into one at all. The cap was guarding a
  // state IAM already refuses.
  //
  // And it cost the reachable case. `resolveUserClearance` answers `basic` for ANY failure, so a
  // Cognito throttle metered a legitimate premium duel against BASIC limits and refused it early -
  // an outage presenting as a spend decision, which is the confusion this codebase now names as
  // invariant E. The global limit that protects the account is unchanged and admin-inclusive.
  const effective = classification;
  // Shared gate (order + message selection live in lib/abuse-controls). isAdmin:false - the opt-in
  // admin exemption is a 1:1-tier router affordance; a group @all/battle never carries it.
  //
  // WHOSE LIMIT. A rate limit is per assistant (`rateLimitPerHour` on its profile), and every turn
  // addressed to ONE assistant is metered by the router at that assistant's own limit - `@all` and
  // `@<assistant>` included, because the flow hands those to the router. The only caller left here is
  // the `/battle` fan-out, which is one action spanning two assistants, metered once for the whole duel.
  // Its limit is the LIVE side's: the bot this flow acts as is the room's primary assistant
  // (`resolvePrimaryBearer`), which is not necessarily the classification's primary, so the limit is
  // read from that bot's own assignment record (`turnAssistantProfileForBot`). The alt side's assistant `alt-{role}` has no
  // profile of its own. A live side whose assistant cannot be named refuses the duel with no reply
  // rather than metering it at another assistant's limit (tenet P4, ADR-046).
  const liveAssistant = await turnAssistantProfileForBot({
    botArn, classification: effective, registry: profiles, liveAssistants: liveAssistantsByHandleOrThrow,
  });
  if (liveAssistant.decision === 'decline') {
    logAssistantDecline('[ChannelFlow][battle]', liveAssistant.reason, { channelArn, classification, asBot: botIdFromArn(botArn) });
    return false;
  }
  const gate = await evaluateAbuseGate({
    personId,
    rateLimit: liveAssistant.profile.rateLimitPerHour ?? 0,
    isAdmin: false,
  });
  if (!gate.allowed) {
    console.warn(`[ChannelFlow] ${gate.reason} gate blocked dispatch; serving notice`, { classification, personId: personId.slice(0, 8) });
    await sayNotice({ classification: effective, channelArn, botArn, kind: gate.notice.kind, to: [senderArn], vars: gate.notice.vars });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// /battle (SPEC-BATTLE.md)
// ─────────────────────────────────────────────────────────────────

interface HandleBattleParams {
  channelArn: string;
  /** See RouterTurnParams.classification - resolved once, passed down like botArn. */
  classification: string;
  userMessageId: string;
  content: string;
  senderArn: string;
  senderName: string;
  /** Default bot ARN (always the first bot member of the channel). */
  defaultBotArn: string;
  /**
   * The roster the address pass already read, which is where the duel's assistant members come from.
   *
   * ONE ROSTER PER MESSAGE, AND THIS IS THE CORRECTNESS HALF OF IT. The bot-member gate used to make a
   * SECOND `ListChannelMemberships` of its own, one page of 50 against the address pass's ten, so a
   * duel in a room past 50 members gated on a different roster from the one that resolved the message's
   * addressing - two reads, two answers, no way to tell which one a decision came from. The roster
   * carried here already marks every member `isBot` (`lib/flow-bypass.ts`), so the second read was
   * asking a question the first had answered, against the same channel, in the same invocation.
   *
   * Null is not expected: `/battle` is a registry command, so the gate that reads the roster has run
   * for every message that reaches here. It is typed nullable because the caller's type says so, and
   * it is treated exactly like an unreadable roster - the sender is told the duel could not start.
   */
  size: ChannelSize | null;
  /** Phase-3 vision-in: image attachment on the `/battle` turn, if any. */
  imageAttachment?: BattleImageAttachment;
}

/**
 * Handle a `/battle` slash command.
 *
 * Flow:
 * 1. Classification gate — premium channels only. Non-premium gets a targeted
 *    bot reply explaining the requirement.
 * 2. Battle-enabled check (ChannelBattleConfig). If Battle Mode is off for
 *    this channel, reply with a one-line "not enabled here — ask a
 *    moderator" hint and stop. A no-op command explains itself.
 * 3. Single-active-battle guard via ChannelBattleConfig (battle-state).
 *    A second `/battle` while one is in flight gets a targeted "already in
 *    progress" reply (best-effort; the gate is a soft lock).
 * 4. List channel memberships, filter to bot ARNs. The <2-bot-members case
 *    is a degenerate internal state (battle was enabled but the alt
 *    isn't a member) — fall back to a single broadcast reply.
 * 5. For each bot member: send a per-bot placeholder, write the initial
 *    INVOKED state row, invoke the premium async processor with a
 *    battleContext payload.
 */
/**
 * `/battle end` - end the duel running in this channel, and the task inside it.
 *
 * WHO MAY. The person who started it, or a channel moderator. Ending a duel destroys work in flight for
 * everyone in it, so this is moderation authority (channel-scoped `ChannelModerator`) and not membership;
 * it is read live from Amazon Chime SDK and fails closed. The initiator comes from the channel pointer,
 * which has a single writer at fan-out - the per-bot rows are rewritten by the duel's own progress and so
 * cannot be trusted to still carry it.
 *
 * An initiator we never recorded (`activeBattleInitiator` absent - a duel from before the field, or a
 * non-fatal write that lost it) leaves the moderator check as the only gate. That is the safe direction:
 * it withholds authority rather than granting it to whoever asks.
 *
 * Every reply is TARGETED at the sender. A refusal is between the asker and the assistant, and it does
 * not name the initiator - who started a duel is not something a refusal should disclose.
 */
async function handleBattleEnd(params: {
  channelArn: string;
  /** The room's classification, for attributing the notices below to its primary assistant. */
  classification: string;
  senderArn: string;
  defaultBotArn: string;
}): Promise<void> {
  const { channelArn, classification: channelClassification, senderArn, defaultBotArn } = params;

  const active = await resolveActiveBattle(channelArn);
  if (!active) {
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleNoneRunning',
      to: [senderArn],
    });
    return;
  }

  // AUTHORIZE FIRST, BEFORE READING THE DUEL AND BEFORE ANY BRANCH THAT WRITES.
  //
  // This gate used to sit AFTER an "already finished" branch that called `endBattle` - and that branch
  // is not the rare case it reads like. `duelInFlight` is false for the whole of ROUND 2: round 1 ends
  // by moving both sides to `COMPLETED`, and nothing moves them back while the rebuttal generates. So
  // for the tens of seconds a duel spends being rebutted, any member of the channel could send
  // `/battle end`, reach the ungated branch, and have it release the pointer and claim the
  // orchestrator's exactly-once sentinel on somebody else's duel. Either they then start their own
  // battle on top of the one still streaming, or their claim beats the orchestrator's and round 2
  // never fires at all - the duel silently truncated with no rebuttal.
  //
  // The lesson generalizes past this function: "already finished" was treated as a read-only pleasantry
  // when it performs two writes and stamps an audit field. A branch that mutates belongs behind the
  // gate no matter how harmless its message sounds.
  const senderSub = personIdFromArn(senderArn) || '';
  const isInitiator = Boolean(active.initiatorUserSub) && active.initiatorUserSub === senderSub;
  // A moderator may also end it, and that grants nothing new: they can already end any duel by turning
  // Battle Mode off, which now ends the running one. Accepting the command from them simply saves the
  // detour. Everyone else is refused - see below.
  const authorised = isInitiator || await callerIsChannelModerator(channelArn, senderArn);
  if (!authorised) {
    // THE REFUSAL IS THE POINT, not a gap to be widened later.
    //
    // A duel belongs to the person who started it. If any member could end it, the assistants would be
    // taking competing instructions from several people mid-comparison, and a duel is only worth
    // anything while both sides are answering the same person's question. So this names the two routes
    // that exist - its initiator ends it, or a moderator turns Battle Mode off - without naming who the
    // initiator is, which is not a refusal's business to disclose.
    console.log('[ChannelFlow][battle] /battle end refused: not the initiator and not a moderator', {
      channelArn,
      battleId: active.battleId,
    });
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleNotYours',
      to: [senderArn],
    });
    return;
  }

  // Past the gate, so both remaining exits are the owner's (or a moderator's) to take.
  //
  // `duelIsLive`, NOT `duelInFlight`. The narrow predicate is false for the whole of round 2, so using
  // it here reported a duel as already finished WHILE its rebuttal was generating - and then ended it
  // anyway, winning the orchestrator's claim and killing the round 2 it had just told the person was
  // over. A duel is finished when the orchestrator says so, not when both sides happen to be idle.
  const rows = await readBattleRows(active.battleId);
  if (!duelIsLive(rows)) {
    // Nothing further is going to happen for this duel: it resolved, or every side was abandoned.
    // Release the pointer so the next `/battle` is not refused, and say the plain thing rather than
    // reporting an end that had already happened.
    await endBattle({
      channelArn,
      battleId: active.battleId,
      reason: 'abandoned:requested',
      endedBy: senderArn,
      classification: channelClassification,
    });
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleAlreadyDone',
      to: [senderArn],
    });
    return;
  }

  const outcome = await endBattle({
    channelArn,
    battleId: active.battleId,
    reason: 'abandoned:requested',
    endedBy: senderArn,
    classification: channelClassification,
  });

  // SAY WHAT ACTUALLY HAPPENED. A lost orchestrator claim means a rebuttal was already on its way and
  // cannot be recalled, so promising "no more answers" would be a promise the channel visibly breaks a
  // few seconds later. It still counts for nothing, and that is the part worth stating.
  await sayNotice({
    classification: channelClassification,
    channelArn,
    botArn: defaultBotArn,
    kind: outcome.round2Suppressed ? 'battleEnded' : 'battleEndedReplyInFlight',
    to: [senderArn],
  });
}

async function handleBattleMessage(params: HandleBattleParams): Promise<void> {
  const { channelArn, classification: channelClassification, userMessageId, content, senderArn, defaultBotArn, imageAttachment } = params;
  console.log('[ChannelFlow][battle] Detected', { channelArn, senderArn });

  // A BATTLE HAS AN INITIATOR, the way a task has an owner (ADR-024, owner 2026-08-20).
  //
  // Every ownership rule in a duel is a rule about this person: they are who a waiting side is waiting
  // on, the only one whose reply resumes it, and the only one who may end it. When the sub could not be
  // derived it was passed along as `undefined`, and each of those rules quietly degraded to "anyone" -
  // the handler's duel resume fails open when it has no owner to check against. An
  // unattributable duel is therefore not a duel with a small gap in its record; it is one with no
  // ownership rules at all.
  //
  // So it does not start. Refusing costs the sender one message; starting costs the channel a duel
  // anybody can steer.
  const initiatorUserSub = personIdFromArn(senderArn) || '';
  if (!initiatorUserSub) {
    console.error('[ChannelFlow][battle] refusing to start an unattributable duel', { channelArn, senderArn });
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleStarterUnknown',
      to: [senderArn],
    });
    return;
  }

  // 1. Eligibility gate. Resolve classification from the immutable `classification` tag (not mutable
  //    metadata) so a tampered modelTier cannot open premium battles on a lower channel, then gate on
  //    `canRunBattle` - the SAME source the enable path uses
  //    (`channel-battle.ts`). Hardcoding `!== 'premium'` here meant a deployment could mark a
  //    non-premium profile battle-eligible, arm Battle Mode on the enable path, and then have every
  //    `/battle` silently refused at invocation. A missing or unreadable tag no longer reaches this
  //    gate at all: the flow releases the message before dispatch (ADR-045 decision 2), which is what
  //    keeps it closed now that falling back to the floor would no longer close it.
  //
  //    TWO QUESTIONS, ASKED TOGETHER (ADR-049). A duel needs the deployment to have WIRED battle for
  //    this classification and an operator to have TURNED IT ON. The old single `battleEligible` flag
  //    on the assistant profile answered `true` for basic, whose stack wires no battle plumbing, so
  //    the surface promised what the role could not back. `canRunBattle` asks capability first.
  //
  //    A DEPLOYMENT WITHOUT `battle` answers here with no read: the flow is told the battle tables exactly where the
  //    capability is declared (`battleDeclared`), and the operator's setting is the Battle stack's to grant.
  if (!battleDeclared() || !(await canRunBattle(channelClassification))) {
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleUnavailable',
      to: [senderArn],
    });
    return;
  }

  // 2. Battle-enabled check. The ChannelBattleConfig.enabled flag must be
  //    set (admin or moderator toggled Battle Mode on for this channel).
  //    Without this, the alt isn't a channel member and there's
  //    no second assistant to fan out to.
  const battleConfig = await loadChannelBattleConfig(channelArn);
  if (battleConfig?.enabled !== true) {
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleNotEnabled',
      to: [senderArn],
    });
    return;
  }

  // 2b. The bound experiment must still be LIVE.
  //
  //     `ChannelBattleConfig` is a SNAPSHOT taken at enable time (challenger, experiment id, briefing).
  //     Nothing re-checked the experiment afterwards, so a channel enabled while an experiment was
  //     active kept fanning out duels indefinitely after that experiment ended - recording human picks
  //     against a completed experiment, where they can never reach a recommendation. Enabling a NEW
  //     channel correctly refused (enable auto-resolves the single ACTIVE battle experiment), so the
  //     two paths disagreed about whether battle was available.
  //
  //     Ending an experiment is how an operator stops a comparison, and it has to stop the duels too.
  //     READ THROUGH THE 60 s MEMO, the same window the config row above is already read through.
  //     The decision is a pair - this channel's bound experiment id, and that experiment's status -
  //     and the id half comes from `loadChannelBattleConfig`'s cached row, so pairing it with an
  //     uncached full `Scan` bought no freshness the decision could use while charging every `/battle`
  //     a table scan. One window for both halves, and it is the window an operator ending an
  //     experiment already converges in.
  //     A REFUSAL IS CONFIRMED FRESH (`battleIsRunnableConfirmed`): the memo may still say "ended" for an
  //     experiment re-activated inside the window, and the notice below would then be false.
  if (!(await battleIsRunnableConfirmed(battleConfig, listExperimentsCached, () => { invalidateExperimentsCache(); return listExperimentsCached(); }))) {
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleExperimentEnded',
      to: [senderArn],
    });
    return;
  }

  // 3. Single-active-battle guard (SPEC-BATTLE.md "max 1 active battle per
  //    channel"; B1). Before claiming the round-1 fan-out, check whether the
  //    channel already has an IN-FLIGHT battle: a fresh activeBattleId pointer
  //    whose BattleState still has a NON-terminal participant (INVOKED or
  //    WAITING_FOR_USER) that has not TTL-expired. If so, a second /battle would
  //    overwrite the activeBattleId pointer (setActiveBattle) and orphan the
  //    first battle's resolution, so we reply to the SENDER and broadcast
  //    nothing (FR5 explained-no-op shape). Deriving battleId here also lets us
  //    NOT block a redelivery of the SAME /battle message (it points at its own
  //    battleId — tryClaimRound1Fanout dedupes that below). The pointer is a
  //    soft lock: a stale pointer with only terminal/TTL-aged rows falls
  //    through and the new battle proceeds.
  const battleId = deriveBattleId(channelArn, userMessageId);
  const activeBattleId = await resolveActiveBattleId(channelArn);
  if (activeBattleId && activeBattleId !== battleId) {
    // RAW rows, sentinels included: `duelIsLive` reads the resolution marker, which `botRowsOnly`
    // filters out by design. Stripping first would hide the very row that says the duel is over. The
    // state filter below is unaffected - a sentinel is never INVOKED or WAITING_FOR_USER.
    const activeRows = await readBattleRows(activeBattleId);
    // STILL RUNNING means a side is generating or blocked on a person AND has not blown its deadline.
    //
    // It used to mean "...and the row has not been deleted yet", reading `ttl > nowSec`. Expiry is a
    // fact about DynamoDB's janitor; being past deadline is a fact about the duel, and conflating them
    // made one number carry two meanings. When the row lifetime was lengthened so a finished side could
    // outlive its rival's think time, a stalled duel silently went from holding its channel for ten
    // minutes to holding it for four hours - nobody changed this guard, and its behavior changed
    // anyway. `deadlineAt` carries the right clock for the state the row is in (ADR-026).
    //
    // LIVE, not merely in flight: a duel mid-round-2 has both sides idle at COMPLETED and is very much
    // still going, so the narrow predicate would have let a second `/battle` start on top of a rebuttal
    // about to land. The deadline check keeps the escape hatch for a duel whose side crashed and will
    // never report - that one really is abandoned, whatever its rows say.
    const stalled = activeRows.length > 0 && activeRows
      .filter((r) => r.state === 'INVOKED' || r.state === 'WAITING_FOR_USER')
      .some((r) => isPastDeadline(r));
    const stillRunning = duelIsLive(activeRows) && !stalled;
    if (stillRunning) {
      // WHAT THIS SAYS DEPENDS ON WHO ASKED (DESIGN-BATTLE 2a-i).
      //
      // The duel's initiator is allowed to leave the one they are in, so they are offered the way out
      // rather than told to "try again" as though the running battle were weather. Anyone ELSE is
      // refused, and told the two routes that exist: its initiator ends it, or a moderator turns Battle
      // Mode off. That refusal is not politeness - a duel that any member could end or restart would
      // leave the assistants taking competing instructions from several people at once, which is the
      // opposite of the focus a head-to-head comparison needs.
      const active = await resolveActiveBattle(channelArn);
      const senderStartedIt = Boolean(active?.initiatorUserSub)
        && active?.initiatorUserSub === (personIdFromArn(senderArn) || '');
      console.log('[ChannelFlow][battle] a battle is already in flight', {
        channelArn,
        activeBattleId,
        attemptedBattleId: battleId,
        senderStartedIt,
      });
      await sayNotice({
        classification: channelClassification,
        channelArn,
        botArn: defaultBotArn,
        kind: senderStartedIt ? 'battleAlreadyRunningYours' : 'battleAlreadyRunningTheirs',
        to: [senderArn],
      });
      return;
    }

    // SUPERSEDING A DUEL IS ALSO ENDING IT, and this path used to just walk past.
    //
    // Falling through means the pointer is about to be overwritten by `setActiveBattle`. The duel it
    // named - stalled past its deadline, or resolved - then had no owner, no release, and, if a side
    // was parked on a question, a live "Replying to:" control on a message nothing would ever read.
    // That is the fourth call site this module's own header warned would get ending wrong, and it did.
    //
    // Best-effort by construction: the person's new duel must start whether or not the old one tidies
    // up cleanly, so nothing here is awaited for its result beyond the logging inside `endBattle`.
    console.log('[ChannelFlow][battle] superseding a duel that is no longer live; ending it first', {
      channelArn,
      supersededBattleId: activeBattleId,
      newBattleId: battleId,
    });
    await endBattle({
      channelArn,
      battleId: activeBattleId,
      reason: 'abandoned:new-battle',
      endedBy: senderArn,
      classification: channelClassification,
    });
  }

  // 4. The assistant members of the channel, from the roster the address pass already read.
  //
  // NOT A SECOND READ. See `HandleBattleParams.size` for what the second one cost: a different
  // pagination bound, and therefore a different roster, for a duel in a room past 50 members.
  //
  // NEVER SILENT WHEN IT CANNOT BE ANSWERED. The router returns silence for the /battle token
  // unconditionally, so this flow is the only thing that can answer - a bare return here left the
  // user's persisted /battle answered by nothing after a transient Amazon Chime SDK throttle. An
  // unreadable roster arrives as `unknown`, which is the same fact the old `catch` was acting on.
  // Same rule as every sibling gate in this function: the person is told, targeted, best-effort.
  if (!params.size || params.size.unknown) {
    console.warn('[ChannelFlow][battle] the channel roster is unreadable; cannot resolve the duel members', {
      channelArn,
    });
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleStartFailed',
      to: [senderArn],
    });
    return;
  }
  const botMembers = params.size.members.filter((m) => m.isBot).map((m) => m.arn);

  if (botMembers.length < 2) {
    console.log('[ChannelFlow][battle] <2 bot members, falling back to @all');
    await handOffTurnToRouter({
      channelArn,
      classification: channelClassification,
      content,
      senderArn,
      senderName: params.senderName,
      botArn: defaultBotArn,
      messageId: userMessageId,
    });
    return;
  }

  // Routing. A battle answers at the channel's OWN classification, not a hardwired premium one - the
  // same rule `@all` follows, and load-bearing since the eligibility gate started honoring
  // `battleEligible`: a battle-eligible standard channel routed to premium would answer with the
  // premium model, the premium guardrail and the premium `context/` S3 scope, which are IAM-enforced
  // classification boundaries. No classification falls back to another's router (ADR-046).
  //
  // It is the ROUTER's arn now, not the processor's: the turn is handed to the handler, which
  // dispatches its own worker. One routing table decides both, so the two can never disagree.
  const battleRouterArn = await resolveRouterArn(channelClassification);
  if (!battleRouterArn) {
    // Deterministic and deployment-shaped (a missing router env), so silence would read as the
    // assistant being broken on EVERY /battle in this channel. Tell the person, loudly log the why.
    console.warn('[ChannelFlow][battle] no router wired for classification, cannot fan out', {
      channelClassification,
    });
    await sayNotice({
      classification: channelClassification,
      channelArn,
      botArn: defaultBotArn,
      kind: 'battleNotConfigured',
      to: [senderArn],
    });
    return;
  }

  // Cost/abuse gate (SPEC-ABUSE-CONTROLS): a /battle fans out N model calls (one per bot) through the
  // premium processor, bypassing the Lex router's gate - the single most expensive dispatch, so it
  // MUST pass the sender's rate limit + spend budget. Gated here, after every cheap rejection (tier,
  // battle-enabled, single-active, <2-bot fallback) and BEFORE the round-1 claim/fan-out, so an
  // over-budget battle consumes no claim and spends nothing.
  //
  // The <2-bot fallback above returns before reaching this, and is gated by the ROUTER it hands off to
  // rather than here - handOffTurnToRouter no longer runs a gate of its own. That is the point:
  // `evaluateAbuseGate` both increments the rate counter and consumes budget, so a gate on both sides
  // of the handoff would double-charge every `@all`. This gate stays because the battle fan-out still
  // dispatches processors directly and so genuinely does bypass the router.
  if (!(await enforceAbuseGate(channelArn, defaultBotArn, senderArn, channelClassification))) {
    return;
  }

  // 5. Per-bot fan-out. battleId (derived above from channelArn+userMessageId)
  //    is deterministic so retries are idempotent.

  // Idempotency: claim the round-1 fan-out exactly once. Chime channel flows are
  // at-least-once, so the SAME /battle message can re-enter here; deriveBattleId
  // gives it the same battleId, and without this claim we would fan out a second
  // time and post duplicate round-1 replies. Only the first delivery proceeds.
  // The claim also records the channel, so a pick submitted later can be checked against the duel it
  // names rather than only against the channel the person happens to be in.
  if (!(await tryClaimRound1Fanout(battleId, channelArn))) {
    console.log('[ChannelFlow][battle] round-1 fan-out already claimed; skipping duplicate delivery', { battleId });
    return;
  }

  console.log('[ChannelFlow][battle] Fanning out', { battleId, botCount: botMembers.length });

  // Stamp the channel→battle pointer so a later message (whose id can't re-derive this battleId) can
  // resolve it: the handler's duel resume and `/battle end` both read it.
  // Non-fatal by contract — never blocks the fan-out.
  await setActiveBattle({
    channelArn,
    battleId,
    initiatorUserSub,
  });

  await Promise.all(
    botMembers.map(async (thisBotArn) => {
      const rivalBotArn = botMembers.find((arn) => arn !== thisBotArn) || '';
      const correlationId = battleCorrelationId({ botArn: thisBotArn, round: 'r1' });

      // Record the initial INVOKED state row BEFORE the turn, so a side that crashes mid-turn is
      // still visible in flight rather than invisible. attribute_not_exists makes this idempotent
      // across channel-flow redelivery. It carries NOTHING about tasks (DESIGN-BATTLE §2a).
      await initBotState({
        battleId,
        botArn: thisBotArn,
        correlationId,
        // The duel's owner: the person who ran /battle. Recorded on every side.
        initiatorUserSub,
      });

      // HAND THE TURN TO THE HANDLER, exactly as `@all` does. Everything this loop used to do
      // itself - classify, resolve the image pair, resolve both variants, create the task, choose a
      // delivery option, invoke the processor - was a SECOND implementation of decisions the handler
      // already makes for every Lex turn, and a second implementation diverges silently: the duel
      // still answers, so nothing errors. That is exactly how an image duel ran as a text duel.
      //
      // What the flow still says is only what a side cannot know about itself: which duel, which
      // round, and who its rival is. Which side is the challenger the turn reads from the alt's own
      // assignment record, and it decides what that side IS.
      //
      // SYNCHRONOUS, because the placeholder comes BACK from the turn already carrying this side's
      // variant name in its marker - the reason the fan-out resolved variants at all.
      let reply: LexResponse;
      try {
        reply = await invokeRouterTurn(battleRouterArn, {
          channelArn,
          senderArn,
          userMessage: content,
          userMessageId,
          botArn: thisBotArn,
          correlationId,
          trigger: 'user',
          ...(imageAttachment && { attachment: imageAttachment }),
          battleContext: {
            battleId,
            round: 1,
            totalRounds: 2,
            selfBotArn: thisBotArn,
            rivalBotArn,
            originatingMessageId: userMessageId,
            ...(imageAttachment && { imageAttachment }),
          },
        });
      } catch (err) {
        console.error('[ChannelFlow][battle] turn invoke failed for', thisBotArn, err);
        // Nothing has been posted for this side yet, so say what happened rather than leaving a
        // silent gap where an answer should be. The rival still runs; a degraded duel is visible.
        // THIS SIDE'S OWN NOTICE, so it is attributed like every other: the duel side that failed is
        // the one speaking, and a degraded duel is still a duel somebody has to be able to account for.
        await sayNotice({
          classification: channelClassification, channelArn, botArn: thisBotArn, kind: 'battleSideStartFailed', to: [],
        });
        return;
      }

      // Normally empty now: each side posts its own placeholder as its own bot (ADR-025), which is
      // also what puts this side's variant display name in the marker. A non-empty array means the
      // router could not post; that side's processor posts the answer itself (`noteHandedBackMessage`).
      noteHandedBackMessage({
        response: reply,
        logPrefix: '[ChannelFlow][battle]',
        logContext: { battleId, botArn: thisBotArn, round: 1 },
      });
    }),
  );
}

/**
 * What the flow's handover routing reads and does, wired to this function's own client and claims.
 * Reads are as the HANDOVER'S SENDER, which may always read its own message and the person's message it
 * answered; a read moments after the release can miss, so it is retried once.
 */
const flowHandoverDeps = {
  async readMessage(channelArn: string, messageId: string, bearerArn: string) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await messagingClient.send(new GetChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: bearerArn }));
        if (res.ChannelMessage) return res.ChannelMessage;
      } catch { /* retried once, then unreadable */ }
    }
    return null;
  },
  async listMembers(channelArn: string, bearerArn: string) {
    const size = await resolveChannelSize(messagingClient, channelArn, bearerArn);
    return size?.unknown ? null : (size?.members ?? null);
  },
  claim: (key: string) => claimCorrelation(key),
  async dispatch(turn: HandoverDispatch): Promise<boolean> {
    const classification = await getChannelClassification(turn.channelArn, turn.receiverBotArn);
    if (!classification) return false;
    await handOffTurnToRouter({
      channelArn: turn.channelArn,
      classification,
      // EMPTY BY DESIGN: the receiving router reads the person's message itself, as its own bearer, or
      // takes the words a task handover carries from the verified handover message.
      content: '',
      senderArn: turn.marker.personSenderArn,
      senderName: '',
      botArn: turn.receiverBotArn,
      requestWasPrivate: turn.privateToPerson,
      messageId: turn.marker.personMessageId,
      handoverMessageId: turn.handoverMessageId,
    });
    return true;
  },
};
