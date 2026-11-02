-- 093: a task turn is attributed to the intent of its work (ADR-064 decisions B and I).
--
-- task_type holds the work a task turn is attributed to: the task's type where that type is an intent the pack declares,
-- and otherwise the intent the request that opened the task was classified as. A platform machine (queued_request,
-- queue_drain, work_still_wanted, ...) is not an intent, so a turn of one is counted under the work it carries, and
-- Effectiveness groups every task turn under COALESCE(task_type, intent). The machine itself rides in the turn's metadata
-- (taskMachine) where it differs.
--
-- A folded queued message's exchange (queued_as = 'folded') carries its own classified intent and the task_type,
-- task_step, model_kind and model_from of the turn that completed it.
--
-- NO BACKFILL and no column change: a row archived before this keeps what it recorded.
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

COMMENT ON COLUMN exchanges.task_type IS
  'The work a task turn is attributed to: the task type where it is an intent, else the intent of the request that '
  'opened the task (ADR-064). NULL on a turn bound to no task. Effectiveness groups by COALESCE(task_type, intent).';
COMMENT ON COLUMN messages.task_type IS
  'The work a task turn is attributed to: the task type where it is an intent, else the intent of the request that '
  'opened the task (ADR-064). NULL on a person''s message and on a turn bound to no task.';
