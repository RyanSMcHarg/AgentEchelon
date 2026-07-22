import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBattleConfig, enableBattle, disableBattle } from './channelBattleService';

const API_URL = 'https://api.example.com/channels/battle';
vi.stubEnv('VITE_CHANNEL_BATTLE_API_URL', API_URL);

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

describe('getBattleConfig', () => {
  it('GETs with the channelArn URL-encoded into the query string', async () => {
    const config = {
      channelArn: 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1',
      enabled: true,
      experimentId: 'exp-9',
      altBotSlotArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt0',
    };
    mockFetch.mockResolvedValueOnce(jsonOk(config));

    const result = await getBattleConfig(config.channelArn);

    expect(result).toEqual(config);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}?channelArn=${encodeURIComponent(config.channelArn)}`);
    // No explicit method → fetch default GET
    expect(options.method).toBeUndefined();
    expect(options.headers.Authorization).toBe('Bearer mock-id-token');
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('encodes reserved characters in the channelArn (no raw colons/slashes leak)', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ channelArn: 'x', enabled: false }));
    await getBattleConfig('arn:aws:chime/i/channel/c2');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('channelArn=arn%3Aaws%3Achime%2Fi%2Fchannel%2Fc2');
    expect(url).not.toContain('channelArn=arn:aws:chime/i/channel/c2');
  });

  it('returns a disabled config shape', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ channelArn: 'c3', enabled: false }));
    const result = await getBattleConfig('c3');
    expect(result.enabled).toBe(false);
  });
});

describe('enableBattle', () => {
  it('POSTs /enable with { channelArn, experimentId } and returns the result', async () => {
    const apiResult = {
      enabled: true,
      channelArn: 'c1',
      experimentId: 'exp-9',
      altBotSlotArn: 'arn:bot/Alt0',
      altBotDisplayName: 'Challenger',
    };
    mockFetch.mockResolvedValueOnce(jsonOk(apiResult));

    const result = await enableBattle('c1', 'exp-9');

    expect(result).toEqual(apiResult);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/enable`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ channelArn: 'c1', experimentId: 'exp-9' });
  });

  it('POSTs /enable with { channelArn } only when experimentId is omitted (backend auto-resolves)', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({
      enabled: true,
      channelArn: 'c1',
      experimentId: 'auto-resolved',
      altBotSlotArn: 'arn:bot/Alt0',
      altBotDisplayName: 'Challenger',
    }));

    await enableBattle('c1');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/enable`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ channelArn: 'c1' });
  });
});

describe('disableBattle', () => {
  it('POSTs /disable with { channelArn } only', async () => {
    mockFetch.mockResolvedValueOnce(jsonOk({ enabled: false, channelArn: 'c1' }));

    const result = await disableBattle('c1');

    expect(result).toEqual({ enabled: false, channelArn: 'c1' });
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(`${API_URL}/disable`);
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ channelArn: 'c1' });
  });
});

describe('error handling', () => {
  it('throws with the server-provided error message on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Caller is not an admin' }),
    });
    await expect(enableBattle('c1', 'exp-9')).rejects.toThrow('Caller is not an admin');
  });

  it('propagates a structured error code onto the thrown error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'Tier mismatch', code: 'TIER_MISMATCH' }),
    });
    await expect(enableBattle('c1', 'exp-9')).rejects.toMatchObject({
      message: 'Tier mismatch',
      code: 'TIER_MISMATCH',
    });
  });

  it('falls back to HTTP <status> when the error body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });
    await expect(getBattleConfig('c1')).rejects.toThrow('HTTP 502');
  });

  it('throws "Not authenticated" when no idToken is in localStorage', async () => {
    mockGetItem.mockReturnValue(null);
    await expect(getBattleConfig('c1')).rejects.toThrow('Not authenticated');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
