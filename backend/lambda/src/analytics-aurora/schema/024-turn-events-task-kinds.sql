-- 024-turn-events-task-kinds.sql
--
-- Let one archived event carry BOTH its response kind and its task kind, and retire the RESERVED
-- marking on the three kinds `v_task_resolution` is built from.
--
-- WHY THIS IS NEEDED AT ALL. 019 declared `UNIQUE (source_message_id, source_event_type, occurred_at)`,
-- which was exactly right while every archived event produced exactly ONE ledger row. It stops being
-- right the moment an event produces two: the turn that opens a task both posts a placeholder and
-- opens the task, at the same instant, from the same message. Under the old key the second row is
-- silently discarded by `ON CONFLICT DO NOTHING` - the write succeeds, the count looks plausible, and
-- the task event simply is not there. That is the quietest possible failure for a ledger, so the key
-- gains `kind`.
--
-- The old constraint is DROPPED rather than left alongside: keeping it would still reject the second
-- row, and a constraint that silently defeats a newer one is worse than either alone.
--
-- IDEMPOTENT AND TRANSACTION-SAFE, because this applies at RUNTIME on a Lambda cold start inside one
-- transaction (db-client applyPendingMigrations) - so no CREATE INDEX CONCURRENTLY here.

-- The constraint name Postgres generates for an inline UNIQUE (...) on `turn_events` is
-- `turn_events_source_message_id_source_event_type_occurred_at_key`. Dropped by name IF EXISTS so a
-- cluster that never had it (or that has already run this) is unaffected.
ALTER TABLE turn_events
    DROP CONSTRAINT IF EXISTS turn_events_source_message_id_source_event_type_occurred_at_key;

ALTER TABLE turn_events
    DROP CONSTRAINT IF EXISTS turn_events_event_kind_key;

ALTER TABLE turn_events
    ADD CONSTRAINT turn_events_event_kind_key
    UNIQUE (source_message_id, source_event_type, occurred_at, kind);

-- ============================================================================
-- The task kinds now have a producer.
--
-- `turn-events-live.ts` projects them from what the archive already carried per turn:
--   task_opened      an edge with no `from` - the task's first recorded state
--   task_transition  the turn applied a declared-graph edge
--   task_terminal    the lifecycle status ended the task; `terminal_kind` records HOW
--
-- Derived from the product's own signals (`task_transition`, `task_status`) rather than from a copy of
-- the state-machine table, so the ledger cannot drift out of step with the machines it describes.
-- ============================================================================
COMMENT ON COLUMN turn_events.kind IS
    'What happened. WRITTEN TODAY - turn-scoped: user_message, placeholder_posted, progress_update, '
    'final_response, error_response, notice_posted, continuation_chunk, content_redacted, '
    'message_deleted. WRITTEN TODAY - task-scoped: task_opened, task_transition, task_terminal '
    '(projected from the archive record task_transition/task_status by turn-events-live.ts). '
    'RESERVED, DECLARED BUT NOT WRITTEN BY ANY PRODUCER: processor_entry, content_edited - a query '
    'filtering on one of these returns nothing, which is a property of the writers rather than of the '
    'data. Only final_response may close a response; error_response deliberately may NOT, because a '
    'turn whose wait ended without an answer must not be folded into time-to-answer. An unrecognised '
    'declared phase archives as progress_update, so a new update type is inert by default (fails '
    'closed into "not final").';

COMMENT ON VIEW v_task_resolution IS
    'LIVE since migration 024 - the three kinds this aggregates (task_opened, task_transition, '
    'task_terminal) have a producer in turn-events-live.ts, so an empty result is a statement about '
    'the product rather than about the pipeline. Whole-task resolution, one row per task_id. '
    'resolve_ms is wall clock and is mostly HUMAN think time; agent_ms is the summed per-turn e2e, '
    'the only part the system is accountable for. The difference is user wait. This is not a latency '
    'metric and must never enter getLatencyMetrics or computeAlerts. Rows exist only from the deploy '
    'that carried 024 onward - the ledger is not backfilled, so a task opened before it shows a NULL '
    'opened_at.';
