/**
 * Routing State Helper
 *
 * Manages the pending-drift-suggestion state that persists across Lex turns.
 * State has two stores:
 *
 *   1. Lex sessionAttributes (primary, in-flight). Fast, ephemeral, gets
 *      reset when the Lex session expires.
 *
 *   2. Aurora `conversation_creation_tasks` (backup, durable). Read on
 *      session-reset paths so a Lex session timeout doesn't lose pending
 *      drift state. Rows expire after 30 minutes via the spec's
 *      `expires_at` column.
 *
 * The pending state captures what we offered the user, so when their next
 * message arrives we can decide:
 *   - "yes" → execute the suggestion (create channel or navigate)
 *   - "no" / decline → record the cosine-distance band so we don't re-ask
 *   - ambiguous → ask once, then default to "continue here"
 *
 * Per SPEC-DRIFT-CONVERGENCE.md "Clarification Routing in Multi-Bot
 * Channels": only one pending suggestion per (channel, user) at a time.
 * A new suggestion replaces the previous pending state.
 */

import { query } from '../analytics-aurora/db-client.js';

export type SuggestionKind = 'confirm' | 'redirect';

export interface PendingSuggestion {
  taskId: string;
  channelArn: string;
  userSub: string;
  kind: SuggestionKind;
  rivalConversationArn?: string;
  originatingMessageId: string;
  cosineDistance?: number;
  correlationId: string;
  driftEventId?: string;        // The drift_events row id (set after recordDriftFire)
  createdAt: string;
}

export interface RoutingSessionAttributes {
  pendingDriftSuggestion?: PendingSuggestion;
  declinedDistances?: number[];  // capped at last 3 declines
}

const MAX_DECLINED_DISTANCES = 3;

// ---------------------------------------------------------------------------
// Lex sessionAttributes serialization
//
// Lex sessionAttributes is a Record<string, string>. We serialize the whole
// routing state under a single key to avoid colliding with other consumers
// of the same session.
// ---------------------------------------------------------------------------

const ROUTING_KEY = 'agentEchelonRouting';

export function readRoutingFromSession(
  sessionAttributes: Record<string, string> | undefined,
): RoutingSessionAttributes {
  if (!sessionAttributes || !sessionAttributes[ROUTING_KEY]) return {};
  try {
    const parsed = JSON.parse(sessionAttributes[ROUTING_KEY]);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as RoutingSessionAttributes;
  } catch {
    return {};
  }
}

export function writeRoutingToSession(
  sessionAttributes: Record<string, string>,
  routing: RoutingSessionAttributes,
): Record<string, string> {
  return { ...sessionAttributes, [ROUTING_KEY]: JSON.stringify(routing) };
}

// ---------------------------------------------------------------------------
// Pending suggestion lifecycle
// ---------------------------------------------------------------------------

export async function savePendingSuggestion(input: {
  channelArn: string;
  userSub: string;
  kind: SuggestionKind;
  rivalConversationArn?: string;
  originatingMessageId: string;
  cosineDistance?: number;
  correlationId: string;
}): Promise<PendingSuggestion> {
  // Aurora write — durable backup.
  const rows = await query<{ task_id: string; created_at: string }>(
    `INSERT INTO conversation_creation_tasks (
       user_sub, channel_arn, suggestion_kind, rival_conversation_arn,
       originating_message_id, cosine_distance, correlation_id, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING task_id::text AS task_id, created_at::text AS created_at`,
    [
      input.userSub,
      input.channelArn,
      input.kind,
      input.rivalConversationArn || null,
      input.originatingMessageId,
      input.cosineDistance ?? null,
      input.correlationId,
    ],
  );
  const row = rows.rows[0];
  return {
    taskId: row.task_id,
    channelArn: input.channelArn,
    userSub: input.userSub,
    kind: input.kind,
    rivalConversationArn: input.rivalConversationArn,
    originatingMessageId: input.originatingMessageId,
    cosineDistance: input.cosineDistance,
    correlationId: input.correlationId,
    createdAt: row.created_at,
  };
}

/**
 * Read the pending suggestion for a (user, channel) pair from Aurora.
 * Used on Lex session-reset paths where the in-memory session state was lost.
 */
export async function readPendingSuggestion(input: {
  userSub: string;
  channelArn: string;
}): Promise<PendingSuggestion | null> {
  const rows = await query<{
    task_id: string;
    suggestion_kind: SuggestionKind;
    rival_conversation_arn: string | null;
    originating_message_id: string;
    cosine_distance: string | null;
    correlation_id: string;
    created_at: string;
  }>(
    `SELECT task_id::text AS task_id,
            suggestion_kind,
            rival_conversation_arn,
            originating_message_id,
            cosine_distance::text AS cosine_distance,
            correlation_id::text AS correlation_id,
            created_at::text AS created_at
       FROM conversation_creation_tasks
      WHERE user_sub = $1 AND channel_arn = $2 AND status = 'pending' AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.userSub, input.channelArn],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    taskId: row.task_id,
    channelArn: input.channelArn,
    userSub: input.userSub,
    kind: row.suggestion_kind,
    rivalConversationArn: row.rival_conversation_arn || undefined,
    originatingMessageId: row.originating_message_id,
    cosineDistance: row.cosine_distance != null ? Number(row.cosine_distance) : undefined,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}

export async function resolvePendingSuggestion(input: {
  taskId: string;
  outcome: 'confirmed' | 'declined' | 'expired';
}): Promise<void> {
  await query(
    `UPDATE conversation_creation_tasks
        SET status = $1,
            resolved_at = NOW()
      WHERE task_id = $2::uuid
        AND status = 'pending'`,
    [input.outcome, input.taskId],
  );
}

// ---------------------------------------------------------------------------
// Decline-suppression: tracks recently-declined cosine distances
// ---------------------------------------------------------------------------

export function recordDecline(
  routing: RoutingSessionAttributes,
  cosineDistance: number,
): RoutingSessionAttributes {
  const declined = routing.declinedDistances || [];
  const next = [cosineDistance, ...declined].slice(0, MAX_DECLINED_DISTANCES);
  return { ...routing, pendingDriftSuggestion: undefined, declinedDistances: next };
}

// ---------------------------------------------------------------------------
// User reply parsing — does the user's next message look like a yes/no?
// ---------------------------------------------------------------------------

// Whole-utterance acks: a bare confirmation/decline, optionally with trailing
// punctuation. Kept strict so a verb-y token ("switch", "navigate", "do it")
// only confirms when it IS the whole reply — "switch to dark mode" is a request,
// not a confirmation, and must stay ambiguous.
const AFFIRMATIVE_EXACT = /^\s*(yes|yeah|yep|yup|sure|ok|okay|please do|do it|go ahead|sounds good|let'?s do it|create it|switch|navigate)\s*[.!]*\s*$/i;
const NEGATIVE_EXACT = /^\s*(no|nope|nah|not now|don'?t|stay here|keep going|continue|stay|cancel|nevermind)\s*[.!]*\s*$/i;

// Brief natural affirmative: a strong yes-word at the LEAD followed by a short
// tail — "yes please", "ok create it", "sure, go ahead". This is the fix for the
// bare-ack case: the old `$`-anchored form accepted exactly one token and dropped
// "yes please" to ambiguous → no channel created. Only the unambiguous yes-words
// lead here (not the verb-y phrase tokens), and the tail is length-capped so a
// multi-clause reply ("yes please tell me about both") stays ambiguous rather
// than auto-creating a channel the user didn't clearly ask for. Question marks
// disqualify (a question isn't a confirmation). SPEC-DRIFT-CONVERGENCE.md
// §Live-Suggestion Flow lists these as confirmations.
const AFFIRMATIVE_LEAD = /^\s*(yes|yeah|yep|yup|sure|ok|okay)\b/i;
const MAX_ACK_TAIL_WORDS = 3;

export type ReplyClassification = 'affirmative' | 'negative' | 'ambiguous';

export function classifyConfirmDeclineReply(text: string): ReplyClassification {
  const trimmed = (text || '').trim();
  if (!trimmed) return 'ambiguous';
  if (NEGATIVE_EXACT.test(trimmed)) return 'negative';
  if (AFFIRMATIVE_EXACT.test(trimmed)) return 'affirmative';
  // Brief leading yes-word ("yes please") — short tail, not a question.
  const lead = AFFIRMATIVE_LEAD.exec(trimmed);
  if (lead && !trimmed.includes('?')) {
    const tail = trimmed.slice(lead[0].length).trim();
    const tailWords = tail ? tail.split(/\s+/).length : 0;
    if (tailWords <= MAX_ACK_TAIL_WORDS) return 'affirmative';
  }
  return 'ambiguous';
}
