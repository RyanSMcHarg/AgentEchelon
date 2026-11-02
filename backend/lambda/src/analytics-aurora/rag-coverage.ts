/**
 * Which corpus objects the database holds chunks for: the read the RAG sync asks before it decides what to re-put,
 * and after, to confirm the ingest settled (`scripts/sync-project-knowledge.mjs`, `ragSourceCoverage` on the data
 * plane).
 *
 * An ingest that timed out or failed leaves an object in S3 with no chunks, and every later S3 event for an
 * unchanged object is the only thing that would ingest it. Asking the database is the one answer to "is it in the
 * corpus": the S3 listing says what was uploaded, not what was embedded.
 *
 * Read as the write role. `embeddings` is under FORCE ROW LEVEL SECURITY and the owner has no policy, so the owner
 * reads zero rows and every source would look missing; the write role reads every classification's rows, which is
 * what a coverage count over the whole corpus needs (the same reason `document-ingestion.ts` counts as it). It
 * returns identifiers and counts, never content.
 */

import { withWriterRole } from './classification-boundary.js';

export interface RagSourceCoverageInput {
  /** The corpus bucket (the archive bucket). */
  bucket: string;
  /** A key prefix under `rag/`, for example `rag/agentechelon/standard/`. */
  prefix: string;
}

export interface RagSourceCoverage {
  /** The object's key, under the prefix. */
  key: string;
  /** The chunks the database holds for it. */
  chunks: number;
  /** The ETag the chunks were written at, or null. */
  etag: string | null;
}

/** The objects under `prefix` that have chunks, each with its count. An object with none is absent from the list. */
export async function ragSourceCoverage(input: RagSourceCoverageInput): Promise<{ sources: RagSourceCoverage[] }> {
  const bucket = String(input?.bucket ?? '').trim();
  const prefix = String(input?.prefix ?? '').trim();
  if (!bucket || /[/\s]/.test(bucket)) throw new Error('[rag-coverage] bucket is required and is a bucket name');
  if (!prefix.startsWith('rag/')) throw new Error('[rag-coverage] prefix must be under rag/');
  const base = `s3://${bucket}/`;
  // LIKE treats % and _ as wildcards; a key prefix is literal.
  const pattern = `${(base + prefix).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const result = await withWriterRole((client) => client.query<{ source_id: string; chunks: string; etag: string | null }>(
    `SELECT source_id, COUNT(*)::text AS chunks, MAX(source_etag) AS etag
       FROM embeddings
      WHERE source_id LIKE $1 ESCAPE '\\'
      GROUP BY source_id`,
    [pattern],
  ));
  return {
    sources: result.rows.map((r) => ({
      key: r.source_id.slice(base.length),
      chunks: parseInt(r.chunks, 10) || 0,
      etag: r.etag ?? null,
    })),
  };
}
