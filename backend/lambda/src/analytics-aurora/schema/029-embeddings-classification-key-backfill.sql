-- Convert every `embeddings` row still carrying the pre-020 isolation metadata key, a BOUNDED batch
-- per cold start, until none remain.
--
-- WHY A SECOND FILE WHEN 020 ALREADY RENAMES THE KEY. `applyPendingMigrations` runs every pending file
-- plus the classification boundary in ONE transaction inside ONE Lambda invocation, and `ensureSchema`
-- rethrows with nothing committed if that invocation runs out. 020's rename was one unbounded UPDATE
-- over the whole table, so on a deployment whose `embeddings` table predates it, an overrun recorded
-- nothing and the next cold start began the identical whole-table rewrite from zero: the upgrade could
-- never converge, and while it did not, retrieval filtered on a key no row carried yet and returned
-- honest-empty for every classification. 020 is now bounded to one batch and this file finishes the job
-- across as many cold starts as it takes.
--
-- 020 IS NOT REWRITTEN. It is already recorded in `_migrations` wherever it has run, so an edit there is
-- inert for those deployments; the bound it gained only protects deployments that have yet to reach it.
-- The convergence lives here, where it applies to every deployment.
--
-- RESUMABLE. `_migration_progress.remaining` is what `applyPendingMigrations` reads to decide whether
-- this file is finished: a non-zero count leaves it PENDING so the next cold start runs the next batch,
-- and it is recorded as applied only once nothing is left. See the "RESUMABLE MIGRATIONS" note in
-- `db-client.ts`.
--
-- `schema-init` DOES NOT READ THAT COUNT, and does not need to. It bootstraps on stack Create only, so
-- the table it applies this file to is empty and one batch is the whole job. The resumable path is the
-- runtime one, which is also the only path an existing cluster takes.
--
-- BOTH SIDES OF THE ROW MOVE TOGETHER, and the predicate keys on the OLD value rather than on the new
-- one being absent. 021 backfilled the `classification` column from the key, and the boundary bootstrap
-- stamps any row whose column is still NULL with the MOST RESTRICTIVE classification. So a row this
-- backfill has not reached yet carries no key, gets no column, and is stamped most-restrictive: withheld
-- rather than leaked, which is the right direction, but it is not the row's real classification. Had
-- this file keyed on `classification IS NULL` that stamp would have been mistaken for the answer and the
-- row would have stayed misclassified permanently. Keying on the surviving old value corrects it.
--
-- ROWS CARRYING NEITHER KEY are deliberately untouched, exactly as in 020: untagged content predates
-- ingestion-time stamping and must be re-ingested rather than guessed at.
--
-- IDEMPOTENT + TRANSACTION-SAFE (required: this auto-applies at Lambda cold start on fresh AND existing
-- clusters). A re-run over a converged table matches no rows and reports nothing remaining.

-- `db-client.ts` creates this too. Both creations are IF NOT EXISTS because `schema-init` bootstraps a
-- fresh cluster by applying these files directly and knows nothing about resumable migrations.
CREATE TABLE IF NOT EXISTS _migration_progress (
    filename VARCHAR(256) PRIMARY KEY,
    remaining BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $backfill$
DECLARE
    -- Sized to be trivially completable inside any of this stack's Lambda timeouts, on the assumption
    -- that a batch may be the only thing that gets done in a cold start. Same value as 020.
    batch_size CONSTANT INT := 5000;
    left_to_do BIGINT;
BEGIN
    -- ADR-028: `embeddings` is under FORCE ROW LEVEL SECURITY and the OWNER has no policy, so the
    -- UPDATE below would report success having touched zero rows if it ran unroled - and, worse, the
    -- COUNT would come back zero too, so this file would declare itself finished having done nothing.
    --
    -- GUARDED, because the role does not always exist yet. `schema-init` applies these files on a fresh
    -- cluster BEFORE any boundary bootstrap has run, and on an existing cluster's first upgrade the
    -- boundary runs AFTER the migrations in the same transaction. In both cases there is no RLS to
    -- satisfy either, so the owner writes the table directly and the result is the same.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_writer') THEN
        SET LOCAL ROLE ae_writer;
    END IF;

    UPDATE embeddings
       SET metadata = jsonb_set(metadata - 'tier', '{classification}', metadata -> 'tier'),
           classification = metadata ->> 'tier'
     WHERE ctid IN (
         SELECT ctid
           FROM embeddings
          WHERE metadata ? 'tier' AND NOT (metadata ? 'classification')
          LIMIT batch_size
     );

    -- Counted through the same role, for the same reason the UPDATE is.
    SELECT COUNT(*) INTO left_to_do
      FROM embeddings
     WHERE metadata ? 'tier' AND NOT (metadata ? 'classification');

    -- MANDATORY, and before the bookkeeping write. A `SET LOCAL` left standing is inherited by whatever
    -- runs next in this shared transaction, and `ae_writer` holds nothing on `_migration_progress`.
    RESET ROLE;

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('029-embeddings-classification-key-backfill.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END
$backfill$;
