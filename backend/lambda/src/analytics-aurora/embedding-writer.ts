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
import { withWriterRole } from './classification-boundary.js';
import { lookupChannelClassification } from './channel-classification.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';

const EMBEDDING_MODEL_ID = process.env.DRIFT_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIM = 1024;
const EMBEDDING_TIMEOUT_MS = 5000; // longer than the live-path timeout — the writer is async

const bedrockClient = new BedrockRuntimeClient({});

export interface WriteSummaryEmbeddingInput {
  channelArn: string;
  summaryText: string;
  fromVersion: number;
  /**
   * The channel's classification, when the caller is in a position to know it authoritatively.
   *
   * The seed path IS: it runs from a live router turn, which resolved the classification from the
   * immutable channel tag on the way in. The scheduled scan is NOT: it runs inside the Aurora VPC,
   * which has `natGateways: 0` and no route to the Chime SDK at all, so it cannot ask. Omitted, this
   * falls back to `channel_classification` and then, failing that, to the most restrictive value.
   */
  classification?: string;
}

export interface WriteSummaryEmbeddingResult {
  written: boolean;
  reason?: 'embedding_failed' | 'stale_version' | 'empty_summary';
  /** The classification actually stamped, and where it came from — see `resolveClassification`. */
  classification?: string;
  classificationSource?: 'caller' | 'projection' | 'fail-closed';
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

  const { classification, source } = await resolveClassification(channelArn, input.classification);

  // UPSERT with version guard: don't overwrite a fresher embedding.
  //
  // ADR-028: `summary_embeddings` is under FORCE ROW LEVEL SECURITY, so this runs as the write role.
  // Issued as the owner it would report success and write NOTHING — drift would then silently lose
  // its anchor for every conversation, which presents as "no drift detected" rather than as a fault.
  const vectorLiteral = `[${embedding.join(',')}]`;
  const result = await withWriterRole((client) => client.query<{ embedded_from_version: number }>(
    `INSERT INTO summary_embeddings (channel_arn, embedding, embedded_from_version, model_id, classification)
     VALUES ($1, $2::vector, $3, $4, $5)
     ON CONFLICT (channel_arn) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           embedded_at = NOW(),
           embedded_from_version = EXCLUDED.embedded_from_version,
           model_id = EXCLUDED.model_id,
           classification = EXCLUDED.classification
       WHERE summary_embeddings.embedded_from_version < EXCLUDED.embedded_from_version
     RETURNING embedded_from_version`,
    [channelArn, vectorLiteral, fromVersion, EMBEDDING_MODEL_ID, classification],
  ));

  if (result.rows.length === 0) {
    // The ON CONFLICT WHERE clause didn't match — the existing row is at
    // or beyond fromVersion. Treat as a no-op success.
    return { written: false, reason: 'stale_version' };
  }

  return { written: true, classification, classificationSource: source };
}

/**
 * Decide which classification this summary embedding is stamped with, and record how confidently.
 *
 * THE ORDER IS THE POINT. A caller that resolved the value from the live channel tag is believed
 * first; `channel_classification` - a projection of an out-of-VPC Chime read - is consulted second;
 * and when neither answers, the row is stamped with the MOST RESTRICTIVE classification rather than a
 * guess or a NULL.
 *
 * WHY FAIL-CLOSED HERE MEANS "MOST RESTRICTIVE", NOT "SKIP". Skipping the write would leave drift
 * with no anchor for the conversation, which degrades a feature. Stamping the top of the ladder keeps
 * the anchor and makes it readable only by the classification that could already see everything - so
 * the failure costs recall for lower classifications instead of costing isolation. It is logged
 * distinguishably because a boundary that quietly withholds is indistinguishable from an empty corpus,
 * and this repo has shipped that shape before.
 */
async function resolveClassification(
  channelArn: string,
  fromCaller?: string,
): Promise<{ classification: string; source: 'caller' | 'projection' | 'fail-closed' }> {
  if (fromCaller && profiles.isKnownClassification(fromCaller)) {
    return { classification: profiles.resolveClassification(fromCaller), source: 'caller' };
  }

  const projected = await lookupChannelClassification(channelArn);
  if (projected) return { classification: projected, source: 'projection' };

  console.warn(
    `[embedding-writer] no classification for ${channelArn}; stamping the most restrictive `
    + `(${profiles.mostRestrictiveValue}). This summary will be invisible to every classification `
    + 'below it until the Chime-sourced backfill records the channel.',
  );
  return { classification: profiles.mostRestrictiveValue, source: 'fail-closed' };
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
