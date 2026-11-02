/**
 * EFFECTIVENESS READS AN INTENT BY ITS STEPS AND BY THE MODELS THAT SERVED THEM (ADR-064 decisions 4 and I,
 * SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR38 to FR42).
 *
 * A task turn counts under its task's type (`COALESCE(task_type, intent)`) on the L1 row, its L2 lists and its vote
 * scope, so a "looks good" classified `acknowledgment` inside a report counts under `report_generation`. One intent's
 * turns break down by the step they started in, by each step the turn recorded (a model call, a tool, a platform action,
 * a correction) and by each model a step entry names, priced from each `steps[]` entry's own cost rather than a dominant
 * model, narrowed by `?step=`, under the same assistant and classification
 * filters as the row. The L3 timeline carries what chose each turn's model.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

import { handler, intentStepRows, WORK_INTENT_SQL, ASSISTANT_FILTERED_QUERIES } from '../../lambda/src/analytics-aurora/analytics-query';
import { analyticsPathFor } from '../helpers/analytics-path';
import { edgeContext } from '../helpers/edge-context';

const RANGE = { start: '2026-05-13', end: '2026-05-20' };
const WINDOW = '[2026-05-13T00:00:00.000Z,2026-05-21T00:00:00.000Z)';

function post(body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: analyticsPathFor(body),
    body: JSON.stringify({ dateRange: RANGE, ...body }),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => jest.clearAllMocks());

describe('a task turn counts under its task type', () => {
  it('groups and filters the L1 row, its model mix and its vote scope by COALESCE(task_type, intent)', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ intent: 'report_generation', exchange_count: '3' }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(post({ queryType: 'intent_effectiveness', intent: 'report_generation' }));
    expect(res.statusCode).toBe(200);
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(WORK_INTENT_SQL('e')).toBe('COALESCE(e.task_type, e.intent)');
    expect(sql).toMatch(/SELECT COALESCE\(e\.task_type, e\.intent\) AS intent,/);
    expect(sql).toMatch(/GROUP BY COALESCE\(e\.task_type, e\.intent\)\n/);
    expect(sql).toMatch(/\$2::varchar IS NULL OR COALESCE\(e2\.task_type, e2\.intent\) = \$2/);
    expect(sql).not.toMatch(/GROUP BY e\.intent\b/);
    expect(mockDbQuery.mock.calls[0][1][1]).toBe('report_generation');
    // The votes are folded by the same intent the row carries.
    const scope = String(mockDbQuery.mock.calls[1][0]);
    expect(scope).toMatch(/COALESCE\(e\.task_type, e\.intent, 'unknown'\) AS intent/);
    expect(scope).toMatch(/OR COALESCE\(e\.task_type, e\.intent\) = \$2/);
  });

  it('the L2 lists hold the same population: exchanges by the same expression, tasks by their type', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await handler(post({ queryType: 'intent_exchanges', intent: 'report_generation' }));
    expect(String(mockDbQuery.mock.calls[0][0])).toMatch(/WHERE COALESCE\(e\.task_type, e\.intent\) = \$1/);
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await handler(post({ queryType: 'task_details', intent: 'report_generation' }));
    const tasks = String(mockDbQuery.mock.calls[1][0]);
    expect(tasks).toMatch(/COALESCE\(task_type, intent\) = \$3/);
    expect(tasks).toMatch(/ARRAY_AGG\(task_type ORDER BY created_at ASC\) FILTER \(WHERE task_type IS NOT NULL\)/);
  });

  it('the L3 timeline carries the step a turn started in and what chose its model', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ exchange_id: 'x', task_step: 'generate', model_kind: 'image', model_from: 'route', bedrock_model: 'stability.sd3' }] });
    const res = await handler(post({ queryType: 'task_timeline', taskId: 't-1' }));
    const sql = String(mockDbQuery.mock.calls[0][0]);
    for (const col of ['e.task_type', 'e.task_step', 'e.model_kind', 'e.model_from', 'm.bedrock_model']) expect(sql).toContain(col);
    expect(JSON.parse(res.body).data[0]).toMatchObject({ task_step: 'generate', model_from: 'route' });
  });
});

describe('intent_steps', () => {
  it('reads one intent by step and by model, priced from steps[], under the row\'s filters and ?step=', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(post({
      queryType: 'intent_steps', intent: 'image_generation', step: 'generate',
      agentType: 'premium', conversationClassification: 'premium', assistantRole: 'primary', profileVersion: '4',
    }));
    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(args.slice(0, 8)).toEqual([WINDOW, 'image_generation', 'premium', 'premium', null, 'primary', 4, 'generate']);
    expect(sql).toMatch(/COALESCE\(e\.task_type, e\.intent\) = \$2/);
    expect(sql).toMatch(/\$8::varchar IS NULL OR e\.task_step = \$8/);
    expect(sql).toMatch(/\$5::text\[\] IS NULL OR e\.conversation_classification = ANY\(\$5\)/);
    expect(sql).toMatch(/e\.queued_as IS NULL/);
    // Cost is what each step recorded, summed; a step that recorded none is counted, never read as free.
    expect(sql).toMatch(/SUM\(\(entry->>'estCostUsd'\)::numeric\) FILTER \(WHERE jsonb_typeof\(entry->'estCostUsd'\) = 'number'\)/);
    expect(sql).toMatch(/unpriced_steps/);
    expect(sql).not.toMatch(/dominant_model/);
    // One row set per task step, one per turn step under its task step, one per model; the platform's own
    // non-model actions are no model.
    expect(sql).toMatch(/SELECT 'task_step'::text AS dimension,[\s\S]*GROUP BY t\.task_step/);
    expect(sql).toMatch(/SELECT 'step'::text AS dimension,[\s\S]*GROUP BY en\.task_step, en\.step_kind, en\.step_key/);
    expect(sql).toMatch(/GROUP BY en\.entry->>'modelId'/);
    expect(sql).toMatch(/en\.entry->>'modelId' <> 'platform'/);
  });

  it('a turn step is what the entry is: a model by its model, a tool by its name, a platform action and a correction by their label', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    await handler(post({ queryType: 'intent_steps', intent: 'competitive_intel' }));
    const sql = String(mockDbQuery.mock.calls[0][0]);
    // A correction first, so a corrected tool call reads as the correction the platform asked for.
    expect(sql).toMatch(/WHEN s\.entry->>'stepLabel' LIKE 'correction-%' THEN 'correction'\s+WHEN jsonb_typeof\(s\.entry->'action'\) = 'object'/);
    expect(sql).toMatch(/WHEN 'correction' THEN split_part\(s\.entry->>'stepLabel', ':', 1\)/);
    expect(sql).toMatch(/WHEN 'platform' THEN COALESCE\(s\.entry->'action'->>'tool'/);
    // A tool is named from the structured outcomes, the label only when there are none (a proposal).
    expect(sql).toMatch(/string_agg\(DISTINCT x\.tool->>'name', '\+' ORDER BY x\.tool->>'name'\)/);
    expect(sql).toMatch(/ELSE COALESCE\(s\.entry->>'modelId', s\.entry->>'stepLabel'\)/);
    // Each step's time is its own span, with a p95, and its cost is what that entry recorded.
    expect(sql).toMatch(/PERCENTILE_CONT\(0\.95\) WITHIN GROUP \(ORDER BY en\.call_ms\)/);
    expect(sql).toMatch(/SUM\(\(en\.entry->>'estCostUsd'\)::numeric\) FILTER \(WHERE jsonb_typeof\(en\.entry->'estCostUsd'\) = 'number'\) AS cost_usd,\s+COUNT\(\*\) FILTER \(WHERE jsonb_typeof\(en\.entry->'estCostUsd'\) IS DISTINCT FROM 'number'\) AS unpriced_steps,\s+ARRAY_AGG\(DISTINCT en\.entry->>'modelId'\)/);
    // The population is the L1 row's, with no task step invented for a turn bound to none.
    expect(sql).toMatch(/COALESCE\(e\.task_type, e\.intent\) = \$2/);
    expect(sql).not.toMatch(/COALESCE\(e\.task_step/);
  });

  it('without an intent it answers empty and reads nothing', async () => {
    const res = await handler(post({ queryType: 'intent_steps' }));
    expect(JSON.parse(res.body).data).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('a model row says whether it is an image model and which steps it served; a task-step row which models answered', () => {
    const rows = intentStepRows([
      { dimension: 'task_step', group_key: 'gather', task_step: 'gather', step_kind: null, step_key: null, turns: '2', cost_usd: '0.0021', models: ['anthropic.claude-haiku'] },
      { dimension: 'model', group_key: 'amazon.nova-canvas-v1:0', task_step: null, step_kind: null, step_key: null, turns: '1', calls: '1', cost_usd: '0.04', models: ['generate'] },
      { dimension: 'model', group_key: 'anthropic.claude-haiku', turns: '3', calls: '4', cost_usd: '0.003', models: ['gather', 'confirm'] },
    ]);
    expect(rows[0]).toMatchObject({ dimension: 'task_step', group_key: 'gather', task_step: 'gather', models: ['anthropic.claude-haiku'] });
    expect(rows[0]).not.toHaveProperty('step_kind');
    expect(rows[1]).toMatchObject({ model_kind: 'image', steps: ['generate'] });
    expect(rows[1]).not.toHaveProperty('models');
    expect(rows[1]).not.toHaveProperty('task_step');
    expect(rows[2]).toMatchObject({ model_kind: 'text', steps: ['gather', 'confirm'] });
  });

  it('a single-turn intent reads its model and tool steps with no task step, each priced from its own entries', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [
      { dimension: 'model', group_key: 'anthropic.claude-sonnet', task_step: null, step_kind: null, step_key: null, turns: '3', calls: '6', avg_ms: '1200', p95_ms: null, cost_usd: '0.0300', unpriced_steps: '0', models: [] },
      { dimension: 'step', group_key: 'tool:load_company_context', task_step: null, step_kind: 'tool', step_key: 'load_company_context', turns: '3', calls: '3', avg_ms: '900', p95_ms: '1100', cost_usd: '0.0120', unpriced_steps: '0', models: ['anthropic.claude-sonnet'] },
      { dimension: 'step', group_key: 'model:anthropic.claude-sonnet', task_step: null, step_kind: 'model', step_key: 'anthropic.claude-sonnet', turns: '3', calls: '3', avg_ms: '1500', p95_ms: '2000', cost_usd: '0.0180', unpriced_steps: '1', models: ['anthropic.claude-sonnet'] },
      { dimension: 'task_step', group_key: null, task_step: null, step_kind: null, step_key: null, turns: '3', calls: null, avg_ms: '2800', p95_ms: '3500', cost_usd: '0.0300', unpriced_steps: '1', models: ['anthropic.claude-sonnet'] },
    ] });
    const res = await handler(post({ queryType: 'intent_steps', intent: 'competitive_intel' }));
    const data = JSON.parse(res.body).data as Array<Record<string, unknown>>;
    const steps = data.filter((r) => r.dimension === 'step');
    expect(steps.map((r) => [r.task_step, r.step_kind, r.step_key])).toEqual([
      [null, 'tool', 'load_company_context'],
      [null, 'model', 'anthropic.claude-sonnet'],
    ]);
    expect(steps[0]).toMatchObject({ calls: '3', p95_ms: '1100', cost_usd: '0.0120', models: ['anthropic.claude-sonnet'] });
    // The turn step's own cost, never the turn's, and the entry that recorded none is counted.
    expect(steps[1]).toMatchObject({ cost_usd: '0.0180', unpriced_steps: '1' });
  });

  it('a workflow intent reads each turn step under the task step its turn started in', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [
      { dimension: 'step', group_key: 'platform:generate_image', task_step: 'generate', step_kind: 'platform', step_key: 'generate_image', turns: '1', calls: '1', cost_usd: '0.04', unpriced_steps: '0', models: ['amazon.nova-canvas-v1:0'] },
      { dimension: 'step', group_key: 'model:anthropic.claude-haiku', task_step: 'gather', step_kind: 'model', step_key: 'anthropic.claude-haiku', turns: '2', calls: '2', cost_usd: '0.002', unpriced_steps: '0', models: ['anthropic.claude-haiku'] },
      { dimension: 'step', group_key: 'correction:correction-deliverable', task_step: 'generate', step_kind: 'correction', step_key: 'correction-deliverable', turns: '1', calls: '1', cost_usd: null, unpriced_steps: '1', models: ['anthropic.claude-haiku'] },
    ] });
    const res = await handler(post({ queryType: 'intent_steps', intent: 'image_generation' }));
    const data = JSON.parse(res.body).data as Array<Record<string, unknown>>;
    expect(data.map((r) => `${r.task_step}/${r.group_key}`)).toEqual([
      'generate/platform:generate_image', 'gather/model:anthropic.claude-haiku', 'generate/correction:correction-deliverable',
    ]);
    expect(data[2]).toMatchObject({ cost_usd: null, unpriced_steps: '1' });
  });

  it('a team reads it for its own assistant only', () => {
    expect(ASSISTANT_FILTERED_QUERIES.has('intent_steps')).toBe(true);
  });
});
