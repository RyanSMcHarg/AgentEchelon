/**
 * The classification shadow gate's API surface (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5).
 *
 * The lifecycle around the batch job is where this fails quietly rather than loudly: a run that is
 * opened and never executed sits `running` forever and reads as in-progress; a ruling recorded
 * without a verified actor destroys the audit trail the human-arbiter rule depends on; and a verdict
 * served from an unfinished run is a measurement of a corpus that was never assembled.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
const mockSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  ScanCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = mockLambdaSend;
  },
  InvokeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

process.env.CLASSIFIER_REPLAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:ClassifierReplay';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/analytics-aurora/analytics-query');

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'admin-sub-1', 'cognito:groups': 'admins' } } },
  } as unknown as APIGatewayProxyEvent;
}

const call = async (body: Record<string, unknown>) => {
  const res = await handler(postEvent(body) as any);
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
  mockSend.mockReset();
  mockLambdaSend.mockReset();
  mockSend.mockResolvedValue({ Items: [] });
  mockLambdaSend.mockResolvedValue({});
  process.env.CLASSIFIER_REPLAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:ClassifierReplay';
});

describe('starting a replay does not happen on this route', () => {
  const startBody = {
    queryType: 'classifier_replay_start',
    incumbentModel: 'haiku',
    challengerModel: 'sonnet',
    experimentId: 'exp1',
  };

  /**
   * This handler is VPC-attached in isolated subnets: `lambda:Invoke` from it has NO ROUTE and hangs
   * until the function times out, so the start moved to a non-VPC function
   * (`classifier-replay-start.ts`, covered by its own test). What is asserted here is that the old
   * route REFUSES rather than pretending — because the previous version of this code passed every
   * test in this file while being incapable of working live, on a mocked Lambda client that made an
   * unreachable call look instant.
   */
  it('refuses, names the route that works, and opens NOTHING', async () => {
    const { status, body } = await call(startBody);

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/classifier-replay-start/);
    expect(mockLambdaSend).not.toHaveBeenCalled();
    const insert = mockDbQuery.mock.calls.find((c) => /INSERT INTO classifier_replay_runs/.test(String(c[0])));
    expect(insert).toBeUndefined();
  });
});

describe('reading a replay', () => {
  const runRow = (over: Record<string, unknown> = {}) => ({
    id: 'run-1',
    experiment_id: 'exp1',
    incumbent_model: 'haiku',
    challenger_model: 'sonnet',
    window_start: '2026-07-08T00:00:00.000Z',
    window_end: '2026-08-07T00:00:00.000Z',
    messages_considered: 400,
    messages_replayed: 400,
    messages_retracted: 3,
    messages_fast_path: 52,
    status: 'complete',
    error: null,
    ...over,
  });

  /** run SELECT then label SELECT, in that order. */
  function primeRun(run: Record<string, unknown>, labels: Array<Record<string, unknown>>) {
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (/FROM classifier_replay_runs/.test(sql)) return { rows: [run] };
      if (/FROM classifier_replay_labels/.test(sql)) return { rows: labels };
      return { rows: [] };
    });
  }

  it('computes the verdict from the labels as they stand, rather than a stored one', async () => {
    // A queue worked further since the last read moves the answer; a cached verdict would quietly
    // disagree with the rows beneath it.
    primeRun(runRow(), [
      ...Array.from({ length: 300 }, () => ({ incumbent_label: 'general', challenger_label: 'general', true_label: null })),
      ...Array.from({ length: 42 }, () => ({ incumbent_label: 'general', challenger_label: 'code_generation', true_label: 'code_generation' })),
      ...Array.from({ length: 18 }, () => ({ incumbent_label: 'general', challenger_label: 'code_generation', true_label: 'general' })),
    ]);

    const { body } = await call({ queryType: 'classifier_replay', runId: 'run-1' });
    expect(body.gate.verdict).toBe('challenger_better');
    expect(body.gate.summary.concordant).toBe(300);
    expect(body.gate.summary.challengerOnlyRight).toBe(42);
    expect(body.incomplete).toBe(false);
  });

  it('flags a run that did not finish, whatever its labels say', async () => {
    // A truncated corpus is not a measurement of the window the operator was shown.
    primeRun(runRow({ status: 'failed', error: 'aurora unavailable' }), []);
    const { body } = await call({ queryType: 'classifier_replay', runId: 'run-1' });
    expect(body.incomplete).toBe(true);
    expect(body.run.status).toBe('failed');
  });

  it('carries the WINDOW and the exclusion counts, so the corpus can be described', async () => {
    primeRun(runRow(), []);
    const { body } = await call({ queryType: 'classifier_replay', runId: 'run-1' });
    expect(body.run.windowStart).toContain('2026-07-08');
    expect(body.run.messagesRetracted).toBe(3);
    expect(body.run.messagesFastPath).toBe(52);
  });

  it('honours a caller-supplied non-inferiority margin', async () => {
    primeRun(runRow(), [
      ...Array.from({ length: 200 }, () => ({ incumbent_label: 'general', challenger_label: 'general', true_label: null })),
      ...Array.from({ length: 12 }, () => ({ incumbent_label: 'general', challenger_label: 'code_generation', true_label: 'code_generation' })),
      ...Array.from({ length: 20 }, () => ({ incumbent_label: 'general', challenger_label: 'code_generation', true_label: 'general' })),
    ]);
    const strict = await call({ queryType: 'classifier_replay', runId: 'run-1', marginPct: 2 });
    const loose = await call({ queryType: 'classifier_replay', runId: 'run-1', marginPct: 25 });
    expect(strict.body.gate.verdict).toBe('worse');
    expect(loose.body.gate.verdict).toBe('non_inferior');
  });

  it('404s an unknown run rather than reporting an empty gate', async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    const { status } = await call({ queryType: 'classifier_replay', runId: 'nope' });
    expect(status).toBe(404);
  });

  it('requires a runId', async () => {
    expect((await call({ queryType: 'classifier_replay' })).status).toBe(400);
    expect((await call({ queryType: 'classifier_replay_labels' })).status).toBe(400);
  });
});

describe('adjudicating', () => {
  it('attributes the ruling to the VERIFIED caller', async () => {
    // The human is the arbiter of record. A ruling nobody is named for is not an audit trail.
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const { body } = await call({
      queryType: 'classifier_replay_adjudicate',
      labelId: 'label-1',
      trueLabel: 'data_extraction',
      adjudicatedBy: 'somebody-else',
    });
    expect(body.updated).toBe(true);
    const update = mockDbQuery.mock.calls.find((c) => /UPDATE classifier_replay_labels/.test(String(c[0])));
    expect(update![1]).toContain('admin-sub-1');
    expect(update![1]).not.toContain('somebody-else');
  });

  it('reports updated:false for a ruling that changes nothing', async () => {
    // A concordant pair, or a row that is not there. Either way the caller should not be told a
    // judgement landed.
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const { body } = await call({
      queryType: 'classifier_replay_adjudicate',
      labelId: 'label-1',
      trueLabel: 'general',
    });
    expect(body.updated).toBe(false);
  });

  it('rejects a ruling with no label', async () => {
    const { status } = await call({ queryType: 'classifier_replay_adjudicate', labelId: 'l', trueLabel: '' });
    expect(status).toBe(400);
  });
});
