/**
 * THE TWO PERSON ROUTES THE INVITATION LANDING PAGE CALLS (M-10, M-5), both on the credential exchange and
 * both unauthenticated: the token in the body is what is asked about, and it never travels in a URL.
 *
 *  - `POST /invitations/peek`: what the token's holder may know (the conversation's name, who invited
 *    them, the mode, whether it can still be used). It consumes nothing.
 *  - `POST /invitations/redeem`: a `link` invitation's one redemption, behind the kill switch, the
 *    per-address limit and the captcha. It answers with a session for the one conversation, pinned to the
 *    invitee, that lasts 15 minutes and is not renewed.
 *
 * A `sign-in` invitation is redeemed by the chat app after its holder signs in, never here.
 */
import { personUrl } from '@ae/shared/platform/config.ts';
import type { SessionCredentials } from './personApi';

/** Every reason the landing page shows a settled state for (D-4), plus `network` (no answer at all). */
export type InvitationRefusalCode =
  | 'expired'
  | 'redeemed'
  | 'revoked'
  | 'redeemed_elsewhere'
  | 'wrong_account'
  | 'wrong_mode'
  | 'ended'
  | 'unknown'
  | 'paused'
  | 'rate_limited'
  | 'captcha_failed'
  | 'unavailable'
  | 'network';

const KNOWN: ReadonlySet<string> = new Set([
  'expired', 'redeemed', 'revoked', 'redeemed_elsewhere', 'wrong_account', 'wrong_mode', 'ended', 'unknown',
  'paused', 'rate_limited', 'captcha_failed', 'unavailable',
]);

export class InvitationRefusal extends Error {
  readonly code: InvitationRefusalCode;
  readonly retryAfterSeconds?: number;
  constructor(code: InvitationRefusalCode, retryAfterSeconds?: number) {
    super(`refused: ${code}`);
    this.name = 'InvitationRefusal';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** What the landing page is told about an invitation. */
export interface InvitationPeek {
  status: 'pending' | 'redeemed' | 'expired' | 'revoked';
  mode: 'sign-in' | 'link';
  conversationName: string;
  inviterName: string;
  inviteeName: string;
  /** Epoch seconds. */
  expiresAt: number;
  /** A `sign-in` invitation: where its holder signs in (the chat app). */
  signInUrl?: string;
  /** A `link` invitation: whether this deployment can redeem it. */
  linkAvailable?: boolean;
  /** A `link` invitation: the captcha the redemption verifies. */
  captchaSiteKey?: string;
  sessionMinutes?: number;
}

/** A `link` redemption's answer: the session, and the conversation it reaches. */
export interface LinkRedemption {
  credentials: SessionCredentials;
  userArn: string;
  channelArn: string;
  /** Epoch seconds: the session ends here and is not renewed. */
  sessionEndsAt: number;
  conversationName: string;
  inviterName: string;
}

async function post(url: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // The page sends no referrer, and no credential but the token in the body.
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
  } catch {
    throw new InvitationRefusal('network');
  }
}

async function refusalOf(resp: Response): Promise<InvitationRefusal> {
  const body = (await resp.json().catch(() => ({}))) as { code?: unknown; retryAfterSeconds?: unknown };
  const code = typeof body.code === 'string' && KNOWN.has(body.code) ? (body.code as InvitationRefusalCode) : resp.status >= 500 ? 'unavailable' : 'unknown';
  const retry = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : Number(resp.headers.get('Retry-After')) || undefined;
  return new InvitationRefusal(code, retry);
}

export async function peekInvitation(token: string): Promise<InvitationPeek> {
  const resp = await post(personUrl('/invitations/peek'), { token });
  if (!resp.ok) throw await refusalOf(resp);
  return (await resp.json()) as InvitationPeek;
}

export async function redeemLinkInvitation(token: string, captchaToken: string): Promise<LinkRedemption> {
  const resp = await post(personUrl('/invitations/redeem'), { token, captchaToken });
  if (!resp.ok) throw await refusalOf(resp);
  const d = (await resp.json()) as Record<string, unknown>;
  const c = (d.credentials ?? {}) as Record<string, unknown>;
  return {
    credentials: {
      accessKeyId: String(c.AccessKeyId ?? ''),
      secretAccessKey: String(c.SecretAccessKey ?? ''),
      sessionToken: String(c.SessionToken ?? ''),
      ...(typeof c.Expiration === 'string' ? { expiration: c.Expiration } : {}),
    },
    userArn: String(d.userArn),
    channelArn: String(d.channelArn),
    sessionEndsAt: Number(d.sessionEndsAt),
    conversationName: String(d.conversationName ?? ''),
    inviterName: String(d.inviterName ?? ''),
  };
}

/** The token an invitation link carries in its fragment (`#t=<token>`), or ''. */
export function tokenFromFragment(hash: string): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const t = params.get('t') ?? '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(t) ? t : '';
}

/** Where a `sign-in` invitation's holder goes to sign in: the chat app, with the token in its fragment. */
export function signInDestination(signInUrl: string, token: string): string {
  return `${signInUrl.replace(/\/$/, '')}/#invitation=${encodeURIComponent(token)}`;
}
