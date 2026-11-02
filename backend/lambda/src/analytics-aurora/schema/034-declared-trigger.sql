-- 034 (G13): the trigger instant is DECLARED, so a proactive turn is measured not guessed.
--
-- WHAT 033 LEFT. `ack_ms` existed but its anchor for a non-user turn was DERIVED - the most recent
-- final answer by another responder in the same channel, inside a 10-minute window. That was the best
-- available with no producer change, and it is a reconstruction: it can pick the wrong message in a
-- busy channel, and it goes silent when the causing answer is older than the bound.
--
-- The producers now declare it. A rebuttal carries the instant the RIVAL finished (read off the
-- rival's own battle row, which every state transition already stamps); a repair carries the instant
-- the PERSON sent the message nobody routed, which is the whole point - everything between that send
-- and the repair dispatch is delay they experienced, and it is the largest part of a repaired turn.
--
-- DECLARED BEATS DERIVED, AND BOTH BEAT NOTHING. The view prefers, in order:
--   1. the declared instant, when the producer supplied one           -> ack_source = 'declared'
--   2. the user message, for a turn a person actually sent            -> ack_source = 'declared'
--   3. the derived rule from 033, for older rows and unwired paths    -> ack_source = 'derived'
-- and NULL when none applies, which stays an honest "not measurable" rather than a zero.
--
-- WHY THE DECLARED INSTANT OUTRANKS THE USER MESSAGE. On a handover the two are the same message, so
-- the order is irrelevant. On a rebuttal there IS no user message for that response, so only one
-- exists. They cannot disagree in practice; the order is stated so a future path that supplies both
-- gets the producer's answer rather than a join's.
--
-- messages.trigger_at is TIMESTAMPTZ, converted at archival from the epoch ms the producer sends, so
-- the comparison below is timestamp-to-timestamp and no arithmetic happens at read time.
--
-- Idempotent: IF NOT EXISTS column, CREATE OR REPLACE VIEW with columns appended after 033's.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS trigger_at TIMESTAMPTZ;

COMMENT ON COLUMN messages.trigger_at IS
    'When the thing that CAUSED this turn happened, declared by the producer that dispatched it: the '
    'rival''s completion for a battle rebuttal, the person''s send for a post-processing repair. NULL '
    'for a turn whose cause was not declared, including every ordinary user turn - those anchor on '
    'their own user message instead. Never defaulted: a producer that cannot supply it honestly '
    'supplies nothing, because an invented instant reports the fastest possible reaction for exactly '
    'the turns least understood.';

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
           MIN(trigger_kind) FILTER (WHERE kind = 'placeholder_posted')    AS trigger_kind,
           MIN(battle_round) FILTER (WHERE kind = 'placeholder_posted')    AS battle_round,
           MIN(actor)       FILTER (WHERE kind = 'placeholder_posted')     AS responder
      FROM turn_events
     WHERE response_id IS NOT NULL
     GROUP BY response_id, channel_arn
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

    CASE WHEN COALESCE(r.trigger_kind, 'user') = 'user'
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

COMMENT ON VIEW v_turn_latency IS
    'THE latency calculation: one row per response with every instant, the metric derived from it, '
    'and residuals that must be >= 0. The turn anchor is the ledger''s own user_message when it has '
    'one and the exchange pairing otherwise (anchor_source says which). ttff_ms is the USER-TRIGGERED '
    'subset, kept comparable to the Nielsen SLO; ack_ms is the general trigger-to-first-signal metric '
    'and covers proactive responses too, anchored on the producer''s DECLARED instant where there is '
    'one and a bounded derivation otherwise (ack_source says which). Task turns appear here as '
    'individual TURNS; whole-task resolve time is v_task_resolution and is a different measurement.';
