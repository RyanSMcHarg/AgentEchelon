-- 101: A MOVE NOBODY WAS ASKED ABOUT (WT90, WT93).
--
-- What happens when a person's message changes the subject is a workflow. The platform's `drift` asks the sender, and
-- their answer is `accepted` or `declined`; a version's own may move the subject without asking. That move is recorded as
-- `moved_unasked`, and a change the workflow neither offered nor moved is `not_offered`, so the acceptance rate counts only
-- offers somebody was shown.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE drift_events DROP CONSTRAINT IF EXISTS drift_events_outcome_check;
ALTER TABLE drift_events ADD CONSTRAINT drift_events_outcome_check
  CHECK (outcome IN ('declined', 'rejected_in_new_channel', 'abandoned', 'accepted', 'moved_unasked', 'not_offered'));
