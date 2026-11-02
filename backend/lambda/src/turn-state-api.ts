/**
 * WHAT IS WAITING IN THIS CONVERSATION, for the client to render (ADR-033).
 *
 *   GET /turn-state?channelArn=...  ->  { busy, queued: [messageId], noticeId? }
 *
 * ── WHY AN ENDPOINT AND NOT A MARKER ON A MESSAGE ────────────────────────────────────────────────
 *
 * The first draft of this design put the queued ids in a marker on an assistant message and had the
 * client derive membership from transcript ordering. That fails in the ordinary cases: a client that
 * reloaded with partial history, one that joined the conversation late, or one whose window does not
 * reach back to the message that triggered the deferral. Ordering is not a reliable encoding of set
 * membership, and a marker carrying the ids grows with the queue and must be rewritten on every send.
 *
 * A record answers all of it directly, is authoritative, and cannot be forged. This is how a client
 * reads it: on load, on reconnect, and on the notification that it changed.
 *
 * ── IT RETURNS IDS, AND THAT IS THE POINT ────────────────────────────────────────────────────────
 *
 * Not content. The queue has never held content - it holds ids, so a message edited while it waited
 * is triaged as edited - and this read holds the same line. The client already has the messages it
 * can see; what it lacks is which of them are waiting, and an id is exactly that and nothing more.
 *
 * ── WHAT A CALLER MAY NOT DO IS ASK ABOUT A CONVERSATION THEY ARE NOT IN ─────────────────────────
 *
 * The queued ids of a conversation are a fact about who is talking to whom. Membership is enforced by
 * Amazon Chime SDK, which owns it, and never from an archived copy - a copy lags exactly when
 * membership has just changed. So the read is performed AS THE CALLER: their own bearer, their own
 * membership. A non-member's `DescribeChannel` fails and this returns 403 without ever touching the
 * queue record.
 *
 * ── AND A TARGETED MESSAGE IS NOT IN THE ANSWER ──────────────────────────────────────────────────
 *
 * A member who cannot read a message must not see it queued: a waiting affordance on a message they
 * cannot open is the same disclosure the private-task rule exists to prevent, arriving through the UI
 * instead of the task list. So the ids are filtered to what this caller can already see, which for
 * the sender is everything and for everyone else is the untargeted ones.
 *
 * That leaves a case worth naming rather than hiding: a member can see the assistant is busy without
 * seeing what it is busy WITH. That is what targeting means, and the copy should not pretend
 * otherwise by implying they are missing something they could have seen.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  ChimeSDKMessagingClient,
  DescribeChannelCommand,
  GetChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { readTurnState, readDispatchFailure, type DispatchFailureReason } from './lib/turn-lock.js';
import { userArnFor } from './lib/person-arn.js';
import { callerPersonId } from './lib/auth.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
const ALLOWED_ORIGINS = originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN);

const chime = chimeMessagingClient({ region: AWS_REGION });

const http = responder({ origin: { allow: ALLOWED_ORIGINS }, methods: 'GET,OPTIONS' });

const respond = http.respond;

/** What the client renders. Ids and flags; never content. */
export interface TurnStateView {
  /** True when a turn is running here, whoever it belongs to. */
  busy: boolean;
  /** The waiting messages THIS caller can see, in the order they were sent. */
  queued: string[];
  /** The deferral notice this conversation is showing, if one was posted. */
  noticeId?: string;
  /**
   * WHY THIS CALLER'S LAST TURN NEVER RAN, when one did not.
   *
   * A REASON CODE AND NEVER PROSE, which is this interface's standing rule: the copy a person reads
   * carries their language, and only the client can resolve that (tenets P5 and D11). A closed set
   * rather than a string, for the reason the flag reasons are closed - open text fragments into
   * something nothing can group or translate.
   *
   * SCOPED TO THIS CALLER. The failure happened to the person whose message went unanswered; the rest
   * of the room neither saw it nor needs to. That scoping is the thing a persistent channel message
   * could not do, and is half of why this is state rather than a posted message.
   */
  dispatchFailed?: DispatchFailureReason;
}

/**
 * Keep only the queued messages this caller may already see.
 *
 * READ AS THE CALLER, so the service answers the question rather than this code re-deriving it: a
 * targeted message the caller is not on simply cannot be fetched with their bearer.
 *
 * A MESSAGE THAT CANNOT BE READ IS OMITTED, which is the safe direction. Being wrong that way costs
 * a moment of missing styling on a message they could have seen; being wrong the other way tells them
 * a message exists that its sender chose to keep from them.
 */
export async function visibleQueued(args: {
  channelArn: string;
  callerArn: string;
  queued: string[];
}): Promise<string[]> {
  const { channelArn, callerArn, queued } = args;
  const seen = await Promise.all(queued.map(async (messageId) => {
    try {
      await chime.send(new GetChannelMessageCommand({
        ChannelArn: channelArn, MessageId: messageId, ChimeBearer: callerArn,
      }));
      return messageId;
    } catch {
      return null;
    }
  }));
  return seen.filter((id): id is string => !!id);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === 'OPTIONS') return respond(200, {}, origin);
  if (event.httpMethod !== 'GET') {
    return respond(405, { error: `${event.httpMethod} not supported` }, origin);
  }

  const sub = await callerPersonId(event);
  if (!sub) return respond(401, { error: 'Unauthorized' }, origin);

  const channelArn = event.queryStringParameters?.channelArn || '';
  if (!channelArn) return respond(400, { error: 'channelArn is required' }, origin);
  /**
   * WHICH ASSISTANT, and it is REQUIRED rather than defaulted.
   *
   * Busy is a property of a RESPONDER, not of a conversation: two people addressing two assistants in
   * one room should both get answers, which is why the lock is keyed that way. So "what is waiting
   * here" has no answer until you say waiting on WHOM.
   *
   * A default would read a key that never exists and return an empty state - a client would then
   * clear its waiting styling and report that nothing is queued, which is a confident lie rather than
   * a missing answer. The client knows which assistant it is addressing; it passes it.
   */
  const responderId = event.queryStringParameters?.responderId || '';
  if (!responderId) return respond(400, { error: 'responderId is required' }, origin);
  // The conversation must belong to THIS deployment's app instance. Without it the caller names any
  // ARN they like and the membership check below runs against somebody else's conversation.
  if (APP_INSTANCE_ARN && !channelArn.startsWith(`${APP_INSTANCE_ARN}/channel/`)) {
    return respond(400, { error: 'channelArn is not from this deployment' }, origin);
  }

  const callerArn = userArnFor(APP_INSTANCE_ARN, sub);

  // MEMBERSHIP, FROM THE SERVICE THAT OWNS IT. A non-member's describe fails, and this returns before
  // the queue record is touched - so a caller who is not in the conversation learns nothing about it,
  // not even that it is busy.
  try {
    await chime.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: callerArn }));
  } catch {
    return respond(403, { error: 'Not a member of this conversation' }, origin);
  }

  try {
    const state = await readTurnState({ channelArn, responderId });
    // COULD NOT LOOK IS NOT NOTHING IS WAITING (invariant E). The read fails open for the lock,
    // which is right there and wrong here: answering 200 with an empty state told the client the
    // queue had drained, and it cleared the waiting styling on messages that were still queued.
    if (state.unreadable) {
      console.error('[turn-state-api] the conversation state could not be read', { channelArn });
      return respond(500, { error: 'Could not read the conversation state' }, origin);
    }
    const queued = await visibleQueued({ channelArn, callerArn, queued: state.queued });
    // WHY THIS CALLER'S TURN NEVER RAN, if it did not. Read AFTER the membership check above, so a
    // non-member cannot learn even that a dispatch failed here. Read per caller rather than per
    // conversation, because the failure belongs to the person whose message went unanswered.
    const failure = await readDispatchFailure({ channelArn, senderSub: sub, responderId });
    const view: TurnStateView = {
      busy: state.busy,
      queued,
      ...(state.noticeId ? { noticeId: state.noticeId } : {}),
      ...(failure ? { dispatchFailed: failure.reason } : {}),
    };
    return respond(200, view, origin);
  } catch (error) {
    console.error('[turn-state-api] read failed:', error);
    // NOT an empty state. "Nothing is waiting" is a claim, and a client that believed it would clear
    // the styling on messages that are still queued. An error lets the client keep what it has.
    return respond(500, { error: 'Could not read the conversation state' }, origin);
  }
};
