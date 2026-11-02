-- THE CALLER'S CLEARANCE, AS IT WAS WHEN THE TURN RAN.
--
-- `messages` records the classification the turn was SERVED at (`agent_type`, the assistant) and the
-- EFFECTIVE classification the router resolved (`user_type`, the min-cap of the channel and the
-- caller). It has never recorded the third value in that calculation: what the person was actually
-- cleared for.
--
-- ── WHY IT CANNOT BE LOOKED UP LATER, WHICH IS THE WHOLE POINT ────────────────────────────────────
--
-- A person's clearance MOVES. A classification change rewrites their Cognito groups and re-stamps the
-- `classification` tag on their AppInstanceUser. Both of those answer "what is this person cleared
-- for NOW". Neither can answer "what were they cleared for when this turn ran", and an analytics row
-- is a historical fact.
--
-- So this is stamped by the producer and never derived by a reader. The router already resolves the
-- clearance to compute the min-cap; it now declares it on the turn, the turn carries it in its
-- analytics metadata, and archival writes it here. Nothing downstream re-resolves it.
--
-- This is the distinction that decides whether a fact belongs in a column at all. The channel's
-- classification is deliberately NOT copied onto every message: it lives in `channel_classification`,
-- it is immutable, and a join cannot go stale. A person's clearance is the opposite on both counts -
-- mutable, and with no other record of its value at a past instant - so the archive is the only place
-- that can hold it, which is exactly what the archive is for.
--
-- ── WHAT IT MAKES ANSWERABLE ──────────────────────────────────────────────────────────────────────
--
-- The min-cap binds when a person's clearance is below the room they are in. Until now that was
-- invisible: `user_type` already had the cap applied, so a capped turn and an uncapped one looked
-- identical. With both values recorded, `user_clearance <> user_type` is exactly the set of turns
-- where the cap bound - which SPEC-CONVERSATION-SECURITY treats as an admission that went wrong
-- rather than as the design working.
--
-- NULL means the producer declared nothing: a turn from before this column existed, or a message
-- that was never a turn. It is never a clearance, and no reader may default it to one.
--
-- Idempotent and additive. No backfill: the rows that lack it are the rows whose clearance at the
-- time was never recorded, and inventing one now would be the guess this column exists to avoid.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_clearance VARCHAR(32);

-- The question this column is for is "which turns ran under a bound cap", so the index covers the
-- rows that can answer it. Partial: most rows have no value, and on the rest the two agree.
CREATE INDEX IF NOT EXISTS idx_messages_user_clearance
    ON messages(user_clearance)
    WHERE user_clearance IS NOT NULL;

COMMENT ON COLUMN messages.user_clearance IS
    'The caller''s classification clearance at the moment the turn ran, declared by the router and '
    'never re-derived. Distinct from user_type, which is the EFFECTIVE classification after the '
    'min-cap of the channel and this clearance, and from agent_type, which is the classification '
    'assigned to the assistant that answered. Point-in-time on purpose: a classification change moves a '
    'person''s groups and their identity tag, so neither can answer what they held at a past instant. '
    'user_clearance <> user_type is the set of turns where the min-cap bound. NULL means the producer '
    'declared none - an older row, or a message that was never a turn - and is never a clearance.';
