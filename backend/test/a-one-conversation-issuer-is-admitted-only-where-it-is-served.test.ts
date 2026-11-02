/**
 * A ONE-CONVERSATION ISSUER IS ADMITTED AT THE EDGE ONLY WHERE IT IS SERVED (tenet D3: two layers).
 *
 * A host app's pool declared with `clearance: { oneChannel }` holds people who reach one conversation.
 * They call two routes: the credential exchange, which vends them that conversation, and conversation
 * creation, which opens or re-opens it (`ONE_CHANNEL_ROUTES`, lib/constructs/trusted-issuers.ts). Every
 * other person-facing route refuses them twice: the edge authorizer's policy for their token names only
 * those two routes, and every other handler resolves nobody for them (`callerPerson`,
 * lambda/src/lib/auth.ts).
 *
 * Synthesized as the whole app, so the route set is every person route the deployment serves, on
 * `PersonApi`, and the route lists are the ones its edge function is handed. Each issuer's token is then
 * decided by the real decision code and the answer evaluated against every route, the way the gateway
 * evaluates a cached policy against each later request. A pool with full reach (a fixed clearance) is
 * admitted on every route, so the split follows the issuer's clearance, not the pool.
 */
import * as path from 'path';
import { synthesizeApp } from '../lib/docs/api-contract';
import { ONE_CHANNEL_ROUTES } from '../lib/constructs/trusted-issuers';
import { edgeRoutesOf, reachableRoutes, routesOf, runtimeEntries } from './helpers/edge-policy';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;
const ONE_CHANNEL_POOL = 'us-east-1_HostApp';
const FULL_REACH_POOL = 'us-east-1_Partner';

const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: ONE_CHANNEL_POOL, audience: 'host-client', clearance: { oneChannel: 'basic', classifications: ['basic'] } },
  { id: 'partner', kind: 'cognito-pool', pool: FULL_REACH_POOL, audience: 'partner-client', clearance: { fixed: ['basic'], classifications: ['basic'] } },
];
const PERSON = { state: 'active' as const, personArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/p-1' };

describe('a one-conversation issuer is admitted at the edge only on the routes that serve it', () => {
  let keys: string[];
  let edgeRoutes: ReturnType<typeof edgeRoutesOf>;
  const entry = (id: string) => runtimeEntries(ISSUERS).find((e) => e.id === id)!;

  beforeAll(() => {
    const app = synthesizeApp(REPO_ROOT, {
      id: 'one-conversation',
      context: { appUrl: 'https://app.example.com', capabilities: ['chat', 'notifications', 'experiments', 'battle'], issuers: ISSUERS },
    });
    const personApi = app.templates.AgentEchelonPersonApi as never;
    keys = routesOf(personApi).map((r) => r.key).sort();
    edgeRoutes = edgeRoutesOf(personApi);
  }, SYNTH_TIMEOUT_MS);

  it('hands the edge the allowlist as data: the exchange and conversation creation', () => {
    expect([...ONE_CHANNEL_ROUTES].sort()).toEqual(['POST /create-conversation', 'POST /exchange-credentials']);
    expect([...edgeRoutes.oneChannel].sort()).toEqual([...ONE_CHANNEL_ROUTES].sort());
    for (const route of ONE_CHANNEL_ROUTES) expect({ route, served: keys.includes(route) }).toEqual({ route, served: true });
  });

  it('a one-conversation person reaches the allowlist and no other route, whichever route the answer was cached on', async () => {
    for (const asked of keys) {
      expect({ asked, reached: await reachableRoutes(entry('host'), PERSON, edgeRoutes, keys, asked) })
        .toEqual({ asked, reached: [...ONE_CHANNEL_ROUTES].sort() });
    }
  });

  it('a full-reach issuer reaches every person route, so the split follows the clearance', async () => {
    expect(await reachableRoutes(entry('partner'), PERSON, edgeRoutes, keys)).toEqual(keys);
    expect(await reachableRoutes(entry('deployment'), PERSON, edgeRoutes, keys)).toEqual(keys);
  });

  it('a first sign-in of either reaches the exchange alone', async () => {
    for (const id of ['host', 'partner']) {
      expect(await reachableRoutes(entry(id), { state: 'unbound' }, edgeRoutes, keys)).toEqual(['POST /exchange-credentials']);
    }
  });

  it('scans a realistic route set (a scan over nothing passes vacuously)', () => {
    expect(keys.length).toBeGreaterThan(15);
  });
});
