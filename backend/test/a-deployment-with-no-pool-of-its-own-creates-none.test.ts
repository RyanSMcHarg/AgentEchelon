/**
 * A DEPLOYMENT WHOSE REGISTRY DECLARES NO ISSUER ON ITS OWN POOL CREATES NO USER POOL (L15).
 *
 * Cognito is the bundled default issuer, not a dependency: the deployment's own pool is an issuer added
 * by declaration (`pool: 'self'`), and the product stands up without one. Synthesized as the whole app,
 * every built capability declared, with a registry naming one Entra tenant through the direct route (a pool-less
 * deployment is where a single-tenant `oidc-entra` entry is taken; with a pool it federates into the pool), with `admin`, so the admin
 * backend has a staff issuer), in both archive modes:
 *
 *  - no stack holds a user pool, an app client, a group or a managed login domain;
 *  - no stack resolves the pool-id parameter the Identity stack publishes only with a pool, so a first
 *    install does not fail on a parameter that was never written;
 *  - no grant names a pool, which would otherwise be `userpool/` with no id;
 *  - the person API is still there, and its edge authorizer verifies the Entra issuer.
 */
import * as path from 'path';
import { synthesizeApp, SYNTH_CAPABILITIES, type SynthesizedApp } from '../lib/docs/api-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

const OIDC_ONLY = [{
  id: 'corp',
  kind: 'oidc-entra',
  tenants: ['11111111-2222-3333-4444-555555555555'],
  tokenVersion: 2,
  discoveryUrl: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0/.well-known/openid-configuration',
  audience: 'corp-client',
  clearance: { fixed: ['basic', 'standard', 'premium', 'admin'], classifications: ['basic', 'standard', 'premium', 'admin'] },
  admin: true,
}];

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = { Parameters?: Record<string, { Default?: unknown }>; Resources?: Record<string, Resource> };

describe.each(['athena', 'aurora'] as const)('a deployment with no pool of its own (%s)', (mode) => {
  let app: SynthesizedApp;
  beforeAll(() => {
    app = synthesizeApp(REPO_ROOT, { id: `no-pool-${mode}`, context: { analyticsMode: mode, capabilities: [...SYNTH_CAPABILITIES], issuers: OIDC_ONLY } });
  }, SYNTH_TIMEOUT_MS);
  const templates = () => Object.entries(app.templates) as Array<[string, Template]>;

  it('creates no user pool, app client, group or login domain in any stack', () => {
    const found = templates().flatMap(([stack, t]) => Object.entries(t.Resources ?? {})
      .filter(([, r]) => /^AWS::Cognito::UserPool/.test(r.Type))
      .map(([id, r]) => `${stack}/${id} (${r.Type})`));
    expect(found).toEqual([]);
  });

  it('resolves no pool-id parameter at deploy', () => {
    const found = templates().flatMap(([stack, t]) => Object.values(t.Parameters ?? {})
      .filter((p) => String(p.Default ?? '').endsWith('/shared/cognito-user-pool-id'))
      .map(() => stack));
    expect(found).toEqual([]);
  });

  it('grants nothing on a pool', () => {
    const found = templates().flatMap(([stack, t]) => {
      const text = JSON.stringify(t.Resources ?? {});
      return /userpool\/(["\]]|\*)/.test(text) || text.includes(':userpool/"') ? [stack] : [];
    });
    expect(found).toEqual([]);
  });

  it('still serves the person API, whose edge verifies the declared issuer', () => {
    const person = app.templates.AgentEchelonPersonApi as Template;
    expect(person).toBeDefined();
    const fn = Object.values(person.Resources ?? {}).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Environment?.Variables?.EDGE_ROUTES);
    expect(JSON.stringify(fn?.Properties?.Environment?.Variables?.TRUSTED_ISSUERS)).toContain('11111111-2222-3333-4444-555555555555');
  });
});
