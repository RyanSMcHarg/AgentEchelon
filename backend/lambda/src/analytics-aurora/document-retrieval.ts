/**
 * Document Retrieval — RAG proof-point retriever.
 *
 * Companion to `document-ingestion.ts`. Embeds a query, runs a
 * pgvector cosine-NN against the `embeddings` table (schema migration
 * 008), filters by `source_type` and (optionally) classification metadata, and
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
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';
import { withReaderRole } from './classification-boundary.js';

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
   * REQUIRED classification filter — the caller's classification and everything below it, as
   * `profiles.scopeAtOrBelow(classification)`. Restricts chunks to those whose `metadata.classification` is in
   * this list. Implements ADR-007 (KB permission filters).
   *
   * Required, and separately re-checked at runtime, because this is a read boundary: it used to be
   * optional, and an omitted scope produced NO filter at all rather than no results, so a single caller
   * that forgot it would silently read across every classification. The type alone is not enough - the
   * data-plane dispatch hands this input across a Lambda boundary as `any`, which erases it.
   */
  classificationScope: string[];
  /**
   * REQUIRED. The caller's OWN classification - the immutable channel tag the router resolved, not a
   * derived list. It selects the database reader role this query runs as (ADR-028), which is the
   * boundary; `classificationScope` above is the query filter, which is defence in depth.
   *
   * WHY BOTH, when one is derivable from the other. It is NOT safely derivable: taking the top of
   * `classificationScope` would mean a caller that built a too-wide scope also got a too-privileged
   * role, so the bug that widens the filter would widen the privilege with it and the second control
   * would fail in the same direction as the first. Passing the classification independently, and
   * cross-checking the two below, means a mismatch is an error rather than an escalation.
   */
  classification: string;
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
  // FAIL CLOSED ON AN ABSENT SCOPE, before any other work. Previously a missing/empty scope produced
  // an EMPTY filter clause, i.e. no filter and every chunk at every classification returned - the read
  // boundary was fail-open by omission, enforced only by each caller remembering to pass it. Refuse
  // instead: an unscoped call is a programming error, and returning "no results" would disguise it as
  // an empty corpus. Checked FIRST so a misconfigured call cannot spend a Bedrock embed round-trip on
  // its way to being rejected. The runtime check is not redundant with the required type - the
  // data-plane dispatch hands this input across a Lambda boundary as `any`, which erases the type.
  if (!Array.isArray(input.classificationScope) || input.classificationScope.length === 0) {
    throw new Error(
      '[document-retrieval] classificationScope is required and must be non-empty: retrieval is '
      + 'classification-scoped (ADR-007) and will not run unscoped. Pass profiles.scopeAtOrBelow(classification).',
    );
  }

  // The role this query will assume. Rejected rather than defaulted: `resolveClassification` would
  // fail CLOSED to the floor, which sounds safe and is wrong here - it would silently downgrade a
  // premium turn to basic retrieval and present the resulting hole in the answer as "nothing
  // relevant". An unrecognized classification is a wiring fault and is surfaced as one.
  if (!profiles.isKnownClassification(input.classification)) {
    throw new Error(
      `[document-retrieval] unknown classification ${JSON.stringify(input.classification)}: retrieval `
      + 'runs as a per-classification database role (ADR-028) and there is no role for this value.',
    );
  }

  // The filter and the privilege must describe the same ladder. If they disagree, one of them is
  // wrong and there is no way to tell which - so neither is used. This is the check that keeps the
  // two controls independent instead of letting the wider one win.
  const expectedScope = profiles.scopeAtOrBelow(input.classification);
  const scopeMatches = input.classificationScope.length === expectedScope.length
    && [...input.classificationScope].sort().join(',') === [...expectedScope].sort().join(',');
  if (!scopeMatches) {
    throw new Error(
      `[document-retrieval] classificationScope ${JSON.stringify(input.classificationScope)} is not the `
      + `ladder for ${JSON.stringify(input.classification)} (${JSON.stringify(expectedScope)}). The SQL `
      + 'filter and the database role would enforce different boundaries.',
    );
  }

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
  // filter by classification metadata.
  // FAIL-CLOSED classification gate: a chunk is returned only if its `metadata.classification` is in
  // the caller's scope (their classification and below). An untagged chunk is NOT returned — the
  // previous `IS NULL OR …` made every untagged chunk visible to every classification, and since
  // ingestion tagged nothing, that leaked ALL KB content to ALL classifications. Ingestion now stamps
  // the `classification` metadata key (document-ingestion.ts, fail-closed default); legacy rows
  // written before that must be re-ingested (re-put the S3 object under `rag/`) to become visible.
  //
  // Schema 020 renamed this key and moved it on every row. Reading ONLY the current name is
  // deliberate: had that migration not run, this filter matches nothing and retrieval returns empty,
  // which withholds content rather than leaking it. Accepting both names via COALESCE would have been
  // more forgiving and would have kept a second spelling alive on a security boundary indefinitely.
  // Scope was validated at the top of the function, so the filter is unconditional here.
  const classificationClause = `AND metadata->>'classification' = ANY($3::text[])`;
  const params: unknown[] = [vectorLiteral, sourceTypes, input.classificationScope];

  // ADR-028: the query runs as this classification's READER ROLE, not as the shared owner. Row-level
  // security admits only rows at or below that role's ladder, so the clause above becomes defence in
  // depth rather than the boundary itself - if it were deleted tomorrow, this query would still not
  // see a premium chunk on a basic turn.
  //
  // It goes through `withReaderRole` (which uses `transaction()` + `SET LOCAL ROLE`) rather than the
  // pooled `query()` for a specific reason: `query()` opens no transaction, and a bare `SET ROLE`
  // there would persist on the pooled connection into the NEXT invocation - possibly a different
  // classification - which is the leak this control exists to prevent.
  const result = await withReaderRole(input.classification, (client) => client.query<{
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
        ${classificationClause}
      ORDER BY embedding <=> $1::vector
      LIMIT ${topK}`,
    params,
  ));

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
 *
 * The wording carries BOTH directions on purpose, because each guards a different failure.
 *
 * The original text only guarded fabrication: it said to cite "when your answer draws on them" and
 * to ignore irrelevant context, with no instruction to actually USE the passages. That is a
 * permissive framing plus an explicit escape hatch, and the model took the escape. Traced live on
 * 2026-07-31: the standard assistant was handed `employee-directory.json` ranked first at
 * similarity 0.615, with the person's name in the prompt, and still answered "I don't have specific
 * information about the individuals leading...". Every other link (corpus, embeddings,
 * classification scope, ranking, forwarding, injection) was verified working; only the instruction
 * was missing.
 *
 * So the positive directive is now explicit, and the irrelevance escape is KEPT - removing it would
 * trade a refusal problem for a fabrication problem, and the corpus is customer-supplied, so a
 * model that over-trusts retrieved text is also a prompt-injection surface. Changing one direction
 * without the other is how this oscillates.
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

The following passages were retrieved from this deployment's own knowledge base, which the user has access to, based on their message.

If a passage below contains the answer, ANSWER FROM IT and cite it with its bracketed number. Do not say you lack the information when it is present here - these documents are the authoritative source for questions about this organisation, including specific names, figures and dates.

If the passages are irrelevant to what was actually asked, ignore them and answer normally - never fabricate a citation, and never stretch a passage to fit a question it does not answer.

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
