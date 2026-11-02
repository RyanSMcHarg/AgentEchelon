-- ============================================================================
-- 064: a rebuttal is not an answer to the person, so it must not anchor a turn.
--
-- EVERY ROUND OF A DUEL IS RECORDED. A side's rebuttal answers the same user message as its round-1
-- reply and comes from the same bot, so a pairing key of (turn, sender) alone cannot tell the two
-- apart. The key carries the round, so a two-round duel records all four turns and its comparison is
-- computed over the whole duel.
--
-- AND RECORDING THEM REACHES HERE. exchanges.user_message_at is NOT NULL, so a round-2 row carries
-- the ORIGINAL user message's instant. This view falls back to that instant when the turn ledger has
-- no anchor of its own, which every rebuttal lacks - so without this guard the change would start
-- reporting rebuttals at a time to first feedback spanning both rounds, on the averages that measure
-- seconds. That is a worse defect than the missing turns it fixes.
--
-- WHY A GUARD HERE RATHER THAN A NULL THERE. The round-2 row's own latency columns ARE withheld
-- (response_latency_ms and e2e_ms are NULL by construction in kinesis-archival), but user_message_at
-- cannot be: the column is NOT NULL and the value is true - that IS the message the duel began from.
-- The row is honest and this reader is the one that must not treat it as a reply anchor.
--
-- The precedent is one line above: a queued exchange is excluded from this same LATERAL for exactly
-- the same reason, that it is not the pairing this turn was measured from.
--
-- WHAT STAYS. Round-2 exchanges remain in cost, model attribution, relevance and the battle round
-- count, which is the point of minting them. DESIGN-BATTLE section 8 states the principle for the
-- neighbouring case: those turns "really happened, really reached the user, and really cost money;
-- dropping them would misstate spend".
--
-- Idempotent and transaction-safe: CREATE OR REPLACE VIEW, no CONCURRENTLY. The body below is the
-- 052 definition with the one guard added, generated from that file rather than retyped so the two
-- cannot drift by transcription.
-- ============================================================================

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
              AND COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END AS ttff_ms,
    CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t3_final_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END       AS e2e_ms,
    CASE WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
              AND r.t3_final_at >= r.t2_placeholder_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - r.t2_placeholder_at)) * 1000)::integer END AS answer_ms,

    m.total_ms, m.latency_ms, m.model_ms, m.tool_ms, m.poll_ms,
    e.inbound_ms,

    (CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL AND r.t3_final_at IS NOT NULL
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
         -- A REBUTTAL IS NOT THIS TURN'S PAIRING EITHER (064), for the same reason and with the
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
