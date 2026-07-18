/**
 * Evaluation Runner (Aurora) — scores agent responses for relevance with Bedrock.
 *
 * The Aurora-native replacement for the legacy Athena+S3 evaluation-runner. In
 * Aurora mode the archival Lambda already pairs messages into the `exchanges`
 * table, so this runner simply:
 *   1. reads UNSCORED exchanges from Aurora (exchanges ⋈ messages, no eval row yet),
 *   2. scores each with Bedrock Haiku,
 *   3. writes a row to `evaluation_results` — exactly the table the dashboard's
 *      getEvaluationMetrics reads (exchanges e LEFT JOIN evaluation_results er).
 *
 * Trigger: EventBridge daily schedule (or a manual invoke). No Athena, no S3.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { query } from './db-client.js';
import { stripMessageMarkers } from '../lib/message-markers.js';

const region = process.env.AWS_REGION_NAME || process.env.AWS_REGION || 'us-east-1';
const EVALUATOR_MODEL = process.env.EVALUATOR_MODEL || 'anthropic.claude-3-haiku-20240307-v1:0';
// Cap per run so a backlog can't exceed the Lambda timeout; the next run picks up the rest.
const MAX_PER_RUN = Number(process.env.EVAL_MAX_PER_RUN || 200);
const MAX_FLOWS_PER_RUN = Number(process.env.EVAL_MAX_FLOWS_PER_RUN || 100);

// Weighted flow-scoring rubric (must match SPEC-AURORA-VPC-MODE §7 Pass B and the
// FlowsTab dimension weights). Sums to 1.0.
const FLOW_WEIGHTS = { outcome: 0.30, information: 0.25, efficiency: 0.15, contextRetention: 0.15, ux: 0.15 } as const;
const FLOW_STATUSES = ['completed', 'in_progress', 'abandoned', 'failed'] as const;

const bedrockClient = new BedrockRuntimeClient({ region });

const RELEVANCE_PROMPT = `You are an expert evaluator assessing whether an AI agent's response is relevant to a user's request.

## Context

Agent Type: {{agentType}}
User Type: {{userType}}
{{taskContext}}
## Conversation so far (prior turns, oldest first)

{{conversationContext}}

## Current Exchange (the turn you are scoring)

User Message: {{userMessage}}

Agent Response: {{agentResponse}}

## Evaluation Criteria

Score the CURRENT response's relevance from 0-100 based on:

1. **Direct Relevance (0-40 points)**: Does the response address what the user asked, READ IN THE CONTEXT of the conversation so far?
2. **Context Awareness (0-20 points)**: Does it correctly use the conversation context?
3. **Completeness (0-20 points)**: Is the response thorough enough to be useful?
4. **Focus (0-20 points)**: Is the response concise and on-topic?

CRITICAL — judge the turn IN CONTEXT, not in isolation:
- A short reply like "yes"/"no"/"the second one" that correctly answers the AGENT's own prior question or confirms a proposed action is FULLY relevant (score it high). Do not penalize it for being short or for "not restating the question".
- When the current turn is part of a multi-step TASK (see Task above), judge the response by its correct CONTRIBUTION to that task at this step, not by whether it self-containedly resolves everything.
- If the user message only makes sense given a previous turn, use that previous turn to decide relevance.

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
  "classification": "<excellent|good|partial|poor|irrelevant|appropriate_refusal>",
  "reasoning": "<brief explanation>"
}`;

interface UnscoredExchange {
  id: string;
  channel_arn: string;
  agent_type: string | null;
  user_type: string | null;
  intent: string | null;
  task_id: string | null;
  created_at: string;
  user_message: string | null;
  agent_response: string | null;
}

interface PriorTurn {
  user_message: string | null;
  agent_response: string | null;
}

// How many prior turns to give the judge as context. Enough to resolve a
// contextual "yes"/"no"/pronoun; small enough to keep the judge prompt cheap.
const CONTEXT_TURNS = 4;

interface Relevance {
  relevanceScore: number;
  classification: string;
  reasoning: string;
}

// Strip ALL internal markers deterministically (the same set the SPA parses),
// so the judge never scores a raw marker like "…NAVIGATE_CHANNEL:arn:…".
const stripMarkers = stripMessageMarkers;

/** Exchanges with no evaluation_results row yet (the unscored backlog). */
async function getUnscoredExchanges(limit: number): Promise<UnscoredExchange[]> {
  const res = await query<UnscoredExchange>(
    `SELECT e.id,
            e.channel_arn,
            e.agent_type,
            e.user_type,
            e.intent,
            e.task_id,
            e.created_at,
            COALESCE(mu.updated_content, mu.content) AS user_message,
            COALESCE(ma.updated_content, ma.content) AS agent_response
       FROM exchanges e
       JOIN messages mu ON e.user_message_id = mu.id
       JOIN messages ma ON e.agent_message_id = ma.id
       LEFT JOIN evaluation_results er ON er.exchange_id = e.id
      WHERE er.id IS NULL
        AND mu.content IS NOT NULL
        AND COALESCE(ma.updated_content, ma.content) IS NOT NULL
      ORDER BY e.created_at
      LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/**
 * The exchanges immediately preceding `ex` in the same conversation, oldest
 * first — the context the judge needs so a reply like "yes" is scored against
 * the question it answers, and a mid-task step is judged by its contribution.
 */
async function getPriorTurns(ex: UnscoredExchange, limit = CONTEXT_TURNS): Promise<PriorTurn[]> {
  const res = await query<PriorTurn>(
    `SELECT COALESCE(mu.updated_content, mu.content) AS user_message,
            COALESCE(ma.updated_content, ma.content) AS agent_response
       FROM exchanges e
       JOIN messages mu ON e.user_message_id = mu.id
       JOIN messages ma ON e.agent_message_id = ma.id
      WHERE e.channel_arn = $1
        AND e.created_at < $2
      ORDER BY e.created_at DESC
      LIMIT $3`,
    [ex.channel_arn, ex.created_at, limit],
  );
  return res.rows.reverse(); // chronological (oldest first)
}

/** Score one exchange with Bedrock Haiku → relevance (0-100) + classification. */
async function scoreExchange(ex: UnscoredExchange): Promise<Relevance> {
  const prior = await getPriorTurns(ex).catch(() => [] as PriorTurn[]);
  const conversationContext = prior.length
    ? prior
        .map((t, i) => `Turn ${i + 1}:\n  User: ${stripMarkers(t.user_message || '')}\n  Agent: ${stripMarkers(t.agent_response || '')}`)
        .join('\n')
    : '(none — this is the first turn of the conversation)';
  const taskContext = ex.task_id
    ? `\nTask: this turn is part of an ongoing multi-step task (task_id=${ex.task_id}, intent=${ex.intent || 'unknown'}). Judge it by its contribution to that task at this step.\n`
    : '';

  const prompt = RELEVANCE_PROMPT
    .replace('{{agentType}}', ex.agent_type || 'unknown')
    .replace('{{userType}}', ex.user_type || 'unknown')
    .replace('{{taskContext}}', taskContext)
    .replace('{{conversationContext}}', conversationContext)
    .replace('{{userMessage}}', stripMarkers(ex.user_message || ''))
    .replace('{{agentResponse}}', stripMarkers(ex.agent_response || ''));

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: EVALUATOR_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    }),
  );

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.content?.[0]?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : text);
    return {
      relevanceScore: Math.max(0, Math.min(100, Number(parsed.relevanceScore) || 0)),
      classification: String(parsed.classification || 'partial'),
      reasoning: String(parsed.reasoning || ''),
    };
  } catch {
    return { relevanceScore: 50, classification: 'partial', reasoning: 'Evaluation parse error' };
  }
}

// ============================================================================
// Pass B - multi-turn task-flow scoring (populates intent_flows).
// ============================================================================

const FLOW_PROMPT = `You are an expert evaluator scoring a completed (or in-progress) MULTI-TURN task an AI agent worked with a user, holistically across five dimensions.

## Task
Intent: {{intent}}
Agent Type: {{agentType}}

## Full conversation for this task (chronological)
{{transcript}}

## Score each dimension 0-100
- outcome: did the task reach the user's goal?
- information: was the information correct, grounded, and sufficient?
- efficiency: was it achieved without needless back-and-forth or repetition?
- contextRetention: did the agent carry earlier context forward across turns (names, prior answers, the task goal)?
- ux: clarity, tone, and interaction quality across the flow.

Also decide:
- outcome: a SHORT label of what happened (e.g. "report delivered", "user abandoned", "blocked - missing data").
- status: one of "completed", "in_progress", "abandoned", "failed".

Respond with JSON only, no markdown:
{
  "outcomeScore": <0-100>, "informationScore": <0-100>, "efficiencyScore": <0-100>,
  "contextRetentionScore": <0-100>, "uxScore": <0-100>,
  "outcome": "<short label>", "status": "<completed|in_progress|abandoned|failed>",
  "reasoning": "<brief>"
}`;

interface TaskFlow {
  task_id: string;
  channel_arn: string;
  intent: string | null;
  user_type: string | null;
  agent_type: string | null;
  exchange_count: number;
  first_at: string;
  last_at: string;
}

interface FlowScore {
  outcomeScore: number;
  informationScore: number;
  efficiencyScore: number;
  contextRetentionScore: number;
  uxScore: number;
  outcome: string;
  status: string;
  reasoning: string;
}

const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/**
 * Task flows to score this run: those with no intent_flows row yet, or whose
 * exchange_count has grown since last scored (a task gained turns). Capped.
 */
async function getFlowsToScore(limit: number): Promise<TaskFlow[]> {
  const res = await query<TaskFlow>(
    `WITH task_agg AS (
       SELECT e.task_id, e.channel_arn,
              MAX(e.intent)     AS intent,
              MAX(e.user_type)  AS user_type,
              MAX(e.agent_type) AS agent_type,
              COUNT(*)::int     AS exchange_count,
              MIN(e.created_at) AS first_at,
              MAX(e.created_at) AS last_at
         FROM exchanges e
        WHERE e.task_id IS NOT NULL
        GROUP BY e.task_id, e.channel_arn
     )
     SELECT t.task_id, t.channel_arn, t.intent, t.user_type, t.agent_type,
            t.exchange_count, t.first_at, t.last_at
       FROM task_agg t
       LEFT JOIN intent_flows f ON f.task_id = t.task_id
      WHERE f.task_id IS NULL OR t.exchange_count > COALESCE(f.exchange_count, 0)
      ORDER BY t.last_at
      LIMIT $1`,
    [limit],
  );
  return res.rows;
}

async function getTaskExchanges(taskId: string): Promise<PriorTurn[]> {
  const res = await query<PriorTurn>(
    `SELECT COALESCE(mu.updated_content, mu.content) AS user_message,
            COALESCE(ma.updated_content, ma.content) AS agent_response
       FROM exchanges e
       JOIN messages mu ON e.user_message_id = mu.id
       JOIN messages ma ON e.agent_message_id = ma.id
      WHERE e.task_id = $1
      ORDER BY e.created_at ASC`,
    [taskId],
  );
  return res.rows;
}

async function scoreFlow(flow: TaskFlow, turns: PriorTurn[]): Promise<FlowScore> {
  const transcript = turns
    .map((t, i) => `Turn ${i + 1}:\n  User: ${stripMarkers(t.user_message || '')}\n  Agent: ${stripMarkers(t.agent_response || '')}`)
    .join('\n');
  const prompt = FLOW_PROMPT
    .replace('{{intent}}', flow.intent || 'unknown')
    .replace('{{agentType}}', flow.agent_type || 'unknown')
    .replace('{{transcript}}', transcript);

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: EVALUATOR_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(response.body));
  const textRaw = body.content?.[0]?.text || '{}';
  const match = textRaw.match(/\{[\s\S]*\}/);
  const p = JSON.parse(match ? match[0] : textRaw);
  const status = FLOW_STATUSES.includes(p.status) ? p.status : 'completed';
  return {
    outcomeScore: clamp(p.outcomeScore),
    informationScore: clamp(p.informationScore),
    efficiencyScore: clamp(p.efficiencyScore),
    contextRetentionScore: clamp(p.contextRetentionScore),
    uxScore: clamp(p.uxScore),
    outcome: String(p.outcome || '').slice(0, 64),
    status,
    reasoning: String(p.reasoning || ''),
  };
}

/** Weighted composite over the five dimensions (0-100). */
export function flowComposite(s: Pick<FlowScore, 'outcomeScore' | 'informationScore' | 'efficiencyScore' | 'contextRetentionScore' | 'uxScore'>): number {
  return Math.round(
    s.outcomeScore * FLOW_WEIGHTS.outcome +
    s.informationScore * FLOW_WEIGHTS.information +
    s.efficiencyScore * FLOW_WEIGHTS.efficiency +
    s.contextRetentionScore * FLOW_WEIGHTS.contextRetention +
    s.uxScore * FLOW_WEIGHTS.ux,
  );
}

async function upsertFlow(flow: TaskFlow, turns: PriorTurn[], s: FlowScore): Promise<void> {
  const durationSeconds = Math.max(0, Math.round((new Date(flow.last_at).getTime() - new Date(flow.first_at).getTime()) / 1000));
  await query(
    `INSERT INTO intent_flows
       (task_id, channel_arn, intent, user_type, agent_type, status,
        exchanges, exchange_count, turn_count, first_exchange_at, last_exchange_at,
        duration_seconds, outcome, outcome_score, efficiency_score,
        context_retention_score, ux_score, information_score, outcome_details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
     ON CONFLICT (task_id) DO UPDATE SET
        status = EXCLUDED.status,
        exchanges = EXCLUDED.exchanges,
        exchange_count = EXCLUDED.exchange_count,
        turn_count = EXCLUDED.turn_count,
        last_exchange_at = EXCLUDED.last_exchange_at,
        duration_seconds = EXCLUDED.duration_seconds,
        outcome = EXCLUDED.outcome,
        outcome_score = EXCLUDED.outcome_score,
        efficiency_score = EXCLUDED.efficiency_score,
        context_retention_score = EXCLUDED.context_retention_score,
        ux_score = EXCLUDED.ux_score,
        information_score = EXCLUDED.information_score,
        outcome_details = EXCLUDED.outcome_details`,
    [
      flow.task_id, flow.channel_arn, flow.intent || 'unknown', flow.user_type, flow.agent_type, s.status,
      JSON.stringify({ turns: turns.length }), flow.exchange_count, turns.length * 2, flow.first_at, flow.last_at,
      durationSeconds, s.outcome, s.outcomeScore, s.efficiencyScore,
      s.contextRetentionScore, s.uxScore, s.informationScore,
      JSON.stringify({ reasoning: s.reasoning, composite: flowComposite(s) }),
    ],
  );

  // P1 backfill: Pass A rows scored before this flow existed carry task_id but a NULL flow_id. Now that
  // the flow row exists, stamp its id onto them so the score->flow join needs no round-trip through
  // exchanges. Forward-looking: rows predating the Pass A task_id write (task_id NULL) are not touched.
  await query(
    `UPDATE evaluation_results er
        SET flow_id = f.id
       FROM intent_flows f
      WHERE f.task_id = $1
        AND er.task_id = $1
        AND er.flow_id IS NULL`,
    [flow.task_id],
  );
}

/** Pass B: score task flows into intent_flows. Returns count scored. */
async function runFlowPass(): Promise<{ scored: number; errors: number }> {
  const flows = await getFlowsToScore(MAX_FLOWS_PER_RUN);
  if (flows.length === 0) return { scored: 0, errors: 0 };
  console.log(`Scoring ${flows.length} task flow(s).`);
  let scored = 0;
  let errors = 0;
  for (const flow of flows) {
    try {
      const turns = await getTaskExchanges(flow.task_id);
      if (turns.length === 0) continue;
      const s = await scoreFlow(flow, turns);
      await upsertFlow(flow, turns, s);
      scored += 1;
    } catch (err) {
      errors += 1;
      console.warn(`flow ${flow.task_id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return { scored, errors };
}

export async function handler(
  event: unknown,
): Promise<{ statusCode: number; body: string }> {
  console.log('Aurora evaluation runner invoked');
  const runId = `eval-${new Date().toISOString()}`;

  try {
    const exchanges = await getUnscoredExchanges(MAX_PER_RUN);
    // NOTE: do not early-return when Pass A is empty — Pass B (flow scoring) still
    // needs to run (a deployment can have all exchanges scored but new task flows).
    if (exchanges.length === 0) console.log('No unscored exchanges (Pass A); running Pass B.');
    else console.log(`Scoring ${exchanges.length} unscored exchange(s) [run ${runId}].`);

    let scored = 0;
    const errors: string[] = [];
    for (const ex of exchanges) {
      try {
        const r = await scoreExchange(ex);
        // P1 (SPEC-ADMIN-CONSOLE-EFFECTIVENESS): stamp the flow join keys at write time so a per-exchange
        // score reaches its flow directly. task_id is copied from the exchange; flow_id is resolved to
        // the intent_flows row for that task WHEN one exists (Pass B may run after Pass A, so it's
        // set-if-present and backfilled by Pass B's upsert otherwise). Both NULL for a single-turn exchange.
        // $9 (task_id) is used twice — the VALUES position AND the flow_id subquery's WHERE — and
        // Postgres deduces its type independently in each, erroring with "inconsistent types deduced
        // for parameter $9" (which failed EVERY Pass A insert). Cast both uses to varchar so the type
        // is unambiguous. (task_id / intent_flows.task_id are both VARCHAR(64).)
        await query(
          `INSERT INTO evaluation_results
             (exchange_id, run_id, evaluator_model, relevance_score, classification,
              reasoning, agent_type, intent, task_id, flow_id, evaluation_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::varchar,
                   (SELECT id FROM intent_flows WHERE task_id = $9::varchar), 'exchange')`,
          [ex.id, runId, EVALUATOR_MODEL, r.relevanceScore, r.classification, r.reasoning, ex.agent_type, ex.intent, ex.task_id],
        );
        scored += 1;
      } catch (err) {
        errors.push(`${ex.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Pass B: multi-turn task-flow scoring (populates intent_flows for the Flows tab).
    const flows = await runFlowPass().catch((err) => {
      console.error('Flow pass error:', err);
      return { scored: 0, errors: 1 };
    });

    console.log(`Evaluation complete: exchanges ${scored} (errors ${errors.length}); flows ${flows.scored} (errors ${flows.errors}).`);
    if (errors.length) console.warn('Eval errors:', errors.slice(0, 5));
    return {
      statusCode: 200,
      body: JSON.stringify({ evaluated: scored, errors: errors.length, flowsScored: flows.scored, flowErrors: flows.errors, runId }),
    };
  } catch (err) {
    console.error('Evaluation runner error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) };
  }
}

