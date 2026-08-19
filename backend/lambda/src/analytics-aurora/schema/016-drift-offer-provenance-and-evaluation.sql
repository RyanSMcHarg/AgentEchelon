-- Migration 016: separate drift OFFERS from post-hoc drift SCORING, and record the
-- post-hoc evaluation verdict on an offer.
--
-- PROVENANCE (`source`). `recordDriftFire` is called from two places that mean different
-- things, and until now they wrote identical rows:
--
--   1. the LIVE path (lib/live-drift-flow.ts) - a suggestion was actually shown to the user,
--      who can accept or decline it. This is an OFFER.
--   2. the ARCHIVAL path (kinesis-archival.ts processDriftDetection) - historical scoring of
--      messages as they are archived, running by default in Aurora mode. NOTHING is shown to
--      anyone. This is analytics, not an offer.
--
-- Mixing them corrupts any question about user response: archival rows inflate the "offered"
-- denominator, can never be accepted (nobody was asked), and stay outcome IS NULL forever
-- (the abandonment detector only settles rows with a new_channel_arn, which archival rows
-- never have). A message that fired live drift is also re-scored when it is archived, so the
-- same event produced TWO rows.
--
-- Rows written before this migration are genuinely ambiguous - nothing distinguished them at
-- write time - so `source` is left NULL for them rather than guessed. The health surface counts
-- `source = 'live'` only, which means it reports on offers made from this migration onward.
-- Guessing a backfill would be inventing data about which users were shown a suggestion.
--
-- EVALUATION (`evaluated_*`). Whether a drift call was CORRECT is a judgement about the call,
-- not about the user's reaction: a user can decline a correct suggestion and accept a bad one.
-- So accuracy comes from a post-hoc LLM judge (the evaluation runner), which reads the
-- originating message by reference from `messages` plus the conversation summary, and records
-- its verdict here. NULL `evaluated_at` means "not yet judged", which the console renders as
-- not-measured rather than as a score.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). All columns nullable; no backfill.

ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS source                VARCHAR(16);
ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS evaluated_correct     BOOLEAN;
ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS evaluated_at          TIMESTAMPTZ;
ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS evaluator_model       VARCHAR(128);
ALTER TABLE drift_events ADD COLUMN IF NOT EXISTS evaluation_reasoning  TEXT;

-- The evaluation runner claims work with (source='live' AND evaluated_at IS NULL); the health
-- query filters on source. Partial index keeps both cheap without indexing archival rows.
CREATE INDEX IF NOT EXISTS idx_drift_events_unevaluated_offers
    ON drift_events (occurred_at)
    WHERE source = 'live' AND evaluated_at IS NULL;

COMMENT ON COLUMN drift_events.source IS
    'live: a suggestion was shown to the user (an OFFER; can be accepted/declined). '
    'archival: post-hoc scoring from the kinesis archival pass, never shown to anyone. '
    'NULL: written before migration 016, provenance unknown - excluded from the health surface '
    'rather than guessed.';
COMMENT ON COLUMN drift_events.evaluated_correct IS
    'Post-hoc LLM judgement of whether offering to split was the RIGHT call, independent of '
    'whether the user accepted. NULL until judged.';
COMMENT ON COLUMN drift_events.evaluated_at IS
    'When the post-hoc evaluation ran. NULL means not yet judged, which the console renders as '
    '"Not measured" rather than as a score.';
