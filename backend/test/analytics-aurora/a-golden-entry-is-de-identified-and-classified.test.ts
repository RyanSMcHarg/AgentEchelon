/**
 * The golden set (SPEC-EVALUATION FR14, FR16, Appendix C1): an entry is nominated from a labeled answer,
 * copied from the de-identified copy and never the raw exchange, written as the write role into a table
 * inside the classification boundary, and read back under each classification's own reader role. The
 * label queue puts the answers a person's label is worth most on first.
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
const mockClientQuery = jest.fn();
const mockWithReaderRole = jest.fn(async (_c: string, fn: (client: unknown) => unknown) => fn({ query: mockClientQuery }));
const mockWithWriterRole = jest.fn(async (fn: (client: unknown) => unknown) => fn({ query: mockClientQuery }));
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => {
  const actual = jest.requireActual('../../lambda/src/analytics-aurora/classification-boundary');
  return { ...actual, withReaderRole: (c: string, fn: (client: unknown) => unknown) => mockWithReaderRole(c, fn), withWriterRole: (fn: (client: unknown) => unknown) => mockWithWriterRole(fn) };
});

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { BOUNDED_TABLES } from '../../lambda/src/analytics-aurora/classification-boundary-sql';
import { analyticsPathFor as pathFor } from '../helpers/analytics-path';

const SUB = '7f1c2a44-0000-4000-8000-abcdefabcdef';
const EXCHANGE = 'e1111111-2222-4333-8444-555555555555';

function adminEvent(body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: pathFor(body),
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: `arn:aws:sts::123456789012:assumed-role/agent-echelon-admin-console/console-${SUB}` } },
  } as unknown as APIGatewayProxyEvent;
}

const exchangeRow = (over: Record<string, unknown> = {}) => ({
  assistant: 'analyst', conversation_classification: 'standard', intent: 'report_request', channel_arn: 'arn:ch',
  user_mid: 'u-1', agent_mid: 'a-1', human_score: 85, ...over,
});

function db(rows: { exchange?: Record<string, unknown> | null; clean?: Array<Record<string, unknown>>; preceding?: Array<Record<string, unknown>> }) {
  mockDbQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('AS user_mid')) return { rows: rows.exchange === null ? [] : [rows.exchange ?? exchangeRow()] };
    // The turns before the request (ADR-065), newest first, from the same de-identified copy.
    if (String(sql).includes('seq < (SELECT seq FROM clean_conversation_rows')) return { rows: rows.preceding ?? [] };
    if (String(sql).includes('FROM clean_conversation_rows')) return { rows: rows.clean ?? [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_IAM_ENFORCEMENT = 'true';
  process.env.USER_POOL_ID = 'us-east-1_pool';
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

const nominate = (extra: Record<string, unknown> = {}) =>
  handler(adminEvent({ queryType: 'golden_set', action: 'nominate', exchangeId: EXCHANGE, purpose: 'regression', ...extra }));
const insertParams = () => mockClientQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO golden_set_entries'))?.[1] as unknown[] | undefined;

describe('nominating an entry', () => {
  it('copies the de-identified request and answer, never the raw exchange, as the write role', async () => {
    db({ clean: [
      { source_message_id: 'u-1', text: 'What did [a person] spend on travel in Q3?' },
      { source_message_id: 'a-1', text: '[A person] spent [an amount] on travel in Q3.' },
    ] });
    const res = JSON.parse((await nominate()).body);
    expect(res).toMatchObject({ submitted: true });
    expect(mockWithWriterRole).toHaveBeenCalledTimes(1);
    const p = insertParams()!;
    expect(p).toEqual(['standard', 'regression', 'analyst', 'report_request',
      'What did [a person] spend on travel in Q3?', '[A person] spent [an amount] on travel in Q3.', 85, EXCHANGE, SUB, null, null, null]);
  });

  it('copies what the answer was given: its tools, its reply-preference keys and the de-identified turns before it', async () => {
    db({
      exchange: exchangeRow({ agent_metadata: { toolCalls: [{ name: 'load_company_context' }], replyPreferences: { answerStyle: 'brief', invented: 'x' } } }),
      clean: [{ source_message_id: 'u-1', text: 'And for Q4?' }, { source_message_id: 'a-1', text: '[A person] spent less.' }],
      preceding: [{ actor_kind: 'assistant', text: 'Q3 was [an amount].' }, { actor_kind: 'person', text: 'What did [a person] spend in Q3?' }],
    });
    expect(JSON.parse((await nominate()).body)).toMatchObject({ submitted: true });
    const p = insertParams()!;
    expect(p[9]).toEqual(['load_company_context']);
    expect(JSON.parse(p[10] as string)).toEqual({ answerStyle: 'brief' });
    expect(JSON.parse(p[11] as string)).toEqual([
      { role: 'user', text: 'What did [a person] spend in Q3?' },
      { role: 'assistant', text: 'Q3 was [an amount].' },
    ]);
  });

  it('refuses when the de-identified copy is not ready, rather than falling back to the raw text', async () => {
    db({ clean: [] });
    expect(JSON.parse((await nominate()).body)).toMatchObject({ submitted: false });
    expect(insertParams()).toBeUndefined();
  });

  it('needs a person\'s label, and a regression entry needs one that passed', async () => {
    db({ exchange: exchangeRow({ human_score: null }), clean: [{ source_message_id: 'u-1', text: 'q' }] });
    expect(JSON.parse((await nominate()).body)).toMatchObject({ submitted: false });
    db({ exchange: exchangeRow({ human_score: 20 }), clean: [{ source_message_id: 'u-1', text: 'q' }, { source_message_id: 'a-1', text: 'a' }] });
    expect(JSON.parse((await nominate()).body)).toMatchObject({ submitted: false });
    expect(insertParams()).toBeUndefined();
  });

  it('takes a failed answer as a capability entry, with no reference', async () => {
    db({ exchange: exchangeRow({ human_score: 20 }), clean: [{ source_message_id: 'u-1', text: 'q' }, { source_message_id: 'a-1', text: 'a bad answer' }] });
    expect(JSON.parse((await nominate({ purpose: 'capability' })).body)).toMatchObject({ submitted: true });
    expect(insertParams()![5]).toBeNull();
  });
});

describe('reading the set', () => {
  it('reads each classification under its own reader role', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: 'g1', conversation_classification: 'standard' }] });
    await handler(adminEvent({ queryType: 'golden_set' }));
    const read = mockWithReaderRole.mock.calls.map(([c]) => c);
    expect(read.length).toBeGreaterThan(1);
    for (const [i, c] of read.entries()) {
      // The role assumed and the classification asked for are the same one, on every read.
      expect(mockClientQuery.mock.calls[i][1][0]).toBe(c);
    }
  });

  it('is a bounded table, so the database itself refuses another classification\'s role', () => {
    expect(BOUNDED_TABLES).toContain('golden_set_entries');
    const verify = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/classification-boundary-verify.ts'), 'utf8');
    expect(verify).toMatch(/name: 'golden:low-reader-cannot-see-high-entry'/);
    // A draft's run against the set is bounded the same way (ADR-065).
    expect(BOUNDED_TABLES).toEqual(expect.arrayContaining(['golden_runs', 'golden_run_attempts']));
    expect(verify).toMatch(/name: 'golden:low-reader-cannot-see-high-run'/);
  });
});

describe('the label queue', () => {
  it('puts answers the guardrail found something on first, then unsure or flagged ones, and leaves labeled ones out', async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    await handler(adminEvent({ queryType: 'label_queue' }));
    const [sql] = mockDbQuery.mock.calls.find(([s]) => String(s).includes('has_safety_finding'))!;
    expect(sql).toMatch(/ORDER BY has_safety_finding DESC, is_unsure_or_flagged DESC, created_at DESC/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM ground_truth_scores g WHERE g\.exchange_id = e\.id\)/);
  });
});
