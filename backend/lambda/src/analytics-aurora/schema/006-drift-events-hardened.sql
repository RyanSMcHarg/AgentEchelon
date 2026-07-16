-- Migration 006: drift_events table (hardened, by-reference)
--
-- Replaces the legacy `drift_detection` table from 001-initial.sql with the
-- hardened by-reference design from SPEC-DRIFT-CONVERGENCE.md.
--
-- Key changes from drift_detection:
-- - Renamed to drift_events
-- - No user message body columns (no original_topic / current_topic). The
--   originating message is referenced by id; the body is read on-demand from
--   the conversation archive when a human inspects the event.
-- - Adds outcome enum (declined / rejected_in_new_channel / abandoned /
--   accepted) tracked by the live-suggestion flow + abandonment detector
-- - Adds cosine_distance as the signal value at fire time
-- - Adds correlation_id (UUIDv7) stitching EMF metrics + log lines
-- - Adds signal_disagreement (reserved for the LLM +DRIFT sanity-check sidecar)
-- - Adds created_via_explicit_intent — true when detectExplicitRoutingRequest
--   fast-path matched, false when cosine similarity fired drift
-- - Adds rival_conversation_arn — the existing channel a redirect suggestion
--   pointed to (null for offer-create suggestions)
--
-- The legacy table is dropped after a no-op grace window because the
-- analytics rollups that previously read drift_detection will be pointed at
-- drift_events by application code in the same release. If you need to
-- preserve historical data, snapshot drift_detection before applying this
-- migration; this is a fresh-design table, not a column refactor.

-- CASCADE: 003-materialized-views.sql builds a materialized view FROM
-- drift_detection; that obsolete rollup must come down with the table (drift
-- analytics read drift_events directly after this migration).
DROP TABLE IF EXISTS drift_detection CASCADE;

CREATE TABLE IF NOT EXISTS drift_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome VARCHAR(32) CHECK (outcome IN ('declined', 'rejected_in_new_channel', 'abandoned', 'accepted')),
    cosine_distance NUMERIC(6, 4),
    parent_channel_arn VARCHAR(256) NOT NULL,
    new_channel_arn VARCHAR(256),
    rival_conversation_arn VARCHAR(256),
    user_sub VARCHAR(128),
    originating_message_id VARCHAR(256),
    intent VARCHAR(64),
    confidence VARCHAR(16) CHECK (confidence IN ('low', 'medium', 'high')),
    correlation_id UUID,
    signal_disagreement BOOLEAN NOT NULL DEFAULT FALSE,
    created_via_explicit_intent BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_drift_events_occurred ON drift_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_events_outcome ON drift_events (outcome, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_events_parent ON drift_events (parent_channel_arn);
CREATE INDEX IF NOT EXISTS idx_drift_events_user ON drift_events (user_sub);

-- Partial index to make the abandonment-detector's query cheap:
--   SELECT ... WHERE outcome IS NULL AND new_channel_arn IS NOT NULL
--             AND occurred_at < NOW() - INTERVAL '5 minutes'
CREATE INDEX IF NOT EXISTS idx_drift_events_pending_abandon
    ON drift_events (occurred_at)
    WHERE outcome IS NULL AND new_channel_arn IS NOT NULL;

COMMENT ON TABLE drift_events IS
    'Live drift detection event log. Replaces drift_detection. By-reference: '
    'never stores user message body. Per SPEC-DRIFT-CONVERGENCE.md, the '
    'originating message is read on-demand from the conversation archive '
    'when a human inspects the event. PII erasure: when a user requests '
    'deletion, the archive scrubber nulls originating_message_id on matching '
    'parent_channel_arn rows.';

COMMENT ON COLUMN drift_events.outcome IS
    'declined: user said no to the suggestion. '
    'rejected_in_new_channel: user accepted, then declined again in the new channel. '
    'abandoned: user accepted but never sent a follow-up (written by scheduled abandonment-detector). '
    'accepted: user accepted and engaged (≥2 messages in new channel). '
    'NULL: pending outcome; the row was just created.';

COMMENT ON COLUMN drift_events.cosine_distance IS
    'cosine_distance(message_embedding, summary_embedding) at fire time. '
    'NULL for explicit-intent fires (no cosine was computed) and for '
    'non-fire telemetry rows.';

COMMENT ON COLUMN drift_events.signal_disagreement IS
    'Reserved. Set TRUE when the LLM classifier +DRIFT flag disagrees with '
    'the cosine signal. Useful for eval-suite calibration; not used to '
    'override the cosine decision.';

COMMENT ON COLUMN drift_events.created_via_explicit_intent IS
    'TRUE when detectExplicitRoutingRequest fast-path matched (user typed an '
    'explicit "switch to a new conversation about X" phrase). FALSE when '
    'cosine similarity fired drift. The two paths have different precision '
    'characteristics and should be analyzed separately.';
