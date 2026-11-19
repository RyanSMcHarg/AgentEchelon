-- 100: A RUN'S TURNS RECORD WHAT STARTED IT (WT118, the ownership tenet of DESIGN-WORKFLOWS-AND-TASKS section 1).
--
-- Each assistant is measured on its own declared intents, the same way whoever asked: a person's request, another
-- assistant's run asking for the work, or a platform event. The run's messages carry which, so the owning team reads one
-- population per declared intent, with what started each run as its breakdown:
--
--   workflow_trigger   person | assistant | event
--
-- Archival writes it on `messages` from the message's own metadata (a run's `eventRun`, or a task turn's `workflowRun`),
-- a bot message's statement only. The archive record carries it first; this is its projection. NO BACKFILL: a message
-- written before this has none, and NULL says so. Idempotent and transaction-safe: applied at runtime on a cold start
-- inside one transaction.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_trigger VARCHAR(16);

COMMENT ON COLUMN messages.workflow_trigger IS
  'What started the message''s run (WT118): person, assistant or event. NULL on a message no run said, or one written '
  'before it was recorded.';
