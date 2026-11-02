/**
 * A TEAM READS ONLY ITS ASSISTANT'S ANALYTICS, WITHIN ITS OWN CLEARANCE (SPEC-ADMIN-CONSOLE FR48).
 *
 * `POST /analytics/assistants/{assistant}/query` is the team route. IAM admits a team member only to an
 * assistant the exchange named in their session; this handler, which runs in a VPC with no route to
 * read ownership again, binds what it returns to the assistant in the path AND to the rooms the
 * session's clearance reaches, which the exchange wrote into the session's name. A query that cannot
 * be bound to both is refused rather than answered across assistants or above the clearance.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';

const SUB = '11111111-2222-3333-4444-555555555555';
/** A team console session, named by the exchange with its holder's clearance. */
const teamPost = (assistant: string, body: Record<string, unknown>, clearance = 'standard'): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-09-01', end: '2026-09-16' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@${clearance}` } },
} as unknown as APIGatewayProxyEvent);

beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));

describe('the team analytics route', () => {
  it('runs a filtered query for the path\'s assistant and the rooms the clearance reaches, whatever the body names', async () => {
    const res = await handler(teamPost('analyst', { queryType: 'intent_effectiveness', agentType: 'advisor' }));
    expect(res.statusCode).toBe(200);
    const params = mockDbQuery.mock.calls.flatMap(([, p]) => (p as unknown[]) ?? []);
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
    const reach = params.find((p) => Array.isArray(p) && (p as string[]).includes('standard')) as string[];
    expect(reach).toBeDefined();
    expect(reach).not.toContain('premium');
  });

  it('cuts a row-attributed query to the assistant\'s rows within the clearance, and returns nothing else', async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { date: '2026-09-02', assistant: 'analyst', conversation_classification: 'standard', turns: '4' },
        { date: '2026-09-02', assistant: 'analyst', conversation_classification: 'premium', turns: '7' },
        { date: '2026-09-02', assistant: 'analyst', conversation_classification: null, turns: '2' },
        { date: '2026-09-02', assistant: 'advisor', conversation_classification: 'standard', turns: '90' },
      ],
    });
    const res = await handler(teamPost('analyst', { queryType: 'latency_metrics' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ assistant: 'analyst', conversation_classification: 'standard' });
  });

  it('sees nothing when the session names no clearance', async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ assistant: 'analyst', conversation_classification: 'basic' }] });
    const res = await handler(teamPost('analyst', { queryType: 'latency_metrics' }, ''));
    expect(JSON.parse(res.body).data ?? []).toEqual([]);
  });

  it.each([
    // Room-wide counts, not one assistant's turns.
    'conversation_volumes', 'intent_distribution', 'user_ratings',
    // Return what was said: a per-conversation read a team has no vend or reason for.
    'evaluation_exchanges', 'execution_steps',
    // Per assistant, but with no way to bind them to the holder's clearance.
    'intent_exchanges', 'router_steps', 'task_details',
  ])('refuses %s', async (queryType) => {
    const res = await handler(teamPost('analyst', { queryType }));
    expect(res.statusCode).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

/** A team write, on the capability path the handler maps it to (`triage`, `ground-truth`). */
const teamWrite = (assistant: string, sub: 'triage' | 'ground-truth', body: Record<string, unknown>, clearance = 'standard'): APIGatewayProxyEvent => ({
  ...teamPost(assistant, {}, clearance),
  path: `/analytics/assistants/${assistant}/${sub}`,
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

describe('a team\'s triage and labels', () => {
  const sqlOf = (i: number) => String(mockDbQuery.mock.calls[i]?.[0] ?? '');

  it('flags a response only when its assistant answered it, in a room the clearance reaches', async () => {
    // The team check, then the write's own check that the message is an answer (every flag makes it).
    mockDbQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }).mockResolvedValue({ rows: [] });
    const res = await handler(teamWrite('analyst', 'triage', { queryType: 'flagged_responses', action: 'flag', channelArn: 'arn:c', messageId: 'm1', reason: 'poor_answer' }));
    expect(res.statusCode).toBe(200);
    expect(sqlOf(0)).toMatch(/JOIN exchanges e ON e.agent_message_id = m.id/);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(['m1', 'arn:c', 'analyst', expect.arrayContaining(['standard'])]);
    expect(sqlOf(2)).toMatch(/INSERT INTO human_flag/);
  });

  it.each([
    ['a flag', 'triage', { queryType: 'flagged_responses', action: 'flag', channelArn: 'arn:c', messageId: 'm1', reason: 'poor_answer' }],
    ['an unflag', 'triage', { queryType: 'flagged_responses', action: 'unflag', channelArn: 'arn:c', messageId: 'm1' }],
    ['a review', 'triage', { queryType: 'flagged_responses', action: 'review', exchangeId: 'e1', reviewAction: 'approved' }],
    ['a label', 'ground-truth', { queryType: 'ground_truth', action: 'submit', exchangeId: 'e1', score: 70 }],
  ] as const)('refuses %s on another assistant\'s turn, writing nothing', async (_label, sub, body) => {
    const res = await handler(teamWrite('analyst', sub, body));
    expect(res.statusCode).toBe(403);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(sqlOf(0)).not.toMatch(/INSERT|DELETE/);
  });

  it('never adjudicates a classifier, which serves a whole classification', async () => {
    const res = await handler(teamWrite('analyst', 'ground-truth', { queryType: 'classifier_replay_adjudicate', labelId: 'l1', trueLabel: 'x' }));
    expect(res.statusCode).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each(['flagged_responses', 'ground_truth'])('reads %s only with a stated reason, bound to the assistant and clearance', async (queryType) => {
    const refused = await handler(teamPost('analyst', { queryType }));
    expect(refused.statusCode).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();

    const res = await handler(teamPost('analyst', { queryType, accessReason: 'weekly review' }));
    expect(res.statusCode).toBe(200);
    const call = mockDbQuery.mock.calls.find(([sql]) => /conversation_classification = ANY/.test(String(sql)))!;
    expect(call[1]).toContain('analyst');
    // Bound to the exchange's own assistant: never the conversation's single agent_type, which would
    // hand a team an unattributed turn.
    expect(String(call[0])).not.toContain('COALESCE(e.assistant, c.assistant) = $');
    // The clearance is the last array bound (the flagged list binds its person-raised flags first).
    const reach = (call[1] as unknown[]).filter((p) => Array.isArray(p)).pop() as string[];
    expect(reach).toContain('standard');
    expect(reach).not.toContain('premium');
  });
});

/**
 * PHASE 6: SPEND, TURN KINDS AND DRIFT, PER ASSISTANT. Each is attributed per turn through the exchange
 * the assistant answered, so a room with several assistants splits by who answered, and a row no
 * exchange claims - an unpaired message, or one migration 055 could not backfill - is no team's.
 */
describe('analytics attributed per assistant', () => {
  it.each(['model_usage', 'model_effectiveness', 'turn_kinds', 'drift_events'])(
    'binds %s to the assistant and the clearance in its SQL',
    async (queryType) => {
      const res = await handler(teamPost('analyst', { queryType, agentType: 'advisor' }));
      expect(res.statusCode).toBe(200);
      expect(mockDbQuery).toHaveBeenCalled();
      for (const [sql, p] of mockDbQuery.mock.calls as Array<[string, unknown[]]>) {
        // Every statement the query runs carries the binding - drift runs a list and a summary.
        expect(sql).toMatch(/assistant = \$\d/);
        expect(sql).toMatch(/conversation_classification = ANY\(\$\d/);
        expect(p).toContain('analyst');
        expect(p).not.toContain('advisor');
        const reach = p.filter((x) => Array.isArray(x)).pop() as string[];
        expect(reach).toContain('standard');
        expect(reach).not.toContain('premium');
      }
    },
  );

  it('leaves an admin\'s figures unbound', async () => {
    const adminPost = {
      ...teamPost('analyst', { queryType: 'model_usage' }),
      path: '/',
      pathParameters: null,
      requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-admin-console/console-${SUB}` } },
    } as unknown as APIGatewayProxyEvent;
    await handler(adminPost);
    const [, p] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(p.slice(1)).toEqual([null, null]);
  });
});
