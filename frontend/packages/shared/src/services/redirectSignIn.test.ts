// @vitest-environment jsdom

/**
 * The redirect sign-in's own rules, each held where it is decided: which `VITE_ISSUERS` entries are
 * offered, which name a person sees, and each reason a callback is refused before a token is kept.
 * The flows end to end, through the sign-in screen, are `components/SignIn.flows.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSignInIssuers,
  issuerDisplayName,
  beginRedirectSignIn,
  completeRedirectSignIn,
  RedirectSignInError,
  type SignInIssuer,
} from './redirectSignIn';

const ISS = 'https://id.partner.example';
const partner: SignInIssuer = {
  id: 'partner',
  kind: 'oidc',
  displayName: { en: 'Partner ID', pt: 'ID do parceiro', 'pt-BR': 'ID do parceiro (Brasil)' },
  discoveryUrl: `${ISS}/.well-known/openid-configuration`,
  issuer: ISS,
  clientId: 'partner-client',
};

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
}

let discovery: Record<string, unknown>;
let token: Record<string, unknown>;
const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
  if (String(input).endsWith('openid-configuration')) return Response.json(discovery);
  return Response.json(token);
}) as unknown as typeof fetch;

let sent: URL;
const assign = (u: string) => { sent = new URL(u); };

async function begin(): Promise<{ state: string; nonce: string }> {
  await beginRedirectSignIn(partner, { fetchImpl, assign });
  return { state: sent.searchParams.get('state')!, nonce: sent.searchParams.get('nonce')! };
}
const callback = (q: Record<string, string>) => `${window.location.origin}/callback?${new URLSearchParams(q)}`;

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(RedirectSignInError);
  return (error as RedirectSignInError).code;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  discovery = { issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token` };
  vi.mocked(fetchImpl).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the issuers VITE_ISSUERS declares', () => {
  it('offers only redirect kinds with what their sign-in needs', () => {
    const list = parseSignInIssuers(JSON.stringify([
      partner,
      { ...partner, id: 'no-client', clientId: undefined },
      { ...partner, id: 'plain-http', discoveryUrl: 'http://id.partner.example/.well-known/openid-configuration' },
      { id: 'deployment', kind: 'cognito-pool', discoveryUrl: partner.discoveryUrl },
      { id: 'guest', kind: 'guest', discoveryUrl: partner.discoveryUrl },
      { id: 'corp', kind: 'cognito-federated', discoveryUrl: partner.discoveryUrl, displayName: { en: 'Corp' } },
      { id: 'corp-ok', kind: 'cognito-federated', providerName: 'Corp', discoveryUrl: partner.discoveryUrl, displayName: { en: 'Corp' } },
    ]));
    expect(list.map((i) => i.id)).toEqual(['partner', 'corp-ok']);
  });

  it('offers nothing for an unset or unreadable value', () => {
    expect(parseSignInIssuers(undefined)).toEqual([]);
    expect(parseSignInIssuers('')).toEqual([]);
    expect(parseSignInIssuers('{not json')).toEqual([]);
  });

  it('names an issuer in the locale, then its language, then English, then its id', () => {
    expect(issuerDisplayName(partner, 'pt-BR')).toBe('ID do parceiro (Brasil)');
    expect(issuerDisplayName(partner, 'pt-PT')).toBe('ID do parceiro');
    expect(issuerDisplayName(partner, 'de')).toBe('Partner ID');
    expect(issuerDisplayName({ ...partner, displayName: {} }, 'de')).toBe('partner');
  });
});

describe('starting a sign-in', () => {
  it('uses a fresh state, nonce and verifier each time', async () => {
    const a = await begin();
    const firstVerifier = JSON.parse(sessionStorage.getItem('ae.signin.pending')!).verifier;
    const b = await begin();
    const secondVerifier = JSON.parse(sessionStorage.getItem('ae.signin.pending')!).verifier;
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(firstVerifier).not.toBe(secondVerifier);
    expect(firstVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a discovery document that describes another issuer', async () => {
    discovery = { ...discovery, issuer: 'https://evil.example' };
    expect(await refusal(beginRedirectSignIn(partner, { fetchImpl, assign }))).toBe('undeclared-issuer');
    expect(sessionStorage.getItem('ae.signin.pending')).toBeNull();
  });

  it('reports an issuer it cannot reach as unavailable', async () => {
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await refusal(beginRedirectSignIn(partner, { fetchImpl: down, assign }))).toBe('unavailable');
  });
});

describe('finishing a sign-in', () => {
  it('refuses a callback with no sign-in in progress in this tab', async () => {
    expect(await refusal(completeRedirectSignIn(callback({ code: 'c', state: 's' }), [partner], { fetchImpl }))).toBe('no-pending-sign-in');
  });

  it('refuses a sign-in older than ten minutes', async () => {
    const { state } = await begin();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    expect(await refusal(completeRedirectSignIn(callback({ code: 'c', state }), [partner], { fetchImpl }))).toBe('expired');
  });

  it('refuses an issuer the build no longer declares', async () => {
    const { state } = await begin();
    expect(await refusal(completeRedirectSignIn(callback({ code: 'c', state }), [], { fetchImpl }))).toBe('undeclared-issuer');
  });

  it('refuses an ID token issued by someone else, or for another client', async () => {
    let p = await begin();
    token = { id_token: jwt({ iss: 'https://evil.example', aud: 'partner-client', nonce: p.nonce }), access_token: 'a' };
    expect(await refusal(completeRedirectSignIn(callback({ code: 'c', state: p.state }), [partner], { fetchImpl }))).toBe('token-mismatch');

    p = await begin();
    token = { id_token: jwt({ iss: ISS, aud: 'another-client', nonce: p.nonce }), access_token: 'a' };
    expect(await refusal(completeRedirectSignIn(callback({ code: 'c', state: p.state }), [partner], { fetchImpl }))).toBe('token-mismatch');
  });

  it('reports a token endpoint that refuses the code', async () => {
    const { state } = await begin();
    const refusing = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('openid-configuration')
      ? Response.json(discovery)
      : Response.json({ error: 'invalid_grant' }, { status: 400 }))) as unknown as typeof fetch;
    expect(await refusal(completeRedirectSignIn(callback({ code: 'c', state }), [partner], { fetchImpl: refusing }))).toBe('token-exchange-failed');
  });

  it('accepts an Entra token whose issuer is the tenant template, with the token tenant', async () => {
    const entra: SignInIssuer = { ...partner, id: 'entra', kind: 'oidc-entra', issuer: undefined };
    discovery = { ...discovery, issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' };
    const tid = '72f988bf-86f1-41af-91ab-2d7cd011db47';
    await beginRedirectSignIn(entra, { fetchImpl, assign });
    const state = sent.searchParams.get('state')!;
    const nonce = sent.searchParams.get('nonce')!;
    token = { id_token: jwt({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid, aud: 'partner-client', nonce }), access_token: 'a' };
    const tokens = await completeRedirectSignIn(callback({ code: 'c', state }), [entra], { fetchImpl });
    expect(tokens.issuerId).toBe('entra');
  });
});
