-- Migration 011: evaluation_results.task_id (SPEC-ADMIN-CONSOLE-EFFECTIVENESS P1)
--
-- The Effectiveness drill joins a per-exchange Pass A score to its task flow.
-- evaluation_results already declares flow_id (the intent_flows.id), but Pass A
-- never populated it, and — contrary to the spec's assumption — task_id was NOT
-- declared on this table at all. Without task_id, a score can only reach its flow
-- by round-tripping evaluation_results.exchange_id -> exchanges.id ->
-- exchanges.task_id -> intent_flows.task_id.
--
-- This adds task_id so Pass A can stamp the flow join keys at write time
-- (evaluation-runner.ts): task_id copied from the exchange, flow_id resolved to
-- the intent_flows row when it exists (else backfilled by Pass B's upsert). One
-- query per drill level then groups by intent through the spine, no round-trip.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Same schema-init Update-path caveat as
-- migration 010: does not auto-apply to an already-bootstrapped cluster.

ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS task_id VARCHAR(64);

-- The score->flow grouping and the Pass B backfill filter on task_id.
CREATE INDEX IF NOT EXISTS idx_evaluation_task ON evaluation_results (task_id)
    WHERE task_id IS NOT NULL;

COMMENT ON COLUMN evaluation_results.task_id IS
    'The exchanges.task_id this Pass A score belongs to (NULL for a single-turn '
    'exchange). Stamped at write time so the score joins to its intent_flows row '
    'via flow_id without round-tripping through exchanges. SPEC-ADMIN-CONSOLE-EFFECTIVENESS P1.';
