/**
 * Unit tests for the user-profile client (SPEC-USER-PROFILE-AND-ONBOARDING).
 * Mocks the DynamoDB doc client + Lambda client; asserts the once-per-user gate, the warm cache,
 * fail-open reads, and the USER_PROFILE_SERVICE_ARN swap seam.
 */
const send = jest.fn();
const lambdaSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  GetCommand: jest.fn((x) => ({ __cmd: 'Get', ...x })),
  UpdateCommand: jest.fn((x) => ({ __cmd: 'Update', ...x })),
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((x) => ({ __cmd: 'Invoke', ...x })),
}));

async function load() {
  return import('../../lambda/src/lib/user-profile-client');
}

describe('user-profile-client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.USER_PROFILE_TABLE = 'user-profile-table';
    delete process.env.USER_PROFILE_SERVICE_ARN;
  });

  describe('hasOnboarded (built-in DynamoDB)', () => {
    it('is false when there is no profile item', async () => {
      send.mockResolvedValueOnce({}); // GetItem → no Item
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(false);
    });

    it('is false when a profile exists but was never onboarded', async () => {
      send.mockResolvedValueOnce({ Item: { userSub: 'sub-1' } });
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(false);
    });

    it('is true when onboardedAt is set', async () => {
      send.mockResolvedValueOnce({ Item: { userSub: 'sub-1', onboardedAt: '2026-01-01T00:00:00Z' } });
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(true);
    });

    it('caches a positive result — a second check does not re-hit the store', async () => {
      send.mockResolvedValueOnce({ Item: { userSub: 'sub-1', onboardedAt: '2026-01-01T00:00:00Z' } });
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(true);
      expect(await hasOnboarded('sub-1')).toBe(true);
      expect(send).toHaveBeenCalledTimes(1); // only the first check queried DynamoDB
    });

    it('re-reads the store once the cached positive expires, so a RESET profile is seen', async () => {
      // THE DEFECT THIS EXISTS FOR. The positive entry used to live for the container's whole warm
      // life, on the reasoning that onboarding is monotonic. It is not: an operator reset, an erasure
      // request, or a test restoring its precondition all un-onboard a user. With an unbounded entry
      // the deletion was invisible for hours - the user was never re-onboarded, and the handler
      // reported "already onboarded" about a profile that no longer existed.
      send.mockResolvedValueOnce({ Item: { userSub: 'sub-1', onboardedAt: '2026-01-01T00:00:00Z' } });
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);

      // The profile is deleted, and enough time passes for the cached fact to expire.
      const realNow = Date.now;
      Date.now = () => realNow() + 6 * 60_000;
      try {
        send.mockResolvedValueOnce({}); // GetItem → no Item (profile was reset)
        expect(await hasOnboarded('sub-1')).toBe(false);
        expect(send).toHaveBeenCalledTimes(2); // it went back to the store rather than trusting the cache
      } finally {
        Date.now = realNow;
      }
    });

    it('drops the cached positive when the store says not onboarded', async () => {
      // Belt and braces for the same failure: even inside the TTL, a read that comes back negative
      // must not leave a stale yes behind for the next caller.
      send.mockResolvedValueOnce({ Item: { userSub: 'sub-1', onboardedAt: '2026-01-01T00:00:00Z' } });
      const { hasOnboarded, __clearUserProfileCache } = await load();
      expect(await hasOnboarded('sub-1')).toBe(true);

      __clearUserProfileCache();
      send.mockResolvedValueOnce({}); // reset profile
      expect(await hasOnboarded('sub-1')).toBe(false);
      send.mockResolvedValueOnce({}); // still reset — must NOT report a cached yes
      expect(await hasOnboarded('sub-1')).toBe(false);
    });

    it('does NOT cache a negative — a later onboarding is still seen', async () => {
      send
        .mockResolvedValueOnce({}) // first check: not onboarded
        .mockResolvedValueOnce({ Item: { userSub: 'sub-1', onboardedAt: '2026-01-01T00:00:00Z' } });
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(false);
      expect(await hasOnboarded('sub-1')).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('fails open to false when the store errors (intake still runs)', async () => {
      send.mockRejectedValueOnce(new Error('ddb down'));
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(false);
    });

    it('is false for an empty sub without touching the store', async () => {
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('')).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('markOnboarded (built-in DynamoDB)', () => {
    it('writes onboardedAt + facts and then reads as onboarded from cache', async () => {
      send.mockResolvedValueOnce({}); // UpdateItem ok
      const { markOnboarded, hasOnboarded } = await load();
      await markOnboarded('sub-1', { company: 'Acme', role: 'Eng' });
      const call = send.mock.calls[0][0];
      expect(call.__cmd).toBe('Update');
      expect(call.ExpressionAttributeValues[':facts']).toEqual({ company: 'Acme', role: 'Eng' });
      // The write populates the warm cache, so a follow-up gate check needs no read.
      expect(await hasOnboarded('sub-1')).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('swallows a write failure (non-fatal)', async () => {
      send.mockRejectedValueOnce(new Error('write failed'));
      const { markOnboarded } = await load();
      await expect(markOnboarded('sub-1', {})).resolves.toBeUndefined();
    });
  });

  describe('USER_PROFILE_SERVICE_ARN swap seam', () => {
    it('delegates getUserProfile to the external service and never touches DynamoDB', async () => {
      process.env.USER_PROFILE_SERVICE_ARN = 'arn:aws:lambda:us-east-1:1:function:their-store';
      lambdaSend.mockResolvedValueOnce({
        Payload: new TextEncoder().encode(JSON.stringify({ success: true, data: { userSub: 'sub-1', onboardedAt: '2026-01-01T00:00:00Z' } })),
      });
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(true);
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled(); // built-in table bypassed
    });

    it('fails open when the external service errors', async () => {
      process.env.USER_PROFILE_SERVICE_ARN = 'arn:aws:lambda:us-east-1:1:function:their-store';
      lambdaSend.mockRejectedValueOnce(new Error('service down'));
      const { hasOnboarded } = await load();
      expect(await hasOnboarded('sub-1')).toBe(false);
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
