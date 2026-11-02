-- ============================================================================
-- 075: THE ASSISTANT COLUMN NAMES WHAT IT HOLDS (ADR-051).
--
-- `agent_type` holds the assistant's stable identifier (`AssistantProfile.name`, migration 055) under a
-- name that promises a category. An assistant has an id, a classification and a role; it does not have
-- a type. The value is right and stays; the column is renamed to `assistant`, the assignment record's
-- own field name.
--
-- A RENAME IN TWO STEPS, because the column is written by the archival Lambda and read by the query
-- Lambdas, and they deploy as separate functions. Renaming in one statement would make whichever runs
-- older code fail every insert or every read until it is replaced. So:
--
--   1. THIS MIGRATION adds `assistant` beside `agent_type` on every table that carries it, keeps the two
--      equal with a trigger whichever one a writer sets, and backfills `assistant` in bounded batches.
--      The code that ships with it writes and reads `assistant`.
--   2. A LATER MIGRATION drops `agent_type` and the trigger, once no deployed code names it.
--
-- The views keep their `agent_type` output column through step 1: replacing a view's columns is the
-- outage class migration 054 avoided, and a reader takes the value from the column it selects, which
-- the trigger keeps equal. Step 2 replaces them.
--
-- The same width as `agent_type`, so the trigger can always copy one into the other.
--
-- BOUNDED AND RESUMABLE, like 071, 073 and 074. Idempotent and transaction-safe: ADD COLUMN IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER, CREATE INDEX IF NOT
-- EXISTS (no CONCURRENTLY), and every UPDATE fills only a NULL.
-- ============================================================================

ALTER TABLE conversations      ADD COLUMN IF NOT EXISTS assistant VARCHAR(32);
ALTER TABLE messages           ADD COLUMN IF NOT EXISTS assistant VARCHAR(32);
ALTER TABLE exchanges          ADD COLUMN IF NOT EXISTS assistant VARCHAR(32);
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS assistant VARCHAR(32);
ALTER TABLE intent_flows       ADD COLUMN IF NOT EXISTS assistant VARCHAR(32);
ALTER TABLE agent_scores       ADD COLUMN IF NOT EXISTS assistant VARCHAR(32);

COMMENT ON COLUMN messages.assistant IS
  'The assistant that sent this message: AssistantProfile.name, its stable identifier (never a display '
  'name and never its classification). NULL on a person''s message, and on rows archived before the '
  'assistant was recorded (migration 055). Renamed from agent_type (ADR-051).';
COMMENT ON COLUMN exchanges.assistant IS
  'The assistant that answered this exchange: AssistantProfile.name. Renamed from agent_type (ADR-051).';

-- ── EITHER NAME A WRITER SETS, BOTH COLUMNS HOLD IT ─────────────────────────────────────────────
-- On INSERT, whichever was given fills the other. On UPDATE, the one that changed wins; a statement
-- that changes neither changes nothing here.
CREATE OR REPLACE FUNCTION ae_assistant_column_sync() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.assistant  := COALESCE(NEW.assistant, NEW.agent_type);
        NEW.agent_type := COALESCE(NEW.agent_type, NEW.assistant);
    ELSIF NEW.assistant IS DISTINCT FROM OLD.assistant THEN
        NEW.agent_type := NEW.assistant;
    ELSIF NEW.agent_type IS DISTINCT FROM OLD.agent_type THEN
        NEW.assistant := NEW.agent_type;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversations_assistant ON conversations;
CREATE TRIGGER trg_conversations_assistant BEFORE INSERT OR UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync();
DROP TRIGGER IF EXISTS trg_messages_assistant ON messages;
CREATE TRIGGER trg_messages_assistant BEFORE INSERT OR UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync();
DROP TRIGGER IF EXISTS trg_exchanges_assistant ON exchanges;
CREATE TRIGGER trg_exchanges_assistant BEFORE INSERT OR UPDATE ON exchanges
    FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync();
DROP TRIGGER IF EXISTS trg_evaluation_results_assistant ON evaluation_results;
CREATE TRIGGER trg_evaluation_results_assistant BEFORE INSERT OR UPDATE ON evaluation_results
    FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync();
DROP TRIGGER IF EXISTS trg_intent_flows_assistant ON intent_flows;
CREATE TRIGGER trg_intent_flows_assistant BEFORE INSERT OR UPDATE ON intent_flows
    FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync();
DROP TRIGGER IF EXISTS trg_agent_scores_assistant ON agent_scores;
CREATE TRIGGER trg_agent_scores_assistant BEFORE INSERT OR UPDATE ON agent_scores
    FOR EACH ROW EXECUTE FUNCTION ae_assistant_column_sync();

-- The indexes agent_type carries, on the column readers now filter by.
CREATE INDEX IF NOT EXISTS idx_exchanges_assistant ON exchanges(assistant);
CREATE INDEX IF NOT EXISTS idx_intent_flows_assistant ON intent_flows(assistant);
CREATE INDEX IF NOT EXISTS idx_agent_scores_assistant ON agent_scores(assistant, date);

DO $repair$
DECLARE
    batch_size CONSTANT integer := 5000;
    left_to_do bigint;
BEGIN
    UPDATE conversations SET assistant = agent_type
     WHERE ctid IN (SELECT ctid FROM conversations WHERE assistant IS NULL AND agent_type IS NOT NULL LIMIT batch_size);
    UPDATE messages SET assistant = agent_type
     WHERE ctid IN (SELECT ctid FROM messages WHERE assistant IS NULL AND agent_type IS NOT NULL LIMIT batch_size);
    UPDATE exchanges SET assistant = agent_type
     WHERE ctid IN (SELECT ctid FROM exchanges WHERE assistant IS NULL AND agent_type IS NOT NULL LIMIT batch_size);
    UPDATE evaluation_results SET assistant = agent_type
     WHERE ctid IN (SELECT ctid FROM evaluation_results WHERE assistant IS NULL AND agent_type IS NOT NULL LIMIT batch_size);
    UPDATE intent_flows SET assistant = agent_type
     WHERE ctid IN (SELECT ctid FROM intent_flows WHERE assistant IS NULL AND agent_type IS NOT NULL LIMIT batch_size);
    UPDATE agent_scores SET assistant = agent_type
     WHERE ctid IN (SELECT ctid FROM agent_scores WHERE assistant IS NULL AND agent_type IS NOT NULL LIMIT batch_size);

    SELECT (SELECT COUNT(*) FROM conversations      WHERE assistant IS NULL AND agent_type IS NOT NULL)
         + (SELECT COUNT(*) FROM messages           WHERE assistant IS NULL AND agent_type IS NOT NULL)
         + (SELECT COUNT(*) FROM exchanges          WHERE assistant IS NULL AND agent_type IS NOT NULL)
         + (SELECT COUNT(*) FROM evaluation_results WHERE assistant IS NULL AND agent_type IS NOT NULL)
         + (SELECT COUNT(*) FROM intent_flows       WHERE assistant IS NULL AND agent_type IS NOT NULL)
         + (SELECT COUNT(*) FROM agent_scores       WHERE assistant IS NULL AND agent_type IS NOT NULL)
      INTO left_to_do;

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('075-the-assistant-column-names-what-it-holds.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END
$repair$;
