-- 097: A TASK TURN RECORDS THE VERSION AND THE MACHINE ITS TASK STARTED ON (ADR-066).
--
-- An intent's machine rides the assistant's version, and a task follows the version it started on. So a workflow change
-- is measured by what each task ran, a turn bound to a task carries, from the task row:
--
--   task_origin_config_id      the configId of the version the task started on (`Task.originConfigId`), the experiment
--                              arm's where the opening turn was on one
--   task_origin_machine_hash   the content hash of the machine the task started on (`Task.originMachineHash`): the same
--                              canonical JSON and hash a configId is, over the machine alone, so an edit that leaves the
--                              machine as it was keeps it and an edit to the machine changes it
--
-- Archival writes them on `messages` from the turn's analytics, a bot turn's own statement only, as it writes task_type
-- and task_step (092). The archive record carries them first; this is its projection.
--
-- NO BACKFILL: a turn archived before this, and a turn whose task was opened before ADR-066, has no record of either,
-- and NULL says so. Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_origin_config_id    VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS task_origin_machine_hash VARCHAR(64);

-- A workflow's turns are read by the machine they ran.
CREATE INDEX IF NOT EXISTS idx_messages_task_origin_machine ON messages (task_type, task_origin_machine_hash)
  WHERE task_origin_machine_hash IS NOT NULL;

COMMENT ON COLUMN messages.task_origin_machine_hash IS
  'Content hash of the task machine the turn''s task started on (ADR-066). NULL on a turn bound to no task, or to a task '
  'opened before it was recorded.';
