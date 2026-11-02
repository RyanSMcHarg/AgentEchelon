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
  embedText,
  EMBEDDING_MODEL_ID,
  EMBEDDING_TIMEOUT_ASYNC_MS,
} from './embed-text.js';
import { query } from './db-client.js';
import { withWriterRole } from './classification-boundary.js';
import { lookupChannelClassification } from './channel-classification.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

// The model id, the dimension and this path's longer timeout come from `embed-text.ts` now - one
// Titan call for every consumer of the 1024-dim conversation space (ADR-002, ADR-004). The model id
// is still imported because it is WRITTEN to `summary_embeddings.model_id`, which records which model
// produced a stored vector.
/**
 * How many subjects of one conversation are embedded per summary version.
 *
 * A bound on model spend and on the step-6b comparison, which loads every row for the channel and takes
 * the minimum distance. The summarizer is asked for a handful of topics, so this guards against a
 * pathological response rather than limiting anything anybody should reach.
 */
const MAX_SUBJECTS_PER_VERSION = 12;

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
  /**
   * WHO GENERATED THE SUMMARY THIS ANCHOR WAS BUILT FROM: `summary-seed`, `summary-updater` or
   * `drift-spawn`, matching what the caller wrote to `conversation_summaries.generated_by`.
   *
   * Carried on the anchor rather than read back through a join, because the reader is a per-
   * classification role that holds SELECT only on the bounded tables, and `conversation_summaries`
   * has no classification column to bound it by. See `065-a-summary-anchor-carries-its-own-provenance`.
   *
   * IT SEPARATES THE TWO VERSION-1 CASES, which is the whole reason drift asks. A conversation split
   * out of another one has its topic BEFORE its first message and is seeded at version 1 from that
   * topic; an ordinary new conversation at version 1 has one message and no topic yet. The version
   * alone cannot tell them apart, and treating the first as the second suppresses drift on a
   * conversation that was created precisely because the subject changed.
   */
  generatedBy?: string;
  /**
   * THE CONVERSATION'S OWN SUBJECTS, embedded individually (SPEC-DRIFT-CONVERGENCE FR5).
   *
   * The summarizer's `topics[]`, as it wrote them to `conversation_summaries`. Each is embedded and
   * stored as its own row in `conversation_topic_embeddings`, so drift's step 6 can ask "is this a
   * subject we already cover" against the subjects THEMSELVES rather than against their average.
   *
   * WHY THE AVERAGE IS NOT ENOUGH (spec section 258): the summary embedding is a mean over everything
   * the conversation covers, so in a multi-subject conversation every individual subject sits some
   * distance from it - and distance from the summary therefore rises whenever somebody moves between
   * the conversation's own subjects. A Q3 revenue report and a Q2 revenue report are far apart; the
   * conversation covering both is one point between them, close to neither.
   *
   * THE TEXT IS EMBEDDED, NEVER STORED. `topics[]` is the model's human-readable labelling of what got
   * embedded and is explicitly "never the matching key" (section 258) - string overlap on it is ruled
   * out by section 192. So these rows carry a vector and a classification and no prose, which is also
   * why the table needs no redaction path.
   *
   * Omitted or empty leaves this channel's existing subject rows untouched: a summary run that could
   * not produce topics is not a statement that the conversation has none.
   */
  topics?: string[] | null;
}

export interface WriteSummaryEmbeddingResult {
  written: boolean;
  reason?: 'embedding_failed' | 'stale_version' | 'empty_summary';
  /** The classification actually stamped, and where it came from — see `resolveClassification`. */
  classification?: string;
  classificationSource?: 'caller' | 'projection' | 'fail-closed';
  /** How many per-subject rows were stored (FR5). Zero is legitimate, not an error. */
  topicsWritten?: number;
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
    `INSERT INTO summary_embeddings (channel_arn, embedding, embedded_from_version, model_id, classification, generated_by)
     VALUES ($1, $2::vector, $3, $4, $5, $6)
     ON CONFLICT (channel_arn) DO UPDATE
       SET embedding = EXCLUDED.embedding,
           embedded_at = NOW(),
           embedded_from_version = EXCLUDED.embedded_from_version,
           model_id = EXCLUDED.model_id,
           classification = EXCLUDED.classification,
           -- Moves WITH the embedding, because it describes the summary this anchor was built from.
           -- Leaving the previous writer's value behind would label a fresh anchor with the
           -- provenance of the one it replaced.
           generated_by = EXCLUDED.generated_by
       WHERE summary_embeddings.embedded_from_version < EXCLUDED.embedded_from_version
     RETURNING embedded_from_version`,
    [channelArn, vectorLiteral, fromVersion, EMBEDDING_MODEL_ID, classification, input.generatedBy ?? null],
  ));

  if (result.rows.length === 0) {
    // The ON CONFLICT WHERE clause didn't match — the existing row is at
    // or beyond fromVersion. Treat as a no-op success.
    //
    // THE SUBJECTS ARE SKIPPED WITH IT, on purpose: they describe the same summary version, so a run
    // whose anchor is stale is carrying stale subjects too. Writing them here would replace a fresher
    // set with an older one under the same "replace at this version" rule.
    return { written: false, reason: 'stale_version' };
  }

  // The subjects, on the same version and with the SAME resolved classification as the anchor above.
  // Best-effort and last: a conversation with a good anchor and no subject rows behaves exactly as it
  // does today, so a failure here costs recall on one comparison rather than drift's whole input.
  const topicsWritten = await writeTopicEmbeddings({
    channelArn, topics: input.topics, fromVersion, classification,
  });

  return { written: true, classification, classificationSource: source, topicsWritten };
}

/**
 * Replace this channel's per-subject embeddings for a summary version.
 *
 * REPLACE, NOT MERGE (spec section 311: "replacing this channel's summarizer rows at the same
 * version"). A summary version states what the conversation is about NOW; a subject the new version
 * dropped is no longer one of its subjects, and leaving it behind would suppress drift on a topic the
 * conversation has actually moved off. `withWriterRole` runs in a transaction, so the delete and the
 * insert are one step and a reader never sees the gap between them.
 *
 * SCOPED TO `origin = 'summary_topic'`. The delete must not touch `drift_offer` rows: those are
 * subjects the person DECLINED to split out, they belong to the conversation independently of any
 * summary, and a summary run is not evidence about them.
 *
 * Returns how many subjects were stored, for the caller's run metrics. Zero is a legitimate outcome and
 * is not an error: a one-exchange conversation may genuinely have no distinct subjects yet.
 */
async function writeTopicEmbeddings(input: {
  channelArn: string;
  topics?: string[] | null;
  fromVersion: number;
  classification: string;
}): Promise<number> {
  const subjects = (input.topics ?? [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // One row per distinct subject: the model occasionally repeats a label between versions of the
    // same list, and two identical vectors change no comparison while costing an embed call each.
    .filter((t, i, all) => all.findIndex((o) => o.toLowerCase() === t.toLowerCase()) === i)
    .slice(0, MAX_SUBJECTS_PER_VERSION);

  // ABSENT IS NOT EMPTY. No topics means the run said nothing about this conversation's subjects, so the
  // previous version's rows stand. An explicit empty list is treated the same way rather than as "this
  // conversation has no subjects", because the summarizer omitting the field and returning `[]` are not
  // distinguishable here and the destructive reading is the wrong default.
  if (subjects.length === 0) return 0;

  const vectors: { subject: string; vector: number[] }[] = [];
  for (const subject of subjects) {
    const vector = await embed(subject);
    // One subject failing to embed does not discard the others: a partial subject set is strictly
    // better than the average-only comparison it replaces.
    if (vector) vectors.push({ subject, vector });
  }
  if (vectors.length === 0) return 0;

  try {
    await withWriterRole(async (client) => {
      await client.query(
        `DELETE FROM conversation_topic_embeddings
          WHERE channel_arn = $1 AND origin = 'summary_topic'`,
        [input.channelArn],
      );
      for (const { subject, vector } of vectors) {
        await client.query(
          `INSERT INTO conversation_topic_embeddings
             (channel_arn, topic_key, origin, status, embedding, classification, model_id, embedded_from_version)
           VALUES ($1, $2, 'summary_topic', 'established', $3::vector, $4, $5, $6)
           ON CONFLICT (channel_arn, topic_key) DO UPDATE
             SET embedding = EXCLUDED.embedding,
                 classification = EXCLUDED.classification,
                 embedded_from_version = EXCLUDED.embedded_from_version`,
          [
            input.channelArn,
            subjectTopicKey(subject),
            `[${vector.join(',')}]`,
            input.classification,
            EMBEDDING_MODEL_ID,
            input.fromVersion,
          ],
        );
      }
    });
    return vectors.length;
  } catch (err) {
    console.warn('[EmbeddingWriter] could not store the conversation subjects; the anchor still stands', {
      channelArn: input.channelArn, count: vectors.length, err: (err as { name?: string })?.name,
    });
    return 0;
  }
}

/**
 * The key a summarizer subject is stored under, inside this channel.
 *
 * DERIVED FROM THE SUBJECT, not from the version, so the same subject surviving a new summary version
 * updates its own row instead of accumulating one row per version. The version lives in its own column.
 *
 * `summary:` prefixes it, which is the namespace 044 anticipated ("The summariser's rows would use
 * their own prefix") - so a key can never collide with a `drift:<correlationId>` row.
 */
function subjectTopicKey(subject: string): string {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  // A subject of only punctuation would slug to nothing; its hash keeps the key unique and stable.
  return `summary:${slug || `h${hashSubject(subject)}`}`;
}

/** A short stable digest, for the one case a subject has no sluggable characters. */
function hashSubject(subject: string): string {
  let h = 0;
  for (let i = 0; i < subject.length; i++) h = (Math.imul(31, h) + subject.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
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
    return { classification: profiles.resolveClassification(fromCaller)!, source: 'caller' };
  }

  const projected = await lookupChannelClassification(channelArn);
  if (projected) return { classification: projected, source: 'projection' };

  console.warn(
    `[embedding-writer] no classification for ${channelArn}; stamping the most restrictive `
    + `classification a conversation is served at (${profiles.failClosedContentValue}). This summary `
    + 'will be invisible to every classification that does not reach it until the Chime-sourced backfill '
    + 'records the channel. NOT the admin plane: it serves no user conversation, so a summary stamped '
    + 'there would be invisible to everyone.',
  );
  return { classification: profiles.failClosedContentValue, source: 'fail-closed' };
}

/**
 * The shared Titan call, with this path's longer timeout and its warning kept.
 *
 * The body moved to `embed-text.ts` unchanged. The wrapper stays so the two call sites below read as
 * they did, and so the timeout and the log label are stated once rather than at each of them.
 */
async function embed(text: string): Promise<number[] | null> {
  return embedText(text, {
    timeoutMs: EMBEDDING_TIMEOUT_ASYNC_MS,
    label: 'embedding-writer',
  });
}
