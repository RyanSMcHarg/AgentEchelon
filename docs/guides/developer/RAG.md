# RAG - Document Retrieval

**Audience:** deployers who want the agent to ground its responses in project documentation (wiki pages, runbooks, design docs) rather than just the LLM's training data.

**Scope:** Ingestion, retrieval, and citation injection are end-to-end. Frontend rendering of citation markers is out of scope; citations land as `[1]`, `[2]` markers in the bot's response text plus a Sources block at the end.

## What this is, and what it isn't

**Is:** semantic retrieval of project-supplied documents at inference time. Drop markdown / text files into an S3 prefix; the next user turn embeds the query, finds the top-K most-similar chunks, and the agent answers with those chunks in the system prompt + numbered citations.

**Isn't:** a chat-with-your-knowledge-base product. There's no admin UI for managing the corpus (drop files in S3; the ingestor handles the rest). There's no multi-corpus / per-channel knowledge base. There's no Bedrock Knowledge Base wrapper; at ~$175-345/mo for OpenSearch Serverless alone it costs too much. This is a direct pgvector implementation that reuses the Aurora cluster already provisioned for drift detection and cross-conversation context.

## Architecture

```
S3 bucket: rag/<source_type>/<file>            ← deployer uploads here
              │
              ▼  PutObject event (prefix-filtered)
       ┌─────────────────────┐
       │ DocumentIngestion   │  ← chunks, embeds via Titan v2, writes
       │ Lambda (VPC, Aurora)│    to embeddings table; idempotent on
       └─────────────────────┘    S3 ETag
              │
              ▼
       ┌─────────────────────┐
       │ embeddings table    │  ← vector(1024), HNSW cosine index
       │ (Aurora pgvector)   │
       └─────────────────────┘
              ▲
              │  cosine NN at query time
       ┌─────────────────────┐
       │ Retrieval Data-Plane│  ← embeds the query, retrieves top-K; also
       │ Lambda (VPC, Aurora)│    runs drift detection. The ONLY component
       └─────────────────────┘    on the Aurora/VPC path.
              ▲
              │  synchronous invoke (RequestResponse)
       ┌─────────────────────┐
       │ Router Agent Handler│  ← NON-VPC. Invokes the data-plane Lambda,
       │ (non-VPC)           │    attaches { chunks, citations } to the
       └─────────────────────┘    InvokeAsync payload
              │
              ▼
       ┌─────────────────────┐
       │ Async Processor     │  ← buildRetrievedContextHint folds chunks
       │ (shared)            │    + citations into the system prompt
       └─────────────────────┘    before invoking the LLM
```

**Execution model (project decision 018).** Retrieval and drift detection both need Aurora (pgvector) and Bedrock (embeddings), so both run inside a dedicated VPC-attached **data-plane Lambda**. The router agent handler stays **non-VPC** and invokes that Lambda synchronously. This keeps the Lex-facing handler off the VPC path, where it would otherwise hang on SSM, Cognito, and Lambda-invoke calls that have no endpoint in the isolated subnets. The data-plane Lambda's own dependencies (Bedrock embed, Secrets, the in-VPC Aurora proxy) are all covered by existing endpoints, so it adds **no new VPC endpoints**.

The Aurora cluster, the Titan v2 embedding model, the pgvector extension, and the HNSW index are all **shared with drift detection**. RAG adds effectively zero incremental infrastructure cost: just the per-call Titan embed (about $0.0001 per turn) and one warm Lambda hop. Full per-piece figures are in [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md).

## Source of truth

| File | Role |
|---|---|
| `backend/lambda/src/analytics-aurora/schema/008-document-embeddings.sql` | Schema migration: 1024-dim embeddings + RAG columns + unique idempotency index |
| `backend/lambda/src/analytics-aurora/document-ingestion.ts` | S3 → chunk → embed → INSERT Lambda |
| `backend/lambda/src/analytics-aurora/document-retrieval.ts` | Query embed + cosine NN + citation packaging (runs in the data-plane Lambda) |
| `backend/lambda/src/analytics-aurora/data-plane-handler.ts` | Retrieval/drift data-plane Lambda: dispatches `retrieve`, `detectDrift`, `recordDriftFire`, `recordDriftOutcome` (project decision 018) |
| `backend/lambda/src/lib/data-plane-client.ts` | Non-VPC client seam: same function signatures, implemented as a synchronous invoke of the data-plane Lambda |
| `backend/lambda/src/router-agent-handler.ts` | Call site - invokes the data-plane Lambda for retrieval, attaches result to InvokeAsync payload |
| `backend/lambda/src/assistant-async-processor.ts` | Receiver - folds the retrieved context into the system prompt (every profile, via the shared processor) |
| `backend/lib/stacks/analytics-stack-aurora.ts` | CDK wiring (Lambda + IAM + S3 notification) |

## Prerequisites

1. **Aurora mode deployed.** `--context analyticsMode=aurora` at deploy time. The Aurora cluster, the embeddings table, and the ingestion Lambda all live in `AgentEchelonAnalyticsAurora`.
2. **Live drift enabled.** `--context enableLiveDrift=true`. RAG and drift share the same gate: both run in the retrieval data-plane Lambda, which the router invokes. The router itself is not VPC-attached (project decision 018).
3. **Schema migration 008 applied.** The schema-init custom resource runs migrations on stack create; verify by querying `information_schema.columns` for `embeddings.chunk_index`.
4. **Bedrock model access for Titan v2.** `amazon.titan-embed-text-v2:0` in `us-east-1` (drift detection already requires this).

## Uploading a corpus

Find your archive bucket name (CDK output `ArchiveBucketName` from `AgentEchelonAnalyticsAurora`), then:

```bash
# wiki/ as the source_type - anything you upload under rag/wiki/ becomes
# searchable with source_type='wiki' filtering. runbooks/, docs/, faq/
# all work the same way; the first path segment under rag/ is the type.
aws s3 cp ./local-docs/ s3://<archive-bucket>/rag/wiki/ --recursive \
  --exclude "*" --include "*.md" --include "*.txt" --include "*.html"
```

Supported file types today: `.md`, `.markdown`, `.txt`, `.json`, `.html`, `.htm`. Binary formats (PDF, DOCX, images) are deliberately out of scope - they'd need an extraction pipeline (Textract, pdf-parse, etc.) that isn't part of this feature.

Per file:
- Chunked at ~1800 chars with ~200-char overlap, prefers paragraph (`\n\n`) boundaries
- First H1 line becomes the chunk title for citations (falls back to filename)
- Max 200 chunks per document - a hard cap to avoid runaway ingestion costs on a stray giant file

**Idempotency:** the ingestor records the S3 ETag with each chunk. Re-uploading the same file is a no-op; uploading a modified version (ETag changes) clears the prior chunks and re-embeds. Safe to re-run the same `aws s3 cp` repeatedly.

## What happens at inference time

When `enableLiveDrift=true` (and the corpus has content), every non-trivial user message (skips GREETING/ACKNOWLEDGMENT) triggers:

1. **Router Lambda** embeds the user message via Titan v2 (~100-300ms warm)
2. Runs pgvector cosine-NN against `embeddings WHERE source_type IN ('wiki', 'doc') AND <tier filter>` for top-K (default 4)
3. Drops chunks below similarity 0.35 (honest empty if nothing's relevant enough)
4. Deduplicates citations by `source_id` - multiple chunks from the same file share one citation number
5. Attaches `{ chunks, citations }` to the async-processor InvokeAsync payload
6. **Async processor** receives the payload, calls `buildRetrievedContextHint`, folds the result into the system prompt as a `## RETRIEVED CONTEXT` section with `[1]`, `[2]` markers + a Sources block at the end
7. The LLM responds, optionally referencing the markers (`"the deploy script handles this [1]"`); the markers map to source identifiers the user can resolve

## Tier-based scoping

Documents are visibility-scoped by tier. Ingestion stamps `metadata.tier` from the S3 path: `rag/{source_type}/{tier}/…` where `{tier}` is `basic`, `standard`, or `premium`. Content with no tier segment defaults to `RAG_DEFAULT_TIER` (default `premium`, the most-restrictive tier), so untagged content is never exposed to a lower tier. Tag content `basic` to publish it to all tiers.

Scoping at the retriever (a user's scope is their tier and below):
- **Basic tier:** sees only chunks with `metadata.tier='basic'`
- **Standard tier:** sees `basic` OR `standard`
- **Premium tier:** sees everything

The tier gate is fail-closed: a chunk is returned only if its `metadata.tier` is in the caller's scope. Untagged chunks (`tier IS NULL`, e.g. legacy rows written before ingestion stamped tier) are not returned; re-put the S3 object under `rag/` to re-ingest and make them visible. The filter is applied at SQL level (inside the WHERE clause), not post-filter, so the HNSW index can prune correctly.

## Failure modes

All best-effort. Any failure logs and lets the agent reply without RAG context for that turn:

- **No Aurora deployed** → no data-plane Lambda ARN wired to the router; retrieval skips entirely
- **Embedding call fails** (Titan throttle, timeout, etc.) → `signalAvailable: false`, log warning
- **No chunks above similarity threshold** → `chunks: []`, no hint added to prompt
- **One chunk fails to embed during ingestion** → that chunk skipped; rest of document continues

Honest-empty contract throughout: the agent never fabricates a citation, never returns a "no results found" non-answer when retrieval misses. It just answers without retrieved context.

## Cost picture

| Component | Cost |
|---|---|
| Aurora cluster | $0 incremental; shared with drift / cross-conv / eval. |
| Titan v2 embedding (query) | ~$0.0001 per turn (~30 tokens at $0.00002/1K) |
| Titan v2 embedding (ingestion) | ~$0.0001 per chunk; a 200-chunk doc = ~$0.02 one-time |
| pgvector storage | ~4 KB raw per chunk + ~2x HNSW overhead; 10K chunks ≈ 120 MB |
| Data-plane Lambda | ~100-500ms per turn for the embed + DB query, plus one warm invoke hop (~10-50ms); under $1/mo of invocations |
| New VPC endpoints | $0 - the data-plane Lambda reuses the existing Bedrock + Secrets endpoints and the in-VPC Aurora proxy |

The dominant cost line is Titan embedding calls. At ~10K turns/day, query-side embedding = $1/day. Ingestion is one-time per document upload. Full per-piece infrastructure costs are in [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md).

## Common operations

**Re-ingest a single file** (e.g. after editing):
```bash
aws s3 cp ./updated-doc.md s3://<archive-bucket>/rag/wiki/updated-doc.md
# The ETag changes; the ingestor clears prior chunks + re-embeds.
```

**Delete a document from the corpus:**
```bash
aws s3 rm s3://<archive-bucket>/rag/wiki/old-doc.md
# Note: S3 deletes don't trigger the ingestor. The chunks stay in
# the embeddings table until the deployer runs a manual cleanup
# (DELETE WHERE source_id = ... against the embeddings table).
```

**Verify corpus contents:**
```bash
# Via the analytics-query API (if exposed) - count chunks per source_type
# Or via psql + RDS Proxy IAM auth:
SELECT source_type, COUNT(DISTINCT source_id) AS docs, COUNT(*) AS chunks
FROM embeddings WHERE source_type IN ('wiki', 'doc')
GROUP BY source_type;
```

**Tune the similarity threshold:** the retriever defaults to `minSimilarity: 0.35`. Lower (more permissive - more chunks, possibly less relevant) by passing `minSimilarity` from the router call site. Higher (more selective - fewer chunks, more precise) the same way.

## What's not included

- Frontend rendering of citation markers - `[1]` lands as plain text in the bot reply. Parsing the trailing Sources block into hoverable / clickable references is not included.
- Multi-corpus per channel: every channel sees the global corpus. The retrieval helper's `sourceTypes` parameter is the seam to extend along.
- PDF / DOCX / image ingestion - requires an extraction pipeline (Textract is the AWS-native fit). Out of scope today.
- S3-delete cleanup - adding a chunk to the corpus is automatic; removing it from S3 does not remove it from `embeddings`. Use a manual SQL DELETE.
- Re-ranking - top-K is purely cosine-sorted today. A cross-encoder re-ranker would improve precision but adds a second model call.

## See also

- `docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md` - drift detection, shares the Aurora pgvector cluster
- `docs/guides/admin/AURORA-MODE-GUIDE.md` - Aurora mode setup + cost detail
- `docs/guides/admin/INFRASTRUCTURE-COST.md` - per-piece infrastructure cost model, including the data-plane Lambda
- Project decision 018 (retrieval and drift data-plane Lambda) - the execution model and why the router stays non-VPC
