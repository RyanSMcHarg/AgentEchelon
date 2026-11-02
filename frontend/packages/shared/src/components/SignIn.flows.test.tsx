// @vitest-environment jsdom

/**
 * SIGN-IN, ONE FLOW PER TEST, THROUGH THE SCREEN A PERSON USES.
 *
 * The password flow stays exactly as it was, and the redirect flow (authorization code with PKCE) sits
 * beside it for the two redirect kinds the registry declares: a provider on this deployment's own pool,
 * reached through Cognito managed login, and a foreign OpenID Connect issuer. Each ends the same way:
 * the ID token goes to the credential exchange, which says who the person is.
 *
 * The callback is driven the way a browser drives it: the screen sends the tab away, the test reads the
 * URL it was sent to, then mounts the app again at `/callback` with the code and the state the issuer
 * would return.
 */
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import i18n from '../i18n';

const { send, InitiateAuthCommand, RevokeTokenCommand, RespondToAuthChallengeCommand } = vi.hoisted(() => ({
  send: vi.fn(),
  InitiateAuthCommand: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; } },
  RevokeTokenCommand: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; } },
  RespondToAuthChallengeCommand: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; } },
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class { send = send; },
  InitiateAuthCommand,
  SignUpCommand: class {},
  ConfirmSignUpCommand: class {},
  RespondToAuthChallengeCommand,
  ForgotPasswordCommand: class {},
  ConfirmForgotPasswordCommand: class {},
  ResendConfirmationCodeCommand: class {},
  GlobalSignOutCommand: class {},
  RevokeTokenCommand,
}));

vi.mock('../services/eventTrackingService', () => ({ setAuthToken: vi.fn(), trackEvent: vi.fn() }));

const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('../services/credentialExchange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/credentialExchange')>()),
  exchangeCredentials: exchange,
}));

// THE REGISTRY'S PUBLIC PROJECTION, as gen-frontend-env.mjs writes it into VITE_ISSUERS.
const { POOL_ISS, MANAGED_LOGIN, PARTNER_ISS } = vi.hoisted(() => ({
  POOL_ISS: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Pool',
  MANAGED_LOGIN: 'https://acme.auth.us-east-1.amazoncognito.com',
  PARTNER_ISS: 'https://id.partner.example',
}));
vi.mock('../platform/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/config')>()),
  USER_POOL_CLIENT_ID: 'own-client',
  // A provider on this pool is offered on the pool's federated client alone (FederatedWebClient).
  FEDERATED_CLIENT_ID: 'federated-client',
  SIGN_IN_ISSUERS_JSON: JSON.stringify([
    {
      id: 'corp-sso',
      kind: 'cognito-federated',
      providerName: 'CorpSAML',
      displayName: { en: 'Corp SSO', fr: 'SSO Entreprise' },
      discoveryUrl: `${POOL_ISS}/.well-known/openid-configuration`,
      issuer: POOL_ISS,
      admin: true,
    },
    {
      id: 'partner',
      kind: 'oidc',
      displayName: { en: 'Partner ID' },
      discoveryUrl: `${PARTNER_ISS}/.well-known/openid-configuration`,
      issuer: PARTNER_ISS,
      clientId: 'partner-client',
    },
  ]),
}));

import { AuthProvider, useAuth } from '../providers/AuthProvider';
import { LoginScreen } from './LoginScreen';
import { navigation, codeChallengeFor } from '../services/redirectSignIn';
import { endSessionEpoch } from '../services/sessionEpoch';
import { trackEvent } from '../services/eventTrackingService';

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const PERSON_ARN = `${INSTANCE}/user/0192f3a4-5b6c-7d8e-9f01-23456789abcd`;

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

/** The issuers' endpoints. Each test sets what the token endpoint answers. */
let tokenAnswer: (body: URLSearchParams, url: string) => Response;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url === `${POOL_ISS}/.well-known/openid-configuration`) {
    return Response.json({ issuer: POOL_ISS, authorization_endpoint: `${MANAGED_LOGIN}/oauth2/authorize`, token_endpoint: `${MANAGED_LOGIN}/oauth2/token` });
  }
  if (url === `${PARTNER_ISS}/.well-known/openid-configuration`) {
    return Response.json({
      issuer: PARTNER_ISS,
      authorization_endpoint: `${PARTNER_ISS}/authorize`,
      token_endpoint: `${PARTNER_ISS}/token`,
      scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
    });
  }
  if (url.endsWith('/token')) return tokenAnswer(new URLSearchParams(String(init?.body)), url);
  return new Response('not found', { status: 404 });
});

/** The app's gate, as chat and admin render it: the sign-in screen until the exchange adopts a session. */
function Gate() {
  const a = useAuth();
  if (a.isLoading) return <p>loading</p>;
  if (a.isAuthenticated) return <><p data-testid="signed-in">{a.user?.email}</p><button onClick={() => a.logout()}>sign out</button></>;
  return (
    <LoginScreen
      onLogin={a.login}
      mfaChallenge={a.mfaChallenge}
      onCompleteMfa={a.completeMfa}
      signInIssuers={a.signInIssuers}
      onSignInWithIssuer={a.signInWithIssuer}
      redirectError={a.redirectError}
      onDismissRedirectError={a.clearRedirectError}
    />
  );
}
const mount = () => render(<AuthProvider><Gate /></AuthProvider>);

let sentTo: URL | null = null;

/** Click an issuer's button and return the authorization URL the tab was sent to. */
async function startSignIn(name: RegExp): Promise<URL> {
  fireEvent.click(await screen.findByRole('button', { name }));
  await waitFor(() => expect(sentTo).not.toBeNull());
  return sentTo!;
}

/** The issuer sends the tab back: a fresh load of the app at /callback. */
async function returnToCallback(query: Record<string, string>) {
  cleanup();
  window.history.pushState(null, '', `/callback?${new URLSearchParams(query)}`);
  await act(async () => { mount(); });
}

beforeEach(async () => {
  send.mockReset();
  vi.mocked(trackEvent).mockClear();
  exchange.mockReset().mockResolvedValue({ credentials: {}, userArn: PERSON_ARN, tier: 'basic', consoleRole: null });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  sentTo = null;
  navigation.assign = (url: string) => { sentTo = new URL(url); };
  endSessionEpoch();
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState(null, '', '/');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage('en');
});

describe('the password flow', () => {
  it('signs in exactly as before, beside the providers', async () => {
    const idToken = jwt({ iss: POOL_ISS, aud: 'own-client', email: 'pat@example.com', exp: inAnHour() });
    send.mockResolvedValue({ AuthenticationResult: { AccessToken: 'access', IdToken: idToken, RefreshToken: 'refresh' } });
    mount();

    // The providers are offered as secondary buttons above the form; the form is unchanged.
    const provider = await screen.findByRole('button', { name: 'Continue with Corp SSO' });
    expect(provider.className).toContain('btn-secondary');
    fireEvent.change(screen.getByLabelText(i18n.t('auth.login.emailLabel')), { target: { value: 'pat@example.com' } });
    fireEvent.change(screen.getByLabelText(i18n.t('auth.login.passwordLabel')), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.login.signInButton') }));

    expect((await screen.findByTestId('signed-in')).textContent).toBe('pat@example.com');
    const cmd = send.mock.calls[0][0] as InstanceType<typeof InitiateAuthCommand>;
    expect(cmd.input).toEqual({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'own-client', AuthParameters: { USERNAME: 'pat@example.com', PASSWORD: 'pw' } });
    expect(exchange).toHaveBeenCalledWith({}, idToken);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('ae.signin.issuer')).toBeNull();
    expect(sessionStorage.getItem('refreshToken')).toBe('refresh');
  });
});

/** The sign-in funnel steps the flow recorded, in order. */
const funnelSteps = () => vi.mocked(trackEvent).mock.calls.map(([name]) => String(name)).filter((n) => n.startsWith('signin_'));

describe('the sign-in funnel the flow records', () => {
  it('records one success for a password sign-in, after the form view and the submit', async () => {
    const idToken = jwt({ iss: POOL_ISS, aud: 'own-client', email: 'pat@example.com', exp: inAnHour() });
    send.mockResolvedValue({ AuthenticationResult: { AccessToken: 'access', IdToken: idToken, RefreshToken: 'refresh' } });
    mount();
    fireEvent.change(await screen.findByLabelText(i18n.t('auth.login.emailLabel')), { target: { value: 'pat@example.com' } });
    fireEvent.change(screen.getByLabelText(i18n.t('auth.login.passwordLabel')), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.login.signInButton') }));
    await screen.findByTestId('signed-in');
    expect(funnelSteps()).toEqual(['signin_form_viewed', 'signin_submitted', 'signin_succeeded']);
  });

  it('records no success while an MFA challenge is open, and one when the code is accepted', async () => {
    const idToken = jwt({ iss: POOL_ISS, aud: 'own-client', email: 'pat@example.com', exp: inAnHour() });
    send.mockImplementation(async (cmd: unknown) => (cmd instanceof RespondToAuthChallengeCommand
      ? { AuthenticationResult: { AccessToken: 'access', IdToken: idToken, RefreshToken: 'refresh' } }
      : { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'challenge-session' }));
    mount();
    fireEvent.change(await screen.findByLabelText(i18n.t('auth.login.emailLabel')), { target: { value: 'pat@example.com' } });
    fireEvent.change(screen.getByLabelText(i18n.t('auth.login.passwordLabel')), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.login.signInButton') }));

    const code = await screen.findByLabelText(i18n.t('auth.mfa.codeLabel'));
    expect(funnelSteps()).not.toContain('signin_succeeded');

    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.mfa.verify') }));
    await screen.findByTestId('signed-in');
    expect(funnelSteps().filter((n) => n === 'signin_succeeded')).toHaveLength(1);
  });
});

describe('PKCE through Cognito managed login (a provider on this pool)', () => {
  it('sends the tab to managed login with the provider, then hands the ID token to the exchange', async () => {
    mount();
    const url = await startSignIn(/Continue with Corp SSO/);

    expect(url.origin + url.pathname).toBe(`${MANAGED_LOGIN}/oauth2/authorize`);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('federated-client');
    expect(q.get('identity_provider')).toBe('CorpSAML');
    expect(q.get('redirect_uri')).toBe(`${window.location.origin}/callback`);
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    // The verifier is held in this tab only, and the challenge is its S256 hash.
    const pending = JSON.parse(sessionStorage.getItem('ae.signin.pending')!);
    expect(q.get('code_challenge')).toBe(await codeChallengeFor(pending.verifier));
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('nonce')).toBe(pending.nonce);
    expect(localStorage.getItem('ae.signin.pending')).toBeNull();

    const idToken = jwt({ iss: POOL_ISS, aud: 'federated-client', nonce: pending.nonce, email: 'sam@corp.example', exp: inAnHour() });
    let tokenRequest: URLSearchParams | null = null;
    tokenAnswer = (body) => { tokenRequest = body; return Response.json({ id_token: idToken, access_token: 'access', refresh_token: 'refresh' }); };
    await returnToCallback({ code: 'the-code', state: pending.state });

    expect((await screen.findByTestId('signed-in')).textContent).toBe('sam@corp.example');
    expect(Object.fromEntries(tokenRequest!)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: `${window.location.origin}/callback`,
      client_id: 'federated-client',
      code_verifier: pending.verifier,
    });
    expect(exchange).toHaveBeenCalledWith({}, idToken);
    // The code and state leave the address bar, and the sign-in cannot be replayed.
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('ae.signin.pending')).toBeNull();
    expect(localStorage.getItem('ae.signin.issuer')).toBe('corp-sso');

    // SIGNING OUT REVOKES THE SESSION ON THE CLIENT THAT ISSUED IT. The federated client carries no scope
    // GlobalSignOut accepts, so its refresh token is revoked there instead, and ends every token it issued.
    send.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    const revoke = send.mock.calls.map(([cmd]) => cmd).find((cmd) => cmd instanceof RevokeTokenCommand);
    expect(revoke?.input).toEqual({ Token: 'refresh', ClientId: 'federated-client' });
  });
});

describe('PKCE at a foreign OIDC issuer', () => {
  it('signs in at the issuer, hands the ID token to the exchange, and refreshes there', async () => {
    mount();
    const url = await startSignIn(/Continue with Partner ID/);

    expect(url.origin + url.pathname).toBe(`${PARTNER_ISS}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('partner-client');
    expect(url.searchParams.get('identity_provider')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('openid email profile offline_access');
    const pending = JSON.parse(sessionStorage.getItem('ae.signin.pending')!);

    const idToken = jwt({ iss: PARTNER_ISS, aud: 'partner-client', nonce: pending.nonce, email: 'kim@partner.example', exp: inAnHour() });
    tokenAnswer = () => Response.json({ id_token: idToken, access_token: 'partner-access', refresh_token: 'partner-refresh' });
    const auth: { current: ReturnType<typeof useAuth> | null } = { current: null };
    const Probe = () => { auth.current = useAuth(); return null; };
    cleanup();
    window.history.pushState(null, '', `/callback?code=c&state=${pending.state}`);
    await act(async () => { render(<AuthProvider><Gate /><Probe /></AuthProvider>); });

    expect((await screen.findByTestId('signed-in')).textContent).toBe('kim@partner.example');
    expect(exchange).toHaveBeenCalledWith({}, idToken);

    // REFRESH PER ISSUER: at the issuer's own token endpoint, never through Cognito.
    const refreshed = jwt({ iss: PARTNER_ISS, aud: 'partner-client', email: 'kim@partner.example', exp: inAnHour() + 60 });
    let refreshRequest: URLSearchParams | null = null;
    tokenAnswer = (body) => { refreshRequest = body; return Response.json({ id_token: refreshed, access_token: 'a2' }); };
    await act(async () => { await auth.current!.refreshCredentials(); });
    expect(Object.fromEntries(refreshRequest!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'partner-refresh', client_id: 'partner-client' });
    expect(localStorage.getItem('idToken')).toBe(refreshed);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('a callback this tab did not start', () => {
  it('is refused on its state before any code is redeemed, with a way back', async () => {
    mount();
    await startSignIn(/Continue with Partner ID/);
    tokenAnswer = () => { throw new Error('a code must not be redeemed for a forged callback'); };

    await returnToCallback({ code: 'stolen-code', state: 'forged-state' });

    expect((await screen.findByRole('alert')).textContent).toContain(i18n.t('auth.redirect.errors.state-mismatch'));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/token'))).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('signed-in')).toBeNull();
    // The sign-in was spent by the refusal: the genuine callback cannot follow it.
    expect(sessionStorage.getItem('ae.signin.pending')).toBeNull();
    expect(window.location.search).toBe('');

    fireEvent.click(screen.getByRole('button', { name: i18n.t('auth.redirect.backToSignIn') }));
    expect(await screen.findByRole('button', { name: 'Continue with Partner ID' })).toBeTruthy();
  });

  it('refuses an ID token that does not carry the nonce this sign-in sent', async () => {
    mount();
    await startSignIn(/Continue with Partner ID/);
    const pending = JSON.parse(sessionStorage.getItem('ae.signin.pending')!);
    tokenAnswer = () => Response.json({
      id_token: jwt({ iss: PARTNER_ISS, aud: 'partner-client', nonce: 'another', exp: inAnHour() }),
      access_token: 'a',
    });
    await returnToCallback({ code: 'c', state: pending.state });
    expect((await screen.findByRole('alert')).textContent).toContain(i18n.t('auth.redirect.errors.nonce-mismatch'));
    expect(exchange).not.toHaveBeenCalled();
    expect(localStorage.getItem('idToken')).toBeNull();
  });
});

describe('a failed callback in a second locale', () => {
  it('says why in that locale, and offers the way back in it', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      auth: {
        login: { emailLabel: 'Adresse e-mail' },
        redirect: {
          continueWith: 'Continuer avec {{name}}',
          backToSignIn: 'Retour à la connexion',
          failedTitle: 'La connexion n\'a pas abouti',
          errors: { 'provider-refused': 'Le fournisseur de connexion de votre organisation a refusé la demande.' },
        },
      },
    }, true, true);
    await i18n.changeLanguage('fr');

    mount();
    // The issuer's own name in that locale, from the registry's displayName.
    const url = await startSignIn(/Continuer avec SSO Entreprise/);
    await returnToCallback({ error: 'access_denied', state: url.searchParams.get('state')! });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Le fournisseur de connexion de votre organisation a refusé la demande.');
    expect(alert.textContent).toContain('La connexion n\'a pas abouti');
    // The provider's own text is never what the person is shown.
    expect(alert.textContent).not.toContain('access_denied');
    fireEvent.click(screen.getByRole('button', { name: 'Retour à la connexion' }));
    expect(await screen.findByRole('button', { name: 'Continuer avec SSO Entreprise' })).toBeTruthy();
  });
});
