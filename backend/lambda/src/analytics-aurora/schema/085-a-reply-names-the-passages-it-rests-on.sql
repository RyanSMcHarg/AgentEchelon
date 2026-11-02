-- A REPLY NAMES THE PASSAGES IT RESTS ON (SPEC-EVALUATION Appendix C7, proposed FR24).
--
-- Groundedness says whether the reply stayed within what the turn retrieved. It does not say which of
-- the retrieved passages the reply actually used, and a passage that was retrieved and never used is a
-- retrieval finding, owned by whoever curates the context source rather than by the assistant's team.
--
-- The groundedness judge already holds the request, every passage and the reply, so it returns the
-- passages the reply's claims rest on in the same call, and this records how many. Judging each
-- passage's relevance to the request in isolation is not used: it tracks answer quality weakly, while a
-- passage's contribution to the answer is the reading that tracks it.
--
-- NULL means NOT ASSESSED, as it does for `is_grounded`: the turn retrieved nothing, the row predates
-- this, or the judge did not say. Zero means it was assessed and the reply used none of them.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe.
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS used_passage_count SMALLINT;

COMMENT ON COLUMN evaluation_results.used_passage_count IS
    'How many of the retrieved_passage_count passages the reply''s claims rest on, as the groundedness '
    'judge returned them. NULL = NOT ASSESSED (nothing retrieved, a pre-085 row, or no answer), never a '
    'default. Read as a share of retrieved_passage_count over the rows that carry both.';

-- Each passage's source and whether the reply used it, as [{"sourceId", "title", "used"}], so retrieval
-- is readable per context source rather than only per intent. NULL exactly when used_passage_count is.
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS passage_sources JSONB;

COMMENT ON COLUMN evaluation_results.passage_sources IS
    'Per retrieved passage, in the order the judge was shown them: its sourceId and title, and whether '
    'the reply rests on it. NULL = NOT ASSESSED, exactly when used_passage_count is NULL.';

-- WHICH GROUNDEDNESS RUBRIC JUDGED THIS ROW. `rubric_version` names the relevance rubric; the
-- groundedness prompt is a separate rubric with its own derived version, and without its own column a
-- change to it could not start a new calibration series (SPEC-EVALUATION Appendix C4). NULL when no
-- groundedness verdict was attempted.
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS groundedness_rubric_version VARCHAR(64);
