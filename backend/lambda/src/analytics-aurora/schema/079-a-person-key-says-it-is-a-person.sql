-- ============================================================================
-- 079: A PERSON KEY SAYS IT IS A PERSON.
--
-- A person is their AppInstanceUser, and the id the archive stores is that AppInstanceUser's id: the
-- bare id after `/user/` in a sender or member ARN. The credential exchange mints it once per
-- (issuer, subject), and it is never the token's `sub`. The column that holds it was named `user_sub`,
-- which told every reader it held a Cognito subject. It is `person_id` from here on, in every table
-- that carries it:
--
--   client_events, cross_conversation_context, channel_membership, drift_events,
--   conversation_creation_tasks, messages, exchanges.
--
-- The indexes and unique constraints over it are renamed with it, so a plan or an error names the
-- column it reads. `conversations.user_id` is dropped with its index: nothing writes it and nothing
-- reads it, and a person column on a conversation would say one person owns a room that several share.
-- `client_events` stores no address: the person is `person_id`, and `event_data` carries no email.
--
-- The column comments 074 wrote are restated for the new name.
--
-- The meetings roster is not on this line; its attendee key is renamed with it when it merges.
--
-- RENAMES, NOT REWRITES. A column rename is a catalog change: no row is touched, so there is no data
-- step to bound. Views follow a renamed column by reference, and no view reads `conversations.user_id`.
--
-- Idempotent and transaction-safe: every rename is guarded by information_schema / to_regclass /
-- pg_constraint so a re-run is a no-op, and nothing here uses CONCURRENTLY.
-- ============================================================================

-- One statement per table, written out rather than built with format(), so each rename is plain to read.
DO $rename$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'client_events' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'client_events' AND column_name = 'person_id')
    THEN
        ALTER TABLE client_events RENAME COLUMN user_sub TO person_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'cross_conversation_context' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'cross_conversation_context' AND column_name = 'person_id')
    THEN
        ALTER TABLE cross_conversation_context RENAME COLUMN user_sub TO person_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'channel_membership' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'channel_membership' AND column_name = 'person_id')
    THEN
        ALTER TABLE channel_membership RENAME COLUMN user_sub TO person_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'drift_events' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'drift_events' AND column_name = 'person_id')
    THEN
        ALTER TABLE drift_events RENAME COLUMN user_sub TO person_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'conversation_creation_tasks' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'conversation_creation_tasks' AND column_name = 'person_id')
    THEN
        ALTER TABLE conversation_creation_tasks RENAME COLUMN user_sub TO person_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'person_id')
    THEN
        ALTER TABLE messages RENAME COLUMN user_sub TO person_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'exchanges' AND column_name = 'user_sub')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'exchanges' AND column_name = 'person_id')
    THEN
        ALTER TABLE exchanges RENAME COLUMN user_sub TO person_id;
    END IF;
END
$rename$;

DO $indexes$
DECLARE
    pair text[];
BEGIN
    FOREACH pair SLICE 1 IN ARRAY ARRAY[
        ARRAY['idx_client_events_user',          'idx_client_events_person'],
        ARRAY['idx_cross_context_user',          'idx_cross_context_person'],
        ARRAY['idx_membership_user',             'idx_membership_person'],
        ARRAY['idx_drift_events_user',           'idx_drift_events_person'],
        ARRAY['idx_creation_tasks_user_channel', 'idx_creation_tasks_person_channel'],
        ARRAY['idx_messages_user_sub',           'idx_messages_person_id'],
        ARRAY['idx_exchanges_user_sub_created',  'idx_exchanges_person_id_created']
    ] LOOP
        IF to_regclass(pair[1]) IS NOT NULL AND to_regclass(pair[2]) IS NULL THEN
            EXECUTE format('ALTER INDEX %I RENAME TO %I', pair[1], pair[2]);
        END IF;
    END LOOP;
END
$indexes$;

DO $constraints$
DECLARE
    trip text[];
BEGIN
    FOREACH trip SLICE 1 IN ARRAY ARRAY[
        ARRAY['cross_conversation_context', 'cross_conversation_context_user_sub_channel_arn_key',
              'cross_conversation_context_person_id_channel_arn_key'],
        ARRAY['channel_membership', 'channel_membership_channel_arn_user_sub_key',
              'channel_membership_channel_arn_person_id_key']
    ] LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
                    WHERE r.relname = trip[1] AND c.conname = trip[2])
           AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
                    WHERE r.relname = trip[1] AND c.conname = trip[3])
        THEN
            EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', trip[1], trip[2], trip[3]);
        END IF;
    END LOOP;
END
$constraints$;

DROP INDEX IF EXISTS idx_conversations_user_id;
ALTER TABLE conversations DROP COLUMN IF EXISTS user_id;

COMMENT ON COLUMN messages.person_id IS
  'The person who sent this message: their AppInstanceUser id, the bare id after /user/ in sender_arn '
  '(<id>-admin for the admin plane, which user_role also says). '
  'Never a Cognito sub. The same shape drift_events.person_id holds. NULL on an assistant''s message, '
  'whose sender is agent_type.';
COMMENT ON COLUMN exchanges.person_id IS
  'The person who asked: person_id of the user message this exchange pairs. NULL when that message '
  'predates migration 074 and has not been backfilled yet.';
