/**
 * A reply names the passages it rests on (SPEC-EVALUATION Appendix C7): the groundedness judge returns
 * them in the call it already makes, each passage's source is kept, and NULL stays NOT ASSESSED.
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

import { usedPassageCountOf, passageSourcesOf } from '../../lambda/src/analytics-aurora/evaluation-runner';
import { handler, RETRIEVAL_SOURCE_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';

const AURORA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const runner = fs.readFileSync(path.join(AURORA, 'evaluation-runner.ts'), 'utf8');
const migration = fs.readFileSync(path.join(AURORA, 'schema', '085-a-reply-names-the-passages-it-rests-on.sql'), 'utf8');

const passages = [
  { sourceId: 'doc-a', title: 'Travel policy' },
  { sourceId: 'doc-b', title: 'Expense policy' },
  { sourceId: 'doc-a', title: 'Travel policy' },
];

describe('the used passages come back from the groundedness call', () => {
  it('asks for them in the same prompt, so no second judge call is made', () => {
    const prompt = runner.slice(runner.indexOf('const GROUNDEDNESS_PROMPT'), runner.indexOf('const GROUNDEDNESS_RUBRIC_VERSION'));
    expect(prompt).toMatch(/"usedPassages": \[<passage numbers>\]/);
  });

  it('counts distinct passages it was shown, and ignores numbers that name none', () => {
    expect(usedPassageCountOf([1, 3, 3, 9, 0, 'x'], 3)).toBe(2);
    expect(usedPassageCountOf([], 3)).toBe(0);
  });

  it('records NOT ASSESSED rather than "used none" when the judge gave no list', () => {
    expect(usedPassageCountOf(undefined, 3)).toBeNull();
    expect(passageSourcesOf('1,2', passages)).toBeNull();
  });

  it('keeps each passage\'s source beside whether it was used, in the order shown', () => {
    expect(passageSourcesOf([2], passages)).toEqual([
      { sourceId: 'doc-a', title: 'Travel policy', used: false },
      { sourceId: 'doc-b', title: 'Expense policy', used: true },
      { sourceId: 'doc-a', title: 'Travel policy', used: false },
    ]);
  });

  it('the reader keeps the source the turn recorded', () => {
    expect(runner).toMatch(/sourceId: String\(c\.sourceId \?\? 'unknown'\)/);
  });

  it('stores both on the reply and on a delivered document\'s grade', () => {
    expect(runner.match(/used_passage_count, passage_sources,/g)?.length).toBe(2);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS used_passage_count SMALLINT/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS passage_sources JSONB/);
  });
});

const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

describe('retrieval per source', () => {
  beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));

  it('reads the stored sources, bound to the team\'s assistant and clearance', async () => {
    await handler(teamPost('analyst', { queryType: 'retrieval_sources', agentType: 'advisor' }));
    const [sql, params] = mockDbQuery.mock.calls.find(([s]) => String(s).includes('passage_sources'))!;
    expect(sql).toMatch(/GROUP BY e\.assistant, e\.conversation_classification, p->>'sourceId'/);
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
  });

  it('returns every column it declares', async () => {
    const row = Object.fromEntries(RETRIEVAL_SOURCE_COLUMNS.map((c) => [c, null]));
    mockDbQuery.mockResolvedValue({ rows: [{ ...row, assistant: 'analyst', conversation_classification: 'standard' }] });
    const body = JSON.parse((await handler(teamPost('analyst', { queryType: 'retrieval_sources' }))).body);
    expect(Object.keys(body.data[0]).sort()).toEqual([...RETRIEVAL_SOURCE_COLUMNS].sort());
  });
});
