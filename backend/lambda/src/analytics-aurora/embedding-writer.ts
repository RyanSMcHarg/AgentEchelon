/**
 * Summary Embedding Writer
 *
 * Generates Titan v2 (1024-dim) embeddings of conversation summaries and
 * UPSERTs into the summary_embeddings table. Called inline from the
 * summary-updater Lambda after each successful summary write.
 *
 * Idempotent: skips if summary_embeddings.embedded_from_version >= the new
 * conversation_summaries.version (a concurrent updater already wrote a
 * fresher embedding).
 *
 * Failure is best-effort: a missed embedding write means drift detection
 * will hit `drift_skipped_no_summary` for that channel until the next
 * summary run regenerates and writes a fresh embedding. The drift module
 * does NOT lazy-compute (the spec deliberately avoids the lazy path to
 * keep the critical-path latency predictable).
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { query } from './db-client.js';

const EMBEDDING_MODEL_ID = process.env.DRIFT_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM = 1024;
const EMBEDDING_TIMEOUT_MS = 5000; // longer than the live-path timeout — the writer is async

const bedrockClient = new BedrockRuntimeClient({});

export interface WriteSummaryEmbeddingInput {
  channelArn: string;
  summaryText: string;
  fromVersion: number;
}

export interface WriteSummaryEmbeddingResult {
  written: boolean;
  reason?: 'embedding_failed' | 'stale_version' | 'empty_summary';
}

export async function writeSummaryEmbedding(
  input: WriteSummaryEmbeddingInput,
): Promise<WriteSummaryEmbeddingResult> {
  const { channelArn, summaryText, fromVersion } = input;

  if (!summaryText || summaryText.trim().length === 0) {
    return { written: false, reason: 'empty_summary' };
  }

  const embedding = await embed(summaryText);
  if (!embedding) {
    return { written: false, reason: 'embedding_failed' };
  }

  // UPSERT with version guard: don't overwrite a fresher embedding.
  const vectorLiteral = `[${embedding.join(',')}]`;
  const result = await query<{ embedded_from_version: number }>(
    `INSERT INTO summary_embeddings (channel_arn, embedding, embedded_from_version, model_id)
     VALUES ($1, $2::vector, $3, $4)
     ON CONFLICT (channel_arn) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           embedded_at = NOW(),
           embedded_from_version = EXCLUDED.embedded_from_version,
           model_id = EXCLUDED.model_id
       WHERE summary_embeddings.embedded_from_version < EXCLUDED.embedded_from_version
     RETURNING embedded_from_version`,
    [channelArn, vectorLiteral, fromVersion, EMBEDDING_MODEL_ID],
  );

  if (result.rows.length === 0) {
    // The ON CONFLICT WHERE clause didn't match — the existing row is at
    // or beyond fromVersion. Treat as a no-op success.
    return { written: false, reason: 'stale_version' };
  }

  return { written: true };
}

async function embed(text: string): Promise<number[] | null> {
  const input = text.slice(0, 8000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const response = await bedrockClient.send(
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
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      return null;
    }
    return embedding as number[];
  } catch (err) {
    clearTimeout(timer);
    console.warn('[embedding-writer] Titan call failed:', err);
    return null;
  }
}
