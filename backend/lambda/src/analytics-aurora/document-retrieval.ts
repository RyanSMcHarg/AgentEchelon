/**
 * Document Retrieval — RAG proof-point retriever.
 *
 * Companion to `document-ingestion.ts`. Embeds a query and ranks the `embeddings` table (schema
 * migration 008) two ways in one statement: a pgvector cosine-NN (the vector leg) and a keyword match
 * over the `content_tsv` lexical index (the lexical leg, schema migration 081). Both legs filter by
 * `source_type` and classification metadata. The two rankings are fused by reciprocal rank fusion
 * (`fuseRetrievalLegs`) into the top-K chunks plus citations, in a shape the async processor can fold
 * into the system prompt.
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
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
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
   *
   * It admits a chunk through EITHER leg: a chunk the lexical leg found that also clears this floor is
   * admitted like any other. A lexical hit below it is admitted only on `minLexicalCoverage`.
   */
  minSimilarity?: number;
  /**
   * Minimum lexical coverage (0..1) for a chunk the lexical leg found to be admitted although its
   * cosine similarity is below `minSimilarity`. Coverage is the share of the query's term weight the
   * chunk contains, each term weighted by its rarity in the scoped corpus (see `retrieveContext`).
   * Default 0.5: a lexical-only passage has to carry at least half of what is informative in the
   * question. A chunk that shares only words most chunks contain stays out, which is the same
   * "too tangential to spend prompt budget on" judgment the similarity floor makes.
   */
  minLexicalCoverage?: number;
  /**
   * REQUIRED classification filter — the classifications the caller's classification may reach, as
   * `profiles.grantsFor(classification)`. Restricts chunks to those whose `metadata.classification` is in
   * this list. Implements ADR-007 (KB permission filters).
   *
   * THE GRANT SET, NOT THE RANK LADDER. The reader role this query runs as is scoped by `grantsFor`
   * (`scopeFunctionSql`), and so are the S3 context prefixes (`contextPrefixesGranted`). This filter
   * and the check below compared against `grantsFor`, which is the same list for a pure ladder and
   * a different one for a non-contiguous grant set: the filter then named classifications the role
   * withholds, so the two controls stopped describing one boundary.
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
   * boundary; `classificationScope` above is the query filter, which is defense in depth.
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
  /** Cosine similarity to the query, for every chunk whichever leg found it. */
  similarity: number;
  /**
   * Which retrieval legs admitted this chunk, vector first. Always set by `retrieveContext`; optional
   * so a chunk built elsewhere (a fixture, a cached result) need not invent one.
   */
  foundBy?: RetrievalLeg[];
}

/** The two rankings retrieval fuses. */
export type RetrievalLeg = 'vector' | 'lexical';

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

/** How many candidates each leg contributes to the fusion. Twice the largest topK, so a chunk ranked
 *  moderately by both legs can still outscore one ranked highly by a single leg. */
const CANDIDATES_PER_LEG = 20;
/** The most query terms the lexical leg weighs and matches; each costs one index scan. */
const MAX_QUERY_TERMS = 32;
/** A query term at least this long is matched as a prefix of an indexed token. */
const PREFIX_MIN_CHARS = 4;
/** The most query characters the lexical leg tokenizes (the embedding reads up to 8000). */
const MAX_LEXICAL_QUERY_CHARS = 2000;
/**
 * The reciprocal rank fusion constant. 60 is the value Cormack, Clarke and Buettcher (SIGIR 2009)
 * found robust across collections; it flattens the head of each ranking so that agreement between
 * the legs outweighs a single leg's first place.
 */
export const RRF_K = 60;

interface HybridCandidateRow {
  source_id: string;
  source_type: string;
  title: string | null;
  chunk_index: number | null;
  content: string;
  similarity: number;
  /** 1-based rank in the vector leg's candidates; null when the vector leg did not return the chunk. */
  vector_rank: number | null;
  /** 1-based rank in the lexical leg's candidates; null when the lexical leg did not return the chunk. */
  lexical_rank: number | null;
  /** Share of the query's term weight the chunk contains, 0..1; null when not a lexical candidate. */
  lexical_coverage: number | null;
}

/** One chunk as a candidate for fusion: what each leg said about it. */
export interface RetrievalCandidate {
  chunk: Omit<RetrievedChunk, 'foundBy'>;
  vectorRank: number | null;
  lexicalRank: number | null;
  lexicalCoverage: number | null;
}

/**
 * Fuse the two legs' candidates into the final top-K, by reciprocal rank fusion.
 *
 * ADMISSION, per leg, before any ranking:
 *  - the vector leg admits a chunk whose cosine similarity is at least `minSimilarity` (the floor
 *    retrieval has always applied);
 *  - the lexical leg admits a chunk that clears that same floor, OR whose lexical coverage is at least
 *    `minLexicalCoverage`. The second condition is what lets an exact identifier the embedding
 *    underrates through, and it is a coverage floor rather than "any match" so that a chunk sharing
 *    only common words with the question is still kept out.
 * A chunk neither leg admits is dropped. Ranks are then re-counted among the admitted candidates of
 * each leg, so a dropped chunk does not hold a rank.
 *
 * SCORE: the sum over the legs that admitted the chunk of 1 / (RRF_K + rank). Ranks, not scores, are
 * fused because cosine similarity and the lexical weight are on unrelated scales.
 *
 * ORDER, with ties broken deterministically: higher fused score; then the better vector rank (a chunk
 * the vector leg admitted before one it did not); then the better lexical rank; then source, type and
 * chunk index. Breaking ties on the vector leg first is also what makes an empty lexical leg return
 * exactly the vector leg's order.
 *
 * Pure, so the fusion rule is tested without a database.
 */
export function fuseRetrievalLegs(
  candidates: RetrievalCandidate[],
  opts: { topK: number; minSimilarity: number; minLexicalCoverage: number },
): RetrievedChunk[] {
  const admitted = candidates.map((c) => {
    const passesFloor = c.chunk.similarity >= opts.minSimilarity;
    const vector = c.vectorRank != null && passesFloor;
    const lexical = c.lexicalRank != null
      && (passesFloor || (c.lexicalCoverage ?? 0) >= opts.minLexicalCoverage);
    return { c, vector, lexical };
  }).filter((a) => a.vector || a.lexical);

  // Code-unit order rather than localeCompare, so the tie-break does not depend on the runtime's locale.
  const byCodeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byKey = (x: RetrievalCandidate, y: RetrievalCandidate) =>
    byCodeUnit(x.chunk.sourceId, y.chunk.sourceId)
    || byCodeUnit(x.chunk.sourceType, y.chunk.sourceType)
    || ((x.chunk.chunkIndex ?? -1) - (y.chunk.chunkIndex ?? -1));
  const rankOrLast = (r: number | null) => (r == null ? Number.POSITIVE_INFINITY : r);

  const reRank = (leg: 'vector' | 'lexical'): Map<RetrievalCandidate, number> => {
    const rankOf = (c: RetrievalCandidate) => (leg === 'vector' ? c.vectorRank : c.lexicalRank);
    const inLeg = admitted.filter((a) => a[leg]).map((a) => a.c);
    inLeg.sort((x, y) => (rankOrLast(rankOf(x)) - rankOrLast(rankOf(y))) || byKey(x, y));
    return new Map(inLeg.map((c, i) => [c, i + 1]));
  };
  const vectorRanks = reRank('vector');
  const lexicalRanks = reRank('lexical');

  const scored = admitted.map(({ c }) => {
    const vr = vectorRanks.get(c) ?? null;
    const lr = lexicalRanks.get(c) ?? null;
    const score = (vr != null ? 1 / (RRF_K + vr) : 0) + (lr != null ? 1 / (RRF_K + lr) : 0);
    const foundBy: RetrievalLeg[] = [];
    if (vr != null) foundBy.push('vector');
    if (lr != null) foundBy.push('lexical');
    return { c, vr, lr, score, foundBy };
  });

  scored.sort((a, b) =>
    (b.score - a.score)
    || (rankOrLast(a.vr) - rankOrLast(b.vr))
    || (rankOrLast(a.lr) - rankOrLast(b.lr))
    || byKey(a.c, b.c));

  return scored.slice(0, opts.topK).map((s) => ({ ...s.c.chunk, foundBy: s.foundBy }));
}

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
      + 'classification-scoped (ADR-007) and will not run unscoped. Pass profiles.grantsFor(classification).',
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
  const expectedScope = profiles.grantsFor(input.classification);
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
  const minLexicalCoverage = input.minLexicalCoverage ?? 0.5;
  const sourceTypes = input.sourceTypes ?? ['wiki', 'doc'];

  // Embed the query.
  const queryEmbedding = await embedQuery(text);
  if (!queryEmbedding) {
    return { chunks: [], citations: [], signalAvailable: false };
  }

  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  // FAIL-CLOSED classification gate: a chunk is returned only if its `metadata.classification` is in
  // the caller's scope (what their classification grants). An untagged chunk is NOT returned — the
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
  //
  // EVERY READ OF `embeddings` IN THE STATEMENT BELOW CARRIES IT: both legs, the corpus count and the
  // per-term document counts the lexical weights come from, and the final fetch. A term weight computed
  // over chunks the caller cannot read would leak how often a word occurs at another classification.
  const scopeFilter = (alias: string) =>
    `${alias}source_type = ANY($2::text[]) AND ${alias}metadata->>'classification' = ANY($3::text[])`;
  const params: unknown[] = [vectorLiteral, sourceTypes, input.classificationScope, text.slice(0, MAX_LEXICAL_QUERY_CHARS)];

  // ADR-028: the query runs as this classification's READER ROLE, not as the shared owner. Row-level
  // security admits only rows at or below that role's ladder, so the clause above becomes defense in
  // depth rather than the boundary itself - if it were deleted tomorrow, this query would still not
  // see a premium chunk on a basic turn.
  //
  // It goes through `withReaderRole` (which uses `transaction()` + `SET LOCAL ROLE`) rather than the
  // pooled `query()` for a specific reason: `query()` opens no transaction, and a bare `SET ROLE`
  // there would persist on the pooled connection into the NEXT invocation - possibly a different
  // classification - which is the leak this control exists to prevent.
  //
  // ONE STATEMENT, BOTH LEGS. The two rankings are CTEs of a single query, so hybrid retrieval costs
  // the same one round trip under the same role that vector-only retrieval did.
  //
  //  - vector_leg: pgvector cosine-distance NN. `<=>` is the cosine-distance operator; similarity =
  //    1 - distance. Filtered by source_type and scope at SQL level (not post-filter), ordered by
  //    distance with a LIMIT so the HNSW index serves it.
  //  - query_terms: the query tokenized by the SAME parser and configuration as `content_tsv`
  //    (`to_tsvector('simple', ...)`), so a term means exactly what the index means by it. A term of
  //    PREFIX_MIN_CHARS or more is matched as a prefix (`persona:*` reaches `personaref`); a shorter one
  //    exactly, because a one- or two-character prefix matches nearly everything. A lexeme carrying a
  //    quote or a backslash is skipped rather than escaped into tsquery syntax. At most MAX_QUERY_TERMS
  //    terms, the longest first, so a pasted page cannot turn one retrieval into hundreds of index scans.
  //  - term_weights: each term weighted by its rarity in the caller's scoped corpus, the BM25 inverse
  //    document frequency ln(1 + (N - df + 0.5) / (df + 0.5)). This is what keeps "the", "de"
  //    and every other common word from ranking a chunk, without a stop-word list chosen for one
  //    language: a word most chunks contain weighs almost nothing in any language. A term no chunk
  //    contains keeps the full weight, so a question about something absent cannot be carried by its
  //    common words.
  //  - lexical_leg: chunks matching any term, scored by the summed weight of the terms they contain.
  //    `lexical_coverage` is that score over the summed weight of every query term, 0..1.
  const result = await withReaderRole(input.classification, (client) => client.query<HybridCandidateRow>(
    `WITH vector_leg AS (
       SELECT id, (row_number() OVER (ORDER BY distance, id))::int AS vector_rank
         FROM (SELECT id, embedding <=> $1::vector AS distance
                 FROM embeddings
                WHERE ${scopeFilter('')}
                ORDER BY embedding <=> $1::vector
                LIMIT ${CANDIDATES_PER_LEG}) nearest
     ),
     query_terms AS (
       SELECT chr(39) || lexeme || chr(39)
                || CASE WHEN char_length(lexeme) >= ${PREFIX_MIN_CHARS} THEN ':*' ELSE '' END AS term
         FROM unnest(tsvector_to_array(to_tsvector('simple'::regconfig, $4::text))) AS lexeme
        WHERE strpos(lexeme, chr(39)) = 0 AND strpos(lexeme, chr(92)) = 0
        ORDER BY char_length(lexeme) DESC, lexeme
        LIMIT ${MAX_QUERY_TERMS}
     ),
     scoped_corpus AS (
       SELECT count(*)::float8 AS n
         FROM embeddings
        WHERE ${scopeFilter('')}
     ),
     term_weights AS (
       SELECT to_tsquery('simple'::regconfig, t.term) AS tq,
              ln(1 + (c.n - d.df + 0.5) / (d.df + 0.5)) AS weight
         FROM query_terms t
         CROSS JOIN scoped_corpus c
         CROSS JOIN LATERAL (
           SELECT count(*)::float8 AS df
             FROM embeddings
            WHERE content_tsv @@ to_tsquery('simple'::regconfig, t.term)
              AND ${scopeFilter('')}
         ) d
     ),
     lexical_leg AS (
       SELECT id,
              lexical_score / NULLIF((SELECT sum(weight) FROM term_weights), 0) AS lexical_coverage,
              (row_number() OVER (ORDER BY lexical_score DESC, id))::int AS lexical_rank
         FROM (SELECT m.id,
                      (SELECT sum(w.weight) FROM term_weights w WHERE m.content_tsv @@ w.tq) AS lexical_score
                 FROM embeddings m
                WHERE m.content_tsv @@ (SELECT to_tsquery('simple'::regconfig, string_agg(term, ' | ')) FROM query_terms)
                  AND ${scopeFilter('m.')}
                ORDER BY lexical_score DESC, m.id
                LIMIT ${CANDIDATES_PER_LEG}) matched
     )
     SELECT e.source_id,
            e.source_type,
            e.title,
            e.chunk_index,
            e.content,
            1 - (e.embedding <=> $1::vector) AS similarity,
            v.vector_rank,
            l.lexical_rank,
            l.lexical_coverage
       FROM (SELECT id FROM vector_leg UNION SELECT id FROM lexical_leg) candidate
       JOIN embeddings e ON e.id = candidate.id
       LEFT JOIN vector_leg v ON v.id = candidate.id
       LEFT JOIN lexical_leg l ON l.id = candidate.id
      WHERE ${scopeFilter('e.')}`,
    params,
  ));

  const chunks: RetrievedChunk[] = fuseRetrievalLegs(
    result.rows.map((r) => ({
      chunk: {
        sourceId: r.source_id,
        sourceType: r.source_type,
        title: r.title,
        chunkIndex: r.chunk_index,
        content: r.content,
        similarity: r.similarity,
      },
      vectorRank: r.vector_rank,
      lexicalRank: r.lexical_rank,
      lexicalCoverage: r.lexical_coverage,
    })),
    { topK, minSimilarity: minSim, minLexicalCoverage },
  );

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
