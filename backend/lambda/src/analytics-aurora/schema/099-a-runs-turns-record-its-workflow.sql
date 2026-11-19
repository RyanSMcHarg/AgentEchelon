-- 099: A RUN'S TURNS RECORD ITS WORKFLOW (ADR-067 decision 6, WT60).
--
-- A workflow change is measured by what each run ran, as a task's is by its machine (097). Every message a run says (a
-- send, an agent step's output, a turn of a task the run opened) carries, from the run:
--
--   workflow_name              the workflow, by its name on the version (an intent's, its intent)
--   workflow_step              the run-level step the message belongs to
--   workflow_run_key           the run, so a run's messages are counted once each (`intent#<correlationId>#<assistant>`,
--                              `<event>#<natural key>#<assistant>`)
--   workflow_origin_config_id  the configId of the version the run started on
--   workflow_origin_hash       the content hash of the workflow the run started on: an edit that changes the workflow
--                              changes it, and one to a persona or a machine does not, so a run's edition is its workflow's
--
-- Archival writes them on `messages` from the message's own metadata, a bot message's statement only. The archive record
-- carries them first; this is its projection. NO BACKFILL: a message written before this has none, and NULL says so.
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_name             VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_step             VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_run_key          VARCHAR(200);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_origin_config_id VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_origin_hash      VARCHAR(64);

-- A workflow's runs are read by the edition they ran.
CREATE INDEX IF NOT EXISTS idx_messages_workflow_edition ON messages (workflow_name, workflow_origin_hash)
  WHERE workflow_name IS NOT NULL;

COMMENT ON COLUMN messages.workflow_origin_hash IS
  'Content hash of the workflow the message''s run started on (ADR-067 decision 6). NULL on a message no run said, or one '
  'written before it was recorded.';
