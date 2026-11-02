-- A GOLDEN ENTRY IS DE-IDENTIFIED AND CLASSIFIED (SPEC-EVALUATION Appendix C1, FR16).
--
-- The golden set is what a draft version is run against before it is activated (FR17). Three properties
-- decide its shape:
--
--   DE-IDENTIFIED, NEVER THE RAW EXCHANGE. An entry is copied from the conversation's de-identified copy
--   (`clean_conversation_rows`, migration 069): people as pseudonyms and personal details described
--   rather than shown. So the set holds no personal data for offboarding to erase, and it outlives the
--   conversation without outliving anybody's right to be removed. `source_exchange_id` is a pointer for
--   provenance, set NULL when the exchange goes, never a way back to the person.
--
--   PER CLASSIFICATION, INSIDE THE BOUNDARY. `classification` is the conversation's, and the table is a
--   bounded table (`classification-boundary-sql.ts`): row-level security lets a classification's reader
--   role see only the entries its grant set covers, and only the writer role writes. Another
--   classification's role is refused, which a deny test proves.
--
--   TWO PURPOSES. `regression`: cases the active version passes and must keep passing. `capability`: cases it
--   does not pass yet. A capability entry that passes reliably is promoted to regression.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe. The boundary bootstrap that runs after the migrations enables row-level security on
-- this table and creates its policies.
CREATE TABLE IF NOT EXISTS golden_set_entries (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    classification      VARCHAR(32)  NOT NULL,
    purpose                VARCHAR(16)  NOT NULL CHECK (purpose IN ('regression', 'capability')),
    assistant           VARCHAR(64),
    intent              VARCHAR(64),
    -- The de-identified request, and the de-identified answer a person judged good (the reference). The
    -- reference is NULL on a capability entry nominated from an answer that failed.
    request_text        TEXT         NOT NULL,
    reference_text      TEXT,
    -- The person's verdict that put the entry here, copied so the entry stands without the label row.
    human_score         SMALLINT,
    source_exchange_id  UUID REFERENCES exchanges(id) ON DELETE SET NULL,
    nominated_by        VARCHAR(128) NOT NULL,
    nominated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    retired_at          TIMESTAMPTZ,
    retired_by          VARCHAR(128)
);

-- One live entry per source exchange: nominating the same answer twice is a no-op, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_set_entries_source
    ON golden_set_entries (source_exchange_id)
    WHERE retired_at IS NULL AND source_exchange_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_golden_set_entries_class
    ON golden_set_entries (classification, purpose)
    WHERE retired_at IS NULL;

COMMENT ON TABLE golden_set_entries IS
    'The golden set a draft version is run against before activation (SPEC-EVALUATION FR16, FR17). '
    'De-identified text only; per classification under row-level security; regression or capability purpose.';
