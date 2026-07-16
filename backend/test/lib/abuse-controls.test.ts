/**
 * Unit tests for the abuse-controls plane (SPEC-ABUSE-CONTROLS): request dedup + spend budget.
 * Mocks the DynamoDB doc client; asserts fail-open vs fail-safe policy.
 */
const send = jest.fn();
const ssmSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  PutCommand: jest.fn((x) => ({ __cmd: 'Put', ...x })),
  UpdateCommand: jest.fn((x) => ({ __cmd: 'Update', ...x })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: ssmSend })),
  PutParameterCommand: jest.fn((x) => ({ __cmd: 'PutParameter', ...x })),
}));

async function load() {
  return import('../../lambda/src/lib/abuse-controls');
}

describe('abuse-controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.ABUSE_CONTROLS_TABLE = 'abuse-table';
    delete process.env.BEDROCK_USER_HOURLY_BUDGET;
    delete process.env.BEDROCK_GLOBAL_HOURLY_BUDGET;
    delete process.env.ABUSE_CIRCUIT_PARAM;
    delete process.env.ABUSE_CIRCUIT_TRIP_THRESHOLD;
    delete process.env.MAX_USER_MESSAGE_LENGTH;
  });

  describe('claimCorrelation (dedup)', () => {
    it('returns true on the first claim (conditional put succeeds)', async () => {
      send.mockResolvedValueOnce({});
      const { claimCorrelation } = await load();
      expect(await claimCorrelation('corr-1')).toBe(true);
    });

    it('returns false for a duplicate (ConditionalCheckFailedException)', async () => {
      send.mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }));
      const { claimCorrelation } = await load();
      expect(await claimCorrelation('corr-1')).toBe(false);
    });

    it('fails OPEN (true) on an unexpected error', async () => {
      send.mockRejectedValueOnce(new Error('DynamoDB down'));
      const { claimCorrelation } = await load();
      expect(await claimCorrelation('corr-1')).toBe(true);
    });

    it('is a no-op (true) when the table is unset', async () => {
      delete process.env.ABUSE_CONTROLS_TABLE;
      const { claimCorrelation } = await load();
      expect(await claimCorrelation('corr-1')).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('checkAndConsumeBudget', () => {
    it('allows when no budget is configured', async () => {
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1')).toEqual({ allowed: true });
      expect(send).not.toHaveBeenCalled();
    });

    it('exempts admins', async () => {
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '5';
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1', { isAdmin: true })).toEqual({ allowed: true });
      expect(send).not.toHaveBeenCalled();
    });

    it('allows while under the global ceiling', async () => {
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '10';
      send.mockResolvedValueOnce({ Attributes: { count: 3 } }); // global bump
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1')).toEqual({ allowed: true });
    });

    it('blocks when the global ceiling is exceeded', async () => {
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '10';
      send.mockResolvedValueOnce({ Attributes: { count: 11 } });
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1')).toEqual({ allowed: false, reason: 'global' });
    });

    it('blocks when the per-user ceiling is exceeded (global under)', async () => {
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '100';
      process.env.BEDROCK_USER_HOURLY_BUDGET = '5';
      send
        .mockResolvedValueOnce({ Attributes: { count: 10 } }) // global under 100
        .mockResolvedValueOnce({ Attributes: { count: 6 } }); // user over 5
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1')).toEqual({ allowed: false, reason: 'user' });
    });

    it('FAILS SAFE (blocks) on error when a global budget is set', async () => {
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '10';
      send.mockRejectedValueOnce(new Error('DynamoDB down'));
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1')).toEqual({ allowed: false, reason: 'global' });
    });

    it('fails OPEN on error when only a per-user budget is set', async () => {
      process.env.BEDROCK_USER_HOURLY_BUDGET = '5';
      send.mockRejectedValueOnce(new Error('DynamoDB down'));
      const { checkAndConsumeBudget } = await load();
      expect(await checkAndConsumeBudget('user-1')).toEqual({ allowed: true });
    });

    it('trips the circuit (SSM PutParameter) once the global count crosses the threshold', async () => {
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '100';
      process.env.ABUSE_CIRCUIT_PARAM = '/agent-echelon/abuse/circuit';
      process.env.ABUSE_CIRCUIT_TRIP_THRESHOLD = '50';
      send.mockResolvedValueOnce({ Attributes: { count: 51 } }); // global just over the trip threshold
      const { checkAndConsumeBudget } = await load();
      const res = await checkAndConsumeBudget('user-1');
      expect(res.allowed).toBe(true); // 51 < budget 100, still allowed
      await new Promise((r) => setImmediate(r)); // let the fire-and-forget PutParameter settle
      expect(ssmSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkRateLimit', () => {
    it('allows under the ceiling and reports remaining', async () => {
      send.mockResolvedValueOnce({ Attributes: { count: 3 } });
      const { checkRateLimit } = await load();
      const r = await checkRateLimit('user-1', 10);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(7);
    });

    it('blocks once the count exceeds the ceiling', async () => {
      send.mockResolvedValueOnce({ Attributes: { count: 11 } });
      const { checkRateLimit } = await load();
      expect((await checkRateLimit('user-1', 10)).allowed).toBe(false);
    });

    it('is a no-op (allowed) when limit <= 0 or admin', async () => {
      const { checkRateLimit } = await load();
      expect((await checkRateLimit('user-1', 0)).allowed).toBe(true);
      expect((await checkRateLimit('user-1', 10, { isAdmin: true })).allowed).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('fails OPEN on error', async () => {
      send.mockRejectedValueOnce(new Error('DynamoDB down'));
      const { checkRateLimit } = await load();
      expect((await checkRateLimit('user-1', 10)).allowed).toBe(true);
    });
  });

  describe('capUserMessage', () => {
    it('truncates a message over the cap and passes a short one through', async () => {
      process.env.MAX_USER_MESSAGE_LENGTH = '10';
      const { capUserMessage } = await load();
      expect(capUserMessage('short')).toBe('short');
      expect(capUserMessage('this is definitely too long')).toBe('this is de');
    });

    it('is a no-op when unset', async () => {
      delete process.env.MAX_USER_MESSAGE_LENGTH;
      const { capUserMessage } = await load();
      const long = 'x'.repeat(100000);
      expect(capUserMessage(long)).toBe(long);
    });
  });
});
