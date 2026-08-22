-- 031 (G11): the ledger gets an anchor on LIVE traffic, so v_turn_latency stops returning NULL.
--
-- THE DEFECT, and it is one line in the writer against one line in the view. `turn-events-live.ts`
-- records every `user_message` row with `turn_id` NULL - correctly, and it says why: the processor is
-- never handed the user's Chime MessageId, so the binding "is made later by pairing". The `anchor` CTE
-- then reads:
--
--     FROM turn_events WHERE turn_id IS NOT NULL GROUP BY turn_id
--
-- which excludes every row the anchor is made of. So `t0_user_at` was NULL for every live turn, and
-- with it `ttff_ms`, `e2e_ms` and `unattributed_ms` - the three numbers the view exists to produce.
-- The Turn Latency Audit rendered blank on a freshly deployed cluster and looked like a wiring fault.
-- Only `turn-events-backfill.ts`, run by hand over history, ever produced rows this CTE could see.
--
-- THE FIX IS TO USE THE PAIRING THAT ALREADY EXISTS rather than to invent a key in the writer.
-- `exchanges` holds exactly the binding the writer cannot make - `user_message_at` beside
-- `agent_message_id` - and the view ALREADY joins it (for `delivery_option`, `task_id`, `inbound_ms`).
-- It is also the same source `response_latency_ms` is derived from, the number that has been working
-- on this deployment all along. Anchoring here makes the ledger agree with the metric that already
-- works, instead of adding a second opinion about when the turn started.
--
-- WHY NOT BACKFILL turn_id INTO THE WRITER. It would be a guess made at archival time, before the
-- pairing exists, and a guessed key in a ledger whose purpose is auditability is worse than a NULL:
-- a NULL says "not known here", a wrong id says something false about a turn.
--
-- PROVENANCE IS RECORDED, NOT ASSUMED (the ledger's own rule: a derived binding says it is derived).
-- The new `anchor_source` column says which of the two produced `t0_user_at` - 'ledger' for a row the
-- ledger anchored itself (the backfilled population), 'exchange' for one anchored by the pairing, NULL
-- when nothing anchored it. A reader can therefore tell an audited turn from a paired one without
-- being told which population they are looking at.
--
-- APPENDED, NEVER REORDERED. `CREATE OR REPLACE VIEW` may add columns at the END and may not change
-- an existing column's type or position, so `anchor_source` goes last and every existing alias keeps
-- the expression shape it had (see a-replaced-view-keeps-its-column-types.test.ts for the live
-- outage that rule comes from). `t0_user_at` stays TIMESTAMPTZ: COALESCE of two timestamptz is one.
--
-- Idempotent: CREATE OR REPLACE VIEW, re-running converges.

CREATE OR REPLACE VIEW v_turn_latency AS
WITH
-- The turn's anchor AS THE LEDGER KNOWS IT. Still first choice: when a user_message row carries a
-- turn_id, that binding was recorded rather than reconstructed. Empty on live traffic by construction,
-- which is the defect above; kept because the backfilled population does have it and an audited
-- anchor outranks a paired one.
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
    -- THE CAST IS LOAD-BEARING, exactly as 026's `channel_arn::text` is, and for the same reason one
    -- column over. `max(varchar)` returns TEXT, while 026 selected the bare `turn_id` column, so the
    -- deployed view's `turn_id` is `varchar(64)` - and `CREATE OR REPLACE VIEW` refuses to change a
    -- column's type.
    SELECT MAX(turn_id)::VARCHAR(64) AS turn_id,
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
    -- THE ANCHOR, ledger first and pairing second. Both ends stay on the Chime clock, so everything
    -- derived from this below is still skew-free whichever source supplied it.
    COALESCE(a.t0_user_at, e.user_message_at)              AS t0_user_at,
    r.t2_placeholder_at,
    r.t3_final_at,
    r.entry_at,                                            -- SERVER clock

    -- DERIVED, SKEW-FREE (both ends Chime).
    -- TTFF is NULL for a system-triggered response by construction: there is no user message to
    -- measure from, and a 0 there would be a lie that quietly drags the average down.
    CASE WHEN COALESCE(r.trigger_kind, 'user') = 'user'
              AND COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END AS ttff_ms,
    CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
              AND r.t3_final_at >= COALESCE(a.t0_user_at, e.user_message_at)
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END       AS e2e_ms,
    -- answer_ms: the blind wait the placeholder covers - how long the user stared at "One moment...".
    CASE WHEN r.t3_final_at IS NOT NULL AND r.t2_placeholder_at IS NOT NULL
              AND r.t3_final_at >= r.t2_placeholder_at
         THEN (EXTRACT(EPOCH FROM (r.t3_final_at - r.t2_placeholder_at)) * 1000)::integer END AS answer_ms,

    -- SERVER-CLOCK, ATTESTED (not provable against the stream).
    m.total_ms, m.latency_ms, m.model_ms, m.tool_ms, m.poll_ms,
    e.inbound_ms,

    -- RECONCILIATION RESIDUALS. Each must be >= 0 or the model of the turn is wrong. A negative
    -- unattributed_ms means compute was attributed to the wrong turn - i.e. the finality marker fired
    -- on the wrong update, which is the exact bug class this whole design exists to expose.
    (CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL AND r.t3_final_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END
     - COALESCE(e.inbound_ms, 0) - COALESCE(m.total_ms, 0))                  AS unattributed_ms,
    (m.total_ms - COALESCE(m.latency_ms, 0) - COALESCE(m.poll_ms, 0))        AS overhead_ms,
    (m.latency_ms - COALESCE(m.model_ms, 0) - COALESCE(m.tool_ms, 0))        AS loop_residual_ms,

    -- COMPLETENESS. An excluded turn is VISIBLE here instead of filtered away.
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
    -- Past the S3 lifecycle this row can no longer be proven against the stream.
    (r.t2_placeholder_at > NOW() - INTERVAL '90 days')                      AS in_stream_window,

    -- APPENDED (031). Which source produced the anchor above, so a reader can tell an audited turn
    -- from a paired one. NULL means nothing anchored this response and its ttff/e2e are absent for
    -- that reason rather than because the turn was slow.
    CASE WHEN a.t0_user_at      IS NOT NULL THEN 'ledger'
         WHEN e.user_message_at IS NOT NULL THEN 'exchange'
    END                                                                     AS anchor_source
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
      -- `user_message_at` is new here (031): the anchor the ledger cannot record for itself. Ordered
      -- and limited exactly as before, so the row chosen for the anchor is the row already chosen for
      -- delivery_option and inbound_ms - one exchange, not a mix of two.
      SELECT ex.delivery_option, ex.task_id, ex.inbound_ms, ex.user_message_at
        FROM exchanges ex
       WHERE ex.agent_message_id = m.id
       ORDER BY ex.created_at
       LIMIT 1
  ) e ON TRUE;

COMMENT ON VIEW v_turn_latency IS
    'THE latency calculation: one row per response with every instant, the metric derived from it, '
    'and residuals that must be >= 0. The turn anchor is the ledger''s own user_message when it has '
    'one and the exchange pairing otherwise; anchor_source says which. ttff_ms is NULL for a '
    'system-triggered response (no user message to measure from). Task turns appear here as '
    'individual TURNS; whole-task resolve time is v_task_resolution and is a different measurement.';
