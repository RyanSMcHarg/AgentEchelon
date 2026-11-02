-- A SCORE NAMES THE RUBRIC IT WAS JUDGED UNDER.
--
-- Migration 047 did this for compliance: every verdict carries `rule_set_version`, so a finding
-- cites the rules it was assessed against. Relevance and the flow score had no equivalent. They
-- recorded `evaluator_model` - which model judged - and nothing about WHAT IT WAS ASKED.
--
-- That is tolerable exactly as long as the prompt never changes, and every improvement queued for
-- the evaluation runner changes it: removing the intent the judge is currently handed, adding a
-- groundedness verdict, moving from absolute scoring to pairwise. The first of those to ship would
-- leave one column holding two incomparable populations, a trend line crossing the change with no
-- marker on it, and no way to segregate the old rows because nothing recorded what they were
-- scored against.
--
-- This is the NULL discipline of migration 047 one level up. There, the failure was an unassessed
-- row presented as assessed. Here it is a row assessed under different terms presented as
-- comparable - harder to see, because every value looks valid.
--
-- DERIVED, NOT DECLARED. The version is a short hash of the prompt text itself (`componentVersion`,
-- the same helper that stamps `systemPromptHash` on a turn), so it cannot drift from what was
-- actually sent. A hand-maintained constant beside the prompt is a second thing to remember, and
-- the one time it is forgotten is the one time the column lies - which is worse than not having it,
-- because a reader now trusts it.
--
-- NULL means "scored before this shipped". Readers segregate rather than coalesce: a NULL rubric is
-- not the current rubric, and a comparison across that boundary is the thing this column exists to
-- let somebody refuse.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe (no CREATE INDEX CONCURRENTLY).
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS rubric_version VARCHAR(32);

-- BOTH TABLES, because there are two rubrics and they version independently. Pass A's relevance
-- score lands in `evaluation_results`; Pass B's holistic flow score lands in `intent_flows`, under a
-- different prompt AND a set of dimension weights. Re-weighting those five dimensions changes every
-- composite without touching a word of the prompt, so the flow version covers the weights too.
ALTER TABLE intent_flows ADD COLUMN IF NOT EXISTS rubric_version VARCHAR(32);

-- Partial: the rows worth grouping are the ones that carry a version, and NULL is the pre-migration
-- backlog rather than a value anybody filters on.
CREATE INDEX IF NOT EXISTS idx_evaluation_results_rubric_version
    ON evaluation_results(rubric_version)
    WHERE rubric_version IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intent_flows_rubric_version
    ON intent_flows(rubric_version)
    WHERE rubric_version IS NOT NULL;

COMMENT ON COLUMN intent_flows.rubric_version IS
  'Short hash of the flow judge prompt AND its dimension weights. Re-weighting the five dimensions changes every composite without changing a word of the prompt, so both are in the hash.';

COMMENT ON COLUMN evaluation_results.rubric_version IS
  'Short hash of the judge prompt that produced this score, derived from the prompt text rather than declared beside it. Pass A rows carry the relevance rubric; flow rows carry the flow rubric and its weights. NULL means the row was scored before rubric versioning shipped: segregate it, never treat it as the current rubric.';
