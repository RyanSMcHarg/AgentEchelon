# RAG - Document Retrieval

**Audience:** deployers who want the assistant to ground its responses in project documentation (wiki pages, runbooks, design docs) rather than just the LLM's training data.

**Scope:** Ingestion, retrieval, and citation injection are end-to-end. Frontend rendering of citation markers is out of scope; citations land as `[1]`, `[2]` markers in the assistant's response text plus a Sources block at the end.

## Scope boundaries

**Is:** hybrid retrieval of project-supplied documents at inference time. Drop markdown / text files into an S3 prefix; the next user turn embeds the query, ranks chunks both by meaning (pgvector similarity) and by the words they share with the query (a lexical index), fuses the two rankings into the top-K, and the assistant answers with those chunks in the system prompt + numbered citations.

**Isn't:** a chat-with-your-knowledge-base product. There is no admin UI for managing the corpus (drop files in S3; the ingestor handles the rest), and no multi-corpus / per-channel knowledge base. There is no Bedrock Knowledge Base wrapper: retrieval is a direct pgvector and Postgres full-text implementation that reuses the Aurora cluster already provisioned for drift detection and cross-conversation context.

## Architecture

```
S3 bucket: rag/<source_type>/<classification>/<file>   ← deployer uploads here
              │
              ▼  ObjectCreated / ObjectRemoved event (prefix-filtered)
       ┌─────────────────────┐
       │ DocumentIngestion   │  ← chunks, embeds via Titan v2, writes
       │ Lambda (VPC, Aurora)│    to embeddings table; idempotent on
       └─────────────────────┘    S3 ETag; a delete removes the chunks
              │
              ▼
       ┌─────────────────────┐
       │ embeddings table    │  ← vector(1024) + HNSW cosine index,
       │ (Aurora pgvector)   │    content_tsv + GIN lexical index,
       └─────────────────────┘    FORCE ROW LEVEL SECURITY
              ▲
              │  cosine NN + lexical match at query time, as the classification's reader role
       ┌─────────────────────┐
       │ Retrieval Data-Plane│  ← embeds the query, retrieves top-K; also
       │ Lambda (VPC, Aurora)│    runs drift detection. The ONLY component
       └─────────────────────┘    on the Aurora/VPC path.
              ▲
              │  synchronous invoke (RequestResponse)
       ┌─────────────────────┐
       │ Async Processor     │  ← NON-VPC. Invokes the data-plane Lambda for
       │ (per classification)│    { chunks, citations }, then
       └─────────────────────┘    buildRetrievedContextHint folds them into
                                  the system prompt before invoking the LLM
```

**Retrieval caller.** The retrieval caller is the PROCESSOR, not the router. Both are non-VPC and both reach Aurora through the same client seam. The processor holds the channel, the classification, the intent and the message, and runs after the first frame is already up, so retrieval stays outside time-to-first-frame (`backend/lambda/src/lib/turn-grounding.ts`). The router invokes the data-plane Lambda only for drift detection, which is a decision it makes itself.

**Execution model (ADR-013).** Retrieval and drift detection both need Aurora (pgvector) and Bedrock (embeddings), so both run inside a dedicated VPC-attached **data-plane Lambda**. The router and the processor stay **non-VPC** and invoke that Lambda synchronously. This keeps the callers off the VPC path, where they would otherwise hang on SSM, Cognito, and Lambda-invoke calls that have no endpoint in the isolated subnets. The data-plane Lambda connects to the Aurora cluster writer endpoint with IAM auth; RDS Proxy is opt-in (`-c enableRdsProxy=true`, default off in `archive-stack-aurora.ts`). Its Bedrock and Secrets Manager calls use endpoints the Aurora stack already provisions, so it adds **no new VPC endpoints**.

The Aurora cluster, the Titan v2 embedding model, the pgvector extension, and the HNSW index are all **shared with drift detection**. RAG adds effectively zero incremental infrastructure cost: just the per-call Titan embed (about $0.0001 per turn) and one warm Lambda hop. Full per-piece figures are in [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md).

## Source of truth

| File | Role |
|---|---|
| `backend/lambda/src/analytics-aurora/schema/008-document-embeddings.sql` | Schema migration: 1024-dim embeddings + RAG columns + unique idempotency index |
| `backend/lambda/src/analytics-aurora/schema/081-a-passage-is-found-by-its-words.sql` | Schema migration: the generated `content_tsv` lexical column (`simple` configuration) + its GIN index |
| `backend/lambda/src/analytics-aurora/document-ingestion.ts` | S3 → chunk → embed → INSERT Lambda; stamps the classification (`deriveContentClassification`) |
| `backend/lambda/src/analytics-aurora/document-retrieval.ts` | Query embed + hybrid retrieval (vector and lexical legs in one statement, fused by `fuseRetrievalLegs`) + citation packaging, run as the classification's reader role (`withReaderRole`) in the data-plane Lambda |
| `backend/lambda/src/analytics-aurora/classification-boundary-sql.ts` | The per-classification reader roles and the row-level security policies, generated from the declared grants (`boundaryStatements`) |
| `backend/lambda/src/analytics-aurora/data-plane-handler.ts` | The data-plane Lambda: dispatches retrieval + drift + summary and the other data-plane ops (ADR-013) |
| `backend/lambda/src/lib/data-plane-client.ts` | Non-VPC client seam: same function signatures, implemented as a synchronous invoke of the data-plane Lambda |
| `backend/lambda/src/lib/turn-grounding.ts` | The gates and the corpus list (`RAG_SOURCE_TYPES`); resolves retrieval + the running summary together |
| `backend/lambda/src/assistant-async-processor.ts` | Call site - invokes the data-plane Lambda for retrieval and folds the result into the system prompt (every profile, via the shared processor code) |
| `backend/lib/stacks/archive-stack-aurora.ts` | CDK wiring (Lambda + IAM + S3 notification) |

## Prerequisites

1. **Aurora mode deployed.** `analyticsMode: "aurora"` in `backend/deploy.config.json`, deployed with `cd backend && npm run deploy`. The Aurora cluster, the embeddings table, and the ingestion Lambda all live in the `<prefix>Archive` stack (`AgentEchelonArchive` for the default instance name; the prefix follows `AE_INSTANCE_NAME`, see `STACK_PREFIX` in `backend/lib/stacks/agent-classification-common.ts`).
2. **Live drift enabled.** `enableLiveDrift: true` (default false; see `backend/deploy.config.example.json`). RAG and drift share the same gate: both run in the retrieval data-plane Lambda, which the processor (retrieval) and the router (drift) invoke. Neither caller is VPC-attached (ADR-013). Without the flag, `turn-grounding.ts` returns no retrieval.
3. **Schema migration 008 applied.** The schema-init custom resource runs migrations on stack create, and later migrations auto-apply at runtime via `db-client.ensureSchema` (any unapplied `schema/*.sql` lands on an existing cluster with no manual step; see [`LATENCY-TARGETS.md`](LATENCY-TARGETS.md)). Verify by querying `information_schema.columns` for `embeddings.chunk_index`.
4. **Bedrock model access for Titan v2.** `amazon.titan-embed-text-v2:0` (drift detection already requires this).

## Uploading a corpus

Find your archive bucket name (CDK output `ArchiveBucketName` from the `<prefix>Archive` stack), then:

```bash
# wiki/ as the source_type - anything you upload under rag/wiki/ is
# stored with source_type='wiki'; the first path segment under rag/ is
# the type, and retrieval reads only wiki, doc, company and agentechelon.
# The NEXT segment is the classification: omitting it stamps the content
# with the fail-closed default (premium in the sample config). In the
# sample config every conversational classification grants basic, so
# content for everyone goes under basic/ as shown here.
aws s3 cp ./local-docs/ s3://<archive-bucket>/rag/wiki/basic/ --recursive \
  --exclude "*" --include "*.md" --include "*.txt" --include "*.html"
```

**Retrieval reads four prefixes only:** `rag/wiki/`, `rag/doc/`, `rag/company/` and `rag/agentechelon/` (`RAG_SOURCE_TYPES` in `backend/lambda/src/lib/turn-grounding.ts`). A file directly under `rag/` with no type segment is stored as `doc` (`deriveSourceType` in `document-ingestion.ts`) and is retrieved. Content under any other prefix, such as `rag/runbooks/`, `rag/faq/` or `rag/docs/`, is ingested and embedded but never retrieved, and nothing errors or warns. **NOT BUILT:** retrieval of other prefixes, or a refusal at ingest of a prefix retrieval does not read. A new corpus type is added to `RAG_SOURCE_TYPES`.

Supported file types: `.md`, `.markdown`, `.txt`, `.json`, `.html`, `.htm`. Binary formats (PDF, DOCX, images) need an extraction pipeline (Textract, pdf-parse, etc.) and are **NOT BUILT**.

Per file:
- Chunked at ~1800 chars with ~200-char overlap, prefers paragraph (`\n\n`) boundaries
- First H1 line becomes the chunk title for citations (falls back to filename)
- Max 200 chunks per document - a hard cap to avoid runaway ingestion costs on a stray giant file

**Idempotency:** the ingestor records the S3 ETag with each chunk. Re-uploading the same file is a no-op; uploading a modified version (ETag changes) clears the prior chunks and re-embeds. Safe to re-run the same `aws s3 cp` repeatedly.

**A failed ingest is retried, then kept.** The S3 notification invokes the ingestor asynchronously. A record that fails (the read or a write threw, or no chunk embedded) fails the invocation after the event's other records are processed, so Lambda retries it twice within a six-hour event age, and an event still failing after that lands in the `DocumentIngestionDlq` queue (kept fourteen days) and fires the `<prefix>Archive-document-ingestion-failed` alarm (`DOCUMENT_INGESTION_RETRY` in `archive-stack-aurora.ts`). The retries are safe because an ingest is idempotent on the ETag. The queued event holds the S3 records it carried; re-putting the object (or re-running `npm run sync-knowledge:rag` for the platform corpus) ingests it.

### Seeded corpora

A demo deployment has two corpora, uploaded by different things; only one is automatic:

| Corpus | Prefix | Uploaded by | Answers |
|---|---|---|---|
| **Company** (the Stratum demo docs) | `rag/company/{classification}/` | `seed-demo.ts`, automatically, in Aurora mode | "what is our refund policy?" |
| **Platform** (this repo's own docs) | `rag/agentechelon/standard/` | **you**, via `npm run sync-knowledge:rag` | "how does AgentEchelon do X?" |

The platform corpus is generated from the `docs/` tree, which a deployed instance does not have, so it is a **deploy-time step an operator runs** rather than something the seed can do. Run it after the deploy and again whenever the docs change. `validate` runs it as its `knowledge-rag` phase. It is stamped `standard`, because the platform's documentation is internal material: row-level security admits its chunks only for a classification that grants `standard` (standard and premium in the sample config), so a basic conversation never retrieves it. The same run deletes every key under the retired `rag/agentechelon/basic/` prefix, and each delete event removes that object's chunks.

**Skipping it is silent.** The assistant still answers platform questions - from the curated index (`platform-knowledge/standard/agentechelon-about.json`, a title plus a ~400-character summary per doc, read through the `load_platform_info` tool), which `seed-demo` does upload. A basic conversation reads only `platform-knowledge/basic/agentechelon-about.json`, a public overview with no document index, so a short answer there is by design and not this symptom. So the symptom is a vague-but-confident answer, not an error or an empty result. If platform answers read as thin, check this prefix before anything else:

```bash
aws s3 ls s3://<archive-bucket>/rag/agentechelon/ --recursive | wc -l   # 0 ⇒ never uploaded
cd backend && node scripts/sync-project-knowledge.mjs --rag --dry-run   # the keys the database holds no chunks for
```

**What the sync puts.** An uploaded object is not an ingested one: the ingest runs after the put returns, and one that timed out leaves the object in S3 with no chunks. So the sync asks the database which keys hold chunks, through the data plane's `ragSourceCoverage` op (`backend/lambda/src/analytics-aurora/rag-coverage.ts`, read as the write role, identifiers and counts only), and puts a key when it is new, when its content changed (each upload carries a `content-sha256` metadata value the next run compares), or when the database holds no chunks for it or holds them at another ETag. Re-putting such a key re-fires the S3 event that ingests it. An unchanged key the database already holds is not put, so a run does not re-ingest the corpus. When the database cannot be asked, every key is put. The decisions are `planRagSync` in `backend/scripts/lib/rag-sync-plan.cjs`.

| Flag | Effect |
|---|---|
| `--rag` | upload the corpus as above |
| `--rag --dry-run` | write nothing to S3; list each key it would put and why (`new`, `changed`, `no-chunks`, `stale-chunks`, `coverage-unknown`), and each key it would delete |
| `--rag --verify` | after the puts, read the database every 15 seconds until every synced key holds chunks at the ETag S3 holds for it, and exit 1 naming the keys that do not within `--verify-timeout=<seconds>` (default 600) |

The `knowledge-rag` validate phase runs `--rag --verify`, so a corpus that did not ingest fails the phase rather than passing on the uploads. The ingestor emits no completion signal the sync could subscribe to, so `--verify` reads the database on a bounded interval; it runs in the operator's sync, not in the platform.

## Inference-time flow

When `enableLiveDrift=true` (and the corpus has content), every non-trivial user message (skips GREETING/ACKNOWLEDGMENT) triggers:

1. **Async processor** invokes the **data-plane Lambda**, which embeds the user message via Titan v2 (~100-300ms warm). Started at the top of the handler, so it runs while the placeholder is still being resolved
2. Runs one statement as the serving classification's reader role against `embeddings WHERE source_type IN ('wiki', 'doc', 'company', 'agentechelon') AND <classification filter>`, with two legs: a pgvector cosine-NN and a lexical match over `content_tsv`, 20 candidates each (see [Ranking](#ranking-hybrid-retrieval))
3. Admits a candidate whose similarity is at least 0.35, or a lexical candidate that carries at least half of the query's term weight, fuses the two rankings by reciprocal rank fusion, and keeps the top-K (the caller configures 6; 4 is only the retrieval helper's default). Honest empty if nothing is admitted
4. Deduplicates citations by `source_id` - multiple chunks from the same file share one citation number
5. The processor calls `buildRetrievedContextHint`, folding the result into the system prompt as a `## RETRIEVED CONTEXT` section with `[1]`, `[2]` markers + a Sources block at the end
6. The LLM responds, optionally referencing the markers (`"the deploy script handles this [1]"`); the markers map to source identifiers the user can resolve

## Ranking: hybrid retrieval

Embedding similarity ranks a chunk by what it is about, and a question's embedding does not reliably rank the chunk that carries its decisive term: an identifier such as `personaRef`, a file name, a product term. Measured on 2026-10-23, a question about where an exported profile's persona text is stored ranked six passages from the right documents and none of the chunks naming `personaRef` and the body store. So retrieval ranks twice and fuses the rankings (`retrieveContext` and `fuseRetrievalLegs` in `document-retrieval.ts`).

**The lexical index.** `content_tsv` is a generated `tsvector` column, `to_tsvector('simple', content)`, with a GIN index (schema 081). Being generated, it exists for every row, both the rows present when the migration ran and every row ingestion writes later; ingestion does not write it. The `simple` configuration lowercases tokens and does nothing else: no stemming and no stop-word list, so the index favors no single language. An identifier written as one alphanumeric run stays one token (`personaRef` is indexed as `personaref`). `pg_trgm` was the alternative and is not used: trigram similarity suits a short value against short values, and against a multi-word question and chunks of several hundred words it is dominated by length and has no notion of a rare term.

**The lexical leg.** The query is tokenized by the same parser and configuration as the index, so a term means what the index means by it. A term of four or more characters matches as a prefix (`persona` reaches `personaref`), a shorter one exactly; at most 32 terms are used, the longest first. Each term is weighted by its rarity in the caller's scoped corpus, the BM25 inverse document frequency `ln(1 + (N - df + 0.5) / (df + 0.5))`, so a word most chunks contain weighs almost nothing in any language. A chunk's lexical score is the summed weight of the terms it contains, and its **coverage** is that score over the summed weight of every query term (a term no chunk contains keeps full weight, so a question about something absent is not carried by its common words). Languages written without spaces between words tokenize into long runs that rarely match; for them the vector leg carries retrieval.

**Admission.** The vector leg admits a chunk whose cosine similarity is at least `minSimilarity` (0.35). The lexical leg admits a chunk that clears the same floor, or whose coverage is at least `minLexicalCoverage` (0.5). A chunk neither leg admits is dropped. Every returned chunk reports its real cosine similarity, including one only the lexical leg admitted, so the Sources line shows what the embedding thought of it.

**Fusion.** Reciprocal rank fusion: each admitted chunk scores the sum over the legs that admitted it of `1 / (60 + rank)`, ranks re-counted among admitted candidates. Ranks are fused rather than scores because cosine similarity and lexical weight are on unrelated scales. Ties break on the better vector rank, then the better lexical rank, then source, type and chunk index, so the order is deterministic and an empty lexical leg returns exactly the vector order.

**What the turn records.** Each chunk carries `foundBy` (`vector`, `lexical`, or both), and the persisted `retrievedPassages` record in message analytics carries it alongside `sourceId`, `title` and `content`.

**Cost.** Both legs are CTEs of one statement, so retrieval is still one round trip under one role. The lexical leg adds one GIN lookup per query term for the document counts, a count of the scoped corpus, and a GIN lookup for the matching chunks.

## Classification scoping

Documents are visibility-scoped by classification. Ingestion stamps `metadata.classification` from the S3 path: `rag/{source_type}/{classification}/…` where `{classification}` is any conversational classification the deployment declares (schema 020 names the isolation key `classification`). Content with no classification segment is stamped by `deriveContentClassification` (`document-ingestion.ts`): `RAG_DEFAULT_CLASSIFICATION` if it names a conversational classification, otherwise the conversational classification the fewest holders reach (`failClosedContentValue` in `backend/lib/profile-registry.ts`). In the sample config that is `premium`, so untagged content is withheld from basic and standard.

**Scope at the retriever.** A turn's retrieval scope is the serving classification's declared grant set, `profiles.grantsFor(classification)` (`maybeRetrieveContext` in `turn-grounding.ts`). A chunk is returned only if its classification is in that set. In the sample config, where basic is granted by standard and both by premium:
- **basic** retrieves only `basic` chunks
- **standard** retrieves `basic` and `standard`
- **premium** retrieves `basic`, `standard` and `premium`

A deployment that declares its classifications as peers gets exactly what each declares, with no inheritance.

**Two database layers.** The gate is fail-closed and held twice ([ADR-028](../../design/decisions/028-vector-store-classification-boundary.md)):
- The query runs as the serving classification's **reader role** (`withReaderRole` in `classification-boundary.ts`, called by `document-retrieval.ts`; `SET LOCAL ROLE` inside a transaction so the role cannot persist on a pooled connection). The `embeddings` table is under `FORCE ROW LEVEL SECURITY`, with one read policy per table that admits a row only when its classification is in the current reader role's declared grants (`ae_classification_scope`, generated by `scopeFunctionSql`; `boundaryStatements` in `classification-boundary-sql.ts`). Retrieval rejects a scope that differs from the classification's grants.
- The SQL `WHERE` clause also filters `metadata->>'classification' = ANY(scope)`, applied inside the query (not as a post-filter) so the HNSW index can prune correctly. It is on every read of `embeddings` in the statement: both legs, the corpus count and per-term document counts the lexical weights come from, and the final fetch, so a term weight is never computed over chunks the caller cannot read.

Chunks with no classification key (rows written before ingestion stamped it) are not returned; re-put the S3 object under `rag/` to re-ingest and make them visible.

## Failure modes

All best-effort. Any failure logs and lets the assistant reply without RAG context for that turn:

- **No Aurora deployed, or `enableLiveDrift` off** → no data-plane Lambda ARN wired to the processor; retrieval skips entirely
- **Embedding call fails** (Titan throttle, timeout, etc.) → `signalAvailable: false`, log warning
- **No chunk admitted by either leg** → `chunks: []`, no hint added to prompt
- **One chunk fails to embed during ingestion** → that chunk skipped; rest of document continues
- **A whole object fails to ingest** (the read or a write threw, no chunk embedded, or the function timed out) → the invocation fails and is retried; once the retries are spent the event is kept in `DocumentIngestionDlq` and its alarm fires. The next sync re-puts the key, because the database holds no chunks for it

Honest-empty contract throughout: the assistant never fabricates a citation and never returns a "no results found" non-answer when retrieval misses. It answers without retrieved context.

## Cost picture

| Component | Cost |
|---|---|
| Aurora cluster | $0 incremental; shared with drift / cross-conv / eval. |
| Titan v2 embedding (query) | ~$0.0001 per turn (~30 tokens at $0.00002/1K) |
| Titan v2 embedding (ingestion) | ~$0.0001 per chunk; a 200-chunk doc = ~$0.02 one-time |
| pgvector storage | ~4 KB raw per chunk + ~2x HNSW overhead; 10K chunks ≈ 120 MB |
| Data-plane Lambda | ~100-500ms per turn for the embed + DB query, plus one warm invoke hop (~10-50ms); under $1/mo of invocations |
| New VPC endpoints | $0 - the data-plane Lambda reuses the Aurora stack's existing Bedrock + Secrets Manager endpoints |

The dominant cost line is Titan embedding calls. At ~10K turns/day, query-side embedding = $1/day. Ingestion is one-time per document upload. Full per-piece infrastructure costs are in [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md).

## Common operations

**Re-ingest a single file** (e.g. after editing):
```bash
aws s3 cp ./updated-doc.md s3://<archive-bucket>/rag/wiki/basic/updated-doc.md
# The ETag changes; the ingestor clears prior chunks + re-embeds.
```

**Delete a document from the corpus:**
```bash
aws s3 rm s3://<archive-bucket>/rag/wiki/basic/old-doc.md
# The ObjectRemoved event reaches the ingestor, which deletes the
# object's rows from the embeddings table (removeObjectChunks in
# document-ingestion.ts) as the classification writer role.
```

**Verify corpus contents:**
```bash
# The platform corpus: the keys the database holds no chunks for, without writing anything
cd backend && node scripts/sync-project-knowledge.mjs --rag --dry-run
# Via the analytics-query API (if exposed) - count chunks per source_type
# Or via psql with IAM auth against the cluster writer endpoint
# (or the RDS Proxy endpoint when -c enableRdsProxy=true). The table is
# under FORCE ROW LEVEL SECURITY, so connect as a role a policy admits.
SELECT source_type, COUNT(DISTINCT source_id) AS docs, COUNT(*) AS chunks
FROM embeddings WHERE source_type IN ('wiki', 'doc', 'company', 'agentechelon')
GROUP BY source_type;
```

**Tune the similarity threshold:** `retrieveContext` (`document-retrieval.ts`) defaults to `minSimilarity: 0.35`, and the one call site, `maybeRetrieveContext` in `turn-grounding.ts` (run by the processor), does not pass it. To change it, pass `minSimilarity` in that call: lower is more permissive (more chunks, possibly less relevant), higher is more selective. `minLexicalCoverage` (default 0.5) is the matching knob for chunks only the lexical leg admits. There is no deploy-time setting for either.

## Not included

- Frontend rendering of citation markers (**NOT BUILT**) - `[1]` lands as plain text in the assistant reply. Parsing the trailing Sources block into hoverable / clickable references is not included.
- Multi-corpus per channel (**NOT BUILT**): every channel retrieves from the global corpus, within its classification's grants. The retrieval helper's `sourceTypes` parameter is the seam to extend along.
- PDF / DOCX / image ingestion (**NOT BUILT**) - requires an extraction pipeline (Textract is the AWS-native fit).
- Model re-ranking (**NOT BUILT**) - top-K is the reciprocal rank fusion of the vector and lexical legs; no model re-scores it. A cross-encoder re-ranker would improve precision but adds a second model call.
- Lexical-only retrieval when the query embedding fails (**NOT BUILT**) - an embedding failure returns `signalAvailable: false` and no chunks, although the lexical leg alone could still answer.

## See also

- [SPEC-DRIFT-CONVERGENCE.md](../../specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md) - drift detection, shares the Aurora pgvector cluster
- [AURORA-MODE-GUIDE.md](../admin/AURORA-MODE-GUIDE.md) - Aurora mode setup + cost detail
- [INFRASTRUCTURE-COST.md](../admin/INFRASTRUCTURE-COST.md) - per-piece infrastructure cost model, including the data-plane Lambda
- [ADR-013](../../design/decisions/013-drift-retrieval-vs-decision.md) (retrieval and drift data-plane Lambda) - the execution model and why the callers stay non-VPC
- [ADR-028](../../design/decisions/028-vector-store-classification-boundary.md) - the reader roles and row-level security on the vector store
