-- ADR-028 step 1: promote the isolation classification from a JSONB key to a real column.
--
-- WHY A COLUMN. Row-level security evaluates its predicate for every row the scan considers. A
-- `metadata->>'classification'` expression cannot use a btree index the way a column can, so the
-- policy that ADR-028 adds next would pay that cost on every retrieval. The column is also what makes
-- the boundary legible in the schema: today you have to read the query to learn that this table is
-- classification-partitioned at all.
--
-- THE COLUMN IS NOT YET THE BOUNDARY. Retrieval keeps filtering on the JSONB key until the policy
-- lands, so this migration changes no behaviour - it only makes the next step possible. Both are
-- written on ingest from that point, and the policy step drops the JSONB read.
--
-- IDEMPOTENT + TRANSACTION-SAFE (auto-applies at Lambda cold start, on fresh and existing clusters).

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS classification TEXT;

-- Backfill from the key schema 020 established. Only rows that have it and lack the column, so a
-- re-run is a no-op and a partially-migrated table converges.
--
-- NO BATCH LIMIT HERE, and that is bounded rather than unbounded. This can only ever touch rows that
-- carry the `classification` key AND have no column value, and there are two sources of those: 020,
-- which is itself bounded to one batch and runs immediately before this file in the same transaction,
-- and document-ingestion, which writes the key and the column in the same INSERT and so produces none.
-- The ceiling is therefore 020's batch. `migration-data-steps-are-bounded.test.ts` records the
-- exemption so that a future edit which widens the predicate has to argue for it.
UPDATE embeddings
   SET classification = metadata ->> 'classification'
 WHERE classification IS NULL
   AND metadata ? 'classification';

-- FAIL-CLOSED for anything the backfill could not resolve. A row whose classification is unknown must
-- never be readable by a lower classification. NULL already achieves that against an `= ANY(scope)`
-- predicate - NULL matches no scope - but it is easy to misread as "unclassified, therefore harmless",
-- so the most restrictive classification is stamped explicitly, matching document-ingestion.ts's
-- default for untagged content.
--
-- THAT STAMP IS NOT DONE HERE. Which value is "most restrictive" is deployment config
-- (`lib/config/profiles.ts` - a deployment may rename or extend the ladder), and static SQL cannot
-- read it; hardcoding 'premium' here would be the same drift the profile registry exists to prevent,
-- on the one path where the consequence is a cross-classification read. `classification-boundary.ts`
-- stamps both bounded tables from `mostRestrictiveValue` under the write role, a bounded batch per
-- cold start so it cannot become a whole-table write inside the shared migration transaction. A row it
-- has not reached yet is NULL, which is STRICTER than the stamp, not looser: NULL matches no scope.
--
-- A ROW THIS BACKFILL RAN TOO EARLY TO SEE IS NOT SETTLED BY THAT STAMP EITHER. 020's key rename is
-- bounded to one batch, so rows still carrying the pre-020 key reach this file with nothing to read.
-- 029 finishes the rename and writes the column from the same key in one statement, which corrects the
-- fail-closed stamp instead of leaving it to be mistaken for the row's real value.

-- Index for the policy predicate and for the existing scope filter.
CREATE INDEX IF NOT EXISTS idx_embeddings_classification ON embeddings (classification);
