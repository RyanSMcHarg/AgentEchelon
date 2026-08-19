/**
 * Channel Flow Processor
 *
 * Invoked by Chime SDK on every message in a channel (before Lex processing).
 *
 * WHAT THIS DOES AND DOES NOT DECIDE (MESSAGE-FLOW §3.1). This flow decides WHO responds. It does
 * not run the turn: classification, profile resolution, variant resolution, the delivery option and
 * the correlation id all belong to `router-agent-handler.ts`, the same code Lex fulfills into. A
 * decision duplicated here diverges SILENTLY, because the turn still answers either way.
 *
 * Responsibilities:
 * - Detect `@all` and hand the turn to the classification's handler, then post the placeholder it
 *   returns; the reply is broadcast to everyone. `@all` is not a Chime CHIME.mentions value, so
 *   AUTO + Lex would not route it, which is why the bypass exists at all.
 *   TAKEN AT EVERY CHANNEL SIZE, with no member-count branch. In a 1:1 AUTO also routes the message
 *   to Lex, so both entries see the turn - and the ROUTER stands down for `@all` rather than this
 *   flow behaving differently by channel size. One responder, one path.
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
  tryClaimRound1Fanout,
  initBotState,
  isBattleEnabled,
  loadChannelBattleConfig,
  battleIsRunnable,
  setActiveBattle,
  resolveActiveBattleId,
  resolveActiveBattle,
  readBattleRows,
  botRowsOnly,
  planBattleContinuation,
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
// NO intent classifier, NO variant or image-pair resolvers, NO task creation and NO delivery-option
// planner. Every one of those was a second implementation of a decision the handler already makes for
// every Lex turn, and the flow now hands the turn over instead (MESSAGE-FLOW §3.1). They are pinned
// as forbidden in `flow-does-not-run-the-turn.test.ts`, so they cannot come back quietly.
import { isEmptyLexEnvelope, unwrapLexEnvelopeForChannel } from './lib/lex-envelope.js';
import { listExperiments } from './lib/experiment-manager.js';
// NO task imports. Which chain a resumed side continues is a turn question, answered by the handler
// via the owner lookup (ADR-024); the flow asked it here and passed a delivery option down, which is
// how a resumed side lost its variant.
import { parseNotifyDirective, fanOutChannelNotification } from './lib/channel-notify.js';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry.js';
import { resolveChannelClassificationTag as resolveChannelClassificationTagShared } from './lib/channel-classification.js';
import { battleCorrelationId, correlationMarkerOf } from './lib/correlation.js';
import { resolveChannelSize } from './lib/channel-size.js';
import { routerArnForClassification } from './lib/router-arn.js';
// The bot-to-bot loop guard. Lands BEFORE the coordination feature that needs it (ADR-023 round 2),
// because the nudge would be the first bot-to-bot targeted message this system has ever sent.
import { evaluateBotToBot } from './lib/bot-coordination.js';
// The bypass tokens, shared with the router so the two sides cannot disagree about what one is.
import {
  matchesAtAll,
  matchesBattleCommand,
  stripAtAll,
  stripBattleCommand,
} from './lib/flow-bypass.js';
// TYPE-ONLY: the bypass contract, taken from the router itself so the two sides cannot drift. Erased
// at build time, so the router is not pulled into this bundle - the flow reaches it by INVOKE, which
// is the whole point (importing it would run the turn on the flow's IAM role, which holds no Bedrock
// or SSM grants).
import type { TurnRequest, LexResponse } from './router-agent-handler.js';
import { evaluateAbuseGate, claimPlaceholderMapping, claimCorrelation } from './lib/abuse-controls.js';
import { resolveUserClearance } from './lib/user-clearance.js';

const messagingClient = new ChimeSDKMessagingClient({});
const lambdaClient = new LambdaClient({});
const ssmClient = new SSMClient({});

// NO PROCESSOR ARNs HERE ANY MORE, and their absence is the point.
//
// The flow used to resolve an async-processor ARN per classification and invoke the worker directly on
// three paths (`@all`, the `/battle` fan-out, the battle continuation). All three now hand the turn to
// the ROUTER instead, which dispatches its own worker - so the flow no longer chooses a worker at all,
// and the fail-safe rules it used to duplicate (`basic` never falls back UP, `premium` may fall back
// DOWN) live in exactly one place instead of being re-derived here.
//
// `routerArnForClassification` - imported from `lib/router-arn.js`, which is the only routing table
// this file has - is no longer defined here: it was one of two identical copies. The processor env
// vars the CDK still sets on this function are now unread; removing them from the stack is safe
// cleanup, not a prerequisite.
//
// The per-classification ROUTER (`router-agent-handler`, the same Lambda Lex fulfills into). `@all`
// hands the turn here instead of running it, so classification, profile resolution, variant
// resolution and delivery-option choice happen ONCE, in the one place that does them for every turn
// (MESSAGE-FLOW §3.1).
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

// Read the channel's classification from its IMMUTABLE `classification` tag. This is a SHARED
// flow (one processor for all channels), so it discovers the classification per message and that
// choice decides which per-classification assistant responds and whether premium battles run. We
// must NOT read `metadata.modelTier`: metadata is mutable via the owner rename cap
// (chime:UpdateChannel), so a moderator could tamper it up to make a higher-classification
// assistant respond or open premium battles on a lower-classification channel. The tag cannot be
// changed by UpdateChannel. Fail-closed to basic. (bearerArn is unused for a tag read.)
async function getChannelClassification(channelArn: string, _bearerArn: string): Promise<string> {
  return resolveChannelClassificationTagShared(messagingClient, channelArn, '[ChannelFlow]');
}

// Resolve the channel's PER-CLASSIFICATION bot (its real creator+member) — the ChimeBearer
// for every bot-attributed action here (@all broadcast, member count, /battle
// default combatant). There is no shared cross-classification bot fallback: a missing
// per-classification SSM key is an error (the classification stack publishes it on deploy).
const botArnCache: Record<string, string> = {};
async function resolveBotArn(classification: string): Promise<string> {
  if (botArnCache[classification]) return botArnCache[classification];
  const key = `${SSM_ROOT}/assistant/${classification}/bot-arn`;
  const resp = await ssmClient.send(new GetParameterCommand({ Name: key }));
  const arn = resp.Parameter?.Value;
  if (!arn) {
    throw new Error(`[ChannelFlow] per-classification bot param ${key} is empty`);
  }
  botArnCache[classification] = arn;
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

/**
 * How a flow delivery is recognised as one already handled (SPEC-ABUSE-CONTROLS dedup, ADR-022).
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
 * that lives in a process is a same-container optimisation wearing the label of a control.
 */
const flowDeliveryKey = (messageId: string): string => `flow-${messageId}`;

// `@all` takes the SAME bypass in every channel, so no member count is read here. The turn is owned
// by this flow regardless of size; what differs by size is only whether Chime ALSO invokes Lex, and
// that is settled in the router (see `router-agent-handler.ts`, the `@all` guard).

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
    // it is a legitimate Lex reply for a handler that is a formality rather than a reply path
    // (`battle-alt-slot-handler`), and returning NO envelope is not the same thing (Chime materialises
    // one message per turn from the last fulfillment response, which is how the placeholder is created).
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
    // to `callbackAllow`, which skipped the duplicate-placeholder claim below - and the Lex-materialised
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
    // WHAT THIS SEES. Every bot message in the channel, INCLUDING ones Amazon Chime SDK materialises
    // from a Lex fulfillment return. This comment previously asserted the opposite - that a
    // Lex-created placeholder "never enters a channel flow" - and that is wrong. Verified live
    // 2026-08-06: a Lex fulfillment returned `{"Messages":[]}`, Chime created message
    // `7f5a1c78...` from it, and this flow was invoked for exactly that MessageId.
    //
    // That matters, because it makes this guard the backstop for the ROUTER's idempotent replay. The
    // router answers a duplicate fulfillment with the SAME placeholder rather than an empty envelope
    // (see `router-agent-handler.ts`), so if both attempts' responses ever materialise, both arrive
    // here carrying one correlation marker - and the second is denied below. One placeholder per turn
    // is enforced HERE, which is why the router is free to be idempotent rather than silent.
    //
    // It also catches a cross-container redelivery of an `@all`, which posts its placeholder before any
    // durable claim is taken; `/battle` is already claimed upstream (`tryClaimRound1Fanout`,
    // `resumeBotFromWaiting`) and cannot reach here twice.
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
    if (corr) {
      const owner = await claimPlaceholderMapping(corr, MessageId);
      if (owner !== MessageId) {
        console.log('[ChannelFlow] duplicate placeholder denied', {
          correlationId: corr, messageId: MessageId, owner,
        });
        await callbackDeny(CallbackId, channelArn, MessageId);
        return;
      }
    }

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
          // The unwrapped text, for the same reason: an email that quoted the raw envelope would ship
          // the wrapper to a reader who has no unwrapper at all.
          messageText: safeDecodeURIComponent(storedContent),
          directive,
        });
        console.log('[ChannelFlow] notify fan-out', res);
      } catch (e) {
        console.warn('[ChannelFlow] notify fan-out failed (non-fatal):', e);
      }
    }
    await callbackAllow(CallbackId, channelArn, MessageId, storedContent, Metadata);
    return;
  }

  const decodedContent = safeDecodeURIComponent(Content);
  // Detect against BOTH the decoded and raw Content. safeDecodeURIComponent
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
  console.log('[ChannelFlow] routing', {
    invokesBattle,
    mentionsAll,
    // How many recipients this message is Target-addressed to, AS THE FLOW RECEIVES IT. Logged because
    // the continuation gate below turns entirely on it, and its absence is indistinguishable in every
    // other record: a targeted reply that the flow sees as untargeted is delivered, answered as an
    // ordinary turn, and looks exactly like a message the user never targeted.
    targets: (ChannelMessage.Target ?? []).length,
    // Its counterpart. `Target` does NOT survive into this event and `Metadata` does, which is what
    // makes Metadata the only per-message channel a client has to this code - Lex never sees either.
    metaLen: (Metadata ?? '').length,
    decodeChanged: decodedContent !== Content,
    rawHead: JSON.stringify(Content).slice(0, 64),
    decHead: JSON.stringify(decodedContent).slice(0, 64),
  });

  // Resolve the channel's per-classification bot (its real member) for every
  // bot-attributed action below — @all broadcast, member count, and the
  // /battle default combatant. No shared bot is a channel member, so only the
  // per-classification bot can read the channel and send. Classification is read as the SENDER (a
  // member); for a /battle channel that
  // resolves to the premium bot, the correct default combatant.
  const channelClassification = await getChannelClassification(channelArn, senderArn);
  const botArn = await resolveBotArn(channelClassification);

  // ═══════════════════════════════════════════════════════════════
  // /battle continuation: a reply Target-addressed to a bot that is
  // WAITING_FOR_USER in this channel's active battle (SPEC-BATTLE.md
  // "Per-bot reply UX"). Resolved BEFORE the universal callback because
  // a continuation must be DENIED (DeleteResource) — not allowed
  // through — so Chime-native TargetedMessages:ALL does not ALSO route
  // it to Lex. The reply is consumed privately; only the targeted bot
  // reply comes back. Cheap-gated on the message actually being
  // bot-targeted so ordinary traffic skips the DDB reads.
  //
  // ⚠ MEASURED 2026-08-14, AND THIS GATE IS NEVER TRUE ON THE DEPLOYMENT. The channel-flow callback's
  // `ChannelMessage` does not carry `Target`. A message sent with one - confirmed present on the stored
  // message via GetChannelMessage - arrives here with these fields and no more:
  //
  //   Content, Persistence, Sender, Type, MessageId, CreatedTimestamp, ChannelArn, PushNotification
  //
  // So `targetedBotArns` is always empty, and everything below it is unreachable: no continuation is
  // ever resolved, no reply is ever DENIED, and a side sitting in `WAITING_FOR_USER` cannot be resumed
  // by anybody - owner or not. The reply is delivered and answered as an ordinary turn instead, which
  // is indistinguishable from a message the user never targeted, which is why this survived unnoticed.
  // The `targets:` field in the routing log above is what makes it visible.
  // ═══════════════════════════════════════════════════════════════
  const targetedBotArns = extractTargetedBotArns(ChannelMessage.Target);
  let continuation:
    | { battleId: string; rows: BattleStateRow[]; resumeBotArns: string[] }
    | null = null;
  if (targetedBotArns.length > 0 && !invokesBattle && !mentionsAll) {
    const active = await resolveActiveBattle(channelArn);
    if (active) {
      const rows = await readBattleRows(active.battleId);
      // ONLY THE OWNER RESUMES A DUEL. A reply from anyone else is not refused - it simply resumes
      // nothing and is answered as an ordinary turn.
      //
      // The owner comes from the POINTER, which is the row that keeps it. Reading it off the battle
      // rows - the shape this shipped as - compared against a field the duel's own progress had
      // erased, so the check passed for everyone and the rule was inert.
      const { resumeBotArns } = planBattleContinuation(
        rows,
        targetedBotArns,
        senderArn.split('/user/').pop() || undefined,
        active.initiatorUserSub,
      );
      // The continuation decision, recorded. Every outcome here is SILENT otherwise - a reply that
      // resumes nothing is delivered and answered as an ordinary turn, which is also what a
      // never-targeted message looks like - so without this line the difference between "the owner
      // rule refused it", "no side was waiting" and "the pointer had aged out" cannot be told apart
      // from any record the system keeps. Identities are logged as a BOOLEAN, not as subs.
      console.log('[ChannelFlow][battle] continuation resolution', {
        battleId: active.battleId,
        targetedBots: targetedBotArns.length,
        waitingSides: rows.filter((r) => r.state === 'WAITING_FOR_USER').length,
        ownerRecorded: Boolean(active.initiatorUserSub),
        speakerIsOwner: active.initiatorUserSub
          ? active.initiatorUserSub === (senderArn.split('/user/').pop() || undefined)
          : null,
        resumes: resumeBotArns.length,
      });
      if (resumeBotArns.length > 0) {
        continuation = { battleId: active.battleId, rows, resumeBotArns };
      }
    }
  }

  // Idempotency for the bypass paths. A continuation is also a bypass; a
  // duplicate must still be DENIED so a redelivery never slips to Lex.
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
  const usesBypass = mentionsAll || invokesBattle || continuation !== null;
  if (usesBypass && !(await claimCorrelation(flowDeliveryKey(MessageId)))) {
    console.log('[ChannelFlow] duplicate delivery; this message is already handled', { messageId: MessageId });
    // STILL CALL BACK. The claim says the message was handled, not that its callback was resolved: a
    // first attempt that died between claiming and calling back would otherwise leave Chime holding
    // the message until it times out, and `FallbackAction: CONTINUE` then delivers it UNPROCESSED,
    // bypassing the mention rules and marker stripping this flow exists to apply. Resolving a callback
    // the winner already resolved is harmless now that an already-decided callback is not an error.
    if (continuation) {
      await callbackDeny(CallbackId, channelArn, MessageId);
    } else {
      await callbackAllow(CallbackId, channelArn, MessageId, Content, Metadata);
    }
    return;
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
    if (cleanMessage) {
      await handleBattleMessage({
        channelArn,
        classification: channelClassification,
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
      await sendBotMessage(
        channelArn,
        botArn,
        'Add a prompt after /battle and both assistants will answer it, for example: /battle what should we prioritise next quarter?',
        [senderArn],
      ).catch((err) => console.warn('[ChannelFlow] empty-/battle hint failed', err));
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
      classification: channelClassification,
      battleId: continuation.battleId,
      rows: continuation.rows,
      resumeBotArns: continuation.resumeBotArns,
      userAnswer: decodedContent,
      senderArn,
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // @all: broadcast bot response. One of the two Lex bypasses (the other is /battle). The reply is
  // visible to all members, and bypassing Lex is the only sanctioned difference from an ordinary turn
  // (MESSAGE-FLOW §3.1).
  //
  // WHO ELSE MIGHT ANSWER, and it decides which entry runs. `@all` is not a Chime CHIME.mentions
  // value, so in a GROUP channel AUTO does not route it: Lex is never invoked and this dispatch is the
  // only thing that can answer. In a 1:1 the opposite holds - AUTO routes EVERY message regardless of
  // mentions, so the Lex entry runs whatever this dispatch does, and taking the bypass as well answered
  // the turn twice (the duplicate users reported).
  //
  // So the size branch below is load-bearing, and this comment used to deny it existed: it read "taken
  // in EVERY channel - one path, no member-count branch", fourteen lines above the member-count branch.
  // EXACTLY ONE entry answers an `@all` at any size. Above 1:1 it is this one; at 1:1 it is Lex, and
  // this returns without dispatching. Both sides read the same helper (`lib/channel-size.ts`) so the
  // two decisions stay exact complements.
  //
  // The message is still ALLOWED through (never denied). Denying would keep Lex out without any router
  // change, but it also drops the user's own message from the channel — unpersisted, invisible to the
  // other members and absent from the assistant's history. That is acceptable for a battle
  // continuation, whose answer is deliberately private; it is not acceptable for `@all`.
  // ═══════════════════════════════════════════════════════════════
  if (mentionsAll) {
    // IN A 1:1, STAND ASIDE (measured 2026-08-12; see lib/channel-size.ts for the evidence).
    //
    // At this size AUTO routes every message to Lex regardless of mentions, so the Lex entry runs
    // whatever this dispatch does. Taking the bypass as well meant TWO entries handled one turn, and
    // because they derive correlation ids by different rules - the flow has the inbound MessageId, the
    // Lex path provably does not - the duplicate-placeholder claim could not recognise them as the
    // same turn. The result was two placeholders 558ms apart with one stranded at "One moment..."
    // forever. Deferring here leaves exactly one entry, so there is one identity and nothing to
    // reconcile.
    //
    // The message is still ALLOWED through (this returns without denying), so the user's own `@all`
    // is persisted and reaches both the channel and the assistant's history, exactly as before.
    const size = await resolveChannelSize(messagingClient, channelArn, botArn);
    if (size.isOneToOne) {
      console.log('[ChannelFlow] @all in a 1:1 — deferring to the Lex entry, which AUTO always invokes', {
        channelArn,
        memberCount: size.memberCount,
      });
      return;
    }

    const cleanMessage = stripAtAll(decodedContent);
    // Attachment-in (image/PDF/doc) rides the @all bypass: the async processor reads the file. The
    // router's `@all` guard is what keeps a 1:1 from ALSO processing it through Lex.
    const allAttachment = extractAttachment(Metadata);
    if (cleanMessage || allAttachment) {
      await handleMentionedMessage({
        channelArn,
        classification: channelClassification,
        content: cleanMessage,
        senderArn,
        senderName: ChannelMessage.Sender?.Name || '',
        botArn,
        broadcast: true,
        attachment: allAttachment,
        messageId: MessageId,
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
 * The ONE definition of the router-invoke boilerplate for all three bypass paths (@all, the
 * round-1 fan-out, the battle continuation), so the FunctionError re-throw and the payload parse
 * cannot drift apart per path. A handler that THREW still returns HTTP 200 with an error payload;
 * posting that unchecked would put a stack trace in the channel as the user's answer, which is
 * why the re-throw is part of this contract rather than per-caller etiquette. What legitimately
 * DIFFERS per path - what to tell the user when the invoke fails - stays with each caller.
 */
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

interface HandleMentionParams {
  channelArn: string;
  /** The channel's classification, resolved ONCE by the main handler from the immutable tag. The
   *  tag cannot change (that is its point), so re-reading it per helper was a second Chime call per
   *  turn for the same answer. */
  classification: string;
  content: string;
  senderArn: string;
  senderName: string;
  botArn: string;
  /** true: broadcast reply visible to everyone. false: targeted reply to sender only. */
  broadcast: boolean;
  /** Attachment-in (image/PDF/doc) from the triggering message Metadata; forwarded to the processor. */
  attachment?: MessageAttachment;
  /** The STABLE inbound Chime message id (F2). Keys the processor's dedup claim so a cross-container
   *  at-least-once redelivery of the same @all collapses to one Bedrock call - matching the router
   *  (CHIME.message.id) and /battle (deriveBattleId). Absent (synthetic/test events) ⇒ random fallback. */
  messageId?: string;
}

/**
 * Handle an @all or @assistant mention.
 *
 * Flow:
 * 1. Quick-path greetings/acknowledgments: respond directly as the bot
 * 2. Non-trivial content: send a placeholder, invoke async processor
 */
async function handleMentionedMessage(params: HandleMentionParams): Promise<void> {
  const { channelArn, classification: mentionClassification, content, senderArn, senderName, botArn, broadcast, attachment, messageId } = params;
  console.log('[ChannelFlow] Mention detected', { broadcast, senderName, hasAttachment: !!attachment });

  const targetArns = broadcast ? undefined : [senderArn];

  // THE FLOW DECIDES WHO RESPONDS; THE ROUTER RUNS THE TURN (MESSAGE-FLOW §3.1). Everything this
  // function used to do itself - the greeting/acknowledgment fast path, the abuse gate, the
  // correlation id, `intent: 'general'`, `deliveryOption` and the processor dispatch - was a second
  // implementation of decisions the router already makes for every Lex turn, and a second
  // implementation diverges SILENTLY: the turn still answers, so nothing errors.
  //
  // @all is answered at the channel's own classification (matching the per-classification bot it is
  // sent as), never hardwired to standard. `basic` deliberately has NO upward fallback: a downgrade to
  // standard is exactly the cross-classification context leak this routing prevents.
  const routerArn = routerArnForClassification(mentionClassification);
  if (!routerArn) {
    console.error('[ChannelFlow] No router wired for classification; cannot process mention', { mentionClassification });
    // Never a silent no-op: an unwired router is a DEPLOYMENT fault, so say so rather than letting the
    // mention vanish. Nothing has been charged at this point - the router owns the abuse gate now, and
    // it has not run.
    await sendBotMessage(
      channelArn,
      botArn,
      "I can't respond in this conversation right now - it isn't fully configured. Please let an administrator know.",
      targetArns,
    );
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
  const aeTurn: TurnRequest = {
    channelArn,
    senderArn,
    userMessage: content,
    userMessageId: messageId,
    // Attachment-in: the file reference from message Metadata, which Lex never sees, so the flow is
    // the only component that can carry it to the turn.
    ...(attachment && { attachment }),
  };

  let response: LexResponse;
  try {
    response = await invokeRouterTurn(routerArn, aeTurn);
  } catch (error) {
    console.error('[ChannelFlow] Router invoke failed for mention:', error);
    // The old shape posted the placeholder FIRST, so a failed dispatch stranded a "One moment..." that
    // never resolved. Nothing has been posted here yet, so say what happened instead of going silent.
    await sendBotMessage(
      channelArn,
      botArn,
      "I couldn't start on that just now. Please try again.",
      targetArns,
    );
    return;
  }

  // AN EMPTY `messages` ARRAY MEANS POST NOTHING (ADR-022), and under ADR-025 that is now the NORMAL
  // outcome rather than the exception: the assistant posts its own acknowledgment, because the turn
  // is what resolved the words from its profile. This branch stays because the empty array also means
  // a genuinely silent turn (a duplicate fulfillment that lost its correlation claim), and it is the
  // fallback when the turn's own send failed and handed the message back.
  const placeholder = response.messages?.[0]?.content;
  if (!placeholder) {
    console.log('[ChannelFlow] nothing to post for this mention; the turn either posted its own message or was silent');
    return;
  }

  // Reached only when the turn handed the message back - it could not post (no resolved identity, or
  // the send failed). Posting it here keeps a Chime hiccup from becoming a turn that answered and
  // showed nothing. The message carries the correlation marker either way, so the duplicate-placeholder
  // guard still claims `corr# -> MessageId` when it re-enters the flow (§5.1).
  console.log('[ChannelFlow] the turn handed its message back; posting on its behalf');
  await sendBotMessage(channelArn, botArn, placeholder, targetArns);
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
): Promise<string | undefined> {
  const isTargeted = !!targetArns && targetArns.length > 0;
  const metadata: Record<string, unknown> = { botResponse: true };
  if (isTargeted) metadata.targetedSender = targetArns![0];
  const res = await messagingClient.send(
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
  // Returned, not discarded. When this message is a PLACEHOLDER the caller can hand the id straight to
  // the async processor as `placeholderMessageId`, and the processor takes the branch that skips
  // `pollForPlaceholderMessage` entirely. Discarding it was the only reason the flow-dispatched paths
  // searched for a message they had just created and already knew the id of.
  //
  // Undefined is tolerated rather than treated as an error: the send SUCCEEDED, so the turn should
  // proceed, and a caller with no id simply falls back to the poll as before.
  return res.MessageId;
}

/**
 * Cost/abuse gate for the channel-flow dispatch paths (SPEC-ABUSE-CONTROLS).
 *
 * The Lex router-agent-handler gates the 1:1 tier turn, but @all/@assistant mentions and /battle
 * fan-outs are dispatched HERE (channel-flow forwards or invokes the async/premium processor
 * directly), BEFORE Lex - so without this gate a group channel is a budget-bypass path that reaches
 * the model without ever crossing the router's ceiling. Enforce the SAME per-user hourly rate limit
 * and per-user+global spend budget the router does, keyed on the sender's sub, right before the
 * expensive dispatch. Over-limit/over-budget replies to the SENDER only (targeted) and returns false
 * so the caller skips the invoke/fan-out (no model cost).
 *
 * isAdmin is intentionally NEVER true here: the router's opt-in admin exemption is a 1:1-tier
 * affordance gated on a server-verified Cognito group; a group @all/battle never carries that
 * exemption, so an admin in a shared channel pays budget like any other member (fail-safe - the
 * global ceiling that protects the account is admin-inclusive regardless).
 *
 * Both controls no-op until their env is wired (checkRateLimit/checkAndConsumeBudget return allowed
 * when ABUSE_CONTROLS_TABLE / the budget envs are unset), so this is inert until enabled.
 */
async function enforceAbuseGate(
  channelArn: string,
  botArn: string,
  senderArn: string,
  classification: string,
): Promise<boolean> {
  const userSub = senderArn.split('/user/').pop() || senderArn;
  // METERED AT THE SENDER'S EFFECTIVE CLASSIFICATION, the same min(channel, clearance) rule the
  // router applies to the same person's ordinary turns. Charging at the CHANNEL's classification -
  // the shape this shipped as - let a basic-clearance member of a premium channel who was over their
  // own ceiling keep spending via /battle, the single most expensive dispatch, against a ceiling
  // that was never theirs. Federated senders skip the lookup (they do not exist in the pool; their
  // entitlement IS the channel they were provisioned into - same rule as the router's).
  const isFederated = userSub.startsWith('fed_');
  const effective = isFederated
    ? classification
    : profiles.min(classification, (await resolveUserClearance(userSub)).clearance);
  // Shared gate (order + message selection live in lib/abuse-controls). isAdmin:false - the opt-in
  // admin exemption is a 1:1-tier router affordance; a group @all/battle never carries it.
  const gate = await evaluateAbuseGate({
    userSub,
    rateCeiling: profiles.profileFor(effective).rateLimitPerHour ?? 0,
    isAdmin: false,
  });
  if (!gate.allowed) {
    console.warn(`[ChannelFlow] ${gate.reason} gate blocked dispatch; serving notice`, { classification, userSub: userSub.slice(0, 8) });
    await sendBotMessage(channelArn, botArn, gate.message, [senderArn]);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// /battle (SPEC-BATTLE.md)
// ─────────────────────────────────────────────────────────────────

interface HandleBattleContinuationParams {
  channelArn: string;
  /** See HandleMentionParams.classification - resolved once, passed down like botArn. */
  classification: string;
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
  const { channelArn, classification: channelClassification, battleId, rows, resumeBotArns, userAnswer, senderArn } = params;

  // A continuation resumes the SAME battle, so it routes exactly as the round-1 fan-out does: to the
  // ROUTER for the channel's classification, never a hardwired premium one. Resolved from the
  // immutable tag via a resuming bot as bearer.
  //
  // It is the router's arn, not the processor's, because a continuation IS a turn: the handler
  // classifies it, finds the chain this side owns and resolves this side's variant. One routing table
  // decides both rounds and the continuation, so they cannot disagree.
  const resumeRouterArn = routerArnForClassification(channelClassification);
  if (!resumeRouterArn) {
    console.warn('[ChannelFlow][battle] no router wired for classification; cannot resume', {
      channelClassification,
    });
    return;
  }

  // Which side is the TREATMENT slot. The turn needs it to know which arm it is; it cannot derive it,
  // because a battle state row does not say which bot is the classification's own. The default bot is
  // the control by construction (round 1 picks the alt slot as "the one that is not the default"), so
  // the same rule reproduces the assignment here rather than inventing a second one.
  const defaultBattleBotArn = await resolveBotArn(channelClassification);

  // Cost/abuse gate (SPEC-ABUSE-CONTROLS, F3): a continuation resumes bot(s) - a USER-triggered model
  // call that bypasses the Lex router (a user could drip-feed answers to waiting bots). Meter it like
  // the initial /battle, before resuming anything, at the CHANNEL's classification so the ceiling
  // matches the processor actually answering. The reject notice goes to the sender via a resuming bot.
  // No bots to resume ⇒ nothing to gate.
  const gateBotArn = resumeBotArns[0] || '';
  if (gateBotArn && !(await enforceAbuseGate(channelArn, gateBotArn, senderArn, channelClassification))) {
    return;
  }

  const bots = botRowsOnly(rows);
  await Promise.all(
    resumeBotArns.map(async (selfBotArn) => {
      const row = bots.find((r) => r.botArn === selfBotArn);

      // NOTHING ABOUT THE TURN IS DECIDED HERE ANY MORE. This used to resolve the side's live task and
      // plan a delivery option (`planBattleResume`), which was the flow answering a turn question - and
      // it dispatched the worker directly, so the resumed side carried NO variant: it answered on the
      // profile default instead of its assigned arm and archived with `experiment_id` NULL, invisible
      // to the battle rollup. The same defect was found and fixed for round 1, then round 2; this was
      // the third instance.
      //
      // The handler asks who owns the chain (ADR-024) and resolves the variant on the turn path, so
      // both go away here.
      const rivalBotArn = bots.find((r) => r.botArn !== selfBotArn)?.botArn || '';
      const correlationId = battleCorrelationId({ botArn: selfBotArn, round: 'r1c' });

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

      // THE QUESTION MESSAGE, not a placeholder (ADR-029). This side's clarifying question replaced its
      // round-1 placeholder and STAYS in the transcript; the resumed turn posts its own placeholder for
      // the answer, like every other turn, and only clears this message's `<!--battlewaiting-->` marker
      // so the frontend stops rendering the side as waiting.
      //
      // This used to be handed over as `placeholderMessageId` and answered onto, which put the finished
      // answer in the bubble from before the question was asked - up to an hour earlier, above
      // everything sent since - and made this the last caller of the processor's handed-id branch.
      // Absent on an older row: nothing to clear, and the turn is unaffected.
      const questionMsgId = row?.waitingMessageId;

      // HAND THE TURN TO THE HANDLER, exactly as round 1 does. The handler classifies, finds the
      // chain this side owns, resolves this side's variant and picks the delivery option - none of
      // which the flow may decide. It answers onto the side's EXISTING waiting message, so nothing
      // new is posted and the cleared marker stays the frontend's "waiting ended" signal.
      try {
        await invokeRouterTurn(resumeRouterArn, {
          channelArn,
          senderArn,
          userMessage: userAnswer,
          botArn: selfBotArn,
          correlationId,
          trigger: 'user',
          battleContext: {
            battleId,
            round: 1,
            totalRounds: 2,
            selfBotArn,
            rivalBotArn,
            altSlotArn: rivalBotArn === defaultBattleBotArn ? selfBotArn : rivalBotArn,
            rivalReply: undefined,
            ...(questionMsgId && { clearWaitingMarkerMessageId: questionMsgId }),
            // Original `/battle` message id is unrecoverable here; the round-2 orchestrator
            // tolerates '' (`originatingMessageId || ''`). Persisting it is a later refinement.
            originatingMessageId: '',
          },
        });
      } catch (err) {
        console.error('[ChannelFlow][battle] continuation turn invoke failed for', selfBotArn, err);
      }
    }),
  );
}

interface HandleBattleParams {
  channelArn: string;
  /** See HandleMentionParams.classification - resolved once, passed down like botArn. */
  classification: string;
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
 * 1. Classification gate — premium channels only. Non-premium gets a targeted
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
  const { channelArn, classification: channelClassification, userMessageId, content, senderArn, defaultBotArn, imageAttachment } = params;
  console.log('[ChannelFlow][battle] Detected', { channelArn, senderArn });

  // 1. Eligibility gate. Resolve classification from the immutable `classification` tag (not mutable
  //    metadata) so a tampered modelTier cannot open premium battles on a lower channel, then gate on
  //    the profile's `battleEligible` flag — the SAME source the enable path uses
  //    (`channel-battle.ts`). Hardcoding `!== 'premium'` here meant a deployment could mark a
  //    non-premium profile battle-eligible, arm Battle Mode on the enable path, and then have every
  //    `/battle` silently refused at invocation. `profileFor` falls back to the fail-closed
  //    classification, so a missing or tampered tag stays closed. Default behaviour is unchanged:
  //    premium is the only battle-eligible profile out of the box.
  if (!profiles.profileFor(channelClassification).battleEligible) {
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      "Battle Mode isn't available in this conversation. Reply normally and I'll respond as usual.",
      [senderArn],
    );
    return;
  }

  // 2. Battle-enabled check. The ChannelBattleConfig.enabled flag must be
  //    set (admin or moderator toggled Battle Mode on for this channel).
  //    Without this, the alt-bot slot isn't a channel member and there's
  //    no second-bot to fan out to.
  const battleConfig = await loadChannelBattleConfig(channelArn);
  if (battleConfig?.enabled !== true) {
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      "Battle Mode isn't enabled on this channel. Ask a moderator to flip the toggle in the members panel, then try /battle again.",
      [senderArn],
    );
    return;
  }

  // 2b. The bound experiment must still be LIVE.
  //
  //     `ChannelBattleConfig` is a SNAPSHOT taken at enable time (slot arn, experiment id, briefing).
  //     Nothing re-checked the experiment afterwards, so a channel enabled while an experiment was
  //     active kept fanning out duels indefinitely after that experiment ended - recording human picks
  //     against a completed experiment, where they can never reach a recommendation. Enabling a NEW
  //     channel correctly refused (enable auto-resolves the single ACTIVE battle experiment), so the
  //     two paths disagreed about whether battle was available.
  //
  //     Ending an experiment is how an operator stops a comparison, and it has to stop the duels too.
  if (!battleIsRunnable(battleConfig, await listExperiments())) {
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      'The experiment this channel was battling for has ended, so there is nothing left to compare. '
      + 'A moderator can turn Battle Mode off, or start a new experiment and enable it again.',
      [senderArn],
    );
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
    const nowSec = Math.floor(Date.now() / 1000);
    const activeRows = botRowsOnly(await readBattleRows(activeBattleId));
    const inFlight = activeRows.some(
      (r) =>
        (r.state === 'INVOKED' || r.state === 'WAITING_FOR_USER') &&
        (r.ttl === undefined || r.ttl > nowSec),
    );
    if (inFlight) {
      console.log('[ChannelFlow][battle] single-active-battle guard: a battle is already in flight; explained no-op', {
        channelArn,
        activeBattleId,
        attemptedBattleId: battleId,
      });
      await sendBotMessage(
        channelArn,
        defaultBotArn,
        'A battle is already in progress here. Give it a moment, then try again.',
        [senderArn],
      );
      return;
    }
  }

  // 4. List bot members of the channel.
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
    // NEVER SILENT. The router returns silence for the /battle token unconditionally, so this flow
    // is the only thing that can answer - a bare return here left the user's persisted /battle
    // answered by nothing after a transient Chime throttle. Same rule as every sibling gate in this
    // function: the person is told, targeted, best-effort.
    console.warn('[ChannelFlow][battle] ListChannelMemberships failed:', err);
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      "I couldn't start that battle just now. Please try /battle again.",
      [senderArn],
    ).catch(() => { /* the log above is the fallback record */ });
    return;
  }

  if (botMembers.length < 2) {
    console.log('[ChannelFlow][battle] <2 bot members, falling back to @all');
    await handleMentionedMessage({
      channelArn,
      classification: channelClassification,
      content,
      senderArn,
      senderName: params.senderName,
      botArn: defaultBotArn,
      broadcast: true,
      messageId: userMessageId,
    });
    return;
  }

  // Routing. A battle answers at the channel's OWN classification, not a hardwired premium one - the
  // same rule `@all` follows, and load-bearing since the eligibility gate started honouring
  // `battleEligible`: a battle-eligible standard channel routed to premium would answer with the
  // premium model, the premium guardrail and the premium `context/` S3 scope, which are IAM-enforced
  // classification boundaries. `basic` deliberately has NO upward fallback.
  //
  // It is the ROUTER's arn now, not the processor's: the turn is handed to the handler, which
  // dispatches its own worker. One routing table decides both, so the two can never disagree.
  const battleRouterArn = routerArnForClassification(channelClassification);
  if (!battleRouterArn) {
    // Deterministic and deployment-shaped (a missing router env), so silence would read as the
    // assistant being broken on EVERY /battle in this channel. Tell the person, loudly log the why.
    console.warn('[ChannelFlow][battle] no router wired for classification, cannot fan out', {
      channelClassification,
    });
    await sendBotMessage(
      channelArn,
      defaultBotArn,
      "Battle Mode isn't fully configured for this conversation's classification. Ask an operator to check the deployment.",
      [senderArn],
    ).catch(() => { /* the log above is the fallback record */ });
    return;
  }

  // Cost/abuse gate (SPEC-ABUSE-CONTROLS): a /battle fans out N model calls (one per bot) through the
  // premium processor, bypassing the Lex router's gate - the single most expensive dispatch, so it
  // MUST pass the sender's rate limit + spend budget. Gated here, after every cheap rejection (tier,
  // battle-enabled, single-active, <2-bot fallback) and BEFORE the round-1 claim/fan-out, so an
  // over-budget battle consumes no claim and spends nothing.
  //
  // The <2-bot fallback above returns before reaching this, and is gated by the ROUTER it hands off to
  // rather than here - handleMentionedMessage no longer runs a gate of its own. That is the point:
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
  if (!(await tryClaimRound1Fanout(battleId))) {
    console.log('[ChannelFlow][battle] round-1 fan-out already claimed; skipping duplicate delivery', { battleId });
    return;
  }

  console.log('[ChannelFlow][battle] Fanning out', { battleId, botCount: botMembers.length });

  // Stamp the channel→battle pointer so a later continuation reply (a
  // new message whose id can't re-derive this battleId) can resolve it.
  // Non-fatal by contract — never blocks the fan-out.
  await setActiveBattle({
    channelArn,
    battleId,
    initiatorUserSub: senderArn.split('/user/').pop() || undefined,
  });

  // The treatment slot. The turn needs it to know which SIDE of the experiment it is; it does not
  // need the flow to resolve what that side IS.
  const altSlotArn = botMembers.find((arn) => arn !== defaultBotArn) || '';

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
        initiatorUserSub: senderArn.split('/user/').pop() || undefined,
      });

      // HAND THE TURN TO THE HANDLER, exactly as `@all` does. Everything this loop used to do
      // itself - classify, resolve the image pair, resolve both variants, create the task, choose a
      // delivery option, invoke the processor - was a SECOND implementation of decisions the handler
      // already makes for every Lex turn, and a second implementation diverges silently: the duel
      // still answers, so nothing errors. That is exactly how an image duel ran as a text duel.
      //
      // What the flow still says is only what a side cannot know about itself: which duel, which
      // round, who its rival is, and which slot is the treatment. The turn decides what that side IS.
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
            altSlotArn,
            originatingMessageId: userMessageId,
            ...(imageAttachment && { imageAttachment }),
          },
        });
      } catch (err) {
        console.error('[ChannelFlow][battle] turn invoke failed for', thisBotArn, err);
        // Nothing has been posted for this side yet, so say what happened rather than leaving a
        // silent gap where an answer should be. The rival still runs; a degraded duel is visible.
        await sendBotMessage(channelArn, thisBotArn, "I couldn't start on that just now.").catch(() => {});
        return;
      }

      // Normally empty now: each side posts its own placeholder as its own bot (ADR-025), which is
      // also what puts this side's variant display name in the marker. A non-empty array means the
      // turn could not post and handed it back, so post it on that side's behalf rather than leaving
      // a gap where an answer should be.
      const placeholder = reply.messages?.[0]?.content;
      if (!placeholder) {
        console.log('[ChannelFlow][battle] side posted its own message (or was silent)', { botArn: thisBotArn });
        return;
      }
      try {
        console.log('[ChannelFlow][battle] side handed its message back; posting on its behalf', { botArn: thisBotArn });
        await sendBotMessage(channelArn, thisBotArn, placeholder);
      } catch (err) {
        console.warn('[ChannelFlow][battle] Failed to post placeholder for', thisBotArn, err);
      }
    }),
  );
}
