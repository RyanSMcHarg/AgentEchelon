-- 019-turn-audit.sql
--
-- The turn event ledger, and the one table that shows the whole latency calculation.
--
-- WHY THIS EXISTS. Today a message's LIFECYCLE ROLE is inferred from its TRANSPORT SHAPE: an update
-- is treated as the final answer because `total_ms` happens to be non-null (kinesis-archival.ts, the
-- `agent_final_at` gate), and "which update" is decided by COALESCE freezing the first one that
-- passes. Transport shape is not a stable contract - it changes the moment a second progress update,
-- a streaming partial, or a new delivery mode appears, and when it changes every `e2e_ms` silently
-- reads wrong with nothing erroring. The ledger replaces the inference: the producer DECLARES the
-- role (`respPhase` in the Chime message Metadata, which reaches the S3 archive), and the consumer
-- refuses to guess.
--
-- WHAT IS AUDITABLE, STATED HONESTLY. The outer bracket - user message -> placeholder -> final answer
-- - is measured on the Chime clock and every instant here can be re-found in the S3 conversation
-- archive from (source_message_id, source_event_type, occurred_at). The inner breakdown
-- (processor entry, model_ms, tool_ms) is SERVER clock and was never in the S3 line: Aurora-mode
-- slimming keeps latency fields off the Chime Metadata entirely, so those numbers are ATTESTED by the
-- emitting Lambda, not provable against the stream. Rows say which they are (`clock`, `auditable`) so
-- no dashboard can imply otherwise.
--
-- NO CONTENT. This table holds ids, timestamps, kinds and provenance. No message text, no
-- updated_content, no user-authored strings, and `actor` holds an identity REFERENCE (user sub or
-- assistant ARN), never a display name or email. That is a design constraint with a test behind it,
-- not an accident: it means a redaction or a deletion needs no ledger mutation at all, so the erasure
-- path does not grow a second place to get wrong.
--
-- Migrations DO auto-apply: db-client.ts `applyPendingMigrations` runs unapplied schema/*.sql at
-- runtime under an advisory lock, on existing clusters. (The "apply out-of-band" caveat carried in
-- migrations 010-013 is stale.) Everything here is therefore idempotent and transaction-safe - no
-- CONCURRENTLY, which cannot run inside the migration transaction.

-- ============================================================================
-- turn_events: one row per observed, timestamped fact about a turn.
-- Append-only. Never updated, never carries content.
-- ============================================================================
CREATE TABLE IF NOT EXISTS turn_events (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- WHAT HAPPENED. Metrics are predicates over `kind` and never over row shape - that is the whole
    -- point. An update whose declared phase is unrecognised archives as 'progress_update', so a
    -- future update type is INERT by default instead of silently becoming "the answer".
    kind              VARCHAR(32)  NOT NULL,

    -- THE TWO KEYS. A turn can have more than one responder: a normal turn is 1 turn_id + 1
    -- response_id, a /battle is 1 turn_id + 2 response_ids, and an N-way fan-out is 1 + N. Latency is
    -- computed per response, sharing the turn's user_message anchor. This generalises what migration
    -- 017 patched narrowly by deduping exchanges on the (user, agent) PAIR.
    turn_id           VARCHAR(64),
    response_id       VARCHAR(128),

    -- HONESTY ABOUT THE JOIN. The processor never receives the user's Chime MessageId - it is handed
    -- a correlationId only - so the turn_id <-> user_message binding is DERIVED at archival, not
    -- declared. Every row says which it is rather than hiding a derived key behind an average.
    turn_id_source    VARCHAR(16),   -- 'declared' | 'paired'

    -- WHO/WHAT STARTED IT. TTFF is only meaningful for a user-triggered response: a battle round-2
    -- rebuttal, a welcome, a proactive briefing and a drift notice have no user message to measure
    -- from, so their ttff_ms must be NULL rather than 0 - and must stay out of the TTFF average.
    trigger_kind      VARCHAR(16),   -- 'user' | 'orchestrator' | 'system'
    battle_round      SMALLINT,      -- battle round; NULL for an ordinary turn

    -- WHO ACTED. An identity reference only (user sub or assistant ARN), never a name.
    actor             VARCHAR(256),

    -- PROVENANCE - enough to re-find this exact event in the S3 archive.
    source_message_id VARCHAR(128),  -- raw Chime MessageId, NO archival suffix
    source_event_type VARCHAR(64),   -- e.g. 'UPDATE_CHANNEL_MESSAGE'
    channel_arn       VARCHAR(256) NOT NULL,

    -- WHEN, AND ON WHOSE CLOCK.
    occurred_at       TIMESTAMPTZ  NOT NULL,
    clock             VARCHAR(8)   NOT NULL DEFAULT 'chime',  -- 'chime' | 'server'
    auditable         BOOLEAN      NOT NULL DEFAULT TRUE,     -- FALSE for server-clock rows

    -- Task-scoped rows only (task_opened / task_transition / task_terminal).
    task_id           VARCHAR(64),
    task_state        VARCHAR(32),
    terminal_kind     VARCHAR(16),   -- 'success' | 'failure' | 'handoff' | 'expired'

    archived_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- RETENTION. Aligned to the 90-day S3 conversation-archive lifecycle: past that window an event
    -- can no longer be proven against the stream, which is this table's reason to exist. A row is
    -- only eligible for deletion, not deleted by the database - see the reaper note on the table.
    expires_at        TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),

    -- IDEMPOTENCY. ADR-022 records that an updated persistent message RE-INVOKES the channel flow, so
    -- the same event legitimately arrives more than once; Kinesis redelivery does the same. The
    -- natural key is the event itself, so a replay collides and is dropped rather than double-counted.
    UNIQUE (source_message_id, source_event_type, occurred_at)
);

COMMENT ON TABLE turn_events IS
    'Append-only ledger of latency-relevant turn events. Holds ids, timestamps, kinds and provenance '
    '- NEVER message content. Chime-clock rows are provable against the S3 archive for 90 days; '
    'server-clock rows (auditable=false) are attested by the emitting Lambda only. RETENTION: rows '
    'past expires_at are eligible for deletion; the reaper is a bounded DELETE on an existing '
    'schedule - a retention COLUMN with no reaper is decoration, so do not treat this as enforced '
    'until that delete exists. Note the sibling analytics tables (messages, exchanges, client_events) '
    'have no retention at all today; this is the first, not a special case.';

COMMENT ON COLUMN turn_events.kind IS
    'What happened. Turn-scoped: user_message, placeholder_posted, progress_update, final_response, '
    'continuation_chunk, processor_entry (server clock), content_edited/content_redacted/'
    'message_deleted. Task-scoped: task_opened, task_transition, task_terminal. Reserved for later: '
    'stream_chunk, client_render. Only final_response may close a response; an unrecognised declared '
    'phase archives as progress_update so a new update type is inert by default (fails closed into '
    '"not final").';
COMMENT ON COLUMN turn_events.turn_id_source IS
    'declared | paired. The processor is never given the user Chime MessageId, so the turn <-> user '
    'message binding is derived at archival. Rows state which, rather than implying a declared key.';
COMMENT ON COLUMN turn_events.trigger_kind IS
    'user | orchestrator | system. TTFF is undefined for a non-user trigger (battle round 2, welcome, '
    'briefing, drift notice) and must be NULL, never 0.';
COMMENT ON COLUMN turn_events.auditable IS
    'TRUE when this instant can be re-found in the S3 archive (Chime clock). FALSE for server-clock '
    'values, which never appeared in the stream because Aurora-mode slimming keeps them off Metadata.';
COMMENT ON COLUMN turn_events.actor IS
    'Identity REFERENCE only - user sub or assistant ARN. Never a display name or email.';

CREATE INDEX IF NOT EXISTS idx_turn_events_turn_response
    ON turn_events (turn_id, response_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_turn_events_occurred
    ON turn_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_turn_events_channel_occurred
    ON turn_events (channel_arn, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_turn_events_task
    ON turn_events (task_id, occurred_at)
    WHERE task_id IS NOT NULL;
-- Supports the retention reaper without scanning the table.
CREATE INDEX IF NOT EXISTS idx_turn_events_expires
    ON turn_events (expires_at);

-- ============================================================================
-- v_turn_latency: THE table that shows the full calculation.
--
-- One row per (turn_id, response_id): every instant, the metric derived from it, and the residuals
-- that prove the arithmetic. A view rather than a copy, so this and the ledger cannot drift.
-- ============================================================================
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
    SELECT turn_id,
           response_id,
           MIN(channel_arn)                                                AS channel_arn,
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
     GROUP BY turn_id, response_id
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
    CASE WHEN r.trigger_kind = 'user' AND a.t0_user_at IS NOT NULL AND r.t2_placeholder_at >= a.t0_user_at
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

-- ============================================================================
-- v_task_resolution: a DIFFERENT measurement, on a different denominator.
--
-- Time-to-resolve is mostly human think time. Reported next to latency it would read as a latency
-- regression, so it is separate, decomposed, and never enters getLatencyMetrics or the alerts.
-- ============================================================================
CREATE OR REPLACE VIEW v_task_resolution AS
WITH t AS (
    SELECT task_id,
           MIN(channel_arn)                                              AS channel_arn,
           MIN(occurred_at) FILTER (WHERE kind = 'task_opened')          AS opened_at,
           MIN(occurred_at) FILTER (WHERE kind = 'task_terminal')        AS terminal_at,
           MIN(terminal_kind) FILTER (WHERE kind = 'task_terminal')      AS terminal_kind,
           COUNT(*)         FILTER (WHERE kind = 'task_transition')      AS transitions,
           COUNT(DISTINCT turn_id)                                       AS turns
      FROM turn_events
     WHERE task_id IS NOT NULL
     GROUP BY task_id
)
SELECT
    t.task_id,
    t.channel_arn,
    t.opened_at,
    t.terminal_at,
    t.terminal_kind,
    t.turns,
    t.transitions,
    (t.terminal_at IS NOT NULL)                                          AS is_resolved,
    -- The headline: wall-clock time to resolve. INCLUDES human think time. Never compare this to an
    -- SLO built for per-turn latency.
    CASE WHEN t.terminal_at IS NOT NULL AND t.terminal_at >= t.opened_at
         THEN (EXTRACT(EPOCH FROM (t.terminal_at - t.opened_at)) * 1000)::bigint END AS resolve_ms,
    -- The only part the deployment is accountable for.
    (SELECT SUM(v.e2e_ms) FROM v_turn_latency v WHERE v.task_id = t.task_id)         AS agent_ms
  FROM t;

COMMENT ON VIEW v_task_resolution IS
    'Whole-task resolution, one row per task_id. resolve_ms is wall clock and is mostly HUMAN think '
    'time; agent_ms is the summed per-turn e2e, the only part the system is accountable for. The '
    'difference is user wait. This is not a latency metric and must never enter getLatencyMetrics or '
    'computeAlerts.';
