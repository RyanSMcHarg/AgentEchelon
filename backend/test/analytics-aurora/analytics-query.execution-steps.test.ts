/**
 * Every filter `getExecutionSteps` adds is a BIND, not a literal.
 *
 * WHY THIS IS ITS OWN FILE. Three of its placeholders shipped without the `$`:
 * `where += \` AND m.channel_arn = ${queryParams.length}\`` emits `AND m.channel_arn = 3` - the
 * parameter INDEX as an integer literal. Postgres refuses the varchar comparisons with
 * `operator does not exist: character varying = integer`, so the endpoint 500s on four of its five
 * filters; `m.profile_version = 6` is a VALID int comparison, so that one returns a plausible wrong
 * population instead of failing. Nothing covered this function, which is how it shipped.
 *
 * The assertion is on the SQL text rather than on returned rows on purpose: a mocked `query` cannot
 * reproduce the type error, and the defect lives entirely in what is sent to the database.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { edgeContext } from '../helpers/edge-context';

const mockDbQuery = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/analytics-aurora/analytics-query');

const DAY = 24 * 60 * 60 * 1000;

function getEvent(params: Record<string, string>): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/analytics/execution-steps',
    queryStringParameters: {
      startDate: new Date(Date.now() - 7 * DAY).toISOString(),
      endDate: new Date().toISOString(),
      ...params,
    },
    requestContext: { authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

/** The SQL string the handler actually sent, plus the values it bound alongside it. */
async function sqlFor(params: Record<string, string>): Promise<{ sql: string; values: unknown[] }> {
  mockDbQuery.mockResolvedValueOnce({ rows: [] });
  const res = await handler(getEvent(params) as any);
  expect(res.statusCode).toBe(200);
  const [sql, values] = mockDbQuery.mock.calls[0];
  return { sql: String(sql), values: values as unknown[] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
});

describe('execution-steps filters are bound, never inlined', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/ai/channel/room-1';

  it.each([
    ['channelArn', { channelArn: CHANNEL }, 'm.channel_arn', CHANNEL],
    ['agentType', { agentType: 'assistant' }, 'm.assistant', 'assistant'],
    ['conversationClassification', { conversationClassification: 'premium' }, 'm.conversation_classification', 'premium'],
    ['assistantRole', { assistantRole: 'ops' }, 'm.assistant_role', 'ops'],
    ['profileVersion', { profileVersion: '6' }, 'm.profile_version', 6],
  ])('%s compares against a placeholder holding its value', async (_name, params, column, expected) => {
    const { sql, values } = await sqlFor(params as Record<string, string>);

    // The comparison exists, and its right-hand side is `$n` - not a bare number, which is what a
    // dropped `$` produces and what Postgres then reads as an integer literal.
    const match = new RegExp(`${column.replace('.', '\\.')}\\s*=\\s*(\\$?\\d+)`).exec(sql);
    expect(match).not.toBeNull();
    const rhs = match![1];
    expect(rhs.startsWith('$')).toBe(true);

    // And the placeholder it names must actually carry the caller's value, so an off-by-one index
    // cannot pass this.
    expect(values[Number(rhs.slice(1)) - 1]).toEqual(expected);
  });

  it('binds every filter at once without colliding indexes', async () => {
    const { sql, values } = await sqlFor({
      channelArn: CHANNEL,
      agentType: 'assistant',
      conversationClassification: 'premium',
      assistantRole: 'ops',
      profileVersion: '6',
    });

    const placeholders = sql.match(/\$\d+/g) ?? [];
    // Every index the SQL names must exist in the bound values.
    for (const p of placeholders) {
      expect(Number(p.slice(1))).toBeLessThanOrEqual(values.length);
    }
    expect(values).toEqual(expect.arrayContaining([CHANNEL, 'assistant', 'premium', 'ops', 6]));
  });
});
