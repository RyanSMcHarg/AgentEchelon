/**
 * THE SIGN-IN MAIL: an invitation's link and a registration's claim link, each to the one address the person gave,
 * in the words of the conversation's assistant, and the reminder of an invitation its inviter confirmed (ADR-061,
 * `send_nudge`), to the one address the inviter typed when they confirmed it.
 *
 * The invitation and the claim are transactional and sent whatever the person muted. The reminder is not: it is the
 * `nudge` kind, sent only while the invitee has not stopped it and carrying the one-click unsubscribe (`emailPeople`
 * checks the preference and mints the link, for the invitee's own AppInstanceUser).
 *
 * Composed and sent in `Notifications`, which holds the deployment's only SES send grant (ADR-055), by the
 * `TransactionalMail` function (`lambda/src/transactional-mail.ts`). The functions in `Conversations` that
 * issue the link (`invitations.ts`, `guest-upgrade.ts`) hand it over with `invokeTransactionalMail`, by the
 * function's fixed name, and hold no SES grant of their own. A deployment that does not declare
 * `notifications` has no such function and no grant to invoke it: the invoke is refused, a warning says the
 * capability is not deployed, nothing is emailed, and each caller says so.
 *
 * Neither mail carries a reply address: a reply would post as a person who has not yet redeemed the link.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { emailPeople } from './channel-notify.js';
import { emailLine, emailVoiceForRoom, type EmailVoice } from './email-copy.js';
import { escapeHtml } from './notification.js';
import { oneRecipientDirectory } from './one-recipient-directory.js';

type Sender = { send(command: unknown): Promise<any> };

/** One mail: whom it goes to, at which address, about which conversation, carrying which link. */
export type TransactionalMail =
  | { mail: 'invitation'; personArn: string; address: string; name: string; channelArn: string; link: string; sender?: string; title?: string }
  | { mail: 'nudge'; personArn: string; address: string; name: string; channelArn: string; link: string; sender?: string; title?: string; note?: string }
  | { mail: 'claim'; personArn: string; address: string; name: string; channelArn: string; link: string };

export interface ComposeDeps {
  /** The fan-out. Default `emailPeople`. */
  email?: typeof emailPeople;
  /** Whose words wrap the mail. Default the conversation's assistant. */
  voice?: (channelArn: string) => Promise<EmailVoice>;
}

const ARN = /^arn:aws:chime:[a-z0-9-]+:\d{1,12}:app-instance\/[^/]+\/(user|channel)\/[^/]+$/;
const ADDRESS = /^[^\s@"\\]{1,64}@[^\s@"\\]{1,253}$/;

/** The request, when it is one this function sends; null otherwise. */
export function transactionalMailOf(input: unknown): TransactionalMail | null {
  const m = input as Record<string, unknown> | null;
  if (!m || (m.mail !== 'invitation' && m.mail !== 'nudge' && m.mail !== 'claim')) return null;
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : '');
  if (!ARN.test(str('personArn')) || !ARN.test(str('channelArn')) || !ADDRESS.test(str('address')) || !/^https?:\/\//.test(str('link'))) return null;
  const base = { personArn: str('personArn'), address: str('address'), name: str('name'), channelArn: str('channelArn'), link: str('link') };
  if (m.mail === 'claim') return { mail: 'claim', ...base };
  const named = { ...(str('sender') ? { sender: str('sender') } : {}), ...(str('title') ? { title: str('title') } : {}) };
  return m.mail === 'invitation'
    ? { mail: 'invitation', ...base, ...named }
    : { mail: 'nudge', ...base, ...named, ...(str('note') ? { note: str('note').slice(0, 1000) } : {}) };
}

const buttonOf = (link: string, label: string): string =>
  `<p style="margin: 24px 0;"><a href="${escapeHtml(link)}" style="background: #2d2d2d; color: #fff; `
  + `padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">${escapeHtml(label)}</a></p>`;

/** Compose the mail and send it through the one fan-out, to the given address alone. True when it was sent. */
export async function sendTransactionalMail(m: TransactionalMail, d: ComposeDeps = {}): Promise<boolean> {
  const voice = await (d.voice ?? emailVoiceForRoom)(m.channelArn);
  const { copy } = voice;
  const content = m.mail === 'nudge'
    ? (() => {
      // THE REMINDER: its own subject and line, the note the inviter confirmed as its own paragraph, and the fresh link.
      const vars = { sender: m.sender || copy.someone, title: m.title || copy.untitled };
      const text = emailLine(voice, 'nudgeBody', vars);
      const note = m.note ? emailLine(voice, 'nudgeNote', { note: m.note }) : '';
      return {
        subject: emailLine(voice, 'nudgeSubject', vars),
        bodyText: [text, note, emailLine(voice, 'invitationLinkLine', { link: m.link }), copy.invitationOnce].filter(Boolean).join('\n\n'),
        bodyHtml: `<p>${escapeHtml(text)}</p>${note ? `<p>${escapeHtml(note)}</p>` : ''}${buttonOf(m.link, copy.openInvitation)}<p>${escapeHtml(copy.invitationOnce)}</p>`,
      };
    })()
    : m.mail === 'invitation'
    ? (() => {
      const vars = { sender: m.sender || copy.someone, title: m.title || copy.untitled };
      const text = emailLine(voice, 'invitationBody', vars);
      return {
        subject: emailLine(voice, 'invitationSubject', vars),
        bodyText: `${text}\n\n${emailLine(voice, 'invitationLinkLine', { link: m.link })}\n\n${copy.invitationOnce}`,
        bodyHtml: `<p>${escapeHtml(text)}</p>${buttonOf(m.link, copy.openInvitation)}<p>${escapeHtml(copy.invitationOnce)}</p>`,
      };
    })()
    : {
      subject: copy.claimSubject,
      bodyText: `${copy.claimBody}\n\n${emailLine(voice, 'claimLinkLine', { link: m.link })}\n\n${copy.claimOnce}`,
      bodyHtml: `<p>${escapeHtml(copy.claimBody)}</p>${buttonOf(m.link, copy.openClaim)}<p>${escapeHtml(copy.claimOnce)}</p>`,
    };
  // NO `channelArn`: the fan-out mints no reply address for a person who has not redeemed the link.
  const res = await (d.email ?? emailPeople)({
    personArns: [m.personArn],
    // The reminder is the `nudge` kind, which the invitee may stop; the other two are transactional.
    kind: m.mail,
    ...content,
    voice,
    deps: { directory: oneRecipientDirectory(m.personArn, m.address, m.name) },
  });
  return res.emailed.length > 0;
}

let defaultLambda: Sender | null = null;

/**
 * Hand the mail to `Notifications` and answer whether it was sent. False, never a throw, when the
 * deployment sends no email or the send failed: each caller has an answer for an unsent link.
 *
 * A DEPLOYMENT WITHOUT `notifications` names no mail function (`TRANSACTIONAL_MAIL_FUNCTION` is set at synth
 * exactly where the capability is declared), so it sends no email: the answer is false, with no call and no log.
 */
export async function invokeTransactionalMail(m: TransactionalMail, d: { lambda?: Sender; functionName?: string } = {}): Promise<boolean> {
  const functionName = d.functionName ?? process.env.TRANSACTIONAL_MAIL_FUNCTION ?? '';
  if (!functionName) return false;
  const lambda = d.lambda ?? (defaultLambda ??= new LambdaClient({}));
  try {
    const res = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(m)) }));
    if (res.FunctionError) {
      console.warn('[TransactionalMail] the send failed', { mail: m.mail, error: res.FunctionError });
      return false;
    }
    const out = JSON.parse(Buffer.from(res.Payload ?? []).toString() || '{}') as { sent?: unknown };
    return out.sent === true;
  } catch (err) {
    const name = (err as { name?: string })?.name || '';
    // A NAMED FUNCTION THAT REFUSES OR IS ABSENT is a fault in a deployment that declares `notifications`: said
    // where an operator reads it.
    console.warn('[TransactionalMail] could not be handed to Notifications', { mail: m.mail, err: name });
    return false;
  }
}
