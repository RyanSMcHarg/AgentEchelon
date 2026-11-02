-- ============================================================================
-- 081: a passage is found by its words as well as by its meaning.
--
-- An embedding of a whole question does not reliably rank the chunk that carries its decisive term:
-- measured on 2026-10-23, a question about where an exported profile's persona text is stored ranked
-- six passages from the right documents and none of the chunks that name `personaRef` and the body
-- store. `document-retrieval.ts` runs a lexical leg beside the vector leg and fuses the two; this
-- migration gives the lexical leg its index.
--
-- WHY A tsvector WITH THE 'simple' CONFIGURATION, AND NOT pg_trgm.
--
--  - 'simple' lowercases each token and does nothing else: no stemming and no stop-word list, so no
--    single language's morphology is built into the index. Deployment and person languages vary, and a
--    language-specific configuration would rank one language's text well and silently mistreat the
--    rest. Common words are discounted at query time by how many chunks contain them, which is a
--    property of the corpus rather than of a language.
--  - The default parser keeps an identifier written as one alphanumeric run as one lexeme
--    (`personaRef` becomes `personaref`), so an exact identifier in a question matches it exactly, and
--    a prefix query (`persona:*`) reaches the compound from its first word.
--  - A tsvector match is per token and the GIN index answers "which chunks contain this term" directly,
--    which is what term-rarity weighting needs. pg_trgm scores the trigram overlap of a whole string,
--    which suits a short value against short values (a name, a title); against a multi-word question
--    and chunks of several hundred words it is dominated by length and has no notion of a rare term.
--
-- A GENERATED COLUMN, so every row has it without a write path having to remember it: rows already in
-- the table are computed when the column is added, and every later INSERT or UPDATE of `content`
-- (document-ingestion.ts) recomputes it. Nothing that writes `embeddings` changes.
--
-- COST ON AN EXISTING CLUSTER. Adding a STORED generated column rewrites the table once, inside the
-- shared migration transaction, holding an exclusive lock on `embeddings` while it does. That is DDL
-- whose work is one tokenization per existing chunk, done once; it is not a data step that needs a
-- batch bound (`migration-data-steps-are-bounded.test.ts` covers UPDATE and DELETE). Retrieval that
-- arrives during the rewrite waits for it.
--
-- IDEMPOTENT + TRANSACTION-SAFE (auto-applies at Lambda cold start, on fresh and existing clusters):
-- ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, no CONCURRENTLY.
-- ============================================================================

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_embeddings_content_tsv
  ON embeddings USING gin (content_tsv);

COMMENT ON COLUMN embeddings.content_tsv IS
  'Lexical index of content (simple configuration: lowercased tokens, no stemming, no stop words). '
  'Generated, so every row carries it. Read by the lexical leg of document-retrieval.ts.';
