-- ============================================================================
-- 051: a deferral notice is not a turn, and must stop appearing as one that never resolved.
--
-- WHAT THE DEFECT IS. `v_turn_latency` grains on `response_id`, and it takes every ledger row that
-- carries one. A `notice_posted` row carries a non-NULL `response_id` - the notice message's own id -
-- and a NULL `turn_id`, deliberately: the notice acknowledges somebody whose message is waiting on
-- work that is not theirs, so it answers no turn (turn-events-live.ts says exactly that where it
-- writes the row). The view had no reason to skip it, so every queue episode added a response with no
-- placeholder instant, no final instant, no TTFF, no E2E and `status = 'unresolved'`.
--
-- WHY IT MATTERS NOW. It was a phantom in an audit nobody read; the Latency tab's figures came from
-- the derived path. The console now reads this view for TTFF and E2E, and the Turn Latency Audit
-- lists these rows unwindowed, so a queue episode shows up to an operator as a turn that was promised
-- and never answered - which is the one reading the ledger exists to make trustworthy.
--
-- THE FIX IS THE ONE THE UNCLOSED SPLIT ALREADY MAKES. That split reads the notice as a real fact
-- about a turn ('awaiting') where a turn has one, and never as a response of its own. Here a response
-- whose ledger rows are ALL notices is not a response at all, and the HAVING says so. A notice posted
-- against a turn that also has a placeholder is untouched: the response still has a non-notice row,
-- so it survives the filter and keeps every instant it recorded.
--
-- AND THE DEFERRAL IS STILL MEASURED. `v_queue_acknowledgement` (039) is where a queued message's
-- first feedback lives, keyed on the acknowledged message rather than on the notice, because several
-- queued sends share one notice and each of them waited. Dropping the notice from THIS view removes a
-- duplicate reading, not a measurement.
--
-- CREATE OR REPLACE, so the column list and every column type is the 038 definition unchanged; the
-- only difference is the HAVING in `resp`. Idempotent and transaction-safe: no CONCURRENTLY, no data
-- step, applied at RUNTIME on a cold start inside one transaction (db-client applyPendingMigrations).
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
    -- A RESPONSE MADE ONLY OF NOTICES IS NOT A RESPONSE. `kind` is NOT NULL, so `bool_or` over a
    -- group is TRUE exactly when at least one row is something other than the deferral
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
    'and residuals that must be >= 0. A response whose only ledger rows are deferral notices is not a '
    'response and is excluded; a queued message''s first feedback is v_queue_acknowledgement, which '
    'keys on the acknowledged message because several queued sends share one notice. The turn anchor '
    'is the ledger''s own user_message when it has one and the exchange pairing otherwise '
    '(anchor_source says which). ttff_ms is the USER-TRIGGERED subset, kept comparable to the Nielsen '
    'SLO, and it is what the admin console''s Latency tab reads; ack_ms is the general '
    'trigger-to-first-signal metric and covers proactive responses too, anchored on the producer''s '
    'DECLARED instant where there is one and a bounded derivation otherwise (ack_source says which). '
    'Task turns appear here as individual TURNS; whole-task resolve time is v_task_resolution and is '
    'a different measurement.';
