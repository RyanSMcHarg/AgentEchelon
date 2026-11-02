/**
 * THE DE-IDENTIFIED COPY'S DATA-PLANE OPERATIONS (DESIGN-ADMIN-CONSOLE 5.3, migration 069).
 *
 * Each op is bounded so it fits the data plane's per-call cap: the batch (`clean-copy-batch.ts`) runs
 * outside the VPC, calls the detector itself, and reaches Aurora only through these, the same seam
 * every non-VPC handler uses (tenet D8). Nothing here calls a model.
 */
import { query, transaction } from './db-client.js';
import type { SourceRow, CleanRow } from '../lib/de-identify.js';

const MEMBERSHIP_ACTION: Record<string, string> = {
  CREATE_CHANNEL_MEMBERSHIP: 'joined',
  DELETE_CHANNEL_MEMBERSHIP: 'left',
  CREATE_CHANNEL_MODERATOR: 'granted_moderator',
  DELETE_CHANNEL_MODERATOR: 'revoked_moderator',
};

export interface PendingConversation {
  channelArn: string;
  sourceRows: number;
  sourceLatest: string | null;
}

/**
 * Conversations whose archive changed since they were last derived, most recent change first, so a
 * run that cannot finish a backlog has brought the conversations operators are most likely to open up
 * to date, and the rest follow on the next run. Any new
 * archived row - a message, an assistant's finalized reply, a redaction, a deletion, a membership
 * change - raises the row count or the latest time it was derived from. `total` is how many are
 * pending in all, so a run cut short can say what it left.
 */
export async function cleanCopyPending(input: { limit?: number; derivation?: string }): Promise<{ pending: PendingConversation[]; total: number }> {
  const limit = Math.min(Math.max(Number(input?.limit) || 25, 1), 200);
  // What the copy would be derived with now. A conversation derived with anything else - another
  // detector, or an earlier version of the rules - is pending again, whether or not it changed.
  const derivation = input?.derivation ?? null;
  const res = await query<{ channel_arn: string; source_rows: string; source_latest: string | null; total: string }>(
    `WITH src AS (
       SELECT channel_arn, COUNT(*) AS source_rows, MAX(created_at) AS source_latest
         FROM messages
        GROUP BY channel_arn
     ),
     changed AS (
       SELECT s.channel_arn, s.source_rows, s.source_latest
         FROM src s
         LEFT JOIN clean_conversations c ON c.channel_arn = s.channel_arn
        WHERE c.channel_arn IS NULL
           OR c.source_rows <> s.source_rows
           OR c.source_latest IS DISTINCT FROM s.source_latest
           OR ($2::text IS NOT NULL AND c.detector IS DISTINCT FROM $2)
     )
     SELECT channel_arn, source_rows, source_latest, COUNT(*) OVER () AS total
       FROM changed
      ORDER BY source_latest DESC NULLS LAST
      LIMIT $1`,
    [limit, derivation],
  );
  return {
    pending: res.rows.map((r) => ({ channelArn: r.channel_arn, sourceRows: Number(r.source_rows), sourceLatest: r.source_latest })),
    total: res.rows.length ? Number(res.rows[0].total) : 0,
  };
}

/**
 * One conversation's archived timeline, as the de-identifier needs it: each message once (its CREATE
 * row, with the finalized or edited text and whether it was removed) and each membership change.
 */
export async function cleanCopySource(input: { channelArn: string }): Promise<{ rows: SourceRow[]; classification: string | null }> {
  const channelArn = input?.channelArn;
  if (!channelArn) throw new Error('cleanCopySource: channelArn required');
  const res = await query<{
    event_type: string; message_id: string | null; at: string; sender_arn: string | null; sender_name: string | null;
    assistant: string | null; content: string | null; updated_content: string | null; target_arn: string | null;
    redacted: boolean; deleted: boolean; classification: string | null;
  }>(
    `SELECT m.event_type, m.message_id, m.created_at AS at, m.sender_arn, m.sender_name, m.assistant,
            m.content, m.updated_content, m.target_arn,
            EXISTS (SELECT 1 FROM messages r WHERE r.channel_arn = m.channel_arn AND r.message_id = m.message_id || '-RED') AS redacted,
            EXISTS (SELECT 1 FROM messages d WHERE d.channel_arn = m.channel_arn AND d.message_id = m.message_id || '-DEL') AS deleted,
            COALESCE(m.conversation_classification, m.user_type) AS classification
       FROM messages m
      WHERE m.channel_arn = $1
        AND (
          (m.event_type = 'CREATE_CHANNEL_MESSAGE' AND m.message_id !~ '-(UPD|RED|DEL)$')
          OR m.event_type IN ('CREATE_CHANNEL_MEMBERSHIP', 'DELETE_CHANNEL_MEMBERSHIP',
                              'CREATE_CHANNEL_MODERATOR', 'DELETE_CHANNEL_MODERATOR')
        )
      ORDER BY m.created_at ASC`,
    [channelArn],
  );
  let classification: string | null = null;
  const rows: SourceRow[] = res.rows.map((r) => {
    classification = classification ?? r.classification;
    if (r.event_type === 'CREATE_CHANNEL_MESSAGE') {
      return {
        kind: 'message',
        messageId: r.message_id,
        at: r.at,
        actorArn: r.sender_arn || '',
        actorName: r.sender_name,
        agentType: r.assistant,
        content: r.content,
        updatedContent: r.updated_content,
        // Deleted wins: a message both redacted and deleted is gone.
        removed: r.deleted ? 'deleted' : r.redacted ? 'redacted' : null,
        action: null,
        subjectArn: null,
        subjectName: null,
      };
    }
    // A membership row: `target_arn` is the member, `content` their name, `sender_*` who acted.
    return {
      kind: 'membership',
      messageId: null,
      at: r.at,
      actorArn: r.sender_arn || r.target_arn || '',
      actorName: r.sender_name,
      agentType: null,
      content: null,
      updatedContent: null,
      removed: null,
      action: MEMBERSHIP_ACTION[r.event_type] || r.event_type,
      subjectArn: r.target_arn,
      subjectName: r.content,
    };
  });
  return { rows, classification };
}

/**
 * Replace one conversation's copy and record what it was derived from, in one transaction, so a reader
 * never sees half a conversation and a failed write leaves the conversation pending for the next run.
 */
export async function cleanCopyWrite(input: {
  channelArn: string; rows: CleanRow[]; sourceRows: number; sourceLatest: string | null;
  classification: string | null; detector: string;
}): Promise<{ written: number }> {
  const { channelArn, rows } = input;
  if (!channelArn || !Array.isArray(rows)) throw new Error('cleanCopyWrite: channelArn and rows required');
  await transaction(async (client) => {
    await client.query('DELETE FROM clean_conversation_rows WHERE channel_arn = $1', [channelArn]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO clean_conversation_rows
           (channel_arn, seq, kind, source_message_id, occurred_at, actor, actor_kind, action, subject, text, original_text, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [channelArn, r.seq, r.kind, r.sourceMessageId, r.occurredAt, r.actor, r.actorKind, r.action, r.subject, r.text, r.originalText, r.state],
      );
    }
    await client.query(
      `INSERT INTO clean_conversations (channel_arn, classification, source_rows, source_latest, derived_at, detector)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (channel_arn) DO UPDATE SET
         classification = EXCLUDED.classification,
         source_rows    = EXCLUDED.source_rows,
         source_latest  = EXCLUDED.source_latest,
         derived_at     = NOW(),
         detector       = EXCLUDED.detector`,
      [channelArn, input.classification, input.sourceRows, input.sourceLatest, input.detector],
    );
  });
  return { written: rows.length };
}

/** Record one run of the batch, whatever its outcome. */
export async function cleanCopyRecordRun(input: {
  startedAt: string; outcome: 'complete' | 'incomplete' | 'failed'; conversations: number; remaining: number | null; failure: string | null;
}): Promise<{ recorded: boolean }> {
  await query(
    `INSERT INTO clean_copy_runs (started_at, outcome, conversations, remaining, failure) VALUES ($1, $2, $3, $4, $5)`,
    [input.startedAt, input.outcome, input.conversations, input.remaining, input.failure],
  );
  return { recorded: true };
}

export interface CleanConversation {
  rows: Array<{
    seq: number; kind: 'message' | 'membership'; occurredAt: string; actor: string; actorKind: 'person' | 'assistant';
    action: string | null; subject: string | null; text: string | null; originalText: string | null;
    state: 'present' | 'redacted' | 'deleted';
  }>;
  /** When this conversation was last derived; null when it has not been yet. */
  derivedAt: string | null;
  classification: string | null;
}

/**
 * Read one conversation's copy for the console. A removal in the archive is applied HERE, at read time,
 * so a message removed after the copy was derived shows as removed and never with its text.
 */
export async function adminCleanConversation(input: { channelArn: string }): Promise<CleanConversation> {
  const channelArn = input?.channelArn;
  if (!channelArn) throw new Error('adminCleanConversation: channelArn required');
  const [rows, meta] = await Promise.all([
    query<{
      seq: number; kind: 'message' | 'membership'; occurred_at: string; actor: string; actor_kind: 'person' | 'assistant';
      action: string | null; subject: string | null; text: string | null; original_text: string | null; state: string;
      redacted_now: boolean; deleted_now: boolean;
    }>(
      `SELECT r.seq, r.kind, r.occurred_at, r.actor, r.actor_kind, r.action, r.subject, r.text, r.original_text, r.state,
              EXISTS (SELECT 1 FROM messages x WHERE x.channel_arn = r.channel_arn AND x.message_id = r.source_message_id || '-RED') AS redacted_now,
              EXISTS (SELECT 1 FROM messages x WHERE x.channel_arn = r.channel_arn AND x.message_id = r.source_message_id || '-DEL') AS deleted_now
         FROM clean_conversation_rows r
        WHERE r.channel_arn = $1
        ORDER BY r.seq ASC`,
      [channelArn],
    ),
    query<{ derived_at: string; classification: string | null }>(
      `SELECT derived_at, classification FROM clean_conversations WHERE channel_arn = $1`,
      [channelArn],
    ),
  ]);
  return {
    rows: rows.rows.map((r) => {
      const state = (r.deleted_now ? 'deleted' : r.redacted_now ? 'redacted' : r.state) as 'present' | 'redacted' | 'deleted';
      const removed = state !== 'present';
      return {
        seq: r.seq,
        kind: r.kind,
        occurredAt: r.occurred_at,
        actor: r.actor,
        actorKind: r.actor_kind,
        action: r.action,
        subject: r.subject,
        text: removed ? null : r.text,
        originalText: removed ? null : r.original_text,
        state,
      };
    }),
    derivedAt: meta.rows[0]?.derived_at ?? null,
    classification: meta.rows[0]?.classification ?? null,
  };
}
