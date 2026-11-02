/**
 * THE ABSOLUTE SCORES ARE CHECKED AGAINST A HUMAN PREFERENCE.
 *
 * Every quality number here is absolute: a judge sees one reply and returns 0-100. The consistent
 * finding in the judging literature is that the same model comparing TWO candidates is markedly more
 * reliable than scoring one, which is why the public arenas are pairwise. That is a claim about
 * instruments, and until it is measured on this deployment it is somebody else's finding.
 *
 * Measured with NO new model call: a duel already produces two replies to one request, a person
 * already picks between them, and both sides already carry a relevance score. So the question "when
 * a person preferred A, did A also score higher?" is answerable from what is stored.
 *
 * A low rate does not mean the humans are wrong. It means the absolute scores are a poor proxy for
 * what people prefer, and the relevance column should be read more cautiously. That is the finding
 * this exists to make available.
 */
const mockDbQuery = jest.fn();
const mockDdbSend = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(new Error('no model in tests')) })),
  InvokeModelCommand: jest.fn((input: unknown) => input),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockDdbSend }) },
  ScanCommand: jest.fn((input) => ({ __scan: input })),
  GetCommand: jest.fn((input) => ({ __get: input })),
  PutCommand: jest.fn((input) => ({ __put: input })),
}));

process.env.BATTLE_OUTCOME_TABLE = 'test-battles';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { edgeContext } from '../helpers/edge-context';

const RANGE = { start: '2026-08-24', end: '2026-09-23' };
const NOW = new Date('2026-09-10T12:00:00Z').toISOString();

const post = (): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: '/query',
  body: JSON.stringify({ queryType: 'pairwise_agreement', dateRange: RANGE }),
  requestContext: { authorizer: edgeContext({ claims: { sub: 'admin', 'cognito:groups': 'admins' } }) },
} as unknown as APIGatewayProxyEvent);

/** One duel's human pick, in the shape the outcome table stores. */
const pick = (battleId: string, winner: 'A' | 'B' | 'tie', variantId?: string) => ({
  battleId,
  schemaVersion: 2,
  votes: { 'user-1': { winner, chosenAt: NOW, variantId, intent: 'general' } },
});

const sides = (battleId: string, control: number, treatment: number) => ([
  { battle_id: battleId, variant_id: 'control', relevance: control },
  { battle_id: battleId, variant_id: 'treatment', relevance: treatment },
]);

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe('pairwise agreement', () => {
  it('reports NULL, not zero, when nobody has picked', async () => {
    // Nobody picking is not the scores disagreeing with nobody.
    mockDdbSend.mockResolvedValueOnce({ Items: [] });
    const body = JSON.parse((await handler(post())).body);
    expect(body.agreementRate).toBeNull();
    expect(body.pickCount).toBe(0);
  });

  it('agrees when the preferred side also scored higher', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [pick('b1', 'A', 'control')] });
    mockDbQuery.mockResolvedValueOnce({ rows: sides('b1', 90, 40) });
    const body = JSON.parse((await handler(post())).body);
    expect(body).toMatchObject({ agreementRate: 100, comparedCount: 1, agreedCount: 1 });
  });

  it('disagrees when the scores favored the side the person did NOT pick', async () => {
    // The case the whole metric exists for.
    mockDdbSend.mockResolvedValueOnce({ Items: [pick('b1', 'A', 'control')] });
    mockDbQuery.mockResolvedValueOnce({ rows: sides('b1', 40, 90) });
    const body = JSON.parse((await handler(post())).body);
    expect(body).toMatchObject({ agreementRate: 0, comparedCount: 1, agreedCount: 0 });
  });

  it('counts an exact score tie as DISAGREEMENT', async () => {
    // The instrument expressed no preference where the person did, which is the failure being
    // measured - not a neutral outcome.
    mockDdbSend.mockResolvedValueOnce({ Items: [pick('b1', 'A', 'control')] });
    mockDbQuery.mockResolvedValueOnce({ rows: sides('b1', 70, 70) });
    const body = JSON.parse((await handler(post())).body);
    expect(body.agreedCount).toBe(0);
    expect(body.comparedCount).toBe(1);
  });

  it('excludes a human TIE, which expresses no preference to check', async () => {
    mockDdbSend.mockResolvedValueOnce({ Items: [pick('b1', 'tie')] });
    const body = JSON.parse((await handler(post())).body);
    expect(body.pickCount).toBe(0);
    expect(body.agreementRate).toBeNull();
  });

  it('skips a duel where only ONE side was scored', async () => {
    // Treating the missing side as zero would make the scored side win every time, manufacturing
    // agreement out of missing data.
    mockDdbSend.mockResolvedValueOnce({ Items: [pick('b1', 'A', 'control')] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ battle_id: 'b1', variant_id: 'control', relevance: 90 }] });
    const body = JSON.parse((await handler(post())).body);
    expect(body.comparedCount).toBe(0);
    expect(body.pickCount).toBe(1);
  });

  it('reports how many picks could not be checked, not just the rate', async () => {
    // The gap between pickCount and comparedCount is how much human signal the scores could not be
    // compared against, and a rate without it overstates its own coverage.
    mockDdbSend.mockResolvedValueOnce({
      Items: [pick('b1', 'A', 'control'), pick('b2', 'B', 'treatment')],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: sides('b1', 90, 40) });
    const body = JSON.parse((await handler(post())).body);
    expect(body.pickCount).toBe(2);
    expect(body.comparedCount).toBe(1);
  });

  it('spends no model call', async () => {
    // The whole design: a duel already produced the pair and the person already judged it.
    mockDdbSend.mockResolvedValueOnce({ Items: [pick('b1', 'A', 'control')] });
    mockDbQuery.mockResolvedValueOnce({ rows: sides('b1', 90, 40) });
    await handler(post());
    const wrote = mockDbQuery.mock.calls.some((c) => /INSERT|UPDATE/.test(String(c[0])));
    expect(wrote).toBe(false);
  });
});
