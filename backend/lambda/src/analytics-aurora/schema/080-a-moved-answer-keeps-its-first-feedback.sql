-- ============================================================================
-- 080: a moved answer keeps its first feedback.
--
-- A turn that delivers its answer as a message of its own (a private answer targeted at the person, a
-- broadcast duel answer, an answer posted at the end because the placeholder became the queue notice)
-- leaves its placeholder behind declaring `receipt` or `queue_ack`. That placeholder pairs with
-- nothing, so the moved answer's exchange is the turn's pairing. The view anchored a response only on
-- its own exchange or the ledger, so the placeholder lost its anchor and the turn lost its time to
-- first feedback, which is the placeholder's post.
--
-- WHAT CHANGES. A response with no exchange of its own and no ledger anchor, that declared `receipt` or
-- `queue_ack`, is anchored on the exchange of the person's message it declared it answers (its
-- answers_message_id, from its update or its CREATE). The anchor source reads `declared_target`. The
-- exchange must not be a queued pairing, a later duel round or a swept pairing, the same rules the own
-- exchange lateral applies plus the sweep exclusion getLatencyMetrics applies to a measured anchor.
--
-- Every other row computes exactly what 071 computes: the target lateral returns nothing unless the
-- own exchange is absent and the response declared one of the two kinds.
--
-- Idempotent and transaction-safe: CREATE OR REPLACE VIEW with the same columns in the same order, and
-- no CONCURRENTLY. The view body is the 071 definition with the changes above applied, generated from
-- that file rather than retyped so the two cannot drift by transcription.
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
  -- THE RESPONSE'S UPDATE ROW, for the kind and the target it declared there (080). One row or none:
  -- messages is unique on (message_id, channel_arn).
  LEFT JOIN messages mu ON mu.channel_arn = m.channel_arn
                       AND mu.event_type = 'UPDATE_CHANNEL_MESSAGE'
                       AND mu.message_id = m.message_id || '-UPD'
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
