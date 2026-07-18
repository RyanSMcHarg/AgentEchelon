-- 012-moderation-actions.sql
-- WHO redacted/deleted WHICH message. Written by the analytics API's record_moderation handler at
-- action time with the SERVER-VERIFIED admin identity (actor_sub from the JWT). The Chime
-- redact/delete event keeps the ORIGINAL author, so it cannot attribute the moderator — this table
-- can. The admin conversation read LEFT JOINs it to show "Redacted/Deleted by <actor>".
--
-- The live DB is bootstrapped Create-only, so admin-conversations-aurora.ts also ensures this table
-- at runtime (CREATE TABLE IF NOT EXISTS); this migration covers fresh deployments.
CREATE TABLE IF NOT EXISTS moderation_actions (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn VARCHAR(512) NOT NULL,
    message_id  VARCHAR(128) NOT NULL,
    action      VARCHAR(16)  NOT NULL,   -- 'redact' | 'delete'
    actor_sub   VARCHAR(128) NOT NULL,   -- server-verified admin sub (from the JWT)
    actor_name  VARCHAR(256),            -- display name/email from claims
    actor_arn   VARCHAR(512),            -- optional: the ${sub}-admin identity ARN
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moderation_actions_msg ON moderation_actions(channel_arn, message_id);
