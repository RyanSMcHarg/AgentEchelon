-- 094: A DRAFT ANSWERS THE GOLDEN SET BEFORE IT IS ACTIVATED (ADR-065, SPEC-EVALUATION FR17).
--
-- THE ENTRY CARRIES WHAT ITS ANSWER WAS GIVEN, so a run answers under the same conditions:
--
--   used_tools        the tools the source answer called, copied at nomination from the answer's recorded tool
--                     calls. The run has no tools, so an entry naming any is answered and recorded as not exercised,
--                     never passed or failed. Copied rather than joined, because `source_exchange_id` goes NULL when
--                     the exchange is deleted and the entry must still say what it needs.
--   reply_preferences the reply-preference keys and the language the asker's turn was answered under: registry values
--                     (`lib/config/reply-preferences.ts`), never the person's words, so the run renders the same
--                     directive the reference was written under.
--   preceding_turns   the turns before the request, from the same de-identified copy as the request, so a follow-up
--                     question is answered and judged with what it refers to. `[{ "role": "user"|"assistant", "text" }]`.
--
-- An entry nominated before this migration has none of the three and is answered as a first turn with no preferences.
--
-- THE RUN RECORD, BOUNDED LIKE THE SET. `golden_runs` is one run of one draft (`draft_config_id`) against the active
-- version (`active_config_id`), k attempts per entry per side; `golden_run_attempts` is one attempt. Both carry
-- `classification`, so the boundary bootstrap's row-level security admits only that classification's reader, and only
-- the write role writes. The gate at Activate reads the latest completed run for the draft's configId.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and transaction-safe.

ALTER TABLE golden_set_entries ADD COLUMN IF NOT EXISTS used_tools TEXT[];
ALTER TABLE golden_set_entries ADD COLUMN IF NOT EXISTS reply_preferences JSONB;
ALTER TABLE golden_set_entries ADD COLUMN IF NOT EXISTS preceding_turns JSONB;

CREATE TABLE IF NOT EXISTS golden_runs (
    id                  UUID PRIMARY KEY,
    classification      VARCHAR(32)  NOT NULL,
    assistant           VARCHAR(64)  NOT NULL,
    draft_config_id     VARCHAR(64)  NOT NULL,
    active_config_id    VARCHAR(64),
    k                   SMALLINT     NOT NULL,
    entries_total       INTEGER      NOT NULL DEFAULT 0,
    entries_done        INTEGER      NOT NULL DEFAULT 0,
    status              VARCHAR(16)  NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    -- The gate's decision over this run (`lib/promotion-gate.ts` GateResult), written when the run completes.
    result              JSONB,
    error               TEXT,
    started_by          VARCHAR(128) NOT NULL,
    started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_golden_runs_draft
    ON golden_runs (classification, assistant, draft_config_id, started_at DESC);

CREATE TABLE IF NOT EXISTS golden_run_attempts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id              UUID         NOT NULL REFERENCES golden_runs(id) ON DELETE CASCADE,
    classification      VARCHAR(32)  NOT NULL,
    entry_id            UUID         NOT NULL REFERENCES golden_set_entries(id) ON DELETE CASCADE,
    side                VARCHAR(8)   NOT NULL CHECK (side IN ('draft', 'active')),
    attempt             SMALLINT     NOT NULL,
    ok                  BOOLEAN      NOT NULL,
    empty               BOOLEAN      NOT NULL,
    blocked             BOOLEAN      NOT NULL,
    breaches            TEXT[]       NOT NULL DEFAULT '{}',
    score               SMALLINT,
    not_exercised       VARCHAR(16),
    model               VARCHAR(128),
    answer_text         TEXT,
    error               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_run_attempts_unique
    ON golden_run_attempts (run_id, entry_id, side, attempt);

COMMENT ON TABLE golden_runs IS
    'One run of a draft version against its classification''s golden set (ADR-065). Bounded by classification; '
    'the gate at Activate reads the latest completed run for the draft''s configId.';
COMMENT ON TABLE golden_run_attempts IS
    'One attempt at one golden entry by one side of a run (ADR-065). Answers are generated from de-identified requests.';
