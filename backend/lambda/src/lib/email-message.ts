/**
 * ONE EMAIL, AS SES v2 SENDS IT (`SendEmail` with `Simple` content).
 *
 * SES composes the MIME message; this file says what goes into it. Simple content carries a text and an
 * HTML part, both UTF-8, and the headers B9 and M-8 need:
 *  - `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 2369, RFC 8058) on
 *    every mail a person can stop, so a mail client offers one-click unsubscribe and the large mailbox
 *    providers accept the sender (`Headers`);
 *  - `Reply-To`, the per-recipient reply address that carries a reply token (`lib/reply-tokens.ts`),
 *    as the request's `ReplyToAddresses`;
 *  - `Content-Language`, the language the assistant's copy is written in (`lib/email-copy.ts`) (`Headers`).
 *
 * Every value is stripped of CR and LF before it is used, so nothing a caller passes can add a header.
 * A non-ASCII display name is an RFC 2047 encoded word, which is what SES asks for in an address.
 */
import type { SendEmailCommandInput } from '@aws-sdk/client-sesv2';

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  language?: string;
  replyTo?: string;
  /** The one-click unsubscribe URL. Absent on a transactional mail, which carries neither header. */
  unsubscribeUrl?: string;
}

const oneLine = (v: string): string => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

/** An RFC 2047 encoded word when the value is not plain ASCII; the value itself otherwise. */
export function encodedWord(v: string): string {
  const s = oneLine(v);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * The headers an email carries beyond what SES writes itself (From, To, Subject, Reply-To, the MIME
 * structure), in order. Exported so the B9 rule is testable without the request.
 */
export function headersOf(m: EmailMessage): Array<[string, string]> {
  const h: Array<[string, string]> = [];
  if (m.language) h.push(['Content-Language', oneLine(m.language)]);
  if (m.unsubscribeUrl) {
    h.push(['List-Unsubscribe', `<${oneLine(m.unsubscribeUrl)}>`]);
    h.push(['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']);
  }
  return h;
}

/** The `SendEmail` request for one recipient's mail: Simple content, its headers and its reply address. */
export function sendEmailInput(m: EmailMessage): SendEmailCommandInput {
  const headers = headersOf(m);
  return {
    FromEmailAddress: oneLine(m.from),
    Destination: { ToAddresses: [oneLine(m.to)] },
    ...(m.replyTo ? { ReplyToAddresses: [oneLine(m.replyTo)] } : {}),
    Content: {
      Simple: {
        Subject: { Data: oneLine(m.subject), Charset: 'UTF-8' },
        Body: {
          Text: { Data: m.text, Charset: 'UTF-8' },
          Html: { Data: m.html, Charset: 'UTF-8' },
        },
        ...(headers.length ? { Headers: headers.map(([Name, Value]) => ({ Name, Value })) } : {}),
      },
    },
  };
}

/** A display name and address as a header value: `"Name" <address>`, the name encoded when it must be. */
export function mailbox(name: string, address: string): string {
  const n = oneLine(name).replace(/["\\]/g, '');
  if (!n) return oneLine(address);
  return /^[\x20-\x7e]*$/.test(n) ? `"${n}" <${oneLine(address)}>` : `${encodedWord(n)} <${oneLine(address)}>`;
}
