/**
 * A REFUSAL NAMES WHAT THE OPERATOR LACKS (SPEC-ADMIN-CONSOLE FR53).
 *
 * The gateway refuses with IAM's own sentence ("User: arn:aws:sts::... is not authorized to perform:
 * execute-api:Invoke on resource: ..."), which tells an operator nothing they can act on. The console
 * session carries the route each capability authorizes, so a refused request is mapped back to the
 * capability it needed and the operator is told that, and who can grant it. A handler's own 403 is a
 * different statement and is passed through as the handler wrote it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('VITE_ADMIN_API_URL', 'https://admin.example.com/');

vi.mock('@ae/shared/i18n', () => ({
  default: { t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) },
}));
vi.mock('@ae/shared', () => ({
  REGION: 'us-east-1',
  exchangeCredentials: async () => ({}),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  },
  ensureFreshIdToken: async () => 'id-token',
}));

import { consoleCredentials, sigv4GetJson, resetSignOnCredentials } from './sigv4Fetch';

const IAM_REFUSAL = 'User: arn:aws:sts::1:assumed-role/x-team-console/console-sub is not authorized to perform: execute-api:Invoke on resource: arn:aws:execute-api:us-east-1:1:abc/prod/GET/admin/conversations/identities';

function answer(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body, clone() { return this; } };
}

/** The error a request was refused with; a request that succeeds fails the test. */
const refusal = (p: Promise<unknown>): Promise<Error> =>
  p.then(() => { throw new Error('expected a refusal'); }, (e: Error) => e);

let gateway: { status: number; body: unknown };
beforeEach(() => {
  resetSignOnCredentials();
  gateway = { status: 403, body: { Message: IAM_REFUSAL } };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url) === 'https://admin.example.com/exchange-credentials') {
      return answer(200, {
        credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token' },
        role: 'team-members',
        capabilities: ['view-conversations'],
        routes: [
          { capability: 'see-user-identity', api: 'admin-conversations', method: 'GET', path: 'admin/conversations/identities' },
          { capability: 'view-messages', api: 'admin-conversations', method: 'GET', path: 'admin/conversations/*/messages' },
          { capability: 'view-analytics', api: 'feedback', method: 'GET', path: 'feedback' },
        ],
      });
    }
    return answer(gateway.status, gateway.body);
  }));
});

describe('a refused request', () => {
  it('names the capability the route needs, never the IAM sentence', async () => {
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/admin/conversations/identities', {}, creds));
    expect(err.message).toContain('admin.refusal.lacksCapability');
    expect(err.message).toContain('see-user-identity');
    expect(err.message).not.toContain('not authorized to perform');
  });

  it('matches a route with the conversation id in its path', async () => {
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/admin/conversations/conv-1/messages', {}, creds));
    expect(err.message).toContain('view-messages');
  });

  it('names the capability on the feedback surface, at the admin API root', async () => {
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/feedback', { days: 30 }, creds));
    expect(err.message).toContain('admin.refusal.lacksCapability');
    expect(err.message).toContain('view-analytics');
  });

  it('says a capability is missing even for a route the session does not list', async () => {
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/query', {}, creds));
    expect(err.message).toBe('admin.refusal.lacksUnknownCapability');
  });

  it('names the assistant, not a capability, when a team route is refused', async () => {
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/admin/assistants/advisor/conversations', {}, creds));
    expect(err.message).toContain('admin.refusal.assistantNotOwned');
    expect(err.message).toContain('advisor');
    expect(err.message).not.toContain('lacksCapability');
  });

  it('names the assistant when the handler refuses it on its own check', async () => {
    gateway = { status: 403, body: { error: 'This assistant is not owned by your team', code: 'ASSISTANT_NOT_OWNED' } };
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/admin/assistants/analyst/conversations', {}, creds));
    expect(err.message).toContain('admin.refusal.assistantNotOwned');
  });

  it('recognizes the HTTP API\'s own refusal, whose body is a bare Forbidden', async () => {
    gateway = { status: 403, body: { message: 'Forbidden' } };
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/admin/conversations/identities', {}, creds));
    expect(err.message).toContain('admin.refusal.lacksCapability');
    expect(err.message).toContain('see-user-identity');
  });

  it('matches a route on the analytics surface below its /query mount', async () => {
    vi.mocked(fetch).mockImplementation((async (url: string) => {
      if (String(url) === 'https://admin.example.com/exchange-credentials') {
        return answer(200, {
          credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token' },
          role: 'admins',
          capabilities: ['view-security'],
          routes: [{ capability: 'view-security', api: 'analytics', method: 'GET', path: 'membership-audit/findings' }],
        });
      }
      return answer(403, { message: 'Forbidden' });
    }) as never);
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/query/membership-audit/findings', {}, creds));
    expect(err.message).toContain('view-security');
  });

  it('passes a handler\'s own 403 through as the handler wrote it', async () => {
    gateway = { status: 403, body: { error: 'Conversation is outside your classification scope' } };
    const creds = await consoleCredentials();
    const err = await refusal(sigv4GetJson('https://admin.example.com/admin/conversations/identities', {}, creds));
    expect(err.message).toBe('Conversation is outside your classification scope');
  });
});
