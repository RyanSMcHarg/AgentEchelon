-- A PERSON CAN RAISE A FLAG, NOT ONLY ANSWER ONE.
--
-- Until now the Flagged list had exactly one author: the judge. `getFlaggedResponses` derives it from
-- `evaluation_results` (relevance below 50, non-compliant, or judge flags attached), and the only
-- human writer is `flagged_review` (migration 014), which records a verdict of `approved` or
-- `rejected` against an exchange the judge ALREADY raised. Nothing anywhere inserts a new one.
--
-- So a moderator reading a conversation and seeing a bad answer had nowhere to put that judgement.
-- Oversight is the moderator surface, and it was read-only about quality: the only human signal in
-- the system was the one an end user volunteered, over a population of responses an end user is
-- least likely to vote on. A moderator reviews the conversations somebody escalated; those are
-- precisely the exchanges where nobody is clicking a thumb.
--
-- This table is the missing origin. It is deliberately NOT a second `flagged_review`: that table
-- answers "what did a human decide about a flag", and this one answers "a human raised one". Keeping
-- them apart preserves the property migration 014 was written for - `evaluation_results` stays a
-- pure record of what the judge decided, and re-evaluating an exchange never discards human input.
--
-- KEYED ON (channel_arn, message_id), NOT ON exchange_id, and that is forced rather than preferred.
-- The moderator is looking at a message in a transcript. No exchange id reaches that client: the
-- admin conversations read (`admin-conversations-aurora.ts`) joins `exchanges` only to pull `intent`
-- and never projects `ex.id`. More importantly the exchange row may not exist yet - archival is
-- asynchronous, so a flag raised on a fresh message would resolve to NULL and silently never appear
-- in the list it was raised for. The join to `exchanges` therefore happens at READ time, where a
-- late-arriving exchange row simply starts matching.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe (no CREATE INDEX CONCURRENTLY).
CREATE TABLE IF NOT EXISTS human_flag (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel_arn     VARCHAR(512) NOT NULL,
    message_id      VARCHAR(128) NOT NULL,   -- the Chime MessageId of the response being flagged
    -- The same closed set the chat client offers an end user, so a moderator's reason and a person's
    -- reason are the same vocabulary and can be counted together:
    --   'wrong_assistant' | 'poor_answer' | 'asked_again'
    -- Closed rather than free text because the whole value of the field is that it groups onto the
    -- axis it indicts. Free prose belongs in `note`.
    reason          VARCHAR(32)  NOT NULL,
    note            TEXT,                    -- optional prose from the moderator
    -- The sub and ONLY the sub. A display name is not attribution: ADR-040 settles that names are
    -- display and every admin aggregation keys on the sub, and a name column here would be a second
    -- copy that goes stale the first time somebody is renamed. The console resolves subs to names at
    -- read time the way it already does elsewhere.
    flagged_by_sub  VARCHAR(128) NOT NULL,   -- server-verified admin sub (from the JWT), never client-supplied
    flagged_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- One CURRENT flag per response. Re-flagging replaces the reason rather than accumulating rows: the
-- list shows one state per message, and a moderator correcting a mis-click should not leave the old
-- reason behind. This mirrors the ON CONFLICT DO UPDATE that `flagged_review` uses for the same
-- reason, and is why the write path needs a unique constraint rather than just an index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_flag_message ON human_flag(channel_arn, message_id);

-- The list reads a time window ordered newest-first.
CREATE INDEX IF NOT EXISTS idx_human_flag_at ON human_flag(flagged_at DESC);

COMMENT ON TABLE human_flag IS
  'A response a person raised as bad, as opposed to one the judge scored badly. Written by a moderator from Oversight > Conversations. Joined to exchanges at read time on agent_message_id, because the exchange row may archive after the flag is raised.';
COMMENT ON COLUMN human_flag.reason IS
  'Closed set shared with the chat client: wrong_assistant (the routing was wrong), poor_answer (the routing was right and the answer was bad), asked_again (the person had to re-ask). Unrecognized values are rejected at the write path, not stored.';
COMMENT ON COLUMN human_flag.flagged_by_sub IS
  'Taken from the verified JWT on the request, never from the request body. Attribution has to survive a dispute about who raised a flag, so it is the sub rather than a display name (ADR-040).';
