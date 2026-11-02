-- A DELIVERED DOCUMENT IS GRADED AS ITSELF (SPEC-EVALUATION FR22).
--
-- When a turn delivers a file - a report, an extraction, code - the exchange's response is the chat
-- reply beside it, and the file is the deliverable the person asked for. The runner scored the reply
-- only, so the quality of every delivered document went unmeasured.
--
-- A document's score is its OWN ROW, `evaluation_type = 'document'`, beside the exchange's reply row
-- (`evaluation_type = 'exchange'`). Separate rows rather than extra columns on the reply's row, because
-- the two are different artifacts judged by different evidence, and every existing reader of a reply
-- score already filters on `evaluation_type = 'exchange'`: a document score cannot be pooled into a
-- reply rate by a reader that predates it.
--
-- WHICH ARTIFACT A SCORE IS ABOUT, on the row:
--   artifact_key     the archive key of the copy the judge read (`delivered-documents/...`)
--   artifact_sha256  the SHA-256 of the bytes the turn delivered, which the archive's copy matches
-- Both NULL on an exchange row, whose artifact is the reply.
--
-- AT MOST ONE DOCUMENT ROW PER EXCHANGE, for the reason migration 028 gives for the reply row: two
-- overlapping scheduled runs can both see the same exchange, and the loser is a no-op rather than a
-- second score.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, no CONCURRENTLY. The unique
-- index is created over a type no row has yet, so it cannot fail on existing data.
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS artifact_key TEXT;
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS artifact_sha256 VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_one_document_row
    ON evaluation_results (exchange_id)
 WHERE evaluation_type = 'document';

COMMENT ON COLUMN evaluation_results.artifact_key IS
  'On a document row (evaluation_type = ''document''): the archive key of the delivered document the judge read. NULL on an exchange row, whose artifact is the chat reply.';
COMMENT ON COLUMN evaluation_results.artifact_sha256 IS
  'On a document row: the SHA-256 of the delivered document''s bytes, as the turn recorded it when it uploaded the file. NULL on an exchange row.';
COMMENT ON INDEX idx_evaluation_one_document_row IS
  'One document-type evaluation per exchange. A document score is a row of its own beside the reply''s exchange-type row, so the two artifacts are never pooled.';
