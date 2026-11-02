-- 095: A DEPLOYMENT UPLOADS ITS OWN GOLDEN ENTRIES (ADR-065 decision 7, SPEC-EVALUATION FR27, FR30).
--
-- An entry arrives in one of three ways, and a result says which, so a reader can tell a case people judged from
-- labeled traffic from one the deployment wrote:
--
--   source     'nominated' from a labeled answer (every entry before this migration), 'uploaded' from a deployment's
--              file, 'generated' from the intent pack by the utility model (ADR-065 decision 8).
--   upload_id  the upload or generation an entry arrived in, so a whole batch can be retired at once, and a retry of one
--              writes nothing. NULL for a nominated entry.
--
-- The uploader is `nominated_by`, as a nominator is. An uploaded entry is de-identified before it is written, by the
-- detector the clean copy uses, so the set still holds no personal data.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and transaction-safe.

ALTER TABLE golden_set_entries ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'nominated';
ALTER TABLE golden_set_entries ADD COLUMN IF NOT EXISTS upload_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'golden_set_entries_source_check') THEN
    ALTER TABLE golden_set_entries
      ADD CONSTRAINT golden_set_entries_source_check CHECK (source IN ('nominated', 'uploaded', 'generated'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_golden_set_entries_upload
    ON golden_set_entries (upload_id)
    WHERE upload_id IS NOT NULL AND retired_at IS NULL;

-- AN UPLOAD OR A GENERATION RUNS IN THE BACKGROUND, and this row is its report: opened when it starts, so a second start
-- of the same batch while it runs does nothing, and closed with how it ended (what was written, or the refusal's code and
-- values). Bounded like the set: it names the assistant and carries counts and codes, never an entry's text.
CREATE TABLE IF NOT EXISTS golden_batches (
    id              UUID PRIMARY KEY,
    classification  VARCHAR(32)  NOT NULL,
    assistant       VARCHAR(64)  NOT NULL,
    kind            VARCHAR(16)  NOT NULL CHECK (kind IN ('upload', 'generation')),
    status          VARCHAR(16)  NOT NULL CHECK (status IN ('running', 'complete', 'refused', 'failed')),
    result          JSONB,
    requested_by    VARCHAR(128) NOT NULL,
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_golden_batches_assistant ON golden_batches (classification, assistant, started_at DESC);
