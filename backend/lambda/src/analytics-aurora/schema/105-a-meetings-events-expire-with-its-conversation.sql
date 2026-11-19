-- 105: A MEETING'S EVENTS EXPIRE WITH ITS CONVERSATION, AND A PERSON'S ARE ERASED WITH THEM.
--
-- `meeting_events` names people (`person_key`, the attendee's AppInstanceUser id) and what they did in a meeting. It is a
-- derived copy of the archive's `meeting_events` family, so it declares its own expiry (tenet D7): the longest a
-- conversation lives (`MAX_CONVERSATION_TTL_DAYS`, 270 days), the life of the transcript and the recording of the same
-- meeting. Rows past it are deleted, a bounded batch at a time, by the ingest that files the next meeting events
-- (`meeting-events-ingest.ts`), so the expiry is enforced by the writes the table already takes rather than a timer.
--
-- A person's rows are erased with the rest of the projection's rows that are theirs (`person-erasure.ts`), by
-- `person_key`.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE meeting_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '270 days');

CREATE INDEX IF NOT EXISTS meeting_events_expires_at ON meeting_events (expires_at);
