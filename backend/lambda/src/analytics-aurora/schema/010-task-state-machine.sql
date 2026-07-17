-- Migration 010: per-turn task machine state (SPEC-TASK-STATE-TRANSITIONS §6, SPEC-ADMIN-CONSOLE-EFFECTIVENESS P0)
--
-- The task STATUS lifecycle (pending/in_progress/completed/...) already lands on
-- messages.task_status + exchanges.task_status. The task MACHINE STATE is distinct:
-- the declared-graph state a multi-step task sits in (e.g. report_generation
-- collecting_requirements -> generating -> completed) and the edge traversed on a
-- given turn. lib/analytics-metadata.ts stamps these per turn as `taskState`
-- (the state AFTER the turn) and `taskTransition` ({from,to}, the edge this turn
-- applied, absent when the turn advanced nothing).
--
-- Landing them as columns lets the admin console's Effectiveness drill build the
-- L3 turn timeline from exchange rows (grouped by task_id, ordered by created_at)
-- instead of round-tripping to the agent-tasks DynamoDB row. The DynamoDB
-- stateHistory stays the source of truth; these columns are the per-exchange
-- projection the analytics spine joins on (via exchanges.agent_message_id).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS): safe to apply on a fresh bootstrap, a
-- manual out-of-band ALTER, or an eventual schema-init Update-path upgrade.
-- NOTE: schema-init.ts is a no-op on CloudFormation Update (IAM auth disables
-- password login after the first deploy), so this file does not auto-apply to an
-- already-bootstrapped cluster without one of those mechanisms.

-- messages: mirror the task_id/task_status promotion so the DB-side exchange
-- builder (createExchangesFromDatabase) can read the machine state as a column.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_state VARCHAR(32);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_transition JSONB;

-- exchanges: the analytics hub the Effectiveness drill queries.
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS task_state VARCHAR(32);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS task_transition JSONB;

-- The L3 timeline reads a task's turns in order: (task_id, created_at).
CREATE INDEX IF NOT EXISTS idx_exchanges_task_timeline
    ON exchanges (task_id, created_at)
    WHERE task_id IS NOT NULL;

COMMENT ON COLUMN exchanges.task_state IS
    'Machine state of the task AFTER this turn (declared graph state, e.g. '
    'report_generation "generating"). Distinct from task_status (the lifecycle). '
    'Source of truth is the agent-tasks DynamoDB stateHistory; this is the '
    'per-exchange projection for the Effectiveness drill. From analytics.taskState.';

COMMENT ON COLUMN exchanges.task_transition IS
    'The authorized edge this turn applied, {"from":<state>,"to":<state>}, or NULL '
    'when the turn advanced nothing. Grouped by task_id + ordered by created_at, '
    'these reconstruct the L3 turn timeline. From analytics.taskTransition.';
