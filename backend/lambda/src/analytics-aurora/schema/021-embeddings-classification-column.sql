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
-- stamps both bounded tables from `mostRestrictiveValue` in the same cold start that applies this
-- file, under the write role, so there is no window in which a row is both present and unstamped.

-- Index for the policy predicate and for the existing scope filter.
CREATE INDEX IF NOT EXISTS idx_embeddings_classification ON embeddings (classification);
