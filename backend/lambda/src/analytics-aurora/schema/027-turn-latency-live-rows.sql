-- 027: v_turn_latency measures LIVE turns, not only backfilled ones.
--
-- Two live-writer facts made the view empty on live traffic, and both are healed at READ so every
-- row already written is repaired too:
--
--   1. final_response rows carry turn_id NULL: the final answer arrives as an UpdateChannelMessage
--      whose content has no <!--corr:--> marker to declare a turn from (async-processor-core's own
--      isPlaceholderMessage doc states this). Grouped by (turn_id, response_id), every live turn
--      split into two rows and e2e_ms never computed. The grain is now the RESPONSE - one response
--      has one turn - and MAX(turn_id) lifts the placeholder's declared id over the final's NULL.
--   2. placeholder rows carry trigger_kind NULL: no live producer stamps a trigger into placeholder
--      metadata, so the strict trigger_kind='user' TTFF gate nulled TTFF for every ordinary live
--      turn. An anchored t0 is itself the user trigger (only a user_message supplies one; a
--      system-triggered response has no user message in its turn), so NULL now defaults to 'user'
--      and an explicitly-declared 'orchestrator'/'system' still suppresses TTFF.
--
-- Idempotent: CREATE OR REPLACE VIEW with an identical column list; re-running converges.

CREATE OR REPLACE VIEW v_turn_latency AS
WITH
-- The turn's anchor. A user_message belongs to the TURN, not to any one response, so it is resolved
-- once per turn and shared by every response in a fan-out.
anchor AS (
    SELECT turn_id,
           MIN(occurred_at) FILTER (WHERE kind = 'user_message') AS t0_user_at,
           MIN(turn_id_source) FILTER (WHERE kind = 'user_message') AS turn_id_source
      FROM turn_events
     WHERE turn_id IS NOT NULL
     GROUP BY turn_id
),
-- One assistant response within a turn.
resp AS (
    SELECT MAX(turn_id) AS turn_id,
           response_id,
           channel_arn::text AS channel_arn,
           MIN(occurred_at) FILTER (WHERE kind = 'placeholder_posted')     AS t2_placeholder_at,
           -- FIRST final wins, mirroring the COALESCE freeze: a later edit cannot move the answer time.
           MIN(occurred_at) FILTER (WHERE kind = 'final_response')         AS t3_final_at,
           MIN(occurred_at) FILTER (WHERE kind = 'processor_entry')        AS entry_at,
           COUNT(*)         FILTER (WHERE kind = 'progress_update')        AS progress_update_count,
           -- Recorded, not hidden: an auditor sees the answer was changed afterwards AND that the
           -- latency deliberately did not move.
           MIN(occurred_at) FILTER (WHERE kind IN ('content_edited','content_redacted','message_deleted'))
                                                                           AS superseded_at,
           MIN(trigger_kind) FILTER (WHERE kind = 'placeholder_posted')    AS trigger_kind,
           MIN(battle_round) FILTER (WHERE kind = 'placeholder_posted')    AS battle_round,
           MIN(actor)       FILTER (WHERE kind = 'placeholder_posted')     AS responder
      FROM turn_events
     WHERE response_id IS NOT NULL
     -- Per RESPONSE, deliberately not per (turn_id, response_id): the live writer's final_response
     -- rows carry turn_id NULL (an UpdateChannelMessage's content has no corr marker to declare it
     -- from), so the old grain split every live turn in two and its e2e_ms never computed. One
     -- response has one turn; MAX() lifts the placeholder's declared id over the final's NULL.
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

    -- INSTANTS. Chime clock unless noted.
    a.t0_user_at,
    r.t2_placeholder_at,
    r.t3_final_at,
    r.entry_at,                                            -- SERVER clock

    -- DERIVED, SKEW-FREE (both ends Chime).
    -- TTFF is NULL for a system-triggered response by construction: there is no user message to
    -- measure from, and a 0 there would be a lie that quietly drags the average down.
    CASE WHEN COALESCE(r.trigger_kind, 'user') = 'user' AND a.t0_user_at IS NOT NULL AND r.t2_placeholder_at >= a.t0_user_at
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at - a.t0_user_at)) * 1000)::integer END AS ttff_ms,
    CASE WHEN a.t0_user_at IS NOT NULL AND r.t3_final_at >= a.t0_user_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - a.t0_user_at)) * 1000)::integer END       AS e2e_ms,
    -- answer_ms: the blind wait the placeholder covers - how long the user stared at "One moment...".
    -- Nothing measures this today.
    CASE WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
              AND r.t3_final_at >= r.t2_placeholder_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - r.t2_placeholder_at)) * 1000)::integer END AS answer_ms,

    -- SERVER-CLOCK, ATTESTED (not provable against the stream).
    m.total_ms, m.latency_ms, m.model_ms, m.tool_ms, m.poll_ms,
    e.inbound_ms,

    -- RECONCILIATION RESIDUALS. Each must be >= 0 or the model of the turn is wrong. A negative
    -- unattributed_ms means compute was attributed to the wrong turn - i.e. the finality marker fired
    -- on the wrong update, which is the exact bug class this whole design exists to expose.
    (CASE WHEN a.t0_user_at IS NOT NULL AND r.t3_final_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (r.t3_final_at - a.t0_user_at)) * 1000)::integer END
     - COALESCE(e.inbound_ms, 0) - COALESCE(m.total_ms, 0))                  AS unattributed_ms,
    (m.total_ms - COALESCE(m.latency_ms, 0) - COALESCE(m.poll_ms, 0))        AS overhead_ms,
    (m.latency_ms - COALESCE(m.model_ms, 0) - COALESCE(m.tool_ms, 0))        AS loop_residual_ms,

    -- COMPLETENESS. An excluded turn is VISIBLE here instead of filtered away, which is the whole
    -- reason a dropped turn is invisible in the current metrics.
    CASE
        WHEN r.t2_placeholder_at IS NOT NULL AND a.t0_user_at IS NOT NULL
             AND r.t2_placeholder_at < a.t0_user_at                        THEN 'anomalous'
        WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
             AND r.t3_final_at < r.t2_placeholder_at                       THEN 'anomalous'
        WHEN r.t3_final_at IS NOT NULL                                     THEN 'complete'
        WHEN r.progress_update_count > 0                                   THEN 'awaiting_user'
        ELSE 'unresolved'
    END                                                                     AS status,
    r.progress_update_count,
    r.superseded_at,
    -- Past the S3 lifecycle this row can no longer be proven against the stream.
    (r.t2_placeholder_at > NOW() - INTERVAL '90 days')                      AS in_stream_window
  FROM resp r
  LEFT JOIN anchor   a ON a.turn_id = r.turn_id
  -- Server-clock durations still live on the canonical message row; the ledger holds the instants.
  LEFT JOIN messages m ON m.message_id = r.response_id AND m.channel_arn = r.channel_arn
                      AND m.event_type = 'CREATE_CHANNEL_MESSAGE'
  -- LATERAL + LIMIT 1, not a plain LEFT JOIN. `exchanges` is unique on the (user, agent) PAIR
  -- (migration 017), so one agent message can legitimately appear in more than one exchange row - and
  -- a plain join would then emit the SAME response twice and double-count it in every average built
  -- on this view. One row per response is the invariant this view exists to provide.
  LEFT JOIN LATERAL (
      SELECT ex.delivery_option, ex.task_id, ex.inbound_ms
        FROM exchanges ex
       WHERE ex.agent_message_id = m.id
       ORDER BY ex.created_at
       LIMIT 1
  ) e ON TRUE;

COMMENT ON VIEW v_turn_latency IS
    'THE latency calculation: one row per (turn_id, response_id) with every instant, the metric '
    'derived from it, and residuals that must be >= 0. ttff_ms is NULL for a system-triggered '
    'response (no user message to measure from). Task turns appear here as individual TURNS; whole-'
    'task resolve time is v_task_resolution and is deliberately a different measurement.';
