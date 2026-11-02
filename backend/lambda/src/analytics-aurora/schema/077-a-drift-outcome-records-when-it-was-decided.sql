-- ============================================================================
-- 077: A DRIFT OUTCOME RECORDS WHEN IT WAS DECIDED, AND A MOVE IS CHECKED ONCE.
--
-- 1. `outcome_at`. `drift_events` held when a subject was flagged and how the offer ended, but not when it
--    ended, so the conversation record placed "kept here", "moved" and "offer not answered" at the time of
--    the flag. Every outcome writer sets it.
--
-- 2. `engagement_settled`. Accepting an offer writes `accepted` at once, and the abandonment detector only
--    read rows whose outcome was still empty, so "moved, and the new conversation was never used" could not
--    be recorded at all. Whether the move has been checked is its own fact: the detector reads accepted moves
--    that are not yet settled, decides `accepted` or `abandoned` from whether a person spoke there, and
--    settles them; a person who moves and at once raises another subject there settles it as
--    `rejected_in_new_channel`.
--
-- Rows that already have a final answer are settled here, and so is anything older than a day, so the
-- detector does not re-judge history. Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, and the
-- UPDATE touches only rows not yet settled.
-- ============================================================================

ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS engagement_settled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE drift_events
   SET engagement_settled = TRUE
 WHERE engagement_settled = FALSE
   AND ((outcome IS NOT NULL AND outcome <> 'accepted') OR occurred_at < NOW() - INTERVAL '1 day');

CREATE INDEX IF NOT EXISTS idx_drift_events_unsettled_moves
    ON drift_events (occurred_at)
 WHERE engagement_settled = FALSE AND new_channel_arn IS NOT NULL;
