/**
 * A VISIT CARRYING OVER INTO THE SIGN-IN THAT FOLLOWS IT (GUEST-ISSUER "Becoming a person").
 *
 * A visitor never opts in to keeping their visit: the visit arrives here in this page's URL fragment, which
 * no server receives, and the sign-in that follows carries it over with nothing else to click:
 *
 *  - `#bindNonce=<nonce>` for path A, from the widget's sign-in tab. The nonce is half of the visit's
 *    sign-in hand-off; the other half, its secret, is asked of the widget that opened this tab
 *    (`requestPendingBindSecret`: a `postMessage` to `window.opener`, answered only by the widget that minted
 *    the nonce, to the tab it opened, and taken here only from the declared widget origin,
 *    `declaredWidgetOrigin`). The person's first credential exchange presents both beside the new
 *    account's token (`bindGuest` on `POST /exchange-credentials`), the visitor's AppInstanceUser becomes the
 *    account, and the answer names the visit's continuation, which the app opens (`bound.conversationArn`).
 *    A link opened anywhere else (forwarded, copied into another tab or browser) has no widget behind it, so
 *    no secret arrives and nothing is bound (`BIND_NOT_HANDED_OFF`). A `#bindGuest=` link, which carried a
 *    refresh credential, is taken out of the address bar and refused the same way.
 *  - `#claim=<claim token>` for path B, from the sign-in link the registration emailed. Once the person is
 *    signed in, the app redeems it (`POST /upgrade/claim`) and opens the conversation the claim answers with.
 *
 * The app takes it out of the address bar at once (`capturePendingUpgrade`) and keeps it for this tab only
 * (`sessionStorage`), so it survives the sign-in redirect and nothing else. It stays pending until it is
 * decided: a refusal drops it, an outage keeps it so the same call is made again, and a continuation that
 * could not be opened keeps it so "Try again" makes the same call (the exchange recognizes the bind that
 * already happened and binds nothing twice).
 */
import { declaredWidgetOrigin, personUrl } from '../platform/config';
import { ExchangeRefusedError, exchangeCredentials, type ExchangeAnswer } from './credentialExchange';
import { discardPendingInvitation } from './pendingInvitation';

const PENDING = 'ae.pendingUpgrade';
const OUTCOME = 'ae.upgradeOutcome';

export type UpgradePath = 'bind' | 'claim';
export interface PendingUpgrade {
  kind: UpgradePath;
  /** A claim token, or a bind's hand-off nonce. */
  token: string;
  /** A bind's hand-off secret, once the widget that opened this tab has answered with it. */
  secret?: string;
}

/** The hand-off's two messages, as the widget names them (`frontend/packages/widget/src/session/upgrade.ts`). */
export const BIND_REQUEST = 'ae.bind.request';
export const BIND_SECRET = 'ae.bind.secret';
/** How long this tab waits for the widget's answer. It is a message between two open windows. */
export const BIND_SECRET_WAIT_MS = 5_000;
/** Why a bind was dropped here, before any exchange: no widget answered for the hand-off. */
export const NOT_HANDED_OFF = 'BIND_NOT_HANDED_OFF';

/** What keeping the visit came to, as the app shows it. */
export type UpgradeOutcome =
  | { opened: string; path: UpgradePath }
  | { pending: UpgradePath }
  | { refused: string; path: UpgradePath };

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): Store | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** Take a visit being kept out of the page's fragment, if it carries one. True when it did. */
export function capturePendingUpgrade(loc: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location, store: Store | null = session()): boolean {
  const params = new URLSearchParams(String(loc.hash || '').replace(/^#/, ''));
  const bind = params.get('bindNonce');
  const claim = params.get('claim');
  const forwardable = params.get('bindGuest');
  if (!bind && !claim && !forwardable) return false;
  // OUT OF THE ADDRESS BAR FIRST, so neither history nor a copied URL carries it.
  try {
    window.history.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch {
    /* a page with no history to rewrite still keeps the token out of storage beyond this tab */
  }
  // A REFRESH CREDENTIAL IN A LINK IS REFUSED, never presented: the exchange takes a hand-off alone.
  if (!bind && !claim) {
    if (store) recordUpgradeOutcome({ refused: NOT_HANDED_OFF, path: 'bind' }, store);
    return false;
  }
  const pending: PendingUpgrade = bind ? { kind: 'bind', token: bind } : { kind: 'claim', token: claim! };
  if (!TOKEN.test(pending.token) || !store) return false;
  store.setItem(PENDING, JSON.stringify(pending));
  store.removeItem(OUTCOME);
  // ONE AT A TIME: the exchange refuses a call that binds a visitor and redeems an invitation together.
  discardPendingInvitation(store);
  return true;
}

/** The visit waiting to be kept, without taking it. */
export function peekPendingUpgrade(store: Store | null = session()): PendingUpgrade | null {
  const raw = store?.getItem(PENDING);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingUpgrade;
    if (!(p?.kind === 'bind' || p?.kind === 'claim') || !TOKEN.test(String(p.token))) return null;
    return { kind: p.kind, token: p.token, ...(p.kind === 'bind' && typeof p.secret === 'string' && TOKEN.test(p.secret) ? { secret: p.secret } : {}) };
  } catch {
    return null;
  }
}

/** Drop the visit waiting to carry over, once it is decided. */
export function discardPendingUpgrade(store: Store | null = session()): void {
  store?.removeItem(PENDING);
}

export function recordUpgradeOutcome(outcome: UpgradeOutcome, store: Store | null = session()): void {
  store?.setItem(OUTCOME, JSON.stringify(outcome));
}

/** What keeping the visit came to, read once by the app that shows it. */
export function takeUpgradeOutcome(store: Store | null = session()): UpgradeOutcome | null {
  const raw = store?.getItem(OUTCOME);
  if (!raw) return null;
  store!.removeItem(OUTCOME);
  try {
    const o = JSON.parse(raw) as UpgradeOutcome;
    return o && typeof o === 'object' && ('opened' in o || 'pending' in o || 'refused' in o) ? o : null;
  } catch {
    return null;
  }
}

/** What the opener and the message channel look like here, for the tests. */
export interface BindSecretChannel {
  opener: Pick<Window, 'postMessage'> | null;
  addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
}

let secretArrival: Promise<void> | null = null;

/**
 * ASK THE WIDGET THAT OPENED THIS TAB FOR THE HAND-OFF'S SECRET, once, as the app loads. The request names
 * the nonce; only that widget holds its secret, and it answers only the tab it opened. The answer is kept
 * with the pending bind for this tab (it survives the sign-in redirect). No opener, or no answer in time,
 * leaves the bind without its secret, and the first exchange drops it (`presentPendingBind`).
 *
 * ONLY FROM THE DECLARED WIDGET ORIGIN (`widgetOrigin`, `VITE_WIDGET_ORIGIN`). A page on any other origin
 * can open this app with a nonce and a secret of its own visit; were its answer taken, the person signing
 * in would be bound to that page's visit (a login CSRF). So the request is posted only to that origin, an
 * answer from anywhere else is ignored, and with no widget origin declared no request is made at all.
 */
export function requestPendingBindSecret(
  store: Store | null = session(),
  channel: BindSecretChannel | null = typeof window === 'undefined' ? null : window,
  waitMs: number = BIND_SECRET_WAIT_MS,
  widgetOrigin: string = declaredWidgetOrigin(),
): Promise<void> {
  const pending = peekPendingUpgrade(store);
  if (pending?.kind !== 'bind' || pending.secret || !channel) return Promise.resolve();
  const opener = channel.opener;
  if (!opener || !widgetOrigin) return Promise.resolve();
  secretArrival = new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      resolve();
    };
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; nonce?: unknown; secret?: unknown } | null;
      if (e.origin !== widgetOrigin || e.source !== (opener as unknown as MessageEventSource)) return;
      if (!data || data.type !== BIND_SECRET || data.nonce !== pending.token) return;
      if (typeof data.secret === 'string' && TOKEN.test(data.secret)) store?.setItem(PENDING, JSON.stringify({ ...pending, secret: data.secret }));
      done();
    };
    const timer = setTimeout(done, waitMs);
    channel.addEventListener('message', onMessage);
    // THE NONCE ALONE GOES OUT, and only to the widget's origin: an opener navigated anywhere else gets nothing.
    opener.postMessage({ type: BIND_REQUEST, nonce: pending.token }, widgetOrigin);
  });
  return secretArrival;
}

/** The pending bind, with its secret, once the widget's answer is in (or known not to be coming). */
async function handedOffBind(store: Store | null): Promise<PendingUpgrade | null> {
  if (secretArrival) await secretArrival;
  const pending = peekPendingUpgrade(store);
  if (pending?.kind !== 'bind') return null;
  if (pending.secret) return pending;
  // NOT FROM THE WIDGET SESSION THAT OWNS THE VISIT: dropped, said, and the person signed in as themselves.
  discardPendingUpgrade(store);
  recordUpgradeOutcome({ refused: NOT_HANDED_OFF, path: 'bind' }, store);
  return null;
}

/**
 * PATH A ON THE FIRST EXCHANGE. Presents the pending bind, and answers with the exchange's answer:
 *
 *  - bound: the continuation is recorded to open, and the bind is settled;
 *  - `CONTINUATION_UNAVAILABLE` (the account is linked, its conversation not opened yet): recorded as
 *    pending, the bind kept so the same call can be made again, and the person signed in as the account;
 *  - any other refusal (a 4xx): recorded, the bind dropped, and the person signed in as themselves;
 *  - an outage (a 5xx, no answer): thrown with the bind kept, so the sign-in's retry makes the same call.
 *
 * Null when no bind is pending.
 */
export async function presentPendingBind(idToken: string, store: Store | null = session()): Promise<ExchangeAnswer | null> {
  if (peekPendingUpgrade(store)?.kind !== 'bind') return null;
  const pending = await handedOffBind(store);
  if (!pending?.secret) return null;
  try {
    const answer = await exchangeCredentials({ bindGuest: { nonce: pending.token, secret: pending.secret } }, idToken);
    discardPendingUpgrade(store);
    recordUpgradeOutcome(answer.bound ? { opened: answer.bound.conversationArn, path: 'bind' } : { refused: 'unknown', path: 'bind' }, store);
    return answer;
  } catch (err) {
    if (!(err instanceof ExchangeRefusedError)) throw err;
    if (err.code === 'CONTINUATION_UNAVAILABLE') {
      recordUpgradeOutcome({ pending: 'bind' }, store);
      return exchangeCredentials({}, idToken);
    }
    if (err.status >= 400 && err.status < 500) {
      discardPendingUpgrade(store);
      recordUpgradeOutcome({ refused: err.code || 'unknown', path: 'bind' }, store);
      return exchangeCredentials({}, idToken);
    }
    throw err;
  }
}

/**
 * Keep the pending visit once the person is signed in: a bind whose continuation could not be opened is
 * presented again (the same call), and a claim is redeemed. Answers with the outcome, which is also
 * recorded; null when nothing is pending.
 */
export async function settlePendingUpgrade(idToken: string, store: Store | null = session(), fetchImpl: typeof fetch = fetch): Promise<UpgradeOutcome | null> {
  const pending = peekPendingUpgrade(store);
  if (!pending) return null;
  let outcome: UpgradeOutcome;
  if (pending.kind === 'bind') {
    const handedOff = await handedOffBind(store);
    if (!handedOff?.secret) {
      const dropped: UpgradeOutcome = { refused: NOT_HANDED_OFF, path: 'bind' };
      recordUpgradeOutcome(dropped, store);
      return dropped;
    }
    try {
      const answer = await exchangeCredentials({ bindGuest: { nonce: handedOff.token, secret: handedOff.secret } }, idToken);
      outcome = answer.bound ? { opened: answer.bound.conversationArn, path: 'bind' } : { refused: 'unknown', path: 'bind' };
      discardPendingUpgrade(store);
    } catch (err) {
      const decided = err instanceof ExchangeRefusedError && err.status >= 400 && err.status < 500;
      if (decided) discardPendingUpgrade(store);
      outcome = decided ? { refused: err.code || 'unknown', path: 'bind' } : { pending: 'bind' };
    }
  } else {
    outcome = await redeemClaim(pending.token, idToken, fetchImpl);
    if (!('pending' in outcome)) discardPendingUpgrade(store);
  }
  recordUpgradeOutcome(outcome, store);
  return outcome;
}

async function redeemClaim(claimToken: string, idToken: string, fetchImpl: typeof fetch): Promise<UpgradeOutcome> {
  let resp: Response;
  try {
    resp = await fetchImpl(personUrl('/upgrade/claim'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimToken }),
    });
  } catch {
    return { pending: 'claim' };
  }
  const body = (await resp.json().catch(() => ({}))) as { conversationArn?: unknown; code?: unknown };
  if (resp.ok && typeof body.conversationArn === 'string') return { opened: body.conversationArn, path: 'claim' };
  if (resp.status >= 500) return { pending: 'claim' };
  return { refused: typeof body.code === 'string' ? body.code : 'unknown', path: 'claim' };
}
