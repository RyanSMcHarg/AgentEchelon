/**
 * Live drift flow — shared across the per-classification agent handlers.
 *
 * This is the USER-FACING drift feature (SPEC-DRIFT-CONVERGENCE.md): when a
 * conversation's latest message has semantically drifted from the established
 * thread (pgvector cosine over Titan v2 embeddings), the assistant offers to
 * spin the tangent into its own conversation, and — if the user confirms —
 * creates the new channel. It is distinct from the async/archival drift path
 * (`analytics-aurora/kinesis-archival.ts`), which is telemetry-only.
 *
 * Drift is **conversation-level + ALL-classification (basic/standard/premium) + ON BY
 * DEFAULT** in Aurora mode — NOT premium-only. This flow is shared so the
 * router (deployed per-classification, including basic) runs the identical drift flow
 * with no `isAdvancedClassification` gate. See the handler-neutral design in
 * SPEC-DRIFT-CONVERGENCE §"runs on all AE tiers".
 *
 * Requires `analyticsMode=aurora` (pgvector + Titan). The wiring helper
 * `auroraDriftWiring` (lib/stacks/agent-classification-common.ts) VPC-attaches the
 * handler and sets DB_* + ENABLE_LIVE_DRIFT=true. In Athena mode the gate
 * (`ENABLE_LIVE_DRIFT && HAS_AURORA`) is false and this is a no-op.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ChimeSDKMessagingClient, ListChannelMessagesCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { randomUUID } from 'crypto';
// Drift's Aurora + Bedrock work runs in the VPC-attached data-plane Lambda
// (ADR-013); this flow runs in the non-VPC handler and invokes it
// via the client seam. Same signatures; only the import source changes. The
// Intent type is still sourced from drift-detection (import type => erased, so
// pg / db-client are not bundled into this non-VPC handler).
import {
  detectDrift,
  recordDriftFire,
  recordDriftOutcome,
  savePendingSuggestion,
  readPendingSuggestion,
  resolvePendingSuggestion,
} from './data-plane-client.js';
import type { Intent as DriftIntent } from '../analytics-aurora/drift-detection.js';
import { resolveScopedChannelArns } from './scoped-channels.js';
import {
  readRoutingFromSession,
  writeRoutingToSession,
  recordDecline,
  classifyConfirmDeclineReply,
} from './routing-state.js';
import { createConversationFromDrift } from './channel-creation.js';
import { isBattleEnabled } from './battle-state.js';
import { claimCorrelation } from './abuse-controls.js';
import {
  resolveConversationTypeKey,
  getConversationTypeConfig,
} from '../../../lib/config/conversation-types.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Live drift detection — feature-flagged. Set via CDK context enableLiveDrift,
// which the auroraDriftWiring helper turns into ENABLE_LIVE_DRIFT=true +
// AURORA_DATA_PLANE_ARN whenever Aurora is wired (on-by-default in Aurora mode;
// the deployer opts out). The embedding + pgvector work runs in the data-plane
// Lambda that ARN points at (ADR-013); this handler stays non-VPC.
//
// Drift requires Aurora mode. If ENABLE_LIVE_DRIFT is set but the data-plane ARN
// is not, the deployer has a misconfiguration: enableLiveDrift=true without
// analyticsMode=aurora. We log a warning at module load so it's visible in
// CloudWatch even before the first drift attempt; runtime drift calls just skip
// the signal (no crash).
const ENABLE_LIVE_DRIFT = process.env.ENABLE_LIVE_DRIFT === 'true';
const HAS_AURORA = !!process.env.AURORA_DATA_PLANE_ARN;
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';

if (ENABLE_LIVE_DRIFT && !HAS_AURORA) {
  console.warn(
    '[Drift][config] ENABLE_LIVE_DRIFT=true but AURORA_DATA_PLANE_ARN is unset. Live drift requires Aurora mode '
      + '(deploy with --context analyticsMode=aurora). Drift will be skipped every turn until this is fixed.',
  );
}

const ssmClient = new SSMClient({ region: AWS_REGION });
const messagingClient = new ChimeSDKMessagingClient({ region: AWS_REGION });

async function getSsmValue(paramName: string): Promise<string | null> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
    return resp.Parameter?.Value || null;
  } catch (err) {
    console.warn(`[Drift] SSM lookup failed for ${paramName}:`, err);
    return null;
  }
}

/** Minimal shape of the Lex fulfillment event the drift flow reads. The shared
 *  router-agent-handler event (every classification) satisfies it. */
export interface LiveDriftEvent {
  inputTranscript?: string;
  sessionState: {
    intent: { name: string; state?: string };
    sessionAttributes?: Record<string, string>;
  };
  requestAttributes?: Record<string, string>;
}

export interface LiveDriftFlowInput {
  /** The Lex event. The decline path MUTATES `sessionState.sessionAttributes`
   *  (to persist `declinedDistances`) so the caller's normal-flow fall-through
   *  response carries the recorded decline. */
  event: LiveDriftEvent;
  channelArn: string;
  userMessage: string;
  userSub: string;
  classification: 'basic' | 'standard' | 'premium';
  botArn: string;
  /** The classified intent (IntentType value). Uppercased for detectDrift. */
  intent: string;
  /**
   * Explicit conversation-type key for this channel (from metadata/tag), if the
   * caller has it. Drift on/off is a property of the conversation TYPE, not the
   * classification (lib/config/conversation-types.ts). Omitted ⇒ the type defaults to the
   * classification, so behavior is unchanged for un-migrated channels.
   */
  conversationType?: string;
  /**
   * True when a LIVE task (pending/in_progress) exists for this user in this channel. The
   * caller already resolves this for task continuation, so it is passed in rather than
   * re-read here (no extra DynamoDB round-trip on the reply path).
   *
   * Suppresses the cosine signal only - see `DetectDriftInput.activeTaskInProgress`. The
   * pending-suggestion branch below is NOT gated on it: a user answering an outstanding
   * yes/no must always be honoured.
   */
  activeTaskInProgress?: boolean;
}

/** A short-circuit response from the drift flow — the caller turns this into a
 *  Lex response (`formatLexResponse(event, messages, sessionAttributes)`) and
 *  returns immediately. `null` means "no drift action — continue normal flow"
 *  (the event's sessionAttributes may have been mutated by a decline). */
export interface LiveDriftResponse {
  messages: Array<{ contentType: string; content: string }>;
  sessionAttributes: Record<string, string>;
}

/**
 * Run the live drift flow for one user turn. Returns a {@link LiveDriftResponse}
 * to short-circuit (drift suggestion emitted, or a pending suggestion confirmed/
 * navigated) or `null` to fall through to the normal agent flow.
 *
 * Three branches (matching the original inline router logic):
 *  (a) Pending drift suggestion in session — user is replying yes/no
 *  (b) No pending (or just declined) — run detectDrift; if it fires, emit a suggestion
 *  (c) No pending and no drift — return null (caller continues)
 *
 * Gated on ENABLE_LIVE_DRIFT + HAS_AURORA + a real channel. Runs on ALL classifications (no
 * isAdvancedClassification gate).
 *
 * In a battle-enabled channel detection runs NORMALLY and only the ACTION changes: a fired drift
 * explains that the duel is still running and that the conversation cannot be split until it finishes
 * or Battle Mode is turned off, and records nothing. This replaced a blanket gate that returned null
 * before detecting anything, which left a user who pivoted mid-duel with no suggestion and no reason
 * for its absence.
 */
// Structural reasons drift never ran, already reported by this container. Drift exiting at a gate
// is INVISIBLE otherwise: the flow returns null and the turn proceeds normally, so an inert drift
// feature looks identical to "no drift this turn" in the handler logs. (Live-verified: drift was
// skipping every turn and the handler log groups contained no drift line at all, which made it look
// like the feature was switched off.) These reasons are constant for the life of a container, so
// log each ONCE rather than per turn - enough to diagnose, no per-request noise.
const reportedGateExits = new Set<string>();
/**
 * A short, human topic for a drift-spawned conversation, derived from the message that caused the drift.
 *
 * The previous behaviour was the fixed string 'Drift Follow-up', which made every drift conversation
 * indistinguishable in the sidebar and gave the welcome nothing real to name. This takes the first clause
 * of what the person actually said, which is the closest thing to a title available without a model call
 * on a path that is meant to be instant.
 *
 * Falls back to the old label when there is no text, so a conversation is never left unnamed.
 */
export function driftTopicLabel(originatingMessageText?: string): string {
  const raw = (originatingMessageText || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Drift Follow-up';

  // Drop a leading conversational preamble so the label is the SUBJECT rather than the request. "let's start
  // a new conversation about quarterly revenue forecasting" should title a conversation "quarterly revenue
  // forecasting", not repeat the whole sentence back.
  const subject = raw.replace(
    /^(?:ok(?:ay)?[,\s]+)?(?:so[,\s]+)?(?:let'?s|let us|can we|could we|i(?:'d| would) like to|i want to)\s+(?:please\s+)?(?:start|open|create|have|switch to|move to|talk about|discuss|chat about)?\s*(?:a\s+)?(?:new\s+)?(?:conversation|thread|chat|discussion)?\s*(?:about|on|regarding|re)?\s*/i,
    '',
  ).trim() || raw;

  // First clause, so a long message does not become a long channel name.
  const clause = subject.split(/[.!?;\n]/)[0].trim() || subject;
  if (clause.length <= 64) return clause;
  // Truncate on a WORD boundary. Slicing mid-word produced labels like "…revenue forecasti", which reads as
  // a bug to anyone who sees it in the sidebar.
  const cut = clause.slice(0, 64);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim() || 'Drift Follow-up';
}

/**
 * The MessageId of the message that triggered drift.
 *
 * `CHIME.message.id` is read first, but Chime does not send it. Measured live across every classification:
 * the request attributes are exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
 * `x-amz-lex:channels:platform` (WelcomeIntent omits the sender). The id therefore cannot be passed through
 * Lex and has to be read back from the channel. The attribute read stays for synthetic events that supply one.
 *
 * IDENTIFIED BY CONTENT, not by recency. "The sender's newest message" would usually be the triggering
 * message and is not the same claim: a second message sent while this turn is in flight would make it anchor
 * to the wrong one, and a link that points at the wrong message is worse than no link because it still looks
 * live. The exact transcript of the message being handled is in hand here, so the match is on that text
 * (newest first, so a repeated phrase still resolves to the current send). No match returns nothing.
 *
 * Why a lookup rather than plumbing the id in. The channel flow does receive `MessageId` on every message,
 * which makes "pass it through" sound obvious, but neither form of that is better here. Having the flow set a
 * message attribute assumes Chime forwards a flow-set attribute into Lex request attributes, which is not
 * established and would need its own live probe (`CHIME.mentions` arrives that way, but Chime sets that one
 * itself, and this codebase's flow callback sends only `MessageId`/`Content`/`Metadata`). Having the flow
 * persist the id somewhere the router reads is a write on EVERY message to serve a read that happens only
 * when drift fires. This lookup is one call, on that rare turn, in the one place that needs it.
 *
 * Returns '' on any failure. An absent id degrades the welcome's link from message-anchored to
 * conversation-level, which is the pre-existing behaviour and not worth failing a turn over.
 */
export async function resolveOriginatingMessageId(args: {
  event: LiveDriftEvent;
  channelArn: string;
  senderArn: string;
  botArn: string;
  /** The exact text of the message being handled. This is what makes the match identifying. */
  userMessage: string;
}): Promise<string> {
  const fromAttribute = args.event.requestAttributes?.['CHIME.message.id'] || '';
  if (fromAttribute) return fromAttribute;
  if (!args.channelArn || !args.senderArn || !args.botArn || !args.userMessage.trim()) return '';

  const wanted = args.userMessage.trim();
  try {
    const resp = await messagingClient.send(new ListChannelMessagesCommand({
      ChannelArn: args.channelArn,
      ChimeBearer: args.botArn,
      SortOrder: 'DESCENDING',
      MaxResults: 20,
    }));
    // Newest first, so the first CONTENT match is the message being handled even if the same text was sent
    // more than once. Chime may store content URI-encoded, so compare both forms.
    for (const m of resp.ChannelMessages || []) {
      if (m.Sender?.Arn !== args.senderArn) continue;
      const raw = (m.Content || '').trim();
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw).trim();
      } catch { /* not encoded */ }
      if (raw === wanted || decoded === wanted) return m.MessageId || '';
    }
    // No content match: the message is not in the window, or its stored form differs from the transcript.
    // Return nothing rather than the newest message from this sender - anchoring to the WRONG message is
    // worse than not anchoring, because the link still looks live.
    console.warn('[Drift] the triggering message was not found in the recent window; the welcome will link '
      + 'to the conversation rather than the message');
    return '';
  } catch (err) {
    console.warn('[Drift] could not resolve the originating MessageId; the welcome will link to the '
      + 'conversation rather than the message:', (err as Error).name);
    return '';
  }
}

function logGateExit(reason: string): void {
  if (reportedGateExits.has(reason)) return;
  reportedGateExits.add(reason);
  console.log(`[Drift] live drift not running for this container: ${reason}`);
}

export async function runLiveDriftFlow(input: LiveDriftFlowInput): Promise<LiveDriftResponse | null> {
  const { event, channelArn, userMessage, userSub, classification, botArn, intent } = input;

  // Infra gate: the Aurora hookup must be wired (auroraDriftWiring sets these).
  if (!ENABLE_LIVE_DRIFT || !HAS_AURORA || !channelArn) {
    logGateExit(!ENABLE_LIVE_DRIFT ? 'flag_off' : !HAS_AURORA ? 'no_aurora' : 'no_channel');
    return null;
  }

  // Policy gate: drift on/off is a property of the CONVERSATION TYPE, not the
  // classification. Resolve the type (explicit metadata type if present, else the classification)
  // and consult the registry. Today every shipped type has drift on, so this
  // is a no-op until a deployer turns it off for a type or adds a drift-off
  // type — at which point no handler code changes.
  const typeKey = resolveConversationTypeKey({ explicitType: input.conversationType, classification });
  const typeConfig = getConversationTypeConfig(typeKey);
  if (!typeConfig.driftEnabled) {
    logGateExit(`type_disabled:${typeKey}`);
    return null;
  }

  // A BATTLE BLOCKS THE ACTION, NOT THE DETECTION (owner, 2026-08-13).
  //
  // This used to return null the moment the channel had Battle Mode on, which is why a user who
  // pivoted mid-duel got nothing at all: no suggestion, and no reason for its absence. Silence reads
  // as the product ignoring them, and they retype the pivot.
  //
  // Detection now runs exactly as it does anywhere else - a battle turn is an ordinary turn - and the
  // battle changes only what happens WHEN drift fires: the user is told the duel is still running and
  // that they cannot split this conversation until it finishes or Battle Mode is turned off. Splitting
  // mid-battle would strand a duel whose sides are mid-round in a conversation the user has left.
  //
  // The flag is read once here and threaded down, so detection and the two branches below agree about
  // it within a turn even if a moderator toggles Battle Mode while the turn is in flight.
  const battleActive = await isBattleEnabled(channelArn);

  const driftIntent = intent.toUpperCase() as DriftIntent;
  const routing = readRoutingFromSession(event.sessionState.sessionAttributes);

  // Resolve the in-flight suggestion. The Lex session is the fast path, but it
  // can be lost or the turn misrouted (a short "yes"/"no" that Lex tags as a
  // different intent). So when the session carries no pending AND this turn looks
  // like a yes/no reply, fall back to the durable task in Aurora
  // (conversation_creation_tasks) — the authoritative record opened at detect.
  // Gated on a non-ambiguous reply so a normal message never costs a data-plane
  // round-trip. See docs SPEC-DRIFT-CONVERGENCE.md "Live-Suggestion Flow".
  let pending = routing.pendingDriftSuggestion;
  if (!pending && classifyConfirmDeclineReply(userMessage) !== 'ambiguous') {
    const durable = await readPendingSuggestion({ userSub, channelArn });
    if (durable) {
      pending = {
        taskId: durable.taskId,
        channelArn: durable.channelArn,
        userSub: durable.userSub,
        kind: durable.kind,
        rivalConversationArn: durable.rivalConversationArn,
        originatingMessageId: durable.originatingMessageId,
        cosineDistance: durable.cosineDistance,
        correlationId: durable.correlationId,
        createdAt: durable.createdAt,
      };
    }
  }

  // Branch (a): in-flight pending suggestion (from session or the durable task)
  if (pending) {
    const reply = classifyConfirmDeclineReply(userMessage);

    // A suggestion can outlive the condition it was made under: Battle Mode may be enabled between the
    // offer and the answer. Accepting it now would create the new conversation and walk the user out of
    // a duel in progress, so the acceptance is held rather than honoured. The pending suggestion is
    // left in place deliberately - it is still a good idea, just not yet - so a "yes" after the battle
    // ends still works without the user re-triggering drift.
    if (reply === 'affirmative' && battleActive) {
      logGateExit('battle_active_confirm_held');
      return {
        messages: [{
          contentType: 'PlainText',
          content:
            "I can't split that off yet - a battle is still running in this conversation. Tell me again "
            + 'once it finishes, or ask a moderator to turn Battle Mode off, and I will move it across.',
        }],
        // The pending suggestion stays in session: it is still valid, just not actionable yet.
        sessionAttributes: event.sessionState.sessionAttributes || {},
      };
    }

    if (reply === 'affirmative') {
      // User confirmed. Create the new channel or navigate.
      try {
        if (pending.kind === 'confirm') {
          const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
          const channelFlowArn = CHANNEL_FLOW_ARN_PARAM
            ? await getSsmValue(CHANNEL_FLOW_ARN_PARAM)
            : undefined;
          const created = await createConversationFromDrift({
            appInstanceArn: APP_INSTANCE_ARN,
            botArn,
            userArn: senderArn,
            // The spawned channel inherits the conversation type's security
            // classification (== the parent's classification today). IAM Layer-1 gates
            // the new channel on this tag, so it must match what the user can
            // reach.
            modelTier: typeConfig.classification,
            modelId: '',
            modelName: '',
            // The topic derives from what the person actually said, not a fixed string. 'Drift Follow-up'
            // was a placeholder that made every drift conversation look identical in the sidebar and gave
            // the welcome nothing real to name.
            topicLabel: driftTopicLabel(pending.originatingMessageText),
            channelFlowArn: channelFlowArn || undefined,
            parentChannelArn: channelArn,
            originatingMessageId: pending.originatingMessageId,
            // Their own words, quoted back in the new conversation's welcome.
            originatingMessageText: pending.originatingMessageText,
          });
          if (pending.driftEventId) {
            await recordDriftOutcome({
              eventId: pending.driftEventId,
              outcome: 'accepted',
              newChannelArn: created.channelArn,
            }).catch(() => undefined);
          }
          await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'confirmed' }).catch(() => undefined);
          const newSession = writeRoutingToSession(
            event.sessionState.sessionAttributes || {},
            { ...routing, pendingDriftSuggestion: undefined },
          );
          return {
            messages: [{
              contentType: 'PlainText',
              content: `Done — I've created a new conversation. NAVIGATE_CHANNEL:${created.channelArn}|Drift Follow-up`,
            }],
            sessionAttributes: newSession,
          };
        }

        if (pending.kind === 'redirect' && pending.rivalConversationArn) {
          if (pending.driftEventId) {
            await recordDriftOutcome({
              eventId: pending.driftEventId,
              outcome: 'accepted',
              newChannelArn: pending.rivalConversationArn,
            }).catch(() => undefined);
          }
          await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'confirmed' }).catch(() => undefined);
          const newSession = writeRoutingToSession(
            event.sessionState.sessionAttributes || {},
            { ...routing, pendingDriftSuggestion: undefined },
          );
          return {
            messages: [{
              contentType: 'PlainText',
              content: `Taking you there. NAVIGATE_CHANNEL:${pending.rivalConversationArn}|Existing conversation`,
            }],
            sessionAttributes: newSession,
          };
        }
      } catch (err) {
        console.error('[Drift] Failed to act on confirmation:', err);
        // Fall through to normal agent flow rather than blocking the user
      }
    }

    if (reply === 'negative') {
      // Record the decline and fall through to normal agent flow.
      if (pending.driftEventId) {
        await recordDriftOutcome({ eventId: pending.driftEventId, outcome: 'declined' }).catch(() => undefined);
      }
      await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'declined' }).catch(() => undefined);
      const updatedRouting = pending.cosineDistance != null
        ? recordDecline(routing, pending.cosineDistance)
        : { ...routing, pendingDriftSuggestion: undefined };
      // Mutate the event so the caller's normal-flow response carries the decline.
      event.sessionState.sessionAttributes = writeRoutingToSession(
        event.sessionState.sessionAttributes || {},
        updatedRouting,
      );
      // Fall through to normal agent flow with the decline recorded.
    }

    // 'ambiguous' or fallthrough from negative → carry on with the user's
    // original message via the normal agent flow. The pending suggestion stays
    // in routing state for one more turn; if the next reply is still ambiguous,
    // detectDrift below will re-evaluate.
  }

  // Branch (b): no pending, or pending was just declined — run detectDrift
  if (!pending || classifyConfirmDeclineReply(userMessage) === 'negative') {
    // ADR-012 scoping, resolved HERE and passed in.
    //
    // A related conversation may only be suggested if EVERY current human member of this one already
    // has access to it, and the only authoritative answer to that is Amazon Chime SDK Messaging's own
    // membership — asked directly, rather than reconstructed from the Aurora archive, which the
    // Kinesis path fills asynchronously and which is therefore missing exactly the member who just
    // joined.
    //
    // It also has to happen on this side of the VPC boundary: `detectDrift` executes in the
    // data-plane Lambda, in isolated subnets with no Chime endpoint and no NAT, where this call would
    // hang until the timeout rather than fail.
    const scopedChannelArns = await resolveScopedChannelArns({
      currentChannelArn: channelArn,
      bearerArn: input.botArn,
      client: messagingClient,
    });

    const driftResult = await detectDrift({
      channelArn,
      messageId: event.requestAttributes?.['CHIME.message.id'] || randomUUID(),
      latestMessage: userMessage,
      intent: driftIntent,
      userClearance: classification,
      declinedDistances: routing.declinedDistances,
      activeTaskInProgress: input.activeTaskInProgress,
      scopedChannelArns,
      // Same value as `userClearance` above, and deliberately a separate field: that one is an
      // optional metric dimension, this one selects the database reader role both summary-embedding
      // reads run as (ADR-028). A boundary cannot ride on a field that is allowed to be absent.
      classification,
    });

    // DRIFT FIRED DURING A DUEL: say so, and offer nothing.
    //
    // The user has changed the subject while two assistants are mid-comparison. Acting on that would
    // move them into a new conversation and leave the duel behind, so the answer is not a suggestion
    // but an explanation with the two ways out - let it finish, or turn Battle Mode off. Nothing is
    // recorded: no drift row, no durable task, no session pending. There is no offer to accept or
    // decline, so an outcome would be a fiction, and the next turn re-detects if they persist.
    if (driftResult.isDrift && battleActive) {
      logGateExit('battle_active_drift_reported');
      return {
        messages: [{
          contentType: 'PlainText',
          content:
            "That's a different topic, and I can't move it into its own conversation while a battle "
            + 'is running here - the assistants are still comparing answers. Once the battle finishes '
            + '(or a moderator turns Battle Mode off) ask me again and I will split it out. For now, '
            + 'go ahead and I will answer it here.',
        }],
        sessionAttributes: event.sessionState.sessionAttributes || {},
      };
    }

    if (driftResult.isDrift && driftResult.suggestionTemplate) {
      // Resolved ONCE, BEFORE the fire is recorded, and reused by the drift row, the durable task and
      // the session copy - so a lookup is not paid twice and the three cannot disagree about which
      // message started this.
      //
      // The drift row previously took `CHIME.message.id` directly, which this module's own comment
      // (see resolveOriginatingMessageId) records that Chime never sends. Every live row therefore
      // stored an empty originating_message_id, and the evaluation pass selects offers with
      // `JOIN messages m ON m.message_id = d.originating_message_id` - a join an empty id can never
      // satisfy. No live offer was ever judged, so evaluated_count stayed 0 and the admin Accuracy
      // tile read "Not measured" permanently, looking like an unimplemented feature rather than a
      // broken write.
      const originatingMessageId = await resolveOriginatingMessageId({
        event,
        channelArn,
        senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
        botArn,
        userMessage,
      });

      // CLAIM BEFORE POSTING, because the router's duplicate guard is too late to help here.
      //
      // The router collapses a duplicate fulfillment of the same turn with a correlation claim -
      // but that runs at router-agent-handler.ts:1709, roughly 200 lines AFTER this flow has already
      // posted its suggestion. So a second invocation posts a SECOND suggestion and only then
      // discovers it was a duplicate and returns idempotently. The ANSWER is protected by that
      // claim; the suggestion is not, because it has already gone out.
      //
      // Measured 2026-08-12 on a live group @all: two identical suggestions 1.8s apart, distinct
      // MessageIds, neither carrying a corr marker - this path posts DIRECTLY rather than as a
      // placeholder-then-update, which is why the placeholder guards do not cover it either.
      //
      // Keyed on originatingMessageId, resolved just above: the same stable per-turn property the
      // answer already dedups on, and one a redelivery replays identically. A random or time-derived
      // key would let each attempt claim its own and defeat the guard - the exact failure mode
      // lib/correlation.ts documents for the placeholder path.
      //
      // FAILS OPEN by contract: claimCorrelation returns true when the dedup table is unset or
      // errors, so a claim outage degrades to today's behaviour rather than silently suppressing a
      // legitimate suggestion. Losing a DUPLICATE suggestion is the intended outcome; losing a real
      // one is not.
      //
      // AN UNRESOLVED ID MUST NOT BE CLAIMED. `resolveOriginatingMessageId` returns '' on three
      // documented paths (no sender or channel, the message outside the 20-message window, a Chime
      // call that failed), and the key was then the literal `drift-suggest-` - one constant shared by
      // every channel and every user. The first turn to hit it claimed it, and for the claim's TTL
      // every other unresolved suggestion anywhere on the deployment was read as a duplicate and
      // dropped. A guard that suppresses the thing it protects is worse than no guard, so an
      // unresolved id skips the claim and accepts the (rare, already-rare) duplicate instead.
      if (
        originatingMessageId
        && !(await claimCorrelation(`drift-suggest-${originatingMessageId}`))
      ) {
        console.log('[Drift] suggestion already posted for this turn; skipping the duplicate', {
          channelArn,
          originatingMessageId,
        });
        return null;
      }
      if (!originatingMessageId) {
        console.warn(
          '[Drift] originating message unresolved; posting without the duplicate claim rather than '
            + 'claiming a key shared with every other unresolved turn',
          { channelArn },
        );
      }

      // Record the fire and persist pending state for the next turn.
      let driftEventId: string | undefined;
      try {
        driftEventId = await recordDriftFire({
          result: driftResult,
          channelArn,
          messageId: originatingMessageId,
          userSub,
          intent: driftIntent,
          // A suggestion is about to be shown to this user, so this row is an OFFER and is the
          // only kind the acceptance rate may count. See migration 016.
          source: 'live',
        });
      } catch (err) {
        console.warn('[Drift] recordDriftFire failed:', err);
      }

      let savedTaskId = '';
      try {
        const saved = await savePendingSuggestion({
          channelArn,
          userSub,
          kind: driftResult.suggestedAction === 'redirect' ? 'redirect' : 'confirm',
          rivalConversationArn: driftResult.rivalConversationArn,
          originatingMessageId,
          cosineDistance: Number.isFinite(driftResult.driftScore) ? driftResult.driftScore : undefined,
          correlationId: driftResult.correlationId,
        });
        savedTaskId = saved.taskId;
      } catch (err) {
        console.warn('[Drift] savePendingSuggestion failed:', err);
      }

      const newSession = writeRoutingToSession(
        event.sessionState.sessionAttributes || {},
        {
          ...routing,
          pendingDriftSuggestion: {
            taskId: savedTaskId,
            channelArn,
            userSub,
            kind: driftResult.suggestedAction === 'redirect' ? 'redirect' : 'confirm',
            rivalConversationArn: driftResult.rivalConversationArn,
            originatingMessageId,
            // The person's own words, so the new conversation can quote them back (see PendingSuggestion).
            originatingMessageText: userMessage,
            cosineDistance: Number.isFinite(driftResult.driftScore) ? driftResult.driftScore : undefined,
            correlationId: driftResult.correlationId,
            driftEventId,
            createdAt: new Date().toISOString(),
          },
        },
      );

      // A fired suggestion SHORT-CIRCUITS the turn: the agent flow never runs, so the turn is
      // answered without the conversation history and without the model. That is by design, but it
      // was invisible - this path logged nothing on success, while the router logs its delivery
      // decision only AFTER the drift check returns. A turn interrupted here therefore left a log
      // trace identical to a turn that failed to dispatch, and a "the assistant forgot the previous
      // turn" report could not be told apart from "drift answered instead". Log the interception.
      console.log('[Drift] suggestion fired, short-circuiting the turn', {
        intent: driftIntent,
        suggestedAction: driftResult.suggestedAction,
        driftScore: Number.isFinite(driftResult.driftScore) ? driftResult.driftScore : undefined,
        driftEventId,
      });

      return {
        messages: [{
          contentType: 'PlainText',
          content: driftResult.suggestionTemplate,
        }],
        sessionAttributes: newSession,
      };
    }
  }

  // Branch (c): no drift action — continue normal flow.
  return null;
}
