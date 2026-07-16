-- 004-experiments.sql
-- A/B experiment tracking and Bedrock resilience metadata
--
-- Adds experiment tracking columns to messages and exchanges tables,
-- plus indices for efficient experiment analysis queries.

-- Messages: track which experiment/variant produced this response
ALTER TABLE messages ADD COLUMN IF NOT EXISTS experiment_id VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS variant_id VARCHAR(64);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS was_fallback BOOLEAN DEFAULT FALSE;

-- Exchanges: track experiment assignment and model fallback details
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS experiment_id VARCHAR(64);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS variant_id VARCHAR(64);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS was_fallback BOOLEAN DEFAULT FALSE;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS primary_model VARCHAR(128);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS actual_model VARCHAR(128);

-- Indices for experiment analysis
CREATE INDEX IF NOT EXISTS idx_messages_experiment ON messages(experiment_id) WHERE experiment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exchanges_experiment ON exchanges(experiment_id, variant_id) WHERE experiment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exchanges_fallback ON exchanges(was_fallback) WHERE was_fallback = TRUE;
