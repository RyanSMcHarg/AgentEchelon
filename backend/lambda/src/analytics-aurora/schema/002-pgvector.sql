-- ============================================================================
-- pgvector Extension + Embeddings Table
-- Aurora PostgreSQL 15 with pgvector
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    source_type VARCHAR(50) NOT NULL,
    source_id VARCHAR(500) NOT NULL,
    content TEXT,
    embedding vector(1536),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);

-- HNSW index for fast cosine similarity search
-- Only create if embeddings table has rows (avoid empty index build issues)
-- This index will be created automatically on first insert via ensureSchema
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_embeddings_vector'
    ) THEN
        CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (embedding vector_cosine_ops);
    END IF;
END $$;
