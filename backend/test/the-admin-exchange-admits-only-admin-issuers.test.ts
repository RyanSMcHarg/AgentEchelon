/**
 * The admin exchange's console session admits, at the edge, only a token whose issuer declares
 * `admin: true`. A one-conversation pool and a full-reach pool without `admin` are refused there, before
 * the handler's own refusal on the registry entry (tenet D3: two layers).
 *
 * Synthesized as the whole app, so the route set is every route `AdminApi` serves and the route lists are
 * the ones its own edge authorizer is handed (the admin plane). Each issuer's token is decided by the real
 * decision code, and the answer evaluated against every admin route the way the gateway evaluates it.
 */
import * as path from 'path';
import { synthesizeApp } from '../lib/docs/api-contract';
import { ADMIN_SESSION_ROUTE } from '../lib/constructs/edge-authorizer';
import { ONE_CHANNEL_ROUTES } from '../lib/constructs/trusted-issuers';
import { edgeRoutesOf, reachableRoutes, routesOf, runtimeEntries } from './helpers/edge-policy';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', audience: 'host-client', clearance: { oneChannel: 'basic', classifications: ['basic'] } },
  { id: 'partner', kind: 'cognito-pool', pool: 'us-east-1_Partner', audience: 'partner-client', clearance: { fixed: ['basic'], classifications: ['basic'] } },
  { id: 'operators', kind: 'cognito-pool', pool: 'us-east-1_Operators', audience: 'operators-client', clearance: { groups: true, classifications: ['basic', 'admin'] }, admin: true },
];
const PERSON = { state: 'active' as const, personArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/p-1' };

describe('the admin exchange admits only the issuers that declare admin', () => {
  let adminRoutes: ReturnType<typeof routesOf>;
  let adminKeys: string[];
  let personKeys: string[];
  let adminEdge: ReturnType<typeof edgeRoutesOf>;
  let personEdge: ReturnType<typeof edgeRoutesOf>;
  const entry = (id: string) => runtimeEntries(ISSUERS).find((e) => e.id === id)!;

  beforeAll(() => {
    const app = synthesizeApp(REPO_ROOT, { id: 'admin-exchange-issuers', context: { capabilities: ['chat', 'admin'], issuers: ISSUERS } });
    const adminApi = app.templates.AgentEchelonAdminApi as never;
    const personApi = app.templates.AgentEchelonPersonApi as never;
    adminRoutes = routesOf(adminApi);
    adminKeys = adminRoutes.map((r) => r.key).sort();
    personKeys = routesOf(personApi).map((r) => r.key).sort();
    adminEdge = edgeRoutesOf(adminApi);
    personEdge = edgeRoutesOf(personApi);
  }, SYNTH_TIMEOUT_MS);

  it('takes a token on one admin route, the console session, never answered from the cache', () => {
    const tokenRoutes = adminRoutes.filter((r) => r.auth !== 'AWS_IAM');
    expect(tokenRoutes.map((r) => [r.key, r.auth, r.authorizerTtl])).toEqual([[ADMIN_SESSION_ROUTE, 'CUSTOM', 0]]);
    expect(adminEdge).toEqual({ plane: 'admin', exchange: [], oneChannel: [], guest: [], admin: [ADMIN_SESSION_ROUTE] });
  });

  it('admits an admin issuer on the console session and on no other admin route', async () => {
    for (const id of ['deployment', 'operators']) {
      expect({ id, reached: await reachableRoutes(entry(id), PERSON, adminEdge, adminKeys, ADMIN_SESSION_ROUTE) })
        .toEqual({ id, reached: [ADMIN_SESSION_ROUTE] });
      // A first sign-in reaches it too, so the exchange can say it must sign in through the person exchange first.
      expect(await reachableRoutes(entry(id), { state: 'unbound' }, adminEdge, adminKeys, ADMIN_SESSION_ROUTE)).toEqual([ADMIN_SESSION_ROUTE]);
    }
  });

  it('refuses the one-conversation and the full-reach issuer on every admin route', async () => {
    for (const id of ['host', 'partner']) {
      expect({ id, reached: await reachableRoutes(entry(id), PERSON, adminEdge, adminKeys, ADMIN_SESSION_ROUTE) }).toEqual({ id, reached: [] });
    }
  });

  it('admits the admin issuer on the person routes too, and still keeps the one-conversation issuer to its allowlist', async () => {
    // An admin issuer's people are people: they reach the person routes like any full-reach issuer.
    expect(await reachableRoutes(entry('operators'), PERSON, personEdge, personKeys)).toEqual(personKeys);
    expect(await reachableRoutes(entry('host'), PERSON, personEdge, personKeys)).toEqual([...ONE_CHANNEL_ROUTES].sort());
  });

  it('scans a realistic admin route set', () => {
    expect(adminKeys.length).toBeGreaterThan(50);
  });
});
