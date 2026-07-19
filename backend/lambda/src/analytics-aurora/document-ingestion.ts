/**
 * Document Ingestion Lambda — RAG proof-point ingestor.
 *
 * Triggered by S3 PutObject events on the `rag/` prefix of the
 * attachments bucket. Reads the uploaded file, chunks it, embeds each
 * chunk via Titan v2 (1024-dim per ADR-002), and UPSERTs into the
 * `embeddings` table (schema migration 008) with `source_type='wiki'`
 * (or the source-type derived from the S3 prefix) + per-chunk metadata.
 *
 * Idempotent: composite unique index `(source_type, source_id, chunk_index)`
 * makes ON CONFLICT DO NOTHING per chunk safe. ETag is recorded so a
 * re-ingestion of the same file produces a no-op until the file content
 * changes; a content change re-embeds all chunks for that source_id.
 *
 * Why no Bedrock Knowledge Base wrapper?
 *   ADR-001 explicitly rejected the OpenSearch Serverless
 *   backing on cost grounds (~$175/mo minimum for 1 OCU each indexing +
 *   search) and committed to Aurora pgvector. This Lambda is the
 *   "manual chunker + ingester" the project chose over Bedrock KB's
 *   managed pipeline. The Aurora cluster amortizes across drift +
 *   cross-conversation context + RAG + (future) eval, so RAG adds zero
 *   incremental infra cost.
 *
 * Failure mode is best-effort: a chunk that fails to embed is logged
 * and skipped; the rest of the document still ingests. A file that
 * fails to read aborts the whole event but does not throw — S3 event
 * retries are bounded by Lambda's retry policy.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { query } from './db-client.js';
import { emitDriftCounter, newCorrelationId } from '../lib/emf-metrics.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const EMBEDDING_MODEL_ID =
  process.env.DRIFT_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM = 1024;
const EMBEDDING_TIMEOUT_MS = 5000;

// Chunking: fixed-size with overlap. Simple and good enough for a
// proof-point corpus. Tuned for Titan v2's input window and typical
// markdown/text wiki content.
const CHUNK_SIZE_CHARS = 1800;     // ~450 tokens at avg 4 chars/token
const CHUNK_OVERLAP_CHARS = 200;   // ~50 tokens; preserves cross-chunk context
const MAX_CHUNKS_PER_DOC = 200;    // hard cap; a 360KB doc is the ceiling

// Source-type derivation: the S3 key prefix immediately under `rag/` is
// the source_type (e.g., rag/wiki/foo.md → 'wiki'). Falls back to
// 'doc' for files at `rag/` root.
function deriveSourceType(s3Key: string): string {
  const m = s3Key.match(/^rag\/([^/]+)\//);
  return m ? m[1] : 'doc';
}

// Tier derivation for per-tier retrieval (schema 008: `metadata` holds `{tier}`).
// Without this, no chunk was tagged and the retrieval tier-filter was a no-op —
// ALL KB content was returned to ALL tiers (cross-tier leak). Convention: an
// optional tier segment right after the source-type — `rag/{sourceType}/{tier}/…`
// where `{tier}` ∈ basic|standard|premium. Content with NO tier segment defaults
// to `RAG_DEFAULT_CLASSIFICATION` (default `premium` = most-restrictive, **fail-closed**),
// so untagged content is never exposed to a lower tier; tag content `basic` to
// publish it to all tiers. Retrieval filters `metadata->>'tier' = ANY(scope)`
// where a user's scope is their tier and below (router-agent-handler.ts).
export function deriveClearance(s3Key: string): string {
  const seg = s3Key.match(/^rag\/[^/]+\/([^/]+)\//)?.[1];
  if (seg && profiles.isKnownClassification(seg)) return profiles.resolveClassification(seg);
  // Untagged content defaults to the MOST restrictive classification (fail-closed) so it is never
  // exposed to a lower one; an env override applies only if it names a known classification.
  const dflt = (process.env.RAG_DEFAULT_CLASSIFICATION || '').trim();
  return profiles.isKnownClassification(dflt) ? dflt : profiles.mostRestrictiveValue;
}

// Title derivation: first non-empty H1 line if present, else filename
// without extension. Used as the citation label in retrieval results.
function deriveTitle(s3Key: string, content: string): string {
  const h1 = content.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1) return h1[1].slice(0, 500);
  const filename = s3Key.split('/').pop() || s3Key;
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').slice(0, 500);
}

/**
 * Pure. Split text into overlapping fixed-size chunks. Prefers to break
 * on paragraph (\n\n) boundaries within the size window; falls back to
 * sentence (. ) or hard cut. Returns positions for later citation
 * anchoring.
 */
export function chunkText(text: string): Array<{ index: number; text: string; start: number }> {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const chunks: Array<{ index: number; text: string; start: number }> = [];
  let cursor = 0;
  let index = 0;

  while (cursor < normalized.length && chunks.length < MAX_CHUNKS_PER_DOC) {
    let end = Math.min(cursor + CHUNK_SIZE_CHARS, normalized.length);

    // If we're not at the document end, try to land on a boundary.
    if (end < normalized.length) {
      const window = normalized.slice(cursor, end);
      const lastParagraph = window.lastIndexOf('\n\n');
      const lastSentence = window.lastIndexOf('. ');
      const boundary =
        lastParagraph >= CHUNK_SIZE_CHARS * 0.5 ? lastParagraph + 2
        : lastSentence >= CHUNK_SIZE_CHARS * 0.5 ? lastSentence + 2
        : -1;
      if (boundary > 0) end = cursor + boundary;
    }

    const chunkText = normalized.slice(cursor, end).trim();
    if (chunkText) {
      chunks.push({ index, text: chunkText, start: cursor });
      index++;
    }

    if (end >= normalized.length) break;
    // Slide forward by chunk size minus overlap, but never less than 1
    // (overlap could in theory exceed the boundary-shrunk chunk).
    cursor = Math.max(cursor + 1, end - CHUNK_OVERLAP_CHARS);
  }

  return chunks;
}

async function embed(text: string): Promise<number[] | null> {
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
    console.warn('[document-ingestion] Titan embed call failed:', err);
    return null;
  }
}

interface S3EventRecord {
  s3?: {
    bucket?: { name?: string };
    object?: { key?: string; eTag?: string };
  };
  eventName?: string;
}

interface S3Event {
  Records?: S3EventRecord[];
}

export interface IngestResult {
  sourceId: string;
  sourceType: string;
  chunksAttempted: number;
  chunksEmbedded: number;
  chunksWritten: number;
  skippedReason?: 'unchanged_etag' | 'unsupported_type' | 'empty_content';
}

/**
 * Lambda entry point. Processes every S3 record in the event; one
 * record's failure does not abort the others.
 */
export async function handler(event: S3Event): Promise<{ ingested: IngestResult[] }> {
  const correlationId = newCorrelationId();
  console.log('[document-ingestion] event received', {
    correlationId,
    recordCount: event.Records?.length ?? 0,
  });

  const results: IngestResult[] = [];

  for (const record of event.Records ?? []) {
    const bucket = record.s3?.bucket?.name;
    const key = decodeURIComponent((record.s3?.object?.key ?? '').replace(/\+/g, ' '));
    const etag = (record.s3?.object?.eTag ?? '').replace(/"/g, '');

    if (!bucket || !key || !key.startsWith('rag/')) {
      console.warn('[document-ingestion] skipping record: not under rag/ prefix', { key });
      continue;
    }

    try {
      const result = await ingestObject(bucket, key, etag, correlationId);
      results.push(result);
    } catch (err) {
      console.error('[document-ingestion] record failed (non-fatal):', { key, err });
    }
  }

  return { ingested: results };
}

export async function ingestObject(
  bucket: string,
  key: string,
  etag: string,
  correlationId: string,
): Promise<IngestResult> {
  const sourceType = deriveSourceType(key);
  const sourceId = `s3://${bucket}/${key}`;

  // Idempotency check: skip if a chunk for this (source_id, etag) already
  // exists. A content edit produces a new etag; we re-embed when the
  // recorded etag differs.
  if (etag) {
    const existing = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM embeddings
        WHERE source_id = $1 AND source_etag = $2`,
      [sourceId, etag],
    );
    if (parseInt(existing.rows[0]?.count || '0', 10) > 0) {
      console.log('[document-ingestion] unchanged etag, skipping', { sourceId, etag });
      return {
        sourceId,
        sourceType,
        chunksAttempted: 0,
        chunksEmbedded: 0,
        chunksWritten: 0,
        skippedReason: 'unchanged_etag',
      };
    }

    // ETag changed — clear the prior version's chunks so we don't keep
    // a mix of old + new embeddings for the same source_id.
    await query(
      `DELETE FROM embeddings WHERE source_id = $1 AND source_type = $2`,
      [sourceId, sourceType],
    );
  }

  // Fetch object body. Only text-like content is supported in this
  // proof-point — binary/PDF would need an extraction pipeline (Textract,
  // pdf-parse) that's deliberately out of scope.
  if (!key.match(/\.(md|markdown|txt|json|html?)$/i)) {
    console.warn('[document-ingestion] unsupported file type, skipping', { key });
    return {
      sourceId,
      sourceType,
      chunksAttempted: 0,
      chunksEmbedded: 0,
      chunksWritten: 0,
      skippedReason: 'unsupported_type',
    };
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const content = (await obj.Body?.transformToString('utf-8')) ?? '';
  if (!content.trim()) {
    return {
      sourceId,
      sourceType,
      chunksAttempted: 0,
      chunksEmbedded: 0,
      chunksWritten: 0,
      skippedReason: 'empty_content',
    };
  }

  const title = deriveTitle(key, content);
  const chunks = chunkText(content);

  let chunksEmbedded = 0;
  let chunksWritten = 0;
  for (const chunk of chunks) {
    const embedding = await embed(chunk.text);
    if (!embedding) {
      emitDriftCounter('drift_skipped_unavailable', correlationId); // reuse closest counter
      continue;
    }
    chunksEmbedded++;

    const metadata = {
      filename: key.split('/').pop(),
      sourceKey: key,
      chunkStart: chunk.start,
      // Per-tier retrieval gate (fail-closed default). See deriveClearance.
      tier: deriveClearance(key),
    };

    try {
      const vectorLiteral = `[${embedding.join(',')}]`;
      const result = await query(
        `INSERT INTO embeddings (
           source_type, source_id, content, embedding, metadata,
           chunk_index, source_etag, title
         ) VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, $7, $8)
         ON CONFLICT (source_type, source_id, chunk_index) DO NOTHING`,
        [
          sourceType,
          sourceId,
          chunk.text,
          vectorLiteral,
          JSON.stringify(metadata),
          chunk.index,
          etag || null,
          title,
        ],
      );
      if ((result.rowCount ?? 0) > 0) chunksWritten++;
    } catch (err) {
      console.warn('[document-ingestion] chunk write failed:', { chunkIndex: chunk.index, err });
    }
  }

  console.log('[document-ingestion] ingested', {
    sourceId,
    sourceType,
    title,
    chunksAttempted: chunks.length,
    chunksEmbedded,
    chunksWritten,
    correlationId,
  });

  return {
    sourceId,
    sourceType,
    chunksAttempted: chunks.length,
    chunksEmbedded,
    chunksWritten,
  };
}
