/**
 * THE VISIT CARRIES OVER WITH NOTHING TO CLICK: the widget's half of the two upgrade paths (GUEST-ISSUER
 * "Becoming a person"). A visitor never opts in to keeping their visit; each path is an ordinary act in
 * the conversation, and the visit follows it:
 *
 *  - **Path A, signing in** (a visitor with no account yet): "Sign in" opens the deployment's chat app
 *    (`VITE_GUEST_SIGN_IN_URL`) in a new tab and hands the visit off to that tab alone. The widget makes a
 *    secret that stays in this page and refreshes once with its hash (`handOff`); the server answers with a
 *    single-use, ten-minute nonce naming the credential that refresh issued and the hash. The tab is sent to
 *    `#bindNonce=<nonce>` (a fragment, which no server, access log or `Referer` receives), asks this
 *    widget for the secret over `postMessage` (`answerHandOff` answers only the window it opened, at the
 *    chat app's origin), and its first exchange presents both beside the new account's token. The guest
 *    AppInstanceUser becomes the account, and the app opens the visit's continuation (`bound.conversationArn`).
 *    A link copied out of that tab or forwarded carries the nonce and not the secret, so it binds nothing:
 *    the sign-in starts from the widget session that owns the visit. The refresh credential never leaves
 *    the widget. The widget stops using the visit while it is handed over, so the credential the nonce
 *    names is the one the bind consumes. The widget has no sign-in of its own: the account's session
 *    belongs in the app that holds it.
 *  - **Path B, leaving details** (a visitor who has an account, or will make one): the registration form
 *    in the conversation (`POST /guest/register`, with the guest token) takes a name and the address the
 *    sign-in link is emailed to. The link carries the claim token, and signing in from it carries the visit
 *    over (`POST /upgrade/claim`, made by the chat app on its own). The widget never holds the claim token.
 */
import { personUrl } from '@ae/shared/platform/config.ts';

/** What a visitor may register: a name, and three bounded optional fields (`registrationFieldsOf`). */
export interface RegistrationFields {
  name: string;
  company?: string;
  role?: string;
  note?: string;
}

/** Why a registration was refused, as the widget shows it. */
export type RegistrationRefusalCode = 'invalid' | 'claimed' | 'refused' | 'unavailable' | 'unsent' | 'network';

export class RegistrationRefusal extends Error {
  readonly code: RegistrationRefusalCode;
  constructor(code: RegistrationRefusalCode) {
    super('registration refused: ' + code);
    this.code = code;
    this.name = 'RegistrationRefusal';
  }
}

/** What a registration came to: its link was emailed, or it waits for the deployment to approve it. */
export type RegistrationOutcome = 'sent' | 'awaiting-approval';

/** Register the visit: the fields, and the address its sign-in link goes to. */
export async function registerGuest(guestToken: string, fields: RegistrationFields, email: string): Promise<{ status: RegistrationOutcome }> {
  let resp: Response;
  try {
    resp = await fetch(personUrl('/guest/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guestToken}` },
      body: JSON.stringify({ fields, email }),
    });
  } catch {
    throw new RegistrationRefusal('network');
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { code?: unknown };
    if (body.code === 'REGISTRATION_INVALID') throw new RegistrationRefusal('invalid');
    if (body.code === 'REGISTRATION_CLAIMED') throw new RegistrationRefusal('claimed');
    if (body.code === 'CLAIM_EMAIL_UNSENT') throw new RegistrationRefusal('unsent');
    throw new RegistrationRefusal(resp.status >= 500 ? 'unavailable' : 'refused');
  }
  const d = (await resp.json()) as Record<string, unknown>;
  return { status: d.status === 'awaiting-approval' ? 'awaiting-approval' : 'sent' };
}

/** Where path A sends the visitor: the chat app's sign-in, carrying the hand-off's nonce and nothing else. */
export function bindDestination(signInUrl: string, nonce: string): string {
  return `${signInUrl.replace(/\/$/, '')}/#bindNonce=${encodeURIComponent(nonce)}`;
}

/** The window the chat app's sign-in opens in. Named, so opening it again reuses the tab and keeps its opener. */
export const HANDOFF_WINDOW = 'ae-widget-sign-in';
/** The two messages of the hand-off: the chat app tab asks, the widget answers. */
export const BIND_REQUEST = 'ae.bind.request';
export const BIND_SECRET = 'ae.bind.secret';
/** How long the widget answers for a hand-off: its nonce's own lifetime on the server. */
export const HANDOFF_ANSWER_MS = 600_000;

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fresh hand-off secret: 256 bits from the browser's CSPRNG, base64url. It never leaves this page but to the tab. */
export function newHandOffSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The secret's SHA-256, base64url: what the refresh sends, and what the server keeps. */
export async function handOffSecretHash(secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));
}

/**
 * ANSWER THE TAB THIS WIDGET OPENED, AND NOTHING ELSE: a request for the hand-off's secret is answered only
 * when it comes from that window (`tab()`, read at each message, because the tab can be opened again from
 * the panel), from the chat app's origin, and names this hand-off's nonce. Answered for the nonce's
 * lifetime; returns the function that stops answering.
 */
export function answerHandOff(
  tab: () => Pick<Window, 'postMessage'> | null,
  chatOrigin: string,
  nonce: string,
  secret: string,
  opts: { target?: Pick<Window, 'addEventListener' | 'removeEventListener'>; ttlMs?: number } = {},
): () => void {
  const target = opts.target ?? window;
  const onMessage = (e: MessageEvent) => {
    const from = tab();
    if (!from || e.source !== (from as unknown as MessageEventSource) || e.origin !== chatOrigin) return;
    const data = e.data as { type?: unknown; nonce?: unknown } | null;
    if (!data || data.type !== BIND_REQUEST || data.nonce !== nonce) return;
    from.postMessage({ type: BIND_SECRET, nonce, secret }, chatOrigin);
  };
  target.addEventListener('message', onMessage as EventListener);
  const timer = setTimeout(() => stop(), opts.ttlMs ?? HANDOFF_ANSWER_MS);
  function stop() {
    clearTimeout(timer);
    target.removeEventListener('message', onMessage as EventListener);
  }
  return stop;
}
