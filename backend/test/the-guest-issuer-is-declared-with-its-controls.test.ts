/**
 * THE GUEST ISSUER IS DECLARED WITH ITS CONTROLS, AND PRODUCTION REFUSES EVERY WAY AROUND THEM (A7, L16).
 *
 * A registry entry of kind `guest` is the platform's own issuer for an anonymous visitor. Its reach is
 * fixed at one visitor classification (an outside one the guest-visitor type permits) and bound to it; nothing else reaches that classification; it is
 * never an admin; and its `guest` block declares the abuse controls guest start runs, with defaults.
 * Synth refuses, in production: the captcha vendor's test keys, a missing captcha secret, any setting the
 * block does not know (there is no bypass), and a per-address limit of 0.
 */
import {
  GUEST_TOKEN_MAX_MINUTES,
  NOT_BUILT_KINDS,
  TURNSTILE_TEST_SITE_KEYS,
  guestIssuerUri,
  guestSettingsOf,
  issuerErrors,
  issuerForClaims,
  issuerRegistry,
  runtimeIssuers,
} from '../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const self = (extra: Record<string, unknown> = {}) => ({ id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true, ...extra });
const guest = (extra: Record<string, unknown> = {}) => ({ id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, ...extra });
const PROD_CAPTCHA = { vendor: 'turnstile', siteKey: '0x4AAAAAAAexample', secretName: 'ae/turnstile' };
const errorsOf = (list: unknown[], environment = 'dev', capabilities: string[] = []) => issuerErrors(list, profiles, { environment, capabilities });
const refused = (list: unknown[], pattern: RegExp, environment = 'dev') => {
  const errors = errorsOf(list, environment);
  expect({ errors, matched: errors.some((e) => pattern.test(e)) }).toMatchObject({ matched: true });
};

describe('a guest entry', () => {
  it('is built: the registry no longer refuses the kind', () => {
    expect(NOT_BUILT_KINDS.guest).toBeUndefined();
    expect(errorsOf([self(), guest()])).toEqual([]);
    expect(errorsOf([guest()])).toEqual([]);
  });

  it('has every control by default: one key generation, minutes-long tokens, a per-address limit, the test keys outside production', () => {
    expect(guestSettingsOf(guest() as never)).toEqual({
      signingKeys: ['g1'],
      tokenMinutes: 10,
      refreshMinutes: 60,
      perIpLimit: { max: 5, windowMinutes: 60 },
      captcha: { vendor: 'turnstile', siteKey: TURNSTILE_TEST_SITE_KEYS[0], testKeys: true },
      noticeVersion: 'sample-1',
      // A registration's sign-in link is sent straight through unless approval is declared.
      registrationApproval: 'none',
    });
    expect(guestSettingsOf(guest({ guest: { captcha: PROD_CAPTCHA } }) as never).captcha).toEqual({ ...PROD_CAPTCHA, testKeys: false });
  });

  it('is fixed at one visitor classification and bound to it', () => {
    refused([self(), guest({ clearance: { fixed: ['basic'], classifications: ['basic'] } })], /fixed at one visitor classification/);
    refused([self(), guest({ clearance: { fixed: ['guest'], classifications: ['guest', 'basic'] } })], /fixed at one visitor classification/);
    refused([self(), guest({ clearance: { oneChannel: 'guest', classifications: ['guest'] } })], /fixed at one visitor classification/);
    refused([self(), guest({ clearance: { mapping: { claim: 'x', values: { a: 'guest' } }, classifications: ['guest'] } })], /fixed at one visitor classification/);
  });

  it('is the only issuer that reaches a visitor classification; the customer, another outside one, is reached by a signed-in issuer', () => {
    refused([self({ clearance: { groups: true, classifications: [...ALL, 'guest'] } })], /classifications name "guest", a visitor's classification/);
    refused([self(), { id: 'partner', kind: 'oidc', issuer: 'https://idp.example.com', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration', audience: 'a', clearance: { fixed: ['guest'], classifications: ['guest'] } }],
      /a visitor's classification; only a guest issuer reaches it/);
  });

  it('is never an admin, and declares one per deployment', () => {
    refused([self(), guest({ admin: true })], /a guest issuer cannot declare admin: true/);
    refused([self(), guest(), guest({ id: 'guest-two' })], /are both guest issuers/);
  });

  it('declares none of a federated issuer\'s fields: the platform signs its tokens itself', () => {
    for (const field of ['pool', 'issuer', 'discoveryUrl', 'audience', 'subject', 'tenants']) {
      refused([self(), guest({ [field]: field === 'subject' ? ['sub'] : 'x' })], new RegExp(`a guest entry declares no ${field}`));
    }
    refused([self(), guest({ algorithm: 'RS256' })], /signs with ES256/);
    refused([self(), guest({ directory: 'cognito' })], /a guest has no directory/);
  });

  it('refuses a setting its block does not know, in every environment: there is no bypass to declare', () => {
    refused([self(), guest({ guest: { bypassToken: 'let-me-in' } })], /guest.bypassToken is not a guest setting.*There is no bypass/);
    refused([self(), guest({ guest: { captcha: { vendor: 'turnstile', skip: true } } })], /guest.captcha.skip is not a captcha setting/);
    refused([self(), guest({ guest: { captcha: { vendor: 'none' } } })], /captcha.vendor is "turnstile"/);
    refused([self(), guest({ guest: { perIpLimit: { max: 5, windowMinutes: 60, exempt: ['10.0.0.0/8'] } } })], /perIpLimit is \{ max, windowMinutes \}/);
  });

  it('bounds its token lifetimes and its key generations', () => {
    refused([self(), guest({ guest: { tokenMinutes: GUEST_TOKEN_MAX_MINUTES + 1 } })], /tokenMinutes is a whole number of minutes/);
    refused([self(), guest({ guest: { refreshMinutes: 0 } })], /refreshMinutes is a whole number/);
    refused([self(), guest({ guest: { signingKeys: ['g1', 'g2', 'g3'] } })], /at most two generations/);
    refused([self(), guest({ guest: { signingKeys: ['key-one'] } })], /lists key generations/);
    expect(errorsOf([self(), guest({ guest: { signingKeys: ['g1', 'g2'] } })])).toEqual([]);
  });

  it('may declare guest settings only on a guest entry', () => {
    refused([self({ guest: { tokenMinutes: 5 } })], /guest settings belong to a guest entry/);
  });
});

describe('production refuses every way around the controls', () => {
  it('refuses the captcha vendor\'s test keys, and a missing secret', () => {
    refused([self(), guest()], /a production guest issuer declares guest.captcha.siteKey/, 'production');
    refused([self(), guest()], /names its captcha secret/, 'production');
    for (const siteKey of TURNSTILE_TEST_SITE_KEYS) {
      refused([self(), guest({ guest: { captcha: { ...PROD_CAPTCHA, siteKey } } })], /published test keys, which production refuses/, 'production');
    }
    refused([self(), guest({ guest: { captcha: { ...PROD_CAPTCHA, secretName: '1x0000000000000000000000000000000AA' } } })], /named by a test key's value/, 'production');
  });

  it('refuses a per-address limit of 0 in production, and allows it outside', () => {
    const zero = guest({ guest: { captcha: PROD_CAPTCHA, perIpLimit: { max: 0, windowMinutes: 60 } } });
    refused([self(), zero], /perIpLimit.max is 0, which limits nothing/, 'production');
    expect(errorsOf([self(), zero], 'dev')).toEqual([]);
  });

  it('accepts a production guest issuer with a real site key and a named secret', () => {
    expect(errorsOf([self(), guest({ guest: { captcha: PROD_CAPTCHA } })], 'production')).toEqual([]);
    expect(errorsOf([self(), guest({ guest: { captcha: { vendor: 'turnstile', siteKey: '0x4AAAAAAAexample', secretParameter: '/ae/turnstile-secret' } } })], 'production')).toEqual([]);
  });
});

describe('the guest at runtime', () => {
  const registry = issuerRegistry([self(), guest()], profiles);
  it('carries this deployment\'s guest issuer URI as its `iss`, and a token naming it resolves to the entry', () => {
    const runtime = runtimeIssuers(registry, 'us-east-1_Self', 'us-east-1', 'acme');
    const g = runtime.find((t) => t.kind === 'guest')!;
    expect(g.iss).toBe(guestIssuerUri('acme', 'guest'));
    expect(g.iss).toBe('urn:agentechelon:acme:issuer:guest');
    expect(issuerForClaims(runtime, { iss: g.iss, sub: 's' })?.id).toBe('guest');
    expect(issuerForClaims(runtime, { iss: guestIssuerUri('other', 'guest'), sub: 's' })).toBeNull();
    expect(registry.guest()?.id).toBe('guest');
    expect(issuerRegistry([self()], profiles).guest()).toBeUndefined();
  });
});
