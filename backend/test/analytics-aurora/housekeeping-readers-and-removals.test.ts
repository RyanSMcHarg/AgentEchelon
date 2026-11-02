/**
 * SPEC-EVALUATION Appendix C housekeeping: what is recorded gets a reader, and what nothing writes goes.
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

import { handler, TEMPLATE_OUTCOME_COLUMNS } from '../../lambda/src/analytics-aurora/analytics-query';

const SCHEMA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'schema');
const SUB = '11111111-2222-3333-4444-555555555555';
const teamPost = (assistant: string, body: Record<string, unknown>): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: `/analytics/assistants/${assistant}/query`,
  pathParameters: { assistant },
  body: JSON.stringify({ dateRange: { start: '2026-10-01', end: '2026-10-26' }, ...body }),
  requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
} as unknown as APIGatewayProxyEvent);

describe('the template check outcomes have a reader', () => {
  beforeEach(() => mockDbQuery.mockReset().mockResolvedValue({ rows: [] }));

  it('counts each outcome per template, and the template versions a row spans', async () => {
    await handler(teamPost('analyst', { queryType: 'template_outcomes', agentType: 'advisor' }));
    const [sql, params] = mockDbQuery.mock.calls.find(([s]) => String(s).includes('documentTemplate'))!;
    for (const o of ['passed', 'passed_after_correction', 'posted_inline', 'filled_by_platform']) {
      expect(sql).toContain(`tpl->>'outcome' = '${o}'`);
    }
    expect(sql).toMatch(/COUNT\(DISTINCT tpl->>'contentHash'\)::int AS template_versions/);
    expect(params).toContain('analyst');
    expect(params).not.toContain('advisor');
    expect(TEMPLATE_OUTCOME_COLUMNS).toContain('template_versions');
  });
});

describe('a table nothing writes is dropped', () => {
  const sql = fs.readFileSync(path.join(SCHEMA, '088-a-table-nothing-writes-is-dropped.sql'), 'utf8');

  it('drops agent_scores only once 075, which updates it, has finished, and stays pending until then', () => {
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM _migrations WHERE filename = '075-the-assistant-column-names-what-it-holds\.sql'\)/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS agent_scores;/);
    expect(sql).toMatch(/remaining = 1/);
  });

  it('leaves nothing in the code reading the dropped table', () => {
    const src = path.join(__dirname, '..', '..', 'lambda', 'src');
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'schema' && e.name !== 'node_modules') walk(p); continue; }
        if (p.endsWith('.ts') && !p.endsWith('.d.ts') && fs.readFileSync(p, 'utf8').includes('agent_scores')) readers.push(p);
      }
    };
    walk(src);
    expect(readers).toEqual([]);
  });
});
