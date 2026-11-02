/**
 * Email notification workflow: the one SES sender.
 *
 * Workflow shape:
 *   - per-recipient resilient SES v2 `SendEmail` (one failure does NOT abort the rest; failures are
 *     collected, not thrown),
 *   - Source = the verified sender identity,
 *   - a text and an HTML part, both UTF-8,
 *   - wrapped in the conversation assistant's own words: its greeting, its sign-off, its name as the
 *     signature, in the language its copy is written in (`lib/email-copy.ts`). Never fixed English, and
 *     never a product name standing in for the assistant.
 *
 * Each recipient's mail is its own request, so it carries its own `Reply-To` (a reply token) and its own
 * `List-Unsubscribe` and `List-Unsubscribe-Post` (an unsubscribe token), as Simple content's headers and
 * the request's reply address (`lib/email-message.ts`).
 *
 * The PLACEHOLDER_SENDER guard skips and reports rather than send from an unverified placeholder.
 * Recipient names and plain bodies are HTML-escaped before they reach the HTML part.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { sessionClient } from './assistant-session.js';
import { defaultEmailVoice, emailLine, type EmailVoice } from './email-copy.js';
import { mailbox, sendEmailInput } from './email-message.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'noreply@example.com';
const PLACEHOLDER_SENDER = 'noreply@example.com';

const sesClient = sessionClient(SESv2Client, { region: AWS_REGION });

export interface EmailRecipient {
  email: string;
  /** The recipient's display name; empty uses the copy's `unnamedRecipient`. */
  name: string;
  /** This recipient's reply address (a reply token), when the mail is about a conversation. */
  replyTo?: string;
  /** This recipient's one-click unsubscribe and preference link, on a mail they can stop. */
  unsubscribeUrl?: string;
}

export interface EmailContent {
  subject: string;
  /** Plain-text body. The greeting and signature are added. */
  bodyText: string;
  /**
   * Optional pre-built HTML body fragment (already-safe HTML, e.g. a
   * link). If omitted, the escaped bodyText is wrapped in a <p>.
   */
  bodyHtml?: string;
  /** Whose words wrap the body. Default: the stand-in copy, signed by an unnamed assistant. */
  voice?: EmailVoice;
}

export interface NotificationResult {
  sent: string[];
  failed: Array<{ email: string; error: string }>;
  /** Set when the whole send was skipped (unverified placeholder sender). */
  skipped?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A link that stands in for the preference link while its line is rendered for the HTML part. */
const LINK_STAND_IN = 'https://link.invalid/manage-email';

/** The two parts of one recipient's mail. Exported so the wrapping is testable without SES. */
export function composeEmail(r: EmailRecipient, content: EmailContent): { text: string; html: string; language: string } {
  const voice = content.voice ?? defaultEmailVoice();
  const { copy } = voice;
  const name = r.name || copy.unnamedRecipient;
  const greeting = emailLine(voice, 'greeting', { name });
  const signature = voice.assistantName || copy.unnamedAssistant;
  const replyLine = r.replyTo ? copy.replyHint : '';
  const manage = r.unsubscribeUrl ? emailLine(voice, 'manageEmail', { link: r.unsubscribeUrl }) : '';
  const text = [greeting, '', content.bodyText, ...(replyLine ? ['', replyLine] : []), '', copy.signOff, signature,
    ...(manage ? ['', '--', manage] : [])].join('\n');
  const htmlInner = content.bodyHtml ?? `<p>${escapeHtml(content.bodyText)}</p>`;
  // The HTML line is the same rendered line with the link made an anchor: rendered around a stand-in link, escaped,
  // and the stand-in replaced, so the template's words are escaped and the link is the only markup.
  const manageHtml = r.unsubscribeUrl
    ? `<p style="color:#666;font-size:12px">${escapeHtml(emailLine(voice, 'manageEmail', { link: LINK_STAND_IN })).replace(escapeHtml(LINK_STAND_IN),
      `<a href="${escapeHtml(r.unsubscribeUrl)}">${escapeHtml(r.unsubscribeUrl)}</a>`)}</p>`
    : '';
  const html = `<html lang="${escapeHtml(copy.language)}"><body><p>${escapeHtml(greeting)}</p>${htmlInner}`
    + (replyLine ? `<p>${escapeHtml(replyLine)}</p>` : '')
    + `<p>${escapeHtml(copy.signOff)}<br/>${escapeHtml(signature)}</p>${manageHtml}</body></html>`;
  return { text, html, language: copy.language };
}

/**
 * Send an email to each recipient. Resilient per-recipient
 * loop: a single recipient failure is recorded and the rest still go.
 * Never throws for send failures — returns a structured result so the
 * caller (e.g. the proactive briefing Lambda) can surface partial
 * delivery the way AE's share flow surfaces { emailSent, emailError }.
 */
export async function sendEmailNotifications(
  recipients: EmailRecipient[],
  content: EmailContent,
): Promise<NotificationResult> {
  if (SENDER_EMAIL === PLACEHOLDER_SENDER) {
    const skipped =
      'SENDER_EMAIL is the unset placeholder (noreply@example.com). ' +
      'Redeploy with --context senderEmail=<SES-verified address> to enable delivery.';
    console.warn('[notification] Skipping all sends:', skipped);
    return { sent: [], failed: [], skipped };
  }

  const sent: string[] = [];
  const failed: Array<{ email: string; error: string }> = [];
  const voice = content.voice ?? defaultEmailVoice();

  for (const r of recipients) {
    const parts = composeEmail(r, { ...content, voice });
    try {
      const input = sendEmailInput({
        from: mailbox(voice.assistantName, SENDER_EMAIL),
        to: mailbox(r.name, r.email),
        subject: content.subject,
        text: parts.text,
        html: parts.html,
        language: parts.language,
        ...(r.replyTo ? { replyTo: r.replyTo } : {}),
        ...(r.unsubscribeUrl ? { unsubscribeUrl: r.unsubscribeUrl } : {}),
      });
      await sesClient.send(new SendEmailCommand(input));
      sent.push(r.email);
      console.log('[notification] Email sent');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ email: r.email, error });
      console.error('[notification] Error sending an email:', error);
    }
  }

  return { sent, failed };
}
