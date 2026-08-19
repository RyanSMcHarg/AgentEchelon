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

    it('exempts admins from the PER-USER budget (the per-user counter is not consumed)', async () => {
      process.env.BEDROCK_USER_HOURLY_BUDGET = '2';
      const { checkAndConsumeBudget } = await load();
      // Only a per-user budget is set; an admin skips it entirely, so the per-user counter never bumps.
      expect(await checkAndConsumeBudget('user-1', { isAdmin: true })).toEqual({ allowed: true });
      expect(send).not.toHaveBeenCalled();
    });

    it('still counts admins against the GLOBAL budget and blocks them once it is exceeded', async () => {
      process.env.BEDROCK_USER_HOURLY_BUDGET = '2';
      process.env.BEDROCK_GLOBAL_HOURLY_BUDGET = '10';
      send.mockResolvedValueOnce({ Attributes: { count: 11 } }); // global bump, over the ceiling
      const { checkAndConsumeBudget } = await load();
      // The global ceiling protects the account, so even an exempt admin is blocked when it is crossed;
      // the per-user counter is still skipped, so only the global bump happened.
      expect(await checkAndConsumeBudget('user-1', { isAdmin: true })).toEqual({ allowed: false, reason: 'global' });
      expect(send).toHaveBeenCalledTimes(1);
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

  // The shared gate the router AND the channel-flow @all/battle paths both run (M2): one place owns the
  // order (rate, THEN budget) and the reject-message selection, so the two entry points can't drift.
  describe('evaluateAbuseGate (shared order + message selection)', () => {
    const bump = (count: number) => ({ Attributes: { count } });

    it('blocks on the rate limit FIRST and never consumes budget', async () => {
      process.env.BEDROCK_USER_HOURLY_BUDGET = '10';
      send.mockResolvedValueOnce(bump(6)); // rate counter over the ceiling (5)
      const { evaluateAbuseGate } = await load();
      const res = await evaluateAbuseGate({ userSub: 'u1', rateCeiling: 5, isAdmin: false });
      expect(res.allowed).toBe(false);
      expect(res).toMatchObject({ reason: 'rate' });
      expect((res as { message: string }).message).toBeTruthy();
      expect(send).toHaveBeenCalledTimes(1); // budget was NOT consumed after the rate block
    });

    it('passes the rate limit, then blocks on the budget', async () => {
      process.env.BEDROCK_USER_HOURLY_BUDGET = '10';
      send
        .mockResolvedValueOnce(bump(1))  // rate ok (1 <= 5)
        .mockResolvedValueOnce(bump(11)); // user budget over (11 > 10)
      const { evaluateAbuseGate } = await load();
      const res = await evaluateAbuseGate({ userSub: 'u1', rateCeiling: 5, isAdmin: false });
      expect(res).toMatchObject({ allowed: false, reason: 'budget' });
    });

    it('allows when both rate and budget are within limits', async () => {
      process.env.BEDROCK_USER_HOURLY_BUDGET = '10';
      send
        .mockResolvedValueOnce(bump(1))  // rate ok
        .mockResolvedValueOnce(bump(1)); // budget ok
      const { evaluateAbuseGate } = await load();
      expect(await evaluateAbuseGate({ userSub: 'u1', rateCeiling: 5, isAdmin: false })).toEqual({ allowed: true });
    });

    it('an exempt admin passes the per-user rate limit even over the ceiling', async () => {
      // isAdmin skips the per-user rate counter entirely (no bump), so an over-ceiling admin still passes.
      const { evaluateAbuseGate } = await load();
      expect(await evaluateAbuseGate({ userSub: 'admin', rateCeiling: 1, isAdmin: true })).toEqual({ allowed: true });
    });
  });
});

// This file declares its jest mocks at top level and imports the module under test lazily
// inside each case, so it has no top-level import/export of its own. Without one TypeScript treats
// it as a global SCRIPT rather than a module: its top-level `const`s then share one global scope
// with every other such test file, they collide (TS2451), and symbols resolve against whichever
// file won - which is how `abuse-controls.test.ts` came to be typechecked against
// `user-profile-client`. `npm run typecheck` was red with 52 errors for that reason alone, and
// these files were effectively unchecked. This marks the file as a module. Do not remove.
export {};
