/**
 * THE TEST ISSUER IS A FIXTURE, NEVER PART OF A REAL DEPLOYMENT (D16).
 *
 * The e2e suite needs people who are not in the deployment's own pool (the H1 rows): a second pool issuer,
 * a foreign OIDC issuer and a one-conversation pool. Their pools come from the opt-in `TestIssuer` stack,
 * created from the registry entries that declare `owner: "test-fixture"`, so there is no separate switch.
 * Pinned here:
 *
 *  - a fixture is refused in production, and an `owner` other than `test-fixture` marks nothing;
 *  - a fixture is trusted only once its entry names the pool TestIssuer created (fail closed);
 *  - the stack makes one pool per fixture, removed with the stack, and a managed-login domain only for
 *    the `oidc` fixture;
 *  - the whole app synthesizes the stack only when a fixture is declared.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { splitTestFixtures, TEST_FIXTURE_OWNER } from '../lib/config/test-issuers';
import { TestIssuerStack, testIssuerPoolName } from '../lib/stacks/test-issuer-stack';
import type { IssuerConfig } from '../lib/config/issuers';
import { synthesizeApp, type SynthesizedApp } from '../lib/docs/api-contract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const env = { account: '111122223333', region: 'us-east-1' };

const DEPLOYMENT = {
  id: 'deployment', kind: 'cognito-pool', pool: 'self', admin: true,
  clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] },
};
const H1_POOL = {
  id: 'h1-pool', kind: 'cognito-pool', owner: TEST_FIXTURE_OWNER, directory: 'cognito',
  clearance: { fixed: ['standard'], classifications: ['standard'] },
};
const H1_OIDC = {
  id: 'h1-oidc', kind: 'oidc', owner: TEST_FIXTURE_OWNER, directory: 'none',
  clearance: { fixed: ['basic'], classifications: ['basic'] },
};
const H1_OIDC_NAMED = {
  ...H1_OIDC,
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Fixture1',
  discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Fixture1/.well-known/openid-configuration',
  audience: 'fixture-client',
};

describe('test-fixture entries', () => {
  it('are refused in production, named or not', () => {
    expect(() => splitTestFixtures([DEPLOYMENT, H1_POOL], 'production')).toThrow(/refused in production/);
    expect(() => splitTestFixtures([DEPLOYMENT, { ...H1_POOL, pool: 'us-east-1_Fixture2' }], 'production')).toThrow(/refused in production/);
    expect(splitTestFixtures([DEPLOYMENT], 'production')).toEqual({ fixtures: [], trusted: [DEPLOYMENT], pending: [] });
  });

  it('are trusted only once they name their pool, so a half-declared fixture reaches nothing', () => {
    const split = splitTestFixtures([DEPLOYMENT, H1_POOL, H1_OIDC_NAMED], 'dev')!;
    expect(split.fixtures.map((f) => f.id)).toEqual(['h1-pool', 'h1-oidc']);
    expect(split.trusted).toEqual([DEPLOYMENT, H1_OIDC_NAMED]);
    expect(split.pending).toEqual(['h1-pool']);
    const named = splitTestFixtures([DEPLOYMENT, { ...H1_POOL, pool: 'us-east-1_Fixture2' }, H1_OIDC], 'dev')!;
    expect(named.pending).toEqual(['h1-oidc']);
  });

  it('refuse an owner that is not test-fixture, another kind, the own pool and admin', () => {
    expect(() => splitTestFixtures([{ ...H1_POOL, owner: 'tests' }], 'dev')).toThrow(/owner is "test-fixture" or absent/);
    expect(() => splitTestFixtures([{ ...H1_POOL, kind: 'guest' }], 'dev')).toThrow(/cognito-pool or an oidc entry/);
    expect(() => splitTestFixtures([{ ...H1_POOL, pool: 'self' }], 'dev')).toThrow(/never this deployment's own/);
    expect(() => splitTestFixtures([{ ...H1_POOL, admin: true }], 'dev')).toThrow(/declares admin: true only as an oidc fixture/);
  });

  it('leave the default registry alone', () => {
    expect(splitTestFixtures(undefined, 'dev')).toBeUndefined();
  });
});

describe('the TestIssuer stack', () => {
  const synth = (fixtures: unknown[]) =>
    Template.fromStack(new TestIssuerStack(new cdk.App(), 'TestIssuer', { env, fixtures: fixtures as IssuerConfig[] }));

  it('makes one pool per fixture, by its fixed name, removed with the stack', () => {
    const t = synth([H1_POOL, H1_OIDC]);
    t.resourceCountIs('AWS::Cognito::UserPool', 2);
    t.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolName: testIssuerPoolName('h1-pool') });
    t.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolName: testIssuerPoolName('h1-oidc') });
    for (const pool of Object.values(t.findResources('AWS::Cognito::UserPool'))) expect(pool.DeletionPolicy).toBe('Delete');
  });

  it('creates the provider groups a translation names, and an unmapped admins group beside them', () => {
    const translating = { ...H1_OIDC, id: 'idp-oidc', admin: true, groupsClaim: 'cognito:groups',
      clearance: { groups: { map: { 'Fixture-Standard': 'standard', 'Fixture-Admins': 'admins' } }, classifications: ['basic', 'standard', 'premium', 'admin'] } };
    const t = synth([translating]);
    for (const GroupName of ['Fixture-Standard', 'Fixture-Admins', 'admins']) t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName });
    t.resourceCountIs('AWS::Cognito::UserPoolGroup', 3);
  });

  it('accepts admin: true on an oidc fixture, the provider whose administrators the guide maps', () => {
    expect(() => splitTestFixtures([{ ...H1_OIDC, admin: true }], 'dev')).not.toThrow();
  });

  it('gives only the oidc fixture a managed login and the code flow, and outputs what its entry names', () => {
    const t = synth([H1_POOL, H1_OIDC]);
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { AllowedOAuthFlows: ['code'], GenerateSecret: false });
    for (const key of ['TestIssuerH1PoolPoolId', 'TestIssuerH1PoolClientId', 'TestIssuerH1OidcIssuer', 'TestIssuerH1OidcDiscoveryUrl']) {
      t.hasOutput(key, Match.anyValue());
    }
  });

  it('refuses to be built with no fixture', () => {
    expect(() => synth([])).toThrow(/no test-fixture issuer/);
  });
});

describe('the app', () => {
  let app: SynthesizedApp;
  beforeAll(() => {
    app = synthesizeApp(REPO_ROOT, {
      id: 'test-issuer',
      context: { analyticsMode: 'athena', capabilities: [], issuers: [DEPLOYMENT, H1_POOL, H1_OIDC_NAMED] },
    });
  }, 600_000);

  it('stands up TestIssuer when the registry declares a fixture, and nothing depends on it', () => {
    const name = Object.keys(app.dependencies).find((s) => s.endsWith('TestIssuer'));
    expect(name).toBeDefined();
    const dependents = Object.entries(app.dependencies).filter(([, deps]) => deps.includes(name!)).map(([s]) => s);
    expect(dependents).toEqual([]);
  });

  it('admits the named fixture at the edge and not the pending one', () => {
    const edge = JSON.stringify(Object.values(app.templates));
    expect(edge).toContain('us-east-1_Fixture1');
    expect(edge).toContain('h1-oidc');
    expect(edge).not.toMatch(/"h1-pool"/);
  });
});
