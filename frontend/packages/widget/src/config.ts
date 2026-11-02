/**
 * The widget's build configuration, read from its own `.env` (written by
 * `backend/scripts/gen-frontend-env.mjs` when `widget` is a declared capability).
 *
 * The person API base, the region and the app instance come from `@ae/shared/platform/config`, the one
 * reader every client uses, so the widget can never call a different instance than the chat app.
 * What is the widget's alone is here: what it needs to start a guest, and which origins may post it a
 * host assertion.
 */

/** The captcha site key the widget loads at guest start, or '' when the deployment declares no guest issuer. */
export function guestCaptchaSiteKey(): string {
  return String(import.meta.env.VITE_GUEST_CAPTCHA_SITE_KEY || '').trim();
}

/** The privacy-notice version the widget shows before the first message and sends with guest start. */
export function guestNoticeVersion(): string {
  return String(import.meta.env.VITE_GUEST_NOTICE_VERSION || '').trim();
}

/** Whether this deployment offers a guest start: a guest issuer is declared, so its site key and notice are set. */
export function guestStartOffered(): boolean {
  return Boolean(guestCaptchaSiteKey() && guestNoticeVersion());
}

/**
 * The origins a host assertion may be posted from: every `allowedOrigins` the registry's
 * `host-assertion` entries declare. Exact origins only (scheme, host and port), compared as strings,
 * never as prefixes or patterns. Read at call time, so a test that stubs the env sees its stub.
 */
export function assertionHosts(): ReadonlySet<string> {
  return new Set(
    String(import.meta.env.VITE_WIDGET_ASSERTION_HOSTS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

/**
 * HOW A VISIT BECOMES AN ACCOUNT, as this deployment offers it: the upgrade paths the visitor's
 * conversation type declares (`VITE_GUEST_UPGRADE_PATHS`, the `GuestUpgradePaths` output), and only when
 * the widget knows the chat app a visitor signs in at (`VITE_GUEST_SIGN_IN_URL`). `bind` is path A (a new
 * account takes the visit over), `claim` is path B (a registration an existing account claims).
 */
export function guestUpgradePaths(): ReadonlySet<'bind' | 'claim'> {
  if (!guestSignInUrl()) return new Set();
  return new Set(
    String(import.meta.env.VITE_GUEST_UPGRADE_PATHS || '')
      .split(',')
      .map((p) => p.trim())
      .filter((p): p is 'bind' | 'claim' => p === 'bind' || p === 'claim'),
  );
}

/** The chat app a visitor signs in at, whose sign-in carries the visit over, or '' when the build names none. */
export function guestSignInUrl(): string {
  const raw = String(import.meta.env.VITE_GUEST_SIGN_IN_URL || '').trim();
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.hostname === 'localhost' ? raw.replace(/\/$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * THE HOST'S DECLARED CONTACT ROUTE: where a visitor goes when the assistant is paused or unavailable. The
 * host passes it to the loader (`contact`, an `https:`, `mailto:` or `tel:` URL), which frames it as
 * `?contact=`. Anything else is dropped, so the frame never links a `javascript:` URL a page put there.
 */
export function contactRoute(search: string = typeof window === 'undefined' ? '' : window.location.search): string | null {
  const raw = new URLSearchParams(search).get('contact');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['https:', 'mailto:', 'tel:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
