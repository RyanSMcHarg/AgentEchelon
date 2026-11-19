-- 103: A MEETING EVENT SAYS WHERE IT CAME FROM.
--
-- The meeting's own lifecycle comes from Amazon Chime SDK (`server`); what only a participant's app can see, such as
-- how long joining took or a microphone that failed, comes from the app (`client`); and what the platform does around a
-- meeting, such as a ring it sent, comes from the platform (`platform`). One log holds all three, so a figure over one
-- of them names it and a figure over all of them can still order them in time. Rows filed before this column existed
-- are the service's lifecycle, the only source there was.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE meeting_events ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'server';
ALTER TABLE meeting_events DROP CONSTRAINT IF EXISTS meeting_events_source_check;
ALTER TABLE meeting_events ADD CONSTRAINT meeting_events_source_check CHECK (source IN ('server', 'client', 'platform'));
