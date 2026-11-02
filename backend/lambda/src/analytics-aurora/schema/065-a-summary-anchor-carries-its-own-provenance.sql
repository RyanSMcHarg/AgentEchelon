-- A summary anchor states who generated it, on the table the reader is allowed to read.
--
-- WHAT WAS WRONG, AND IT WAS NOT THE GRANT. `loadSummaryEmbedding` (drift-detection.ts) reads the
-- anchor as the channel's READER role, correctly: the row carries a classification and RLS narrows it
-- to the ones this channel may see. To report WHO generated the summary the anchor was built from, it
-- joined `conversation_summaries` for its `generated_by`. Reader roles hold SELECT on exactly the
-- three bounded tables (`classification-boundary-sql.ts`), and `conversation_summaries` is not one of
-- them, so the whole query was refused with `permission denied for table conversation_summaries`.
--
-- HOW IT PRESENTED, which is worse than an error. The caller catches and warns, so the anchor came
-- back null and drift compared against nothing. That reads as "the conversation has not drifted"
-- rather than as a fault, on the one signal whose whole job is to notice a change of subject.
-- Measured: every drift turn on the deployment, logging `[drift] summary_embeddings lookup failed`.
--
-- WHY THE FIX IS NOT A GRANT. Adding `conversation_summaries` to the bounded set would mean granting
-- every reader role SELECT on a table with NO classification column, so RLS has nothing to scope it
-- by, and a basic reader could read a premium conversation's summary text. The reach the join wanted
-- is one 64-character provenance string, so the string moves to the table that is already scoped.
--
-- ADDITIVE AND IDEMPOTENT, as every migration here must be: it re-runs on a cold start.
ALTER TABLE summary_embeddings ADD COLUMN IF NOT EXISTS generated_by VARCHAR(64);

-- BACKFILLED FROM THE SUMMARY THE ANCHOR WAS ACTUALLY BUILT FROM, joined on the exact version, so the
-- value describes THAT summary and not a later one. Without this, every anchor written before this
-- migration reads as null, and the caller's null-fallback treats a real topic as the thin
-- single-message case - which suppresses drift on exactly the long conversations it matters for.
--
-- Migrations run as the owner, which may read both tables; this is the one place the join is allowed
-- and it happens once rather than per turn.
--
-- `WHERE se.generated_by IS NULL` makes the re-run a no-op and also protects a value the writer has
-- since set: a row re-embedded after this migration carries its writer's own provenance, and that is
-- fresher than whatever `conversation_summaries` holds for the same version.
--
-- THROUGH THE WRITE ROLE, BECAUSE THE OWNER WRITES NOTHING HERE. `summary_embeddings` is under FORCE
-- ROW LEVEL SECURITY (ADR-028), which applies to the table owner too: issued as the owner this UPDATE
-- matches ZERO rows and reports success, so the backfill would look done and every anchor written
-- before this migration would still read `generated_by` as null. That is the exact failure this
-- table's policies are built to make loud, and it is silent in a migration.
--
-- GUARDED, because the role does not always exist yet: `schema-init` applies these files on a fresh
-- cluster before any boundary bootstrap, and on an existing cluster the boundary runs after the
-- migrations in the same transaction. In both cases there is no RLS to satisfy either, so the owner
-- writes directly and the result is the same.
-- THE READ AND THE WRITE USE DIFFERENT ROLES, because neither can do both. The owner is the only one
-- who may read `conversation_summaries` (it carries no classification, so it is not a bounded table
-- and `ae_writer` holds nothing on it); `ae_writer` is the only one who may write
-- `summary_embeddings` (FORCE RLS applies to the owner too). Assuming the writer for the whole
-- statement fails with `permission denied for table conversation_summaries` and, because every
-- pending migration shares one transaction, aborts the entire run. See 066, which carries the same
-- split and the resume bookkeeping.
DO $$
BEGIN
    CREATE TEMP TABLE _anchor_provenance_065 ON COMMIT DROP AS
        SELECT channel_arn, version, generated_by
          FROM conversation_summaries
         WHERE generated_by IS NOT NULL;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_writer') THEN
        GRANT SELECT ON _anchor_provenance_065 TO ae_writer;
        SET LOCAL ROLE ae_writer;
    END IF;

    -- BOUNDED: every pending migration shares one transaction in one Lambda invocation, so an
    -- unbounded rewrite of an accumulating table can overrun it - and an overrun commits nothing and
    -- starts over on the next cold start. `066` carries the remainder and the resume bookkeeping.
    UPDATE summary_embeddings se
       SET generated_by = p.generated_by
      FROM _anchor_provenance_065 p
     WHERE p.channel_arn = se.channel_arn
       AND p.version = se.embedded_from_version
       AND se.ctid IN (
           SELECT ctid
             FROM summary_embeddings
            WHERE generated_by IS NULL
            LIMIT 5000
       );

    -- MANDATORY. A `SET LOCAL` left standing is inherited by whatever runs next in this shared
    -- transaction, and `ae_writer` holds nothing on the migration bookkeeping tables.
    RESET ROLE;
END $$;
