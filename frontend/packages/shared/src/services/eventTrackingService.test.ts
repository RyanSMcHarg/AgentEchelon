import { describe, it, expect, vi, beforeEach } from 'vitest';

// ESM hoists `import` statements above non-import top-level code, so vi.stubEnv
// must be hoisted with vi.hoisted to apply before eventTrackingService is
// evaluated (which reads VITE_PERSON_API_URL at module-load time).
vi.hoisted(() => {
  // @ts-expect-error -- runtime stub before module init
  globalThis.__VITEST_HOISTED_ENV__ = true;
});
vi.stubEnv('VITE_PERSON_API_URL', 'https://api.example.com/');

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
  mockSessionStorage.store.clear();
  svc = await import('./eventTrackingService');
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true });
});

it('test harness — env stub is visible to the service', () => {
  expect(import.meta.env.VITE_PERSON_API_URL).toBe('https://api.example.com/');
});

/** The events of every POST so far, in order. */
const sentEvents = () => mockFetch.mock.calls.flatMap(([, init]) => JSON.parse((init as RequestInit).body as string).events as Array<{ name: string; sessionId: string }>);
const sentTokens = () => mockFetch.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>).Authorization);

describe('eventTrackingService — auth token gating', () => {
  it('holds a payload while no one is signed in, rather than sending it to be refused', () => {
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
    svc.trackEvent('signin_form_viewed');
    svc.flushEvents();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

/**
 * THE SIGN-IN FUNNEL'S STEPS ARE RECORDED BEFORE ANYONE IS SIGNED IN, and `/events` accepts only a signed-in
 * caller. They used to be dropped by whichever flush came first, the 30-second batch or a hidden tab, so a
 * person who took longer than that on the form reached the server as a success with no form view.
 */
describe('eventTrackingService — what is recorded before sign-in', () => {
  it('is sent the moment the person signs in, with no flush or timer in between', () => {
    svc.trackEvent('signin_form_viewed');
    svc.trackEvent('signin_submitted');
    svc.setAuthToken('t');
    expect(sentEvents().map((e) => e.name)).toEqual(['signin_form_viewed', 'signin_submitted']);
    expect(sentTokens()).toEqual(['t']);
  });

  it('survives every flush that happens before sign-in', () => {
    svc.trackEvent('signin_form_viewed');
    svc.flushEvents(); // the batch timer, or the tab hidden while the person finds a password
    svc.flushEvents();
    svc.trackEvent('signin_succeeded');
    svc.setAuthToken('t');
    expect(sentEvents().map((e) => e.name)).toEqual(['signin_form_viewed', 'signin_succeeded']);
  });

  it('survives a reload of the tab, in the same session, and is sent once', async () => {
    svc.trackEvent('signin_form_viewed');
    svc.flushEvents(); // the page-hide flush as the tab unloads
    // A reload, or the round trip of a redirect sign-in: the module loads again over the same sessionStorage.
    vi.resetModules();
    svc = await import('./eventTrackingService');
    svc.trackEvent('signin_succeeded');
    svc.setAuthToken('t');
    const sent = sentEvents();
    expect(sent.map((e) => e.name)).toEqual(['signin_form_viewed', 'signin_succeeded']);
    expect(new Set(sent.map((e) => e.sessionId)).size).toBe(1);
    mockFetch.mockClear();
    svc.flushEvents();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSessionStorage.getItem('_tracking_held')).toBeNull();
  });

  it('keeps only the newest entries when a tab is left on the form', () => {
    for (let i = 0; i < 150; i++) svc.trackEvent('signin_form_viewed', { i });
    svc.flushEvents();
    svc.setAuthToken('t');
    const sent = mockFetch.mock.calls.flatMap(([, init]) => JSON.parse((init as RequestInit).body as string).events as Array<{ properties: { i: number } }>);
    expect(sent).toHaveLength(100);
    expect(sent[0].properties.i).toBe(50);
  });

  it('sends what was recorded under a sign-in before signing out, never under the next person', () => {
    svc.setAuthToken('first');
    svc.trackEvent('logout');
    svc.setAuthToken(null);
    svc.trackEvent('signin_form_viewed');
    svc.setAuthToken('second');
    expect(mockFetch.mock.calls.map(([, init]) => ({
      token: ((init as RequestInit).headers as Record<string, string>).Authorization,
      events: (JSON.parse((init as RequestInit).body as string).events as Array<{ name: string }>).map((e) => e.name),
    }))).toEqual([
      { token: 'first', events: ['logout'] },
      { token: 'second', events: ['signin_form_viewed'] },
    ]);
  });

  it('does not flush again when a signed-in token is refreshed', () => {
    svc.setAuthToken('t');
    svc.trackEvent('message_sent');
    svc.setAuthToken('t-refreshed');
    expect(mockFetch).not.toHaveBeenCalled();
    svc.flushEvents();
    expect(sentTokens()).toEqual(['t-refreshed']);
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
