/**
 * The Performance overview's message flow: path, intent and outcome over the same
 * turns the Latency tab reads, every latency average with its count, the turns behind any node with no
 * message text, and one turn's record bound by the same filters.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler, MESSAGE_FLOW_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';

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

describe('the message flow', () => {
  it('reads the Latency tab\'s turns, narrowed to the ones that answered something, with round two held out', async () => {
    await handler(teamPost('analyst', { queryType: 'message_flow' }));
    const sql = firstSql();
    expect(sql).toMatch(/LEFT JOIN v_turn_latency vl ON vl\.response_id = m\.message_id/);
    expect(sql).toMatch(/AND \(e\.id IS NOT NULL OR lbl\.delivery_option = 'REFUSED' OR lbl\.kind = 'handover'\)/);
    expect(sql).toMatch(/COALESCE\(m\.battle_round, 1\) <= 1/);
  });

  it('decides each outcome once, refusal first, from recorded facts', async () => {
    await handler(teamPost('analyst', { queryType: 'message_flow' }));
    const sql = firstSql();
    const order = ["'refused'", "'handed'", "'stopped'", "'task'", "'answered'"].map((o) => sql.indexOf(`THEN ${o}`) >= 0 ? sql.indexOf(`THEN ${o}`) : sql.indexOf(`ELSE ${o}`));
    expect(order.every((p) => p > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sql).toMatch(/tc\.kind = 'cancelled_response'/);
  });

  it('returns every latency average with the count it was taken over, so the console can weight them', () => {
    for (const metric of ['ttff', 'e2e', 'router', 'classifier', 'total', 'resolve', 'model', 'tool']) {
      expect(MESSAGE_FLOW_COLUMNS).toContain(`${metric}_n`);
    }
  });

  it('is bound to the team\'s assistant and the rooms its clearance reaches', async () => {
    await handler(teamPost('analyst', { queryType: 'message_flow', agentType: 'advisor' }));
    expect(firstParams()).toContain('analyst');
    expect(firstParams()).not.toContain('advisor');
  });
});

describe('the shared bar Path and Battle filters', () => {
  it('narrows the flow by path and keeps battle turns out when asked', async () => {
    await handler(teamPost('analyst', { queryType: 'message_flow', turnEntry: 'lex', duelRound: 'none' }));
    expect(firstParams()).toEqual(expect.arrayContaining(['lex', 'none']));
    expect(firstSql()).toContain("$8 = 'none' AND m.battle_round IS NULL");
  });

  it('narrows Effectiveness the same way, through the answer message of each exchange', async () => {
    await handler(teamPost('analyst', { queryType: 'intent_effectiveness', turnEntry: 'flow', duelRound: '1' }));
    const sql = firstSql();
    expect(firstParams()).toEqual(expect.arrayContaining(['flow', '1']));
    expect(sql).toContain('SELECT pm.turn_entry FROM messages pm WHERE pm.id = e.agent_message_id');
    expect(sql).toContain('SELECT pm.battle_round FROM messages pm WHERE pm.id = e2.agent_message_id');
  });
});

describe('the shared bar Response type filter', () => {
  it('narrows the flow by the delivery option Latency labels the turn with', async () => {
    await handler(teamPost('analyst', { queryType: 'message_flow', responseType: 'TASK_STEP' }));
    expect(firstParams()).toContain('TASK_STEP');
    expect(firstSql()).toContain('lbl.delivery_option = $9');
  });

  it('narrows Effectiveness by the delivery option of each exchange', async () => {
    await handler(teamPost('analyst', { queryType: 'intent_effectiveness', responseType: 'DIRECT_REPLY' }));
    expect(firstParams()).toContain('DIRECT_REPLY');
    expect(firstSql()).toContain('e.delivery_option = $11');
  });
});

describe('the turns behind a node', () => {
  it('filters on the node and reads no message text', async () => {
    await handler(teamPost('analyst', { queryType: 'flow_turns', flowPath: 'lex', flowIntent: 'report_request', flowOutcome: 'task' }));
    const sql = firstSql();
    expect(firstParams()).toEqual(expect.arrayContaining(['lex', 'report_request', 'task']));
    const select = sql.slice(0, sql.indexOf('FROM messages m'));
    expect(select).not.toMatch(/content/);
  });

  it('opens one turn only within the same filters, so a team cannot read another assistant\'s turn by id', async () => {
    await handler(teamPost('analyst', { queryType: 'flow_turn', messageId: 'm-1' }));
    expect(firstParams()).toEqual(expect.arrayContaining(['analyst', 'm-1']));
    expect(firstSql()).toMatch(/WHERE m\.id::text = \$10/);
  });
});
