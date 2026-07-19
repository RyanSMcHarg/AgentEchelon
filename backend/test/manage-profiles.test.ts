/**
 * SPEC-PORTABLE-VERSIONED-PROFILES P1 — the manage-profiles API handler (gating + routing).
 * The lifecycle/manifest logic is unit-tested separately; here we prove the capability gate and route
 * dispatch, since this is the WRITE surface (§7).
 */
const send = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send })) };
});

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../lambda/src/manage-profiles';

function evt(over: Partial<APIGatewayProxyEvent> & { groups?: string; sub?: string; path?: string; method?: string }): APIGatewayProxyEvent {
  const { groups = 'admins', sub = 'u-1', path = '/admin/profiles', method = 'GET', ...rest } = over;
  return {
    httpMethod: method,
    path,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: { claims: { sub, 'cognito:groups': groups } } },
    ...rest,
  } as unknown as APIGatewayProxyEvent;
}

beforeEach(() => send.mockReset());

describe('manage-profiles handler', () => {
  it('OPTIONS → 200 (CORS preflight)', async () => {
    const res = await handler(evt({ method: 'OPTIONS' }));
    expect(res.statusCode).toBe(200);
  });

  it('no sub → 401', async () => {
    const res = await handler(evt({ sub: '' }));
    expect(res.statusCode).toBe(401);
  });

  it('non-admin (lacks the manage-profiles capability) → 403, never reaches SSM', async () => {
    const res = await handler(evt({ groups: 'basic' }));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('admin GET /profiles → 200 listing every shipped profile', async () => {
    // Every SSM read (history/draft) → ParameterNotFound ⇒ seed-only listing.
    send.mockImplementation(async () => {
      const e = new Error('nf') as Error & { name: string };
      e.name = 'ParameterNotFound';
      throw e;
    });
    const res = await handler(evt({ method: 'GET' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.profiles)).toBe(true);
    expect(body.profiles.length).toBeGreaterThanOrEqual(3);
    expect(body.profiles.every((p: { activeVersion: number | null }) => p.activeVersion === null)).toBe(true);
  });

  it('POST /profiles/version for an unknown profile → 400', async () => {
    const res = await handler(evt({ method: 'POST', path: '/admin/profiles/version', body: JSON.stringify({ profileName: 'ghost' }) }));
    expect(res.statusCode).toBe(400);
  });
});
