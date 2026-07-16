-- ============================================================================
-- Document Embeddings — RAG demonstration proof point
-- ============================================================================
--
-- The dormant `embeddings` table from migration 002 was declared at
-- vector(1536) — the original plan when OpenAI text-embedding-3-small was
-- the candidate model. ADR-002 (2026-04-28) selected Amazon Titan Text
-- Embeddings v2 at 1024 dimensions; ADR-001 (2026-04-28) committed to
-- Aurora pgvector as the KB backing store. Existing `summary_embeddings`
-- (migration 005) already runs at 1024-dim; this migration brings the
-- generic `embeddings` table into ADR-002 conformance and adds the
-- columns the document-ingestion Lambda needs.
--
-- Safe to ALTER the column type because nothing has populated this table
-- yet (verified by code review 2026-05-22 — no Lambda writes to it).
-- HNSW indexes must be rebuilt against the new vector dimension; the DO
-- block in migration 002 created the index only on first insert, so it
-- may not exist yet — handle both cases.
-- ============================================================================

-- 1) Bring the dormant embeddings table to ADR-002's Titan v2 dimension.
ALTER TABLE embeddings
  ALTER COLUMN embedding TYPE vector(1024);

-- 2) Rebuild the HNSW index (idempotent — drops if present, recreates).
DROP INDEX IF EXISTS idx_embeddings_vector;
CREATE INDEX idx_embeddings_vector
  ON embeddings USING hnsw (embedding vector_cosine_ops);

-- 3) Add the columns the document-ingestion Lambda needs that aren't in
--    the original schema. All nullable so existing rows (none today, but
--    future-proof) don't need backfill.
ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS chunk_index INTEGER,
  ADD COLUMN IF NOT EXISTS source_etag VARCHAR(64),
  ADD COLUMN IF NOT EXISTS title VARCHAR(500),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Idempotent ingestion guard: a re-ingest of the same source file (same
-- S3 etag) shouldn't double-insert chunks. The composite unique constraint
-- lets the ingestor INSERT ... ON CONFLICT DO NOTHING per chunk.
-- source_type + source_id + chunk_index is the natural key; source_etag
-- additionally distinguishes revisions of the same file.
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_source_chunk
  ON embeddings (source_type, source_id, chunk_index);

-- Lookup index for tier-scoped retrieval. The metadata JSONB holds {tier,
-- visibility} for per-tier filtering at query time; this GIN index makes
-- the @> containment operator fast.
CREATE INDEX IF NOT EXISTS idx_embeddings_metadata_gin
  ON embeddings USING gin (metadata);

-- Confirm the table is now ADR-002-conformant (introspection query for
-- the schema-init Lambda's verification step).
COMMENT ON TABLE embeddings IS
  'Generic vector store for RAG / cross-conversation context. ADR-002: Titan v2 @ 1024-dim. ADR-001: Aurora pgvector as KB backing.';
COMMENT ON COLUMN embeddings.source_type IS
  'High-level category (wiki, doc, conversation, summary). Used to filter at retrieval time.';
COMMENT ON COLUMN embeddings.source_id IS
  'Provider-specific id within source_type (e.g. s3://bucket/path/foo.md for wiki, channelArn for conversation).';
COMMENT ON COLUMN embeddings.chunk_index IS
  'Position of this chunk within source_id. NULL for single-chunk sources (e.g. summaries).';
COMMENT ON COLUMN embeddings.source_etag IS
  'S3 ETag at ingestion time. Used to detect when a source file changed; the ingestion Lambda re-embeds when ETag differs.';
COMMENT ON COLUMN embeddings.metadata IS
  'JSON: {tier?, visibility?, filename?, sourceUrl?, anchor?}. Tier+visibility drive retrieval-time filtering.';
