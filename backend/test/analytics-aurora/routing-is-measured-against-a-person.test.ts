/**
 * ROUTING IS MEASURED AGAINST A PERSON, NOT AGAINST ITSELF.
 *
 * The console showed the classifier's own CONFIDENCE and called it routing quality. That is the
 * model grading its own decision. Nothing asked whether the decision was RIGHT, even though the
 * labels to answer it were already stored: `classifier_replay_labels.true_label` is a human's
 * verdict on what the intent should have been.
 *
 * NOT SCHEDULED, and that is a deliberate departure from how the gap was first written up. The
 * comparison is a join between two stored facts, so it needs no model call and nothing to batch.
 * Tenet D6: a timer recomputing what a query derives is duplicated logic with added latency and a
 * second way to be wrong.
 */
const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(new Error('no model in tests')) })),
  InvokeModelCommand: jest.fn((input: unknown) => input),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { edgeContext } from '../helpers/edge-context';

const RANGE = { start: '2026-08-24', end: '2026-09-23' };

const post = (): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: '/query',
  body: JSON.stringify({ queryType: 'routing_agreement', dateRange: RANGE }),
  requestContext: { authorizer: edgeContext({ claims: { sub: 'admin', 'cognito:groups': 'admins' } }) },
} as unknown as APIGatewayProxyEvent);

const statements = (): string[] =>
  mockDbQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));

beforeEach(() => jest.clearAllMocks());

describe('routing agreement', () => {
  it('reports NULL, not zero, when nothing has been labeled', async () => {
    // "No disagreement found" and "nothing was compared" are different statements. A deployment that
    // has adjudicated no replay has no labeled set, and a 0% there would read as a perfect record.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ labeled_count: '0', agreed_count: '0', agreement_rate: null }] });
    const res = await handler(post());
    const body = JSON.parse(res.body);
    expect(body.agreementRate).toBeNull();
    expect(body.labeledCount).toBe(0);
  });

  it('does not run the per-intent breakdown when there is nothing to break down', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ labeled_count: '0', agreed_count: '0', agreement_rate: null }] });
    await handler(post());
    expect(statements()).toHaveLength(1);
  });

  it('reports the rate WITH the population it was computed over', async () => {
    // A rate over eleven labels is not a measurement of a classifier. The denominator is what tells
    // a reader which of the two they are looking at.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ labeled_count: '40', agreed_count: '34', agreement_rate: '85.0' }] })
      .mockResolvedValueOnce({ rows: [] });
    const body = JSON.parse((await handler(post())).body);
    expect(body).toMatchObject({ agreementRate: 85, labeledCount: 40, agreedCount: 34 });
  });

  it('counts only ADJUDICATED rows', async () => {
    // A replay row with no true_label has been produced but not judged. Counting it would score the
    // classifier against another model's prediction rather than against a person.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ labeled_count: '5', agreed_count: '5', agreement_rate: '100.0' }] })
      .mockResolvedValueOnce({ rows: [] });
    await handler(post());
    expect(statements()[0]).toContain('l.true_label IS NOT NULL');
  });

  it('compares the human label to the intent the turn actually recorded', async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ labeled_count: '5', agreed_count: '5', agreement_rate: '100.0' }] })
      .mockResolvedValueOnce({ rows: [] });
    await handler(post());
    const sql = statements()[0];
    expect(sql).toContain('JOIN exchanges e ON e.id = l.exchange_id');
    expect(sql).toContain('l.true_label = e.intent');
  });

  it('names what an intent was mistaken FOR, not just that it was', async () => {
    // A confusion pair is the actionable half of a low rate: it says which boundary to fix rather
    // than reporting that one exists.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ labeled_count: '40', agreed_count: '30', agreement_rate: '75.0' }] })
      .mockResolvedValueOnce({ rows: [{ true_intent: 'expense_report', labeled_count: '10', agreed_count: '6', most_confused_with: 'general' }] });
    const body = JSON.parse((await handler(post())).body);
    expect(statements()[1]).toContain('most_confused_with');
    expect(body.data[0].most_confused_with).toBe('general');
  });

  it('is computed on read, so it can never be stale', async () => {
    // The whole reason this is not a scheduled job: both sides are already stored.
    mockDbQuery.mockResolvedValue({ rows: [{ labeled_count: '0', agreed_count: '0', agreement_rate: null }] });
    await handler(post());
    expect(statements().every((s) => !s.includes('INSERT') && !s.includes('UPDATE'))).toBe(true);
  });
});
