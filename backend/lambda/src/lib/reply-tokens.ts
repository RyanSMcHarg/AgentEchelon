/**
 * INBOUND EMAIL RESOLVES THROUGH A REPLY TOKEN, NEVER THROUGH ITS FROM (M-8, B10).
 *
 * A notice about a conversation is sent with a per-recipient reply address, `reply+<token>@<reply domain>`
 * (`lib/email-consent.ts`). The token is a `Tokens` record of kind `reply`, bound to (conversation,
 * AppInstanceUser, outbound notice), accepted until it expires (14 days) and not single-use, because people
 * reply to a thread more than once.
 *
 * A reply is posted only when every one of these holds, checked in this order (`decideReply`):
 *  1. SES found no virus and did not mark it as spam;
 *  2. it was addressed to a reply address on this deployment's reply domain, carrying a token;
 *  3. the token's record exists, is of kind `reply`, and has not expired;
 *  4. DMARC passed: SPF or DKIM passed AND aligned with the From domain. SES reports the verdict; SPF and
 *     DKIM on their own are inputs to it and are never trusted alone, because either can pass for a domain
 *     that is not the one in From;
 *  5. From is the address the person's issuer holds for them now (`Directory.contactFor`), which answers
 *     nothing for a person offboarded or disabled at their issuer's pool, so their reply is refused then;
 *  6. there is text left once the quoted thread is removed.
 *
 * Anything else posts nothing and sends nothing back: a refusal is counted by reason, and no bounce is
 * generated, so a forged reply cannot turn this deployment into a source of backscatter.
 *
 * An accepted reply is posted AS THE PERSON, on the same bearer-pinned session a person's own message
 * takes (`email-reply.ts`): never as a service identity.
 */
import type { RedemptionRefusal } from './tokens.js';

/** How long a reply address accepts replies. */
export const REPLY_TOKEN_TTL_SECONDS = 14 * 86_400;

/** The local-part prefix of a reply address. */
export const REPLY_LOCAL_PREFIX = 'reply+';

/** The reply address for a token. */
export function replyAddressFor(token: string, domain: string): string {
  return `${REPLY_LOCAL_PREFIX}${token}@${domain.trim().toLowerCase()}`;
}

/** The token a recipient address carries, when it is a reply address on `domain`. */
export function tokenOfRecipient(address: string, domain: string): string | null {
  const m = /^reply\+([a-z2-7]{52})@(.+)$/.exec(String(address || '').trim().toLowerCase());
  if (!m || !domain || m[2] !== domain.trim().toLowerCase()) return null;
  return m[1];
}

/** The bare address in a From header value: `"Name" <a@b>` or `a@b`. */
export function addressOf(header: string): string {
  const s = String(header || '');
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  const raw = angle ? angle[1] : (/([^\s<>"]+@[^\s<>"]+)/.exec(s)?.[1] ?? '');
  return raw.trim().toLowerCase();
}

/** Why a reply posted nothing. Each is a counted outcome. */
export type ReplyRefusal =
  | 'virus'
  | 'spam'
  | 'no-token'
  | 'token-unknown'
  | 'token-expired'
  | 'dmarc'
  | 'person-not-reachable'
  | 'from-not-the-person'
  | 'empty';

/** What SES says about one received message (the receipt rule's Lambda event). */
export interface ReceivedMail {
  messageId: string;
  /** The recipients SES accepted this message for, on this deployment's domains. */
  recipients: string[];
  /** The From header, as received. */
  from: string;
  verdicts: { spf?: string; dkim?: string; dmarc?: string; spam?: string; virus?: string };
}

export interface ReplyTokenRecord {
  channelArn: string;
  personArn: string;
  expiresAt: number;
  noticeId?: string;
}

export interface ReplyDeps {
  replyDomain: string;
  now: number;
  /** The live `reply` record for a token, or why there is none. */
  token(token: string): Promise<{ ok: true; record: ReplyTokenRecord } | { ok: false; reason: RedemptionRefusal }>;
  /** The address the person's issuer holds for them now, or null for a person who cannot be reached. */
  contactOf(personArn: string): Promise<string | null>;
  /** The message's text, with the quoted thread removed. */
  text(): Promise<string>;
}

export type ReplyDecision =
  | { post: true; channelArn: string; personArn: string; text: string; noticeId?: string }
  | { post: false; reason: ReplyRefusal };

const verdict = (v?: string): string => String(v || '').toUpperCase();

/** Whether this received mail may be posted, and as whom. Every refusal posts nothing. */
export async function decideReply(mail: ReceivedMail, deps: ReplyDeps): Promise<ReplyDecision> {
  if (verdict(mail.verdicts.virus) === 'FAIL') return { post: false, reason: 'virus' };
  if (verdict(mail.verdicts.spam) === 'FAIL') return { post: false, reason: 'spam' };
  const token = mail.recipients.map((r) => tokenOfRecipient(r, deps.replyDomain)).find(Boolean);
  if (!token) return { post: false, reason: 'no-token' };
  const found = await deps.token(token);
  if (!found.ok) return { post: false, reason: found.reason === 'expired' ? 'token-expired' : 'token-unknown' };
  const { record } = found;
  if (!(record.expiresAt > deps.now)) return { post: false, reason: 'token-expired' };
  if (verdict(mail.verdicts.dmarc) !== 'PASS') return { post: false, reason: 'dmarc' };
  const contact = await deps.contactOf(record.personArn);
  if (!contact) return { post: false, reason: 'person-not-reachable' };
  if (addressOf(mail.from) !== contact.trim().toLowerCase()) return { post: false, reason: 'from-not-the-person' };
  const text = (await deps.text()).trim();
  if (!text) return { post: false, reason: 'empty' };
  return { post: true, channelArn: record.channelArn, personArn: record.personArn, text, ...(record.noticeId ? { noticeId: record.noticeId } : {}) };
}

// ── THE TEXT OF A REPLY ──────────────────────────────────────────────────────────────────────────

/** The most a reply posts, under the Amazon Chime SDK's 4 KB message cap. */
export const MAX_REPLY_CHARS = 3500;

function decodeQuotedPrintable(s: string): Buffer {
  const soft = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(bytes);
}

function splitHeaders(part: string): { headers: Record<string, string>; body: string } {
  const at = part.search(/\r?\n\r?\n/);
  const head = at < 0 ? part : part.slice(0, at);
  const body = at < 0 ? '' : part.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

function decodeBody(body: string, headers: Record<string, string>): string {
  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();
  const charset = (/charset="?([^";\s]+)"?/i.exec(headers['content-type'] || '')?.[1] || 'utf-8').toLowerCase();
  const bytes = encoding === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
    : encoding === 'quoted-printable' ? decodeQuotedPrintable(body) : Buffer.from(body, 'utf8');
  return bytes.toString(charset === 'iso-8859-1' || charset === 'latin1' || charset === 'us-ascii' ? 'latin1' : 'utf8');
}

/** The first `text/plain` part of a MIME message, decoded; or the HTML part with its tags removed. */
export function plainTextOf(raw: string, depth = 0): string {
  const { headers, body } = splitHeaders(raw);
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = /boundary="?([^";]+)"?/i.exec(headers['content-type'] || '')?.[1];
    if (!boundary) return '';
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    let html = '';
    for (const p of parts) {
      const ptype = (splitHeaders(p).headers['content-type'] || 'text/plain').toLowerCase();
      if (ptype.startsWith('text/plain') || ptype.startsWith('multipart/')) {
        const t = plainTextOf(p.replace(/^\r?\n/, ''), depth + 1);
        if (t) return t;
      } else if (ptype.startsWith('text/html') && !html) {
        html = plainTextOf(p.replace(/^\r?\n/, ''), depth + 1);
      }
    }
    return html;
  }
  if (type.startsWith('text/html')) {
    return decodeBody(body, headers).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  if (type.startsWith('text/plain')) return decodeBody(body, headers);
  return '';
}

/**
 * The person's own words: the quoted thread a mail client appends is removed (lines from the first
 * `On ... wrote:` or `-----Original Message-----`, and every `>` line), and the result is capped.
 */
export function replyTextOf(raw: string): string {
  const lines = plainTextOf(raw).replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{5,}\s*$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_REPLY_CHARS);
}
