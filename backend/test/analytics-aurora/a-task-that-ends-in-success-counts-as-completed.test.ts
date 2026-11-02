/**
 * A TASK THAT ENDS IN SUCCESS COUNTS AS COMPLETED, whatever its machine calls that state.
 *
 * A task turn records the state its task ended the turn in as `task_status`: the machine's state where the task has a
 * machine, the lifecycle status where it has none. `image_generation` ends in `done` and a work item in `placed`, so an
 * experiment's `task_completion_rate` that counted only the literal `completed` read every such task, a duel side's
 * image task among them, as unfinished. The count reads every success state the machines declare.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

import { handler, successTerminalStates } from '../../lambda/src/analytics-aurora/analytics-query';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { analyticsPathFor } from '../helpers/analytics-path';
import { edgeContext } from '../helpers/edge-context';

function post(body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: analyticsPathFor(body),
    body: JSON.stringify({ dateRange: { start: '2026-10-29', end: '2026-10-30' }, ...body }),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe('the success states a task can end in', () => {
  it('are every state a machine declares a success terminal, by task type', () => {
    const states = successTerminalStates();
    expect(states).toContain('image_generation:done');
    expect(states).toContain('report_generation:completed');
    // A failure ending is not a completion.
    const failures = Object.entries(DEFAULT_TASK_STATE_MACHINES).flatMap(([type, m]) =>
      Object.entries(m.states).filter(([, d]) => d.terminal === 'failure').map(([s]) => `${type}:${s}`));
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect(states).not.toContain(f);
  });

  it('read a machine handed to them, not only the platform set', () => {
    expect(successTerminalStates({
      triage: { initial: 'open', states: { open: { transitions: ['settled', 'lost'] }, settled: { transitions: [], terminal: 'success' }, lost: { transitions: [], terminal: 'failure' } } },
    } as never)).toEqual(['triage:settled']);
  });
});

describe('an experiment counts a duel side\'s task that ended in success as completed', () => {
  it('counts the lifecycle `completed` and every machine success state, keyed by the task\'s type', async () => {
    const res = await handler(post({ queryType: 'experiment_results', experimentId: 'exp-1', includeBattle: 'true' }));
    expect(res.statusCode).toBe(200);
    const call = mockDbQuery.mock.calls.find(([sql]) => String(sql).includes('task_completed_count'));
    expect(call).toBeDefined();
    const [sql, params] = call!;
    const m = String(sql).match(/COUNT\(DISTINCT e\.task_id\) FILTER \(WHERE \(e\.task_status = 'completed' OR \(e\.task_type \|\| ':' \|\| e\.task_status\) = ANY\(\$(\d+)::text\[\]\)\)\) AS task_completed_count/);
    expect(m).not.toBeNull();
    const bound = params[Number(m![1]) - 1] as string[];
    expect(bound).toEqual(successTerminalStates());
    expect(bound).toContain('image_generation:done');
    // The battle turns are in the population: includeBattle drops the probabilistic-only filter.
    expect(String(sql)).not.toMatch(/= 'probabilistic'/);
  });

  it('turns the counts into the rate per variant', async () => {
    mockDbQuery.mockImplementation(async (sql: string) => (String(sql).includes('task_completed_count')
      ? { rows: [{ experiment_id: 'exp-1', variant_id: 'treatment', model_name: 'amazon.nova-canvas-v1:0', intent: 'image_generation', assistant: 'premium', exchange_count: '4', conversation_count: '2', scored_count: '0', task_count: '2', task_completed_count: '1', fallback_count: '0' }] }
      : { rows: [] }));
    const res = await handler(post({ queryType: 'experiment_results', experimentId: 'exp-1', includeBattle: 'true' }));
    const row = (JSON.parse(res.body).data as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ variant_id: 'treatment', task_completion_rate: 50 });
  });
});
