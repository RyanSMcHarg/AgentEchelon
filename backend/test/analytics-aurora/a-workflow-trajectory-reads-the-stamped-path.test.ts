/**
 * The workflow trajectory reading (SPEC-EVALUATION Appendix C2) is read from the trajectory a task turn
 * stamped, needs no judge, and is bound to a team's assistant and clearance like every per-assistant query.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler, WORKFLOW_TRAJECTORY_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';
import { TASK_STALL_TURNS } from '../../lambda/src/lib/task-trajectory';

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));

describe('the workflow trajectory reading', () => {
  it('reads the latest stamped trajectory per task, counts refusals from the steps, and calls no model', async () => {
    const res = await handler(teamPost('analyst', { queryType: 'workflow_trajectory' }));
    expect(res.statusCode).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls.find(([s]) => String(s).includes('taskTrajectory'))!;
    expect(sql).toMatch(/DISTINCT ON \(e\.task_id\)/);
    expect(sql).toMatch(/'workflow_refusal'/);
    expect(params).toContain(TASK_STALL_TURNS);
  });

  it('is bound to the team\'s assistant and the rooms its clearance reaches, whatever the body names', async () => {
    await handler(teamPost('analyst', { queryType: 'workflow_trajectory', agentType: 'advisor' }));
    const params = mockDbQuery.mock.calls.flatMap(([, p]) => (p as unknown[]) ?? []);
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
    const reach = params.find((p) => Array.isArray(p) && (p as string[]).includes('standard')) as string[];
    expect(reach).not.toContain('premium');
  });

  it('returns every column it declares', async () => {
    const row = Object.fromEntries(WORKFLOW_TRAJECTORY_COLUMNS.map((c) => [c, null]));
    mockDbQuery.mockResolvedValue({ rows: [{ ...row, assistant: 'analyst', conversation_classification: 'standard' }] });
    const res = await handler(teamPost('analyst', { queryType: 'workflow_trajectory' }));
    const body = JSON.parse(res.body);
    expect(Object.keys(body.data[0]).sort()).toEqual([...WORKFLOW_TRAJECTORY_COLUMNS].sort());
  });
});
