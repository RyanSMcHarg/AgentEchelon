-- A REFERENCE, NOT A COPY.
--
-- `cross_conversation_context` stored the latest user message verbatim: its first 100 characters as
-- `topic` and its first 500 as `summary`, upserted per conversation on every archival pass. That is a
-- second copy of what somebody said, outside the three places a message is allowed to live - the
-- message itself, the Aurora archive, and S3.
--
-- THE COPY IS WHAT MADE EVERY OTHER PROTECTION NECESSARY. The redaction mechanism resolves a `-RED`
-- or `-DEL` sibling row at READ time, which works for a derived VIEW of a message and cannot reach a
-- copy of one: a redacted message's text simply stayed here, and nothing anywhere deleted it. Rather
-- than build a third redaction path to chase the copy, this removes the copy. A row now says THAT a
-- person has a conversation and WHICH message it was last touched by, and the text is read from the
-- one place it lives.
--
-- The principle this follows: a person's exact words live only in the original message, the Aurora
-- archive and S3. Everywhere else a message is referenced by its id, so redaction stays complete by
-- construction.

-- ── 1. THE CLASSIFICATION THIS ROW BELONGS TO ───────────────────────────────────────────────────
--
-- The table joins this migration to `BOUNDED_TABLES`, so it gains per-classification reader grants,
-- FORCE ROW LEVEL SECURITY and the scope policy that the three embedding tables already have under
-- ADR-028. The boundary bootstrap iterates that list and needs this column to exist, which is why it
-- is added here and not left to the writer.
--
-- EXISTING ROWS ARE NOT GUESSED AT. They are left NULL, and the bootstrap's own stamping step sets a
-- NULL classification to `failClosedContentValue` in bounded batches - the most restrictive readable
-- value. A row whose classification nobody can establish is readable by the fewest people rather than
-- by a guess, which is the same rule `summary_embeddings` follows.
ALTER TABLE cross_conversation_context
    ADD COLUMN IF NOT EXISTS classification VARCHAR(64);

-- ── 2. THE REFERENCE THAT REPLACES THE COPY ─────────────────────────────────────────────────────
--
-- The message id, not the message. It is what a caller follows to read the text from the message
-- itself when it genuinely needs it, and following it goes through that message's own access control
-- rather than around it - which is the property the copy destroyed.
ALTER TABLE cross_conversation_context
    ADD COLUMN IF NOT EXISTS last_message_id VARCHAR(256);

-- ── 3. THE COPY GOES ────────────────────────────────────────────────────────────────────────────
--
-- DROPPED, NOT BLANKED, and that is the point of doing it as DDL. Setting the columns to NULL leaves
-- a place for the next writer to put message text back, and leaves the old values recoverable until
-- the rows are vacuumed. A column that does not exist cannot be repopulated by a future call site
-- that means well, so the invariant is enforced by the schema instead of by everyone remembering it.
--
-- The read that used these is re-pointed at `conversation_summaries`, which holds the model's own
-- summary and topic labels for the same channel - one source per question, tenet D7, rather than a
-- stale duplicate of it here.
ALTER TABLE cross_conversation_context DROP COLUMN IF EXISTS topic;
ALTER TABLE cross_conversation_context DROP COLUMN IF EXISTS summary;

-- The scope policy filters on `classification` on every read of this table, so it is indexed like the
-- other bounded tables rather than left to a sequential scan per user.
CREATE INDEX IF NOT EXISTS idx_cross_context_classification
    ON cross_conversation_context (classification);
