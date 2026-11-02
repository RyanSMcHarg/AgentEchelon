/**
 * AN INVITATION-LINK ISSUER IS DECLARED WITH ITS CONTROLS, AND REFUSED WITHOUT THEM (M-10, L16, Q5, A6).
 *
 * The `invitation-link` kind (`lib/config/issuers.ts`) is the platform's own issuer for a person who redeems a
 * `link` invitation with no sign-in. Each refusal here is one a deployment hits at synth:
 *
 *  - its clearance is the `fixed` set of conversation classifications a link session may be vended at, under
 *    its classifications, and no other source; never a visitor's classification, never the admin plane;
 *  - it declares nothing about a token (no pool, issuer, discovery, audience, subject, algorithm, origins) and
 *    no directory, provisioning or lifecycle of its own; never `admin: true`;
 *  - its `invitationLink` block knows its settings and refuses any other, so no bypass can be named; the
 *    session lasts 15 minutes and no more; production refuses the captcha vendor's test keys, a missing
 *    secret and a limit of 0;
 *  - one per deployment; and a conversation type that declares `link` shares a classification with it;
 *  - the edge authorizer skips it: there is no token of its to verify.
 */
import { invitationLinkSettingsOf, issuerErrors, issuerRegistry, LINK_SESSION_MAX_MINUTES, NOT_BUILT_KINDS } from '../lib/config/issuers';
import { edgeIssuers, edgeVerificationErrors } from '../lib/config/edge-verification';
import { invitationPolicyOf } from '../lib/config/conversation-types';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const self = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true };
const link = (extra: Record<string, unknown> = {}) => ({ id: 'invitation', kind: 'invitation-link', clearance: { fixed: ['basic', 'standard'], classifications: ['basic', 'standard'] }, ...extra });
const errorsOf = (list: unknown[], environment = 'dev') => issuerErrors(list, profiles, { environment });
const refused = (list: unknown[], pattern: RegExp, environment = 'dev') => {
  const errors = errorsOf(list, environment);
  expect(errors.some((e) => pattern.test(e))).toBe(true);
};

describe('an invitation-link issuer', () => {
  it('is built: declared with its fixed set, it synthesizes, and the registry names it', () => {
    expect(NOT_BUILT_KINDS).toEqual({});
    expect(errorsOf([self, link()])).toEqual([]);
    expect(issuerRegistry([self, link()], profiles).invitationLink()?.id).toBe('invitation');
    expect(issuerRegistry([self], profiles).invitationLink()).toBeUndefined();
  });

  it('defaults to a 15 minute session and a per-address limit, with the vendor\'s test keys outside production', () => {
    const s = invitationLinkSettingsOf({});
    expect(s.sessionMinutes).toBe(LINK_SESSION_MAX_MINUTES);
    expect(LINK_SESSION_MAX_MINUTES).toBe(15);
    expect(s.perIpLimit).toEqual({ max: 10, windowMinutes: 60 });
    expect(s.captcha.testKeys).toBe(true);
  });

  it.each([
    ['a groups source', { clearance: { groups: true, classifications: ['basic'] } }, /clearance is the fixed set of classifications a link session may be vended at/],
    ['a mapping', { clearance: { mapping: { claim: 'x', values: { a: 'basic' } }, classifications: ['basic'] } }, /clearance is the fixed set/],
    ['oneChannel', { clearance: { oneChannel: 'basic', classifications: ['basic'] } }, /clearance is the fixed set/],
    ['a visitor\'s classification', { clearance: { fixed: ['guest'], classifications: ['guest'] } }, /a visitor's classification; only a guest issuer reaches it/],
    ['the admin plane', { clearance: { fixed: ['admin'], classifications: ['admin'] } }, /not a classification a conversation is held at/],
    ['a set outside its classifications', { clearance: { fixed: ['premium'], classifications: ['basic'] } }, /fixed names "premium", outside the issuer's classifications/],
    ['a pool', { pool: 'self' }, /declares no pool/],
    ['an issuer URL', { issuer: 'https://example.com' }, /declares no issuer/],
    ['an audience', { audience: 'x' }, /declares no audience/],
    ['origins', { allowedOrigins: ['https://example.com'] }, /declares no allowedOrigins/],
    ['provisioning', { provisioning: 'provisioned-only' }, /declares no provisioning/],
    ['a directory', { directory: 'claims' }, /directory is "none" or absent/],
    ['a lifecycle', { lifecycle: 'cloudtrail-cognito' }, /lifecycle is "none" or absent/],
    ['admin', { admin: true }, /a invitation-link issuer cannot declare admin: true/],
    ['a setting it does not know', { invitationLink: { bypass: true } }, /invitationLink.bypass is not an invitation-link setting/],
    ['a longer session', { invitationLink: { sessionMinutes: 60 } }, /invitationLink.sessionMinutes is 15/],
    ['a malformed limit', { invitationLink: { perIpLimit: { max: 'many' } } }, /invitationLink.perIpLimit is \{ max, windowMinutes \}/],
    ['another captcha vendor', { invitationLink: { captcha: { vendor: 'other' } } }, /invitationLink.captcha.vendor is "turnstile"/],
  ])('refuses %s', (_what, extra, pattern) => {
    refused([self, link(extra)], pattern);
  });

  it('refuses the vendor\'s test keys, a missing secret and a limit of 0 in production', () => {
    refused([self, link()], /a production invitation-link issuer declares invitationLink.captcha.siteKey/, 'production');
    refused([self, link({ invitationLink: { captcha: { vendor: 'turnstile', siteKey: '1x00000000000000000000AA', secretName: 's' } } })],
      /invitationLink.captcha.siteKey is one of the vendor's published test keys/, 'production');
    refused([self, link({ invitationLink: { captcha: { vendor: 'turnstile', siteKey: 'real-site-key' } } })], /names its captcha secret/, 'production');
    refused([self, link({ invitationLink: { perIpLimit: { max: 0, windowMinutes: 60 } } })], /perIpLimit.max is 0, which limits nothing/, 'production');
    expect(errorsOf([self, link({ invitationLink: { captcha: { vendor: 'turnstile', siteKey: 'real-site-key', secretName: 'link/captcha' } } })], 'production')).toEqual([]);
  });

  it('refuses invitationLink settings on any other kind', () => {
    refused([{ ...self, invitationLink: {} }], /invitationLink settings belong to an invitation-link entry/);
  });

  it('refuses two of them', () => {
    refused([self, link(), link({ id: 'invitation-two' })], /are both invitation-link issuers; a deployment declares one/);
  });

  it('refuses a set no type that declares link could ever be redeemed at', () => {
    // The shipped ordinary type declares link at basic and standard; a link issuer for premium alone shares neither.
    expect(invitationPolicyOf('general')).toMatchObject({ modes: ['sign-in', 'link'], linkClassifications: ['basic', 'standard'] });
    refused([self, link({ clearance: { fixed: ['premium'], classifications: ['premium'] } })], /conversation type "general" declares link invitations up to basic, standard, none of which this issuer declares/);
    expect(errorsOf([self, link({ clearance: { fixed: ['basic'], classifications: ['basic'] } })])).toEqual([]);
  });

  it('is skipped by the edge authorizer, which has no token of its to verify', () => {
    const registry = issuerRegistry([self, link()], profiles);
    expect(edgeVerificationErrors(registry, ['client'], { deploymentId: 'test' })).toEqual([]);
    expect(edgeIssuers(registry, 'us-east-1_Self', 'us-east-1', ['client'], { deploymentId: 'test' }).map((e) => e.id)).toEqual(['deployment']);
  });
});

describe('a type\'s invitations', () => {
  it('are declared on the ordinary type, and on no type whose people come from a membership source', () => {
    expect(invitationPolicyOf('general')).toEqual({ modes: ['sign-in', 'link'], default: 'sign-in', linkClassifications: ['basic', 'standard'], expiresInDays: 7 });
    expect(invitationPolicyOf('ops')).toBeNull();
    expect(invitationPolicyOf('ops-team')).toBeNull();
    expect(invitationPolicyOf('guest-visitor')).toBeNull();
    expect(invitationPolicyOf('customer-engagement')).toBeNull();
    expect(invitationPolicyOf('no-such-type')).toBeNull();
  });
});
