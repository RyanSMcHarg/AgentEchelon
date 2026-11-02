/**
 * A `sign-in` INVITATION, CARRIED FROM ITS LANDING PAGE INTO THE FIRST SIGN-IN (M-10).
 *
 * The landing page (`invite.html`, on this app's own origin, where every invitation lands) sends its holder here with the token in this page's URL
 * fragment (`#invitation=<token>`), which no server receives. The chat app takes it out of the address bar
 * at once (`capturePendingInvitation`) and keeps it for this tab only (`sessionStorage`), so it survives the
 * sign-in redirect and nothing else. The person's first credential exchange presents it
 * (`personIdentity.ts`): a first sign-in is bound to the invitee and lands in the conversation; any other
 * answer is a settled refusal the app shows, and the person is signed in as themselves all the same.
 *
 * `wrong_account` (an account that already exists signed in) keeps the invitation in its outcome, so the app
 * can offer to sign out and continue with a new account: the invitation is pending again for the next
 * sign-in, and the account signed in now is never bound.
 */

const PENDING = 'ae.pendingInvitation';
const OUTCOME = 'ae.invitationOutcome';

/** What presenting the invitation came to. `retryToken`: the invitation, kept to continue with a new account. */
export type InvitationOutcome =
  | { joined: string }
  | { refused: string; retryToken?: string };

/** The refusal codes the exchange answers a sign-in redemption with (D-4). */
export const INVITATION_REFUSALS: ReadonlySet<string> = new Set([
  'expired', 'redeemed', 'revoked', 'redeemed_elsewhere', 'wrong_account', 'wrong_mode', 'unknown', 'invalid_request',
]);

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): Store | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Take an invitation out of the page's fragment, if it carries one, and keep it for the first exchange.
 * True when it did.
 */
export function capturePendingInvitation(loc: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location, store: Store | null = session()): boolean {
  const params = new URLSearchParams(String(loc.hash || '').replace(/^#/, ''));
  const token = params.get('invitation') ?? '';
  if (!token) return false;
  // OUT OF THE ADDRESS BAR FIRST, so neither history nor a copied URL carries it.
  try {
    window.history.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch {
    /* a page with no history to rewrite still keeps the token out of storage beyond this tab */
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token) || !store) return false;
  store.setItem(PENDING, token);
  store.removeItem(OUTCOME);
  // ONE AT A TIME: the exchange refuses a call that redeems an invitation and binds a visitor together.
  store.removeItem(PENDING_UPGRADE);
  return true;
}

/** The visit being kept (`pendingUpgrade.ts`), which an invitation captured after it replaces. */
const PENDING_UPGRADE = 'ae.pendingUpgrade';

/** Drop a waiting invitation: a visit being kept replaces it. */
export function discardPendingInvitation(store: Store | null = session()): void {
  store?.removeItem(PENDING);
}

/** Make an invitation pending again, for the next sign-in: "sign out and continue" after `wrong_account`. */
export function restorePendingInvitation(token: string, store: Store | null = session()): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token) || !store) return;
  store.setItem(PENDING, token);
  store.removeItem(PENDING_UPGRADE);
}

/** The invitation waiting for the first exchange, removed as it is taken: it is presented once. */
export function takePendingInvitation(store: Store | null = session()): string | null {
  const token = store?.getItem(PENDING) ?? null;
  if (token) store!.removeItem(PENDING);
  return token;
}

export function recordInvitationOutcome(outcome: InvitationOutcome, store: Store | null = session()): void {
  store?.setItem(OUTCOME, JSON.stringify(outcome));
}

/** What the invitation came to, read once by the app that shows it. */
export function takeInvitationOutcome(store: Store | null = session()): InvitationOutcome | null {
  const raw = store?.getItem(OUTCOME);
  if (!raw) return null;
  store!.removeItem(OUTCOME);
  try {
    const parsed = JSON.parse(raw) as InvitationOutcome;
    return parsed && typeof parsed === 'object' && ('joined' in parsed || 'refused' in parsed) ? parsed : null;
  } catch {
    return null;
  }
}
