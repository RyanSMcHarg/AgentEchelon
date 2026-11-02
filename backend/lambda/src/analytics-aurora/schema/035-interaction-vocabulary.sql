-- 035: the deployed column comment names the vocabulary that is actually emitted.
--
-- WHY A MIGRATION FOR A COMMENT. `019` documented `trigger_kind` as `user | orchestrator | system`,
-- and that comment is a live database object: it is what an operator reads from `\d+ turn_events` or
-- from the information schema when they ask what the column holds. Migration 019 is already recorded
-- in `_migrations` and is never re-read, so editing its file updates what a developer sees in the
-- repo and leaves the DATABASE still describing a vocabulary no producer emits. The two would then
-- disagree, and the database would be the one an operator trusts.
--
-- WHAT CHANGED. The vocabulary was renamed from the two DISPATCHERS to the INTERACTIONS
-- (`interaction-kinds.ts`). `orchestrator` covered a battle rebuttal AND a post-processing repair -
-- two turns that answer "is a person waiting for this?" in opposite ways - so it could not survive as
-- one value. `system` was never emitted by anything at all.
--
--   user       a person sent a message and is waiting for the reply
--   rebuttal   battle round 2, answering the rival rather than a person
--   handover   a person's message, passed to the assistant that owns the work it answers
--   repair     a person's message that reached nobody, re-driven by post-processing
--
-- HISTORY IS NOT REWRITTEN. Rows already carrying `orchestrator` keep it: the value is ambiguous
-- between two interactions and cannot be resolved after the fact, so replacing it would be inventing
-- a fact rather than correcting one. `normaliseLegacyTrigger` maps it at READ time to the interaction
-- it was overwhelmingly used for, which keeps the ambiguity visible in one place instead of baking a
-- guess into the data.
--
-- VARCHAR(16) still fits: the longest current value is eight characters.
--
-- Idempotent: COMMENT ON is a replace, so re-running converges.

COMMENT ON COLUMN turn_events.trigger_kind IS
    'Which INTERACTION this turn is, as the producer declared it: user (a person is waiting), '
    'rebuttal (battle round 2, answering the rival), handover (a person''s message passed to the '
    'assistant owning the work), repair (a person''s message that reached nobody, re-driven by '
    'post-processing). NULL reads as a user turn, which is what every path did before a kind was '
    'forwarded. ttff_ms is undefined for a trigger no person is waiting on and is NULL, never 0; '
    'ack_ms is the metric that covers those. Rows predating this vocabulary carry the retired '
    'dispatcher name "orchestrator", which spanned rebuttal and repair and is resolved at read time '
    'rather than rewritten, because the two cannot be separated after the fact.';
