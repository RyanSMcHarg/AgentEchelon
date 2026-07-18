/**
 * Aurora (Postgres) read path for the admin Conversations views.
 *
 * In Aurora mode the admin-conversations Lambda must NOT read the archive via
 * Athena: those `json_extract_scalar` full-scan queries take 15-27s and blow past
 * both the Lambda timeout and API Gateway's 29s cap, so the Conversations tab
 * 502s (see BUG #21). Aurora already holds the same records in the `messages`
 * table (message events, plus channel + membership events as their own
 * `event_type` rows), so these queries answer the same three views in
 * sub-second time. Runs inside the VPC-attached data-plane Lambda (the only seam
 * with Aurora access); the non-VPC admin handler invokes it (ADR-018 pattern).
 *
 * Field parity with the Athena path: the channel name is archived in `content`
 * for CREATE/UPDATE_CHANNEL rows; the member name in `content` and the inviter in
 * `sender_name` for membership rows - so nothing degrades.
 */

import { query } from './db-client.js';
import { stripMessageMarkers } from '../lib/message-markers.js';

export interface AdminConvSummary {
  channelArn: string;
  name: string;
  messageCount: number;
  lastMessageAt?: string;
  memberCount: number;
  metadata: { modelTier: string };
}

export interface AdminConvMessage {
  id: string;
  content: string;
  senderArn: string;
  senderName: string;
  timestamp: string;
  isBot: boolean;
  redacted: boolean;
  /** True when a DELETE_CHANNEL_MESSAGE sibling exists — content is blanked like a
   *  redaction. Optional: the Athena path does not derive it (undefined → falsy). */
  deleted?: boolean;
  modelId?: string;
  intent?: string;
  metadata: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface AdminMembershipEvent {
  action: string;
  memberArn: string;
  memberName: string;
  invitedBy?: string;
  timestamp: string;
  isBot: boolean;
}

export async function adminListConversations(limit = 50): Promise<AdminConvSummary[]> {
  const lim = Math.min(Math.max(1, limit), 200);
  const res = await query<{
    channel_arn: string; tier: string | null; name: string | null;
    message_count: string; last_message_at: string | null; member_count: string;
  }>(
    `WITH names AS (
       SELECT DISTINCT ON (channel_arn) channel_arn, content AS name
         FROM messages
        WHERE event_type IN ('CREATE_CHANNEL','UPDATE_CHANNEL') AND content IS NOT NULL AND content <> ''
        ORDER BY channel_arn, created_at DESC
     ),
     first_msg AS (
       -- Fallback title: the first human message in the conversation. The title auto-derive
       -- renames the LIVE Chime channel, but that UpdateChannel event is not streamed to Kinesis,
       -- so Aurora has no derived title and every row showed 'Untitled'. Deriving from the first
       -- user message (the same signal the client title-derive uses) gives a meaningful title.
       SELECT DISTINCT ON (channel_arn) channel_arn,
              LEFT(REGEXP_REPLACE(content, '<!--.*?-->', '', 'g'), 60) AS name
         FROM messages
        WHERE event_type = 'CREATE_CHANNEL_MESSAGE' AND is_bot = false AND content IS NOT NULL AND content <> ''
        ORDER BY channel_arn, created_at ASC
     ),
     agg AS (
       SELECT channel_arn,
              MAX(user_type) AS tier,
              COUNT(*) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE') AS message_count,
              MAX(created_at) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE') AS last_message_at
         FROM messages
        GROUP BY channel_arn
     ),
     members AS (
       -- Current member count from the archived membership events (humans + bots):
       -- a member is present iff their most-recent membership event is a join, not a
       -- leave. The archive captures CREATE/DELETE_CHANNEL_MEMBERSHIP as their own
       -- event_type rows, so this is the same system of record adminMembershipHistory
       -- reads. Channels predating membership archival resolve to 0 (not wrong — no
       -- events to count), same honest-empty as before.
       SELECT channel_arn, COUNT(*) AS member_count
         FROM (
           SELECT DISTINCT ON (channel_arn, target_arn) channel_arn, event_type
             FROM messages
            WHERE event_type IN ('CREATE_CHANNEL_MEMBERSHIP','DELETE_CHANNEL_MEMBERSHIP')
              AND target_arn IS NOT NULL
            ORDER BY channel_arn, target_arn, created_at DESC
         ) latest
        WHERE event_type = 'CREATE_CHANNEL_MEMBERSHIP'
        GROUP BY channel_arn
     )
     SELECT a.channel_arn, a.tier, COALESCE(n.name, fm.name) AS name,
            a.message_count::text AS message_count, a.last_message_at,
            COALESCE(mem.member_count, 0)::text AS member_count
       FROM agg a
       LEFT JOIN names n ON n.channel_arn = a.channel_arn
       LEFT JOIN first_msg fm ON fm.channel_arn = a.channel_arn
       LEFT JOIN members mem ON mem.channel_arn = a.channel_arn
      WHERE a.message_count > 0
      ORDER BY a.last_message_at DESC NULLS LAST
      LIMIT $1`,
    [lim],
  );
  return res.rows.map((r) => ({
    channelArn: r.channel_arn,
    name: r.name || 'Untitled Conversation',
    messageCount: Number(r.message_count || 0),
    lastMessageAt: r.last_message_at || undefined,
    memberCount: Number(r.member_count || 0),
    metadata: { modelTier: r.tier || '' },
  }));
}

export async function adminListMessages(channelArn: string): Promise<AdminConvMessage[]> {
  const res = await query<{
    message_id: string; content: string | null; sender_name: string | null;
    sender_arn: string | null; created_at: string; is_bot: boolean | null;
    bedrock_model: string | null; input_tokens: number | null; output_tokens: number | null;
    total_ms: number | null; redacted: boolean | null; deleted: boolean | null;
    metadata: Record<string, unknown> | null;
  }>(
    // Moderation (redact + delete) is archived as a sibling row, NOT a column on
    // the CREATE row: kinesis-archival suffixes the event's MessageId (`-RED` for
    // REDACT_CHANNEL_MESSAGE, `-DEL` for DELETE_CHANNEL_MESSAGE), so the moderated
    // state lands on a separate row the plain CREATE read never sees. Both are
    // derived here by LEFT JOIN. This mirrors the Athena path, where the REDACT /
    // DELETE event (same MessageId, blanked Content) supersedes the CREATE via
    // latest-per-id, yielding an empty message. Deriving at read time (rather than
    // a `messages.redacted` column) needs no migration, so it takes effect on the
    // already-bootstrapped live DB — schema-init is create-only (no-op on Update).
    `SELECT m.message_id,
            COALESCE(m.updated_content, m.content) AS content,
            m.sender_name, m.sender_arn, m.created_at, m.is_bot, m.bedrock_model,
            m.input_tokens, m.output_tokens, m.total_ms, m.metadata,
            (red.message_id IS NOT NULL) AS redacted,
            (del.message_id IS NOT NULL) AS deleted
       FROM messages m
       LEFT JOIN messages red
              ON red.channel_arn = m.channel_arn
             AND red.event_type = 'REDACT_CHANNEL_MESSAGE'
             AND red.message_id = m.message_id || '-RED'
       LEFT JOIN messages del
              ON del.channel_arn = m.channel_arn
             AND del.event_type = 'DELETE_CHANNEL_MESSAGE'
             AND del.message_id = m.message_id || '-DEL'
      WHERE m.channel_arn = $1 AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
      ORDER BY m.created_at ASC`,
    [channelArn],
  );
  return res.rows.map((r) => {
    const metadata = (r.metadata as Record<string, unknown>) || {};
    const senderArn = r.sender_arn || '';
    const redacted = r.redacted === true;
    const deleted = r.deleted === true;
    // A redacted OR deleted message must not leak its original content through the
    // admin read or the raw inspect payload — blank it, matching Athena (whose
    // superseding REDACT/DELETE row carries empty Content). `redacted` stays the
    // distinct flag the UI renders; `deleted` blanks content the same way.
    const content = redacted || deleted ? '' : stripMessageMarkers(r.content);
    return {
      id: r.message_id,
      content,
      senderArn,
      senderName: r.sender_name || 'Unknown',
      timestamp: r.created_at,
      isBot: r.is_bot === true || senderArn.includes('/bot/'),
      redacted,
      deleted,
      modelId: r.bedrock_model || undefined,
      intent: typeof metadata.intent === 'string' ? (metadata.intent as string) : undefined,
      metadata,
      // Inspect-drawer payload: the faithful stored projection of this message.
      raw: {
        MessageId: r.message_id,
        Content: redacted || deleted ? '' : r.content,
        Redacted: redacted,
        Deleted: deleted,
        Sender: { Arn: senderArn, Name: r.sender_name },
        CreatedTimestamp: r.created_at,
        BedrockModel: r.bedrock_model,
        InputTokens: r.input_tokens,
        OutputTokens: r.output_tokens,
        TotalMs: r.total_ms,
        Metadata: metadata,
      },
    };
  });
}

const MEMBERSHIP_ACTION: Record<string, string> = {
  CREATE_CHANNEL_MEMBERSHIP: 'joined',
  DELETE_CHANNEL_MEMBERSHIP: 'left',
  CREATE_CHANNEL_MODERATOR: 'granted_moderator',
  DELETE_CHANNEL_MODERATOR: 'revoked_moderator',
};

export async function adminMembershipHistory(channelArn: string): Promise<AdminMembershipEvent[]> {
  const res = await query<{
    event_type: string; member_arn: string | null; member_name: string | null;
    invited_by: string | null; at: string;
  }>(
    `SELECT event_type,
            target_arn  AS member_arn,
            content     AS member_name,
            sender_name AS invited_by,
            created_at  AS at
       FROM messages
      WHERE channel_arn = $1
        AND event_type IN ('CREATE_CHANNEL_MEMBERSHIP','DELETE_CHANNEL_MEMBERSHIP',
                           'CREATE_CHANNEL_MODERATOR','DELETE_CHANNEL_MODERATOR')
      ORDER BY created_at ASC`,
    [channelArn],
  );
  return res.rows.map((r) => {
    const memberArn = r.member_arn || '';
    return {
      action: MEMBERSHIP_ACTION[r.event_type] || r.event_type,
      memberArn,
      memberName: r.member_name || 'Unknown',
      invitedBy: r.invited_by || undefined,
      timestamp: r.at,
      isBot: memberArn.includes('/bot/'),
    };
  });
}
