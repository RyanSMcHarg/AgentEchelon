-- THE CONVERSATION'S CLASSIFICATION, RECORDED UNDER ITS OWN NAME. `user_type` IS DEPRECATED.
--
-- A turn runs at exactly one classification: the conversation's, read from the channel's immutable
-- `classification` tag. A person's credential cannot reach a channel above their clearance, so there
-- is no per-person value a turn could run at instead. The turn declares that value as
-- `classification` in its analytics metadata, and archival writes it here.
--
-- ── WHY A NEW COLUMN AND NOT `user_type` ──────────────────────────────────────────────────────────
--
-- `user_type` is named for the person and does not describe one. On `exchanges` it holds a mix: the
-- conversation's classification on rows paired in-batch, the sender's clearance on rows paired late,
-- and the literal 'unknown' on most of the rest. A reader cannot tell which a row holds, so the column
-- is left in place and no longer written. The two person-shaped facts already have honest homes:
-- `user_clearance` (migration 046) and `user_role` (migration 049).
--
-- ── WHY NOT A JOIN TO `channel_classification` ────────────────────────────────────────────────────
--
-- That table is the in-VPC isolation projection for the vector tables (migration 022), written only by
-- a live drift check or a bulk backfill, so most channels have no row. It is also an access input, and
-- a value an analytics pipeline derives from message metadata must not be able to write one. So the
-- analytics fact is recorded with the analytics row.
--
-- ── WHAT CHANGES FOR `user_type` ──────────────────────────────────────────────────────────────────
--
-- Nothing is dropped and no row is rewritten. `exchanges.user_type` loses its NOT NULL and its
-- 'unknown' default, so a row minted from now on reads NULL there - not written - instead of a
-- default that looks like a value. Existing rows keep whatever they hold.
--
-- NULL in `conversation_classification` means the turn declared none: a row from before this column,
-- or a message that was never a turn. It is never a classification, and no reader may default it to one.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and ALTER
-- COLUMN / COMMENT statements that are no-ops on a second run. No backfill: `user_type` cannot say
-- which of its three meanings a row holds, so copying it would record a guess as a fact.

ALTER TABLE messages      ADD COLUMN IF NOT EXISTS conversation_classification VARCHAR(32);
ALTER TABLE exchanges     ADD COLUMN IF NOT EXISTS conversation_classification VARCHAR(32);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_classification VARCHAR(32);

-- Readers slice exchanges by classification over a date window, and conversations by classification.
CREATE INDEX IF NOT EXISTS idx_exchanges_conversation_classification_created
    ON exchanges(conversation_classification, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_conversation_classification
    ON conversations(conversation_classification);

ALTER TABLE exchanges ALTER COLUMN user_type DROP NOT NULL;
ALTER TABLE exchanges ALTER COLUMN user_type DROP DEFAULT;

COMMENT ON COLUMN messages.conversation_classification IS
    'The classification of the conversation this turn ran in, from the channel''s immutable tag, as '
    'the turn declared it. A fact about the room: distinct from user_clearance (what the sender was '
    'cleared for) and agent_type (the classification assigned to the answering assistant). NULL means '
    'the message declared none and is never a classification.';

COMMENT ON COLUMN exchanges.conversation_classification IS
    'The classification of the conversation the exchange happened in, carried from the answering '
    'turn''s messages.conversation_classification. NULL means no turn declared one.';

COMMENT ON COLUMN conversations.conversation_classification IS
    'The conversation''s classification, from the first archived turn that declared one. NULL means '
    'no archived turn has declared one yet.';

COMMENT ON COLUMN messages.user_type IS
    'DEPRECATED, no longer written. Read conversation_classification for the conversation''s '
    'classification, user_clearance for the sender''s clearance, user_role for the kind of sender.';

COMMENT ON COLUMN exchanges.user_type IS
    'DEPRECATED, no longer written; NULL on rows minted after migration 050. Older rows mix the '
    'conversation''s classification, the sender''s clearance and ''unknown'' with nothing to tell them '
    'apart. Read conversation_classification, user_clearance or user_role instead.';

COMMENT ON COLUMN conversations.user_type IS
    'DEPRECATED, no longer written. Read conversation_classification.';

COMMENT ON COLUMN intent_flows.user_type IS
    'DEPRECATED, no longer written. The conversation''s classification is on the flow''s exchanges '
    '(exchanges.conversation_classification).';
