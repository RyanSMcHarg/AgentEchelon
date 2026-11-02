/**
 * THE THREE PERSON ROUTES THE WIDGET CALLS, and nothing else.
 *
 *  - `POST /guest/start` and `POST /guest/refresh`: the guest issuer's two unauthenticated entry points
 *    (`backend/lambda/src/guest-session.ts`), each behind its own abuse controls.
 *  - `POST /exchange-credentials`: the one credential exchange, called with a guest token or a host
 *    assertion as the bearer. It vends the Amazon Chime SDK session, pinned to one AppInstanceUser.
 *
 * Every refusal comes back as a `WidgetRefusal` carrying the server's reason code, so the widget shows
 * a settled state for it and never a raw error.
 */
import { personUrl } from '@ae/shared/platform/config.ts';

/** A vended Amazon Chime SDK session credential. */
export interface SessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601. */
  expiration?: string;
}

/** What guest start and guest refresh both answer with. */
export interface GuestTokens {
  guestToken: string;
  /** Seconds since the epoch. */
  guestTokenExpiresAt: number;
  refreshToken: string;
  /** Seconds since the epoch: the visit ends here, whatever is refreshed. */
  sessionEndsAt: number;
  channelArn: string;
  userArn: string;
}

/** Guest start's answer: the tokens, the first session, and the notice version it recorded as shown. */
export interface GuestStart extends GuestTokens {
  credentials: SessionCredentials;
  noticeVersion: string;
}

/** The credential exchange's answer. */
export interface ExchangeAnswer {
  credentials: SessionCredentials;
  userArn: string;
}

/**
 * Every reason the server gives for refusing the widget, plus `network` (no answer at all). The guest
 * codes are guest-session.ts's; the exchange answers with its own `code` or a bare status.
 */
export type RefusalCode =
  | 'paused'
  | 'rate_limited'
  | 'captcha_failed'
  | 'unavailable'
  | 'replayed'
  | 'revoked'
  | 'expired'
  | 'ended'
  | 'invalid_request'
  | 'not_provisioned'
  | 'refused'
  | 'network';

const KNOWN: ReadonlySet<string> = new Set([
  'paused', 'rate_limited', 'captcha_failed', 'unavailable', 'replayed', 'revoked', 'expired', 'ended', 'invalid_request',
]);

export class WidgetRefusal extends Error {
  readonly code: RefusalCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(code: RefusalCode, status: number, retryAfterSeconds?: number) {
    super(`refused: ${code}`);
    this.name = 'WidgetRefusal';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The refusal a non-2xx answer carries. */
async function refusalOf(resp: Response, route: 'guest' | 'exchange'): Promise<WidgetRefusal> {
  const body = (await resp.json().catch(() => ({}))) as { code?: unknown; retryAfterSeconds?: unknown };
  const raw = typeof body.code === 'string' ? body.code : '';
  const retry = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : Number(resp.headers.get('Retry-After')) || undefined;
  if (KNOWN.has(raw)) return new WidgetRefusal(raw as RefusalCode, resp.status, retry);
  if (route === 'exchange') {
    // A subject nobody provisioned is refused and nothing is created (P-13): the exchange names it.
    if (raw === 'PERSON_NOT_PROVISIONED') return new WidgetRefusal('not_provisioned', resp.status);
    if (resp.status >= 500) return new WidgetRefusal('unavailable', resp.status);
    return new WidgetRefusal('refused', resp.status);
  }
  return new WidgetRefusal(resp.status >= 500 ? 'unavailable' : 'invalid_request', resp.status);
}

async function post(url: string, body: unknown, bearer?: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new WidgetRefusal('network', 0);
  }
}

function credentialsOf(c: Record<string, unknown> | undefined): SessionCredentials {
  return {
    accessKeyId: String(c?.AccessKeyId ?? ''),
    secretAccessKey: String(c?.SecretAccessKey ?? ''),
    sessionToken: String(c?.SessionToken ?? ''),
    ...(typeof c?.Expiration === 'string' ? { expiration: c.Expiration } : {}),
  };
}

function tokensOf(d: Record<string, unknown>): GuestTokens {
  return {
    guestToken: String(d.guestToken),
    guestTokenExpiresAt: Number(d.guestTokenExpiresAt),
    refreshToken: String(d.refreshToken),
    sessionEndsAt: Number(d.sessionEndsAt),
    channelArn: String(d.channelArn),
    userArn: String(d.userArn),
  };
}

/** Guest start: the captcha's response and the notice version the visitor was shown. */
export async function guestStart(captchaToken: string, noticeVersion: string): Promise<GuestStart> {
  const resp = await post(personUrl('/guest/start'), { captchaToken, noticeVersion });
  if (!resp.ok) throw await refusalOf(resp, 'guest');
  const d = (await resp.json()) as Record<string, unknown>;
  return { ...tokensOf(d), credentials: credentialsOf(d.credentials as Record<string, unknown>), noticeVersion: String(d.noticeVersion) };
}

/**
 * Guest refresh: spends the refresh credential once and answers with its successor. With `bindSecretHash`
 * (a sign-in hand-off, path A) it also answers with `bindNonce`, which names the successor and that hash.
 */
export async function guestRefresh(refreshToken: string, opts: { bindSecretHash?: string } = {}): Promise<GuestTokens & { bindNonce?: string }> {
  const resp = await post(personUrl('/guest/refresh'), { refreshToken, ...(opts.bindSecretHash ? { bindSecretHash: opts.bindSecretHash } : {}) });
  if (!resp.ok) throw await refusalOf(resp, 'guest');
  const d = (await resp.json()) as Record<string, unknown>;
  return { ...tokensOf(d), ...(typeof d.bindNonce === 'string' ? { bindNonce: d.bindNonce } : {}) };
}

/**
 * The credential exchange, with a guest token or a host assertion as the bearer. A guest names no
 * conversation (its token names it); a host may name the one the person opened.
 */
export async function exchange(bearer: string, channelArn?: string): Promise<ExchangeAnswer> {
  const resp = await post(personUrl('/exchange-credentials'), channelArn ? { channelArn } : {}, bearer);
  if (!resp.ok) throw await refusalOf(resp, 'exchange');
  const d = (await resp.json()) as Record<string, unknown>;
  return { credentials: credentialsOf(d.credentials as Record<string, unknown>), userArn: String(d.userArn) };
}
