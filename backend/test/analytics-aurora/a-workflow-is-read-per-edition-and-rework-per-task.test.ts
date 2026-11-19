/**
 * A WORKFLOW IS READ PER EDITION, AND REWORK PER TASK (ADR-067 decision 6 and OPEN 6, WT109 and WT105).
 *
 * What it proves: `workflow_editions` groups a run's messages by workflow, the assistant whose run it was, and the hash its run started on, counts the runs
 * whose run-end record names them and the share that ended in success, and breaks each edition down by run-level step;
 * `task_rework` counts a reopen as a transition out of a state the same task ended in earlier (on a turn or in a
 * settlement record) and groups by intent and machine edition. Both run under the assistant and classification filters,
 * a team may run both (bound to its assistant and clearance), and the API marks both Aurora only.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

import { handler, workflowEditionRows, taskReworkRows, ASSISTANT_FILTERED_QUERIES } from '../../lambda/src/analytics-aurora/analytics-query';
import { analyticsPathFor } from '../helpers/analytics-path';
import { edgeContext } from '../helpers/edge-context';

const RANGE = { start: '2026-05-13', end: '2026-05-20' };

function post(body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: analyticsPathFor(body),
    body: JSON.stringify({ dateRange: RANGE, ...body }),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => jest.clearAllMocks());

describe('runs per workflow edition', () => {
  it('groups by workflow, origin hash and the assistant whose run it was, reads the run-end records, and narrows by workflow and filters', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(post({ queryType: 'workflow_editions', workflow: 'ops-room', agentType: 'advisor', conversationClassification: 'standard' }));
    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT m\.assistant, m\.workflow_name/);
    expect(sql.match(/AS dimension, r\.assistant, r\.workflow_name/g)).toHaveLength(3);
    expect(sql).toMatch(/GROUP BY r\.workflow_name, r\.workflow_origin_hash, r\.assistant\n/);
    expect(sql).toMatch(/GROUP BY r\.workflow_name, r\.workflow_origin_hash, r\.assistant, r\.workflow_trigger/);
    expect(sql).toMatch(/GROUP BY r\.workflow_name, r\.workflow_origin_hash, r\.assistant, r\.workflow_step/);
    expect(sql).toMatch(/f\.event_type = 'AE_RUN_ENDED'/);
    expect(sql).toMatch(/FILTER \(WHERE e\.disposition = 'success'\) AS succeeded/);
    expect(args.slice(1, 4)).toEqual(['ops-room', 'advisor', 'standard']);
  });

  it('a share is read over the runs that ended, and a step row carries none', () => {
    const rows = workflowEditionRows([
      { dimension: 'edition', workflow_name: 'w', workflow_origin_hash: 'h1', runs: '5', ended: '4', succeeded: '3', messages: '12', avg_ms: '800', p95_ms: '1500' },
      { dimension: 'edition', workflow_name: 'w', workflow_origin_hash: 'h2', runs: '2', ended: '0', succeeded: '0', messages: '3', avg_ms: null, p95_ms: null },
      { dimension: 'step', workflow_name: 'w', workflow_origin_hash: 'h1', workflow_step: 'greet', runs: '5', ended: null, succeeded: null, messages: '5', avg_ms: '400', p95_ms: '600' },
    ]);
    expect(rows[0]).toMatchObject({ runs: 5, ended: 4, succeeded: 3, success_share: 0.75 });
    expect(rows[1].success_share).toBeNull();
    expect(rows[2]).toMatchObject({ runs: 5, ended: null, success_share: null });
  });
});

describe('rework per task', () => {
  it('counts a transition out of a state the task ended in earlier, on a turn or in a settlement record', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(post({ queryType: 'task_rework', intent: 'report_generation' }));
    expect(res.statusCode).toBe(200);
    const [sql, args] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/FROM turn_events te\s+WHERE te\.kind = 'task_terminal'/);
    expect(sql).toMatch(/f\.event_type = 'AE_TASK_SETTLED' AND f\.metadata->>'terminal' IS NOT NULL/);
    expect(sql).toMatch(/e\.task_id = t\.task_id AND e\.state = t\.task_transition->>'from' AND e\.created_at < t\.created_at/);
    // A task is one assistant's row: the first assistant its turns name.
    expect(sql).toMatch(/FIRST_VALUE\(assistant\) OVER \(PARTITION BY task_id ORDER BY \(assistant IS NULL\), created_at\) AS assistant/);
    expect(sql).toMatch(/GROUP BY k\.task_type, k\.task_origin_machine_hash, k\.assistant/);
    expect(args[1]).toBe('report_generation');
  });

  it('reads reopens per task as a number', () => {
    expect(taskReworkRows([{ task_type: 'r', task_origin_machine_hash: 'm', tasks: '4', tasks_reopened: '1', reopens: '2' }])[0])
      .toMatchObject({ tasks: 4, tasks_reopened: 1, reopens: 2, reopens_per_task: 0.5 });
    expect(taskReworkRows([{ task_type: 'r', tasks: '0', reopens: '0' }])[0].reopens_per_task).toBe(0);
  });
});

describe('who may read them', () => {
  it('a team may run both, bound to its assistant and clearance, and the API marks both Aurora only', () => {
    expect(ASSISTANT_FILTERED_QUERIES.has('workflow_editions')).toBe(true);
    expect(ASSISTANT_FILTERED_QUERIES.has('task_rework')).toBe(true);
    const api = readFileSync(resolve(__dirname, '../../lambda/src/analytics-query.ts'), 'utf8');
    const auroraOnly = api.slice(api.indexOf('AURORA_ONLY_TYPES'), api.indexOf(']);', api.indexOf('AURORA_ONLY_TYPES')));
    expect(auroraOnly).toContain("'workflow_editions'");
    expect(auroraOnly).toContain("'task_rework'");
  });
});
