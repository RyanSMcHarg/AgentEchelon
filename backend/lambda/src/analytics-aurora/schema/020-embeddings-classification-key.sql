-- Rename the embeddings isolation metadata key to `classification`.
--
-- WHY THIS IS A MIGRATION AND NOT A RENAME. The key is the CLASSIFICATION ISOLATION filter
-- (document-retrieval.ts: `metadata->>'classification' = ANY(scope)`) and it is stamped on every
-- embedded row. Changing the name in code alone would leave every existing row carrying the old key,
-- so the filter would match nothing and retrieval would return empty for every classification. That
-- direction is fail-CLOSED (content withheld, never leaked), but it is silent: retrieval returning
-- nothing is indistinguishable from "nothing relevant". So the data moves first, in the same deploy.
--
-- Internal surfaces say `classification`; the old key used the customer-facing word, which left the
-- one value a security decision reads as the odd one out on the whole isolation path.
--
-- IDEMPOTENT + TRANSACTION-SAFE (required: applyPendingMigrations runs this at Lambda cold start on
-- fresh AND existing clusters). Only rows carrying the old key and lacking the new one are touched,
-- so a re-run is a no-op and a partially-migrated table converges.
--
-- BOUNDED TO ONE BATCH, and 029 converges the rest. Every pending file plus the classification boundary
-- shares ONE transaction inside ONE Lambda invocation, and nothing commits until all of it does - so a
-- whole-table jsonb rewrite that outran the invocation would record no progress at all, and the next
-- cold start would begin the same rewrite from zero, forever. Bounded work that lands is progress;
-- unbounded work that is discarded on timeout is not. The batch size is the same in both files.
UPDATE embeddings
   SET metadata = jsonb_set(metadata - 'tier', '{classification}', metadata -> 'tier')
 WHERE ctid IN (
   SELECT ctid
     FROM embeddings
    WHERE metadata ? 'tier' AND NOT (metadata ? 'classification')
    LIMIT 5000
 );

-- Rows carrying NEITHER key stay invisible to retrieval, which is the intended fail-closed behaviour
-- for untagged content (document-ingestion.ts stamps the key on every write; anything without one
-- predates that and must be re-ingested rather than shown to every classification).
