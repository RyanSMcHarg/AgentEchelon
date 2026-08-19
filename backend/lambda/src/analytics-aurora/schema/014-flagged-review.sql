-- 014-flagged-review.sql
-- Persistence for the admin console's Quality > Flagged review action (approve / reject + note).
--
-- Flagged responses are DERIVED at query time from `evaluation_results` (low relevance, non-compliant,
-- or judge flags) rather than stored, so there is no row to mark. The reviewer's verdict is separate,
-- human-authored state and gets its own table keyed by exchange: the eval store stays a pure record of
-- what the judge decided, and re-evaluating an exchange never silently discards a human review.
--
-- Before this, the review endpoint acknowledged without saving and the list hardcoded
-- `'pending' AS review_status`, so every reviewed item reappeared as unreviewed on the next load.
-- (The stated reason was that schema-init is Create-only and could not add a column on Update. That
-- is no longer true: db-client `applyPendingMigrations` applies any file not yet in `_migrations` on
-- the runtime IAM connection, so this auto-applies to existing clusters on the next deploy.)
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe (no CREATE INDEX CONCURRENTLY).
CREATE TABLE IF NOT EXISTS flagged_review (
    exchange_id   UUID PRIMARY KEY,          -- exchanges.id; one current verdict per exchange
    review_status VARCHAR(16) NOT NULL,      -- 'approved' | 'rejected'
    reviewer_sub  VARCHAR(128),              -- server-verified admin sub (from the JWT)
    note          TEXT,                      -- optional reviewer rationale
    reviewed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list query filters/sorts by verdict to separate outstanding work from settled items.
CREATE INDEX IF NOT EXISTS idx_flagged_review_status ON flagged_review(review_status, reviewed_at DESC);
