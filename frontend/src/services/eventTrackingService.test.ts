import { describe, it, expect, vi, beforeEach } from 'vitest';

// ESM hoists `import` statements above non-import top-level code, so vi.stubEnv
// must be hoisted with vi.hoisted to apply before eventTrackingService is
// evaluated (which reads VITE_CLIENT_EVENTS_API_URL at module-load time).
vi.hoisted(() => {
  // @ts-expect-error -- runtime stub before module init
  globalThis.__VITEST_HOISTED_ENV__ = true;
});
vi.stubEnv('VITE_CLIENT_EVENTS_API_URL', 'https://api.example.com/events');

const mockSessionStorage = {
  store: new Map<string, string>(),
  getItem(k: string) { return this.store.get(k) ?? null; },
  setItem(k: string, v: string) { this.store.set(k, v); },
  removeItem(k: string) { this.store.delete(k); },
};
vi.stubGlobal('sessionStorage', mockSessionStorage);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Dynamic import inside the suite so vi.stubEnv applies before the module's
// top-level ENDPOINT read runs.
let svc: typeof import('./eventTrackingService');
beforeEach(async () => {
  vi.resetModules();
  svc = await import('./eventTrackingService');
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
});

it('test harness — env stub is visible to the service', () => {
  expect(import.meta.env.VITE_CLIENT_EVENTS_API_URL).toBe('https://api.example.com/events');
});

describe('eventTrackingService — auth token gating', () => {
  it('drops payloads when no auth token has been set', () => {
    svc.trackEvent('signin_submitted');
    svc.flushEvents();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs with Authorization header once setAuthToken is called', () => {
    svc.setAuthToken('eyJ.fake.token');
    svc.trackEvent('signin_submitted');
    svc.flushEvents();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/events');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('eyJ.fake.token');
    expect(headers['Content-Type']).toBe('application/json');
    expect((init as RequestInit).keepalive).toBe(true);
  });

  it('clears auth on setAuthToken(null) and stops sending', () => {
    svc.setAuthToken('t');
    svc.trackEvent('login');
    svc.flushEvents();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    mockFetch.mockClear();
    svc.setAuthToken(null);
    svc.trackEvent('logout');
    svc.flushEvents();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('eventTrackingService — payload shape', () => {
  it('flushes events + performance arrays in one POST', () => {
    svc.setAuthToken('t');
    svc.trackEvent('message_sent', { conversationId: 'c' });
    svc.trackPerformance('web_vital_lcp', 1234);
    svc.flushEvents();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ name: 'message_sent', properties: { conversationId: 'c' } });
    expect(body.events[0].timestamp).toMatch(/T/);
    expect(body.events[0].sessionId).toBeTruthy();
    expect(body.performance).toHaveLength(1);
    expect(body.performance[0]).toMatchObject({ metric: 'web_vital_lcp', value: 1234 });
  });

  it('flushEvents is a no-op when nothing is queued', () => {
    svc.setAuthToken('t');
    svc.flushEvents();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
