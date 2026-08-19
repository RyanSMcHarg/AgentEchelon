/**
 * Context source alarm notifier.
 *
 * Triggered by SNS when the context-source FAILURE RATE alarm changes state. Posts to the admin
 * notification channel, which fans the message out to the admin roster by email via the channel
 * flow's `notify` directive - the same path `sendProcessorErrorAlert` and the membership audit use.
 *
 * Why a rate and not an occurrence. Context sources resolve on every turn, so a broken grant fails
 * continuously. An alert per occurrence would email every admin once per user message, which is how
 * a channel gets muted. CloudWatch does the windowing (5 minutes) and, because an alarm notifies on
 * STATE TRANSITION, it also does the de-duplication: one message when it breaks, one when it clears.
 *
 * Why SNS is still here. It is the transport between CloudWatch and this function, not the
 * destination. The destination is the admin conversation.
 *
 * Never throws. An exception bubbles back to SNS and triggers a retry storm, so every failure is
 * logged and swallowed - the alarm has already done its job by existing.
 */
import type { SNSEvent } from 'aws-lambda';
import {
  ChimeSDKMessagingClient,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';

const region = process.env.AWS_REGION || 'us-east-1';
const messaging = new ChimeSDKMessagingClient({ region });

const CHANNEL_ARN = process.env.ADMIN_ERROR_ALERT_CHANNEL_ARN || '';
const BEARER_ARN = process.env.ADMIN_ALERT_BEARER_ARN || '';
const CLASSIFICATION = process.env.CLASSIFICATION || '';
const DASHBOARD_NAME = process.env.CONTEXT_SOURCE_DASHBOARD || '';

/**
 * Amazon Chime SDK message limits, measured on the URL-ENCODED string.
 *
 * Content 4096, Metadata 1024. Encoding is the trap: `encodeURIComponent` turns every newline into
 * `%0A` and every space into `%20`, so prose roughly doubles and a message that looks comfortably
 * short raw can exceed the cap once encoded. `async-processor-core.ts` carries the same constants and
 * the scars that produced them.
 *
 * Duplicated rather than imported: that module pulls in the whole Bedrock turn engine, which has no
 * business in an alarm notifier's bundle.
 *
 * Enforced because the failure mode is exactly what this alert exists to prevent. Over the cap,
 * `SendChannelMessage` throws, the handler swallows it (it must, or SNS retries forever), and the
 * alarm that fired is never delivered - a monitoring system that silently fails to monitor.
 */
const CHIME_CONTENT_SAFE = 3600;
const CHIME_METADATA_SAFE = 900;

const encodedLen = (s: string): number => encodeURIComponent(s).length;

/** Trim to fit an ENCODED budget. Binary search rather than a ratio guess: the inflation factor
 *  depends entirely on the characters present, so a fixed divisor either wastes room or overshoots. */
export function fitEncoded(text: string, budget: number): string {
  if (encodedLen(text) <= budget) return text;
  const suffix = '\n[truncated]';
  const room = budget - encodedLen(suffix);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodedLen(text.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + suffix;
}

/** The subset of the CloudWatch alarm SNS payload this reads. */
interface AlarmMessage {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateValue?: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  NewStateReason?: string;
  StateChangeTime?: string;
  Region?: string;
}

/**
 * Deep link to the dashboard, so the alert is actionable without anyone hunting for it.
 *
 * The `#dashboards:name=` form is the console's own permalink shape. Built here rather than baked
 * into the message at deploy time because the region is only known at runtime in a Lambda.
 */
export function dashboardUrl(dashboardName: string, awsRegion: string): string {
  if (!dashboardName) return '';
  return `https://${awsRegion}.console.aws.amazon.com/cloudwatch/home?region=${awsRegion}`
    + `#dashboards:name=${encodeURIComponent(dashboardName)}`;
}

/**
 * Render the admin message.
 *
 * Exported for tests: the content is the whole product of this Lambda, and asserting on it is the
 * only way to know an operator receives something they can act on rather than "ALARM: true".
 */
export function renderAlarmMessage(alarm: AlarmMessage, classification: string): {
  content: string;
  subject: string;
  recovered: boolean;
} {
  const recovered = alarm.NewStateValue === 'OK';
  const awsRegion = alarm.Region || region;
  const link = dashboardUrl(DASHBOARD_NAME, awsRegion);
  const when = alarm.StateChangeTime || new Date().toISOString();

  const subject = recovered
    ? `Recovered: context sources for ${classification}`
    : `Context source failures: ${classification}`;

  const headline = recovered
    ? `**Context sources recovered** (${classification})`
    : `**Context sources are failing** (${classification})`;

  // NewStateReason carries CloudWatch's own arithmetic ("Threshold Crossed: ... [12.5 (01/08/26 ...)]"),
  // which is the actual percentage over the window. Passing it through beats re-deriving it here and
  // risking a number that disagrees with the console an operator is about to open.
  const body = [
    headline,
    '',
    `**What:** ${alarm.AlarmDescription || alarm.AlarmName || 'context source failure rate'}`,
    `**CloudWatch:** ${alarm.NewStateReason || '(no reason given)'}`,
    `**When:** ${when}`,
    link ? `**Dashboard:** ${link}` : '',
    '',
    recovered
      ? 'The failure rate is back under the threshold. No action needed unless it recurs.'
      : 'Open the dashboard and check the Outcome breakdown. `denied` means a grant is missing or '
        + 'was refused; `absent` means content is missing; `(catalog)` as the source key means the '
        + 'catalog parameter itself could not be read, which takes out every source at once.',
  ].filter((l) => l !== '').join('\n');

  return { content: body, subject, recovered };
}

export const handler = async (event: SNSEvent): Promise<void> => {
  if (!CHANNEL_ARN || !BEARER_ARN) {
    // The stack only deploys this function when both are set, so reaching here means the wiring
    // regressed. Say so loudly rather than returning quietly, which would look like "no alarms".
    console.error('[context-source-alarm] no admin channel configured; alarm not delivered');
    return;
  }

  for (const record of event.Records || []) {
    try {
      const alarm = JSON.parse(record.Sns.Message) as AlarmMessage;
      // INSUFFICIENT_DATA is not news: it means no turns used context sources in the window, which is
      // normal on a quiet deployment. Only breaking and recovering are worth an admin's attention.
      if (alarm.NewStateValue !== 'ALARM' && alarm.NewStateValue !== 'OK') continue;

      const { content, subject } = renderAlarmMessage(alarm, CLASSIFICATION);

      // Metadata first: `subject` is the only unbounded field in it, so it absorbs the trim.
      const metadataFor = (subj: string) => JSON.stringify({
        messageType: 'context_source_alarm',
        classification: CLASSIFICATION,
        alarmState: alarm.NewStateValue,
        timestamp: alarm.StateChangeTime || new Date().toISOString(),
        // What turns the in-app post into an email to the admin roster (channel-notify fan-out).
        notify: { email: true },
        subject: subj,
        // Keeps the alert out of classification usage metrics - it is not a user turn.
        analytics: { userType: 'admin' },
      });
      let metadata = metadataFor(subject);
      if (encodedLen(metadata) > CHIME_METADATA_SAFE) {
        const overBy = encodedLen(metadata) - CHIME_METADATA_SAFE;
        metadata = metadataFor(fitEncoded(subject, Math.max(0, encodedLen(subject) - overBy)));
      }

      await messaging.send(new SendChannelMessageCommand({
        ChannelArn: CHANNEL_ARN,
        Content: encodeURIComponent(fitEncoded(content, CHIME_CONTENT_SAFE)),
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ChimeBearer: BEARER_ARN,
        Metadata: metadata,
      }));
      console.log(`[context-source-alarm] delivered ${alarm.NewStateValue} for ${CLASSIFICATION}`);
    } catch (err) {
      console.error('[context-source-alarm] failed to deliver an alarm notification:', err);
    }
  }
};
