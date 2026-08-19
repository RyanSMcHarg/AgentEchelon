/**
 * Drift-offer evaluation (Pass C) - the ACCURACY half of the drift health surface.
 *
 * Accuracy is a judgement about the CALL, deliberately independent of how the user reacted: a
 * correct suggestion can be declined and a bad one accepted. These pin the properties that would
 * otherwise let a wrong or unmeasured number reach the console.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn((input) => ({ input })),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn(), ensureSchema: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { handler } from '../../lambda/src/analytics-aurora/evaluation-runner';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function bedrockJson(obj: unknown) {
  const payload = JSON.stringify({ content: [{ text: JSON.stringify(obj) }] });
  return { body: new TextEncoder().encode(payload) };
}

/** Pass A (no exchanges) then Pass B (no flows), so only Pass C does work. */
function skipPassesAandB() {
  mockedQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // getUnscoredExchanges
    .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // getFlowsToScore
}

const OFFER = {
  event_id: 'evt-1',
  user_message: 'Actually, can you help me plan the Q3 offsite instead?',
  conversation_summary: 'The user is debugging a failing CI pipeline.',
};

describe('drift-offer evaluation (Pass C)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('judges an unevaluated live offer and records the verdict', async () => {
    skipPassesAandB();
    mockedQuery
      .mockResolvedValueOnce({ rows: [OFFER], rowCount: 1 } as never) // getUnjudgedDriftOffers
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE drift_events

    mockSend.mockResolvedValueOnce(bedrockJson({ correct: true, reasoning: 'genuinely a new subject' }));

    const res = await handler({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).driftOffersScored).toBe(1);

    const update = mockedQuery.mock.calls.at(-1)!;
    expect(String(update[0])).toContain('UPDATE drift_events');
    expect(String(update[0])).toContain('evaluated_at = NOW()');
    expect((update[1] as unknown[])[0]).toBe(true); // evaluated_correct
    expect((update[1] as unknown[])[3]).toBe('evt-1');
  });

  it('selects only LIVE offers with an archived message body', async () => {
    // Archival rows are post-hoc scoring that was never shown to anyone (migration 016); judging
    // them would score a suggestion that does not exist. A row whose message has not been archived
    // yet must not be judged without its input either - it becomes eligible when archival lands.
    skipPassesAandB();
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await handler({});

    const select = String(mockedQuery.mock.calls[2][0]);
    expect(select).toContain("d.source = 'live'");
    expect(select).toContain('d.evaluated_at IS NULL');
    expect(select).toContain('m.content IS NOT NULL');
  });

  it('does NOT record a verdict when the judge returns unparseable output', async () => {
    // A parse failure must leave evaluated_at NULL so the offer stays "not measured" and is
    // retried, rather than being written down as a wrong (or right) call.
    skipPassesAandB();
    mockedQuery.mockResolvedValueOnce({ rows: [OFFER], rowCount: 1 } as never);
    mockSend.mockResolvedValueOnce({ body: new TextEncoder().encode(JSON.stringify({ content: [{ text: 'not json' }] })) });

    const res = await handler({});

    expect(JSON.parse(res.body).driftOffersScored).toBe(0);
    expect(JSON.parse(res.body).driftOfferErrors).toBe(1);
    const updates = mockedQuery.mock.calls.filter((c) => String(c[0]).includes('UPDATE drift_events'));
    expect(updates).toHaveLength(0);
  });

  it('does NOT record a verdict when the judge omits a boolean', async () => {
    // A judge that returns only prose has expressed no verdict; coercing that to false would
    // manufacture a "wrong call" finding.
    skipPassesAandB();
    mockedQuery.mockResolvedValueOnce({ rows: [OFFER], rowCount: 1 } as never);
    mockSend.mockResolvedValueOnce(bedrockJson({ reasoning: 'hard to say' }));

    const res = await handler({});

    expect(JSON.parse(res.body).driftOffersScored).toBe(0);
    const updates = mockedQuery.mock.calls.filter((c) => String(c[0]).includes('UPDATE drift_events'));
    expect(updates).toHaveLength(0);
  });

  it('judges on the summary and message alone, never on the user outcome', async () => {
    // The prompt must not carry accept/decline: that would make accuracy a measure of user
    // reaction, which is exactly what it exists to be independent of.
    skipPassesAandB();
    mockedQuery
      .mockResolvedValueOnce({ rows: [OFFER], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    mockSend.mockResolvedValueOnce(bedrockJson({ correct: false, reasoning: 'continuation' }));

    await handler({});

    const prompt = String(mockSend.mock.calls[0][0].input.body);
    expect(prompt).toContain('debugging a failing CI pipeline'); // the anchor
    expect(prompt).toContain('Q3 offsite'); // the message that fired
    expect(prompt).not.toMatch(/accepted|declined|abandoned/i);
  });
});
