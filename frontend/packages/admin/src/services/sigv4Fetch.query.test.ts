/**
 * A SIGNED GET SENDS ITS QUERY.
 *
 * The templates listing names its assistant as `?profileName=`, and the route refuses a listing that names none. The
 * signed GET builds the request it sends from its `query` argument, so a query written into the URL alone was dropped
 * on the way out: the route answered 400 and the step editor's message template list was empty. These prove the query
 * arrives, written either way, and that the listing names its assistant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  USER_POOL_ID: 'us-east-1_pool',
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  },
  ensureFreshIdToken: async () => 'token',
}));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));

const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' };
const sent: string[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    sent.push(url);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

describe('a signed GET', () => {
  it('sends the query it is handed', async () => {
    const { sigv4GetJson } = await import('./sigv4Fetch');
    await sigv4GetJson('https://api.example.com/admin/templates', { profileName: 'concierge' }, CREDS);
    expect(new URL(sent[0]).searchParams.get('profileName')).toBe('concierge');
  });

  it('sends a query written into the URL, and a key in the query argument takes its place', async () => {
    const { sigv4GetJson } = await import('./sigv4Fetch');
    await sigv4GetJson('https://api.example.com/admin/templates?profileName=concierge&limit=5', { limit: 10 }, CREDS);
    const q = new URL(sent[0]).searchParams;
    expect(q.get('profileName')).toBe('concierge');
    expect(q.get('limit')).toBe('10');
    expect(q.getAll('limit')).toHaveLength(1);
  });
});

describe('the message templates listing', () => {
  it('names the assistant whose templates it lists', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'https://api.example.com/');
    vi.stubEnv('VITE_ADMIN_API_CAPABILITIES', 'admin');
    vi.resetModules();
    vi.doMock('./sigv4Fetch', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./sigv4Fetch')>()),
      consoleCredentials: async () => CREDS,
    }));
    const { listMessageTemplates } = await import('./profileService');
    await listMessageTemplates('concierge');
    const url = new URL(sent[0]);
    expect(url.pathname).toBe('/admin/templates');
    expect(url.searchParams.get('profileName')).toBe('concierge');
  });
});
