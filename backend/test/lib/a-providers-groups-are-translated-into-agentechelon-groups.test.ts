/**
 * A PROVIDER'S GROUPS ARE TRANSLATED INTO AGENTECHELON GROUPS, AND A POOL IS NEEDED ONLY WHEN DECLARED
 * (SPEC-CREDENTIAL-EXCHANGE §4b, "A person's groups" and "A provider is verified directly or federated").
 *
 * Each identity provider keeps its own groups; the deployment keeps its own (the AgentEchelon groups:
 * `groupClearance` and `membershipGroups` keys, `admins`, `team-members`, `team-<name>`). An issuer entry
 * translates one into the other, and every clearance, console role and team scope reads only the result,
 * so a group an outside administrator names `admins` means nothing until the entry maps it there.
 */
import {
  decodeFlattenedAttribute,
  expandIssuer,
  groupsOf,
  holderTokenOf,
  issuerErrors,
  issuerRegistry,
  runtimeIssuers,
  type TrustedIssuer,
} from '../../lib/config/issuers';
import { edgeVerificationOf } from '../../lib/config/edge-verification';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import { consoleRoleFor } from '../../lambda/src/lib/vend';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const self = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true };
const OKTA_ISS = 'https://example.okta.com/oauth2/default';
const okta = (extra: Record<string, unknown> = {}, clearance: Record<string, unknown> = {}) => ({
  id: 'okta', kind: 'oidc', issuer: OKTA_ISS, discoveryUrl: `${OKTA_ISS}/.well-known/openid-configuration`, audience: 'okta-spa-client',
  directory: 'claims', admin: true,
  clearance: { groups: { map: { 'AE Standard': 'standard', 'AE-Admins': 'admins', Platform: ['premium', 'team-platform'] } }, classifications: ALL, ...clearance },
  ...extra,
});
const TENANT = '11111111-2222-3333-4444-555555555555';
const entra = (extra: Record<string, unknown> = {}) => ({
  id: 'entra', kind: 'oidc-entra', tenants: [TENANT], tokenVersion: 2, audience: 'entra-client', directory: 'claims',
  discoveryUrl: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
  clearance: { groups: { map: { 'aaaaaaaa-0000-4000-8000-000000000001': 'standard' } }, classifications: ['basic', 'standard'] },
  ...extra,
});
const federated = (groups: Record<string, unknown> = { map: { 'AE Standard': 'standard' }, emptyGroupsSent: true }, extra: Record<string, unknown> = {}) => ({
  id: 'corp-saml', kind: 'cognito-federated', pool: 'self', providerName: 'CorpSAML',
  clearance: { groups, classifications: ['basic', 'standard'] }, ...extra,
});

const errorsOf = (list: unknown[], environment = 'production') => issuerErrors(list, profiles, { environment });
const refused = (list: unknown[], pattern: RegExp) => expect(errorsOf(list).some((e) => pattern.test(e))).toBe(true);

/** The runtime entry, as the edge and the exchange read it. */
function runtimeOf(entry: Record<string, unknown>): TrustedIssuer {
  const registry = issuerRegistry([self, entry], profiles, { environment: 'production' });
  const t = runtimeIssuers(registry, 'us-east-1_Pool', 'us-east-1').find((x) => x.id === entry.id)!;
  return expandIssuer(t)!;
}

describe('a provider is verified directly or federated into the pool, and the deployment chooses', () => {
  it('accepts a production oidc entry, and needs no pool for one', () => {
    expect(errorsOf([self, okta()])).toEqual([]);
    const alone = issuerRegistry([okta()], profiles, { environment: 'production' });
    expect(alone.ownsPool()).toBe(false);
  });

  it('accepts a single-tenant oidc-entra entry beside a pool', () => {
    expect(errorsOf([self, entra()])).toEqual([]);
  });

  it('refuses an issuer whose iss every account shares unless it names what makes a token its own', () => {
    const google = okta({ id: 'google', issuer: 'https://accounts.google.com', discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration' });
    refused([self, google], /shared by every account of that provider/);
    expect(errorsOf([self, { ...google, requiredClaims: { hd: 'example.com' } }])).toEqual([]);
  });

  it('carries the lifetime bound and the required claims to the edge', () => {
    const v = edgeVerificationOf({ ...okta(), requiredClaims: { hd: 'example.com' }, maxLifetimeMinutes: 30 } as never, []);
    expect(v).toMatchObject({ maxLifetimeSeconds: 1800, requiredClaims: { hd: 'example.com' } });
    expect(edgeVerificationOf(okta() as never, []).maxLifetimeSeconds).toBe(90 * 60);
    refused([self, okta({ maxLifetimeMinutes: 2 })], /maxLifetimeMinutes is a whole number of minutes from 5 to 1440/);
    refused([self, federated(undefined, { requiredClaims: { hd: 'x' } })], /requiredClaims belong to a directly verified/);
  });
});

describe('a translation is per issuer, and names only AgentEchelon groups', () => {
  it('refuses a target that is not an AgentEchelon group', () => {
    refused([self, okta({}, { groups: { map: { Ops: 'operators' } } })], /maps to "operators", which is not an AgentEchelon group/);
    expect(errorsOf([self, okta({}, { groups: { map: { Ops: 'team-ops' } } })])).toEqual([]);
  });

  it('keeps groups: true for a pool\'s own groups, and a translation for every other kind that carries groups', () => {
    refused([self, okta({}, { groups: true })], /groups: true is a cognito-pool's own groups/);
    refused([{ ...self, clearance: { groups: { map: { a: 'standard' } }, classifications: ALL } }], /declares groups: true/);
  });

  it('refuses a mapping on a groups claim: groups are translated, one way (tenet D9)', () => {
    refused([self, entra({ clearance: { mapping: { claim: 'groups', values: { x: 'standard' } }, classifications: ['standard'] } })], /a mapping reads "groups", a groups claim/);
    expect(errorsOf([self, entra({ clearance: { mapping: { claim: 'roles', values: { 'AE.Standard': 'standard' } }, classifications: ['standard'] } })])).toEqual([]);
  });

  it('refuses a federated translation unless the provider sends the attribute empty, and reads it from the ID token alone', () => {
    refused([self, federated({ map: { a: 'standard' } })], /declares emptyGroupsSent: true/);
    refused([self, federated(undefined, { tokenUse: 'access' })], /carries on the ID token only/);
    refused([self, okta({}, { groups: { map: { a: 'standard' }, emptyGroupsSent: true } })], /emptyGroupsSent belongs to a cognito-federated translation/);
    expect(errorsOf([self, federated()])).toEqual([]);
    expect(runtimeOf(federated()).groupsClaim).toBe('custom:groups');
  });

  it('keeps adminGroups for a pool\'s own groups', () => {
    refused([self, okta({ adminGroups: ['AE-Admins'] })], /adminGroups names which of a pool's own groups mark an admin/);
  });
});

describe('every decision reads the translated groups', () => {
  const issuer = () => runtimeOf(okta());

  it('drops a provider group the map does not name, and never splits a value', () => {
    expect(groupsOf(issuer(), { groups: ['AE Standard', 'Unmapped'] })).toEqual(['standard']);
    // "Not admins" is one group, unmapped: it does not become the AgentEchelon group admins.
    expect(groupsOf(issuer(), { groups: 'Not admins' })).toEqual([]);
    expect(groupsOf(issuer(), { groups: ['admins'] })).toEqual([]);
  });

  it('gives an outside administrator\'s raw admins and team groups no console role', () => {
    const groups = groupsOf(issuer(), { groups: ['admins', 'team-members', 'team-x'] });
    expect(groups).toEqual([]);
    expect(consoleRoleFor(issuer(), groups)).toBeNull();
  });

  it('gives a mapped group its AgentEchelon meaning, within the entry\'s classifications', () => {
    expect(groupsOf(issuer(), { groups: ['AE-Admins'] })).toEqual(['admins']);
    expect(holderTokenOf(issuer(), { groups: ['AE Standard'] }, profiles)).toBe('standard');
    const narrowed = runtimeOf(okta({ admin: false }, { classifications: ['basic', 'standard'] }));
    expect(holderTokenOf(narrowed, { groups: ['AE-Admins'] }, profiles)).toBeUndefined();
  });

  it('reads nothing from an Entra token that carries the overage marker in place of its groups', () => {
    const e = runtimeOf(entra());
    expect(groupsOf(e, { groups: ['aaaaaaaa-0000-4000-8000-000000000001'] })).toEqual(['standard']);
    expect(groupsOf(e, { hasgroups: true })).toEqual([]);
    expect(groupsOf(e, { _claim_names: { groups: 'src1' }, groups: ['aaaaaaaa-0000-4000-8000-000000000001'] })).toEqual([]);
  });
});

describe('a federated person\'s custom:groups', () => {
  const issuer = () => runtimeOf(federated({ map: { 'AE Standard': 'standard', 'R&D, Lab': 'standard' }, emptyGroupsSent: true }));
  const signedInThroughTheProvider = { token_use: 'id', identities: [{ providerName: 'CorpSAML' }] };

  it('decodes Cognito\'s flattened form, keeping a space or a comma inside a group', () => {
    expect(decodeFlattenedAttribute('[AE%20Standard,R%26D%2C%20Lab]')).toEqual(['AE Standard', 'R&D, Lab']);
    expect(decodeFlattenedAttribute('AE+Standard')).toEqual(['AE Standard']);
    expect(decodeFlattenedAttribute('[%E0%A4%A]')).toEqual([]);
  });

  it('is read only from an ID token of the provider\'s own sign-in', () => {
    expect(groupsOf(issuer(), { ...signedInThroughTheProvider, 'custom:groups': '[AE%20Standard]' })).toEqual(['standard']);
    expect(groupsOf(issuer(), { token_use: 'access', identities: [{ providerName: 'CorpSAML' }], 'custom:groups': '[AE%20Standard]' })).toEqual([]);
    expect(groupsOf(issuer(), { token_use: 'id', 'custom:groups': '[AE%20Standard]' })).toEqual([]);
    expect(groupsOf(issuer(), { token_use: 'id', identities: [{ providerName: 'Other' }], 'custom:groups': '[AE%20Standard]' })).toEqual([]);
  });
});
