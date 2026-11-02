/**
 * Evaluation Runner Lambda
 *
 * Scores agent responses for relevance using Bedrock and Athena.
 * Adapted for Kinesis → S3 → Athena pipeline (no Aurora).
 *
 * Trigger: EventBridge scheduled rule (daily 2am UTC)
 *
 * Pipeline:
 * 1. Query Athena conversations table for previous day's messages
 * 2. Parse NDJSON lines, extract user messages and agent responses
 * 3. Pair into exchanges (user message + next agent response)
 * 4. Score each exchange with Bedrock Haiku
 * 5. When the reply delivered a document, copy it into the archive and grade it as its own row
 *    (`evaluationType: 'document'`, SPEC-EVALUATION FR22)
 * 6. Write evaluation results as NDJSON to S3 evaluations/ prefix
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { stripMessageMarkers } from '../lib/message-markers.js';
import { declaresFinalAnswer } from '../lib/turn-declaration.js';
import { renderPrompt } from '../lib/render-prompt.js';
import { UTILITY_MODEL_ID } from '../../../lib/config/model-strategy.js';
import { decodeContent } from '../lib/chime/history.js';
import { loadProfileRegistry } from '../../../lib/profile-registry';
import { fetchAttachmentBytes } from '../lib/attachment-bytes.js';
import {
  DELIVERED_DOCUMENTS_PREFIX,
  DOCUMENT_FRAMING,
  deliveredDocumentOf,
  documentRequirementsText,
  documentSha256,
  type DeliveredDocumentReference,
  type DocumentSkip,
} from '../lib/delivered-document.js';
import { archiveDeliveredDocument } from '../analytics-aurora/delivered-document-archive.js';

const region = process.env.AWS_REGION_NAME || process.env.AWS_REGION || 'us-east-1';
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET || '';
// The conversation's deliverables (`generated-docs/`), read once per delivered document to make the
// archive's own copy. Unset: no document is copied, and each is recorded as not archived.
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET || '';
/** The longest document the judge is shown, in characters; the same bound the Aurora runner applies. */
const JUDGE_DOCUMENT_MAX_CHARS = Number(process.env.EVAL_DOCUMENT_MAX_CHARS || 100_000);
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || 'agent-echelon-analytics';
const ATHENA_DATABASE = process.env.ATHENA_DATABASE || 'agent_echelon';

const athenaClient = new AthenaClient({ region });
const bedrockClient = new BedrockRuntimeClient({ region });
const s3Client = new S3Client({ region });

// Intent weights for composite scoring, by INTENT and the same for every assistant. A score's
// `agentType` is the assistant's own name (`concierge`, a deployment's own), never a classification
// value, so a table keyed by classification names matched no assistant at all. An intent not listed
// weighs `UNLISTED_INTENT_WEIGHT`.
const INTENT_WEIGHTS: Record<string, number> = {
  'guided_troubleshooting': 0.30,
  'data_extraction': 0.25,
  'report_generation': 0.25,
  'general': 0.15,
  'greeting': 0.025,
  'acknowledgment': 0.025,
};
const UNLISTED_INTENT_WEIGHT = 0.02;

interface Exchange {
  channelArn: string;
  conversationClassification: string;
  agentType: string;
  intent: string;
  userMessage: string;
  agentResponse: string;
  userMessageAt: string;
  agentResponseAt: string;
  // Model + experiment + telemetry fields denormalized from the bot
  // reply's metadata so per-exchange eval rows can power admin queries
  // (Models, Latency, Model Effectiveness, Experiment Results) without
  // a second join back to the conversations table. All optional —
  // older messages or non-fulfillment paths may omit them.
  bedrockModel?: string;
  experimentId?: string;
  variantId?: string;
  latencyMs?: number;
  totalMs?: number;
  pollMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  wasFallback?: boolean;
  assignmentMode?: string;
  deliveryOption?: string;
  // Config attribution — denormalized from the bot reply's
  // analytics metadata so an eval row is sliceable by config (persona/pack), not just model.
  configId?: string;
  personaVersion?: string;
  intentPackVersion?: string;
  systemPromptHash?: string;
  /**
   * The document this reply delivered, from the reference the turn put on the inline Metadata
   * (`inlineDeliveredDocument`: Athena mode has no out-of-band store). Graded as its own row.
   */
  deliveredDocument?: DeliveredDocumentReference;
}

interface RelevanceResult {
  relevanceScore: number;
  directRelevanceScore: number;
  contextAwarenessScore: number;
  completenessScore: number;
  focusScore: number;
  classification: string;
  reasoning: string;
  missedTopics: string[];
  unnecessaryContent: string[];
}

interface EvaluationResult {
  exchangeId: string;
  channelArn: string;
  intentType: string;
  agentType: string;
  /** Absent on a `document_skipped` row, which records that no score was given. */
  relevanceScore?: number;
  classification?: string;
  reasoning?: string;
  evaluatedAt: string;
  // Mirror of Exchange's denormalized metadata. The eval row is the
  // unit the admin dashboard rolls up per (model, intent, experiment),
  // so capturing telemetry here means the analytics queries never need
  // to re-parse conversations metadata. Null when the bot reply lacked
  // the field (older rows, non-fulfillment paths, image-only turns).
  bedrockModel?: string;
  experimentId?: string;
  variantId?: string;
  latencyMs?: number;
  totalMs?: number;
  pollMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  wasFallback?: boolean;
  assignmentMode?: string;
  deliveryOption?: string;
  // Config attribution (P4) — mirrors the Exchange fields above.
  configId?: string;
  personaVersion?: string;
  intentPackVersion?: string;
  systemPromptHash?: string;
  /**
   * WHICH ARTIFACT THE ROW IS ABOUT (SPEC-EVALUATION FR22). `exchange` is the chat reply; `document` is
   * the file the reply delivered, graded from the archive's copy; `document_skipped` is a delivered
   * document that was not graded, with `skipReason`, and carries no score. Every reader of reply scores
   * keeps to `exchange`, so a document score is never pooled into a reply rate.
   */
  evaluationType: 'exchange' | 'document' | 'document_skipped';
  /** On a document row: the archive key of the copy the judge read, and the SHA-256 of its bytes. */
  artifactKey?: string;
  artifactSha256?: string;
  /** On a document row: what kind of document (the producing task type, else `document`). */
  documentKind?: string;
  /** On a `document_skipped` row: why it was not graded. */
  skipReason?: DocumentSkip;
}

// Relevance evaluation prompt
const RELEVANCE_PROMPT = `You are an expert evaluator assessing whether an AI agent's response is relevant to a user's request.

## Context

Agent Type: {{agentType}}
Conversation Classification: {{conversationClassification}}
{{documentFraming}}
## Current Exchange

User Message: {{userMessage}}

Agent Response: {{agentResponse}}

## Evaluation Criteria

Score the response's relevance from 0-100 based on:

1. **Direct Relevance (0-40 points)**: Does the response directly address what the user asked?
2. **Context Awareness (0-20 points)**: Does the response acknowledge relevant context?
3. **Completeness (0-20 points)**: Is the response thorough enough to be useful?
4. **Focus (0-20 points)**: Is the response concise and on-topic?

## Scoring Guidelines

- **90-100 (Excellent)**: Directly and comprehensively addresses the request
- **85-100 (Appropriate Refusal)**: User sent adversarial/jailbreak message and agent correctly refused
- **75-89 (Good)**: Addresses the main request with minor gaps
- **50-74 (Partial)**: Partially addresses the request but misses key aspects
- **25-49 (Poor)**: Has some relation but largely misses the point
- **0-24 (Irrelevant)**: Does not address the user's actual request

## Output Format

Respond with JSON only, no markdown code blocks:

{
  "relevanceScore": <0-100>,
  "directRelevanceScore": <0-40>,
  "contextAwarenessScore": <0-20>,
  "completenessScore": <0-20>,
  "focusScore": <0-20>,
  "classification": "<excellent|good|partial|poor|irrelevant|appropriate_refusal>",
  "reasoning": "<brief explanation>",
  "missedTopics": ["<any user topics not addressed>"],
  "unnecessaryContent": ["<any off-topic additions>"]
}`;

/**
 * Execute Athena query and wait for results
 */
async function executeAthenaQuery(query: string): Promise<string[][]> {
  const startResult = await athenaClient.send(new StartQueryExecutionCommand({
    QueryString: query,
    WorkGroup: ATHENA_WORKGROUP,
    QueryExecutionContext: { Database: ATHENA_DATABASE },
  }));

  const queryId = startResult.QueryExecutionId!;

  // Poll for completion
  let state = 'RUNNING';
  while (state === 'RUNNING' || state === 'QUEUED') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const status = await athenaClient.send(new GetQueryExecutionCommand({
      QueryExecutionId: queryId,
    }));
    state = status.QueryExecution?.Status?.State || 'FAILED';
  }

  if (state !== 'SUCCEEDED') {
    throw new Error(`Athena query failed with state: ${state}`);
  }

  // Fetch results
  const results = await athenaClient.send(new GetQueryResultsCommand({
    QueryExecutionId: queryId,
  }));

  const rows = results.ResultSet?.Rows || [];
  // Skip header row
  return rows.slice(1).map(row =>
    (row.Data || []).map(cell => cell.VarCharValue || '')
  );
}

/**
 * Query Athena for a target day's exchanges (defaults to yesterday for
 * the EventBridge nightly run; manual invocations can pass
 * `{ "targetDate": "YYYY-MM-DD" }` to backfill, validate, or re-score a
 * specific day).
 */
async function getExchangesFromAthena(targetDate?: string): Promise<Exchange[]> {
  // targetDate flows into Athena SQL via year/month/day below. Today the values
  // are derived from a parsed
  // Date so they're numeric and safe, but the only protection is the
  // implicit round-trip — a one-line refactor to pass the raw string
  // straight into SQL would reopen injection. Apply the same strict
  // ISO regex the dashboard's analytics-query handler uses, before the
  // Date parse.
  if (targetDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error(`Invalid targetDate: ${targetDate} (expected YYYY-MM-DD)`);
  }
  const target = targetDate
    ? new Date(`${targetDate}T00:00:00Z`)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (isNaN(target.getTime())) {
    throw new Error(`Invalid targetDate: ${targetDate} (expected YYYY-MM-DD)`);
  }
  const year = target.getUTCFullYear().toString();
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  console.log(`Evaluating exchanges for ${year}-${month}-${day}`);

  // Restrict to message events. The conversations table also archives
  // CREATE_CHANNEL, CREATE_CHANNEL_MEMBERSHIP, UPDATE_CHANNEL, etc. -
  // those have no Sender and would confuse the pairing pass below. We
  // include BOTH CREATE_CHANNEL_MESSAGE and UPDATE_CHANNEL_MESSAGE
  // because for Lex / placeholder-then-final flows the bot's real reply
  // arrives as an UPDATE of the original CREATE row; pairing collapses
  // to (MessageId -> latest content) below.
  const query = `
SELECT
  json_extract_scalar(line, '$.Payload.MessageId') as message_id,
  json_extract_scalar(line, '$.Payload.ChannelArn') as channel_arn,
  json_extract_scalar(line, '$.Payload.Content') as content,
  json_extract_scalar(line, '$.Payload.Sender.Arn') as sender_arn,
  json_extract_scalar(line, '$.Payload.Metadata') as metadata,
  json_extract_scalar(line, '$.Payload.CreatedTimestamp') as created_at,
  json_extract_scalar(line, '$.EventType') as event_type
FROM ${ATHENA_DATABASE}.conversations
WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  AND json_extract_scalar(line, '$.EventType') IN ('CREATE_CHANNEL_MESSAGE', 'UPDATE_CHANNEL_MESSAGE')
ORDER BY channel_arn, created_at
  `;

  const rows = await executeAthenaQuery(query);

  // Parse rows. CREATE and UPDATE for the same MessageId both appear
  // (the bot posts a placeholder, then edits in the final content).
  // We collapse to one logical message per MessageId, taking the LAST
  // content/metadata seen (UPDATE wins over CREATE in chronological
  // order). The CREATE timestamp is what we report as createdAt so
  // user-then-bot ordering still respects the original send time.
  type Msg = {
    messageId: string;
    channelArn: string;
    content: string;
    senderArn: string;
    metadata: string;
    createdAt: string;
  };
  const byId = new Map<string, Msg>();
  for (const row of rows) {
    const id = row[0];
    if (!id) continue;
    const existing = byId.get(id);
    const next: Msg = {
      messageId: id,
      channelArn: row[1] || existing?.channelArn || '',
      content: decodeContent(row[2] || ''),
      senderArn: row[3] || existing?.senderArn || '',
      metadata: row[4] || existing?.metadata || '',
      // Preserve the CREATE timestamp; UPDATEs would shift ordering.
      createdAt: existing?.createdAt || row[5] || '',
    };
    byId.set(id, next);
  }
  const messages = Array.from(byId.values()).sort(
    (a, b) =>
      a.channelArn.localeCompare(b.channelArn) ||
      a.createdAt.localeCompare(b.createdAt)
  );

  // Pair user messages with agent responses. The bot frequently posts a
  // placeholder ("One moment...", "Analyzing...", or any content
  // containing the <!--corr:--> marker) before its real reply, and may
  // ALSO emit a second bot message (a continuation, a battle rival,
  // etc.) before the user's next turn. The naive i,i+1 pairing missed
  // both of these; instead we walk forward from each user message to
  // find the next non-placeholder bot reply in the same channel that
  // arrives before the user's next message in that channel.
  //
  // AND A TURN THAT DECLARED IT IS FINISHED IS NOT ONE, however it is marked (2026-09-11). A DIRECT
  // answer now carries a correlation marker so it can be paired; it posts once and no update
  // follows. Skipped as a placeholder, the walk below would keep going and hand this user message to
  // somebody ELSE'S reply to be judged against - a mispairing inside the judge, which is worse than
  // not judging the turn at all.
  const isPlaceholder = (content: string): boolean =>
    !declaresFinalAnswer(content) && (
      content.includes('<!--corr:') ||
      content === 'One moment...' ||
      content === 'Analyzing...'
    );

  const exchanges: Exchange[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.senderArn?.includes('/bot/')) continue; // user turns only
    if (!current.channelArn) continue;

    // Find the next real bot reply in this channel before the same
    // user sends again.
    let next: typeof messages[number] | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const cand = messages[j];
      if (cand.channelArn !== current.channelArn) continue;
      if (!cand.senderArn?.includes('/bot/')) break; // user took another turn first
      if (isPlaceholder(cand.content)) continue;
      next = cand;
      break;
    }
    if (!next) continue;

    // Extract analytics metadata from bot response
    let agentType = 'unknown';
    let intent = 'unknown';
    let conversationClassification = 'unknown';
    // Config attribution (P4) — denormalize the config fingerprint so eval rows slice by config.
    let configId: string | undefined;
    let personaVersion: string | undefined;
    let intentPackVersion: string | undefined;
    let systemPromptHash: string | undefined;
    let deliveredDocument: DeliveredDocumentReference | undefined;

    if (next.metadata) {
      try {
        const meta = JSON.parse(next.metadata);
        deliveredDocument = deliveredDocumentOf(meta);
        const analytics = meta.analytics || meta;
        agentType = analytics.agentType || 'unknown';
        intent = analytics.intent || 'unknown';
        conversationClassification = analytics.classification || 'unknown';
        configId = analytics.configId;
        personaVersion = analytics.personaVersion;
        intentPackVersion = analytics.intentPackVersion;
        systemPromptHash = analytics.systemPromptHash;
      } catch {
        // Metadata parse failed
      }
    }

    exchanges.push({
      channelArn: current.channelArn,
      conversationClassification,
      agentType,
      intent,
      userMessage: current.content,
      agentResponse: next.content,
      userMessageAt: current.createdAt,
      agentResponseAt: next.createdAt,
      ...(configId && { configId }),
      ...(personaVersion && { personaVersion }),
      ...(intentPackVersion && { intentPackVersion }),
      ...(systemPromptHash && { systemPromptHash }),
      ...(deliveredDocument && { deliveredDocument }),
    });
  }

  return exchanges;
}

/**
 * Evaluate a single exchange using Bedrock Haiku.
 *
 * `artifact` is a delivered document (SPEC-EVALUATION FR22): the same rubric, with the document in the
 * place of the reply and the shared document framing (`DOCUMENT_FRAMING`) in the context. Absent, the
 * reply is scored and the framing placeholder renders empty.
 */
async function evaluateExchange(exchange: Exchange, artifact?: { text: string; framing: string }): Promise<RelevanceResult> {
  // Strip internal markers from content before evaluation. A document is a file, not a chat message:
  // it carries no markers, and stripping would rewrite content the judge has to see as delivered.
  const cleanUserMessage = stripMarkers(exchange.userMessage);
  const cleanAgentResponse = artifact ? artifact.text : stripMarkers(exchange.agentResponse);

  // THE SAME RENDERER THE AURORA RUNNER USES, and this file is the reason the fix has to reach both:
  // it is the runner Athena mode deploys, Athena mode is the default, and a chained `.replace` lets a
  // message containing `` $` `` splice the surrounding rubric into the evidence. See
  // `lib/render-prompt.ts` for the two defects and why one pass through a replacer closes both.
  const prompt = renderPrompt(RELEVANCE_PROMPT, {
    agentType: exchange.agentType,
    conversationClassification: exchange.conversationClassification,
    documentFraming: artifact ? artifact.framing : '',
    userMessage: cleanUserMessage,
    agentResponse: cleanAgentResponse,
  });

  const command = new InvokeModelCommand({
    modelId: UTILITY_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const responseText = responseBody.content[0]?.text || '{}';

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : responseText;

  try {
    return JSON.parse(jsonStr);
  } catch {
    return {
      relevanceScore: 50,
      directRelevanceScore: 20,
      contextAwarenessScore: 10,
      completenessScore: 10,
      focusScore: 10,
      classification: 'partial',
      reasoning: 'Evaluation parse error - defaulted to partial score',
      missedTopics: [],
      unnecessaryContent: [],
    };
  }
}

/**
 * Write evaluation results to S3
 */
async function writeResults(results: EvaluationResult[]): Promise<void> {
  if (results.length === 0) return;

  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const timestamp = now.toISOString().replace(/[:.]/g, '-');

  const ndjson = results.map(r => JSON.stringify(r)).join('\n');

  await s3Client.send(new PutObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: `evaluations/year=${year}/month=${month}/day=${day}/eval-${timestamp}.ndjson`,
    Body: ndjson,
    ContentType: 'application/x-ndjson',
  }));

  console.log(`Wrote ${results.length} evaluation results to S3`);
}

/**
 * Write daily agent scores to S3
 */
async function writeAgentScores(
  results: EvaluationResult[]
): Promise<Record<string, number>> {
  const agentScores: Record<string, number> = {};

  // Group by agent type and intent
  const byAgent: Record<string, Record<string, number[]>> = {};
  // REPLIES ONLY. An agent score is a reply score; a delivered document's grade is a different
  // artifact and is reported on its own rows, never averaged into this one.
  for (const result of results) {
    if (result.evaluationType !== 'exchange' || typeof result.relevanceScore !== 'number') continue;
    if (!byAgent[result.agentType]) byAgent[result.agentType] = {};
    if (!byAgent[result.agentType][result.intentType]) byAgent[result.agentType][result.intentType] = [];
    byAgent[result.agentType][result.intentType].push(result.relevanceScore);
  }

  for (const [agentType, intents] of Object.entries(byAgent)) {
    const weights = INTENT_WEIGHTS;
    let weightedSum = 0;
    let totalWeight = 0;

    for (const [intent, scores] of Object.entries(intents)) {
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const weight = weights[intent] || UNLISTED_INTENT_WEIGHT;
      weightedSum += avgScore * weight;
      totalWeight += weight;
    }

    agentScores[agentType] = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  }

  // Write to S3
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  await s3Client.send(new PutObjectCommand({
    Bucket: ARCHIVE_BUCKET,
    Key: `agent-scores/${dateStr}.json`,
    Body: JSON.stringify({
      date: dateStr,
      scores: agentScores,
      totalExchanges: results.filter((r) => r.evaluationType === 'exchange').length,
    }),
    ContentType: 'application/json',
  }));

  return agentScores;
}

// Deterministic strip of ALL internal markers (shared source of truth with the
// SPA parser + the Aurora eval runner), so the judge never sees a raw marker.
const stripMarkers = stripMessageMarkers;

/**
 * GRADE THE DOCUMENT A REPLY DELIVERED, AS ITS OWN ROW (SPEC-EVALUATION FR22), in Athena mode.
 *
 * THE ARCHIVE COPY IS MADE HERE. In Aurora mode archival copies the document into the archive as it
 * archives the message; the Firehose that archives messages in Athena mode delivers records to S3 and
 * runs no code that could read a second object. This runner is the first code in this mode that sees the
 * reference, so it makes the same copy with the same module (`archiveDeliveredDocument`: only a file
 * under the conversation's own `generated-docs/<conversationId>/`, verified against the recorded
 * SHA-256, written to `delivered-documents/<classification>/<conversationId>/<sha256>`), then reads the
 * archive's copy back and grades that. The copy is keyed by content, so re-running a day writes the
 * same object again.
 *
 * NOT GRADED, AND SAID SO, on the same grounds as Aurora mode: a private task's document, no copy, a
 * copy that does not match or cannot be read, an empty one or one longer than the judge is shown. Each
 * writes a `document_skipped` row naming the reason and carrying no score. A judge call that throws is
 * counted as an error and writes nothing; this mode has no attempt ledger, and re-running the day
 * (`{ "targetDate": "YYYY-MM-DD" }`) grades it again.
 */
async function gradeDeliveredDocument(exchange: Exchange, exchangeId: string): Promise<EvaluationResult> {
  const doc = exchange.deliveredDocument!;
  const base: EvaluationResult = {
    exchangeId,
    channelArn: exchange.channelArn,
    intentType: exchange.intent,
    agentType: exchange.agentType,
    evaluatedAt: new Date().toISOString(),
    evaluationType: 'document_skipped',
    artifactSha256: doc.sha256,
    documentKind: doc.kind || 'document',
    ...(exchange.configId && { configId: exchange.configId }),
    ...(exchange.personaVersion && { personaVersion: exchange.personaVersion }),
    ...(exchange.intentPackVersion && { intentPackVersion: exchange.intentPackVersion }),
    ...(exchange.systemPromptHash && { systemPromptHash: exchange.systemPromptHash }),
  };
  const skip = (why: DocumentSkip): EvaluationResult => {
    console.warn(`[eval] document for exchange ${exchangeId} not graded: ${why}`);
    return { ...base, skipReason: why };
  };
  if (doc.private) return skip('private');

  const archived = await archiveDeliveredDocument({
    s3: s3Client as never,
    attachmentsBucket: ATTACHMENTS_BUCKET,
    archiveBucket: ARCHIVE_BUCKET,
    channelArn: exchange.channelArn,
    classification: exchange.conversationClassification !== 'unknown' ? exchange.conversationClassification : undefined,
    reference: doc,
  });
  const archiveKey = archived.archiveKey;
  if (!archiveKey || !archiveKey.startsWith(DELIVERED_DOCUMENTS_PREFIX)) return skip('not-archived');

  let bytes: Uint8Array;
  try {
    bytes = await fetchAttachmentBytes(s3Client, ARCHIVE_BUCKET, archiveKey);
  } catch {
    return skip('unreadable');
  }
  if (documentSha256(bytes) !== doc.sha256) return skip('hash-mismatch');
  const text = Buffer.from(bytes).toString('utf-8');
  if (!text.trim()) return skip('empty');
  if (text.length > JUDGE_DOCUMENT_MAX_CHARS) return skip('too-long');

  const framing = renderPrompt(DOCUMENT_FRAMING, { requirements: documentRequirementsText(doc) });
  const relevance = await evaluateExchange(exchange, { text, framing });
  return {
    ...base,
    evaluationType: 'document',
    relevanceScore: relevance.relevanceScore,
    classification: relevance.classification,
    reasoning: relevance.reasoning,
    artifactKey: archiveKey,
  };
}

/**
 * Main handler
 */
export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  console.log('Evaluation runner invoked');

  // Manual invocations may pass { targetDate: "YYYY-MM-DD" } to score a
  // specific day; nightly EventBridge runs pass an empty object and
  // fall back to "yesterday".
  const targetDate =
    typeof event === 'object' && event !== null && 'targetDate' in event
      ? String((event as { targetDate?: unknown }).targetDate || '')
      : undefined;

  try {
    // Get exchanges from Athena
    const exchanges = await getExchangesFromAthena(targetDate);

    if (exchanges.length === 0) {
      console.log('No exchanges found for evaluation');
      return { statusCode: 200, body: JSON.stringify({ evaluated: 0 }) };
    }

    console.log(`Found ${exchanges.length} exchanges to evaluate`);

    // Evaluate each exchange
    const results: EvaluationResult[] = [];
    const errors: string[] = [];
    let documentErrors = 0;

    for (const exchange of exchanges) {
      try {
        const relevance = await evaluateExchange(exchange);
        const exchangeId = `${exchange.channelArn.split('/').pop()}-${exchange.userMessageAt}`;

        results.push({
          exchangeId,
          channelArn: exchange.channelArn,
          intentType: exchange.intent,
          agentType: exchange.agentType,
          relevanceScore: relevance.relevanceScore,
          classification: relevance.classification,
          reasoning: relevance.reasoning,
          evaluatedAt: new Date().toISOString(),
          evaluationType: 'exchange',
          // Config attribution (P4) — carry the fingerprint onto the eval row.
          ...(exchange.configId && { configId: exchange.configId }),
          ...(exchange.personaVersion && { personaVersion: exchange.personaVersion }),
          ...(exchange.intentPackVersion && { intentPackVersion: exchange.intentPackVersion }),
          ...(exchange.systemPromptHash && { systemPromptHash: exchange.systemPromptHash }),
        });
      } catch (err) {
        errors.push(`Exchange evaluation failed: ${err instanceof Error ? err.message : 'Unknown'}`);
        continue;
      }

      // THE DELIVERED DOCUMENT, after its reply and only when the reply was scored, so the document is
      // drawn from the same population. Its own try: a document that fails leaves the reply's row as it is.
      if (exchange.deliveredDocument) {
        const exchangeId = `${exchange.channelArn.split('/').pop()}-${exchange.userMessageAt}`;
        try {
          results.push(await gradeDeliveredDocument(exchange, exchangeId));
        } catch (err) {
          documentErrors += 1;
          console.warn(`[eval] document for exchange ${exchangeId} could not be graded:`, err instanceof Error ? err.message : String(err));
        }
      }
    }

    // Write results to S3
    await writeResults(results);

    // Compute and write agent scores
    const agentScores = await writeAgentScores(results);

    // Reply rows only: the headline average is a reply score, and a document's grade is not one.
    const replies = results.filter((r) => r.evaluationType === 'exchange');
    const avgScore = replies.length > 0
      ? Math.round(replies.reduce((sum, r) => sum + (r.relevanceScore ?? 0), 0) / replies.length * 10) / 10
      : 0;

    const summary = {
      evaluated: replies.length,
      errors: errors.length,
      avgRelevanceScore: avgScore,
      agentScores,
      documentsScored: results.filter((r) => r.evaluationType === 'document').length,
      documentsSkipped: results.filter((r) => r.evaluationType === 'document_skipped').length,
      documentErrors,
    };

    console.log('Evaluation complete:', summary);
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('Evaluation runner error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown' }) };
  }
}
