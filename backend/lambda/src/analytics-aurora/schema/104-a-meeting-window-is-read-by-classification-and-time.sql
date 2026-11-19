-- 104: A MEETING WINDOW IS READ BY CLASSIFICATION AND TIME.
--
-- The console's Meetings tab and a meeting's summary read `meeting_events` one classification at a time, each as that
-- classification's reader role, over a window of time (`meeting-events-read.ts`). This index answers that read in order,
-- so a window costs the rows in it rather than a scan of the table per classification.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

CREATE INDEX IF NOT EXISTS meeting_events_classification_at ON meeting_events (classification, event_at);
