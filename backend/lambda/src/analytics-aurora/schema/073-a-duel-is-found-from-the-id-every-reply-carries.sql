-- ============================================================================
-- 073: A DUEL IS FOUND FROM THE ID EVERY BATTLE REPLY CARRIES.
--
-- A battle reply carries its duel in up to three places: `metadata.analytics.battleContext` (the
-- out-of-band analytics record), `metadata.battleContext` (older rows), and the scalar
-- `metadata.battleId` / `metadata.battleRound` on the slimmed channel-message Metadata
-- (`FRONTEND_METADATA_KEYS`). Migration 057 and the archival writer read only the first two, so a reply
-- whose out-of-band record never reached archival was stored with battle_id NULL although the message
-- itself named its duel. The writer now reads all three (`battleIdOf` in kinesis-archival.ts); this
-- repairs the rows already stored.
--
-- THREE STEPS, in 057's order and for 057's reasons:
--   1. a bot row takes the scalar id and round from its own Metadata;
--   2. a CREATE row takes them from its `-UPD` sibling, since the answer's facts land on the sibling
--      and exchanges point at the CREATE;
--   3. an exchange takes them from the message that answered.
--
-- BOUNDED AND RESUMABLE. Step 1 scans messages for the scalar, so it runs one batch per application and
-- reports what is left in _migration_progress (029, 066, 071); the file stays pending until nothing is.
-- Steps 2 and 3 start from rows that already carry a battle_id, through the partial indexes 057 built,
-- so they touch duel rows only. A person's message is never read: a duel id on a person's message would
-- let anyone who can type file their turn into someone else's duel.
--
-- Idempotent and transaction-safe: every UPDATE fills only a NULL, so a second run changes no row.
-- ============================================================================

DO $repair$
DECLARE
    batch_size CONSTANT integer := 5000;
    left_to_do bigint;
BEGIN
    UPDATE messages tgt
       SET battle_id    = COALESCE(tgt.battle_id, NULLIF(TRIM(tgt.metadata->>'battleId'), '')),
           battle_round = COALESCE(
               tgt.battle_round,
               CASE WHEN tgt.metadata->>'battleRound' ~ '^[0-9]+$'
                    THEN (tgt.metadata->>'battleRound')::smallint END)
     WHERE tgt.ctid IN (
           SELECT m.ctid
             FROM messages m
            WHERE m.is_bot = TRUE
              AND m.battle_id IS NULL
              AND NULLIF(TRIM(m.metadata->>'battleId'), '') IS NOT NULL
            LIMIT batch_size
     );

    SELECT COUNT(*) INTO left_to_do
      FROM messages m
     WHERE m.is_bot = TRUE
       AND m.battle_id IS NULL
       AND NULLIF(TRIM(m.metadata->>'battleId'), '') IS NOT NULL;

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('073-a-duel-is-found-from-the-id-every-reply-carries.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END
$repair$;

-- The CREATE row takes the duel from its `-UPD` sibling (057, step 2).
UPDATE messages c
   SET battle_id    = COALESCE(c.battle_id, u.battle_id),
       battle_round = COALESCE(c.battle_round, u.battle_round)
  FROM messages u
 WHERE u.battle_id IS NOT NULL
   AND u.message_id = c.message_id || '-UPD'
   AND u.channel_arn = c.channel_arn
   AND (c.battle_id IS NULL OR c.battle_round IS NULL);

-- The exchange takes it from the message that answered (057, step 3).
UPDATE exchanges ex
   SET battle_id    = COALESCE(ex.battle_id, m.battle_id),
       battle_round = COALESCE(ex.battle_round, m.battle_round)
  FROM messages m
 WHERE m.battle_id IS NOT NULL
   AND m.id = ex.agent_message_id
   AND (ex.battle_id IS NULL OR ex.battle_round IS NULL);
