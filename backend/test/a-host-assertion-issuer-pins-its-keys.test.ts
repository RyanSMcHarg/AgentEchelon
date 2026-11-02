/**
 * A HOST-ASSERTION ISSUER IS DECLARED WITH ITS PINNED KEYS, AND IS PROVISIONED-ONLY (A9, V7, P-13).
 *
 * The registry entry for a host application that signs its own users' assertions (a Salesforce org) is
 * validated at synth: its exact issuer, one or two pinned public keys of the declared algorithm's type, a
 * lifetime of at most ten minutes, the host origins that embed the widget, and a clearance that is a
 * declared mapping or a fixed set within its declared classifications. It names no pool, discovery document or audience of
 * its own (the audience is the deployment id), it is never an admin, and it is `provisioned-only`
 * whatever it says. Then its runtime form: `iss` exact, the subject `org` + `sub`, `provisioned-only`
 * carried to every function, and the pinned keys carried to the edge alone.
 */
import { generateKeyPairSync } from 'crypto';
import {
  compactIssuers,
  defaultSubject,
  expandIssuer,
  issuerErrors,
  issuerForClaims,
  issuerRegistry,
  isProvisionedOnly,
  NOT_BUILT_KINDS,
  runtimeIssuers,
  subjectOf,
} from '../lib/config/issuers';
import { edgeIssuers } from '../lib/config/edge-verification';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

const spki = (type: 'rsa' | 'ec', bits = 2048) => (type === 'rsa'
  ? generateKeyPairSync('rsa', { modulusLength: bits }).publicKey
  : generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey).export({ format: 'der', type: 'spki' }).toString('base64');
const RSA = spki('rsa');
const RSA_2 = spki('rsa');
const EC = spki('ec');
const self = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true };
const host = (over: Record<string, unknown> = {}) => ({
  id: 'salesforce-org', kind: 'host-assertion', issuer: 'https://example.my.salesforce.com', allowedOrigins: ['https://example.lightning.force.com'],
  hostAssertion: { publicKeys: { k1: RSA } }, clearance: { mapping: { claim: 'permsets', values: { AE_Sales: 'standard' } }, classifications: ['basic', 'standard'] },
  ...over,
});
const errorsOf = (entry: Record<string, unknown>) => issuerErrors([self, entry], profiles);
const refusedWith = (entry: Record<string, unknown>, pattern: RegExp) => {
  const errors = errorsOf(entry);
  expect(errors.filter((e) => pattern.test(e))).not.toEqual([]);
};

describe('a host-assertion entry', () => {
  it('is built: no NOT BUILT refusal remains for the kind', () => {
    expect(NOT_BUILT_KINDS['host-assertion']).toBeUndefined();
    expect(errorsOf(host())).toEqual([]);
    expect(errorsOf(host({ hostAssertion: { publicKeys: { k1: RSA, k2: RSA_2 }, maxMinutes: 10 } }))).toEqual([]);
    expect(errorsOf(host({ algorithm: 'ES256', hostAssertion: { publicKeys: { e1: EC } } }))).toEqual([]);
    expect(errorsOf(host({ clearance: { fixed: ['basic'], classifications: ['basic'] }, provisioning: 'provisioned-only' }))).toEqual([]);
  });

  it.each([
    ['no issuer', { issuer: undefined }, /names the exact issuer its assertions carry/],
    ['an issuer that is not a URL or a urn', { issuer: 'salesforce' }, /names the exact issuer its assertions carry/],
    ['no hostAssertion block', { hostAssertion: undefined }, /declares hostAssertion: \{ publicKeys/],
    ['no pinned key', { hostAssertion: { publicKeys: {} } }, /pins at least one key/],
    ['three pinned keys', { hostAssertion: { publicKeys: { a: RSA, b: RSA_2, c: spki('rsa') } } }, /pins at most two keys/],
    ['a key that is not one', { hostAssertion: { publicKeys: { k1: 'bm90IGEga2V5' } } }, /is not a public key/],
    ['a value that is not base64', { hostAssertion: { publicKeys: { k1: '-----BEGIN PUBLIC KEY-----' } } }, /is not base64 DER/],
    ['an RSA key shorter than 2048 bits', { hostAssertion: { publicKeys: { k1: spki('rsa', 1024) } } }, /shorter than 2048 bits/],
    ['an EC key for RS256', { hostAssertion: { publicKeys: { k1: EC } } }, /RS256 verifies with an RSA key/],
    ['an RSA key for ES256', { algorithm: 'ES256' }, /is not a P-256 key/],
    ['a key id that is not one', { hostAssertion: { publicKeys: { 'k 1': RSA } } }, /which is not a key id/],
    ['a lifetime past ten minutes', { hostAssertion: { publicKeys: { k1: RSA }, maxMinutes: 30 } }, /maxMinutes is a whole number of minutes from 1 to 10/],
    ['a setting the block does not know', { hostAssertion: { publicKeys: { k1: RSA }, skipJti: true } }, /hostAssertion.skipJti is not a host-assertion setting/],
    ['an audience of its own', { audience: 'x' }, /declares no audience/],
    ['a discovery document', { discoveryUrl: 'https://example.com/.well-known/openid-configuration' }, /declares no discoveryUrl/],
    ['a pool', { pool: 'us-east-1_X' }, /declares no pool/],
    ['no allowed origins', { allowedOrigins: undefined }, /lists allowedOrigins/],
    ['provisioning on first sign-in', { provisioning: 'on-first-sign-in' }, /is provisioned-only/],
    ['an ID token', { tokenUse: 'id' }, /tokenUse is "access" or absent/],
    ['the one-conversation session', { clearance: { oneChannel: 'basic', classifications: ['basic'] } }, /a mapping \(its permission-set claim\) or a fixed set/],
    ['admin: true', { admin: true }, /cannot declare admin: true/],
    ['a mapping outside its classifications', { clearance: { mapping: { claim: 'permsets', values: { X: 'premium' } }, classifications: ['basic', 'standard'] } }, /outside the issuer's classifications/],
  ])('refuses %s', (_label, over, pattern) => {
    refusedWith(host(over), pattern);
  });

  it('refuses hostAssertion settings on any other kind', () => {
    const oidc = { id: 'partner', kind: 'oidc', issuer: 'https://idp.example', discoveryUrl: 'https://idp.example/.well-known/openid-configuration', audience: 'ae', clearance: { fixed: ['basic'], classifications: ['basic'] } };
    refusedWith({ ...oidc, hostAssertion: { publicKeys: { k1: RSA } } }, /hostAssertion settings belong to a host-assertion entry/);
  });
});

describe('its runtime form', () => {
  const registry = issuerRegistry([self, host()], profiles);
  const runtime = runtimeIssuers(registry, 'us-east-1_Self', 'us-east-1', 'test-instance');
  const entry = runtime.find((t) => t.id === 'salesforce-org')!;

  it('matches its exact issuer, names its person by org and user, and is provisioned-only', () => {
    expect(defaultSubject('host-assertion')).toEqual(['org', 'sub']);
    expect(entry).toMatchObject({ iss: 'https://example.my.salesforce.com', subject: ['org', 'sub'], provisioning: 'provisioned-only', admin: false });
    expect(isProvisionedOnly(entry)).toBe(true);
    expect(issuerForClaims(runtime, { iss: 'https://example.my.salesforce.com' })?.id).toBe('salesforce-org');
    expect(issuerForClaims(runtime, { iss: 'https://example.my.salesforce.com/' })).toBeNull();
    expect(subjectOf(entry, { org: '00D1', sub: '0051' })).toBe('00D1:0051');
    expect(subjectOf(entry, { sub: '0051' })).toBeNull();
    expect(registry.hostAssertions().map((e) => e.id)).toEqual(['salesforce-org']);
    expect(registry.provisionedOnly().map((e) => e.id)).toEqual(['salesforce-org']);
  });

  it('carries provisioned-only through the travelling form, and the pinned keys to no function but the edge', () => {
    const compact = compactIssuers(runtime);
    expect(JSON.stringify(compact)).not.toContain(RSA);
    expect(expandIssuer(compact.find((c) => c.id === 'salesforce-org'))).toMatchObject({ provisioning: 'provisioned-only', subject: ['org', 'sub'] });
    const edge = edgeIssuers(registry, 'us-east-1_Self', 'us-east-1', ['self-client'], { deploymentId: 'test-instance' });
    expect(edge.find((e) => e.id === 'salesforce-org')!.verify).toEqual({
      audience: ['test-instance'], tokenUse: 'access', algorithm: 'RS256', pinnedKeys: { k1: RSA }, maxLifetimeSeconds: 300, singleUse: true,
    });
  });

  it('is refused at the edge without the deployment id its assertions are issued to', () => {
    expect(() => edgeIssuers(registry, 'us-east-1_Self', 'us-east-1', ['self-client'], {})).toThrow(/needs this deployment's id, the audience a host assertion carries/);
  });
});
