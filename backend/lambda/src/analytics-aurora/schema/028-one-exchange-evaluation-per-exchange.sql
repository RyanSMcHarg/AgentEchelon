-- 028: at most ONE exchange-type evaluation row per exchange.
--
-- Every read of `evaluation_results` already assumes this. The score reads pre-aggregate per
-- exchange_id precisely so a second row cannot fan a join out, and the experiment rollup that feeds
-- the ship recommendation now does the same. That is the read half of the fix; this is the write
-- half, so the duplicate cannot exist in the first place and no future read has to remember.
--
-- The duplicate is reachable. The evaluation runner selects the unscored backlog with `er.id IS NULL`
-- and then plain-INSERTs the score, with nothing between the two: two overlapping scheduled
-- invocations both see the same exchange as unscored and both write. The table carried indexes on
-- exchange_id but no uniqueness, so both rows persisted. The cost was silent, which is the worst
-- kind: a fanned-out join double-counts the exchange in COUNT(*) and mis-weights AVG/STDDEV, so the
-- variant sample size behind the Welch tests read larger than the traffic actually collected.
--
-- SCOPE. Partial, on the 'exchange' evaluation type only. Other evaluation types are free to hold
-- several rows per exchange, and rows with a NULL type predate the discriminator and are left alone.
--
-- DEDUPE FIRST, because the index cannot be created over rows that already violate it, and a
-- migration that fails on a live cluster blocks every later migration behind it. The survivor is the
-- most recent evaluation: a later score supersedes an earlier one, and after this runs the question
-- cannot arise again.
--
-- Idempotent and transaction-safe, as required of a runtime-applied migration (db-client applies
-- these in ONE transaction on cold start, so CREATE INDEX CONCURRENTLY is not available here). The
-- DELETE is a no-op on a table that is already deduplicated, and the index is IF NOT EXISTS.
--
-- ON COST, since a migration's data step gets one shot inside that shared transaction. The DELETE
-- ranks the exchange-type rows once and removes only duplicates, so the work it does scales with the
-- duplicates a deployment has (a handful at most: they come from overlapping scheduled runs) while the
-- work it READS is one pass over the table. That pass is the same order as the unique index build on
-- the next statement, which is fixed work no batching can remove, so batching the DELETE would leave
-- the dominant cost untouched. Nothing here is resumable by design: either the constraint exists after
-- this transaction or the migration stays pending and is retried whole.

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY exchange_id
               ORDER BY evaluated_at DESC NULLS LAST, id DESC
           ) AS rn
      FROM evaluation_results
     WHERE evaluation_type = 'exchange'
)
DELETE FROM evaluation_results
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_one_exchange_row
    ON evaluation_results (exchange_id)
 WHERE evaluation_type = 'exchange';

COMMENT ON INDEX idx_evaluation_one_exchange_row IS
    'One exchange-type evaluation per exchange. The scores are read as per-exchange aggregates and '
    'the experiment rollup counts exchanges through this join, so a second row would inflate the '
    'sample size behind a ship recommendation rather than fail loudly.';
