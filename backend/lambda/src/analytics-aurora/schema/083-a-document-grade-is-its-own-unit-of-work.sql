-- A DOCUMENT GRADE IS ITS OWN UNIT OF WORK (SPEC-EVALUATION FR22).
--
-- A delivered document is graded in a row of its own (`evaluation_type = 'document'`, migration 082).
-- Whether that row exists says whether the document was scored, and nothing else: a document that was
-- not graded leaves no row, whatever the reason. Two reasons need telling apart.
--
--   * TERMINAL. The producing task is private, the archive holds no copy, or the copy does not match,
--     is empty or is longer than the judge is shown. Trying again gives the same answer.
--   * TRANSIENT. The judge call threw, or the archive's copy could not be read. Trying again can work.
--
-- The runner picks up an exchange that delivered a document and has no document row, so a transient
-- failure is retried by the next run. This table is what stops that being forever: it records each
-- failed attempt and each terminal skip, so a document that keeps failing stops after a bounded number
-- of attempts and is reported as such, and one that cannot be graded is not read again.
--
-- ONE ROW PER EXCHANGE, written only when a document was NOT scored on some attempt. A document scored
-- on its first try has no row here; one scored after a failure keeps its row with `status = 'scored'`,
-- so the attempt count stays readable.
--
--   status          retrying   a transient failure; the next run tries again
--                   exhausted  `attempts` reached the runner's bound; not tried again, and reported
--                   skipped    a terminal reason (`skip_reason`); not tried again
--                   scored     a later attempt wrote the document row
--   skip_reason     private | not-archived | hash-mismatch | empty | too-long  (terminal only)
--   last_error      the last transient failure's message, bounded by the runner; never document text
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, no CONCURRENTLY.
CREATE TABLE IF NOT EXISTS document_grading_attempts (
    exchange_id UUID PRIMARY KEY REFERENCES exchanges(id) ON DELETE CASCADE,
    artifact_sha256 VARCHAR(64),
    status VARCHAR(16) NOT NULL CHECK (status IN ('retrying', 'exhausted', 'skipped', 'scored')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    skip_reason VARCHAR(32),
    last_error TEXT,
    first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The runner's pickup reads the rows still open; the console reads the rest by exchange.
CREATE INDEX IF NOT EXISTS idx_document_grading_open
    ON document_grading_attempts (status)
 WHERE status = 'retrying';

COMMENT ON TABLE document_grading_attempts IS
  'Why a delivered document has no document-type evaluation row yet: a transient failure being retried, a bounded run of failures that stopped (exhausted), or a terminal skip. One row per exchange; absent when the document was scored on its first attempt.';
COMMENT ON COLUMN document_grading_attempts.attempts IS
  'Failed grading attempts. The runner stops at its bound (EVAL_DOCUMENT_MAX_ATTEMPTS) and sets status exhausted.';
COMMENT ON COLUMN document_grading_attempts.skip_reason IS
  'On status skipped: private | not-archived | hash-mismatch | empty | too-long. NULL otherwise.';
