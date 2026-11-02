/**
 * Routing State Helper
 *
 * Manages the pending drift offer between the turn that makes it and the turn that answers it.
 *
 * ONE STORE: Aurora `conversation_creation_tasks`, read at the start of every drift turn. Rows expire
 * after 30 minutes via `expires_at`.
 *
 * NOT THE AMAZON LEX SESSION, which this used to treat as the primary copy. That session exists only
 * when Lex is the entry: a turn the channel flow answers starts with it empty and its writes are
 * discarded, and Lex drops it after five idle minutes on its own. A pending offer that lives there is
 * one that some turns cannot see - a "yes" that reaches the flow's entry finds nothing to confirm, and
 * an ordinary message fires a second offer beside the first. Turn state belongs to AgentEchelon, not to
 * one of the ways a turn can arrive.
 *
 * Declines are not tracked here either. A declined offer's subject becomes a topic of the
 * conversation (`adoptOfferedTopic`, migration 044), so it stops being drift rather than being
 * suppressed by distance.
 *
 * The pending state captures what we offered the user, so when their next
 * message arrives we can decide:
 *   - "yes" → execute the suggestion (create channel or navigate)
 *   - "no" / decline → record the cosine-distance band so we don't re-ask
 *   - ambiguous → ask once, then default to "continue here"
 *
 * Per SPEC-DRIFT-CONVERGENCE, the live-suggestion flow (clarification routing in multi-assistant
 * Channels": only one pending suggestion per (channel, user) at a time.
 * A new suggestion replaces the previous pending state.
 */

import { query } from '../analytics-aurora/db-client.js';

export type SuggestionKind = 'confirm' | 'redirect';

export interface PendingSuggestion {
  taskId: string;
  channelArn: string;
  personId: string;
  kind: SuggestionKind;
  rivalConversationArn?: string;
  originatingMessageId: string;
  cosineDistance?: number;
  correlationId: string;
  /**
   * The drift_events row this offer fired, so its outcome can be recorded when it is answered. Stored on
   * the durable row (migration 044): without it an answered offer left its drift event unresolved.
   */
  driftEventId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pending suggestion lifecycle
// ---------------------------------------------------------------------------

export async function savePendingSuggestion(input: {
  channelArn: string;
  personId: string;
  kind: SuggestionKind;
  rivalConversationArn?: string;
  originatingMessageId: string;
  cosineDistance?: number;
  correlationId: string;
  driftEventId?: string;
}): Promise<PendingSuggestion> {
  const rows = await query<{ task_id: string; created_at: string }>(
    `INSERT INTO conversation_creation_tasks (
       person_id, channel_arn, suggestion_kind, rival_conversation_arn,
       originating_message_id, cosine_distance, correlation_id, drift_event_id, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING task_id::text AS task_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`,
    [
      input.personId,
      input.channelArn,
      input.kind,
      input.rivalConversationArn || null,
      input.originatingMessageId,
      input.cosineDistance ?? null,
      input.correlationId,
      input.driftEventId || null,
    ],
  );
  const row = rows.rows[0];
  return {
    taskId: row.task_id,
    channelArn: input.channelArn,
    personId: input.personId,
    kind: input.kind,
    rivalConversationArn: input.rivalConversationArn,
    originatingMessageId: input.originatingMessageId,
    cosineDistance: input.cosineDistance,
    correlationId: input.correlationId,
    ...(input.driftEventId ? { driftEventId: input.driftEventId } : {}),
    createdAt: row.created_at,
  };
}

/** The open drift offer for a (user, channel) pair, or null. Read at the start of every drift turn. */
export async function readPendingSuggestion(input: {
  personId: string;
  channelArn: string;
}): Promise<PendingSuggestion | null> {
  const rows = await query<{
    task_id: string;
    suggestion_kind: SuggestionKind;
    rival_conversation_arn: string | null;
    originating_message_id: string;
    cosine_distance: string | null;
    correlation_id: string;
    drift_event_id: string | null;
    created_at: string;
  }>(
    `SELECT task_id::text AS task_id,
            suggestion_kind,
            rival_conversation_arn,
            originating_message_id,
            cosine_distance::text AS cosine_distance,
            correlation_id::text AS correlation_id,
            drift_event_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM conversation_creation_tasks
      WHERE person_id = $1 AND channel_arn = $2 AND status = 'pending' AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.personId, input.channelArn],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    taskId: row.task_id,
    channelArn: input.channelArn,
    personId: input.personId,
    kind: row.suggestion_kind,
    rivalConversationArn: row.rival_conversation_arn || undefined,
    originatingMessageId: row.originating_message_id,
    cosineDistance: row.cosine_distance != null ? Number(row.cosine_distance) : undefined,
    correlationId: row.correlation_id,
    ...(row.drift_event_id ? { driftEventId: row.drift_event_id } : {}),
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
