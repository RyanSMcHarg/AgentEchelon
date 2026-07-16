/**
 * Archival Alarm Lambda
 *
 * Triggered by SNS when a CloudWatch alarm on the Kinesis archival
 * pipeline fires (typically: zero IncomingRecords on the Chime→Kinesis
 * stream for 1+ hours). Sends an email alert to the operator addresses
 * configured at deploy time via the `alertRecipients` CDK context.
 *
 * Why this exists:
 *   The Chime→Kinesis→Firehose→S3→Athena path can break silently —
 *   Chime streaming config wiped, Kinesis stream throttled, Firehose
 *   delivery role denied. When it breaks, the admin dashboard goes
 *   quiet but no obvious error surfaces. This Lambda makes the silent
 *   failure loud.
 *
 * Design notes:
 *   - Sends via SES (there is no admin notification Chime channel by
 *     default — forcing one would be a deploy footgun), so it goes direct to SES.
 *   - Recipients come from ALERT_RECIPIENTS env (JSON array of
 *     {email,name}). Empty array → skip-but-report (warn + return),
 *     mirroring the placeholder-sender pattern in notification.ts.
 *   - The CDK construct that wires this Lambda only deploys the alarm
 *     + SNS topic when alertRecipients is non-empty, so this code only
 *     runs at all when the deployer has configured it.
 *
 * Never throws: an exception bubbles up to SNS and triggers a retry
 * storm. We log the failure and return cleanly.
 */
import { SNSEvent } from 'aws-lambda';
import {
  sendEmailNotifications,
  type EmailRecipient,
} from './lib/notification';

interface CloudWatchAlarmSnsMessage {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateValue?: string;
  NewStateReason?: string;
  Region?: string;
  StateChangeTime?: string;
}

function parseRecipients(): EmailRecipient[] {
  const raw = process.env.ALERT_RECIPIENTS || '[]';
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[archival-alarm] ALERT_RECIPIENTS is not an array, ignoring:', raw);
      return [];
    }
    return parsed.filter(
      (r): r is EmailRecipient =>
        r && typeof r.email === 'string' && typeof r.name === 'string'
    );
  } catch (err) {
    console.warn('[archival-alarm] ALERT_RECIPIENTS is not valid JSON, ignoring:', err);
    return [];
  }
}

function buildBody(message: CloudWatchAlarmSnsMessage): {
  subject: string;
  bodyText: string;
} {
  const alarmName = message.AlarmName || 'Unknown alarm';
  const reason = message.NewStateReason || '(no reason supplied)';
  const region = message.Region || process.env.AWS_REGION || 'unknown';
  const when = message.StateChangeTime || new Date().toISOString();

  const subject = `[AgentEchelon] Archival pipeline alarm: ${alarmName}`;

  const bodyText = [
    'The Chime → Kinesis → Firehose → S3 archival pipeline appears to have stopped.',
    'Messages are not being written to the analytics archive while this alarm is active.',
    '',
    `Alarm: ${alarmName}`,
    `Region: ${region}`,
    `Triggered: ${when}`,
    `Reason: ${reason}`,
    '',
    'Likely causes:',
    '  - Chime SDK messaging streaming configuration was removed or rewritten',
    '    (verify: aws chime-sdk-messaging get-messaging-streaming-configurations',
    '     --app-instance-arn <arn>)',
    '  - Kinesis stream throttled, deleted, or its retention expired',
    '  - Firehose delivery role denied write to the archive bucket',
    '',
    'See docs/TROUBLESHOOTING.md §14 (admin dashboard tabs silently empty) for diagnostic steps.',
  ].join('\n');

  return { subject, bodyText };
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const recipients = parseRecipients();
  if (recipients.length === 0) {
    console.warn(
      '[archival-alarm] ALERT_RECIPIENTS is empty — no email will be sent. ' +
        'Configure via --context alertRecipients=\'[{"email":"ops@you.com","name":"Ops"}]\'.'
    );
    return;
  }

  for (const record of event.Records) {
    let message: CloudWatchAlarmSnsMessage = {};
    try {
      message = JSON.parse(record.Sns.Message);
    } catch (err) {
      console.error('[archival-alarm] SNS Message is not valid JSON:', err);
      continue;
    }

    // CloudWatch alarms notify on every state transition; only alert on
    // ALARM (skip OK recovery + INSUFFICIENT_DATA to avoid noise).
    if (message.NewStateValue !== 'ALARM') {
      console.log(
        `[archival-alarm] State ${message.NewStateValue} for ${message.AlarmName}, skipping`
      );
      continue;
    }

    const { subject, bodyText } = buildBody(message);
    const result = await sendEmailNotifications(recipients, { subject, bodyText });
    console.log('[archival-alarm] Email dispatch:', {
      sent: result.sent.length,
      failed: result.failed.length,
      skipped: result.skipped,
    });
  }
};
