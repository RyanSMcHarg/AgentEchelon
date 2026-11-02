-- 041: the router's pre-placeholder path becomes divisible.
--
-- WHAT WAS MISSING. `router_ms` is the router handler's own compute and sits IN FRONT of the
-- placeholder, so all of it is inside TTFF. It divided exactly once: `classifier_ms` broken out, and
-- everything else as `avg_router_other_ms` - a single derived residual covering the channel reads,
-- the SSM reads, the task lookup, the drift check, the ADR-033 claim and the grounding fetch at
-- once. When that residual moved by 865 ms, the finest thing the data could say was "the router got
-- slower". A fix measured against a number that cannot be decomposed cannot be shown to have worked.
--
-- INSTANTS, NOT COLUMNS (LATENCY-TARGETS.md G12). Each boundary is a row saying WHEN it was reached;
-- the durations are derived by subtracting consecutive instants, the way v_turn_latency already
-- derives the outer bracket. A stamped duration is a claim nobody can re-check - it cannot be
-- recomputed or compared against a neighboring span, only believed. Two instants can disagree with
-- each other and with `router_ms`, and a disagreement is a finding. That is also why this is not six
-- more INTEGER columns: the set of boundaries worth naming will change, and a column per boundary
-- makes each change a migration.
--
-- SERVER CLOCK, ATTESTED. These instants never appeared in the Amazon Chime SDK message stream, so
-- they are `clock='server'`, `auditable=false`, like `processor_entry`. Deltas between them are exact
-- and skew-free - one Lambda, one clock - and none of them is provable against the archive.
--
-- THE COST, STATED. This adds roughly nine ledger rows per dispatched turn, which is the largest
-- single increase in this table's write volume since it was created. It buys the only decomposition
-- of the span the TTFF target is about. The rows carry the same 90-day expiry as every other, so the
-- steady-state size is bounded by the same window.
--
-- Idempotent and transaction-safe: applied at RUNTIME on a cold start inside one transaction
-- (db-client applyPendingMigrations), so no CREATE INDEX CONCURRENTLY.

-- WHICH BOUNDARY. NULL on every row that is not a router step, which is every row written before
-- this migration.
ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS step_name VARCHAR(48);

COMMENT ON COLUMN turn_events.step_name IS
    'On a router_step row: which boundary of the router''s pre-placeholder path this instant marks '
    '(lib/router-steps.ts declares the set). NULL on every other kind. A step that did not run marks '
    'nothing, so ABSENCE means the branch skipped it - never that it was free.';

-- ── THE NATURAL KEY GAINS THE STEP, FOR THE SAME REASON 024 GAVE IT `kind` ──
--
-- 024's key is (source_message_id, source_event_type, occurred_at, kind). Every router_step row from
-- one turn shares all four and differs only in `occurred_at` - so two boundaries reached inside the
-- same millisecond, which is routine when a read is cached, collide. Under `ON CONFLICT DO NOTHING`
-- the second is discarded silently: the write succeeds, the count looks plausible, and one boundary
-- is simply absent. The step whose instant was dropped then has its time folded into its neighbor,
-- which is worse than not measuring at all - it reports a wrong attribution rather than none.
--
-- AN EXPRESSION INDEX, NOT AN EXTENDED CONSTRAINT, and the difference matters. Adding a NULLable
-- column to a UNIQUE constraint would make every EXISTING row mutually non-conflicting, because a
-- UNIQUE treats NULLs as distinct - redelivery dedup would quietly stop working for every ordinary
-- ledger row. COALESCE(step_name, '') keeps non-step rows arbitrated exactly as they were.
ALTER TABLE turn_events
    DROP CONSTRAINT IF EXISTS turn_events_event_kind_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_events_event_kind_step
    ON turn_events (source_message_id, source_event_type, occurred_at, kind, COALESCE(step_name, ''));

-- ── AND ONE INSTANT PER (MESSAGE, STEP), WHICHEVER EVENT CARRIED IT ──
--
-- The step log rides the out-of-band analytics record, which the archive merges onto EVERY event of
-- a bot message - the CREATE and its -UPD sibling both carry it, exactly as they both carry the task
-- blob (migration 025). Without this each would write its own copy of every boundary, and
-- v_router_steps would compute a zero-length span between the two copies of each step.
--
-- Same shape and same reason as uq_turn_events_task_fact: the database is the dedup point, because
-- no per-record writer can know whether a sibling event already wrote the fact. First arrival wins,
-- which dates each boundary at the CREATE instant - and the CREATE is the record whose blob was
-- written by the turn that measured it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_events_router_step_fact
    ON turn_events (source_message_id, kind, step_name)
    WHERE kind = 'router_step';

-- The view below reads one response's steps at a time; without this it scans the ledger.
CREATE INDEX IF NOT EXISTS idx_turn_events_router_step
    ON turn_events (response_id, occurred_at)
    WHERE kind = 'router_step';

COMMENT ON COLUMN turn_events.kind IS
    'What happened. WRITTEN TODAY - turn-scoped: user_message, placeholder_posted, progress_update, '
    'final_response, cancelled_response, error_response, notice_posted, continuation_chunk, '
    'content_redacted, message_deleted, router_step (server clock, one row per boundary of the '
    'router''s pre-placeholder path, named by step_name). WRITTEN TODAY - task-scoped: task_opened, '
    'task_transition, task_terminal (projected from the archive record task_transition/task_status '
    'by turn-events-live.ts). RESERVED, DECLARED BUT NOT WRITTEN BY ANY PRODUCER: processor_entry, '
    'content_edited - a query filtering on one of these returns nothing, which is a property of the '
    'writers rather than of the data. Only final_response may close a response; error_response and '
    'cancelled_response deliberately may NOT, because a turn whose wait ended without an answer must '
    'not be folded into time-to-answer. An unrecognised declared phase archives as progress_update, '
    'so a new update type is inert by default (fails closed into "not final").';

-- ============================================================================
-- v_router_steps: what each boundary of the router leg cost, derived.
--
-- One row per (response, boundary). `step_ms` is this instant less the previous one for the same
-- response, so it is a DERIVED duration that can be recomputed from the rows beside it - and the
-- steps of one response sum to `router_ms` for that response, which is the check that says the
-- instrumentation is honest.
--
-- `entry` carries a NULL step_ms by construction: it is the origin, not a step.
--
-- TIED INSTANTS. Two boundaries can share a millisecond, and the tie-break on step_name is
-- deterministic rather than meaningful - a tied pair produces a zero-length span whichever way round
-- it is read, and the following step's duration is identical either way.
-- ============================================================================
CREATE OR REPLACE VIEW v_router_steps AS
SELECT
    te.turn_id,
    te.response_id,
    te.channel_arn,
    te.step_name,
    te.occurred_at,
    (EXTRACT(EPOCH FROM (te.occurred_at - LAG(te.occurred_at) OVER w)) * 1000)::integer AS step_ms
  FROM turn_events te
 WHERE te.kind = 'router_step'
WINDOW w AS (PARTITION BY te.response_id ORDER BY te.occurred_at, te.step_name);

COMMENT ON VIEW v_router_steps IS
    'What each boundary of the router''s pre-placeholder path cost, derived from the ledger''s '
    'instants rather than stamped. One row per (response_id, step_name); step_ms is this instant less '
    'the previous one for that response, and is NULL for `entry`, which is the origin. The steps of a '
    'response sum to messages.router_ms for that response - a residual that will not close is a '
    'measurement bug, not a rounding matter. An ABSENT step means the branch did not run it (a fast '
    'path never classifies, a triage turn never claims, only the placeholder path fetches grounding); '
    'it never means the step was free. Server clock, attested by the router and not provable against '
    'the message stream.';
