/**
 * Email notification workflow.
 *
 * Workflow shape:
 *   - per-recipient resilient SES SendEmailCommand (one failure does
 *     NOT abort the rest; failures are collected, not thrown),
 *   - Source = the verified sender identity,
 *   - Message.Subject + Body.Text + Body.Html, all Charset UTF-8,
 *   - "Hi {name}, … Best regards, <signature>" templating.
 *
 * AE adaptations (identity only — workflow unchanged):
 *   - uses AE's verified SENDER_EMAIL with the same PLACEHOLDER_SENDER
 *     guard the share-conversation Lambda already uses (skip-but-report
 *     rather than send from an unverified placeholder),
 *   - signature is "AgentEchelon",
 *   - recipient name + plain body are HTML-escaped before going into
 *     the HTML part (guards against a latent HTML-injection foot-gun).
 */
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'noreply@example.com';
const PLACEHOLDER_SENDER = 'noreply@example.com';

const sesClient = new SESClient({ region: AWS_REGION });

export interface EmailRecipient {
  email: string;
  name: string;
}

export interface EmailContent {
  subject: string;
  /** Plain-text body. The "Hi {name}," greeting and signature are added. */
  bodyText: string;
  /**
   * Optional pre-built HTML body fragment (already-safe HTML, e.g. a
   * link). If omitted, the escaped bodyText is wrapped in a <p>.
   */
  bodyHtml?: string;
}

export interface NotificationResult {
  sent: string[];
  failed: Array<{ email: string; error: string }>;
  /** Set when the whole send was skipped (unverified placeholder sender). */
  skipped?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  for (const r of recipients) {
    const safeName = escapeHtml(r.name);
    const htmlInner = content.bodyHtml ?? `<p>${escapeHtml(content.bodyText)}</p>`;
    try {
      await sesClient.send(
        new SendEmailCommand({
          Source: SENDER_EMAIL,
          Destination: { ToAddresses: [r.email] },
          Message: {
            Subject: { Data: content.subject, Charset: 'UTF-8' },
            Body: {
              Text: {
                Data: `Hi ${r.name},\n\n${content.bodyText}\n\nBest regards,\nAgentEchelon`,
                Charset: 'UTF-8',
              },
              Html: {
                Data:
                  `<html><body><p>Hi ${safeName},</p>${htmlInner}` +
                  `<p>Best regards,<br/>AgentEchelon</p></body></html>`,
                Charset: 'UTF-8',
              },
            },
          },
        }),
      );
      sent.push(r.email);
      console.log(`[notification] Email sent to ${r.email}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ email: r.email, error });
      console.error(`[notification] Error sending to ${r.email}:`, error);
    }
  }

  return { sent, failed };
}
