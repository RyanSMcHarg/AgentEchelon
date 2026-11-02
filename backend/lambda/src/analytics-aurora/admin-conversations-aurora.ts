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
 * with Aurora access); the non-VPC admin handler invokes it (ADR-013 pattern).
 *
 * Field parity with the Athena path: the channel name is archived in `content`
 * for CREATE/UPDATE_CHANNEL rows; the member name in `content` and the inviter in
 * `sender_name` for membership rows - so nothing degrades.
 */

import { query, ownerQuery } from './db-client.js';
import { stripMessageMarkers } from '../lib/message-markers.js';
import { ARCHIVAL_SUFFIX_SQL } from './update-events.js';

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
  /** OPTIONAL: who a participant is, is a separate grant from what they said (SPEC-ADMIN-CONSOLE
   *  FR41). `admin-conversations` withholds it for a caller without the identity capability, on this
   *  path as well as the archive one. `senderArn` always identifies the sender. */
  senderName?: string;
  timestamp: string;
  isBot: boolean;
  redacted: boolean;
  /** True when a DELETE_CHANNEL_MESSAGE sibling exists — content is blanked like a
   *  redaction. Optional: the Athena path does not derive it (undefined → falsy). */
  deleted?: boolean;
  modelId?: string;
  intent?: string;
  /** True when an exchange claims this message as its answer: the only messages a flag can reach the
   *  Flagged list from. Aurora mode only; absent on the Athena path. */
  answersTurn?: boolean;
  /** Who performed the moderation + when — taken from the -RED/-DEL sibling EVENT's own
   *  sender (the actor who redacted/deleted), not the original author. Undefined if not moderated. */
  moderatedByName?: string;
  moderatedByArn?: string;
  moderatedAt?: string;
  /** Every version of an edited message, the original first and the latest last. Absent on a message
   *  never edited, and on a removed one: a removal blanks every version with the message. */
  versions?: Array<{ at: string; content: string }>;
  metadata: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface AdminMembershipEvent {
  action: string;
  memberArn: string;
  /** OPTIONAL for the reason `AdminConvMessage.senderName` is. */
  memberName?: string;
  /** The INVITER's display name, withheld under the same grant. No ARN accompanies it: the archive
   *  row carries only `sender_name`, so there is no id to fall back to. */
  invitedBy?: string;
  timestamp: string;
  isBot: boolean;
  /** True for a member the others could not see. Absent where the archive row predates recording it. */
  hidden?: boolean;
  /** True for the creating identity's own join, moderator grant and leave while it assembled the room. */
  roomSetup?: boolean;
  /** A subject change (`subject_added`, `subject_dropped`): the summarizer's label. */
  subject?: string;
  /** A drift flag (`subject_flagged`): the message that raised it, and how the offer ended. */
  messageId?: string;
  subjectOutcome?: string;
}

export interface AdminConvPage {
  conversations: AdminConvSummary[];
  total: number;
}

/**
 * One page of the admin conversation list, plus the TOTAL match count (server-side pagination).
 * `allowedClassifications` pushes the caller's classification scope INTO the SQL so the
 * page and total are consistent for a scoped admin (null = full access, no filter). COUNT(*) OVER()
 * returns the total in the same round-trip.
 */
export async function adminListConversations(
  limit = 50,
  offset = 0,
  allowedClassifications: string[] | null = null,
  /** One conversation by its ARN: the lookup by id (SPEC-ADMIN-CONSOLE FR52), under the same scope as the list. */
  channelArn: string | null = null,
  /**
   * Only conversations one of these identities was ever made a member of: a team's assistant
   * (SPEC-ADMIN-CONSOLE FR48). From the archived membership events, the same record the history reads.
   */
  memberArns: string[] | null = null,
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
          -- Not the client placeholder: the CREATE row always carries 'New conversation', which made
          -- the first_msg fallback unreachable in exactly the lost-rename case it covers.
          AND content <> 'New conversation'
        ORDER BY channel_arn, created_at DESC
     ),
     first_msg AS (
       -- Fallback title: the first human message in the conversation.
       --
       -- THE STATED CAUSE HERE WAS WRONG, and it is corrected rather than deleted because the fallback
       -- is still worth having. It claimed the title auto-derive's UpdateChannel "is not streamed to
       -- Kinesis". It IS: the immutable S3 archive carries UPDATE_CHANNEL events with real derived
       -- titles (verified 2026-08-12 - "Moon Facts Sharing", "Calculate Simple Math Problem"), and
       -- kinesis-archival deliberately stamps channel events with LastUpdatedTimestamp so a rename
       -- sorts after the create and wins the DISTINCT ON above.
       --
       -- What actually leaves a row titled 'New conversation' is a conversation whose auto-derive
       -- never RAN: the rename fires on the first user turn (async-processor-core, isFirstUserTurn),
       -- so a conversation that never had one keeps the placeholder. That is a real gap and it is
       -- what this fallback covers - deriving from the first user message, the same signal the
       -- client title-derive uses.
       SELECT DISTINCT ON (channel_arn) channel_arn,
              LEFT(REGEXP_REPLACE(content, '<!--.*?-->', '', 'g'), 60) AS name
         FROM messages
        WHERE event_type = 'CREATE_CHANNEL_MESSAGE' AND is_bot = false AND content IS NOT NULL AND content <> ''
        ORDER BY channel_arn, created_at ASC
     ),
     agg AS (
       SELECT channel_arn,
              -- The conversation's classification as its turns declared it. The deprecated user_type
              -- (migration 050) held the same value on messages archived before that column, so it
              -- answers for them - and keeps them inside the caller's classification scope below.
              COALESCE(MAX(conversation_classification), MAX(user_type)) AS classification,
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
        -- Classification scope in SQL, so LIMIT/OFFSET/total match what a scoped admin sees.
        AND ($3::text[] IS NULL OR a.classification = ANY($3))
        AND ($4::text IS NULL OR a.channel_arn = $4)
        AND ($5::text[] IS NULL OR a.channel_arn IN (
              SELECT channel_arn FROM messages
               WHERE event_type = 'CREATE_CHANNEL_MEMBERSHIP' AND target_arn = ANY($5)))
      ORDER BY a.last_message_at DESC NULLS LAST
      LIMIT $1 OFFSET $2`,
    // An EMPTY member list is a scope with nobody in it and matches no conversation; only null means
    // unscoped. Collapsing [] to null would have answered a team with every conversation.
    [lim, off, allowed, channelArn, memberArns],
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
  // AS THE OWNER: `ae_app` has no CREATE on schema public by design (ADR-028), so this DDL fails on
  // the ordinary path with `permission denied for schema public`.
  await ownerQuery(
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
  await ownerQuery(
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
    original_content: string | null; content_versions: Array<{ at: string; content: string }> | null;
    moderated_by_name: string | null; moderated_by_arn: string | null; moderated_at: string | null;
    flag_reason: string | null; flagged_at: string | null; answers_turn: boolean | null;
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
            -- Every version (migration 070): the original, then each edit in arrival order.
            m.content AS original_content, m.content_versions,
            m.sender_name, m.sender_arn, m.created_at, m.is_bot, m.bedrock_model,
            m.input_tokens, m.output_tokens, m.total_ms, m.metadata,
            -- Intent lives ONLY on the exchange (there is no messages.intent column, and it is
            -- NOT folded into messages.metadata). Pull it from the exchange this message belongs
            -- to — as either the user prompt or the agent reply — so both turns show the intent.
            (SELECT ex.intent FROM exchanges ex
              WHERE ex.agent_message_id = m.id OR ex.user_message_id = m.id
              LIMIT 1) AS intent,
            -- Whether this message is the answer of an exchange. Only an answer reaches the Flagged list,
            -- so the transcript offers the flag on nothing else.
            EXISTS (SELECT 1 FROM exchanges ex WHERE ex.agent_message_id = m.id) AS answers_turn,
            (red.message_id IS NOT NULL) AS redacted,
            (del.message_id IS NOT NULL) AS deleted,
            -- Attribution: the ACTUAL actor comes from moderation_actions, written by the analytics
            -- API at action time with the server-verified admin identity. The Chime redact/delete
            -- event keeps the original author, so it can't attribute the moderator; this can.
            ma.actor_name AS moderated_by_name, ma.actor_arn AS moderated_by_arn, ma.created_at AS moderated_at,
            -- A flag a moderator raised on this response (human_flag, migration 059). Projected so
            -- the transcript can show the control as already-flagged after a reload: without it the
            -- button state would live only in component memory, and a moderator who refreshed would
            -- be invited to flag the same response again.
            hf.reason AS flag_reason, hf.flagged_at AS flagged_at
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
       LEFT JOIN human_flag hf
              ON hf.channel_arn = m.channel_arn AND hf.message_id = m.message_id
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
    // EVERY VERSION, ONLY WHILE THE MESSAGE IS THERE. A removal blanks every version with the message,
    // because each one is what was said. Absent on a message never edited.
    const edits = Array.isArray(r.content_versions) ? r.content_versions : [];
    const versions = redacted || deleted || edits.length === 0
      ? undefined
      : [{ at: r.created_at, content: r.original_content ?? '' }, ...edits]
          .map((v) => ({ at: v.at, content: stripMessageMarkers(v.content ?? '') }));
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
      // Absent when nobody has flagged this response. Unflagged is the ABSENCE of a flag, not a
      // stored 'clear', so there is no third state to render.
      answersTurn: r.answers_turn === true,
      flagReason: r.flag_reason || undefined,
      flaggedAt: r.flagged_at || undefined,
      versions,
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
  /** OPTIONAL for the reason `AdminConvMessage.senderName` is. `null` keeps its existing meaning -
   *  the archived event carried no sender - while ABSENT means withheld. */
  senderName?: string | null;
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
 * content through ANY of its rows: the finalized text lives on an update row (a bot reply is a
 * placeholder finalized via UpdateChannelMessage), so blank the content of every message-content row
 * (CREATE and each UPDATE) whose BASE message has a `-RED`/`-DEL` sibling, not just the CREATE row.
 */
export async function adminListEvents(channelArn: string): Promise<AdminConvEvent[]> {
  const res = await query<{
    event_type: string; message_id: string | null; sender_name: string | null;
    sender_arn: string | null; target_arn: string | null; content: string | null;
    created_at: string; is_bot: boolean | null; metadata: Record<string, unknown> | null;
    moderated: boolean | null;
  }>(
    // The `-RED`/`-DEL` sibling keys off the BASE Chime MessageId. A row is a CREATE (`<base>`), one of
    // its UPDATEs (`<base>-UPD-<hash>`, one row per update event since migration 084, or `<base>-UPD`
    // before it), or a moderation event (`<base>-RED`/`-DEL`); strip any suffix to the base before
    // checking, so every update row, the finalized content among them, is caught too.
    //
    // EVERY UPDATE ROW IS LISTED: this is the event log, and each update is an event. They share the
    // message's CreatedTimestamp, so they are ordered among themselves by their own instant.
    `SELECT m.event_type, m.message_id, m.sender_name, m.sender_arn, m.target_arn,
            COALESCE(m.updated_content, m.content) AS content, m.created_at, m.is_bot, m.metadata,
            EXISTS (
              SELECT 1 FROM messages x
               WHERE x.channel_arn = m.channel_arn
                 AND x.event_type IN ('REDACT_CHANNEL_MESSAGE','DELETE_CHANNEL_MESSAGE')
                 AND x.message_id IN (
                       regexp_replace(m.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-RED',
                       regexp_replace(m.message_id, ${ARCHIVAL_SUFFIX_SQL}, '') || '-DEL')
            ) AS moderated
       FROM messages m
      WHERE m.channel_arn = $1
      ORDER BY m.created_at ASC, m.event_type ASC, m.last_updated_at ASC NULLS FIRST, m.message_id ASC`,
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

/** How long after CREATE_CHANNEL the creating identity's own membership events count as assembling the room. */
const ROOM_SETUP_WINDOW_MS = 2 * 60_000;

export async function adminMembershipHistory(channelArn: string): Promise<AdminMembershipEvent[]> {
  // WHO CREATED THE ROOM, AND WHEN. A person-created conversation is created by the service admin, which
  // joins, is made moderator by the service, and leaves once the room is assembled (channel-creation.ts
  // CREATOR_BEARER_ARN). Those rows are true and stay in the record; they are marked as room setup so
  // the console does not read them as somebody entering the conversation. Only the creating PERSON
  // identity's own events, and only inside the window: the same admin joining later, to oversee, is not
  // setup and is not marked.
  const res = await query<{
    event_type: string; member_arn: string | null; member_name: string | null;
    invited_by: string | null; at: string; membership_type: string | null;
    creator_arn?: string | null; channel_created_at?: string | null;
  }>(
    `SELECT event_type,
            (SELECT c.sender_arn FROM messages c WHERE c.channel_arn = $1 AND c.event_type = 'CREATE_CHANNEL'
              ORDER BY c.created_at ASC LIMIT 1) AS creator_arn,
            (SELECT MIN(c.created_at) FROM messages c WHERE c.channel_arn = $1 AND c.event_type = 'CREATE_CHANNEL')
              AS channel_created_at,
            metadata->>'membershipType' AS membership_type,
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
  const membership: AdminMembershipEvent[] = res.rows.map((r) => {
    const memberArn = r.member_arn || '';
    const setupBy = (r.creator_arn || '').includes('/user/') ? r.creator_arn : '';
    const createdAt = Date.parse(String(r.channel_created_at ?? '')) || 0;
    return {
      action: MEMBERSHIP_ACTION[r.event_type] || r.event_type,
      memberArn,
      memberName: r.member_name || 'Unknown',
      invitedBy: r.invited_by || undefined,
      timestamp: r.at,
      isBot: memberArn.includes('/bot/'),
      ...(setupBy && memberArn === setupBy && (Date.parse(String(r.at)) || 0) - createdAt <= ROOM_SETUP_WINDOW_MS
        ? { roomSetup: true } : {}),
      // Known only for events archived since the type was kept; older rows answer undefined, not false.
      ...(r.membership_type ? { hidden: r.membership_type === 'HIDDEN' } : {}),
    };
  });
  const subjects = await subjectTimeline(channelArn);
  if (!subjects.length) return membership;
  const at = (e: AdminMembershipEvent) => Date.parse(e.timestamp) || 0;
  return [...membership, ...subjects].sort((a, b) => at(a) - at(b));
}

/**
 * WHEN THE CONVERSATION'S SUBJECT CHANGED, read from what is already stored, so no
 * turn pays for it: a drift flag and how it ended (`drift_events`, live offers only), and the subjects each
 * summary version added or dropped against the one before (`conversation_summaries` keeps every version).
 *
 * Folded into the membership timeline as its own actions, so the conversation record shows a context change
 * where it happened. "Kept here" is the flag's outcome rather than its own row: the adoption time lives on a
 * classification-bounded vector table this read is not a role for. Best-effort: a failed read leaves the
 * membership timeline as it was.
 */
async function subjectTimeline(channelArn: string): Promise<AdminMembershipEvent[]> {
  try {
    const [flags, versions] = await Promise.all([
      query<{ occurred_at: string; originating_message_id: string | null; outcome: string | null; new_channel_arn: string | null; outcome_at: string | null }>(
        `SELECT occurred_at, originating_message_id, outcome, new_channel_arn, outcome_at FROM drift_events
          WHERE parent_channel_arn = $1 AND COALESCE(source, 'live') = 'live'
          ORDER BY occurred_at ASC`,
        [channelArn],
      ),
      query<{ version: number; topics: string[] | null; created_at: string }>(
        `SELECT version, topics, created_at FROM conversation_summaries
          WHERE channel_arn = $1 ORDER BY version ASC`,
        [channelArn],
      ),
    ]);
    // THE FLAG AND ITS OUTCOME ARE TWO ROWS, each at its own time (migration 077 records when an outcome was
    // decided); a row written before that falls back to the flag's time.
    const out: AdminMembershipEvent[] = [];
    for (const f of flags?.rows ?? []) {
      out.push({
        action: 'subject_flagged',
        memberArn: '',
        timestamp: String(f.occurred_at),
        isBot: false,
        ...(f.originating_message_id ? { messageId: f.originating_message_id } : {}),
      });
      if (f.outcome) {
        out.push({
          action: 'subject_resolved',
          memberArn: '',
          timestamp: String(f.outcome_at ?? f.occurred_at),
          isBot: false,
          // `abandoned` covers two endings: a split-out conversation nobody used, and an offer nobody answered
          // (abandonment-detector.ts). Only the first has a new conversation, so that is what tells them apart.
          subjectOutcome: f.outcome === 'abandoned' && !f.new_channel_arn ? 'unanswered' : f.outcome,
        });
      }
    }
    let previous = new Map<string, string>();
    for (const v of versions?.rows ?? []) {
      const current = new Map((v.topics ?? []).map((t) => [t.trim().toLowerCase(), t.trim()] as const).filter(([k]) => k));
      for (const [key, subject] of current) {
        if (!previous.has(key)) out.push({ action: 'subject_added', memberArn: '', subject, timestamp: String(v.created_at), isBot: false });
      }
      for (const [key, subject] of previous) {
        if (!current.has(key)) out.push({ action: 'subject_dropped', memberArn: '', subject, timestamp: String(v.created_at), isBot: false });
      }
      previous = current;
    }
    return out;
  } catch (err) {
    console.warn('[admin-conversations] subject timeline unavailable', { err: (err as { name?: string })?.name });
    return [];
  }
}
