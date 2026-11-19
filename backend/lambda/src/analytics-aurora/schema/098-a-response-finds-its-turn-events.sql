-- 098: a response finds its turn events by its own id.
--
-- The Effectiveness exchange reads ask, for each message, whether a turn event names it as the response
-- (`WHERE tc.response_id = m.message_id AND tc.channel_arn = m.channel_arn`, analytics-query.ts). The indexes
-- on turn_events lead with turn_id, occurred_at, channel_arn or task_id, so that lookup walks every event of
-- the conversation for every message, and a few concurrent reads hold the cluster at its capacity ceiling.
-- This index answers it directly.
--
-- Idempotent (IF NOT EXISTS) and transaction-safe: a plain CREATE INDEX, applied at cold start like every
-- migration.
CREATE INDEX IF NOT EXISTS idx_turn_events_response_channel
    ON turn_events (response_id, channel_arn)
    WHERE response_id IS NOT NULL;
