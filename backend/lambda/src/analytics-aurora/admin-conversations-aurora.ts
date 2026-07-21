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
  /** Lifecycle state derived from the archived channel events: 'deleted' when a
   *  DELETE_CHANNEL row exists, else 'archived' when a channel event carries the
   *  archived metadata mirror (conversation-management.ts), else 'live'. Deleted
   *  wins over archived. */
  state: 'live' | 'archived' | 'deleted';
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
  /** Who performed the moderation + when — taken from the -RED/-DEL sibling EVENT's own
   *  sender (the actor who redacted/deleted), not the original author. Undefined if not moderated. */
  moderatedByName?: string;
  moderatedByArn?: string;
  moderatedAt?: string;
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

export interface AdminConvPage {
  conversations: AdminConvSummary[];
  total: number;
}

/**
 * One page of the admin conversation list, plus the TOTAL match count (server-side pagination).
 * `allowedClassifications` pushes the caller's classification-ceiling scope INTO the SQL so the
 * page and total are consistent for a scoped admin (null = full access, no filter). COUNT(*) OVER()
 * returns the total in the same round-trip.
 */
export async function adminListConversations(
  limit = 50,
  offset = 0,
  allowedClassifications: string[] | null = null,
): Promise<AdminConvPage> {
  const lim = Math.min(Math.max(1, limit), 200);
  const off = Math.max(0, offset);
  const allowed = allowedClassifications && allowedClassifications.length ? allowedClassifications : null;
  const res = await query<{
    channel_arn: string; classification: string | null; name: string | null;
    message_count: string; last_message_at: string | null; member_count: string;
    is_deleted: boolean; is_archived: boolean; total_count: string;
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
              MAX(user_type) AS classification,
              COUNT(*) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE') AS message_count,
              MAX(created_at) FILTER (WHERE event_type = 'CREATE_CHANNEL_MESSAGE') AS last_message_at
         FROM messages
        GROUP BY channel_arn
     ),
     lifecycle AS (
       -- Channel lifecycle from the archived channel events. A DELETE_CHANNEL row
       -- means the Chime channel was deleted (the archive rows persist). The
       -- archived state is mirrored into channel Metadata by conversation-management
       -- (the tag is authoritative but tags are not streamed to Kinesis; the
       -- UpdateChannel metadata mirror IS), captured onto the row's metadata column.
       -- There is no un-archive path, so presence is authoritative. Deleted wins.
       SELECT channel_arn,
              bool_or(event_type = 'DELETE_CHANNEL') AS is_deleted,
              bool_or(metadata->>'archived' = 'true') AS is_archived
         FROM messages
        WHERE event_type IN ('CREATE_CHANNEL','UPDATE_CHANNEL','DELETE_CHANNEL')
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
     SELECT a.channel_arn, a.classification, COALESCE(n.name, fm.name) AS name,
            a.message_count::text AS message_count, a.last_message_at,
            COALESCE(mem.member_count, 0)::text AS member_count,
            COALESCE(lc.is_deleted, false) AS is_deleted,
            COALESCE(lc.is_archived, false) AS is_archived,
            COUNT(*) OVER()::text AS total_count
       FROM agg a
       LEFT JOIN names n ON n.channel_arn = a.channel_arn
       LEFT JOIN first_msg fm ON fm.channel_arn = a.channel_arn
       LEFT JOIN members mem ON mem.channel_arn = a.channel_arn
       LEFT JOIN lifecycle lc ON lc.channel_arn = a.channel_arn
      WHERE a.message_count > 0
        -- Classification-ceiling scope in SQL, so LIMIT/OFFSET/total match what a scoped admin sees.
        AND ($3::text[] IS NULL OR a.classification = ANY($3))
      ORDER BY a.last_message_at DESC NULLS LAST
      LIMIT $1 OFFSET $2`,
    [lim, off, allowed],
  );
  const total = res.rows[0]?.total_count != null ? Number(res.rows[0].total_count) : res.rows.length;
  const conversations = res.rows.map((r) => ({
    channelArn: r.channel_arn,
    name: r.name || 'Untitled Conversation',
    messageCount: Number(r.message_count || 0),
    lastMessageAt: r.last_message_at || undefined,
    memberCount: Number(r.member_count || 0),
    state: (r.is_deleted ? 'deleted' : r.is_archived ? 'archived' : 'live') as 'live' | 'archived' | 'deleted',
    metadata: { modelTier: r.classification || '' },
  }));
  return { conversations, total };
}

// moderation_actions holds WHO redacted/deleted WHICH message, stamped by the analytics API at
// action time with the SERVER-VERIFIED admin identity (the Chime redact/delete event keeps the
// original author, so it can't attribute the moderator). The live DB won't re-bootstrap
// (schema-init is Create-only), so ensure the table at runtime; migration 012 covers fresh
// bootstraps. Memoized per container.
let moderationTableReady = false;
async function ensureModerationTable(): Promise<void> {
  if (moderationTableReady) return;
  await query(
    `CREATE TABLE IF NOT EXISTS moderation_actions (
       id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       channel_arn VARCHAR(512) NOT NULL,
       message_id  VARCHAR(128) NOT NULL,
       action      VARCHAR(16)  NOT NULL,
       actor_sub   VARCHAR(128) NOT NULL,
       actor_name  VARCHAR(256),
       actor_arn   VARCHAR(512),
       created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
     )`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_moderation_actions_msg ON moderation_actions(channel_arn, message_id)`,
  );
  moderationTableReady = true;
}

/** Record a moderation action with the server-verified actor. The analytics API's
 *  record-moderation handler is the ONLY writer (it derives the actor from the JWT, never
 *  the client body). Best-effort: the Chime redact/delete already succeeded client-side. */
export async function recordModerationAction(input: {
  channelArn: string; messageId: string; action: 'redact' | 'delete';
  actorSub: string; actorName?: string; actorArn?: string;
}): Promise<void> {
  await ensureModerationTable();
  await query(
    `INSERT INTO moderation_actions (channel_arn, message_id, action, actor_sub, actor_name, actor_arn)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.channelArn, input.messageId, input.action, input.actorSub, input.actorName || null, input.actorArn || null],
  );
}

export async function adminListMessages(channelArn: string): Promise<AdminConvMessage[]> {
  await ensureModerationTable();
  const res = await query<{
    message_id: string; content: string | null; sender_name: string | null;
    sender_arn: string | null; created_at: string; is_bot: boolean | null;
    bedrock_model: string | null; input_tokens: number | null; output_tokens: number | null;
    total_ms: number | null; redacted: boolean | null; deleted: boolean | null;
    metadata: Record<string, unknown> | null; intent: string | null;
    moderated_by_name: string | null; moderated_by_arn: string | null; moderated_at: string | null;
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
            -- Intent lives ONLY on the exchange (there is no messages.intent column, and it is
            -- NOT folded into messages.metadata). Pull it from the exchange this message belongs
            -- to — as either the user prompt or the agent reply — so both turns show the intent.
            (SELECT ex.intent FROM exchanges ex
              WHERE ex.agent_message_id = m.id OR ex.user_message_id = m.id
              LIMIT 1) AS intent,
            (red.message_id IS NOT NULL) AS redacted,
            (del.message_id IS NOT NULL) AS deleted,
            -- Attribution: the ACTUAL actor comes from moderation_actions, written by the analytics
            -- API at action time with the server-verified admin identity. The Chime redact/delete
            -- event keeps the original author, so it can't attribute the moderator; this can.
            ma.actor_name AS moderated_by_name, ma.actor_arn AS moderated_by_arn, ma.created_at AS moderated_at
       FROM messages m
       LEFT JOIN messages red
              ON red.channel_arn = m.channel_arn
             AND red.event_type = 'REDACT_CHANNEL_MESSAGE'
             AND red.message_id = m.message_id || '-RED'
       LEFT JOIN messages del
              ON del.channel_arn = m.channel_arn
             AND del.event_type = 'DELETE_CHANNEL_MESSAGE'
             AND del.message_id = m.message_id || '-DEL'
       LEFT JOIN LATERAL (
              SELECT actor_name, actor_arn, created_at
                FROM moderation_actions
               WHERE channel_arn = m.channel_arn AND message_id = m.message_id
               ORDER BY created_at DESC LIMIT 1
            ) ma ON true
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
    // Attribution from the moderation_actions audit (server-verified actor). Null when no
    // audit row exists (bot self-delete, or a moderation before audit logging) → the UI
    // falls back to the role ("by an admin" / "by a moderator").
    const moderatedByName = r.moderated_by_name;
    const moderatedByArn = r.moderated_by_arn;
    const moderatedAt = r.moderated_at;
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
      intent: r.intent || undefined,
      moderatedByName: moderatedByName || undefined,
      moderatedByArn: moderatedByArn || undefined,
      moderatedAt: moderatedAt || undefined,
      metadata,
      // Inspect-drawer payload: the faithful stored projection of this message.
      raw: {
        MessageId: r.message_id,
        Content: redacted || deleted ? '' : r.content,
        Redacted: redacted,
        Deleted: deleted,
        ModeratedBy: moderatedByArn ? { Arn: moderatedByArn, Name: moderatedByName } : undefined,
        ModeratedAt: moderatedAt || undefined,
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

export interface AdminConvEvent {
  eventType: string;
  messageId: string | null;
  senderName: string | null;
  senderArn: string | null;
  targetArn: string | null;
  content: string | null;
  createdAt: string;
  isBot: boolean;
  metadata: Record<string, unknown> | null;
}

/**
 * The COMPLETE archived event log for a channel — every event_type (message
 * create/update/redact/delete, membership create/update/delete, channel create/update/delete)
 * ordered by time. For the dev-persona "all events" view. A redacted/deleted message must not leak
 * content through ANY of its rows: the finalized text lives on the `-UPD` row (a bot reply is a
 * placeholder finalized via UpdateChannelMessage), so blank the content of every message-content row
 * (CREATE and UPDATE) whose BASE message has a `-RED`/`-DEL` sibling, not just the CREATE row.
 */
export async function adminListEvents(channelArn: string): Promise<AdminConvEvent[]> {
  const res = await query<{
    event_type: string; message_id: string | null; sender_name: string | null;
    sender_arn: string | null; target_arn: string | null; content: string | null;
    created_at: string; is_bot: boolean | null; metadata: Record<string, unknown> | null;
    moderated: boolean | null;
  }>(
    // The `-RED`/`-DEL` sibling keys off the BASE Chime MessageId. A row is a CREATE (`<base>`), an
    // UPDATE (`<base>-UPD`), or a moderation event (`<base>-RED`/`-DEL`); strip any suffix to the base
    // before checking, so the finalized-content `-UPD` row is caught too (the earlier version keyed
    // on the row's own id and missed it).
    `SELECT m.event_type, m.message_id, m.sender_name, m.sender_arn, m.target_arn,
            COALESCE(m.updated_content, m.content) AS content, m.created_at, m.is_bot, m.metadata,
            EXISTS (
              SELECT 1 FROM messages x
               WHERE x.channel_arn = m.channel_arn
                 AND x.event_type IN ('REDACT_CHANNEL_MESSAGE','DELETE_CHANNEL_MESSAGE')
                 AND x.message_id IN (
                       regexp_replace(m.message_id, '-(UPD|RED|DEL)$', '') || '-RED',
                       regexp_replace(m.message_id, '-(UPD|RED|DEL)$', '') || '-DEL')
            ) AS moderated
       FROM messages m
      WHERE m.channel_arn = $1
      ORDER BY m.created_at ASC, m.event_type ASC`,
    [channelArn],
  );
  return res.rows.map((r) => {
    // Blank content for ANY message-content row (CREATE or the finalized UPDATE) of a moderated
    // message, so a redact/delete cannot leak the original or final text through this view.
    const isMessageContent =
      r.event_type === 'CREATE_CHANNEL_MESSAGE' || r.event_type === 'UPDATE_CHANNEL_MESSAGE';
    const blank = r.moderated === true && isMessageContent;
    return {
      eventType: r.event_type,
      messageId: r.message_id,
      senderName: r.sender_name,
      senderArn: r.sender_arn,
      targetArn: r.target_arn,
      content: blank ? '' : r.content ? stripMessageMarkers(r.content) : r.content,
      createdAt: r.created_at,
      isBot: r.is_bot === true,
      metadata: (r.metadata as Record<string, unknown>) || null,
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
