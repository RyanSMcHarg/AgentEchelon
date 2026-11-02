-- AN ANSWER IS CHECKED AGAINST WHAT IT WAS GIVEN.
--
-- A retrieval-augmented answer is normally judged on three questions: was the retrieved material
-- relevant, was the answer relevant, and IS EVERY CLAIM IN THE ANSWER SUPPORTED BY WHAT WAS
-- RETRIEVED. The third is called groundedness or faithfulness and is the headline metric in every
-- published rubric for this shape of system. This platform measured the second and not the third.
--
-- The consequence was specific: relevance asks whether the reply addressed the request, and a
-- FABRICATED reply does address it. So a confidently wrong answer citing a real document scored as
-- excellent, and every column on the Effectiveness surface read green on the one failure an operator
-- most wants to catch.
--
-- THE WORD ALREADY APPEARED, WHICH WAS WORSE THAN ITS ABSENCE. Pass B's flow rubric asks whether the
-- information was "correct, grounded, and sufficient" while handing that judge only the transcript:
-- no documents, no citations, nothing to check against. A dimension NAMED grounded, scored by a
-- model with no access to the ground, reads on the surface as the metric being covered. An absent
-- metric is a gap somebody finds; a named one measuring something else is a gap that hides.
--
-- AND THE INSTRUCTION EXISTED WITHOUT THE VERIFICATION. `document-retrieval.ts` tells the answering
-- model "never fabricate a citation, and never stretch a passage to fit a question it does not
-- answer." That is a prompt, not a control: nothing afterwards checked whether it was obeyed.
--
-- THREE STATES, AND NULL IS ONE OF THEM, exactly as compliance established at migration 047:
--
--   true   assessed against the passages this turn retrieved; every claim supported
--   false  assessed; at least one claim is not supported, and `groundedness_notes` says which
--   NULL   NOT ASSESSED. The turn retrieved nothing (so there is no ground to check against), the
--          row predates this, or the judge could not answer.
--
-- NULL is not a default to coalesce. A turn that answered from the model's own knowledge is not
-- ungrounded, it is unretrieved, and counting it either way is an invention. Readers report coverage
-- beside the rate, the same discipline every other verdict here follows.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe (no CREATE INDEX CONCURRENTLY).
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS is_grounded BOOLEAN;

-- What the judge could not find support for, so a false verdict is actionable rather than a flag.
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS groundedness_notes TEXT;

-- How many passages the turn was given. Distinguishes "assessed against eight passages" from
-- "assessed against one", which is the difference between a verdict and a coin toss, and lets a
-- reader see at a glance why a row is NULL (zero passages means nothing to check).
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS retrieved_passage_count SMALLINT;

CREATE INDEX IF NOT EXISTS idx_evaluation_results_grounded
    ON evaluation_results(is_grounded)
    WHERE is_grounded IS NOT NULL;

COMMENT ON COLUMN evaluation_results.is_grounded IS
  'Whether every claim in the reply is supported by the passages the turn actually retrieved. NULL means not assessed: the turn retrieved nothing, the row predates groundedness, or the judge could not answer. A turn that answered from model knowledge is unretrieved, not ungrounded - never coalesce NULL to either verdict.';
COMMENT ON COLUMN evaluation_results.groundedness_notes IS
  'What the judge could not find support for. Present on a false verdict so it is actionable; the claim is quoted from the reply rather than described, so a reader can find it.';
COMMENT ON COLUMN evaluation_results.retrieved_passage_count IS
  'How many passages the turn was given to answer from. Zero is why a row is NULL rather than false, and the count is what tells a reader whether a verdict was made against enough material to mean anything.';
