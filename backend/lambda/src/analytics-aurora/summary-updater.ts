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
 * - Event-driven first: archival calls `summarizeChannelsNow` for the conversations
 *   whose new messages it has just written, so a summary follows the conversation turn by turn. This
 *   scheduled scan is the reconciliation backstop (tenet D6) for what that path deferred or failed, not
 *   the primary mechanism. Both run the same `processChannel`, so there is one summary writer.
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
import { query, ensureSchema } from './db-client.js';
import { writeSummaryEmbedding } from './embedding-writer.js';
import { emitDriftCounter, emitDriftTiming, newCorrelationId } from '../lib/emf-metrics.js';
import { UTILITY_MODEL_ID } from '../../../lib/config/model-strategy.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';
import { supersededUpdateSql } from './update-events.js';

const SUMMARY_MODEL_ID = process.env.SUMMARY_MODEL_ID || UTILITY_MODEL_ID;
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
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const startedAt = Date.now();
  console.log('[summary-updater] run start', { event });

  // Apply any pending migration first. `schema-init` bootstraps on Create only and can never
  // reconnect, so runtime application is the ONLY way a new migration reaches an existing cluster -
  // and it happens where `ensureSchema` is called, not where the schema files are bundled. Memoized
  // per instance; pinned by `db-lambdas-apply-migrations.test.ts`.
  await ensureSchema();

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

/**
 * Seed a conversation's FIRST summary from the opening exchange, so drift has an anchor from
 * turn one instead of waiting up to a full scheduler interval (the `drift_skipped_no_summary`
 * window, during which drift cannot fire at all).
 *
 * The exchange is passed IN by the caller rather than read from a store. The reply handler already
 * holds both messages when it responds, and Aurora `messages` is a projection fed by Kinesis then
 * archival - seeding from it would inherit exactly the lag this exists to remove. (Amazon Chime SDK
 * Messaging is the authoritative conversation; neither store is consulted here.)
 *
 * Idempotent: a conversation that already has ANY summary is left alone, so a caller may invoke this
 * without tracking whether the turn was genuinely the first.
 */
/**
 * Seed a SPLIT-OUT conversation's summary from the topic that created it, before it has any messages.
 *
 * A conversation created by accepting a drift offer is the one case where the topic is known ahead of
 * the first turn: the person was asked "shall I move that to a separate conversation?" and said yes,
 * so the subject is settled and in their own words. Writing it down at creation means drift in the new
 * conversation has a real anchor from its very first message, instead of comparing message two against
 * a seed built from message one - which is the thin-anchor case `detectDrift` refuses.
 *
 * NO MODEL CALL. Every other summary is written by Bedrock because it has to compress a transcript;
 * this one has nothing to compress. The topic label and the person's own words ARE the summary, so
 * asking a model to restate them would add a call, a failure mode and a latency to the creation path
 * in exchange for nothing.
 *
 * Stamped `drift-spawn` rather than `summary-seed`, which is what lets drift tell the two version-1
 * anchors apart. Idempotent in the same way as the turn-one seed: an existing summary wins.
 */
export async function seedSummaryFromDriftTopic(input: {
  channelArn: string;
  topicLabel: string;
  originatingMessageText?: string;
}): Promise<{ seeded: boolean; reason?: string }> {
  const { channelArn, topicLabel } = input;
  const originating = (input.originatingMessageText || '').trim();
  if (!channelArn || !topicLabel.trim()) return { seeded: false, reason: 'no-topic' };

  const existing = await query<{ version: number }>(
    `SELECT version FROM conversation_summaries WHERE channel_arn = $1 LIMIT 1`,
    [channelArn],
  );
  if (existing.rows.length > 0) return { seeded: false, reason: 'already-summarised' };

  // The person's words carry more of the subject than the label, which is truncated for a sidebar.
  // Both, when both exist, so the embedding sees the full subject and a reader sees a clean purpose.
  const summaryText = originating ? `${topicLabel}. ${originating}` : topicLabel;

  const inserted = await query<{ version: number }>(
    `INSERT INTO conversation_summaries (
       channel_arn, purpose, summary, topics, key_points, version, generated_by, model_used
     ) VALUES ($1, $2, $3, $4::text[], $5::text[], 1, 'drift-spawn', NULL)
     ON CONFLICT (channel_arn, version) DO NOTHING
     RETURNING version`,
    [channelArn, topicLabel.slice(0, 64), summaryText, [topicLabel.slice(0, 64)], []],
  );
  if (inserted.rows.length === 0) return { seeded: false, reason: 'already-summarised' };

  try {
    // `drift-spawn`, matching the row written just above: this conversation was split out of another
    // one, so it has its topic before its first message. The anchor has to say so, or a reader at
    // version 1 cannot tell it from an ordinary new conversation with nothing to drift from.
    await writeSummaryEmbedding({ channelArn, summaryText, fromVersion: 1, generatedBy: 'drift-spawn' });
  } catch (err) {
    // The row is what marks this anchor as a real topic; the embedding writer catches up on the next
    // scheduled run. Do not fail the seed over it - the conversation already exists either way.
    console.warn(`[summary-updater][drift-seed] embedding write failed for ${channelArn}:`, err);
  }

  console.log(`[summary-updater][drift-seed] seeded v1 from the drift topic for ${channelArn}`);
  return { seeded: true };
}

export async function seedSummaryFromExchange(input: {
  channelArn: string;
  userMessage: string;
  assistantReply: string;
}): Promise<{ seeded: boolean; reason?: string }> {
  const correlationId = newCorrelationId();
  const { channelArn, userMessage, assistantReply } = input;
  if (!channelArn || !userMessage || !assistantReply) {
    return { seeded: false, reason: 'incomplete-exchange' };
  }

  const existing = await query<{ version: number }>(
    `SELECT version FROM conversation_summaries WHERE channel_arn = $1 LIMIT 1`,
    [channelArn],
  );
  if (existing.rows.length > 0) return { seeded: false, reason: 'already-summarised' };

  const transcript = `User: ${userMessage.slice(0, 4000)}\nAssistant: ${assistantReply.slice(0, 4000)}`;
  const tBedrock = Date.now();
  let parsed: ParsedSummary | null = null;
  try {
    parsed = await callBedrockHaiku(buildSummaryPrompt({ transcript }));
  } catch (err) {
    console.warn(`[summary-updater][seed] Bedrock call failed for ${channelArn}:`, err);
  }
  emitDriftTiming('comparison', Date.now() - tBedrock, correlationId);
  if (!parsed) return { seeded: false, reason: 'summarisation-failed' };

  // `name`, `message_count` and `participant_count` were DROPPED (ADR-020, migration 015): each
  // described CHANNEL STATE, and this row is versioned and never rewritten, so a value copied here
  // was frozen at one summarization. Their live homes are the Amazon Chime SDK channel /
  // `channel_registry`, `messages`, and `channel_membership`.
  const inserted = await query<{ version: number }>(
    `INSERT INTO conversation_summaries (
       channel_arn, purpose, summary, topics, key_points, version, generated_by, model_used
     ) VALUES ($1, $2, $3, $4::text[], $5::text[], 1, 'summary-seed', $6)
     ON CONFLICT (channel_arn, version) DO NOTHING
     RETURNING version`,
    [
      channelArn,
      parsed.purpose.slice(0, 64),
      parsed.summary,
      parsed.topics,
      parsed.keyPoints,
      SUMMARY_MODEL_ID,
    ],
  );
  // Lost the race with a concurrent seed or the scheduled scan. Their row stands.
  if (inserted.rows.length === 0) return { seeded: false, reason: 'already-summarised' };

  try {
    await writeSummaryEmbedding({
      channelArn, summaryText: parsed.summary, fromVersion: 1, generatedBy: 'summary-seed', topics: parsed.topics,
    });
  } catch (err) {
    // The row is what unblocks drift's cold start; the embedding writer will catch up on the next
    // scheduled run. Do not fail the seed over it.
    console.warn(`[summary-updater][seed] embedding write failed for ${channelArn}:`, err);
  }

  console.log(`[summary-updater][seed] seeded v1 for ${channelArn}`);
  return { seeded: true };
}

/** How many conversations one archival batch summarizes at once; the rest wait for the scheduled scan. */
const SUMMARY_ON_ARCHIVE_MAX = Number(process.env.SUMMARY_ON_ARCHIVE_MAX || '3');

/**
 * SUMMARIZE THESE CONVERSATIONS NOW, because their new messages were just archived.
 *
 * The summary used to move only on the 30-minute schedule, so a conversation's subjects lagged it by up
 * to half an hour, and drift compared each turn against a picture of the conversation that old. Archival
 * is where new messages land, so it calls this once the batch is written: the transcript is already in
 * Aurora, and `processChannel` reads it through the same filter that keeps a privately addressed message
 * out of the summary everyone reads. An in-memory refresh would skip that filter, which is why this reads
 * the store.
 *
 * BOUNDED, and the schedule catches up: at most `SUMMARY_ON_ARCHIVE_MAX` conversations per batch, each one
 * only if it has a message newer than its latest summary. Never throws: a failed summary is the
 * scheduled scan's to repeat, and archival must not fail over it.
 */
export async function summarizeChannelsNow(channelArns: string[]): Promise<{ summarized: number; deferred: number }> {
  const unique = [...new Set(channelArns.filter(Boolean))];
  const now = unique.slice(0, SUMMARY_ON_ARCHIVE_MAX);
  let summarized = 0;
  for (const channelArn of now) {
    try {
      const [channel] = await findActiveChannels(channelArn);
      if (!channel) continue;
      const lastSummary = Date.parse(channel.last_summary_at ?? '');
      if (Number.isFinite(lastSummary) && lastSummary >= Date.parse(channel.newest_message_at)) continue;
      await processChannel(channel);
      summarized++;
    } catch (err) {
      console.warn('[summary-updater] event-driven summary failed; the scheduled scan will retry', {
        channelArn, err: (err as { name?: string })?.name ?? err,
      });
    }
  }
  return { summarized, deferred: unique.length - now.length };
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
    // A TARGETED MESSAGE IS NOT PART OF THE CONVERSATION'S SHARED SUBJECT. Targeted content never
    // enters a shared summary, so what one member said to another stays between them.
    //
    // `target_arn` holds the one member a message was addressed to (ADR-034: addressing a message is
    // not the same as making it private, and `Target` carries exactly one member). This select had no
    // predicate on it, so a privately-addressed question AND the assistant's targeted reply to it were
    // both summarized into the channel-wide summary - the one every member can read through the
    // console, and the one drift builds its anchor from.
    //
    // THE BLAST RADIUS IS WIDER THAN THE SUMMARY TEXT, which is why this is the right place to fix it
    // rather than at a reader. `summary_embeddings` is embedded FROM this summary, and the per-subject
    // rows in `conversation_topic_embeddings` are embedded from the `topics[]` it returned. Filtering
    // here keeps private content out of all three with one predicate; filtering at each consumer would
    // be three chances to forget.
    //
    // IT IS THE ROOM'S SUBJECT THAT IS BEING SUMMARIZED. A message sent to one person is not evidence
    // about what the room is discussing, so excluding it is not only a privacy rule - it also stops a
    // side conversation dragging the anchor off the subject everybody else is on.
    `SELECT sender_name, is_bot, content, created_at
       FROM messages m
      WHERE channel_arn = $1
        AND event_type IN ('CREATE_CHANNEL_MESSAGE', 'UPDATE_CHANNEL_MESSAGE')
        -- ONE UPDATE PER MESSAGE, ITS LATEST (migration 084). Every update is its own row, and a
        -- placeholder's queue notice or receipt is not what the room said; the latest is the text the
        -- message holds now.
        AND NOT (event_type = 'UPDATE_CHANNEL_MESSAGE' AND ${supersededUpdateSql('m')})
        AND content IS NOT NULL
        AND content <> ''
        AND target_arn IS NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [channel.channel_arn, SUMMARY_MAX_MESSAGES],
  );
  emitDriftTiming('summary_fetch', Date.now() - tMsgStart, correlationId);

  // NO PERSON HAS SPOKEN, SO THERE IS NO SUBJECT YET. A conversation holding only the assistant's welcome
  // was summarized from the welcome, and that summary became drift's anchor: the person's first real
  // question then read as a change of subject and drew an offer instead of an answer. The summary waits
  // for the first message a person sends. Messages only, above: channel and membership events carry a
  // channel or member name in `content`, and with the service admin as their sender they read as a
  // person speaking.
  if (!messages.rows.some((m) => !m.is_bot)) {
    console.log('[summary-updater] no message from a person yet; nothing to summarize', { channelArn: channel.channel_arn });
    return;
  }

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
    generated_by: string | null;
  }>(
    `SELECT version, summary, purpose, topics, generated_by
       FROM conversation_summaries
      WHERE channel_arn = $1
      ORDER BY version DESC
      LIMIT 1`,
    [channel.channel_arn],
  );
  const previous = existingSummary.rows[0];
  const previousVersion = previous?.version || 0;

  // ── A TURN-ONE SEED IS NOT CARRIED FORWARD, AND THAT IS WHAT KEEPS THE TARGETING FILTER HONEST ──
  //
  // The filter on the transcript above excludes a message addressed to one member. It cannot reach
  // `seedSummaryFromExchange`, which is handed the opening exchange IN MEMORY precisely to avoid the
  // archival lag, so a targeted first turn still seeds version 1 from private content. Feeding that
  // version forward as `previousSummary` would carry it into every later version and past the filter
  // permanently - the transcript would be clean and the anchor context would not.
  //
  // Dropping it costs nothing in the ordinary case: the seed was built from the same opening exchange
  // that is in the transcript, so a rebuild sees it anyway. In the case that matters the exchange is
  // absent from the transcript BECAUSE it was targeted, and it should be absent from the summary too.
  //
  // `drift-spawn` IS carried forward, and the difference is not arbitrary. That version 1 is seeded
  // from the topic the person accepted when they agreed to split the conversation out - their own
  // words about what the new conversation is for, shared by construction - and a split-out
  // conversation may have no messages of its own yet, so dropping it would leave the anchor empty.
  const previousIsTurnOneSeed = previous?.generated_by === 'summary-seed';
  const carried = previousIsTurnOneSeed ? undefined : previous;
  if (previousIsTurnOneSeed) {
    console.log('[summary-updater] rebuilding from the transcript rather than extending the turn-one seed', {
      channelArn: channel.channel_arn, previousVersion,
    });
  }

  // Build the Bedrock prompt.
  const reversedMessages = messages.rows.slice().reverse(); // chronological
  const transcript = reversedMessages
    .map((m) => `${m.is_bot ? 'Assistant' : m.sender_name || 'User'}: ${(m.content || '').slice(0, 1000)}`)
    .join('\n');

  const prompt = buildSummaryPrompt({
    transcript,
    previousSummary: carried?.summary || undefined,
    previousPurpose: carried?.purpose || undefined,
    previousTopics: carried?.topics || undefined,
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

  // `name`, `participant_count` and `message_count` were DROPPED (ADR-020, migration 015) - all three
  // described CHANNEL STATE, and this row is versioned and never rewritten, so any value copied here
  // was frozen at one summarization and wrong from the next change onward.
  const inserted = await query<{ version: number }>(
    `INSERT INTO conversation_summaries (
       channel_arn, purpose, summary, topics, key_points, version, generated_by, model_used
     ) VALUES ($1, $2, $3, $4::text[], $5::text[], $6, 'summary-updater', $7)
     ON CONFLICT (channel_arn, version) DO NOTHING
     RETURNING version`,
    [
      channel.channel_arn,
      parsed.purpose.slice(0, 64),
      parsed.summary,
      parsed.topics,
      parsed.keyPoints,
      newVersion,
      SUMMARY_MODEL_ID,
    ],
  );

  if (inserted.rows.length === 0) {
    // Another writer won the race; their version is in place. No-op: no embedding is written for a
    // version this run did not write, and the channel is not counted as failed.
    console.log('[summary-updater] another writer holds this version; nothing to write', {
      channelArn: channel.channel_arn, version: newVersion,
    });
    return;
  }

  // Write the embedding for this new version.
  const embedResult = await writeSummaryEmbedding({
    channelArn: channel.channel_arn,
    summaryText: parsed.summary,
    fromVersion: newVersion,
    generatedBy: 'summary-updater',
    // FR5: the subjects THEMSELVES, not only their average. Same version, same call, so the anchor
    // and the subjects can never describe different summaries.
    topics: parsed.topics,
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

// `name`, `message_count` and `participant_count` are DELIBERATELY left NULL on conversation_summaries.
//
// All three describe CHANNEL STATE, and a conversation_summaries row is VERSIONED and never
// rewritten - so a value copied in here is frozen at one summarization and wrong from the next
// change onward. Unfixable by construction, not merely hard to keep in sync (ADR-020):
//
//   name              -> the Amazon Chime SDK channel is authoritative (set on the first turn by
//                        `maybeDeriveAndRenameChannel`, and renameable by the user afterwards).
//                        Readers derive it from the ARCHIVED channel events - the latest
//                        CREATE/UPDATE_CHANNEL row - which is what both the admin Conversations list
//                        and the analytics conversation list do; `channel_registry.channel_name`
//                        mirrors the same events via `syncChannelRegistryRecords`. Having the
//                        summariser generate its own name would create a SECOND name that can
//                        disagree with the one the user actually sees.
//   participant_count -> `channel_membership`, maintained live from the Kinesis membership events
//                        (`syncMembershipRecords`). Read it when needed:
//                        SELECT COUNT(*) FROM channel_membership WHERE channel_arn = $1
//   message_count     -> counted at read time from `messages`. It previously stored the channel
//                        TOTAL, which is channel state, not a fact about this summary version. No
//                        consumer ever read it: every "messages" figure in the console counts live
//                        or reads `conversations.message_count`.
//
// Nothing reads any of the three, so NULL removes a wrong value rather than a useful one. The
// incremental watermark is `updated_at`, not a count. Migration 015 drops all three columns.
