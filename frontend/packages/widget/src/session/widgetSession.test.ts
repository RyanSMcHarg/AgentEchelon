/**
 * The session credential renews before it expires, once for every caller in flight, and a host's
 * assertion is exchanged once and never presented twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hostSession, renewingProvider, RENEW_MARGIN_MS } from './widgetSession';
import { WidgetRefusal, type SessionCredentials } from './personApi';
import type { HostAssertionInbox } from './hostAssertion';

const creds = (n: number, expiresInMs: number, now: number): SessionCredentials => ({
  accessKeyId: `ak-${n}`, secretAccessKey: 's', sessionToken: 't', expiration: new Date(now + expiresInMs).toISOString(),
});

describe('the renewing provider', () => {
  it('answers the current credential while it is live, and renews once inside the margin', async () => {
    let now = 1_000_000;
    const renew = vi.fn(async () => creds(2, 900_000, now));
    const provider = renewingProvider(creds(1, 900_000, now), renew, vi.fn(), () => now);
    expect((await provider()).accessKeyId).toBe('ak-1');
    expect(renew).not.toHaveBeenCalled();
    now += 900_000 - RENEW_MARGIN_MS + 1;
    const [a, b] = await Promise.all([provider(), provider()]);
    expect([a.accessKeyId, b.accessKeyId]).toEqual(['ak-2', 'ak-2']);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('hands a refusal to the widget, so it shows a settled state', async () => {
    const onRefused = vi.fn();
    const provider = renewingProvider(null, async () => { throw new WidgetRefusal('revoked', 401); }, onRefused);
    await expect(provider()).rejects.toMatchObject({ code: 'revoked' });
    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ code: 'revoked' }));
  });
});

describe('a host session', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv('VITE_PERSON_API_URL', 'https://test.execute-api.us-east-1.amazonaws.com');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const exchangeAnswer = (n: number) => new Response(JSON.stringify({
    credentials: { AccessKeyId: `ak-${n}`, SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3_600_000).toISOString() },
    userArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/rep',
  }), { status: 200 });

  function inbox(assertions: Array<{ assertion: string; conversationArn?: string }>) {
    return { take: vi.fn(async () => assertions.shift()!), request: vi.fn(() => true) } as unknown as HostAssertionInbox;
  }

  it('exchanges the first assertion once, for the conversation the host names', async () => {
    fetchMock.mockResolvedValueOnce(exchangeAnswer(1));
    const channel = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';
    const session = await hostSession(inbox([{ assertion: 'first', conversationArn: channel }]), vi.fn());
    expect(session).toMatchObject({ kind: 'host', channelArn: channel });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://test.execute-api.us-east-1.amazonaws.com/exchange-credentials');
    expect(init.headers.Authorization).toBe('Bearer first');
    expect(JSON.parse(init.body)).toEqual({ channelArn: channel });
  });

  it('refuses, and calls nothing, when the host names no conversation', async () => {
    await expect(hostSession(inbox([{ assertion: 'first' }]), vi.fn())).rejects.toMatchObject({ code: 'refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an unprovisioned subject as such, from the exchange\'s own code', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PERSON_NOT_PROVISIONED' }), { status: 403 }));
    await expect(hostSession(inbox([{ assertion: 'first', conversationArn: 'arn:c' }]), vi.fn())).rejects.toMatchObject({ code: 'not_provisioned' });
  });
});
