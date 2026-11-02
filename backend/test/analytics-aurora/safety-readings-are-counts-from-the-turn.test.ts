/**
 * Safety and refusal readings (SPEC-EVALUATION Appendix C5) are counts of what each turn recorded, with
 * their populations, bound to a team's assistant and clearance, and they call no judge.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler, SAFETY_READING_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';
import { INTERNAL_MARKER_FINDING_IDS } from '../../lib/config/guardrail-masks';

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));

const call = () => mockDbQuery.mock.calls.find(([s]) => String(s).includes('guardrailFindings'))!;

describe('safety and refusal readings', () => {
  it('counts a refusal from the delivery option the router wrote, beside the judge\'s own call on it', async () => {
    await handler(teamPost('analyst', { queryType: 'safety_readings' }));
    const [sql] = call();
    expect(sql).toMatch(/delivery_option = 'REFUSED'/);
    expect(sql).toMatch(/classification = 'appropriate_refusal'/);
  });

  it('counts each guardrail finding on its own, leaving out the platform\'s internal-marker masks', async () => {
    await handler(teamPost('analyst', { queryType: 'safety_readings' }));
    const [sql, params] = call();
    expect(sql).toMatch(/jsonb_array_elements_text/);
    expect(sql).toMatch(/NOT \(f\.finding LIKE ANY\(\$5::text\[\]\)\)/);
    expect(params[4]).toEqual(INTERNAL_MARKER_FINDING_IDS.map((id) => `${id}%`));
  });

  it('is bound to the team\'s assistant and the rooms its clearance reaches', async () => {
    await handler(teamPost('analyst', { queryType: 'safety_readings', agentType: 'advisor' }));
    const [, params] = call();
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
    expect((params as unknown[]).find((p) => Array.isArray(p) && (p as string[]).includes('standard'))).toBeDefined();
  });

  it('returns every column it declares', async () => {
    const row = Object.fromEntries(SAFETY_READING_COLUMNS.map((c) => [c, null]));
    mockDbQuery.mockResolvedValue({ rows: [{ ...row, assistant: 'analyst', conversation_classification: 'standard' }] });
    const body = JSON.parse((await handler(teamPost('analyst', { queryType: 'safety_readings' }))).body);
    expect(Object.keys(body.data[0]).sort()).toEqual([...SAFETY_READING_COLUMNS].sort());
  });
});
