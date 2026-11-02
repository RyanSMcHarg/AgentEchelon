/**
 * THE WIDGET'S SESSION: one AppInstanceUser, one conversation, and a credential provider that renews.
 *
 * There are three ways in, and each ends at the one credential exchange (SPEC-EMBEDDABLE-WIDGET):
 *
 *  - **Guest.** Guest start vends the first session. After that the provider asks the visit's refresh
 *    leader (`refreshLeader.ts`) for a live guest token and exchanges it.
 *  - **Host.** The host's posted assertion (`hostAssertion.ts`) is exchanged once. To renew, the widget
 *    asks the host for a new assertion; an assertion is never presented twice.
 *  - **Link.** A `link` invitation's landing page (`invite.html`) redeems the invitation once and is
 *    vended one session for the invited conversation (`invitationApi.ts`). It is never renewed: when it
 *    ends, the page shows `ended` (M-10).
 *
 * The provider is what the Amazon Chime SDK clients are built with, so every call renews the session
 * credential shortly before it expires. A refusal while renewing is handed to `onRefused`, which shows its
 * settled state.
 *
 * THE VISIT CARRYING OVER (path A bind, path B claim) is not a session call: the visitor signs in at the
 * chat app, or registers for an emailed sign-in link (`upgrade.ts`, `CarryOver.tsx`).
 */
import { exchange, WidgetRefusal, type GuestStart, type SessionCredentials } from './personApi';
import type { GuestVisit } from './refreshLeader';
import type { HostAssertionInbox } from './hostAssertion';

/** The AWS SDK credential provider shape. */
export type CredentialProvider = () => Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}>;

export interface WidgetSession {
  kind: 'guest' | 'host' | 'link';
  userArn: string;
  channelArn: string;
  credentials: CredentialProvider;
}

/** A session credential this close to its expiry is renewed before it is used. */
export const RENEW_MARGIN_MS = 2 * 60 * 1000;
/** How long the widget waits for a host to answer its request for a new assertion. */
export const HOST_RENEW_WAIT_MS = 15_000;

/**
 * A provider over a renew function: answers the current credential while it has more than
 * `RENEW_MARGIN_MS` left, renews once (callers in flight share it) when it does not.
 */
export function renewingProvider(
  initial: SessionCredentials | null,
  renew: () => Promise<SessionCredentials>,
  onRefused: (refusal: WidgetRefusal) => void,
  now: () => number = Date.now,
): CredentialProvider {
  let current = initial;
  let inFlight: Promise<SessionCredentials> | null = null;
  const live = (c: SessionCredentials | null): c is SessionCredentials =>
    !!c && (!c.expiration || Date.parse(c.expiration) - now() > RENEW_MARGIN_MS);
  return async () => {
    if (!live(current)) {
      inFlight ??= renew()
        .then((c) => {
          current = c;
          return c;
        })
        .catch((err: unknown) => {
          if (err instanceof WidgetRefusal) onRefused(err);
          throw err;
        })
        .finally(() => {
          inFlight = null;
        });
      current = await inFlight;
    }
    const c = current;
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      ...(c.expiration ? { expiration: new Date(c.expiration) } : {}),
    };
  };
}

/** A guest session: from guest start's answer, or a visit joined from another tab (no session yet). */
export function guestSession(
  visit: GuestVisit,
  start: Pick<GuestStart, 'userArn' | 'channelArn'> & { credentials?: SessionCredentials },
  onRefused: (refusal: WidgetRefusal) => void,
): WidgetSession {
  return {
    kind: 'guest',
    userArn: start.userArn,
    channelArn: start.channelArn,
    credentials: renewingProvider(
      start.credentials ?? null,
      async () => (await exchange(await visit.guestToken())).credentials,
      onRefused,
    ),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WidgetRefusal('unavailable', 0)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * A host session: the first accepted assertion is exchanged for the conversation the host names. Throws
 * the exchange's refusal (an unprovisioned subject among them), or `refused` when the host names no
 * conversation, since starting one from inside the widget is **NOT BUILT**.
 */
export async function hostSession(
  inbox: HostAssertionInbox,
  onRefused: (refusal: WidgetRefusal) => void,
): Promise<WidgetSession> {
  const first = await inbox.take();
  if (!first.conversationArn) throw new WidgetRefusal('refused', 0);
  const channelArn = first.conversationArn;
  const answer = await exchange(first.assertion, channelArn);
  const renew = async () => {
    if (!inbox.request()) throw new WidgetRefusal('unavailable', 0);
    const next = await withTimeout(inbox.take(), HOST_RENEW_WAIT_MS);
    return (await exchange(next.assertion, channelArn)).credentials;
  };
  return {
    kind: 'host',
    userArn: answer.userArn,
    channelArn,
    credentials: renewingProvider(answer.credentials, renew, onRefused),
  };
}

/**
 * A link session: the one credential a `link` invitation's redemption vended. Nothing renews it, so the
 * first call after it ends is refused `ended`, and the landing page shows that state.
 */
export function linkSession(
  redeemed: { userArn: string; channelArn: string; credentials: SessionCredentials },
  onRefused: (refusal: WidgetRefusal) => void,
): WidgetSession {
  return {
    kind: 'link',
    userArn: redeemed.userArn,
    channelArn: redeemed.channelArn,
    credentials: renewingProvider(redeemed.credentials, async () => { throw new WidgetRefusal('ended', 0); }, onRefused),
  };
}
