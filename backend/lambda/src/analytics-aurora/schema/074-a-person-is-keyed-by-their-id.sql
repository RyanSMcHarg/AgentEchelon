-- ============================================================================
-- 074: A PERSON IS KEYED BY THEIR ID ON THE TURN TABLES (ADR-043 decision 4).
--
-- `user_sub` is the person key across client_events, cross_conversation_context, channel_membership,
-- drift_events and conversation_creation_tasks. The two turn tables did not carry it: `messages` named
-- a person by `sender_arn` and `sender_name`, and `exchanges` held no person at all beyond `user_role`.
-- So a person's turns could be joined to their other records only through an ARN parse or a display
-- name, and a display name is not an identity.
--
-- THE SAME SHAPE drift_events stores: the bare id after `/user/` in the sender ARN (`classifyPrincipal`
-- in principal-role.ts). A person's chat identity is their Cognito sub; the admin-plane identity is
-- `<sub>-admin` and `user_role` already says it is the admin plane; a federated sender is `fed_...`.
-- NULL on an assistant's message: the assistant is the `agent_type` column, and putting a bot's id in a
-- person column would make "this person's turns" include an assistant's.
--
-- `exchanges.user_sub` is the person who ASKED, copied from the user message the exchange pairs.
--
-- The view is not replaced (migration 054's rule): no reader of v_turn_latency changes here, and a
-- CREATE OR REPLACE VIEW is the outage class 054 avoided.
--
-- BOUNDED AND RESUMABLE, like 071 and 073: one batch of messages per application, reported in
-- _migration_progress, then exchanges filled from messages that already carry the id. Rows archived
-- after this ships are written with it, so the backfill only ever shrinks.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS (no
-- CONCURRENTLY), and every UPDATE fills only a NULL.
-- ============================================================================

ALTER TABLE messages  ADD COLUMN IF NOT EXISTS user_sub VARCHAR(128);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS user_sub VARCHAR(128);

COMMENT ON COLUMN messages.user_sub IS
  'The person who sent this message, as the bare id after /user/ in sender_arn (a Cognito sub, '
  '<sub>-admin for the admin plane, fed_... for a federated sender). The same shape drift_events.user_sub '
  'holds. NULL on an assistant''s message, whose sender is agent_type.';
COMMENT ON COLUMN exchanges.user_sub IS
  'The person who asked: user_sub of the user message this exchange pairs. NULL when that message '
  'predates migration 074 and has not been backfilled yet.';

CREATE INDEX IF NOT EXISTS idx_messages_user_sub
    ON messages(user_sub) WHERE user_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exchanges_user_sub_created
    ON exchanges(user_sub, created_at DESC) WHERE user_sub IS NOT NULL;

DO $repair$
DECLARE
    batch_size CONSTANT integer := 5000;
    left_to_do bigint;
BEGIN
    UPDATE messages tgt
       SET user_sub = NULLIF(split_part(tgt.sender_arn, '/user/', 2), '')
     WHERE tgt.ctid IN (
           SELECT m.ctid
             FROM messages m
            WHERE m.is_bot = FALSE
              AND m.user_sub IS NULL
              AND m.sender_arn LIKE '%/user/%'
            LIMIT batch_size
     );

    UPDATE exchanges ex
       SET user_sub = um.user_sub
      FROM messages um
     WHERE ex.ctid IN (
           SELECT e.ctid
             FROM exchanges e
             JOIN messages u ON u.id = e.user_message_id
            WHERE e.user_sub IS NULL
              AND u.user_sub IS NOT NULL
            LIMIT batch_size
     )
       AND um.id = ex.user_message_id;

    SELECT (SELECT COUNT(*) FROM messages m
             WHERE m.is_bot = FALSE AND m.user_sub IS NULL AND m.sender_arn LIKE '%/user/%')
         + (SELECT COUNT(*) FROM exchanges e JOIN messages u ON u.id = e.user_message_id
             WHERE e.user_sub IS NULL AND u.user_sub IS NOT NULL)
      INTO left_to_do;

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('074-a-person-is-keyed-by-their-id.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END
$repair$;
