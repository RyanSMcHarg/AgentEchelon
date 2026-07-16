-- Migration 005: Summary embeddings table for live drift detection
--
-- Stores Titan v2 embeddings (1024-dim) of conversation summaries.
-- Populated by the embedding-writer Lambda on every conversation_summaries
-- insert/update. Consumed by drift detection's cosine-similarity comparison
-- and by findRelatedConversations' cosine-NN lookup.
--
-- Why a separate table from the existing 1536-dim `embeddings` table:
-- decision 002-embedding-model.md picks Titan v2 at 1024-dim. pgvector
-- doesn't allow ALTERing a column's dimension, so a new table at the right
-- dim is cleaner than DROP+recreate of the existing generic embeddings table.
-- The old `embeddings` table is dormant (no Lambda populates it today); it
-- can be cleaned up in a future migration once anything that depends on its
-- schema is gone.

CREATE TABLE IF NOT EXISTS summary_embeddings (
    channel_arn VARCHAR(256) PRIMARY KEY,
    embedding vector(1024) NOT NULL,
    embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    embedded_from_version INTEGER NOT NULL,
    model_id VARCHAR(128) NOT NULL DEFAULT 'amazon.titan-embed-text-v2:0'
);

-- HNSW index for fast approximate-NN cosine queries.
-- ef_construction=200 and m=16 are pgvector defaults; tune later if recall
-- on the eval suite warrants it.
CREATE INDEX IF NOT EXISTS idx_summary_embeddings_cosine
    ON summary_embeddings
    USING hnsw (embedding vector_cosine_ops);

-- Index for queries that need to know "which embeddings are out of date" —
-- the embedding-writer Lambda compares embedded_from_version to the
-- conversation_summaries.version on each insert/update to skip duplicate work.
CREATE INDEX IF NOT EXISTS idx_summary_embeddings_version
    ON summary_embeddings (embedded_from_version);

COMMENT ON TABLE summary_embeddings IS
    'Titan v2 (1024-dim) embeddings of conversation_summaries.summary. '
    'PK channel_arn; one row per conversation. Updated by embedding-writer '
    'Lambda whenever conversation_summaries.version increments. Consumed by '
    'drift-detection.ts cosine comparison and findRelatedConversations '
    'cosine-NN lookup.';

COMMENT ON COLUMN summary_embeddings.embedded_from_version IS
    'conversation_summaries.version this embedding was generated from. Used '
    'by the writer to detect staleness without re-computing the embedding '
    'on every summary read.';
