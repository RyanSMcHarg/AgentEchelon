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
 * SPEC-DRIFT-CONVERGENCE, Overview (drift is enabled in every shipped conversation type).
 *
 * Requires `analyticsMode=aurora` (pgvector + Titan). The wiring helper
 * `auroraDriftWiring` (lib/stacks/agent-classification-common.ts) VPC-attaches the
 * handler and sets DB_* + ENABLE_LIVE_DRIFT=true. In Athena mode the gate
 * (`ENABLE_LIVE_DRIFT && HAS_AURORA`) is false and this is a no-op.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { templateLine, type VersionWords } from './message-lines.js';
import { ChimeSDKMessagingClient, GetChannelMessageCommand } from '@aws-sdk/client-chime-sdk-messaging';
import type { Classification } from '../../../lib/config/model-strategy.js';
// Drift's Aurora + Bedrock work runs in the VPC-attached data-plane Lambda
// (ADR-013); this flow runs in the non-VPC handler and invokes it
// via the client seam. Same signatures; only the import source changes. The
// Intent type is still sourced from drift-detection (import type => erased, so
// pg / db-client are not bundled into this non-VPC handler).
import {
  detectDrift,
  resolveDriftRival,
  recordDriftFire,
  recordDriftOutcome,
  savePendingSuggestion,
  readPendingSuggestion,
  resolvePendingSuggestion,
  adoptOfferedTopic,
  seedDriftTopicSummary,
} from './data-plane-client.js';
import type { Intent as DriftIntent } from '../analytics-aurora/drift-detection.js';
import { resolveScopedChannelArns } from './scoped-channels.js';
import { findInboundMessage, type InboundMessage } from './inbound-message.js';
import { withTurnDeclaration } from './turn-declaration.js';
import { classifyConfirmDeclineReply } from './routing-state.js';
import { createConversationFromDrift } from './channel-creation.js';
import { resolveServiceAdminBearer } from './service-admin-bearer.js';
import { getChannelContext } from './channel-context-client.js';
import { resolveActiveBattle, readBattleRows, duelIsLive } from './battle-state.js';
import { claimCorrelation } from './abuse-controls.js';
import {
  resolveConversationTypeKey,
  getConversationTypeConfig,
} from '../../../lib/config/conversation-types.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { chimeMessagingClient } from './chime/clients.js';

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

const ssmClient = sessionClient(SSMClient, { region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });
// ROUTING READS: drift scoping asks which conversations this one's members share, as the router
// deciding where work goes, so it stays on the router's own role rather than the assistant's session.
const messagingClient = chimeMessagingClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });

async function getSsmValue(paramName: string): Promise<string | null> {
  try {
    const resp = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
    return resp.Parameter?.Value || null;
  } catch (err) {
    console.warn(`[Drift] SSM lookup failed for ${paramName}:`, err);
    return null;
  }
}

/**
 * What the drift flow reads from the turn's event: the sender, and the transcript fields a caller may
 * carry. The router's event satisfies it on either way in.
 *
 * NO SESSION STATE, deliberately. Nothing this flow needs lives in the Amazon Lex session: the open
 * offer is read from Aurora and a declined topic is kept as a topic of the conversation. A turn the
 * channel flow answers has no Lex session at all, and drift has to behave identically on it.
 */
export interface LiveDriftEvent {
  inputTranscript?: string;
  requestAttributes?: Record<string, string>;
}

export interface LiveDriftFlowInput {
  event: LiveDriftEvent;
  /** What this assistant's lines are worded from (ADR-062): its version's copy and the stored templates. */
  words?: VersionWords;
  channelArn: string;
  userMessage: string;
  personId: string;
  /**
   * THE SHARED TYPE, not a restatement of it. This was spelled out as a literal triple and went
   * stale the moment a fourth profile was added - the compiler caught it here, at the one call site
   * that passes a classification straight through to channel creation, where a narrowed type would
   * have meant a whole profile could never spawn a drift conversation. Referencing the catalog's own
   * union means the next profile is a config change and nothing more.
   */
  classification: Classification;
  botArn: string;
  /**
   * THE TURN'S ONE RESOLUTION OF WHICH MESSAGE IT IS ANSWERING, when the caller already has a memo
   * for it.
   *
   * The router now keeps one, defined before this check runs. Without this the router and this flow
   * resolved the SAME fact independently, so a turn that drifted and then opened a task paid two
   * `ListChannelMessages` in one invocation.
   *
   * OPTIONAL, and the fallback is the direct call this used to make - a caller that has no memo is
   * exactly as it was, which is what keeps a synthetic or test caller working unchanged.
   */
  resolveInbound?: () => Promise<{ messageId: string; targeted?: boolean; createdAt?: string }>;
  /**
   * Told what this turn's subject comparison decided, whenever detection ran. The router carries it to
   * the turn's analytics record, so each turn records whether it stayed on a subject the conversation
   * has or raised a new one, at no cost beyond the comparison already made.
   */
  onDecision?: (decision: TurnSubjectDecision) => void;
  /**
   * Told the question an offer held when the person declines it. The offer replaced that question's
   * answer, so the declining turn must answer it; the router carries it to the
   * assistant, which answers it before anything else the reply asks.
   */
  onHeldQuestion?: (held: HeldQuestion) => void;
  /** The classified intent (IntentType value). Uppercased for detectDrift. */
  intent: string;
  /**
   * Explicit conversation-type key for this channel, if the caller has it. Drift on/off is a property of
   * the conversation TYPE, not the classification (lib/config/conversation-types.ts). Omitted ⇒ the stamp
   * in the channel-context store, and with no registered stamp, the ordinary type (`general`).
   */
  conversationType?: string;
  /**
   * True when a LIVE task (pending/in_progress) exists in this channel, whichever principal holds it.
   * The caller already resolves this for task continuation, so it is passed in rather than re-read
   * here (no extra DynamoDB round-trip on the reply path).
   *
   * NOT owner-scoped, deliberately: ownership only moves to the person at an `awaits` boundary, so
   * keying on it made the suppression depend on every state remembering to declare that flag, and a
   * state that did not silently lost drift protection. See `DetectDriftInput.activeTaskInProgress`.
   *
   * Suppresses the cosine signal only. The open-offer branch below is NOT gated on it: a person
   * answering an outstanding offer must always be honored.
   */
  activeTaskInProgress?: boolean;
  /**
   * Which evidence the caller used, for the skip counter only - 'live' work, or work that ENDED here
   * within the deployment's recently-ended window. Never read to make a decision here or downstream.
   */
  taskSignal?: 'live' | 'recently_ended';
}

/** A short-circuit response from the drift flow: the caller returns these messages as the turn's reply
 *  and stops. `null` means "no drift action - continue the normal flow". */
export interface LiveDriftResponse {
  messages: Array<{ contentType: string; content: string }>;
}

/**
 * Run the live drift flow for one user turn. Returns a {@link LiveDriftResponse}
 * to short-circuit (drift suggestion emitted, or a pending suggestion confirmed/
 * navigated) or `null` to fall through to the normal agent flow.
 *
 * Three branches:
 *  (a) An offer is open (read from Aurora) - a yes acts on it; anything else keeps the subject here,
 *      which declines the offer, adopts the subject as a topic of this conversation, and answers the
 *      turn without detecting on it
 *  (b) No offer open - run detectDrift; if it fires, make an offer
 *  (c) No offer and no drift - return null (caller continues)
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
 * The previous behavior was the fixed string 'Drift Follow-up', which made every drift conversation
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
 * message attribute assumes Chime forwards a flow-set attribute into Lex request attributes, and it does not:
 * the three below are all a turn ever carries. `CHIME.mentions` is sometimes cited as proof that it can,
 * which is a conflation - that is a MESSAGE attribute the channel flow reads off the message itself, and it
 * appears zero times in the Lex logs. This codebase's flow callback sends only `MessageId`/`Content`/
 * `Metadata` in any case. Having the flow
 * persist the id somewhere the router reads is a write on EVERY message to serve a read that happens only
 * when drift fires. This lookup is one call, on that rare turn, in the one place that needs it.
 *
 * Returns '' on any failure. An absent id degrades the welcome's link from message-anchored to
 * conversation-level, which is the pre-existing behavior and not worth failing a turn over.
 */
export async function resolveOriginatingMessageId(args: {
  event: LiveDriftEvent;
  channelArn: string;
  senderArn: string;
  botArn: string;
  /** The exact text of the message being handled. This is what makes the match identifying. */
  userMessage: string;
}): Promise<string> {
  return (await resolveOriginatingMessage(args)).messageId;
}

/**
 * The message this turn is answering, AND whether it was addressed privately.
 *
 * The Lex attribute first, then the channel read (`findInboundMessage`, which owns the match and the
 * rules about what `targeted` may claim). The attribute is checked HERE rather than there because it
 * is a fact about how this turn arrived, and only a Lex-shaped caller has one.
 */
export async function resolveOriginatingMessage(args: {
  event: LiveDriftEvent;
  channelArn: string;
  senderArn: string;
  botArn: string;
  /** The exact text of the message being handled. This is what makes the match identifying. */
  userMessage: string;
}): Promise<InboundMessage> {
  // Kept because it costs nothing and this is the one place that would benefit if it ever arrived - but
  // it never does. Amazon Chime SDK sends Lex exactly `CHIME.channel.arn`, `CHIME.sender.arn` and
  // `x-amz-lex:channels:platform`. An id from here carries NO addressing with it, so `targeted` stays
  // unset rather than being guessed about a message this never read.
  //
  // RE-MEASURED 2026-09-10, AND THE INSTRUMENT IS PERMANENT. Lex text conversation logs are enabled on
  // every assistant's bot alias (`assistant-provisioner.ts`; the provisioner's `AssistantLexConversationLogs`)
  // and record `requestAttributes` verbatim. Across fourteen days on all three classifications,
  // `CHIME.message.id` occurs zero times. `sessionId` is not a substitute either: it is stable per
  // CONVERSATION, three turns in one channel sharing one value, so it names the room and not the
  // message.
  //
  // Worth stating because this line was deleted once on the belief that the attribute does arrive, and
  // the belief came from another comment rather than from a measurement.
  const fromAttribute = args.event.requestAttributes?.['CHIME.message.id'] || '';
  if (fromAttribute) return { messageId: fromAttribute };
  // A CARRIED TURN RECONSTRUCTS NOTHING (ADR-043). The channel flow declares the message a turn it
  // dispatches is answering (`AE.message.id`) and whether it was sent privately (`AE.turn.targeted`).
  // Matching text against the channel would find nothing here anyway: the flow strips its address
  // token before dispatch, so the stored content never equals the turn's text. The declaration is the
  // answer, and the channel read is paid only by a turn Amazon Lex invoked natively.
  const declaredId = args.event.requestAttributes?.['AE.message.id'] || '';
  if (declaredId) {
    const targeted = args.event.requestAttributes?.['AE.turn.targeted'];
    return { messageId: declaredId, ...(targeted === '1' ? { targeted: true } : targeted === '0' ? { targeted: false } : {}) };
  }
  return findInboundMessage(args);
}

/**
 * The text of the message that caused an offer, read back BY REFERENCE when the offer is accepted.
 *
 * The new conversation's name and welcome quote the person's own words. The offer stores only the
 * message id (by-reference telemetry: no drift record holds message text), so the words are read from
 * Amazon Chime SDK, the authority on what the conversation says, at the one moment they are needed.
 * This used to ride the Amazon Lex session, which a turn the channel flow answers does not have.
 *
 * Returns undefined on any failure: the conversation is still created, under the generic label.
 */
export async function readOriginatingMessageText(args: {
  channelArn: string;
  messageId: string;
  botArn: string;
}): Promise<string | undefined> {
  if (!args.channelArn || !args.messageId || !args.botArn) return undefined;
  try {
    const res = await messagingClient.send(new GetChannelMessageCommand({
      ChannelArn: args.channelArn,
      MessageId: args.messageId,
      ChimeBearer: args.botArn,
    }));
    const raw = res.ChannelMessage?.Content || '';
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch (err) {
    console.warn('[Drift] could not read the originating message back; using the generic label', {
      name: (err as Error)?.name,
    });
    return undefined;
  }
}

function logGateExit(reason: string): void {
  if (reportedGateExits.has(reason)) return;
  reportedGateExits.add(reason);
  console.log(`[Drift] live drift not running for this container: ${reason}`);
}

/**
 * What a turn's subject comparison decided: the same subject as one the conversation has, a new subject,
 * or not compared (no anchor yet, an unavailable embedding, a live task, a greeting). `distance` is the
 * nearest anchor's cosine distance when one was measured.
 */
export interface TurnSubjectDecision {
  decision: 'same' | 'new' | 'skipped';
  distance?: number;
}

/** The question a declined offer held: the person's own message the offer answered instead of it. */
export interface HeldQuestion {
  messageId: string;
  text: string;
}

export async function runLiveDriftFlow(input: LiveDriftFlowInput): Promise<LiveDriftResponse | null> {
  const { event, channelArn, userMessage, personId, classification, botArn, intent } = input;
  // TEMPORARY PHASE TIMING (2026-09-17). Drift is ~604 ms warm and sits in front of the placeholder;
  // this says WHICH of its five round trips that is, so the optimisation targets the real one.
  const driftT0 = Date.now();
  const driftMarks: Record<string, number> = {};
  const driftMark = (name: string) => { driftMarks[name] = Date.now() - driftT0; };

  // Infra gate: the Aurora hookup must be wired (auroraDriftWiring sets these).
  if (!ENABLE_LIVE_DRIFT || !HAS_AURORA || !channelArn) {
    logGateExit(!ENABLE_LIVE_DRIFT ? 'flag_off' : !HAS_AURORA ? 'no_aurora' : 'no_channel');
    return null;
  }

  // Policy gate: drift on/off is a property of the CONVERSATION TYPE, not the
  // classification. Resolve the type (the stamped type if registered, else the ordinary type) and
  // consult the registry. The classification is never used to choose a type.
  //
  // THE TYPE IS READ FROM THE CHANNEL-CONTEXT STORE when the caller does not supply one, which is what
  // makes the dimension real rather than declared. Every conversation records its type key there
  // (ADR-053); without the stamp an `ops` conversation would resolve to the ordinary type, so the gate
  // would offer to split a conversation whose type says not to. One `GetItem`, and it is placed AFTER the infra gate above so a deployment with drift off pays
  // nothing for it. The row is written before the channel exists and is long settled by the first turn,
  // so the default (eventually consistent) read is the right one here - unlike the welcome path, which
  // reads within seconds of the write and must ask for consistency.
  const stampedType = input.conversationType
    ?? (await getChannelContext(channelArn))?.conversationType;
  const typeKey = resolveConversationTypeKey({ explicitType: stampedType });
  const typeConfig = getConversationTypeConfig(typeKey);
  if (!typeConfig.driftEnabled) {
    logGateExit(`type_disabled:${typeKey}`);
    return null;
  }

  // A BATTLE BLOCKS THE ACTION, NOT THE DETECTION (maintainer, 2026-08-13).
  //
  // This used to return null the moment the channel had Battle Mode on, which is why a user who
  // pivoted mid-duel got nothing at all: no suggestion, and no reason for its absence. Silence reads
  // as the product ignoring them, and they retype the pivot.
  //
  // Detection now runs exactly as it does anywhere else - a battle turn is an ordinary turn - and the
  // battle changes only what happens WHEN drift fires. Splitting mid-battle would strand a duel whose
  // sides are mid-round in a conversation the user has left.
  //
  // A RUNNING DUEL, NOT THE MODE FLAG. This asked `isBattleEnabled`, which says only that a moderator
  // has Battle Mode switched on for the channel - so the answer fired between duels, with nothing in
  // flight, and told the person "the assistants are still comparing answers" when no assistant was
  // doing anything. A claim about what is happening now has to be read from what is happening now:
  // whether a side is generating or blocked on a person. The mode being on is not an event.
  //
  // Read once here and threaded down, so detection and the two branches below agree within a turn even
  // if the duel ends while the turn is in flight.
  //
  // WHO IS SPEAKING matters as much as whether a duel is running, because only the person who started
  // it may end it. Offering `/battle end` to everyone would let any member pull a duel out from under
  // the person running it, and would leave the assistants fielding competing instructions from several
  // people at once - the opposite of the focus a head-to-head comparison needs. So the answer differs by
  // speaker: the initiator is offered the way out, everybody else is told who has it.
  const { battleActive, viewerStartedIt } = await (async () => {
    const active = await resolveActiveBattle(channelArn);
    if (!active) return { battleActive: false, viewerStartedIt: false };
    const startedIt = Boolean(active.initiatorUserSub) && active.initiatorUserSub === personId;

    const rows = await readBattleRows(active.battleId);

    // AN EMPTY RESULT IS "I COULD NOT TELL", NOT "NOTHING IS RUNNING".
    //
    // `readBattleRows` catches its own errors and returns `[]`, so a DynamoDB failure, a missing table
    // and a duel whose rows have aged out are one value here. The pointer says a duel exists; if its
    // rows cannot be produced, the safe reading is that it is still going. Splitting a conversation out
    // from under a live duel strands it; declining to split costs the person one more message.
    if (rows.length === 0) {
      console.warn('[live-drift] the pointer names a duel with no readable rows; treating it as running', {
        battleId: active.battleId,
      });
      return { battleActive: true, viewerStartedIt: startedIt };
    }

    // `duelIsLive`, NOT `duelInFlight`. The question here is "is a battle running in this conversation",
    // and `duelInFlight` answers a narrower one - "is a side working right now" - which is FALSE for the
    // whole of round 2, while the rebuttal generates. Asking the narrow question would let a topic
    // change move the person into a new conversation moments before the rebuttal lands in the one they
    // left. The previous `isBattleEnabled` check happened to cover that window; this must too.
    return { battleActive: duelIsLive(rows), viewerStartedIt: startedIt };
  })();

  /**
   * What to tell this speaker about leaving the duel.
   *
   * An instruction somebody cannot carry out is worse than no instruction: they try it, it is refused,
   * and now they have been refused twice. A non-initiator gets the two routes that actually exist -
   * the person who started it ends it, or a moderator turns Battle Mode off - and neither names who
   * the initiator is, which is not a refusal's business to disclose.
   */
  // Who may end the duel decides which form the refusal takes, so a person is told only the route open to them.
  const battleRefusalForm = viewerStartedIt ? 'starter' : 'member';

  const driftIntent = intent.toUpperCase() as DriftIntent;

  // THE OPEN OFFER, READ FROM THE ONE PLACE IT LIVES, ON EVERY DRIFT TURN.
  //
  // It used to be read from the Amazon Lex session first, with Aurora consulted only when the session
  // was empty AND the reply looked like a yes or a no. A turn the channel flow answers has no Lex
  // session, so there the offer was invisible to every ordinary message: an answer that was not a bare
  // yes/no ran detection again and could fire a second offer beside the first. The durable row is the
  // record of the offer, so it is the thing that is read. One data-plane read per drift turn, which is
  // the price of a "yes" never being lost to how the turn arrived.
  driftMark('battle');
  const pending = await readPendingSuggestion({ personId, channelArn });
  driftMark('pending');

  // AN OFFER IS ANSWERED ONLY BY A MESSAGE SENT AFTER IT (code review, 2026-09-12).
  //
  // Reading the offer on every turn, with anything but a yes counting as a decline, made two messages
  // able to decline an offer nobody had seen. A REDELIVERY of the message that made the offer - the
  // at-least-once shape already measured on this path - reads the offer its first delivery just saved
  // and would decline it with the very message it answers; the person then says yes to an offer that is
  // already closed. And a second message sent before the offer appeared was not a reply to it either.
  // So this message is compared with the offer: the same message, or one sent no later than the offer
  // was opened, leaves the offer open and the turn is answered normally. Detection does not run either:
  // an offer is already open, and the duplicate-offer claim below would refuse a second one anyway.
  if (pending) {
    const declaredId = event.requestAttributes?.['AE.message.id'] || '';
    const inbound = declaredId
      ? { messageId: declaredId }
      : input.resolveInbound
        ? await input.resolveInbound()
        : await resolveOriginatingMessage({
          event,
          channelArn,
          senderArn: event.requestAttributes?.['CHIME.sender.arn'] || '',
          botArn,
          userMessage,
        });
    const isTheOfferingMessage = Boolean(pending.originatingMessageId)
      && inbound.messageId === pending.originatingMessageId;
    const inboundAt = 'createdAt' in inbound && inbound.createdAt ? Date.parse(inbound.createdAt) : NaN;
    const offeredAt = pending.createdAt ? Date.parse(pending.createdAt) : NaN;
    const sentBeforeTheOffer = Number.isFinite(inboundAt) && Number.isFinite(offeredAt) && inboundAt <= offeredAt;
    if (isTheOfferingMessage || sentBeforeTheOffer) {
      console.log('[Drift] this message cannot answer the open offer; leaving it open', {
        channelArn,
        reason: isTheOfferingMessage ? 'same_message' : 'sent_before_offer',
      });
      return null;
    }
  }

  // Branch (a): an offer is open, and this message answers it.
  let justDeclined = false;
  if (pending) {
    const reply = classifyConfirmDeclineReply(userMessage);

    // A suggestion can outlive the condition it was made under: Battle Mode may be enabled between the
    // offer and the answer. Accepting it now would create the new conversation and walk the user out of
    // a duel in progress, so the acceptance is held rather than honored. The offer is left open
    // deliberately - it is still a good idea, just not yet - so a "yes" after the battle ends still
    // works without the user re-triggering drift.
    if (reply === 'affirmative' && battleActive) {
      logGateExit('battle_active_confirm_held');
      return {
        messages: [{
          contentType: 'PlainText',
          content: templateLine('drift-battle-refusal', input.words, { form: battleRefusalForm }),
        }],
      };
    }

    if (reply === 'affirmative') {
      try {
        if (pending.kind === 'confirm') {
          const senderArn = event.requestAttributes?.['CHIME.sender.arn'] || '';
          const channelFlowArn = CHANNEL_FLOW_ARN_PARAM
            ? await getSsmValue(CHANNEL_FLOW_ARN_PARAM)
            : undefined;
          // The person's own words, read back by reference now that they are needed (see
          // readOriginatingMessageText). Nothing about the offer stored them.
          const originatingMessageText = await readOriginatingMessageText({
            channelArn,
            messageId: pending.originatingMessageId,
            botArn,
          });
          const created = await createConversationFromDrift({
            // As above: the admin creates, every assistant is added after the flow association.
            creatorBearerArn: await resolveServiceAdminBearer(),
            appInstanceArn: APP_INSTANCE_ARN,
            botArn,
            userArn: senderArn,
            // The spawned channel carries THE PARENT CONVERSATION'S classification, the one this turn
            // is running at. It used to be read off the parent's type entry, which only worked while
            // types were named after classifications - a conversation whose type named none produced
            // no classification at all. IAM Layer-1 gates the new channel on this tag, so it must be
            // the parent's own.
            modelTier: classification,
            modelId: '',
            modelName: '',
            // The topic derives from what the person actually said, not a fixed string.
            topicLabel: driftTopicLabel(originatingMessageText),
            channelFlowArn: channelFlowArn || undefined,
            parentChannelArn: channelArn,
            originatingMessageId: pending.originatingMessageId,
            // Their own words, quoted back in the new conversation's welcome.
            originatingMessageText,
          });
          // THE NEW CONVERSATION KNOWS ITS TOPIC BEFORE ITS FIRST MESSAGE, and this is where that is
          // written down. The person was asked whether to move this subject somewhere else and said
          // yes, so the subject is settled and in their own words.
          //
          // Without it the new conversation's first summary is the ordinary turn-one seed, built from
          // its own opening exchange - which `detectDrift` treats as no topic at all and refuses to
          // compare against. A conversation created BECAUSE of a topic would then be the one place
          // drift stayed blind longest, which is backwards.
          //
          // NOTHING HERE MAY COST THE PERSON THEIR NEW CONVERSATION. It is already created and they
          // are already being sent to it, so a failure to write the anchor must be invisible to them;
          // losing it costs the new conversation its early drift anchor and nothing else.
          //
          // try/catch rather than `.catch()`, because `.catch()` only covers a REJECTED promise. A
          // synchronous throw - the client absent, the op unrecognized - would escape it and land on
          // the outer error path, which answers the person with a failure for a conversation that was
          // successfully created. A test caught exactly that.
          try {
            await seedDriftTopicSummary({
              channelArn: created.channelArn,
              topicLabel: driftTopicLabel(originatingMessageText),
              originatingMessageText,
            });
          } catch (err) {
            console.warn('[drift] drift-topic seed failed (non-fatal):', err);
          }

          if (pending.driftEventId) {
            await recordDriftOutcome({
              eventId: pending.driftEventId,
              outcome: 'accepted',
              newChannelArn: created.channelArn,
            }).catch(() => undefined);
          }
          await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'confirmed' }).catch(() => undefined);
          return {
            messages: [{
              contentType: 'PlainText',
              content: `${templateLine('drift-created', input.words)} NAVIGATE_CHANNEL:${created.channelArn}|${templateLine('drift-created', input.words, { section: 'label.link' })}`,
            }],
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
          return {
            messages: [{
              contentType: 'PlainText',
              content: `${templateLine('drift-redirected', input.words)} NAVIGATE_CHANNEL:${pending.rivalConversationArn}|${templateLine('drift-redirected', input.words, { section: 'label.link' })}`,
            }],
          };
        }
      } catch (err) {
        console.error('[Drift] Failed to act on confirmation:', err);
      }
      // The yes could not be acted on. The offer stays open and the message is answered normally, rather
      // than being re-read as a new subject.
      return null;
    }

    // ANYTHING BUT A YES KEEPS THE SUBJECT HERE, AND THAT IS A DECLINE.
    //
    // The offer itself says so: "Reply 'yes' to create one, or anything else to keep going here." So a
    // "no" and a message that simply carries on are the same answer, and the code now agrees with the
    // copy. Before, an ordinary reply left the offer pending in the Lex session, which kept detection
    // off for as long as that session lived.
    //
    // AND A DECLINED SUBJECT BELONGS TO THIS CONVERSATION. "Once drift is declined the topic determined
    // as drift becomes a topic of the conversation, so therefore should no longer be considered drift."
    // So the offer's embedding is adopted as a topic, for the life of the conversation, and the detector
    // compares later messages with it (SPEC-DRIFT-CONVERGENCE step 6). This replaces suppression by
    // distance, which matched a number rather than a subject and was kept in a session that forgot it.
    if (pending.driftEventId) {
      await recordDriftOutcome({ eventId: pending.driftEventId, outcome: 'declined' }).catch(() => undefined);
    }
    await resolvePendingSuggestion({ taskId: pending.taskId, outcome: 'declined' }).catch(() => undefined);
    // THE HELD QUESTION IS ANSWERED ON DECLINE. The offer was that turn's whole reply,
    // so declining it must not leave the question unanswered. Read alongside the adoption, which this
    // turn already waits on, so the read adds no time.
    const [{ adopted }, heldText] = await Promise.all([
      adoptOfferedTopic({ channelArn, correlationId: pending.correlationId }),
      pending.originatingMessageId
        ? readOriginatingMessageText({ channelArn, messageId: pending.originatingMessageId, botArn })
        : Promise.resolve(undefined),
    ]);
    if (heldText && pending.originatingMessageId) {
      try { input.onHeldQuestion?.({ messageId: pending.originatingMessageId, text: heldText }); } catch { /* an observer never affects the turn */ }
    } else {
      console.warn('[Drift] a declined offer held a question that could not be read back; the reply is answered alone', {
        channelArn, hasId: Boolean(pending.originatingMessageId),
      });
    }
    if (!adopted) {
      console.warn('[Drift] a declined offer had no kept embedding to adopt; the subject may be offered again', {
        channelArn,
        correlationId: pending.correlationId,
      });
    }
    justDeclined = true;
  }

  // A REPLY TO AN OFFER IS ANSWERED, AND IS NOT ITSELF OFFERED.
  //
  // The offer says "Reply 'yes' to create one, or anything else to keep going here", so a person who
  // carries on has just answered it. Detecting on that same message offered again whenever it touched a
  // third subject ("Before that, what is 17 multiplied by 3?"), and the person got neither the held
  // question nor this one answered. Detection resumes with their next message, where the subject just
  // declined is already a known topic.
  if (justDeclined) return null;

  // Branch (b): no offer open - run detectDrift on this message.
  if (!pending) {
    driftMark('before_detect');
    const detected = await detectDrift({
      channelArn,
      latestMessage: userMessage,
      intent: driftIntent,
      userClearance: classification,
      activeTaskInProgress: input.activeTaskInProgress,
      taskSignal: input.taskSignal,
      // Question 3 is handed back rather than asked here; see below.
      deferRelatedLookup: true,
      // Keep the embedding only when an offer will be shown, so a decline can adopt it. A battle turn
      // reports drift without offering a split, so there is nothing to decline.
      retainOfferEmbedding: !battleActive,
      // Same value as `userClearance` above, and deliberately a separate field: that one is an
      // optional metric dimension, this one selects the database reader role both summary-embedding
      // reads run as (ADR-028). A boundary cannot ride on a field that is allowed to be absent.
      classification,
    });
    driftMark('detect');

    // ADR-012 SCOPING, RESOLVED ONLY WHEN QUESTION 3 IS ACTUALLY ASKED.
    //
    // A related conversation may only be suggested if EVERY current human member of this one already
    // has access to it, and the only authoritative answer is Amazon Chime SDK Messaging's own
    // membership - asked directly, never reconstructed from the Aurora archive, and never cached: a
    // stored scope is the lagging copy that keeps a conversation someone was just removed from.
    //
    // It is resolved HERE, on this side of the VPC boundary, because the data plane runs in isolated
    // subnets with no Chime endpoint, and only AFTER detection has fired, because it costs one
    // `SearchChannels` page per 50 shared conversations. Resolving it first, on every turn, measured 12
    // sequential searches a turn for a person sharing 597 conversations with the assistant, and a burst
    // of turns was throttled by the service. Most turns do not fire, so most turns now make no search.
    //
    // A battle turn names the duel instead of offering a split, so it never needs a rival.
    let driftResult = detected;
    if (detected.relatedLookupPending && !battleActive) {
      const scopedChannelArns = await resolveScopedChannelArns({
        currentChannelArn: channelArn,
        bearerArn: input.botArn,
        client: messagingClient,
      });
      driftMark('scope');
      driftResult = await resolveDriftRival({
        result: detected,
        channelArn,
        messageEmbedding: detected.relatedLookupPending.messageEmbedding,
        scopedChannelArns,
        classification,
        userClearance: classification,
        intent: driftIntent,
      });
      driftMark('rival');
    } else if (detected.relatedLookupPending) {
      const { relatedLookupPending: _pending, ...offer } = detected;
      driftResult = offer;
    }
    console.log('[LiveDrift] phase timings ms', { ...driftMarks, total: Date.now() - driftT0, fired: driftResult.isDrift });
    try {
      input.onDecision?.({
        decision: driftResult.isDrift ? 'new' : Number.isFinite(driftResult.driftScore) ? 'same' : 'skipped',
        ...(Number.isFinite(driftResult.driftScore) ? { distance: Math.round(driftResult.driftScore * 1000) / 1000 } : {}),
      });
    } catch { /* an observer never affects the turn */ }

    // DRIFT FIRED DURING A DUEL: name the battle, and offer the way out of it.
    //
    // The person has changed the subject while two assistants are mid-comparison. Splitting now would
    // move them into a new conversation and leave the duel behind, so this cannot simply act. What it
    // says next depends on who is asking: the battle is the CONTAINER (DESIGN-BATTLE 2a-i), its owner
    // may leave it and take the work inside with them, and anyone else is told who can.
    //
    // Nothing is recorded: no drift row, no open offer, no kept embedding. The choice is theirs to make
    // in their next message, and the next turn re-detects if they persist.
    if (driftResult.isDrift && battleActive) {
      // ── DRIFT NEVER REPLACES A DUEL TURN, BECAUSE REPLACING IT COSTS A SIDE ────────────────────
      //
      // This returned a message, and the router treats ANY drift response as the whole turn
      // (`router-agent-handler.ts`: `if (driftResponse) return formatLexResponse(...)`). Detection
      // runs per answering assistant, so on a duel it fired for ONE side, that side returned this
      // notice instead of its round-1 reply, and the comparison ran with a single participant. Which
      // side survived was down to whichever embedding happened to clear the threshold.
      //
      // Observed 2026-09-21 on `/battle Generate an image of a La Croix can`: the alt posted this
      // notice, Atlas generated the image alone, and the duel had nothing to compare. The copy even
      // promised "go ahead and I will answer it here" while returning without answering.
      //
      // So the turn proceeds. The person gets the duel they explicitly asked for, which is also the
      // only thing they can act on right now: a split cannot happen during a battle whatever they
      // are told, and they opened this turn with `/battle` precisely because they wanted it.
      //
      // NOTHING IS RECORDED, unchanged: no drift row, no open offer, no kept embedding. The next turn
      // re-detects if they persist, and once the duel ends an ordinary drift offer can be made.
      logGateExit(viewerStartedIt ? 'battle_active_drift_suppressed' : 'battle_active_drift_suppressed:not-initiator');
      console.log('[LiveDrift] drift fired during a duel; letting the turn answer rather than replacing it', {
        channelArn, viewerStartedIt,
      });
      return null;
    }

    if (driftResult.isDrift && driftResult.suggestionTemplate) {
      // Resolved ONCE, BEFORE the fire is recorded, and reused by the drift row, the open offer and
      // the dedup claim - so a lookup is not paid twice and the three cannot disagree about which
      // message started this.
      //
      // The drift row previously took `CHIME.message.id` directly, which this module's own comment
      // (see resolveOriginatingMessageId) records that Chime never sends. Every live row therefore
      // stored an empty originating_message_id, and the evaluation pass selects offers with
      // `JOIN messages m ON m.message_id = d.originating_message_id` - a join an empty id can never
      // satisfy. No live offer was ever judged, so evaluated_count stayed 0 and the admin Accuracy
      // tile read "Not measured" permanently, looking like an unimplemented feature rather than a
      // broken write.
      // The caller's memo where there is one, so this turn resolves once however many callers want it.
      const originatingMessageId = input.resolveInbound
        ? (await input.resolveInbound()).messageId
        : await resolveOriginatingMessageId({
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
      // errors, so a claim outage degrades to today's behavior rather than silently suppressing a
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

      // Record the fire, then open the offer the next turn reads.
      let driftEventId: string | undefined;
      try {
        driftEventId = await recordDriftFire({
          result: driftResult,
          channelArn,
          messageId: originatingMessageId,
          personId,
          intent: driftIntent,
          // A suggestion is about to be shown to this user, so this row is an OFFER and is the
          // only kind the acceptance rate may count. See migration 016.
          source: 'live',
        });
      } catch (err) {
        console.warn('[Drift] recordDriftFire failed:', err);
      }

      try {
        await savePendingSuggestion({
          channelArn,
          personId,
          kind: driftResult.suggestedAction === 'redirect' ? 'redirect' : 'confirm',
          rivalConversationArn: driftResult.rivalConversationArn,
          originatingMessageId,
          cosineDistance: Number.isFinite(driftResult.driftScore) ? driftResult.driftScore : undefined,
          correlationId: driftResult.correlationId,
          // Carried on the durable row, which is the only record of the offer (migration 044).
          ...(driftEventId ? { driftEventId } : {}),
        });
      } catch (err) {
        console.warn('[Drift] savePendingSuggestion failed:', err);
      }

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
          // ── IT SAYS WHAT IT RESPONDS TO, AND THAT IT IS NOT AN ANSWER ──────
          //
          // "Drift suggestions are a response to a message... Drift can be excluded from normal
          // responses, but should still be tracked in analytics and filterable / separately viewable
          // like readings." So it declares BOTH facts rather than one.
          //
          // THE TARGET COSTS NOTHING. `originatingMessageId` was resolved above for the drift row
          // and the dedup claim, and was in scope here and unused.
          //
          // THE KIND IS WHY IT MUST NOT BE INFERRED FROM AN ABSENCE. This suggestion is excluded
          // from the exchange population today only by accident: it posts directly rather than as a
          // placeholder-then-update, so it carries no correlation marker, and the pairing rule
          // happened to require one. That is the same coincidence that wrongly excludes a broadcast
          // answer, which IS a real reply - so the absence could never be read as intent. Saying
          // which it is makes the two separable.
          //
          // AND THE EXCLUSION IS THE POINT, not a technicality: a suggestion answers fast and
          // deliberately does not do the work. Counted as an answer it drags every latency average
          // down while representing a turn that answered nothing.
          //
          // No `phase`, deliberately. A phase closes a response in the ledger, and this message
          // opens none - it carries no correlation marker, so it archives as a message the assistant
          // volunteered rather than as a response of its own.
          // The offer the detection decided: a redirect to the conversation it found, else a new one. Read from its
          // action, so a data plane on another build cannot hand the router a name it does not say.
          content: withTurnDeclaration(templateLine(driftResult.suggestedAction === 'redirect' ? 'drift-redirect-offer' : 'drift-offer', input.words), {
            ...(originatingMessageId ? { answers: originatingMessageId } : {}),
            kind: 'drift',
          }),
        }],
      };
    }
  }

  // Branch (c): no drift action - continue normal flow.
  return null;
}
