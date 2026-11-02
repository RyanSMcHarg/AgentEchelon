/**
 * The frustration reading (SPEC-EVALUATION Appendix C6) counts recorded events, one person in one
 * conversation at a time, and never adds two people's signals together.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler, FRUSTRATION_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));
const call = () => mockDbQuery.mock.calls.find(([s]) => String(s).includes('per_person'))!;

describe('the frustration reading', () => {
  it('reads each signal from a recorded event, never from the words of a message', async () => {
    await handler(teamPost('analyst', { queryType: 'frustration' }));
    const [sql] = call();
    expect(sql).toMatch(/'asked_again'/);
    expect(sql).toMatch(/d\.outcome IN \('declined', 'rejected_in_new_channel'\)/);
    expect(sql).toMatch(/aeHandover/);
    expect(sql).toMatch(/jsonb_typeof\(s\.metadata->'stopped'\) = 'object'/);
    // No content is read: the reading never looks at what anybody wrote.
    expect(sql).not.toMatch(/\.content\b/);
  });

  it('counts per person per conversation first, so two people are never one total', async () => {
    await handler(teamPost('analyst', { queryType: 'frustration' }));
    const [sql] = call();
    expect(sql).toMatch(/per_person AS \([\s\S]*GROUP BY pc\.assistant, pc\.conversation_classification, pc\.channel_arn, pc\.person_id/);
    // A conversation row counts PEOPLE with a signal and the most any one person had, never a sum.
    const conv = sql.slice(sql.indexOf('conversation AS ('));
    expect(conv).toMatch(/COUNT\(\*\) FILTER \(WHERE signals > 0\) AS with_signal/);
    expect(conv).toMatch(/MAX\(signals\) AS most_signals/);
    expect(conv).not.toMatch(/SUM\(/);
  });

  it('is bound to the team\'s assistant and clearance', async () => {
    await handler(teamPost('analyst', { queryType: 'frustration', agentType: 'advisor' }));
    const [, params] = call();
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
  });

  it('returns every column it declares', async () => {
    const row = Object.fromEntries(FRUSTRATION_COLUMNS.map((c) => [c, null]));
    mockDbQuery.mockResolvedValue({ rows: [{ ...row, assistant: 'analyst', conversation_classification: 'standard' }] });
    const body = JSON.parse((await handler(teamPost('analyst', { queryType: 'frustration' }))).body);
    expect(Object.keys(body.data[0]).sort()).toEqual([...FRUSTRATION_COLUMNS].sort());
  });

  it('a stop records who stopped and how much on its acknowledgment, written by the assistant', () => {
    const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/botMessageMetadata\(spoke\.attribution, \{ stopped: \{ personId, cancelled \} \}\)/);
  });
});
