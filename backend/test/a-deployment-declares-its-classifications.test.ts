/**
 * A DEPLOYMENT DECLARES ITS CLASSIFICATIONS (`profiles` in deploy.config.json, `resolveDeploymentProfiles`).
 *
 *  - Declared as nothing, it runs the shipped catalog minus its outside classifications: no `guest`, no
 *    `customer`, so no `Assistants-guest` and no `Assistants-customer`.
 *  - A list selects from the shipped catalog; an object replaces it with a fully custom set. The admin
 *    plane is in every set, and every set is checked by `validateProfilesConfig`.
 *  - Synth refuses anything that names a classification the deployment does not declare: the guest issuer
 *    (it needs `guest`), its path B claim (`customer`), an invitation-link issuer's link classifications, an
 *    issuer's classifications, and a conversation type served here.
 *  - Every function the app builds is told the registry's path (`PROFILE_REGISTRY_PATH_ENV`), the same for every
 *    set, and each classification's stack publishes its row there, so the registry a handler reads at runtime is
 *    the one the stacks were synthesized from (`test/lib/the-runtime-registry-is-its-rows.test.ts`).
 *
 * The unit cases run on the resolver and the checks; two cases synthesize the real app (`synthesizeApp`).
 */
import * as path from 'path';
import { synthesizeApp } from '../lib/docs/api-contract';
import {
  DEFAULT_PROFILES_CONFIG,
  PROFILE_REGISTRY_PATH_ENV,
  canonicalProfilesConfig,
  profilesConfigFromRows,
  registryRowFromValue,
  deployedAssistantClassifications,
  parseProfilesContext,
  resolveDeploymentProfiles,
  type ProfilesConfig,
} from '../lib/config/profiles';
import { ProfileRegistry, useDeploymentProfiles } from '../lib/profile-registry';
import { classificationDeclarationErrors, typeIsServed } from '../lib/config/declared-classifications';
import { typeGroupContradictions } from '../lib/conversation-type-grants';
import { issuerErrors } from '../lib/config/issuers';
import { getModelCatalog } from '../lib/config/model-strategy';
import { CUSTOM_PROFILES } from './deploy-matrix/configurations';

/** A direct OIDC entry is a multi-tenant Entra one: a generic `oidc` entry is refused (it federates into the pool). */
const ENTRA_TENANTS = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000'];
const ENTRA_DISCOVERY = 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;

const values = (c: ProfilesConfig) => c.classifications.map((x) => x.value);
const registryOf = (raw: unknown) => new ProfileRegistry(resolveDeploymentProfiles(raw));

const GUEST = { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, allowedOrigins: ['https://www.example.com'] };
const POOL = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true };
const LINK = { id: 'invitation', kind: 'invitation-link', clearance: { fixed: ['legal'], classifications: ['legal'] } };

afterEach(() => {
  // The tests that install a set restore the shipped catalog, which is what every other test file reads.
  useDeploymentProfiles(DEFAULT_PROFILES_CONFIG);
});

describe('the set a deployment runs', () => {
  it('is the shipped catalog minus guest and customer when it declares none', () => {
    for (const raw of [undefined, null, '']) {
      const config = resolveDeploymentProfiles(raw);
      expect(values(config)).toEqual(['basic', 'standard', 'premium', 'admin']);
      expect(deployedAssistantClassifications(config)).toEqual(['basic', 'standard', 'premium']);
      expect(config.profiles.map((p) => p.name)).toEqual(['concierge', 'analyst', 'advisor', 'admin-agent']);
    }
  });

  it('deploys an outside classification only when it is declared', () => {
    const config = resolveDeploymentProfiles(['basic', 'standard', 'premium', 'guest', 'customer']);
    expect(deployedAssistantClassifications(config)).toEqual(['basic', 'standard', 'premium', 'guest', 'customer']);
    expect(config.profiles.map((p) => p.name)).toEqual(expect.arrayContaining(['greeter', 'liaison']));
  });

  it('narrows grants, clearance groups and membership groups to a selection', () => {
    const config = resolveDeploymentProfiles(['standard']);
    const registry = new ProfileRegistry(config);
    expect(values(config)).toEqual(['standard', 'admin']);
    expect(registry.grantsFor('standard')).toEqual(['standard']);
    expect(registry.grantsFor('admin')).toEqual(['admin']);
    expect(config.groupClearance).toEqual({ standard: 'standard', admins: 'admin' });
    expect(config.membershipGroups).toBeUndefined();
    expect(config.profiles.map((p) => p.name)).toEqual(['analyst', 'admin-agent']);
  });

  it('refuses a selection naming something the catalog does not ship, or nothing a conversation is held at', () => {
    expect(() => resolveDeploymentProfiles(['basic', 'legal'])).toThrow(/"legal" is not a shipped classification/);
    expect(() => resolveDeploymentProfiles(['admin'])).toThrow(/names no classification a conversation is held at/);
  });

  it('replaces the shipped catalog with a custom set, and adds the admin plane over it', () => {
    const config = resolveDeploymentProfiles(CUSTOM_PROFILES);
    const registry = new ProfileRegistry(config);
    expect(values(config)).toEqual(['legal', 'finance', 'admin']);
    expect(deployedAssistantClassifications(config)).toEqual(['legal', 'finance']);
    expect(registry.grantsFor('admin')).toEqual(['admin']);
    expect(registry.adminPlaneValues()).toEqual(['admin']);
    expect(config.groupClearance).toEqual({ legal: 'legal', finance: 'finance', admins: 'admin' });
    expect(config.profiles.map((p) => p.name)).toEqual(['counsel', 'controller', 'admin-agent']);
  });

  it('refuses a custom set that declares the admin plane itself or reuses its names', () => {
    const withAdmin = { ...CUSTOM_PROFILES, classifications: [...CUSTOM_PROFILES.classifications, { value: 'ops', profile: 'counsel', grants: ['ops'], adminPlane: true }] };
    expect(() => resolveDeploymentProfiles(withAdmin)).toThrow(/declares adminPlane; the admin plane is the platform's/);
    expect(() => resolveDeploymentProfiles({ ...CUSTOM_PROFILES, groupClearance: { ...CUSTOM_PROFILES.groupClearance, admins: 'legal' } }))
      .toThrow(/groupClearance\['admins'\] is the admin plane's clearance group/);
    expect(() => resolveDeploymentProfiles({ ...CUSTOM_PROFILES, profiles: [...CUSTOM_PROFILES.profiles, { ...CUSTOM_PROFILES.profiles[0], name: 'admin-agent' }] }))
      .toThrow(/'admin-agent' is the admin plane's assistant/);
    expect(() => resolveDeploymentProfiles({ classifications: [] })).toThrow(/a custom set is an object with a classifications list/);
  });

  it('checks every set with validateProfilesConfig', () => {
    const typo = { ...CUSTOM_PROFILES, classifications: [{ ...CUSTOM_PROFILES.classifications[0], grants: ['legal', 'finanse'] }, CUSTOM_PROFILES.classifications[1]] };
    expect(() => resolveDeploymentProfiles(typo)).toThrow(/grants 'finanse', which is not a declared classification/);
    const unserved = { ...CUSTOM_PROFILES, classifications: [{ ...CUSTOM_PROFILES.classifications[0], topology: undefined }, CUSTOM_PROFILES.classifications[1]] };
    expect(() => deployedAssistantClassifications(resolveDeploymentProfiles(unserved))).toThrow(/legal declare no topology/);
  });

  it('reads the forms deploy.mjs and a hand-written -c forward', () => {
    expect(parseProfilesContext('basic, guest')).toEqual(['basic', 'guest']);
    expect(parseProfilesContext('["basic","guest"]')).toEqual(['basic', 'guest']);
    expect(parseProfilesContext(`json64:${Buffer.from(JSON.stringify(CUSTOM_PROFILES)).toString('base64url')}`)).toEqual(CUSTOM_PROFILES);
    expect(() => parseProfilesContext('{not json')).toThrow(/the value is not JSON/);
  });
});

describe('the set a handler runs', () => {
  it('gives a custom classification exactly the models it selects, and names no classification in the catalog', () => {
    const registry = useDeploymentProfiles(resolveDeploymentProfiles(CUSTOM_PROFILES));
    expect(registry.selectsModel('legal', 'sonnet')).toBe(true);
    expect(registry.selectsModel('finance', 'sonnet')).toBe(false);
    expect(registry.selectsModel('finance', 'haiku')).toBe(true);
    expect(registry.selectsModel('legal', 'opus')).toBe(false);
    for (const model of Object.values(getModelCatalog('us-east-1', '111122223333'))) {
      expect(Object.keys(model)).not.toContain('allowedClassifications');
    }
  });

  it('keeps the shipped selections: each classification the same models it had', () => {
    const registry = useDeploymentProfiles(resolveDeploymentProfiles(['basic', 'standard', 'premium', 'guest', 'customer']));
    expect(registry.modelsOf('premium')!.selected).toContain('opus');
    for (const c of ['basic', 'standard', 'guest', 'customer']) expect(registry.selectsModel(c, 'opus')).toBe(false);
    for (const c of ['basic', 'standard', 'premium', 'guest', 'customer']) expect(registry.selectsModel(c, 'haiku')).toBe(true);
  });
});

describe('a classification named but not declared is refused', () => {
  it('refuses the guest issuer without guest, and its path B without customer', () => {
    const errors = classificationDeclarationErrors([GUEST, POOL], registryOf(undefined));
    expect(errors).toEqual([
      expect.stringMatching(/^issuer "guest": a guest issuer opens guest-visitor conversations at "guest", which this deployment does not declare; add "guest" to profiles/),
      expect.stringMatching(/^issuer "guest": guest-visitor's upgrade path B \(claim\) opens customer-engagement conversations at "customer", which this deployment does not declare/),
    ]);
    expect(classificationDeclarationErrors([GUEST, POOL], registryOf(['basic', 'standard', 'premium', 'guest'])))
      .toEqual([expect.stringMatching(/path B \(claim\).*"customer"/)]);
    expect(classificationDeclarationErrors([GUEST, POOL], registryOf(['basic', 'standard', 'premium', 'guest', 'customer']))).toEqual([]);
  });

  it('refuses an invitation-link issuer whose link classifications name a classification not declared', () => {
    // `general` declares link invitations up to basic and standard; a custom set declares neither.
    expect(classificationDeclarationErrors([LINK], registryOf(CUSTOM_PROFILES))).toEqual([
      expect.stringMatching(/^issuer "invitation": conversation type "general" declares link invitations up to "basic" \(linkClassifications\)/),
      expect.stringMatching(/^issuer "invitation": conversation type "general" declares link invitations up to "standard" \(linkClassifications\)/),
    ]);
    expect(classificationDeclarationErrors([{ ...LINK, clearance: { fixed: ['basic'], classifications: ['basic'] } }], registryOf(undefined))).toEqual([]);
  });

  it('refuses an issuer whose classifications name a classification not declared', () => {
    const customer = { id: 'customers', kind: 'oidc-entra', tenants: ENTRA_TENANTS, tokenVersion: 2, discoveryUrl: ENTRA_DISCOVERY, audience: 'ae', clearance: { fixed: ['customer'], classifications: ['customer'] } };
    expect(issuerErrors([POOL, customer], registryOf(undefined))).toEqual(expect.arrayContaining([
      'issuer "customers": classifications name "customer", which this deployment does not declare',
    ]));
    expect(issuerErrors([POOL, customer], registryOf(['basic', 'standard', 'premium', 'customer']))).toEqual([]);
  });

  it('refuses a served conversation type naming a classification or assistant not declared, and serves none naming only others', () => {
    // Under a custom set the shipped ops types (premium) and the visitor types are served nowhere.
    const custom = registryOf(CUSTOM_PROFILES);
    for (const t of ['ops', 'ops-team', 'guest-visitor', 'customer-engagement']) expect({ t, served: typeIsServed(t, custom) }).toEqual({ t, served: false });
    expect(typeIsServed('general', custom)).toBe(true);
    expect(classificationDeclarationErrors([], custom)).toEqual([]);
    expect(typeGroupContradictions(custom)).toEqual([]);
    // Premium declaring its ops role without the role's profile: the ops type adds an assistant this deployment does not declare.
    const noOps = resolveDeploymentProfiles(['premium', 'ops-premium']);
    const registry = new ProfileRegistry({ ...noOps, profiles: noOps.profiles.filter((p) => p.name !== 'ops-premium') });
    expect(classificationDeclarationErrors([], registry)).toEqual([
      'conversation type "ops" adds the assistant "ops-premium", which this deployment\'s profiles do not declare',
    ]);
  });
});

describe('the app synthesizes the set it declares', () => {
  const failureOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      const e = err as { stderr?: unknown; message?: unknown };
      return `${String(e?.message ?? '')}\n${e?.stderr ? String(e.stderr) : ''}`;
    }
    return '';
  };

  it('refuses a guest issuer when guest and customer are not declared, naming both', () => {
    const text = failureOf(() => synthesizeApp(REPO_ROOT, { id: 'guest-undeclared', context: { capabilities: [], issuers: [GUEST, POOL] } }));
    expect(text).toContain('a guest issuer opens guest-visitor conversations at "guest", which this deployment does not declare');
    expect(text).toContain('opens customer-engagement conversations at "customer", which this deployment does not declare');
  }, SYNTH_TIMEOUT_MS);

  it('stands up Assistants-guest and Assistants-customer once both are declared, and publishes each row the set has', () => {
    const profiles = ['basic', 'standard', 'premium', 'guest', 'customer'];
    const app = synthesizeApp(REPO_ROOT, { id: 'guest-declared', context: { capabilities: [], issuers: [GUEST, POOL], profiles } });
    const stacks = Object.keys(app.dependencies);
    for (const c of profiles) expect(stacks.some((s) => s.endsWith(`Assistants-${c}`))).toBe(true);
    type Fn = { Type: string; Properties?: { Environment?: { Variables?: Record<string, unknown> } } };
    const functions = Object.values(app.templates).flatMap((t) => Object.values((t as { Resources?: Record<string, Fn> }).Resources ?? {}))
      .filter((r) => r.Type === 'AWS::Lambda::Function');
    expect(functions.length).toBeGreaterThan(10);
    // Every function is told the same path, whatever the set.
    const carried = new Set(functions.map((f) => f.Properties?.Environment?.Variables?.[PROFILE_REGISTRY_PATH_ENV]).filter(Boolean));
    expect([...carried]).toEqual([expect.stringMatching(/\/registry\/classification$/)]);
    // One row per classification, each in its own stack (the admin plane's in Identity), assembling to the set.
    type Param = { Type: string; Properties?: { Name?: unknown; Value?: unknown } };
    const rows = Object.entries(app.templates).flatMap(([stack, t]) => Object.values((t as { Resources?: Record<string, Param> }).Resources ?? {})
      .filter((r) => r.Type === 'AWS::SSM::Parameter' && /\/registry\/classification\//.test(String(r.Properties?.Name)))
      .map((r) => ({ stack, name: String(r.Properties!.Name), value: String(r.Properties!.Value) })));
    expect(rows.map((r) => r.name.split('/').pop()).sort()).toEqual([...profiles, 'admin'].sort());
    for (const r of rows) {
      const value = r.name.split('/').pop()!;
      const owner = value === 'admin' ? 'Identity' : `Assistants-${value}`;
      expect({ name: r.name, stack: r.stack.endsWith(owner) }).toEqual({ name: r.name, stack: true });
    }
    expect(canonicalProfilesConfig(profilesConfigFromRows(rows.map((r) => registryRowFromValue(r.value)))))
      .toEqual(canonicalProfilesConfig(resolveDeploymentProfiles(profiles)));
  }, SYNTH_TIMEOUT_MS);
});
