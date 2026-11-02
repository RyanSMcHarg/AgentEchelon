/**
 * The Welcome lane of the Performance view: a welcome answers no message, so it has no TTFF, and is
 * timed from the assistant joining the conversation to its welcome appearing.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler, WELCOME_FLOW_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));
const firstSql = () => String(mockDbQuery.mock.calls[0]?.[0] ?? '');
const firstParams = () => (mockDbQuery.mock.calls[0]?.[1] ?? []) as unknown[];

describe('the welcome lane', () => {
  it('reads declared welcomes and times each from the same assistant joining the same conversation', async () => {
    await handler(teamPost('analyst', { queryType: 'welcome_flow' }));
    const sql = firstSql();
    expect(sql).toMatch(/m\.turn_kind = 'welcome'/);
    expect(sql).toMatch(/mm\.event_type = 'CREATE_CHANNEL_MEMBERSHIP'/);
    expect(sql).toMatch(/mm\.target_arn = m\.sender_arn/);
    expect(sql).toMatch(/mm\.channel_arn = m\.channel_arn/);
  });

  it('leaves a welcome with no recent join unmeasured rather than timing it from an old one', async () => {
    await handler(teamPost('analyst', { queryType: 'welcome_flow' }));
    expect(firstSql()).toMatch(/mm\.created_at > m\.created_at - interval '10 minutes'/);
    expect(WELCOME_FLOW_COLUMNS).toEqual(expect.arrayContaining(['welcomes', 'measured']));
  });

  it('is bound to the team\'s assistant and the rooms its clearance reaches', async () => {
    await handler(teamPost('analyst', { queryType: 'welcome_flow', agentType: 'advisor' }));
    expect(firstParams()).toContain('analyst');
    expect(firstParams()).not.toContain('advisor');
    expect(firstSql()).toMatch(/m\.conversation_classification = ANY\(\$4\)/);
  });

  it('returns counts and timings only, never message text', async () => {
    await handler(teamPost('analyst', { queryType: 'welcome_flow' }));
    expect(WELCOME_FLOW_COLUMNS).not.toContain('content');
  });
});
