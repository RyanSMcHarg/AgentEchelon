-- The backfill in 065, done again, bounded, and split across two roles because NEITHER role can do it
-- alone.
--
-- WHAT 065 GOT WRONG. It added `summary_embeddings.generated_by` and backfilled it from
-- `conversation_summaries` as the migration owner. `summary_embeddings` is under FORCE ROW LEVEL
-- SECURITY (ADR-028), and FORCE applies to the OWNER too, so the UPDATE matched zero rows, reported
-- success, and recorded itself applied. The column add was fine; only the row write was lost.
--
-- WHY THE OBVIOUS FIX WAS ALSO WRONG, measured: assuming `ae_writer` for the whole statement fails
-- with `permission denied for table conversation_summaries`. `ae_writer` holds DML on the BOUNDED
-- tables only (`classification-boundary-sql.ts`), and `conversation_summaries` is not one of them -
-- it carries no classification, which is the same reason the reader role could not join it either.
-- And because every pending migration shares ONE transaction, that refusal aborted the whole run:
-- `Schema migration failed` on every analytics cold start, with the schema stuck before this file.
--
-- SO THE TWO HALVES USE THE TWO ROLES. The owner can read `conversation_summaries` and is the only
-- one who may; `ae_writer` can write `summary_embeddings` and is the only one who may. The read
-- therefore happens as the owner into a temp table, the write happens as the writer out of it, and
-- neither role is widened to cover the other's half. Widening `ae_writer` to read
-- `conversation_summaries` would have been the smaller diff and the larger mistake: it would hand
-- every writer in the deployment standing access to summary TEXT, permanently, to fix one backfill.
DO $$
DECLARE
    -- BOUNDED, because the shared transaction is also a Lambda invocation: an unbounded rewrite of an
    -- accumulating table can overrun it, and an overrun commits nothing and starts over next time.
    batch_size CONSTANT integer := 5000;
    left_to_do bigint;
BEGIN
    -- READ AS THE OWNER. `ON COMMIT DROP` so this cannot outlive the migration transaction it belongs
    -- to, and no cleanup step has to be remembered.
    CREATE TEMP TABLE _anchor_provenance ON COMMIT DROP AS
        SELECT channel_arn, version, generated_by
          FROM conversation_summaries
         WHERE generated_by IS NOT NULL;

    -- Guarded exactly as 029 guards it: on a fresh cluster the boundary bootstrap has not run, so the
    -- role does not exist and there is no RLS to satisfy either - the owner writes directly and the
    -- result is identical.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_writer') THEN
        -- The temp table is the owner's, so the writer needs to be let into it explicitly. Session
        -- scoped, and gone with the table at commit.
        GRANT SELECT ON _anchor_provenance TO ae_writer;
        SET LOCAL ROLE ae_writer;
    END IF;

    UPDATE summary_embeddings se
       SET generated_by = p.generated_by
      FROM _anchor_provenance p
     WHERE p.channel_arn = se.channel_arn
       AND p.version = se.embedded_from_version
       AND se.ctid IN (
           SELECT ctid
             FROM summary_embeddings
            WHERE generated_by IS NULL
            LIMIT batch_size
       );

    -- Counted through the same role, for the same reason the UPDATE is: as the owner under FORCE RLS
    -- this count sees nothing and would report a finished backfill.
    SELECT COUNT(*) INTO left_to_do
      FROM summary_embeddings
     WHERE generated_by IS NULL;

    -- MANDATORY, and before the bookkeeping write. A standing `SET LOCAL` is inherited by whatever
    -- runs next in this shared transaction, and `ae_writer` holds nothing on `_migration_progress`.
    RESET ROLE;

    INSERT INTO _migration_progress (filename, remaining, updated_at)
    VALUES ('066-the-anchor-provenance-backfill-that-wrote-nothing.sql', left_to_do, NOW())
    ON CONFLICT (filename) DO UPDATE
        SET remaining = EXCLUDED.remaining, updated_at = NOW();
END $$;
