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
