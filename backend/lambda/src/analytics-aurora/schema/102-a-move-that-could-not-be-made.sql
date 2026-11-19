-- 102: A YES WHOSE MOVE COULD NOT BE MADE.
--
-- A person answered an offer with yes and the subject did not move; they are told, and the offer is closed. `move_failed`
-- records that ending, so the sweep does not later count the offer as one nobody answered.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE drift_events DROP CONSTRAINT IF EXISTS drift_events_outcome_check;
ALTER TABLE drift_events ADD CONSTRAINT drift_events_outcome_check
  CHECK (outcome IN ('declined', 'rejected_in_new_channel', 'abandoned', 'accepted', 'moved_unasked', 'not_offered', 'move_failed'));
