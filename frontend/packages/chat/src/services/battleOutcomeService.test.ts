import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBattleOutcome, recordBattleOutcome } from './battleOutcomeService';

const API_URL = 'https://api.example.com/channels/battle/outcome';
vi.stubEnv('VITE_BATTLE_OUTCOME_API_URL', API_URL);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockGetItem = vi.fn();
vi.stubGlobal('localStorage', { getItem: mockGetItem, setItem: vi.fn(), removeItem: vi.fn() });

beforeEach(() => {
  mockFetch.mockReset();
  mockGetItem.mockReturnValue('mock-id-token');
});

function jsonOk(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

const BATTLE_ID = 'a1b2c3d4e5f60718';
const CHANNEL_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/conv-1';
const OUTCOME = {
  battleId: BATTLE_ID,
  winner: 'B' as const,
  chosenByUserSub: 'sub-1',
  chosenAt: '2026-05-15T00:00:00.000Z',
};

describe('getBattleOutcome', () => {
  it('GETs with the battleId URL-encoded and unwraps { outcome }', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ outcome: OUTCOME }));

    const result = await getBattleOutcome(BATTLE_ID);

    expect(result).toEqual(OUTCOME);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}?battleId=${encodeURIComponent(BATTLE_ID)}`);
    expect(options.method).toBeUndefined();
    expect(options.headers.Authorization).toBe('Bearer mock-id-token');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('returns null when there is no recorded pick', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ outcome: null }));
    expect(await getBattleOutcome(BATTLE_ID)).toBeNull();
  });
});

describe('recordBattleOutcome', () => {
  it('POSTs { battleId, winner, channelArn } to the base URL and returns the outcome', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ outcome: OUTCOME }));

    const result = await recordBattleOutcome(BATTLE_ID, 'B', CHANNEL_ARN);

    expect(result).toEqual(OUTCOME);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(API_URL);
    expect(options.method).toBe('POST');
    // channelArn is REQUIRED by the API (M2 membership check).
    expect(JSON.parse(options.body)).toEqual({ battleId: BATTLE_ID, winner: 'B', channelArn: CHANNEL_ARN });
    // chosenByUserSub is NEVER sent from the client (server-derived).
    expect(JSON.parse(options.body)).not.toHaveProperty('chosenByUserSub');
  });

  it('supports the tie outcome', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ outcome: { ...OUTCOME, winner: 'tie' } }));
    const result = await recordBattleOutcome(BATTLE_ID, 'tie', CHANNEL_ARN);
    expect(result.winner).toBe('tie');
  });
});

describe('error handling', () => {
  it('throws the server-provided message and propagates a structured code', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'winner must be A, B, or tie', code: 'INVALID_WINNER' }),
    });
    await expect(recordBattleOutcome(BATTLE_ID, 'B', CHANNEL_ARN)).rejects.toMatchObject({
      message: 'winner must be A, B, or tie',
      code: 'INVALID_WINNER',
    });
  });

  it('falls back to HTTP <status> when the error body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error('not json')),
    });
    await expect(getBattleOutcome(BATTLE_ID)).rejects.toThrow('HTTP 503');
  });

  it('throws "Not authenticated" with no idToken and issues no request', async () => {
    mockGetItem.mockReturnValue(null);
    await expect(getBattleOutcome(BATTLE_ID)).rejects.toThrow('Not authenticated');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
