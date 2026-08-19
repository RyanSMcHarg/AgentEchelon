-- 015-summary-drop-channel-state.sql
-- Remove the CHANNEL-STATE columns from `conversation_summaries` (ADR-020).
--
-- `conversation_summaries` is versioned and never rewritten, so a value describing the CONVERSATION
-- rather than the SUMMARY is frozen at one summarisation and wrong from the next change onward. Each
-- of these already has a continuously-maintained home, and no consumer ever read the copy here:
--
--   name              -> the Amazon Chime SDK channel is authoritative; `channel_registry.channel_name`
--                        mirrors it live from the Kinesis channel events.
--   participant_count -> `channel_membership`, maintained live from the Kinesis membership events.
--   message_count     -> counted at read time from `messages`. It stored the channel TOTAL. Every
--                        "messages" figure in the console counts live or reads
--                        `conversations.message_count` (a DIFFERENT table, untouched here).
--
-- What REMAINS on the row is the artifact and its provenance: `summary`, `purpose`, `topics`,
-- `key_points`, `version`, `generated_by`, `model_used`, `created_at`, `updated_at`. The incremental
-- watermark is `updated_at`, not a count.
--
-- Historical rows carry values that were already wrong (a frozen count, a NULL name); dropping the
-- columns discards them, which is the point - they cannot be repaired, only re-derived from the live
-- tables above.
--
-- Runtime-applied migrations run in ONE transaction, so this is idempotent and transaction-safe.
-- DROP COLUMN IF EXISTS is a catalog-only operation in PostgreSQL (no table rewrite).
ALTER TABLE conversation_summaries DROP COLUMN IF EXISTS name;
ALTER TABLE conversation_summaries DROP COLUMN IF EXISTS participant_count;
ALTER TABLE conversation_summaries DROP COLUMN IF EXISTS message_count;
