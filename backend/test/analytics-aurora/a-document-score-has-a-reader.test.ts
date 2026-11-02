/**
 * A DOCUMENT SCORE HAS A READER (SPEC-EVALUATION FR22; SPEC-ADMIN-CONSOLE-EFFECTIVENESS).
 *
 * The runner writes a delivered document's grade as a row of its own (`evaluation_type = 'document'`),
 * and every other reader filters to `exchange`, so until `document_evaluation` the document scores
 * reached no surface. These go through `handler` with the database mocked and assert on the SQL that was
 * sent and the body that came back:
 *
 *  - the aggregate reads the document's own row for relevance, groundedness and compliance, the reply's
 *    row only for the reply's relevance beside it, and never one in place of the other;
 *  - it is grouped by intent and by task type, and every document lands in exactly one grading state;
 *  - naming a conversation returns that conversation's documents with their scores and grading state,
 *    for the drill-down to show next to the delivered file.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { edgeContext } from '../helpers/edge-context';

const mockDbQuery = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: jest.fn() }) },
  ScanCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/analytics-aurora/analytics-query');

const DAY = 24 * 60 * 60 * 1000;
const RANGE = {
  start: new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10),
  end: new Date().toISOString().slice(0, 10),
};
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/ch-1';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

const call = async (body: Record<string, unknown>) => {
  const res = await handler(postEvent({ dateRange: RANGE, ...body }) as never);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

const sqlSent = (): string[] => mockDbQuery.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
});

describe('document_evaluation, by intent and by task type', () => {
  const ROWS = [
    { dimension: 'intent', group_key: 'report_request', documents_delivered: '4', documents_scored: '2', documents_skipped: '1', documents_failed: '1', doc_avg_relevance: '64.0', reply_avg_relevance: '90.0' },
    { dimension: 'task_type', group_key: 'report_generation', documents_delivered: '4', documents_scored: '2', documents_skipped: '1', documents_failed: '1', doc_avg_relevance: '64.0', reply_avg_relevance: '90.0' },
  ];

  it('returns both dimensions to the caller', async () => {
    mockDbQuery.mockResolvedValue({ rows: ROWS, rowCount: ROWS.length });
    const { status, body } = await call({ queryType: 'document_evaluation' });
    expect(status).toBe(200);
    expect(body.data).toEqual(ROWS);
  });

  it('reads the document\'s own row for its scores and the reply\'s row only beside them', async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await call({ queryType: 'document_evaluation' });
    const sql = sqlSent().find((s) => s.includes("'task_type' AS dimension"))!;
    expect(sql).toBeDefined();
    // The document's scores come from the document row, joined as `d`.
    expect(sql).toMatch(/WHERE evaluation_type = 'document'[\s\S]*\) d ON d\.exchange_id = e\.id/);
    expect(sql).toContain('d.relevance_score AS doc_relevance');
    expect(sql).toContain('d.is_grounded AS doc_grounded');
    expect(sql).toContain('d.is_compliant AS doc_compliant');
    // The reply's comes from the exchange row, joined as `rr`, and is its own column.
    expect(sql).toMatch(/WHERE evaluation_type = 'exchange'[\s\S]*\) rr ON rr\.exchange_id = e\.id/);
    expect(sql).toContain('ROUND(AVG(reply_relevance)::numeric, 1) AS reply_avg_relevance');
    expect(sql).not.toMatch(/AVG\(COALESCE\(doc_relevance, reply_relevance\)/);
    // Grouped both ways, one turn per row.
    expect(sql).toContain("'intent' AS dimension, intent AS group_key");
    expect(sql).toContain("COALESCE(NULLIF(md.ref->>'kind', ''), 'document') AS task_type");
    expect(sql).toContain('e.queued_as IS NULL');
  });

  it('puts every document in exactly one grading state, with the denominators beside the rates', async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await call({ queryType: 'document_evaluation' });
    const sql = sqlSent().find((s) => s.includes("'task_type' AS dimension"))!;
    for (const col of ['documents_delivered', 'documents_scored', 'documents_skipped', 'documents_retrying', 'documents_failed', 'documents_awaiting',
      'doc_groundedness_assessed_count', 'doc_compliance_assessed_count', 'reply_scored_count']) {
      expect(sql).toContain(`AS ${col}`);
    }
    expect(sql).toContain("COUNT(*) FILTER (WHERE NOT scored AND grading_status = 'exhausted') AS documents_failed");
    expect(sql).toContain('COUNT(*) FILTER (WHERE NOT scored AND grading_status IS NULL) AS documents_awaiting');
    expect(sql).toContain('LEFT JOIN document_grading_attempts ga ON ga.exchange_id = e.id');
  });
});

describe('document_evaluation for one conversation', () => {
  it('returns each delivered document with its score and grading state, for the drill-down', async () => {
    const row = {
      exchange_id: 'ex-1', agent_message_id: 'm-bot', channel_arn: CHANNEL, conversation_classification: 'standard',
      file_key: 'generated-docs/ch-1/report.md', relevance_score: 64, grading_status: 'scored', reply_relevance_score: 90,
    };
    mockDbQuery.mockResolvedValue({ rows: [row], rowCount: 1 });
    const { body } = await call({ queryType: 'document_evaluation', channelArn: CHANNEL });
    expect(body.data).toEqual([row]);
    const [sql, params] = mockDbQuery.mock.calls.find((c) => String(c[0]).includes('WHERE e.channel_arn = $1'))!;
    expect(params[0]).toBe(CHANNEL);
    expect(String(sql)).toContain("md.ref->>'fileKey' AS file_key");
    expect(String(sql)).toContain("WHEN ga.status = 'exhausted' THEN 'failed'");
    // Not the aggregate: no grouping by dimension.
    expect(String(sql)).not.toContain('AS dimension');
  });
});
