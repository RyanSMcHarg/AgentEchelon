-- REPAIR: `agent_type` NAMES THE SEAT THAT ANSWERED, NOT THE DEFINITION IT SERVED.
--
-- Migration 055 moved `agent_type` from the classification to the assistant, which was right. Its
-- backfill took the value from `metadata->>'profileName'`, which was not: that key names the
-- DEFINITION a turn served, while `agent_type` groups by the SEAT that answered. The processor stamps
-- both and says in terms why they are different questions:
--
--   "DELIBERATELY NOT THE SAME QUESTION AS `servingAssistant` ABOVE. That one names the SEAT that
--    answered, which is what `agent_type` groups by; this one names the DEFINITION it served. They
--    are the same string on every ordinary turn and come apart exactly on a cross-assistant variant."
--
-- So on an ordinary turn 055's backfill was a no-op, and on a cross-assistant variant - a duel side
-- serving a rival's definition - it replaced a correct seat with the wrong assistant's name. 055 is
-- re-runnable by design, so it did that again on every cold start.
--
-- 055 now prefers `metadata->>'agentType'` and falls back to `profileName` only where the seat was
-- never recorded. This repairs what the old predicate already wrote.
--
-- ── WHY THIS IS SAFE TO DECIDE FROM THE ROW ALONE ───────────────────────────────────────────────
--
-- The seat is on the row. A message whose `agent_type` disagrees with its own `metadata->>'agentType'`
-- is a row where something other than the live write set the column, and the live write is the only
-- producer that knows which seat answered. There is no guessing here and no deployment-specific list:
-- the correct value travelled with the message and is still there.
--
-- Rows with no `agentType` in their metadata are LEFT ALONE. They predate the seat being recorded, so
-- `profileName` is the best available answer and 055 already applied it. Overwriting them here would
-- replace a considered fallback with a NULL.
--
-- IDEMPOTENT AND TRANSACTION-SAFE: the predicate excludes rows that already agree, so a second run
-- updates nothing, and every statement is a single guarded UPDATE.

UPDATE messages m
   SET agent_type = m.metadata->>'agentType'
 WHERE m.metadata->>'agentType' IS NOT NULL
   AND (m.agent_type IS NULL OR m.agent_type <> m.metadata->>'agentType');

-- The exchange inherits the assistant from the bot message it was minted against, by the same rule
-- and for the same reason.
--
-- ── IT JOINS THE MESSAGE, NOT A TIME WINDOW (code review, 2026-09-22) ─────────────────────────────
--
-- The first version of this statement matched bot messages by `channel_arn` inside a -1min/+10min
-- window and took `MAX(metadata->>'agentType')` - the lexicographically greatest assistant name among
-- everything that answered nearby. On a duel channel two assistants answer inside that window, so it
-- assigned whichever name sorted last: at the exchange level, exactly the arbitrary attribution this
-- file exists to repair. Worse, because the guard is `ex.agent_type <> src.assistant` and migrations
-- re-run on every cold start, it would re-break correct duel rows indefinitely.
--
-- `exchanges.agent_message_id` has named the answering message since 001. There was never a window to
-- guess with: the join is exact, one row per exchange, and no aggregate is needed. An exchange whose
-- `agent_message_id` is NULL is left alone, because nothing in the row says which assistant answered
-- and a guess is what this is correcting.
UPDATE exchanges ex
   SET agent_type = m.metadata->>'agentType'
  FROM messages m
 WHERE m.id = ex.agent_message_id
   AND m.is_bot = TRUE
   AND m.metadata->>'agentType' IS NOT NULL
   AND (ex.agent_type IS NULL OR ex.agent_type <> m.metadata->>'agentType');

COMMENT ON COLUMN messages.agent_type IS
    'The assistant SEAT that answered this turn, as the answering processor declared it '
    '(servingAssistant -> metadata.agentType). NOT the profile definition it served, which is '
    'metadata.profileName and differs on a cross-assistant variant; and NOT the room''s '
    'classification, which is conversation_classification (migration 050).';
