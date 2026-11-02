/**
 * THE PREFERENCE PAGE AND ONE-CLICK UNSUBSCRIBE (B9, RFC 8058): `GET` and `POST /email/preferences?t=<token>`.
 *
 * Reached from every mail a person can stop: its footer links here, and its `List-Unsubscribe` header
 * names this URL with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so a mail client's one-click
 * unsubscribe is a `POST` here with that body.
 *
 * ── AUTHENTICATED BY THE TOKEN, NOT BY A SIGN-IN ─────────────────────────────────────────────────
 *
 * The route has no authorizer: RFC 8058 requires one-click to work with no session, and a mail client
 * posts it with none. The `unsubscribe` token in the link is the credential. Two layers (tenet D3):
 *  - IAM: this function's role reads `unsubscribe#*` records in the token store and nothing else there,
 *    and writes only the `<personId>#notices` items of the user-profile table, only their `muted`,
 *    `personArn` and `updatedAt` attributes (`notification-stack.ts`). It cannot read a profile, a contact
 *    copy or another kind of token;
 *  - the handler: the person and the kind are read from the token's record, never from the request, so a
 *    link acts for the one person it was minted for. An unknown or expired token changes nothing.
 *
 * `GET` never changes anything: a link scanner or a prefetching mail client that opens the link must not
 * unsubscribe anyone. The page lists the kinds a person can stop and posts the chosen change back here.
 *
 * A link past its live window still stops its own kind of email, and only that (`expiredLink`, below).
 *
 * The page speaks in the words of the email that linked to it: its copy is carried on the token's record,
 * resolved from the conversation assistant's profile when the mail was sent (`lib/email-consent.ts`).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { presentBoundedToken, type TokenRecord } from './lib/tokens.js';
import {
  ALL_KINDS, MUTABLE_KINDS, isMuted, isNoticeKind, isTransactional, readNoticePreferences, setNoticeMute, type NoticeKind,
} from './lib/notice-preferences.js';
import { DEFAULT_EMAIL_COPY, emailCopyOfLines, fill, kindLabel, type EmailCopy } from './lib/email-copy.js';
import { escapeHtml } from './lib/notification.js';
import { preferencesScreenLink } from './lib/notify-directive.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

export interface PreferencesDeps {
  doc: Sender;
  tokensTable: string;
  preferencesTable: string;
  now(): number;
}

interface HttpEvent {
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface HttpResult { statusCode: number; headers: Record<string, string>; body: string }

const page = (statusCode: number, html: string): HttpResult => ({
  statusCode,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  },
  body: html,
});

/** The copy a token's record carries, over the shipped English. */
function copyOf(record: TokenRecord | undefined): EmailCopy {
  const carried = (record?.page && typeof record.page === 'object') ? record.page as Record<string, string> : {};
  return emailCopyOfLines(carried);
}

function render(copy: EmailCopy, args: { token?: string; muted?: (k: NoticeKind | typeof ALL_KINDS) => boolean; notice?: string }): string {
  const t = args.token ? encodeURIComponent(args.token) : '';
  const rows = args.token && args.muted ? MUTABLE_KINDS.map((k) => {
    const off = args.muted!(k);
    return `<li><form method="post" action="?t=${t}"><input type="hidden" name="kind" value="${k}">`
      + `<input type="hidden" name="action" value="${off ? 'resume' : 'stop'}">`
      + `<span>${escapeHtml(fill(copy.preferenceKind, { kind: kindLabel(copy, k) }))}</span> `
      + `<button type="submit">${escapeHtml(off ? copy.resumeKind : copy.stopKind)}</button></form></li>`;
  }).join('') : '';
  const all = args.token
    ? `<form method="post" action="?t=${t}"><input type="hidden" name="action" value="stopAll"><button type="submit">${escapeHtml(copy.stopAll)}</button></form>`
    : '';
  return `<!doctype html><html lang="${escapeHtml(copy.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(copy.preferencesTitle)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}`
    + `li{margin:8px 0}button{margin-left:8px}</style></head><body><h1>${escapeHtml(copy.preferencesTitle)}</h1>`
    + (args.notice ? `<p role="status">${escapeHtml(args.notice)}</p>` : '')
    + (rows ? `<ul>${rows}</ul>${all}<p>${escapeHtml(copy.transactionalNote)}</p>` : '')
    + '</body></html>';
}

function formOf(event: HttpEvent): URLSearchParams {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  return new URLSearchParams(raw);
}

/** The page, or the change a post asks for. Exported for the B9 tests. */
export async function handlePreferences(event: HttpEvent, deps: PreferencesDeps): Promise<HttpResult> {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const token = String(event.queryStringParameters?.t || '');
  const invalid = () => page(404, render({ ...DEFAULT_EMAIL_COPY }, { notice: DEFAULT_EMAIL_COPY.linkInvalid }));
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return invalid();
  const presented = await presentBoundedToken(deps.doc, deps.tokensTable, 'unsubscribe', token, Math.floor(deps.now() / 1000));
  if (!presented.ok) {
    // AN EXPIRED BUT GENUINE LINK STILL STOPS ITS OWN EMAIL, until its record's `muteUntil`.
    if (presented.reason === 'expired' && presented.record) return expiredLink(event, method, token, presented.record, deps);
    console.log('[email-preferences] a link was refused', { reason: presented.reason });
    return page(404, render(copyOf(presented.record), { notice: copyOf(presented.record).linkInvalid }));
  }
  const record = presented.record;
  const copy = copyOf(record);
  const personArn = String(record.personArn || '');
  const kind = record.noticeKind;
  if (!personArn || !isNoticeKind(kind)) return invalid();

  let notice: string | undefined;
  if (method === 'POST') {
    const form = formOf(event);
    // RFC 8058: the one-click body stops the kind the mail was. A form post names its change.
    const oneClick = form.get('List-Unsubscribe') === 'One-Click';
    const action = oneClick ? 'stop' : form.get('action');
    const target = oneClick ? kind : (action === 'stopAll' ? ALL_KINDS : form.get('kind'));
    const known = target === ALL_KINDS || (isNoticeKind(target) && !isTransactional(target));
    if (!known || !['stop', 'resume', 'stopAll'].includes(String(action))) return page(400, render(copy, { notice: copy.linkInvalid }));
    await setNoticeMute(deps.doc, deps.preferencesTable, {
      personArn, route: 'email', kind: target as NoticeKind | typeof ALL_KINDS, muted: action !== 'resume', now: new Date(deps.now()),
    });
    console.log('[email-preferences] a preference was changed', { action, kind: target, oneClick });
    if (oneClick) return page(200, render(copy, { notice: copy.saved }));
    notice = copy.saved;
  } else if (method !== 'GET') {
    return page(405, render(copy, {}));
  }
  const prefs = await readNoticePreferences(deps.doc, deps.preferencesTable, personArn) ?? { muted: {} };
  return page(200, render(copy, { token, muted: (k) => isMuted(prefs, 'email', k) || isMuted(prefs, 'email', ALL_KINDS), notice }));
}

/**
 * AN EXPIRED LINK MAY ONLY STOP THE ONE KIND OF EMAIL IT CAME IN, FOR THE ONE PERSON IT NAMES.
 *
 * A link past its live window (`expiresAt`) but within its record's `muteUntil` performs its own mute, by
 * one-click or by the page's single stop action, and nothing else: it shows no other preference, resumes
 * nothing and stops no other kind. Viewing or changing the full set needs a live link. A `GET` changes
 * nothing. The page then says the email is stopped and that everything else is managed after signing in.
 * **NOT BUILT:** the signed-in preferences screen, so the page names it in words and links nowhere.
 */
async function expiredLink(event: HttpEvent, method: string, token: string, record: TokenRecord, deps: PreferencesDeps): Promise<HttpResult> {
  const copy = copyOf(record);
  const personArn = String(record.personArn || '');
  const kind = record.noticeKind;
  const now = Math.floor(deps.now() / 1000);
  const muteUntil = typeof record.muteUntil === 'number' ? record.muteUntil : 0;
  if (record.kind !== 'unsubscribe' || !personArn || !isNoticeKind(kind) || isTransactional(kind) || !(muteUntil > now)) {
    console.log('[email-preferences] a link was refused', { reason: 'expired' });
    return page(404, render(copy, { notice: copy.linkInvalid }));
  }
  if (method === 'GET') return page(200, renderExpired(copy, { token, kind }));
  if (method !== 'POST') return page(405, render(copy, {}));
  const form = formOf(event);
  const oneClick = form.get('List-Unsubscribe') === 'One-Click';
  const ownStop = form.get('action') === 'stop' && form.get('kind') === kind;
  if (!oneClick && !ownStop) {
    console.log('[email-preferences] an expired link asked for more than its own mute; refused');
    return page(403, renderExpired(copy, { token, kind }));
  }
  await setNoticeMute(deps.doc, deps.preferencesTable, { personArn, route: 'email', kind, muted: true, now: new Date(deps.now()) });
  console.log('[email-preferences] an expired link stopped its own kind', { kind, oneClick });
  return page(200, renderExpired(copy, { done: true, kind }));
}

/** The paragraph that sends a person to the signed-in screen: a link when the deployment knows its app. */
function signInLine(copy: EmailCopy): string {
  const link = preferencesScreenLink(process.env.APP_URL || '');
  return link
    ? `<p>${escapeHtml(copy.expiredSignIn)} <a href="${escapeHtml(link)}" rel="noreferrer">${escapeHtml(copy.openPreferences)}</a></p>`
    : `<p>${escapeHtml(copy.expiredSignIn)}</p>`;
}

function renderExpired(copy: EmailCopy, args: { token?: string; kind: NoticeKind; done?: boolean }): string {
  const label = escapeHtml(fill(copy.preferenceKind, { kind: kindLabel(copy, args.kind) }));
  const body = args.done
    ? `<p role="status">${escapeHtml(copy.expiredStopped)}</p><p>${label}</p>${signInLine(copy)}`
    : `<p>${escapeHtml(copy.expiredOffer)}</p><form method="post" action="?t=${encodeURIComponent(args.token || '')}">`
      + `<input type="hidden" name="kind" value="${args.kind}"><input type="hidden" name="action" value="stop">`
      + `<span>${label}</span> <button type="submit">${escapeHtml(copy.stopKind)}</button></form>${signInLine(copy)}`;
  return `<!doctype html><html lang="${escapeHtml(copy.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(copy.preferencesTitle)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}`
    + `button{margin-left:8px}</style></head><body><h1>${escapeHtml(copy.preferencesTitle)}</h1>${body}</body></html>`;
}

let defaults: PreferencesDeps | null = null;
export const handler = async (event: HttpEvent): Promise<HttpResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  defaults ??= {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })),
    tokensTable: process.env.TOKENS_TABLE || '',
    preferencesTable: process.env.NOTICE_PREFERENCES_TABLE || '',
    now: () => Date.now(),
  };
  try {
    return await handlePreferences(event, defaults);
  } catch (err) {
    console.error('[email-preferences] the request failed', { err: (err as Error)?.name || String(err) });
    return page(500, render({ ...DEFAULT_EMAIL_COPY }, { notice: DEFAULT_EMAIL_COPY.linkInvalid }));
  }
};

/** Test seam. */
export function __setPreferencesDepsForTests(d: PreferencesDeps | null): void {
  defaults = d;
}
