-- A DUEL BECOMES SOMETHING YOU CAN JOIN ON, so a battle can be reviewed as a battle.
--
-- `/battle` has been measurable per VARIANT since it shipped and never per DUEL. The battle identity
-- lived in one place only - `messages.metadata->'analytics'->'battleContext'->>'battleId'` - which is
-- unindexable, invisible to a GROUP BY that any reader would think to write, and reachable only by a
-- query that already knows the JSON path. So "how did this battle go" had no answer: the rollup could
-- say control averaged 4.2 and treatment 4.4 across the window, and could not say which turns were
-- the same duel, how many rounds it ran, or what the two sides said to each other.
--
-- `battle_round` had the mirror problem from the other side. It is a real column, but only on
-- `turn_events` (migration 019), which records the latency timeline and not the exchange. So the round
-- was joinable to a span and not to an answer, and the two facts a duel is made of - WHICH duel and
-- WHICH round - lived in two stores that do not join.
--
-- NAMING WHAT THIS DOES NOT FIX. "Battle" still has two definitions in the console: the Experiments
-- surface asks `assignmentMode = 'battle'` (round-agnostic, in JSON), and the Latency surface asks the
-- interaction kind (names only round 2, in a column). This migration does not reconcile them. It gives
-- the third fact - the duel - a column, so a future reconciliation has something to key on; it does
-- not pick a winner between the other two, which is a product decision and not a schema one.
--
-- BACKFILL IS FROM THE JSONB ALREADY RECORDED, so every duel already archived becomes reviewable
-- rather than only duels fought after this ships. Both the nested path and the legacy flat path are
-- read, the same two `resolveBattleChannels` has always coalesced. A turn that carried neither stays
-- NULL, which is the honest record of an ordinary turn rather than a duel with a missing id.

ALTER TABLE messages  ADD COLUMN IF NOT EXISTS battle_id    VARCHAR(64);
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS battle_round SMALLINT;

ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS battle_id    VARCHAR(64);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS battle_round SMALLINT;

COMMENT ON COLUMN exchanges.battle_id IS
  'Which duel this turn belongs to. sha256(channelArn:userMessageId), so it is stable for every turn '
  'of one battle and one-way - it identifies a duel without naming the conversation. NULL on an '
  'ordinary turn, which is how a battle turn is told from one.';
COMMENT ON COLUMN exchanges.battle_round IS
  'Which round of that duel (1 = the parallel answers, 2 = the rebuttal). NULL on an ordinary turn. '
  'Round 2 has no production analogue and no user message to measure from, so a reader pooling rounds '
  'is pooling two different populations - see DESIGN-BATTLE 5b.';

-- ── BACKFILL FROM WHAT WAS ALREADY RECORDED ─────────────────────────────────────────────────────
-- The nested path first, then the legacy flat one, exactly as resolveBattleChannels has always read
-- them. Regex-guarded cast on the round: a malformed value must leave the column NULL rather than
-- error the migration, which on this codebase runs at RUNTIME on a cold start.
UPDATE messages m
   SET battle_id = COALESCE(
         m.battle_id,
         m.metadata->'analytics'->'battleContext'->>'battleId',
         m.metadata->'battleContext'->>'battleId'),
       battle_round = COALESCE(
         m.battle_round,
         CASE WHEN COALESCE(m.metadata->'analytics'->'battleContext'->>'round',
                            m.metadata->'battleContext'->>'round') ~ '^[0-9]+$'
              THEN COALESCE(m.metadata->'analytics'->'battleContext'->>'round',
                            m.metadata->'battleContext'->>'round')::smallint END)
 WHERE (m.metadata->'analytics'->'battleContext'->>'battleId' IS NOT NULL
        OR m.metadata->'battleContext'->>'battleId' IS NOT NULL)
   AND (m.battle_id IS NULL OR m.battle_round IS NULL);

-- ── THE CREATE ROW TAKES THE ANSWER'S FACTS FROM ITS `-UPD` SIBLING ─────────────────────────────
--
-- THIS STEP IS WHY THE BACKFILL ABOVE IS NOT ENOUGH, and leaving it out would have made the whole
-- migration a no-op on existing data. A bot turn is archived as TWO rows: the placeholder CREATE,
-- which carries no analytics at all, and `<createId>-UPD`, which carries the answer. `battleContext`
-- therefore only ever lands on the `-UPD` row - so the UPDATE above filled in the sibling and left
-- the CREATE row, which is the row that matters, still NULL.
--
-- And it is the row that matters because `exchanges.agent_message_id` points at the CREATE, never at
-- the `-UPD`. An exchange backfill reading the CREATE row would therefore have copied NULL onto
-- every exchange and reported success.
--
-- Same `-UPD` sibling idiom the redaction and deletion reads use. Role, version and config id ride
-- along for the identical reason: migration 056 backfilled them from each row's own metadata, which
-- means it reached the `-UPD` rows and not the CREATEs.
UPDATE messages c
   SET battle_id         = COALESCE(c.battle_id, u.battle_id),
       battle_round      = COALESCE(c.battle_round, u.battle_round),
       assistant_role    = COALESCE(c.assistant_role, u.assistant_role),
       profile_version   = COALESCE(c.profile_version, u.profile_version),
       profile_config_id = COALESCE(c.profile_config_id, u.profile_config_id)
  FROM messages u
 WHERE u.message_id = c.message_id || '-UPD'
   AND u.channel_arn = c.channel_arn
   AND (u.battle_id IS NOT NULL OR u.assistant_role IS NOT NULL
        OR u.profile_version IS NOT NULL OR u.profile_config_id IS NOT NULL)
   AND (c.battle_id IS NULL OR c.assistant_role IS NULL
        OR c.profile_version IS NULL OR c.profile_config_id IS NULL);

-- Exchanges take theirs from the message that answered, which is where a duel's facts are recorded.
--
-- ROLE, VERSION AND CONFIG ID ARE REPAIRED IN THE SAME PASS, and that is not scope creep. Migration
-- 056 added them and backfilled them once; the CROSS-BATCH SWEEP that mints an exchange never carried
-- them, so every exchange swept since 056 ran has them NULL again. That hits duels hardest of all:
-- two model calls per round puts a duel past the batching window routinely, so a duel's exchanges are
-- usually swept rather than paired in batch. Filtering battle turns by role or version would have
-- returned nothing, on columns that look populated everywhere else. The writer is fixed too; this
-- repairs what it already lost.
UPDATE exchanges ex
   SET battle_id         = COALESCE(ex.battle_id, m.battle_id),
       battle_round      = COALESCE(ex.battle_round, m.battle_round),
       assistant_role    = COALESCE(ex.assistant_role, m.assistant_role),
       profile_version   = COALESCE(ex.profile_version, m.profile_version),
       profile_config_id = COALESCE(ex.profile_config_id, m.profile_config_id)
  FROM messages m
 WHERE m.id = ex.agent_message_id
   AND (m.battle_id IS NOT NULL OR m.assistant_role IS NOT NULL
        OR m.profile_version IS NOT NULL OR m.profile_config_id IS NOT NULL)
   AND (ex.battle_id IS NULL OR ex.battle_round IS NULL OR ex.assistant_role IS NULL
        OR ex.profile_version IS NULL OR ex.profile_config_id IS NULL);

-- One duel's turns are read together, and a review window is a time range, so the index is
-- (duel, time) like every other dimension index here. The partial index keeps it to battle turns:
-- battle_id is NULL on the overwhelming majority of rows and there is no reason to carry them.
CREATE INDEX IF NOT EXISTS idx_exchanges_battle_id_created
    ON exchanges(battle_id, created_at DESC) WHERE battle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_battle_id
    ON messages(battle_id) WHERE battle_id IS NOT NULL;
