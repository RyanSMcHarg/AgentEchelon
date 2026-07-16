/**
 * Document Retrieval — RAG proof-point retriever.
 *
 * Companion to `document-ingestion.ts`. Embeds a query, runs a
 * pgvector cosine-NN against the `embeddings` table (schema migration
 * 008), filters by `source_type` and (optionally) tier metadata, and
 * returns top-K chunks plus citations in a shape the async processor
 * can fold into the system prompt.
 *
 * ADR-001 + ADR-002 anchoring:
 *   - Aurora pgvector as the KB backing (no Bedrock KB on OpenSearch)
 *   - Titan v2 @ 1024-dim embeddings (matches summary-embeddings)
 *
 * Failure mode is best-effort: an embedding call that fails returns
 * `{chunks: [], citations: []}` so the agent reply proceeds without
 * RAG context for that turn (same posture as drift detection).
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { query } from './db-client.js';

const bedrock = new BedrockRuntimeClient({});

const EMBEDDING_MODEL_ID =
  process.env.DRIFT_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM = 1024;
const EMBEDDING_TIMEOUT_MS = 500; // live-path budget — same as drift detection

export interface RetrieveContextInput {
  /** The user's message / query text — embedded and used for cosine NN. */
  query: string;
  /**
   * Restrict candidates to these source_types. Default
   * ['wiki', 'doc'] — the document-ingestion sources, excluding
   * conversation/summary embeddings written by other paths.
   */
  sourceTypes?: string[];
  /**
   * Max chunks to return. Default 4; spec is "low single-digits so the
   * prompt budget isn't eaten by context."
   */
  topK?: number;
  /**
   * Minimum cosine similarity (0..1) for a chunk to be returned.
   * Default 0.35 — below that, content is too tangentially related to
   * justify spending prompt budget on. Tunable per-deployment.
   */
  minSimilarity?: number;
  /**
   * Optional tier filter — restricts chunks to those whose
   * metadata.tier is in this list (or has no tier set, treated as
   * available to all). Implements ADR-007 (KB permission filters).
   */
  tierScope?: Array<'basic' | 'standard' | 'premium'>;
}

export interface RetrievedChunk {
  sourceId: string;
  sourceType: string;
  title: string | null;
  chunkIndex: number | null;
  content: string;
  similarity: number;
}

export interface Citation {
  index: number;
  sourceId: string;
  title: string | null;
  similarity: number;
}

export interface RetrieveContextResult {
  chunks: RetrievedChunk[];
  citations: Citation[];
  /** True when the query embedding step failed; caller emits honest empty. */
  signalAvailable: boolean;
}

const EMPTY: RetrieveContextResult = { chunks: [], citations: [], signalAvailable: true };

export async function retrieveContext(
  input: RetrieveContextInput,
): Promise<RetrieveContextResult> {
  const text = (input.query || '').trim();
  if (!text) return EMPTY;

  const topK = Math.max(1, Math.min(input.topK ?? 4, 10));
  const minSim = input.minSimilarity ?? 0.35;
  const sourceTypes = input.sourceTypes ?? ['wiki', 'doc'];

  // Embed the query.
  const queryEmbedding = await embedQuery(text);
  if (!queryEmbedding) {
    return { chunks: [], citations: [], signalAvailable: false };
  }

  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  // pgvector cosine-distance NN. `<=>` is the cosine-distance operator;
  // similarity = 1 - distance. Filter by source_type at SQL level (not
  // post-filter) so the HNSW index can prune correctly. Optionally
  // filter by tier metadata.
  // FAIL-CLOSED tier gate: a chunk is returned only if its `metadata.tier` is in
  // the caller's scope (their tier and below). An untagged chunk (`tier IS NULL`)
  // is NOT returned — the previous `IS NULL OR …` made every untagged chunk
  // visible to every tier, and since ingestion tagged nothing, that leaked ALL KB
  // content to ALL tiers. Ingestion now stamps `tier` (document-ingestion.ts,
  // fail-closed default); legacy rows written before that must be re-ingested
  // (re-put the S3 object under `rag/`) to become visible again.
  const tierClause = input.tierScope && input.tierScope.length > 0
    ? `AND metadata->>'tier' = ANY($3::text[])`
    : '';

  const params: unknown[] = [vectorLiteral, sourceTypes];
  if (input.tierScope && input.tierScope.length > 0) {
    params.push(input.tierScope);
  }

  const result = await query<{
    source_id: string;
    source_type: string;
    title: string | null;
    chunk_index: number | null;
    content: string;
    similarity: number;
  }>(
    `SELECT source_id,
            source_type,
            title,
            chunk_index,
            content,
            1 - (embedding <=> $1::vector) AS similarity
       FROM embeddings
      WHERE source_type = ANY($2::text[])
        ${tierClause}
      ORDER BY embedding <=> $1::vector
      LIMIT ${topK}`,
    params,
  );

  const chunks: RetrievedChunk[] = result.rows
    .filter((r) => r.similarity >= minSim)
    .map((r) => ({
      sourceId: r.source_id,
      sourceType: r.source_type,
      title: r.title,
      chunkIndex: r.chunk_index,
      content: r.content,
      similarity: r.similarity,
    }));

  // Citations: deduplicate by sourceId so multiple chunks from the same
  // doc share one citation index. The chunk text in the prompt carries
  // `[N]` markers pointing at the citation list.
  const citationByDoc = new Map<string, Citation>();
  for (const chunk of chunks) {
    if (!citationByDoc.has(chunk.sourceId)) {
      citationByDoc.set(chunk.sourceId, {
        index: citationByDoc.size + 1,
        sourceId: chunk.sourceId,
        title: chunk.title,
        similarity: chunk.similarity,
      });
    }
  }

  return {
    chunks,
    citations: Array.from(citationByDoc.values()),
    signalAvailable: true,
  };
}

/**
 * Pure shaping: turn a retrieval result into a system-prompt fragment.
 * Returns empty string when there's nothing to inject. Chunks are
 * presented with `[N]` markers that map to the citation list; the
 * model is instructed to use the markers when answering from retrieved
 * context, so a downstream `<!--sources:-->` marker (emitted by the
 * model in its reply text) can resolve to the right URLs.
 */
export function buildRetrievedContextHint(result: RetrieveContextResult): string {
  if (!result.chunks.length) return '';

  const citationToIndex = new Map<string, number>();
  for (const c of result.citations) citationToIndex.set(c.sourceId, c.index);

  const chunkLines = result.chunks.map((chunk) => {
    const idx = citationToIndex.get(chunk.sourceId) ?? 0;
    return `[${idx}] ${chunk.content.trim()}`;
  });

  const citationLines = result.citations.map(
    (c) => `[${c.index}] ${c.title ?? c.sourceId} (similarity ${c.similarity.toFixed(2)})`,
  );

  return `
## RETRIEVED CONTEXT

The following passages were retrieved from the knowledge base based on the user's message. Cite them with the bracketed numbers when your answer draws on them. If retrieved context is irrelevant to the user's actual question, ignore it — never fabricate a citation.

${chunkLines.join('\n\n')}

### Sources
${citationLines.join('\n')}
`;
}

/**
 * Render the conversation's running summary as an always-relevant system-prompt
 * section (ADR-017: summary as consumable context). Injected only when the
 * router attached a summary (long conversation); empty string otherwise, so
 * callers can append unconditionally.
 */
export function buildConversationSummaryHint(summary: string | undefined | null): string {
  const text = (summary ?? '').trim();
  if (!text) return '';
  return `
## EARLIER IN THIS CONVERSATION (summary)

This conversation is long enough that its earlier turns are no longer in the recent history above. Use this running summary to stay consistent with what was already discussed and decided; prefer the live turns when they conflict.

${text}
`;
}

async function embedQuery(text: string): Promise<number[] | null> {
  const input = text.slice(0, 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  try {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: EMBEDDING_MODEL_ID,
        body: JSON.stringify({
          inputText: input,
          dimensions: EMBEDDING_DIM,
          normalize: true,
        }),
        contentType: 'application/json',
        accept: 'application/json',
      }),
      { abortSignal: controller.signal },
    );
    clearTimeout(timer);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    const embedding = body?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) return null;
    return embedding as number[];
  } catch (err) {
    clearTimeout(timer);
    console.warn('[document-retrieval] query embed failed:', err);
    return null;
  }
}
