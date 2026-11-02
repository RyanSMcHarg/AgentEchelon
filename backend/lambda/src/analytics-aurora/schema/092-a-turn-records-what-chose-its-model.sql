-- 092: a turn records the work it is attributed to and what chose its model (ADR-064 decision 4).
--
-- A turn's model is chosen by its message's intent, or, for a turn bound to a task, by the step the task was in when
-- the turn started where the version's route overrides that step or the step delivers the intent's work. The turn is
-- attributed to the task's type whichever chose the model, so Effectiveness groups a task turn under
-- COALESCE(task_type, intent) at query time and `intent` keeps the classifier's intent on every row.
--
--   task_type   the task's type (an intent key, or a platform machine's type), NULL on a turn bound to no task
--   task_step   the state the task was in when the turn started, which chose the model; task_state stays the state after
--   model_kind  'text' or 'image'
--   model_from  'experiment', 'version_rule', 'context_rule', 'step', 'route', 'general' or 'base'
--
-- Archival writes them on `messages` from the turn's analytics and reads them onto `exchanges` off the answering
-- message, the way the profile columns are. `exchanges.original_intent` had no writer (no turn ever stated an
-- original intent) and is dropped, so no column claims a meaning nothing records.
--
-- NO BACKFILL: a row archived before this has no record of what chose its model, and NULL says so.
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE messages  ADD COLUMN IF NOT EXISTS task_type  VARCHAR(64);
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS task_step  VARCHAR(32);
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS model_kind VARCHAR(8);
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS model_from VARCHAR(16);

ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS task_type  VARCHAR(64);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS task_step  VARCHAR(32);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS model_kind VARCHAR(8);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS model_from VARCHAR(16);

ALTER TABLE exchanges DROP COLUMN IF EXISTS original_intent;

-- Effectiveness reads a task's turns by type and step.
CREATE INDEX IF NOT EXISTS idx_exchanges_task_type_step ON exchanges (task_type, task_step) WHERE task_type IS NOT NULL;

COMMENT ON COLUMN exchanges.task_step IS
  'The task state the turn STARTED in, which chose its model where the route overrides that step or the step delivers. '
  'task_state is the state after the turn. NULL on a turn bound to no task.';
COMMENT ON COLUMN exchanges.model_from IS
  'Which rule chose the model: experiment, version_rule, context_rule, step, route, general or base (ADR-064).';
