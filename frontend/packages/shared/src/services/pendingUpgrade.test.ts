// @vitest-environment jsdom
/**
 * A VISIT CARRIED INTO THE SIGN-IN THAT FOLLOWS IT, with nothing for the person to click (paths A and B).
 *
 *  - The visit leaves the address bar at once and is kept for this tab; it displaces a pending invitation,
 *    because the exchange refuses the two together.
 *  - PATH A arrives as a hand-off nonce; its secret is asked of the widget that opened the tab
 *    (`requestPendingBindSecret`) and kept with it. A link with no widget behind it (forwarded, copied, opened
 *    in another browser) gets no secret and is dropped before any exchange as `BIND_NOT_HANDED_OFF`, and so is
 *    a `#bindGuest=` link, which carried a refresh credential. The secret is asked of the declared widget
 *    origin alone and taken from nowhere else, so a page on another origin that opened the sign-in cannot
 *    hand the person its own visit (a login CSRF); with no widget origin declared nothing is asked.
 *  - PATH A rides on the first exchange as `bindGuest` (the nonce and the secret), with no confirmation in it. Bound: the continuation
 *    (`bound.conversationArn`) is recorded to open. `CONTINUATION_UNAVAILABLE`: the person is signed in as
 *    the account, the bind is kept, and "Try again" makes the same call, which opens it. Any other refusal:
 *    recorded, dropped, and the person signed in as themselves. An outage: thrown, with the bind kept, so
 *    the sign-in's retry makes the same call.
 *  - PATH B is redeemed once signed in. A refusal is recorded with its code and dropped; an outage keeps it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('./credentialExchange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentialExchange')>()),
  exchangeCredentials: exchange,
}));

import { BIND_REQUEST, BIND_SECRET, capturePendingUpgrade, discardPendingUpgrade, peekPendingUpgrade, requestPendingBindSecret, settlePendingUpgrade, takeUpgradeOutcome, type BindSecretChannel } from './pendingUpgrade';
import { capturePendingInvitation, takePendingInvitation } from './pendingInvitation';
import { resolvePersonIdentity } from './personIdentity';
import { ExchangeRefusedError } from './credentialExchange';
import { endSessionEpoch } from './sessionEpoch';

const REFRESH = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
const NONCE = 'NonceNonceNonce0123456789-_abcdefghijklmnop';
const SECRET = 'SecretSecretSecret0123456789-_abcdefghijklm';
const CLAIM = 'claimtoken0123456789abcdefghijklmnopqrstuvwxyz';
const ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const CONTINUATION = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/continued-1';
const answer = (extra: Record<string, unknown> = {}) => ({ credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }, userArn: ARN, ...extra });
const fragment = (hash: string) => ({ hash, pathname: '/', search: '' });
const bindBody = { bindGuest: { nonce: NONCE, secret: SECRET } };
/** The declared widget origin (`VITE_WIDGET_ORIGIN`), and a page on another one. */
const WIDGET = 'https://widget.example.com';
const ELSEWHERE = 'https://elsewhere.example.net';

/** The window that opened this tab, on `origin`: answers a request for the hand-off's secret, or (`answer: null`) never does. */
function widgetOpener(answer: { nonce?: string; secret?: string } | null = {}, origin = WIDGET) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const opener = {
    postMessage: vi.fn((msg: { type: string; nonce: string }) => {
      if (answer === null || msg.type !== BIND_REQUEST) return;
      const data = { type: BIND_SECRET, nonce: answer.nonce ?? msg.nonce, secret: answer.secret ?? SECRET };
      queueMicrotask(() => { for (const l of listeners) l({ source: opener, origin, data } as unknown as MessageEvent); });
    }),
  };
  const channel: BindSecretChannel = {
    opener: opener as unknown as Window,
    addEventListener: (_t, cb) => void listeners.add(cb),
    removeEventListener: (_t, cb) => void listeners.delete(cb),
  };
  return { opener, channel };
}

/** Arrive from the widget: the nonce in the fragment, the secret from the widget that opened the tab. */
async function arriveFromWidget() {
  capturePendingUpgrade(fragment(`#bindNonce=${NONCE}`));
  await requestPendingBindSecret(sessionStorage, widgetOpener().channel, 1000, WIDGET);
}

beforeEach(() => {
  sessionStorage.clear();
  exchange.mockReset();
  endSessionEpoch();
});

describe('capturing the visit', () => {
  it('takes a bind or a claim out of the fragment and the address bar, and keeps it for this tab', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(capturePendingUpgrade(fragment(`#bindNonce=${NONCE}`))).toBe(true);
    expect(replace).toHaveBeenCalledWith(null, '', '/');
    expect(peekPendingUpgrade()).toEqual({ kind: 'bind', token: NONCE });
    expect(capturePendingUpgrade(fragment(`#claim=${CLAIM}`))).toBe(true);
    expect(peekPendingUpgrade()).toEqual({ kind: 'claim', token: CLAIM });
  });

  it('keeps nothing that is not a token, and nothing from a page with no visit', () => {
    expect(capturePendingUpgrade(fragment('#bindNonce=%3Cscript%3E'))).toBe(false);
    expect(capturePendingUpgrade(fragment('#message=m1'))).toBe(false);
    expect(peekPendingUpgrade()).toBeNull();
  });

  it('displaces a pending invitation, and an invitation captured after it displaces the visit', () => {
    capturePendingInvitation(fragment(`#invitation=${CLAIM}`));
    capturePendingUpgrade(fragment(`#bindNonce=${NONCE}`));
    expect(takePendingInvitation()).toBeNull();
    capturePendingInvitation(fragment(`#invitation=${CLAIM}`));
    expect(peekPendingUpgrade()).toBeNull();
  });
});

describe('path A on the first exchange', () => {
  it('binds the first sign-in with nothing asked of the person, and records the continuation to open', async () => {
    await arriveFromWidget();
    exchange.mockResolvedValue(answer({ bound: { conversationArn: CONTINUATION } }));
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange).toHaveBeenCalledWith(bindBody, 'id-token');
    expect(takeUpgradeOutcome()).toEqual({ opened: CONTINUATION, path: 'bind' });
    expect(peekPendingUpgrade()).toBeNull();
  });

  it('signs the account in when the continuation could not be opened, and "Try again" makes the same call', async () => {
    await arriveFromWidget();
    exchange
      .mockRejectedValueOnce(new ExchangeRefusedError('retry the same call', 503, 'CONTINUATION_UNAVAILABLE'))
      .mockResolvedValueOnce(answer());
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange.mock.calls.map((c) => c[0])).toEqual([bindBody, {}]);
    expect(takeUpgradeOutcome()).toEqual({ pending: 'bind' });
    expect(peekPendingUpgrade()).toEqual({ kind: 'bind', token: NONCE, secret: SECRET });

    // Still not opened: still pending, still kept.
    exchange.mockRejectedValueOnce(new ExchangeRefusedError('retry the same call', 503, 'CONTINUATION_UNAVAILABLE'));
    await expect(settlePendingUpgrade('id-token')).resolves.toEqual({ pending: 'bind' });
    expect(peekPendingUpgrade()).not.toBeNull();

    // The same call, recognized as the bind that already happened, opens the continuation.
    exchange.mockResolvedValueOnce(answer({ bound: { conversationArn: CONTINUATION } }));
    await expect(settlePendingUpgrade('id-token')).resolves.toEqual({ opened: CONTINUATION, path: 'bind' });
    expect(exchange.mock.calls.at(-1)).toEqual([bindBody, 'id-token']);
    expect(peekPendingUpgrade()).toBeNull();
  });

  it.each(['SUBJECT_ALREADY_BOUND', 'GUEST_SESSION_NOT_LIVE', 'BIND_NOT_DECLARED'])('records %s, drops the visit and signs the person in as themselves', async (code) => {
    await arriveFromWidget();
    exchange.mockRejectedValueOnce(new ExchangeRefusedError('refused', code === 'GUEST_SESSION_NOT_LIVE' ? 401 : 409, code)).mockResolvedValue(answer());
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange.mock.calls.map((c) => c[0])).toEqual([bindBody, {}]);
    expect(takeUpgradeOutcome()).toEqual({ refused: code, path: 'bind' });
    expect(peekPendingUpgrade()).toBeNull();
  });

  it('does not swallow an outage, and keeps the visit for the retry', async () => {
    await arriveFromWidget();
    exchange.mockRejectedValue(new ExchangeRefusedError('down', 503, 'BIND_UNAVAILABLE'));
    await expect(resolvePersonIdentity('id-token')).rejects.toThrow('down');
    expect(peekPendingUpgrade()).toEqual({ kind: 'bind', token: NONCE, secret: SECRET });
  });

  it('is not presented once declined on the sign-in screen', async () => {
    await arriveFromWidget();
    discardPendingUpgrade();
    exchange.mockResolvedValue(answer());
    await resolvePersonIdentity('id-token');
    expect(exchange).toHaveBeenCalledWith({}, 'id-token');
  });
});

describe('a sign-in that did not start from the widget session that owns the visit', () => {
  it('asks the opener for the secret with the nonce alone, and keeps the answer for this tab', async () => {
    capturePendingUpgrade(fragment(`#bindNonce=${NONCE}`));
    const { opener, channel } = widgetOpener();
    await requestPendingBindSecret(sessionStorage, channel, 1000, WIDGET);
    expect(opener.postMessage).toHaveBeenCalledWith({ type: BIND_REQUEST, nonce: NONCE }, WIDGET);
    expect(peekPendingUpgrade()).toEqual({ kind: 'bind', token: NONCE, secret: SECRET });
  });

  it.each([
    ['a forwarded link, opened with no widget behind it', () => ({ opener: null, addEventListener: () => {}, removeEventListener: () => {} })],
    ['an opener that never answers', () => widgetOpener(null).channel],
    ['an answer for another hand-off', () => widgetOpener({ nonce: 'AnotherNonce0123456789-_abcdefghijklmnopqrs' }).channel],
    ['an answer from a page on another origin that opened the sign-in', () => widgetOpener({}, ELSEWHERE).channel],
  ])('%s: binds nothing, says so, and signs the person in as themselves', async (_why, channel) => {
    capturePendingUpgrade(fragment(`#bindNonce=${NONCE}`));
    await requestPendingBindSecret(sessionStorage, channel() as BindSecretChannel, 20, WIDGET);
    exchange.mockResolvedValue(answer());
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange.mock.calls.map((c) => c[0])).toEqual([{}]);
    expect(takeUpgradeOutcome()).toEqual({ refused: 'BIND_NOT_HANDED_OFF', path: 'bind' });
    expect(peekPendingUpgrade()).toBeNull();
  });

  it('asks nothing, and binds nothing, where the deployment declares no widget origin', async () => {
    capturePendingUpgrade(fragment(`#bindNonce=${NONCE}`));
    const { opener, channel } = widgetOpener();
    await requestPendingBindSecret(sessionStorage, channel, 20, '');
    expect(opener.postMessage).not.toHaveBeenCalled();
    exchange.mockResolvedValue(answer());
    await expect(resolvePersonIdentity('id-token')).resolves.toMatchObject({ userArn: ARN });
    expect(exchange.mock.calls.map((c) => c[0])).toEqual([{}]);
    expect(takeUpgradeOutcome()).toEqual({ refused: 'BIND_NOT_HANDED_OFF', path: 'bind' });
  });

  it('refuses a link that carries a refresh credential: out of the address bar, never kept or presented', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(capturePendingUpgrade(fragment(`#bindGuest=${REFRESH}`))).toBe(false);
    expect(replace).toHaveBeenCalledWith(null, '', '/');
    expect(peekPendingUpgrade()).toBeNull();
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(REFRESH);
    expect(takeUpgradeOutcome()).toEqual({ refused: 'BIND_NOT_HANDED_OFF', path: 'bind' });
  });
});

describe('path B once signed in', () => {
  beforeEach(() => vi.stubEnv('VITE_PERSON_API_URL', 'https://person.example.com'));
  afterEach(() => vi.unstubAllEnvs());
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('redeems the claim with the account\'s token and records its conversation to open', async () => {
    capturePendingUpgrade(fragment(`#claim=${CLAIM}`));
    const fetchImpl = respond(200, { conversationArn: CONTINUATION, type: 'customer-engagement' });
    await expect(settlePendingUpgrade('id-token', sessionStorage, fetchImpl)).resolves.toEqual({ opened: CONTINUATION, path: 'claim' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/upgrade\/claim$/);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer id-token' });
    expect(JSON.parse(String(init.body))).toEqual({ claimToken: CLAIM });
    expect(peekPendingUpgrade()).toBeNull();
  });

  it.each([[404, 'CLAIM_UNKNOWN'], [409, 'CLAIM_USED'], [410, 'CLAIM_EXPIRED'], [403, 'NOT_CLEARED_FOR_TARGET']])('records a %i %s and drops the claim', async (status, code) => {
    capturePendingUpgrade(fragment(`#claim=${CLAIM}`));
    await expect(settlePendingUpgrade('id-token', sessionStorage, respond(status, { code }))).resolves.toEqual({ refused: code, path: 'claim' });
    expect(peekPendingUpgrade()).toBeNull();
  });

  it('keeps the claim through an outage, so the same call can be made again', async () => {
    capturePendingUpgrade(fragment(`#claim=${CLAIM}`));
    await expect(settlePendingUpgrade('id-token', sessionStorage, respond(503, { code: 'CLAIM_UNAVAILABLE' }))).resolves.toEqual({ pending: 'claim' });
    await expect(settlePendingUpgrade('id-token', sessionStorage, vi.fn(async () => { throw new TypeError('offline'); }))).resolves.toEqual({ pending: 'claim' });
    expect(peekPendingUpgrade()).toEqual({ kind: 'claim', token: CLAIM });
  });
});
