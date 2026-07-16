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
 * 5. Write evaluation results as NDJSON to S3 evaluations/ prefix
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

const region = process.env.AWS_REGION_NAME || process.env.AWS_REGION || 'us-east-1';
const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET || '';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || 'agent-echelon-analytics';
const ATHENA_DATABASE = process.env.ATHENA_DATABASE || 'agent_echelon';

const athenaClient = new AthenaClient({ region });
const bedrockClient = new BedrockRuntimeClient({ region });
const s3Client = new S3Client({ region });

// Intent weights for composite scoring
const AGENT_INTENT_WEIGHTS: Record<string, Record<string, number>> = {
  basic: {
    'general': 0.60,
    'greeting': 0.20,
    'acknowledgment': 0.20,
  },
  standard: {
    'guided_troubleshooting': 0.30,
    'data_extraction': 0.25,
    'report_generation': 0.25,
    'general': 0.15,
    'greeting': 0.025,
    'acknowledgment': 0.025,
  },
  premium: {
    'guided_troubleshooting': 0.30,
    'data_extraction': 0.25,
    'report_generation': 0.25,
    'general': 0.15,
    'greeting': 0.025,
    'acknowledgment': 0.025,
  },
};

interface Exchange {
  channelArn: string;
  userType: string;
  agentType: string;
  intent: string;
  userMessage: string;
  agentResponse: string;
  userMessageAt: string;
  agentResponseAt: string;
  // Model + experiment + telemetry fields denormalised from the bot
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
  // Config attribution — denormalised from the bot reply's
  // analytics metadata so an eval row is sliceable by config (persona/pack), not just model.
  configId?: string;
  personaVersion?: string;
  intentPackVersion?: string;
  systemPromptHash?: string;
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
  relevanceScore: number;
  classification: string;
  reasoning: string;
  evaluatedAt: string;
  // Mirror of Exchange's denormalised metadata. The eval row is the
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
}

// Relevance evaluation prompt
const RELEVANCE_PROMPT = `You are an expert evaluator assessing whether an AI agent's response is relevant to a user's request.

## Context

Agent Type: {{agentType}}
User Type: {{userType}}

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
      content: tryDecode(row[2] || ''),
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
  const isPlaceholder = (content: string): boolean =>
    content.includes('<!--corr:') ||
    content === 'One moment...' ||
    content === 'Analyzing...';

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
    let userType = 'unknown';
    // Config attribution (P4) — denormalise the config fingerprint so eval rows slice by config.
    let configId: string | undefined;
    let personaVersion: string | undefined;
    let intentPackVersion: string | undefined;
    let systemPromptHash: string | undefined;

    if (next.metadata) {
      try {
        const meta = JSON.parse(next.metadata);
        const analytics = meta.analytics || meta;
        agentType = analytics.agentType || 'unknown';
        intent = analytics.intent || 'unknown';
        userType = analytics.userType || 'unknown';
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
      userType,
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
    });
  }

  return exchanges;
}

/**
 * Evaluate a single exchange using Bedrock Haiku
 */
async function evaluateExchange(exchange: Exchange): Promise<RelevanceResult> {
  // Strip internal markers from content before evaluation
  const cleanUserMessage = stripMarkers(exchange.userMessage);
  const cleanAgentResponse = stripMarkers(exchange.agentResponse);

  const prompt = RELEVANCE_PROMPT
    .replace('{{agentType}}', exchange.agentType)
    .replace('{{userType}}', exchange.userType)
    .replace('{{userMessage}}', cleanUserMessage)
    .replace('{{agentResponse}}', cleanAgentResponse);

  const command = new InvokeModelCommand({
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
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
  for (const result of results) {
    if (!byAgent[result.agentType]) byAgent[result.agentType] = {};
    if (!byAgent[result.agentType][result.intentType]) byAgent[result.agentType][result.intentType] = [];
    byAgent[result.agentType][result.intentType].push(result.relevanceScore);
  }

  for (const [agentType, intents] of Object.entries(byAgent)) {
    const weights = AGENT_INTENT_WEIGHTS[agentType] || {};
    let weightedSum = 0;
    let totalWeight = 0;

    for (const [intent, scores] of Object.entries(intents)) {
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const weight = weights[intent] || 0.02;
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
      totalExchanges: results.length,
    }),
    ContentType: 'application/json',
  }));

  return agentScores;
}

// Deterministic strip of ALL internal markers (shared source of truth with the
// SPA parser + the Aurora eval runner), so the judge never sees a raw marker.
const stripMarkers = stripMessageMarkers;

function tryDecode(content: string): string {
  try {
    if (content.includes('%')) return decodeURIComponent(content);
  } catch {
    // Not encoded
  }
  return content;
}

/**
 * Main handler
 */
export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {
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
          // Config attribution (P4) — carry the fingerprint onto the eval row.
          ...(exchange.configId && { configId: exchange.configId }),
          ...(exchange.personaVersion && { personaVersion: exchange.personaVersion }),
          ...(exchange.intentPackVersion && { intentPackVersion: exchange.intentPackVersion }),
          ...(exchange.systemPromptHash && { systemPromptHash: exchange.systemPromptHash }),
        });
      } catch (err) {
        errors.push(`Exchange evaluation failed: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }

    // Write results to S3
    await writeResults(results);

    // Compute and write agent scores
    const agentScores = await writeAgentScores(results);

    const avgScore = results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.relevanceScore, 0) / results.length * 10) / 10
      : 0;

    const summary = {
      evaluated: results.length,
      errors: errors.length,
      avgRelevanceScore: avgScore,
      agentScores,
    };

    console.log('Evaluation complete:', summary);
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('Evaluation runner error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown' }) };
  }
}
