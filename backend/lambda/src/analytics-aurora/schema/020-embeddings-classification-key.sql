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
UPDATE embeddings
   SET metadata = jsonb_set(metadata - 'tier', '{classification}', metadata -> 'tier')
 WHERE metadata ? 'tier' AND NOT (metadata ? 'classification');

-- Rows carrying NEITHER key stay invisible to retrieval, which is the intended fail-closed behaviour
-- for untagged content (document-ingestion.ts stamps the key on every write; anything without one
-- predates that and must be re-ingested rather than shown to every classification).
