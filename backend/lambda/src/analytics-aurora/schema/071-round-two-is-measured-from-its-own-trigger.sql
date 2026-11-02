-- ============================================================================
-- 071: round two is measured from the instant it was triggered.
--
-- A battle's round-2 rebuttal has an end to end of its own: from the instant round two was triggered
-- to the rebuttal's final answer. The battle orchestrator declares that instant on each rebuttal as
-- messages.trigger_at, the carrier migration 034 established for a turn nobody sent. It is the duel's
-- last round-1 terminal transition, the write that fires the orchestrator, so every side of one duel
-- carries the same instant.
--
-- WHAT THIS VIEW DOES WITH IT. For a row whose battle_round is past the first:
--   e2e_ms          is final_response less trigger_at, and NULL when the turn declares no trigger_at.
--   unattributed_ms is that end to end less inbound_ms and total_ms, the same residual as every row.
--   ttff_ms         is NULL. A rebuttal is nobody's wait: the interaction-kind gate already says so for
--                   a row that declared its kind, and the round says so for a row that did not.
-- The person's message is never the start for such a row. The 064 guard stays in the anchor lateral,
-- so a round-2 row with no declared trigger has no end to end, rather than one spanning both rounds.
-- Every first-round and ordinary row computes exactly what 064 computes.
--
-- ONE ANCHOR FOR ACK AND END TO END, WHEN THE TRIGGER IS DECLARED. For a rebuttal that declares
-- trigger_at, ack_ms starts there and the end to end starts at the same instant and ends at the final
-- answer, so the two describe one interval split at the placeholder. For a rebuttal that declares no
-- trigger_at the two part: the end to end is NULL, while ack_ms falls back to the person anchor or the
-- 033 derived instant, exactly as 064 computes it.
--
-- CLOCKS. trigger_at is the orchestrator's server clock and final_response is the Amazon Chime SDK
-- clock, so a round-2 end to end crosses clocks exactly as its ack_ms does. Every first-round figure
-- stays on the Amazon Chime SDK clock alone.
--
-- OLDER REBUTTALS. A rebuttal archived before the orchestrator declared the round-two trigger carries
-- its rival's round-1 completion as trigger_at. For the side that finished round 1 first the two
-- instants are the same. For the side that finished second the older instant is earlier by the gap
-- between the two completions, so that side's end to end reads longer by that gap.
--
-- THE EXCHANGE ROWS. exchanges.e2e_ms is the second opinion the shadow diff compares this view against.
-- The repair at the end recomputes round-2 exchanges by the rule the archival writers apply
-- (exchangeE2eSql in kinesis-archival.ts): e2e_ms from trigger_at to agent_final_at, and inbound_ms and
-- response_latency_ms NULL, since both are spans from the person's message. It is deterministic, so a
-- second run changes no row.
--
-- WHICH EXCHANGES IT READS. Only duel rows, found through the partial index migration 057 built on
-- exchanges.battle_id, so the repair never joins the whole exchanges table to messages. A round-2
-- exchange whose own battle_id is NULL (the duel id never reached the exchange row) is outside the
-- repair and keeps the value it has until the archival fold next writes it. The ledger never reads that
-- value: the anchor lateral excludes every round-2 exchange.
--
-- BOUNDED AND RESUMABLE. One batch per application, with the rows still to convert reported in
-- _migration_progress (029, 066), so a deployment with many duels converges over successive cold starts
-- rather than overrunning one invocation and committing nothing. Nothing later depends on the repair
-- having finished.
--
-- WHO READS IT. Round two keeps out of the headline end to end, which describes a person's wait
-- (getLatencyMetrics), and appears as the rebuttal row of the per-interaction breakdown, labeled as
-- battle round 2 (getLatencyByInteraction).
--
-- Idempotent and transaction-safe: CREATE OR REPLACE VIEW with the same columns in the same order, a
-- bounded UPDATE that converges, and no CONCURRENTLY. The view body is the 064 definition with the changes above
-- applied, generated from that file rather than retyped so the two cannot drift by transcription.
-- ============================================================================

COMMENT ON COLUMN messages.trigger_at IS
    'When the thing that CAUSED this turn happened, declared by the producer that dispatched it: the '
    'instant round two was triggered for a battle rebuttal (the duel''s last round-1 terminal '
    'transition), the person''s send for a post-processing repair. A rebuttal''s ack_ms and its own '
    'e2e_ms both start here. NULL for a turn whose cause was not declared, including every ordinary '
    'user turn - those anchor on their own user message instead. Never defaulted: a producer that '
    'cannot supply it honestly supplies nothing.';

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

    COALESCE(a.t0_user_at, e.user_message_at)              AS t0_user_at,
    r.t2_placeholder_at,
    r.t3_final_at,
    r.entry_at,                                            -- SERVER clock

    CASE WHEN COALESCE(r.trigger_kind, 'user') IN ('user','handover','repair','recovery')
              -- A LATER DUEL ROUND IS NEVER A PERSON'S WAIT (071), whatever kind it declared or failed
              -- to declare.
              AND COALESCE(r.battle_round, 1) <= 1
              AND COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END AS ttff_ms,
    -- ROUND TWO IS MEASURED FROM THE INSTANT IT WAS TRIGGERED (071). The orchestrator declares that
    -- instant as trigger_at; the person's message is never this row's start, and with no declared
    -- instant the figure is NULL rather than a span covering both rounds.
    CASE WHEN COALESCE(r.battle_round, 1) > 1
         THEN CASE WHEN m.trigger_at IS NOT NULL
                        AND r.t3_final_at >= m.trigger_at
                   THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END
         WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t3_final_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END       AS e2e_ms,
    CASE WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
              AND r.t3_final_at >= r.t2_placeholder_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - r.t2_placeholder_at)) * 1000)::integer END AS answer_ms,

    m.total_ms, m.latency_ms, m.model_ms, m.tool_ms, m.poll_ms,
    e.inbound_ms,

    -- The same end to end as above, round two included, less what the brackets claim.
    (CASE WHEN COALESCE(r.battle_round, 1) > 1
          THEN CASE WHEN m.trigger_at IS NOT NULL AND r.t3_final_at IS NOT NULL
                    THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END
          WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL AND r.t3_final_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END
     - COALESCE(e.inbound_ms, 0) - COALESCE(m.total_ms, 0))                  AS unattributed_ms,
    (m.total_ms - COALESCE(m.latency_ms, 0) - COALESCE(m.poll_ms, 0))        AS overhead_ms,
    (m.latency_ms - COALESCE(m.model_ms, 0) - COALESCE(m.tool_ms, 0))        AS loop_residual_ms,

    CASE
        WHEN r.t2_placeholder_at IS NOT NULL AND COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
             AND r.t2_placeholder_at < COALESCE(a.t0_user_at, e.user_message_at)  THEN 'anomalous'
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
    END                                                                     AS anchor_source,

    -- THE CAUSE INSTANT, declared first and derived only as a fallback (034).
    COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at) AS trigger_at,
    CASE WHEN COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at
                                   - COALESCE(m.trigger_at, COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at))) * 1000)::integer
    END                                                                     AS ack_ms,
    -- Provenance, and it now has three states rather than two. 'declared' covers both a producer's own
    -- instant and a real user message - in both cases the anchor was OBSERVED rather than reconstructed
    -- - while 'derived' marks the 033 rule, which is a reconstruction and must never read as one.
    CASE WHEN m.trigger_at IS NOT NULL                             THEN 'declared'
         WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL THEN 'declared'
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

-- ── THE EXCHANGE ROWS, BY THE SAME RULE ─────────────────────────────────────────────────────────
-- A round-2 exchange's end to end runs from its declared trigger to its final answer, and its reply
-- time and inbound hop are NULL. Only rows that differ from that are written, one bounded batch at a time.
DO $repair$
DECLARE
    -- Same value as 029 and 066: trivially completable inside any of this stack's Lambda timeouts.
    batch_size CONSTANT integer := 5000;
    left_to_do bigint;
BEGIN
    UPDATE exchanges tgt
       SET e2e_ms              = CASE WHEN am.trigger_at IS NOT NULL AND am.agent_final_at > am.trigger_at
                                      THEN (EXTRACT(EPOCH FROM (am.agent_final_at - am.trigger_at)) * 1000)::integer
                                 END,
           inbound_ms          = NULL,
           response_latency_ms = NULL
      FROM messages am
     WHERE am.id = tgt.agent_message_id
       AND tgt.ctid IN (
           SELECT ex.ctid
             FROM exchanges ex
             JOIN messages am ON am.id = ex.agent_message_id
            -- Duel rows only, through idx_exchanges_battle_id_created (057).
            WHERE ex.battle_id IS NOT NULL
              AND COALESCE(ex.battle_round, am.battle_round, 1) > 1
              AND (ex.e2e_ms IS DISTINCT FROM
                     CASE WHEN am.trigger_at IS NOT NULL AND am.agent_final_at > am.trigger_at
                          THEN (EXTRACT(EPOCH FROM (am.agent_final_at - am.trigger_at)) * 1000)::integer
                     END
                   OR ex.inbound_ms IS NOT NULL
                   OR ex.response_latency_ms IS NOT NULL)
            LIMIT batch_size
       );

    -- The same predicate, counted after the batch, so a non-zero remainder keeps this file pending.
    SELECT COUNT(*) INTO left_to_do
      FROM exchanges ex
      JOIN messages am ON am.id = ex.agent_message_id
     WHERE ex.battle_id IS NOT NULL
       AND COALESCE(ex.battle_round, am.battle_round, 1) > 1
       AND (ex.e2e_ms IS DISTINCT FROM
              CASE WHEN am.trigger_at IS NOT NULL AND am.agent_final_at > am.trigger_at
                   THEN (EXTRACT(EPOCH FROM (am.agent_final_at - am.trigger_at)) * 1000)::integer
              END
            OR ex.inbound_ms IS NOT NULL
            OR ex.response_latency_ms IS NOT NULL);

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('071-round-two-is-measured-from-its-own-trigger.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END
$repair$;
