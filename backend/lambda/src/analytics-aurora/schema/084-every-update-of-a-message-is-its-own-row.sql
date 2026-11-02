-- ============================================================================
-- 084: every update of a message is its own row.
--
-- The archive is a stream of events, and an event is never updated (tenet D7). Archival keyed every
-- UPDATE_CHANNEL_MESSAGE of a message as one fixed `<MessageId>-UPD` row, so a message's second update
-- collided with the first on (message_id, channel_arn) and ON CONFLICT DO NOTHING dropped it. A
-- placeholder that became the queue notice and then a receipt kept the notice's queue_ack and lost the
-- receipt. Archival now keys each update by the event itself, `<MessageId>-UPD-<12 hex>` over the
-- event's LastUpdatedTimestamp, Content and Metadata (update-events.ts), so a second update is a row
-- of its own and a redelivery lands on the row it already wrote.
--
-- WHAT THIS ADDS.
--   base_message_id  the MessageId a message event is about: the CREATE row's own id, shared by each
--                    of its updates, its redaction and its deletion. A reader finds a message's
--                    updates by this equality instead of by the id's suffix.
--   last_updated_at  the event's own LastUpdatedTimestamp. created_at keeps the message's original
--                    CreatedTimestamp on every event, so it cannot order a message's updates.
--   an index on a message's update rows, for the lateral that picks the latest (or the first).
--
-- EXISTING ROWS. base_message_id is derived here from the archived id, for every message event, in
-- bounded batches that touch only rows still NULL. A reader finds a pre-084 row once its batch has run,
-- which on a development-sized projection is the first cold start. A pre-084 update row keeps its fixed id and a
-- NULL last_updated_at: it is the only update row its message has, and every reader orders it as the
-- earliest of the message's updates, which it is. The updates it dropped are not in the projection and
-- are not invented here; they are in the S3 archive. No rebuild-from-archive job exists (AURORA-MODE-
-- GUIDE.md, "Rebuilding the projection"), so they stay absent from this projection; a teardown and
-- fresh deploy starts a projection that keeps every update from its first event. The readers keep
-- naming the pre-084 messages as before: a queue notice closed out as a receipt is still read as a
-- receipt (analytics-query.ts, noticeClosedAsReceiptSql).
--
-- THE VIEW. v_turn_latency read the response's update row by the fixed id. It is replaced with the 080
-- body and that one join changed to the latest update row, generated from 080 rather than retyped so
-- the two cannot drift by transcription. Every other line is 080's.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, a bounded UPDATE guarded on NULL that
-- reports its remaining work, CREATE INDEX IF NOT EXISTS without CONCURRENTLY, and CREATE OR REPLACE
-- VIEW with the same columns in the same order.
-- ============================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS base_message_id VARCHAR(128);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS _migration_progress (
    filename VARCHAR(256) PRIMARY KEY,
    remaining BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A BOUNDED BATCH THAT RESUMES (AURORA-MODE-GUIDE.md, the 029 pattern). messages accumulates for the
-- life of the cluster, and every pending migration shares one transaction in one Lambda invocation, so
-- a single statement over all of it could outrun the invocation and commit nothing. Each run stamps one
-- batch and reports what is left; the file stays pending until that is zero. Every other statement in
-- this file is idempotent, so a re-run repeats them harmlessly.
DO $base_ids$
DECLARE
    batch_size CONSTANT INT := 20000;
    left_to_do BIGINT;
BEGIN
    UPDATE messages
       SET base_message_id = regexp_replace(message_id, '-(UPD(-[0-9a-f]{12})?|RED|DEL)$', '')
     WHERE ctid IN (
         SELECT ctid
           FROM messages
          WHERE base_message_id IS NULL
            AND event_type IN ('CREATE_CHANNEL_MESSAGE', 'UPDATE_CHANNEL_MESSAGE',
                               'REDACT_CHANNEL_MESSAGE', 'DELETE_CHANNEL_MESSAGE')
          LIMIT batch_size
     );

    SELECT COUNT(*) INTO left_to_do
      FROM messages
     WHERE base_message_id IS NULL
       AND event_type IN ('CREATE_CHANNEL_MESSAGE', 'UPDATE_CHANNEL_MESSAGE',
                          'REDACT_CHANNEL_MESSAGE', 'DELETE_CHANNEL_MESSAGE');

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('084-every-update-of-a-message-is-its-own-row.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END
$base_ids$;

CREATE INDEX IF NOT EXISTS idx_messages_update_events
    ON messages (channel_arn, base_message_id, last_updated_at)
 WHERE event_type = 'UPDATE_CHANNEL_MESSAGE';

CREATE OR REPLACE VIEW v_turn_latency AS
WITH
anchor AS (
    SELECT turn_id,
           MIN(occurred_at) FILTER (WHERE kind = 'user_message') AS t0_user_at,
           MIN(turn_id_source) FILTER (WHERE kind = 'user_message') AS turn_id_source
      FROM turn_events
     WHERE turn_id IS NOT NULL
     GROUP BY turn_id
),
resp AS (
    SELECT MAX(turn_id)::VARCHAR(64) AS turn_id,
           response_id,
           channel_arn::text AS channel_arn,
           MIN(occurred_at) FILTER (WHERE kind = 'placeholder_posted')     AS t2_placeholder_at,
           MIN(occurred_at) FILTER (WHERE kind = 'final_response')         AS t3_final_at,
           MIN(occurred_at) FILTER (WHERE kind = 'processor_entry')        AS entry_at,
           COUNT(*)         FILTER (WHERE kind = 'progress_update')        AS progress_update_count,
           MIN(occurred_at) FILTER (WHERE kind IN ('content_edited','content_redacted','message_deleted'))
                                                                           AS superseded_at,
           -- FROM WHICHEVER ROW DECLARES ONE, not only the placeholder. See 038.
           MIN(trigger_kind) FILTER (WHERE trigger_kind IS NOT NULL)        AS trigger_kind,
           MIN(battle_round) FILTER (WHERE kind = 'placeholder_posted')    AS battle_round,
           MIN(actor)       FILTER (WHERE kind = 'placeholder_posted')     AS responder
      FROM turn_events
     WHERE response_id IS NOT NULL
     GROUP BY response_id, channel_arn
    -- A RESPONSE MADE ONLY OF NOTICES IS NOT A RESPONSE (051). `kind` is NOT NULL, so `bool_or` over
    -- a group is TRUE exactly when at least one row is something other than the deferral
    -- acknowledgement. A turn that recorded a notice alongside a placeholder keeps every row it has.
    HAVING bool_or(kind <> 'notice_posted')
)
SELECT
    r.turn_id,
    r.response_id,
    r.channel_arn,
    a.turn_id_source,
    r.trigger_kind,
    r.battle_round,
    r.responder,
    m.agent_type,
    e.delivery_option,
    e.task_id,

    COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at)              AS t0_user_at,
    r.t2_placeholder_at,
    r.t3_final_at,
    r.entry_at,                                            -- SERVER clock

    CASE WHEN COALESCE(r.trigger_kind, 'user') IN ('user','handover','repair','recovery')
              -- A LATER DUEL ROUND IS NEVER A PERSON'S WAIT (071), whatever kind it declared or failed
              -- to declare.
              AND COALESCE(r.battle_round, 1) <= 1
              AND COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at - COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at))) * 1000)::integer END AS ttff_ms,
    -- ROUND TWO IS MEASURED FROM THE INSTANT IT WAS TRIGGERED (071). The orchestrator declares that
    -- instant as trigger_at; the person's message is never this row's start, and with no declared
    -- instant the figure is NULL rather than a span covering both rounds.
    CASE WHEN COALESCE(r.battle_round, 1) > 1
         THEN CASE WHEN m.trigger_at IS NOT NULL
                        AND r.t3_final_at >= m.trigger_at
                   THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END
         WHEN COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at) IS NOT NULL
              AND r.t3_final_at >= COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at))) * 1000)::integer END       AS e2e_ms,
    CASE WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
              AND r.t3_final_at >= r.t2_placeholder_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - r.t2_placeholder_at)) * 1000)::integer END AS answer_ms,

    m.total_ms, m.latency_ms, m.model_ms, m.tool_ms, m.poll_ms,
    e.inbound_ms,

    -- The same end to end as above, round two included, less what the brackets claim.
    (CASE WHEN COALESCE(r.battle_round, 1) > 1
          THEN CASE WHEN m.trigger_at IS NOT NULL AND r.t3_final_at IS NOT NULL
                    THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END
          WHEN COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at) IS NOT NULL AND r.t3_final_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at))) * 1000)::integer END
     - COALESCE(e.inbound_ms, 0) - COALESCE(m.total_ms, 0))                  AS unattributed_ms,
    (m.total_ms - COALESCE(m.latency_ms, 0) - COALESCE(m.poll_ms, 0))        AS overhead_ms,
    (m.latency_ms - COALESCE(m.model_ms, 0) - COALESCE(m.tool_ms, 0))        AS loop_residual_ms,

    CASE
        WHEN r.t2_placeholder_at IS NOT NULL AND COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at) IS NOT NULL
             AND r.t2_placeholder_at < COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at)  THEN 'anomalous'
        WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
             AND r.t3_final_at < r.t2_placeholder_at                       THEN 'anomalous'
        WHEN r.t3_final_at IS NOT NULL                                     THEN 'complete'
        WHEN r.progress_update_count > 0                                   THEN 'awaiting_user'
        ELSE 'unresolved'
    END                                                                     AS status,
    r.progress_update_count,
    r.superseded_at,
    (r.t2_placeholder_at > NOW() - INTERVAL '90 days')                      AS in_stream_window,

    CASE WHEN a.t0_user_at      IS NOT NULL THEN 'ledger'
         WHEN e.user_message_at IS NOT NULL THEN 'exchange'
         WHEN tx.user_message_at IS NOT NULL THEN 'declared_target'
    END                                                                     AS anchor_source,

    -- THE CAUSE INSTANT, declared first and derived only as a fallback (034).
    COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at), trg.trigger_at) AS trigger_at,
    CASE WHEN COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at), trg.trigger_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at), trg.trigger_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at
                                   - COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at), trg.trigger_at))) * 1000)::integer
    END                                                                     AS ack_ms,
    -- Provenance, and it now has three states rather than two. 'declared' covers both a producer's own
    -- instant and a real user message - in both cases the anchor was OBSERVED rather than reconstructed
    -- - while 'derived' marks the 033 rule, which is a reconstruction and must never read as one.
    CASE WHEN m.trigger_at IS NOT NULL                             THEN 'declared'
         WHEN COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at) IS NOT NULL THEN 'declared'
         WHEN trg.trigger_at IS NOT NULL                            THEN 'derived'
    END                                                                     AS ack_source
  FROM resp r
  LEFT JOIN anchor   a ON a.turn_id = r.turn_id
  LEFT JOIN messages m ON m.message_id = r.response_id AND m.channel_arn = r.channel_arn
                      AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
  LEFT JOIN LATERAL (
      SELECT ex.delivery_option, ex.task_id, ex.inbound_ms, ex.user_message_at
        FROM exchanges ex
       WHERE ex.agent_message_id = m.id
         -- A QUEUED EXCHANGE IS NOT THIS TURN'S PAIRING (052). A folded answer carries one exchange
         -- per queued message it rolled in, on this same message; taking one as the anchor would
         -- measure the turn from a message it was not answering. The turn's own exchange is minted
         -- against the acknowledgment it closes out and carries no label.
         AND ex.queued_as IS NULL
         -- A REBUTTAL IS NOT THIS TURN'S PAIRING EITHER (064, kept by 071), for the same reason and with the
         -- same shape. A round-2 duel turn answers onto its rival's reply, not onto the person, so
         -- its exchange carries the ORIGINAL user message as the inbound instant. Anchoring here
         -- would measure a rebuttal from a message two rounds earlier and report that as time to
         -- first feedback - minutes, on the population that measures seconds.
         AND COALESCE(ex.battle_round, 1) <= 1
       ORDER BY ex.created_at
       LIMIT 1
  ) e ON TRUE
  -- THE RESPONSE'S LATEST UPDATE ROW, for the kind and the target it declared there (080, 084). Every
  -- update is its own row, and the latest is what the message declared last: a notice later closed out
  -- as a receipt reads as the receipt. Ordered by the event's own instant, a pre-084 row (NULL) last,
  -- then arrival and id, the order updateJoinSql uses (update-events.ts). LIMIT 1, so one row or none.
  LEFT JOIN LATERAL (
      SELECT mu_ev.* FROM messages mu_ev
       WHERE mu_ev.channel_arn = m.channel_arn
         AND mu_ev.event_type = 'UPDATE_CHANNEL_MESSAGE'
         AND mu_ev.base_message_id = m.message_id
       ORDER BY mu_ev.last_updated_at DESC NULLS LAST, mu_ev.archived_at DESC, mu_ev.message_id DESC
       LIMIT 1
  ) mu ON TRUE
  -- A PLACEHOLDER WHOSE ANSWER MOVED IS ANCHORED BY THE TARGET IT DECLARED (080). A receipt or a
  -- notice written into the placeholder pairs with nothing, so it has no exchange of its own; the
  -- moved answer's exchange names the same person's message. Anchoring the placeholder there keeps
  -- the turn's time to first feedback, which is the placeholder's post. Only these two kinds, and
  -- never through a swept pairing, which is a reconstruction rather than a declaration.
  LEFT JOIN LATERAL (
      SELECT ex.user_message_at
        FROM exchanges ex
        JOIN messages um ON um.id = ex.user_message_id
       WHERE e.user_message_at IS NULL
         AND COALESCE(mu.turn_kind, m.turn_kind, mu.metadata->>'turnKind', m.metadata->>'turnKind')
             IN ('receipt', 'queue_ack')
         AND um.channel_arn = m.channel_arn
         AND um.message_id = COALESCE(mu.answers_message_id, m.answers_message_id,
                                      mu.metadata->>'answersMessageId', m.metadata->>'answersMessageId')
         AND ex.queued_as IS NULL
         AND COALESCE(ex.battle_round, 1) <= 1
         AND ex.paired_by IS DISTINCT FROM 'swept'
       ORDER BY ex.created_at
       LIMIT 1
  ) tx ON TRUE
  -- The 033 derived rule, now a FALLBACK for rows written before the producers declared their own
  -- instant. Kept rather than dropped: history does not get re-dispatched, so removing it would blank
  -- the only measurement those turns will ever have.
  LEFT JOIN LATERAL (
      SELECT MAX(te.occurred_at) AS trigger_at
        FROM turn_events te
       WHERE r.trigger_kind IS NOT NULL
         AND r.trigger_kind <> 'user'
         AND m.trigger_at IS NULL
         AND te.channel_arn = r.channel_arn
         AND te.kind = 'final_response'
         AND te.occurred_at < r.t2_placeholder_at
         AND te.occurred_at > r.t2_placeholder_at - INTERVAL '10 minutes'
         AND (te.actor IS DISTINCT FROM r.responder)
  ) trg ON TRUE;
