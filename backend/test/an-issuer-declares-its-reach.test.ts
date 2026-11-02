/**
 * AN ISSUER DECLARES WHERE ITS PEOPLE'S REACH COMES FROM, AND THE MOST IT CAN BE (Q5).
 *
 * The trusted-issuer registry (`lib/config/issuers.ts`) is validated at synth, and every refusal here is
 * one a deployment hits before anything is deployed:
 *
 *  - an entry with no clearance source, or no classifications: there is no fallback reach;
 *  - `admin: true` on `guest`, `invitation-link` or `host-assertion` (A6, D10);
 *  - the admin capability with no issuer that is not the guest (L18);
 *  - the modes that parse but are NOT BUILT, each with why, and where `provisioned-only` may be
 *    declared (the `host-assertion` kind's own refusals are `a-host-assertion-issuer-pins-its-keys.test.ts`);
 *  - classifications naming one the deployment does not declare, and a source reaching past it.
 *
 * Then the synthesized app: the registry reaches the exchange and the person authorizers, and an absent
 * registry is the deployment's own pool alone.
 */
import {
  ISSUER_KINDS,
  defaultIssuers,
  issuerErrors,
  issuerRegistry,
  parseIssuersContext,
  runtimeIssuers,
  compactIssuers,
  expandIssuer,
  userProfileServiceArn,
  issuerClassificationsOf,
  holderTokenOf,
  heldWithinIssuer,
} from '../lib/config/issuers';
import { ProfileRegistry } from '../lib/profile-registry';
import { resolveDeploymentProfiles } from '../lib/config/profiles';
import { CUSTOM_PROFILES, CUSTOM_PROFILES_PLUS_ENTERPRISE } from './deploy-matrix/configurations';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

/** An Entra allowlist of two tenants, for the entries that verify Entra directly. */
const ENTRA_TENANTS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000'];
const ENTRA_DISCOVERY = 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const self = (extra: Record<string, unknown> = {}) => ({
  id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true, ...extra,
});
const host = (extra: Record<string, unknown> = {}) => ({
  id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', clearance: { oneChannel: 'basic', classifications: ['basic'] }, ...extra,
});
const errorsOf = (list: unknown[], capabilities: string[] = []) => issuerErrors(list, profiles, capabilities);
const refusedWith = (list: unknown[], pattern: RegExp, capabilities: string[] = []) => {
  const errors = errorsOf(list, capabilities);
  expect(errors.some((e) => pattern.test(e))).toBe(true);
  return errors;
};

describe('a registry with no declaration', () => {
  it('trusts this deployment\'s own pool alone, at every classification, its admins as admins', () => {
    const registry = issuerRegistry(undefined, profiles, ['admin']);
    expect(registry.entries).toEqual(defaultIssuers(profiles));
    // NO LISTED SET: its groups clear for whatever they name (every classification of the deployment's own people);
    // the guest's is reached through the guest issuer alone.
    expect(registry.self()).toMatchObject({ pool: 'self', admin: true, clearance: { groups: true } });
    expect(registry.self()!.clearance.classifications).toBeUndefined();
    expect(issuerClassificationsOf(registry.self()!, profiles)).toEqual(profiles.memberClassificationValues());
    expect(profiles.memberClassificationValues()).not.toContain('guest');
    expect(registry.contextClassification()).toBeUndefined();
    expect(registry.otherPoolIds()).toEqual([]);
    expect(registry.identityProviderLabel()).toBe('cognito');
  });

  it('accepts the shipped example and a host app\'s pool beside it', () => {
    expect(errorsOf([self(), host()], ['admin'])).toEqual([]);
  });
});

describe('no fallback reach', () => {
  it('refuses an entry that declares no clearance source', () => {
    refusedWith([self(), host({ clearance: undefined })], /issuer "host": declares no clearance source/);
    refusedWith([self(), host({ clearance: { classifications: ['basic'] } })], /declares no clearance source/);
  });

  it('refuses an entry that names two sources, which is not one declaration', () => {
    refusedWith([self(), host({ clearance: { oneChannel: 'basic', fixed: ['basic'], classifications: ['basic'] } })], /declares no clearance source/);
  });

  it('refuses a source with no classifications, and classifications naming an undeclared one', () => {
    // A groups source may list none: it reaches whatever its groups clear for. Every other source lists them.
    expect(errorsOf([self({ clearance: { groups: true } })])).toEqual([]);
    refusedWith([host({ clearance: { oneChannel: 'basic' } })], /declares no classifications/);
    refusedWith([self({ clearance: { groups: true, classifications: [] } })], /declares no classifications/);
    refusedWith([self({ clearance: { groups: true, classifications: ['basic', 'legal'] } })], /classifications name "legal"/);
  });

  it('refuses a source that reaches outside its classifications', () => {
    refusedWith([self(), host({ clearance: { fixed: ['premium'], classifications: ['basic'] } })], /fixed names "premium", outside the issuer's classifications/);
    refusedWith([self(), host({ clearance: { oneChannel: 'standard', classifications: ['basic'] } })], /oneChannel names "standard", outside the issuer's classifications/);
    refusedWith([self(), {
      id: 'okta', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY, audience: 'ae',
      clearance: { mapping: { claim: 'roles', values: { analyst: 'premium' } }, classifications: ['basic'] },
    }], /mapping value "analyst" maps to "premium", outside the issuer's classifications/);
  });

  it("refuses oneChannel on this deployment's own pool, whose routes leave the gateway no second layer", () => {
    refusedWith([self({ clearance: { oneChannel: 'basic', classifications: ['basic'] }, admin: false })],
      /oneChannel cannot be declared on this deployment's own pool: that pool serves every person route, so the gateway cannot be a second layer/);
    refusedWith([self(), { id: 'saml', kind: 'cognito-federated', pool: 'self', providerName: 'Okta', clearance: { oneChannel: 'basic', classifications: ['basic'] } }],
      /must be its own pool/);
  });

  it('refuses a oneChannel classification no conversation can be created at', () => {
    refusedWith([self(), host({ clearance: { oneChannel: 'admin', classifications: ['admin'] } })], /not a classification a conversation can be created at/);
  });

  it('refuses a pool\'s own groups on a kind whose groups are its provider\'s: those are translated', () => {
    refusedWith([self(), {
      id: 'okta', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY, audience: 'ae',
      clearance: { groups: true, classifications: ['basic'] },
    }], /groups: true is a cognito-pool's own groups/);
  });

  it('refuses oneChannel issuers naming different classifications', () => {
    refusedWith([self(), host(), host({ id: 'host-two', pool: 'us-east-1_HostTwo', clearance: { oneChannel: 'standard', classifications: ['standard'] } })],
      /context conversations at more than one classification are NOT BUILT/);
  });
});

describe('admin (A6, D10, L18)', () => {
  it.each(['guest', 'invitation-link', 'host-assertion'])('refuses admin: true on a %s issuer', (kind) => {
    refusedWith([self(), { id: 'outside', kind, clearance: { fixed: ['basic'], classifications: ['basic'] }, admin: true }],
      new RegExp(`a ${kind} issuer cannot declare admin: true`));
  });

  it('refuses the admin capability with only a guest issuer (L18)', () => {
    const guest = { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] } };
    refusedWith([self({ admin: false }), guest], /the admin capability needs an issuer that is not the guest/, ['admin']);
    // The same registry without the admin capability synthesizes.
    expect(errorsOf([self({ admin: false }), guest])).toEqual([]);
  });

  it('refuses the admin capability when no issuer declares admin: true at all', () => {
    refusedWith([self({ admin: false })], /the admin capability needs an issuer that is not the guest/, ['admin']);
    expect(errorsOf([self({ admin: false })])).toEqual([]);
  });

  it('refuses admin on a oneChannel issuer, and adminGroups without admin', () => {
    refusedWith([self(), host({ admin: true })], /a oneChannel issuer cannot declare admin: true/);
    refusedWith([self({ admin: false, adminGroups: ['ops'] })], /adminGroups is meaningful only with admin: true/);
  });
});

describe('what parses and is NOT BUILT', () => {
  it("builds every kind: none is refused as NOT BUILT (the invitation-link kind's own refusals are an-invitation-link-issuer-is-declared-with-its-controls.test.ts)", () => {
    expect(errorsOf([self(), { id: 'invitation', kind: 'invitation-link', clearance: { fixed: ['basic'], classifications: ['basic'] } }])).toEqual([]);
  });

  it('refuses provisioning scim as NOT BUILT', () => {
    refusedWith([self({ provisioning: 'scim' })], /provisioning "scim" is NOT BUILT/);
    expect(errorsOf([self({ provisioning: 'on-first-sign-in' })])).toEqual([]);
  });

  it('takes provisioned-only on another issuer, never on this deployment\'s own pool or a oneChannel issuer (P-13)', () => {
    const oidc = { id: 'partner', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY, audience: 'ae', clearance: { fixed: ['basic'], classifications: ['basic'] } };
    expect(errorsOf([self(), { ...oidc, provisioning: 'provisioned-only' }])).toEqual([]);
    expect(issuerRegistry([self(), { ...oidc, provisioning: 'provisioned-only' }], profiles).provisionedOnly().map((e) => e.id)).toEqual(['partner']);
    // The first administrator signs in through the one minter, so the deployment's own pool mints.
    refusedWith([self({ provisioning: 'provisioned-only' })], /this deployment's own pool mints its people at their first sign-in/);
    refusedWith([self(), host({ provisioning: 'provisioned-only' })], /a oneChannel issuer mints its people at their first sign-in/);
  });

  it('refuses a scim or connector lifecycle as NOT BUILT', () => {
    refusedWith([self({ lifecycle: 'scim' })], /lifecycle "scim" is NOT BUILT/);
    refusedWith([self({ lifecycle: 'connector:workday' })], /lifecycle "connector:workday" is NOT BUILT/);
    expect(errorsOf([self({ lifecycle: 'cloudtrail-cognito' })])).toEqual([]);
  });

  it('refuses a directory adapter that is not built', () => {
    refusedWith([self({ directory: 'graph' })], /directory "graph" is NOT BUILT/);
  });

  it('refuses identity-store, graph, scim and connector directories as NOT BUILT, each with why (C5)', () => {
    const oidc = (directory: string) => ({
      id: 'partner', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY,
      audience: 'ae', clearance: { fixed: ['basic'], classifications: ['basic'] }, directory,
    });
    refusedWith([self(), oidc('identity-store')], /directory "identity-store" is NOT BUILT: no IAM Identity Center adapter exists/);
    refusedWith([self(), oidc('graph')], /directory "graph" is NOT BUILT: no Microsoft Graph connector exists/);
    refusedWith([self(), oidc('scim')], /directory "scim" is NOT BUILT: this deployment has no SCIM receiver/);
    refusedWith([self(), oidc('connector:salesforce')], /directory "connector:salesforce" is NOT BUILT: no connector serves as a directory adapter/);
    expect(errorsOf([self(), oidc('claims')])).toEqual([]);
    expect(errorsOf([self(), oidc('none')])).toEqual([]);
  });

  it('refuses a pool read through no directory, because the vend asks the pool whether the account is enabled', () => {
    refusedWith([self({ directory: 'none' })], /reads its pool \(directory "cognito"\), which is where the vend asks whether the account is enabled/);
  });

  it('keeps the claims copy for an issuer with no directory, never for a pool, which is read live', () => {
    refusedWith([self({ directory: 'claims' })], /the claims directory is for an issuer with no directory of its own/);
    expect(issuerRegistry([self(), {
      id: 'partner', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY,
      audience: 'ae', clearance: { fixed: ['basic'], classifications: ['basic'] }, directory: 'claims',
    }], profiles).claimsDirectoryIssuers()).toEqual(['partner']);
    expect(issuerRegistry(undefined, profiles).claimsDirectoryIssuers()).toEqual([]);
  });

  it('the runtime form carries each entry\'s directory, its default left out', () => {
    const reg = issuerRegistry([self(), {
      id: 'partner', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY,
      audience: 'ae', clearance: { fixed: ['basic'], classifications: ['basic'] }, directory: 'claims',
    }], profiles);
    const runtime = runtimeIssuers(reg, 'us-east-1_SELF', 'us-east-1');
    expect(runtime.map((t) => [t.id, t.directory])).toEqual([['deployment', 'cognito'], ['partner', 'claims']]);
    const compact = compactIssuers(runtime);
    expect(compact[0]).not.toHaveProperty('directory');
    expect(compact[1].directory).toBe('claims');
    expect(compact.map((c) => expandIssuer(c)!.directory)).toEqual(['cognito', 'claims']);
  });

  it('takes a userProfileService Lambda ARN beside the registry, and refuses anything else (C6)', () => {
    expect(userProfileServiceArn(undefined)).toBeUndefined();
    expect(userProfileServiceArn('')).toBeUndefined();
    expect(userProfileServiceArn('arn:aws:lambda:us-east-1:111122223333:function:profiles')).toBe('arn:aws:lambda:us-east-1:111122223333:function:profiles');
    expect(() => userProfileServiceArn('arn:aws:dynamodb:us-east-1:111122223333:table/profiles')).toThrow(/is not a Lambda function ARN/);
  });

  it('knows every kind the plan names, and refuses one it does not', () => {
    expect([...ISSUER_KINDS].sort()).toEqual(['cognito-federated', 'cognito-pool', 'guest', 'host-assertion', 'invitation-link', 'oidc', 'oidc-entra']);
    refusedWith([self(), { id: 'pd', kind: 'pagerduty', clearance: { fixed: ['basic'], classifications: ['basic'] } }], /"pagerduty" is not an issuer kind/);
  });
});

describe('the kinds built here', () => {
  const entra = {
    id: 'entra', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2,
    discoveryUrl: ENTRA_DISCOVERY,
    audience: 'api://ae', clearance: { mapping: { claim: 'roles', values: { 'AE.Admin': 'admin' } }, classifications: ALL }, admin: true,
  };
  const saml = { id: 'okta-saml', kind: 'cognito-federated', pool: 'self', providerName: 'Okta', clearance: { mapping: { claim: 'custom:roles', values: { analyst: 'standard' } }, classifications: ['basic', 'standard'] }, displayName: { en: 'Okta' } };

  it('accepts cognito-pool, cognito-federated and multi-tenant oidc-entra entries', () => {
    expect(errorsOf([self(), host(), saml, entra, {
      id: 'okta', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY, audience: ['ae'],
      clearance: { fixed: ['basic'], classifications: ['basic'] }, allowedOrigins: ['https://plans.example.com'],
    }], ['admin'])).toEqual([]);
  });

  it('accepts a generic oidc entry, with or without a pool of its own', () => {
    const generic = { id: 'okta', kind: 'oidc', issuer: 'https://idp.example.com', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration', audience: 'ae', directory: 'claims', clearance: { fixed: ['basic'], classifications: ['basic'] } };
    expect(errorsOf([self(), generic])).toEqual([]);
    expect(errorsOf([generic])).toEqual([]);
  });

  it('accepts a single-tenant oidc-entra entry beside a pool and without one: the deployment chooses', () => {
    const single = { ...entra, admin: false, tenants: [ENTRA_TENANTS[0]], clearance: { fixed: ['basic'], classifications: ['basic'] } };
    expect(errorsOf([self(), single])).toEqual([]);
    expect(errorsOf([single])).toEqual([]);
  });

  it('refuses each kind without its own fields', () => {
    refusedWith([self(), { ...saml, providerName: undefined }], /names its providerName/);
    refusedWith([self(), { ...entra, tenants: ['not-a-guid'] }], /lists its tenant GUIDs/);
    refusedWith([self(), { ...entra, tokenVersion: 3 }], /tokenVersion 1 or 2/);
    refusedWith([self(), { id: 'okta', kind: 'oidc', clearance: { fixed: ['basic'], classifications: ['basic'] } }], /exact https issuer/);
    refusedWith([self({ id: 'mine' })], /this deployment's own pool is the issuer "deployment"/);
  });

  it('writes the runtime form with each pool resolved and each subject declared', () => {
    const registry = issuerRegistry([self(), host(), saml, entra], profiles, ['admin']);
    const runtime = runtimeIssuers(registry, 'us-east-1_Self', 'us-east-1');
    expect(runtime.find((t) => t.id === 'deployment')).toMatchObject({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Self', subject: ['sub'], groupsClaim: 'cognito:groups' });
    expect(runtime.find((t) => t.id === 'host')).toMatchObject({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_HostApp', admin: false });
    expect(runtime.find((t) => t.id === 'entra')).toMatchObject({ subject: ['tid', 'oid'], admin: true });
    expect(registry.contextClassification()).toBe('basic');
    expect(registry.foreignPools()).toEqual([{ id: 'host', pool: 'us-east-1_HostApp', oneChannelOnly: true, admin: false }]);
    expect(registry.identityProviderLabel()).toBe('Okta');
  });

  it('travels with every default left out, and is restored whole', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { compactIssuers, expandIssuer } = require('../lib/config/issuers') as typeof import('../lib/config/issuers');
    const runtime = runtimeIssuers(issuerRegistry([self(), host(), saml, entra], profiles), 'us-east-1_Self', 'us-east-1');
    const compact = compactIssuers(runtime);
    // A Cognito entry's iss is derived from its pool id, so it does not travel.
    expect(compact.find((t) => t.id === 'host')).toEqual({ id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', clearance: { oneChannel: 'basic', classifications: ['basic'] } });
    expect(compact.map(expandIssuer)).toEqual(runtime);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(runtime).length);
  });
});

describe('the issuers context value', () => {
  it('reads an array, a JSON string and the json64 form deploy.mjs forwards', () => {
    const list = [self()];
    expect(parseIssuersContext(list)).toEqual(list);
    expect(parseIssuersContext(JSON.stringify(list))).toEqual(list);
    expect(parseIssuersContext(`json64:${Buffer.from(JSON.stringify(list)).toString('base64url')}`)).toEqual(list);
    expect(parseIssuersContext(undefined)).toBeUndefined();
    expect(() => parseIssuersContext('{"id":"x"}')).toThrow(/not a list/);
  });

  it('round-trips through the deploy guard that forwards deploy.config.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { contextFlagsFromConfig } = require('../scripts/lib/deploy-guards.cjs');
    const flags: string[] = contextFlagsFromConfig({ issuers: [self(), host()], capabilities: ['chat', 'admin'] });
    const issuers = flags.find((f) => f.startsWith('issuers='))!.slice('issuers='.length);
    // No quote, space or brace a shell could split: the Windows spawn goes through cmd.exe.
    expect(issuers).toMatch(/^json64:[A-Za-z0-9_-]+$/);
    expect(parseIssuersContext(issuers)).toEqual([self(), host()]);
    expect(flags).toContain('capabilities=chat,admin');
  });
});

describe('the app refuses at synth, before any stack is built', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { synthesizeApp } = require('../lib/docs/api-contract') as typeof import('../lib/docs/api-contract');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const REPO_ROOT = path.resolve(__dirname, '..', '..');
  const refusal = (context: Record<string, unknown>): string => {
    try {
      // A guest issuer is declared beside the two outside classifications it needs, so the refusal read is the one under test.
      synthesizeApp(REPO_ROOT, { id: 'refused', context: { analyticsMode: 'athena', profiles: ['basic', 'standard', 'premium', 'guest', 'customer'], ...context } });
    } catch (err) {
      return String((err as { stderr?: Buffer }).stderr ?? (err as Error).message);
    }
    return 'synthesized';
  };

  it('refuses the admin capability with only a guest issuer (L18)', () => {
    const text = refusal({
      capabilities: ['admin'],
      issuers: [self({ admin: false }), { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] } }],
    });
    expect(text).toContain('the admin capability needs an issuer that is not the guest');
  }, 300_000);

  it('refuses a production guest issuer on the captcha vendor test keys', () => {
    const text = refusal({
      environment: 'production',
      capabilities: [],
      issuers: [self(), { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] } }],
    });
    expect(text).toContain('a production guest issuer declares guest.captcha.siteKey');
    expect(text).toContain('a production guest issuer names its captcha secret');
  }, 300_000);

  it.each(['federatedUserPoolId', 'assistantTier', 'notifyUserPoolId', 'notifyAdditionalUserPoolIds', 'adminGroupNames', 'identityProvider'])(
    'refuses the retired %s, naming the registry that replaced it',
    (key) => {
      const text = refusal({ capabilities: [], [key]: 'x' });
      expect(text).toContain(`${key} is retired`);
      expect(text).toMatch(/issuers|trusted-issuer registry/);
    },
    300_000,
  );
});

describe('the outside classifications', () => {
  const customers = (extra: Record<string, unknown> = {}) => ({
    id: 'customers', kind: 'cognito-pool', pool: 'us-east-1_Customers', clearance: { fixed: ['customer'], classifications: ['customer'] }, ...extra,
  });
  const guest = (extra: Record<string, unknown> = {}) => ({ id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, ...extra });

  it('accepts a customers\' pool that reaches the customer classification alone, beside the guest', () => {
    expect(profiles.outsideClassificationValues()).toEqual(['guest', 'customer']);
    expect(errorsOf([self(), guest(), customers()])).toEqual([]);
  });

  it('keeps the visitor\'s classification the guest issuer\'s alone', () => {
    refusedWith([self(), customers({ clearance: { fixed: ['guest'], classifications: ['guest'] } })], /classifications name "guest", a visitor's classification; only a guest issuer reaches it/);
    refusedWith([self(), guest({ clearance: { fixed: ['customer'], classifications: ['customer'] } })], /a guest issuer's clearance is fixed at one visitor classification/);
  });

  it('refuses one issuer spanning the deployment\'s own people and outside ones, and an admin issuer for outside people', () => {
    refusedWith([self({ clearance: { groups: true, classifications: [...ALL, 'customer'] } })], /beside the deployment's own; an issuer for outside people reaches outside classifications alone/);
    refusedWith([self(), customers({ admin: true })], /an issuer for outside people cannot declare admin: true/);
  });

  it('no member classification reaches the customer, and it is never the fail-closed stamp', () => {
    for (const c of profiles.memberClassificationValues()) expect(profiles.grantsFor(c)).not.toContain('customer');
    expect(profiles.grantsFor('customer')).toEqual(['customer']);
    expect(profiles.failClosedContentValue).not.toBe('customer');
  });
});

describe('a Cognito entry keys on the sub its pool is asked by (SPEC-CREDENTIAL-EXCHANGE §4b)', () => {
  // Whether an account may sign in is asked of the pool by the account's `sub`, so another subject claim
  // would find no account and refuse every vend through the entry.
  const saml = (extra: Record<string, unknown> = {}) => ({
    id: 'okta-saml', kind: 'cognito-federated', pool: 'self', providerName: 'Okta',
    clearance: { mapping: { claim: 'custom:roles', values: { analyst: 'standard' } }, classifications: ['basic', 'standard'] }, displayName: { en: 'Okta' }, ...extra,
  });

  it.each([[['email']], [['cognito:username']], [['sub', 'email']], [['custom:employee_id']]])(
    'refuses a cognito-pool or cognito-federated entry whose subject is %j', (subject) => {
      refusedWith([self(), host({ subject })], /"host": a cognito-pool entry is read from its pool by the account's sub/);
      refusedWith([self(), saml({ subject })], /"okta-saml": a cognito-federated entry is read from its pool by the account's sub/);
    },
  );

  it('accepts a subject of ["sub"] or none, which is sub', () => {
    expect(errorsOf([self({ subject: ['sub'] }), host(), saml({ subject: ['sub'] })])).toEqual([]);
  });

  it('accepts another subject on an entry that is not read from its pool', () => {
    expect(errorsOf([self(), host({ subject: ['email'], directory: 'claims' })]).filter((e) => /by the account's sub/.test(e))).toEqual([]);
  });

  it('leaves other kinds their own subject claims', () => {
    const entra = { id: 'entra', kind: 'oidc-entra', tenants: ENTRA_TENANTS, discoveryUrl: ENTRA_DISCOVERY, audience: 'api://x', clearance: { fixed: ['basic'], classifications: ['basic'] }, displayName: { en: 'Entra' } };
    expect(errorsOf([self(), entra]).filter((e) => /by the account's sub/.test(e))).toEqual([]);
  });

  it('passes the shipped deploy configs', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    for (const file of ['deploy.config.example.json', 'deploy.config.guest-widget.example.json', 'deploy.config.json']) {
      const at = path.join(__dirname, '..', file);
      if (!fs.existsSync(at)) continue; // deploy.config.json is the gitignored live config, absent in CI
      const config = JSON.parse(fs.readFileSync(at, 'utf8'));
      const issuers = (config.context ?? config).issuers;
      const list = Array.isArray(issuers) ? issuers : issuers?.issuers;
      if (!list) continue;
      expect([file, issuerErrors(list, profiles, []).filter((e) => /by the account's sub/.test(e))]).toEqual([file, []]);
    }
  });
});

describe('an issuer with groups and no listed set reaches what its groups clear, in the set the registry holds', () => {
  const entry = { id: 'deployment', kind: 'cognito-pool' as const, pool: 'self', subject: ['sub'], clearance: { groups: true as const }, admin: true, groupsClaim: 'cognito:groups', directory: 'cognito' as const };

  it('reaches a classification added later with no change to its entry', () => {
    const before = new ProfileRegistry(resolveDeploymentProfiles(CUSTOM_PROFILES));
    const after = new ProfileRegistry(resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE));
    expect(issuerClassificationsOf(entry, before).sort()).toEqual(['admin', 'finance', 'legal']);
    expect(issuerClassificationsOf(entry, after).sort()).toEqual(['admin', 'enterprise', 'finance', 'legal']);
    const claims = { iss: 'x', sub: 's', 'cognito:groups': ['enterprise'] };
    expect(holderTokenOf(entry as never, claims, before)).toBeUndefined();
    expect(holderTokenOf(entry as never, claims, after)).toBe('enterprise');
  });

  it('still binds an issuer that lists its classifications to that list', () => {
    const after = new ProfileRegistry(resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE));
    expect(heldWithinIssuer({ clearance: { groups: true, classifications: ['legal', 'finance', 'admin'] } }, ['enterprise', 'legal'], after)).toEqual(['legal']);
    expect(heldWithinIssuer({ clearance: { groups: true } }, ['enterprise', 'legal'], after)).toEqual(['enterprise', 'legal']);
  });
});

describe('an issuer that lists no classifications reaches its own audience, and the admin plane only when it declares admin', () => {
  const claimsWith = (groups: string[]) => ({ iss: 'x', sub: 's', 'cognito:groups': groups, groups });
  const foreignPool = { id: 'partner', kind: 'cognito-pool' as const, pool: 'us-east-1_Partner', subject: ['sub'], clearance: { groups: true as const }, admin: false, groupsClaim: 'cognito:groups', directory: 'cognito' as const };
  const foreignOidc = { id: 'idp', kind: 'oidc' as const, subject: ['sub'], clearance: { groups: { map: { 'g-admins': 'admins', 'g-basic': 'basic' } } }, admin: false, groupsClaim: 'groups', directory: 'none' as const };

  it('a foreign pool whose group is called admins reaches no admin plane', () => {
    expect(issuerClassificationsOf(foreignPool, profiles)).not.toContain('admin');
    expect(heldWithinIssuer(foreignPool, ['admin', 'basic'], profiles)).toEqual(['basic']);
    expect(holderTokenOf(foreignPool as never, claimsWith(['admins']), profiles)).toBeUndefined();
  });

  it('a translation mapping a provider group to admins reaches no admin plane without admin: true', () => {
    expect(issuerClassificationsOf(foreignOidc, profiles)).not.toContain('admin');
    expect(holderTokenOf(foreignOidc as never, claimsWith(['g-admins']), profiles)).toBeUndefined();
    expect(holderTokenOf(foreignOidc as never, claimsWith(['g-basic']), profiles)).toBe('basic');
  });

  it('the same entry declaring admin: true reaches the admin plane', () => {
    expect(issuerClassificationsOf({ ...foreignPool, admin: true }, profiles)).toContain('admin');
    expect(holderTokenOf({ ...foreignPool, admin: true } as never, claimsWith(['admins']), profiles)).toBe('admin');
  });

  it('never reaches an outside classification: no group clears for one, so an issuer for outside people lists its own', () => {
    for (const e of [foreignPool, foreignOidc, { ...foreignPool, admin: true }]) {
      for (const v of profiles.outsideClassificationValues()) expect(issuerClassificationsOf(e, profiles)).not.toContain(v);
    }
    const config = (profiles as unknown as { config: { groupClearance: Record<string, string> } }).config;
    expect(() => new ProfileRegistry({ ...config, groupClearance: { ...config.groupClearance, customers: 'customer' } } as never))
      .toThrow(/names the outside classification 'customer'/);
  });

  it('runs the outside-people rules on what an entry reaches with no list', () => {
    const idp = (extra: Record<string, unknown> = {}) => ({
      id: 'idp', kind: 'oidc', issuer: 'https://idp.example.com', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
      audience: 'ae', directory: 'claims', clearance: { groups: { map: { b: 'basic' } } }, ...extra,
    });
    // A registry whose own people include an outside value is refused by its own validation; here the rule is
    // exercised directly, by a registry stand-in that reports one beside the deployment's own.
    const leaky = Object.assign(Object.create(profiles), { memberClassificationValues: () => ['basic', 'customer'] });
    expect(issuerErrors([self(), idp()], leaky, []).some((e) => /the outside classification "customer" beside the deployment's own/.test(e))).toBe(true);
    expect(issuerErrors([self(), idp()], profiles, []).filter((e) => /outside/.test(e))).toEqual([]);
  });
});
