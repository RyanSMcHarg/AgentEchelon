-- ============================================================================
-- 078: A CLASSIFIER REPLAY RUNS IN ONE CLASSIFICATION, FOR ONE ASSISTANT, AGAINST ITS PACK (tenet D12).
--
-- A replay read every classification's exchanges and ran on one role granted every catalog model, so one
-- principal held several classifications' content and models (ADR-054 decision 5). Each run now names:
--
--   classification  the classification it runs in. Only that classification's exchanges are read, both
--                   candidates must be models it allows (`modelFits`), and the run executes on that
--                   classification's own replay function, whose role can invoke only its models.
--   assistant       the assistant whose classifier is compared. Its exchanges are the corpus.
--   intent_pack     the taxonomy both candidates classify against: that assistant's served pack, resolved
--                   by the starter when the run is opened and kept on the run, so a re-execution asks the
--                   same question the first one did.
--
-- NULL on every run opened before this, which completed under the old shape; nothing re-executes them,
-- and the execute path refuses a run with no classification rather than guessing one.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS only, no data
-- step, applied at cold start inside the migration transaction (db-client applyPendingMigrations).
-- ============================================================================

ALTER TABLE classifier_replay_runs ADD COLUMN IF NOT EXISTS classification VARCHAR(32);
ALTER TABLE classifier_replay_runs ADD COLUMN IF NOT EXISTS assistant VARCHAR(64);
ALTER TABLE classifier_replay_runs ADD COLUMN IF NOT EXISTS intent_pack JSONB;

CREATE INDEX IF NOT EXISTS idx_replay_runs_classification ON classifier_replay_runs (classification, started_at DESC);
