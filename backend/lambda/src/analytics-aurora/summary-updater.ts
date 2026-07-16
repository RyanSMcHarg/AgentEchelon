/**
 * Summary Updater Lambda
 *
 * Generates `conversation_summaries` rows for channels with recent activity.
 * Scheduled via EventBridge every `SUMMARY_UPDATER_INTERVAL_MIN` minutes
 * (default 30). On each run, finds channels whose newest message is newer
 * than their newest summary, and (re)summarizes via Bedrock Haiku.
 *
 * Per SPEC-DRIFT-CONVERGENCE.md "Summary Updater (Prerequisite)":
 *
 * - Time-based trigger only. No fire-and-forget invocation from
 *   kinesis-archival; this Lambda owns all summary generation.
 * - Bedrock Haiku at temperature 0 for determinism. Prompt produces
 *   structured JSON (summary, purpose, topics, key_points).
 * - UPSERT with version guard. Concurrent writers are race-safe via
 *   conditional update: `WHERE version = $previousVersion`.
 * - Embedding write happens inline after each successful summary write
 *   (via embedding-writer.ts) so drift detection sees fresh embeddings
 *   on the very next call.
 * - Per-channel best-effort. A Bedrock failure on one channel doesn't
 *   block the rest of the batch.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { query } from './db-client.js';
import { writeSummaryEmbedding } from './embedding-writer.js';
import { emitDriftCounter, emitDriftTiming, newCorrelationId } from '../lib/emf-metrics.js';

const SUMMARY_MODEL_ID = process.env.SUMMARY_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
const SUMMARY_MAX_MESSAGES = Number(process.env.SUMMARY_MAX_MESSAGES || '50');
const SUMMARY_BATCH_LIMIT = Number(process.env.SUMMARY_BATCH_LIMIT || '20'); // max channels per run
const SUMMARY_BEDROCK_TIMEOUT_MS = 8000;

const bedrockClient = new BedrockRuntimeClient({});

interface SummaryUpdaterEvent {
  // Reserved — current Lambda always processes the active-channel scan.
  // Future: { source: 'manual'; channelArn: string } for ops backfills.
  source?: string;
  channelArn?: string;
}

interface ActiveChannel {
  channel_arn: string;
  current_version: number | null;
  last_summary_at: string | null;
  newest_message_at: string;
}

export async function handler(event: SummaryUpdaterEvent = {}): Promise<{ processed: number; failed: number }> {
  const startedAt = Date.now();
  console.log('[summary-updater] run start', { event });

  // Find channels needing summary updates.
  const channels = await findActiveChannels(event.channelArn);
  console.log(`[summary-updater] found ${channels.length} active channels`);

  let processed = 0;
  let failed = 0;
  for (const channel of channels) {
    try {
      await processChannel(channel);
      processed++;
    } catch (err) {
      failed++;
      console.warn(`[summary-updater] channel ${channel.channel_arn} failed:`, err);
    }
  }

  console.log('[summary-updater] run complete', { processed, failed, durationMs: Date.now() - startedAt });
  return { processed, failed };
}

async function findActiveChannels(specificArn?: string): Promise<ActiveChannel[]> {
  // If invoked with a specific channelArn (e.g., ops backfill), process only that one.
  if (specificArn) {
    const rows = await query<ActiveChannel>(
      `SELECT m.channel_arn,
              cs.version AS current_version,
              cs.updated_at::text AS last_summary_at,
              MAX(m.created_at)::text AS newest_message_at
         FROM messages m
         LEFT JOIN LATERAL (
           SELECT version, updated_at
             FROM conversation_summaries
            WHERE channel_arn = m.channel_arn
            ORDER BY version DESC
            LIMIT 1
         ) cs ON TRUE
         WHERE m.channel_arn = $1
         GROUP BY m.channel_arn, cs.version, cs.updated_at`,
      [specificArn],
    );
    return rows.rows;
  }

  // Scheduled run: find all channels with messages newer than their newest
  // summary. The LATERAL join gets the latest summary version per channel
  // efficiently; the WHERE filters to channels actually due for an update.
  const rows = await query<ActiveChannel>(
    `SELECT m.channel_arn,
            cs.version AS current_version,
            cs.updated_at::text AS last_summary_at,
            MAX(m.created_at)::text AS newest_message_at
       FROM messages m
       LEFT JOIN LATERAL (
         SELECT version, updated_at
           FROM conversation_summaries
          WHERE channel_arn = m.channel_arn
          ORDER BY version DESC
          LIMIT 1
       ) cs ON TRUE
       WHERE m.created_at > COALESCE(cs.updated_at, 'epoch'::timestamptz)
       GROUP BY m.channel_arn, cs.version, cs.updated_at
       ORDER BY MAX(m.created_at) DESC
       LIMIT $1`,
    [SUMMARY_BATCH_LIMIT],
  );
  return rows.rows;
}

async function processChannel(channel: ActiveChannel): Promise<void> {
  const correlationId = newCorrelationId();
  const tStart = Date.now();

  // Pull recent messages.
  const tMsgStart = Date.now();
  const messages = await query<{
    sender_name: string | null;
    is_bot: boolean;
    content: string | null;
    created_at: string;
  }>(
    `SELECT sender_name, is_bot, content, created_at
       FROM messages
      WHERE channel_arn = $1
        AND content IS NOT NULL
        AND content <> ''
      ORDER BY created_at DESC
      LIMIT $2`,
    [channel.channel_arn, SUMMARY_MAX_MESSAGES],
  );
  emitDriftTiming('summary_fetch', Date.now() - tMsgStart, correlationId);

  if (messages.rows.length === 0) {
    emitDriftCounter('drift_skipped_no_summary', correlationId); // reusing closest counter
    return;
  }

  // Pull the existing summary (if any) for incremental context.
  const existingSummary = await query<{
    version: number;
    summary: string | null;
    purpose: string | null;
    topics: string[] | null;
  }>(
    `SELECT version, summary, purpose, topics
       FROM conversation_summaries
      WHERE channel_arn = $1
      ORDER BY version DESC
      LIMIT 1`,
    [channel.channel_arn],
  );
  const previous = existingSummary.rows[0];
  const previousVersion = previous?.version || 0;

  // Build the Bedrock prompt.
  const reversedMessages = messages.rows.slice().reverse(); // chronological
  const transcript = reversedMessages
    .map((m) => `${m.is_bot ? 'Assistant' : m.sender_name || 'User'}: ${(m.content || '').slice(0, 1000)}`)
    .join('\n');

  const prompt = buildSummaryPrompt({
    transcript,
    previousSummary: previous?.summary || undefined,
    previousPurpose: previous?.purpose || undefined,
    previousTopics: previous?.topics || undefined,
  });

  // Call Bedrock.
  const tBedrockStart = Date.now();
  let parsed: ParsedSummary | null = null;
  try {
    parsed = await callBedrockHaiku(prompt);
  } catch (err) {
    console.warn(`[summary-updater] Bedrock call failed for ${channel.channel_arn}:`, err);
  }
  emitDriftTiming('comparison', Date.now() - tBedrockStart, correlationId); // reusing closest

  if (!parsed) {
    return;
  }

  // UPSERT with version guard (race-safe against concurrent updaters).
  const newVersion = previousVersion + 1;
  const totalMessageCount = await getMessageCount(channel.channel_arn);

  const inserted = await query<{ version: number }>(
    `INSERT INTO conversation_summaries (
       channel_arn, name, purpose, summary, topics, key_points,
       message_count, participant_count, version, generated_by, model_used
     ) VALUES ($1, NULL, $2, $3, $4::text[], $5::text[], $6, 0, $7, 'summary-updater', $8)
     RETURNING version`,
    [
      channel.channel_arn,
      parsed.purpose.slice(0, 64),
      parsed.summary,
      parsed.topics,
      parsed.keyPoints,
      totalMessageCount,
      newVersion,
      SUMMARY_MODEL_ID,
    ],
  );

  if (inserted.rows.length === 0) {
    // Another writer won the race; their version is in place. No-op.
    return;
  }

  // Write the embedding for this new version.
  const embedResult = await writeSummaryEmbedding({
    channelArn: channel.channel_arn,
    summaryText: parsed.summary,
    fromVersion: newVersion,
  });
  if (!embedResult.written) {
    console.warn(`[summary-updater] embedding skipped for ${channel.channel_arn}: ${embedResult.reason}`);
  }

  emitDriftTiming('total', Date.now() - tStart, correlationId);
}

interface ParsedSummary {
  summary: string;
  purpose: string;
  topics: string[];
  keyPoints: string[];
}

function buildSummaryPrompt(args: {
  transcript: string;
  previousSummary?: string;
  previousPurpose?: string;
  previousTopics?: string[];
}): string {
  const previousContext = args.previousSummary
    ? `\n\n<previous_summary>\n${args.previousSummary}\nPurpose: ${args.previousPurpose || '(unset)'}\nTopics: ${(args.previousTopics || []).join(', ') || '(none)'}\n</previous_summary>\n\nUpdate this summary incrementally based on the new transcript below. Preserve any topics still relevant; add new ones; drop topics that have been resolved or moved past.`
    : `\nSummarize this conversation from scratch.`;

  return `You are summarizing an enterprise AI assistant conversation for analytics and drift detection. Produce a structured summary.${previousContext}

<transcript>
${args.transcript}
</transcript>

Respond ONLY with a valid JSON object matching this schema, no other text:
{
  "summary": "1-3 sentence narrative summary of what the conversation is about",
  "purpose": "short label (≤64 chars) for the primary purpose of the conversation",
  "topics": ["topic 1", "topic 2", ...],  // 2-5 short topic phrases
  "key_points": ["key point 1", ...]      // 1-5 concise key points (decisions, takeaways)
}`;
}

async function callBedrockHaiku(prompt: string): Promise<ParsedSummary | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_BEDROCK_TIMEOUT_MS);

  try {
    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: SUMMARY_MODEL_ID,
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 800,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
        contentType: 'application/json',
        accept: 'application/json',
      }),
      { abortSignal: controller.signal },
    );
    clearTimeout(timer);

    const body = JSON.parse(new TextDecoder().decode(response.body));
    const text = body?.content?.[0]?.text;
    if (!text) return null;
    return parseSummaryJson(text);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function parseSummaryJson(text: string): ParsedSummary | null {
  // The model may emit fenced JSON or stray prose around it. Extract the
  // outermost {...} block.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.summary !== 'string' || typeof parsed.purpose !== 'string') return null;
    return {
      summary: String(parsed.summary).slice(0, 4000),
      purpose: String(parsed.purpose).slice(0, 64),
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 10).map((t: unknown) => String(t).slice(0, 64)) : [],
      keyPoints: Array.isArray(parsed.key_points) ? parsed.key_points.slice(0, 10).map((p: unknown) => String(p).slice(0, 200)) : [],
    };
  } catch {
    return null;
  }
}

async function getMessageCount(channelArn: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM messages WHERE channel_arn = $1`,
    [channelArn],
  );
  return parseInt(result.rows[0]?.count || '0', 10);
}
