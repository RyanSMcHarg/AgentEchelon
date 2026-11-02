-- A PERSON CAN SAY WHETHER AN ANSWER WAS GROUNDED (SPEC-EVALUATION Appendix C4, FR15).
--
-- Every judged reading is shown only beside the agreement it reaches with people, and groundedness had
-- no human half: a person could score relevance and, through an operator script, compliance, but had no
-- way to record whether a reply stayed within the passages it was given. So the groundedness judge could
-- not be calibrated at all, and its rate read with the same authority as the two that could.
--
-- Three states, as on the judge's side (migration 062): true, false, and NULL for "this label does not
-- say", which is never coalesced.
--
-- Runtime-applied migrations run inside ONE transaction, so this is idempotent and transaction-safe.
ALTER TABLE ground_truth_scores ADD COLUMN IF NOT EXISTS human_is_grounded BOOLEAN;

COMMENT ON COLUMN ground_truth_scores.human_is_grounded IS
    'A person''s verdict on whether the reply stayed within the passages the turn retrieved. NULL = the '
    'label does not say. Compared with evaluation_results.is_grounded to calibrate the groundedness judge.';
