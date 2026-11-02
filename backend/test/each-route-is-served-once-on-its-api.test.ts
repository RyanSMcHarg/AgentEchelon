/**
 * EACH ROUTE IS SERVED ONCE, ON THE RIGHT API, WITH THE RIGHT AUTHORIZER (D11, A3).
 *
 * Every route is declared by the stack that owns its handler (`RouteSpec`, `lib/constructs/http-api.ts`)
 * and served by one of the HTTP APIs. Synthesized as the whole app with every built capability, in both
 * archive modes (sleep mode on in Aurora, which adds the most routes), with the reference connectors
 * (`SYNTH_CONNECTORS`), one of which subscribes to vendor events (through its partner event source, so
 * it adds no route):
 *
 *  - no route key is served twice, by one API or across them;
 *  - `PersonApi` serves the person routes, every one behind its own edge authorizer except the
 *    paused-deployment probe, which has none; `AdminApi` serves the admin routes, every one behind IAM
 *    except the console session, behind its own (admin-plane) edge authorizer; no API serves a vendor
 *    route (`IngressApi` is NOT BUILT);
 *  - the credential exchange, the console session and every single-use route take the UNCACHED
 *    attachment, and every other edge-authorized route the cached one, for at most the TTL;
 *  - each API's routes reach its own authorizers, and its integrations send payload format 1.0;
 *  - every route a stack declares is served, and nothing else is.
 */
import * as path from 'path';
import { synthesizeApp, SYNTH_CAPABILITIES, type SynthesizedApp } from '../lib/docs/api-contract';
import { UNCACHED_ROUTES } from '../lib/constructs/edge-authorizer';
import { EDGE_RESULT_TTL_SECONDS } from '../lib/config/edge-verification';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = { Resources?: Record<string, Resource> };

interface Served { stack: string; key: string; auth: string; ttl: number | null; authorizerInApi: boolean; payload: string | null }

function servedRoutes(app: SynthesizedApp): Served[] {
  return Object.entries(app.templates).flatMap(([stack, t]) => {
    const res = (t as Template).Resources ?? {};
    return Object.values(res).filter((r) => r.Type === 'AWS::ApiGatewayV2::Route').map((r) => {
      const p = r.Properties!;
      const authorizer = p.AuthorizerId?.Ref ? res[p.AuthorizerId.Ref] : undefined;
      const integrationId = /"Ref":"([A-Za-z0-9]+)"/.exec(JSON.stringify(p.Target))?.[1];
      return {
        stack,
        key: String(p.RouteKey),
        auth: String(p.AuthorizationType ?? 'NONE'),
        ttl: authorizer ? Number(authorizer.Properties?.AuthorizerResultTtlInSeconds ?? 0) : null,
        authorizerInApi: !authorizer || JSON.stringify(authorizer.Properties?.ApiId) === JSON.stringify(p.ApiId),
        payload: integrationId ? String(res[integrationId]?.Properties?.PayloadFormatVersion ?? '') : null,
      };
    });
  });
}

describe.each([
  ['athena', { analyticsMode: 'athena' }],
  ['aurora with sleep mode', { analyticsMode: 'aurora', sleepMode: true }],
] as const)('every route, %s', (_label, mode) => {
  let served: Served[];
  beforeAll(() => {
    served = servedRoutes(synthesizeApp(REPO_ROOT, { id: `routes-${_label}`, context: { ...mode, capabilities: [...SYNTH_CAPABILITIES] } }));
  }, SYNTH_TIMEOUT_MS);
  const on = (stack: string) => served.filter((r) => r.stack === `AgentEchelon${stack}`);

  it('is on one of the APIs, and no API serves a route twice', () => {
    expect([...new Set(served.map((r) => r.stack))].sort()).toEqual(['AgentEchelonAdminApi', 'AgentEchelonPersonApi']);
    for (const api of ['PersonApi', 'AdminApi']) {
      const keys = on(api).map((r) => r.key);
      expect({ api, duplicates: keys.filter((k, i) => keys.indexOf(k) !== i) }).toEqual({ api, duplicates: [] });
    }
    // The one key both serve is the exchange: the person exchange on PersonApi, the console session on AdminApi.
    const both = on('PersonApi').map((r) => r.key).filter((k) => on('AdminApi').some((a) => a.key === k));
    expect(both).toEqual(['POST /exchange-credentials']);
  });

  it('PersonApi: every route behind its edge authorizer, but the paused-deployment probe, the email preference page and the invitation landing page read, which have none', () => {
    const notEdge = on('PersonApi').filter((r) => r.auth !== 'CUSTOM').map((r) => `${r.key} ${r.auth}`);
    // The preference page is posted by a mail client's one-click unsubscribe, which holds no session (RFC 8058):
    // its link's token is the credential (`email-preferences.ts`).
    const preferencePage = ['GET /email/preferences NONE', 'POST /email/preferences NONE'];
    // The invitation landing page's read (M-5) is the token's holder asking what it may know, with no session:
    // the token in the body is what is asked about, and the read consumes nothing.
    const landing = ['POST /invitations/peek NONE'];
    expect(notEdge.sort()).toEqual(('sleepMode' in mode ? ['GET /deployment/state NONE', ...preferencePage, ...landing] : [...preferencePage, ...landing]).sort());
    expect(on('PersonApi').every((r) => r.authorizerInApi)).toBe(true);
    // No admin path is a person route.
    expect(on('PersonApi').filter((r) => /^[A-Z]+ \/(admin|users|query)(\/|$)/.test(r.key))).toEqual([]);
  });

  it('AdminApi: every route behind IAM, but the console session, behind its own edge authorizer', () => {
    const notIam = on('AdminApi').filter((r) => r.auth !== 'AWS_IAM').map((r) => `${r.key} ${r.auth}`);
    expect(notIam).toEqual(['POST /exchange-credentials CUSTOM']);
    expect(on('AdminApi').every((r) => r.authorizerInApi)).toBe(true);
  });

  it('answers the exchange, the console session and every single-use route uncached, and every other for at most the TTL', () => {
    for (const r of served.filter((x) => x.auth === 'CUSTOM')) {
      const want = UNCACHED_ROUTES.includes(r.key) ? 0 : EDGE_RESULT_TTL_SECONDS;
      expect({ route: `${r.stack} ${r.key}`, ttl: r.ttl }).toEqual({ route: `${r.stack} ${r.key}`, ttl: want });
    }
    expect(EDGE_RESULT_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(served.filter((r) => r.ttl === 0).map((r) => `${r.stack} ${r.key}`).sort())
      .toEqual(['AgentEchelonAdminApi POST /exchange-credentials', 'AgentEchelonPersonApi POST /exchange-credentials']);
  });

  it('serves no vendor route: a subscribing connector\'s events arrive through its partner event source', () => {
    expect(served.filter((r) => r.key.includes('/webhooks/'))).toEqual([]);
    // Every route a stack outside the two APIs would serve is one an API serves: none is left over.
    expect(served.filter((r) => !/^AgentEchelon(PersonApi|AdminApi)$/.test(r.stack))).toEqual([]);
  });

  it('sends every handler payload format 1.0', () => {
    expect([...new Set(served.map((r) => r.payload))]).toEqual(['1.0']);
  });
});
