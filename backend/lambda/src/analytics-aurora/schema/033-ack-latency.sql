-- 033 (G13): a response with no user message in front of it gets a latency at last.
--
-- THE GAP. `ttff_ms` is NULL by construction for anything the person did not ask for - a battle
-- rebuttal, a welcome, a briefing, a drift notice - because there is no user message to measure from.
-- That was the correct answer while nothing recorded what DID cause the turn, and the doc says so.
-- The consequence is that on a duel-heavy day the MAJORITY of assistant messages have no measured
-- latency at all: 174 of 1,137 on one measured day were round-2 rebuttals alone, and every one of
-- them was invisible to every latency number on the console.
--
-- ack_ms IS THE GENERAL METRIC, ttff_ms STAYS THE USER-TRIGGERED SUBSET. That split is deliberate and
-- it is what keeps the Nielsen SLO meaningful. TTFF is compared against a threshold about human
-- patience, and a person is not waiting on a rebuttal the way they wait on a reply to their own
-- message. Folding proactive responses into TTFF would move a UX number using turns no user was
-- sitting in front of. So: every response gets `ack_ms` (trigger -> first signal), and `ack_ms` for a
-- user-triggered response IS `ttff_ms`, by construction rather than by coincidence.
--
-- ── THE ANCHOR, AND WHY THIS ONE IS DERIVED ──
--
-- The end state is a DECLARED anchor: the producer stamps the instant it was reacting to, exactly as
-- it already declares `respPhase` and `trigger`. The orchestrator knows what unblocked round 2, the
-- welcome knows the membership event, the drift notice knows its `drift_events` row.
--
-- It is derived here instead because round 1 records no completion instant to declare - a rebuttal
-- gets a FRESH correlation id (`battle-r2-...`), so it shares no turn with the answer that caused it,
-- and there is nothing on the battle row to carry. Adding one means changing the battle state machine.
-- Deriving the anchor needs no producer change at all, and the derivation is honest about itself:
-- `ack_source` says 'declared' when the turn had a user message and 'derived' when this rule supplied
-- it, so nobody reads a reconstruction as an observation. Same rule `turn_id_source` already follows.
--
-- THE RULE, stated so its failure modes are visible: for an ORCHESTRATOR-triggered response, the
-- trigger is the most recent final answer posted by a DIFFERENT responder in the same channel before
-- this placeholder. That is what a rebuttal is - the reply to the rival's answer.
--
--   BOUNDED to 10 minutes. Unbounded, a quiet channel would anchor a rebuttal to yesterday's
--   conversation and report an ack_ms in the hours. This is the same failure the cross-batch exchange
--   pairer produced with its one-hour bound, which fabricated 93% of a TTFF total, and the lesson is
--   the bound has to be shorter than the gap between conversations rather than merely finite.
--
--   DIFFERENT RESPONDER, so a side is never anchored to its OWN previous answer - which would measure
--   a bot's idle time between its own turns rather than its reaction to a rival.
--
--   NULL WHEN NOTHING QUALIFIES, never 0. A response whose cause cannot be found is unmeasured, and
--   saying "0 ms" would report the fastest possible reaction for the turns we understand least.
--
-- WHAT IS STILL UNMEASURED, said plainly rather than left for a reader to discover: a welcome and a
-- drift notice are 'system'-triggered and have no preceding final answer to derive from, so their
-- ack_ms stays NULL. They need the declared anchor. This migration closes the majority case (duels)
-- and names the rest.
--
-- Idempotent: CREATE OR REPLACE VIEW with columns APPENDED after 031's, so no existing column changes
-- type or position (see a-replaced-view-keeps-its-column-types.test.ts).

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

    -- ── APPENDED (033) ──
    -- The instant this response was a reaction TO. The user's message when there was one; otherwise
    -- the rival answer that provoked it, found by the bounded rule in the header.
    COALESCE(COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at)      AS trigger_at,
    -- ack_ms: trigger -> first visible signal, for EVERY response rather than only the asked-for ones.
    -- Identical to ttff_ms on a user turn, by construction: same two instants.
    CASE WHEN COALESCE(COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at) IS NOT NULL
              AND r.t2_placeholder_at >= COALESCE(COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at)
         THEN (EXTRACT(EPOCH FROM (r.t2_placeholder_at
                                   - COALESCE(COALESCE(a.t0_user_at, e.user_message_at), trg.trigger_at))) * 1000)::integer
    END                                                                     AS ack_ms,
    -- Provenance, so a derived anchor is never mistaken for an observed one. 'declared' = there was a
    -- real user message; 'derived' = the preceding-final-answer rule supplied it; NULL = nothing did,
    -- and ack_ms is NULL for that reason rather than because the response was instant.
    CASE WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL THEN 'declared'
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
  -- THE DERIVED TRIGGER (033). Evaluated only for a response that declared a non-user trigger: on a
  -- user turn the anchor is already known and this lateral would be work done to be discarded.
  --
  -- NO NEW INDEX. `idx_turn_events_channel_occurred (channel_arn, occurred_at DESC)` from 019 already
  -- serves the two selective predicates, and the 10-minute window leaves a candidate set small enough
  -- that `kind` is a cheap residual. An index added for a filter the window has already reduced to a
  -- handful of rows is write cost bought for nothing.
  LEFT JOIN LATERAL (
      SELECT MAX(te.occurred_at) AS trigger_at
        FROM turn_events te
       WHERE r.trigger_kind IS NOT NULL
         AND r.trigger_kind <> 'user'
         AND te.channel_arn = r.channel_arn
         AND te.kind = 'final_response'
         AND te.occurred_at < r.t2_placeholder_at
         -- Shorter than the gap between conversations, not merely finite. See the header.
         AND te.occurred_at > r.t2_placeholder_at - INTERVAL '10 minutes'
         -- Never a side's own previous answer: that measures idle time, not a reaction.
         AND (te.actor IS DISTINCT FROM r.responder)
  ) trg ON TRUE;

COMMENT ON VIEW v_turn_latency IS
    'THE latency calculation: one row per response with every instant, the metric derived from it, '
    'and residuals that must be >= 0. The turn anchor is the ledger''s own user_message when it has '
    'one and the exchange pairing otherwise (anchor_source says which). ttff_ms is the USER-TRIGGERED '
    'subset, kept comparable to the Nielsen SLO; ack_ms is the general trigger-to-first-signal metric '
    'and covers proactive responses too, with ack_source saying whether its anchor was declared or '
    'derived. Task turns appear here as individual TURNS; whole-task resolve time is '
    'v_task_resolution and is a different measurement.';
