-- A TABLE NOTHING WRITES IS DROPPED (SPEC-EVALUATION Appendix C, housekeeping).
--
-- `agent_scores` has been created since 001 and written by nothing in Aurora mode: per-assistant figures
-- are aggregated at read from `evaluation_results` and `exchanges` (migration 072 dropped the rollups for
-- the same reason). An empty table that a reader could join reads as a quiet week rather than as a
-- table nobody fills, so it goes.
--
-- AFTER 075, AND ONLY ONCE 075 HAS FINISHED. Migration 075's resumable backfill updates this table on
-- every run until it reports nothing left; dropping the table while 075 is still pending would fail its
-- next run and stop the schema converging. So while 075 is pending this reports work left and stays
-- pending itself, and drops the table on the run after 075 is recorded.
--
-- Runtime-applied migrations run inside ONE transaction; this is idempotent and transaction-safe.
DO $drop$
BEGIN
    IF EXISTS (SELECT 1 FROM _migrations WHERE filename = '075-the-assistant-column-names-what-it-holds.sql') THEN
        DROP TABLE IF EXISTS agent_scores;
        INSERT INTO _migration_progress (filename, remaining, updated_at)
        VALUES ('088-a-table-nothing-writes-is-dropped.sql', 0, NOW())
        ON CONFLICT (filename) DO UPDATE SET remaining = 0, updated_at = NOW();
    ELSE
        INSERT INTO _migration_progress (filename, remaining, updated_at)
        VALUES ('088-a-table-nothing-writes-is-dropped.sql', 1, NOW())
        ON CONFLICT (filename) DO UPDATE SET remaining = 1, updated_at = NOW();
    END IF;
END
$drop$;
