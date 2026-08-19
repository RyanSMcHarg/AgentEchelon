-- An exchange is a user turn paired with ONE agent reply — and a battle turn has TWO.
--
-- The backfill deduped on `user_message_id` alone (`LEFT JOIN exchanges e ON e.user_message_id =
-- um.id ... AND e.id IS NULL`) and paired only the FIRST bot message after the user turn. Both encode
-- a 1 user message : 1 agent reply assumption that `/battle` breaks: one `/battle` prompt is answered
-- by both variants. So exactly one side of every duel ever got an exchange row, and
-- `fetchBattleEffectivenessRows` — which joins through `exchanges` — could only ever see one variant.
-- That is the "Only one variant has recorded traffic" the recommendation reported: not missing
-- attribution (the messages carry it correctly), but a projection that could not represent a duel.
--
-- The dedup key becomes the PAIR. A normal turn is unaffected: it has one agent reply, so it still
-- produces exactly one row. A battle produces two, one per variant, which is what a comparison needs.
--
-- Safe to apply to existing data: today at most one exchange exists per user message, so the pair is
-- already unique and the index builds without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS exchanges_user_agent_message_uniq
  ON exchanges (user_message_id, agent_message_id);
