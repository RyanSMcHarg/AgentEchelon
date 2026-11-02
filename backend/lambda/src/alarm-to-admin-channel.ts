/**
 * THE ONE ALARM NOTIFIER: any CloudWatch alarm, to the admins.
 *
 * Triggered by SNS when an alarm wired to its topic changes state. Raises the alarm's own description and
 * CloudWatch's reason as an `ae.alert` (`lib/admin-notice.ts`), which the `AdminServices` stack posts into
 * the admin notification channel, emailed to the admin roster. When the deployment names people for this alarm (`ALERT_RECIPIENT_ARNS`, AppInstanceUser ARNs),
 * they are emailed the same notice through the one fan-out (`lib/channel-notify.ts` `emailPeople`), whose
 * contacts are resolved by person at send time: that is how an alarm reaches someone on a deployment with
 * no admin channel. One message when it breaks, one when it clears: CloudWatch notifies on state
 * transition, so it does the de-duplication. `INSUFFICIENT_DATA` is not news and is skipped.
 *
 * The alarm's description carries what to do, written where the alarm is defined, so this handler needs
 * to know nothing about any particular alarm. A dashboard an alarm wants linked is named in
 * `ALARM_DASHBOARD`, and the link is built here, where the region is known.
 *
 * Every alarm in the deployment is delivered by this one handler; a per-alarm notifier is what let three
 * of them disagree about what an operator is told.
 *
 * Never throws: an exception bubbles back to SNS and is retried, and a retried alarm posts twice.
 */
import type { SNSEvent } from 'aws-lambda';
import { postAdminNotice } from './lib/admin-notice.js';
import { shippedAdminNoticeText, type AdminNoticeWords } from './lib/admin-notice-templates.js';
import { emailPeople } from './lib/channel-notify.js';
import { isPersonArn } from './lib/person-arn.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

export { fitEncoded } from './lib/admin-notice.js';

/** The subset of the CloudWatch alarm SNS payload this reads. */
export interface AlarmMessage {
  AlarmName?: string;
  AlarmDescription?: string;
  NewStateValue?: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  OldStateValue?: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  NewStateReason?: string;
  StateChangeTime?: string;
  /** The display name (`US East (N. Virginia)`), never a region code; the code is read from `AlarmArn`. */
  Region?: string;
  AlarmArn?: string;
}

/** The alarm's region code, from its ARN (`arn:aws:cloudwatch:<region>:...`); a console URL needs the code, not `Region`'s display name. */
export function alarmRegionCode(alarm: AlarmMessage): string | undefined {
  const code = alarm.AlarmArn?.split(':')[3];
  return code && /^[a-z]{2}(-[a-z]+)+-\d+$/.test(code) ? code : undefined;
}

/**
 * Deep link to a CloudWatch dashboard, so the alert is actionable without anyone hunting for it.
 *
 * The `#dashboards:name=` form is the console's own permalink shape. Built here rather than baked into
 * the alarm at deploy time because the region is only known at runtime.
 */
export function dashboardUrl(dashboardName: string, awsRegion: string): string {
  if (!dashboardName) return '';
  return `https://${awsRegion}.console.aws.amazon.com/cloudwatch/home?region=${awsRegion}`
    + `#dashboards:name=${encodeURIComponent(dashboardName)}`;
}

/** The notice for one state change. Exported for tests: the text is the whole product. */
export function renderAlarm(
  alarm: AlarmMessage,
  opts: { dashboard?: string; region?: string } = {},
): { content: string; subject: string; words: AdminNoticeWords } {
  const link = dashboardUrl(opts.dashboard ?? '', alarmRegionCode(alarm) || opts.region || process.env.AWS_REGION || 'us-east-1');
  // SAID FROM THE `cloudwatch-alarm` TEMPLATE (ADR-062 decision 6): the state and a value the alarm did not carry are the
  // template's own labels, and a line with no value is left out.
  const words: AdminNoticeWords = {
    name: 'cloudwatch-alarm',
    values: {
      ...(alarm.AlarmName ? { name: alarm.AlarmName } : {}),
      ...(alarm.AlarmDescription ? { description: alarm.AlarmDescription } : {}),
      ...(alarm.NewStateReason ? { reason: alarm.NewStateReason } : {}),
      when: alarm.StateChangeTime || new Date().toISOString(),
      ...(link ? { dashboard: link } : {}),
    },
    labels: {
      state: alarm.NewStateValue === 'OK' ? 'recovered' : 'alarm',
      ...(alarm.AlarmName ? {} : { name: 'anAlarm' }),
      ...(alarm.NewStateReason ? {} : { reason: 'noReason' }),
    },
  };
  return { ...shippedAdminNoticeText(words), words };
}

/** The people this deployment names for its alarms, as AppInstanceUser ARNs. */
export function alertRecipientArns(raw: string = process.env.ALERT_RECIPIENT_ARNS || ''): string[] {
  return raw.split(',').map((s) => s.trim()).filter((arn) => isPersonArn(arn));
}

export const handler = async (event: SNSEvent): Promise<void> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const recipients = alertRecipientArns();
  const dashboard = process.env.ALARM_DASHBOARD || '';
  for (const record of event.Records || []) {
    try {
      const alarm = JSON.parse(record.Sns.Message) as AlarmMessage;
      if (alarm.NewStateValue !== 'ALARM' && alarm.NewStateValue !== 'OK') continue;
      // A RECOVERY IS A RETURN FROM ALARM. A new or recreated alarm's first evaluation moves INSUFFICIENT_DATA to OK,
      // which recovers nothing, so it says nothing; a message without the old state is still said.
      if (alarm.NewStateValue === 'OK' && alarm.OldStateValue && alarm.OldStateValue !== 'ALARM') continue;
      const { content, subject, words } = renderAlarm(alarm, { dashboard });
      const posted = await postAdminNotice({
        content,
        subject,
        messageType: 'cloudwatch_alarm',
        extra: { alarmName: alarm.AlarmName, alarmState: alarm.NewStateValue },
        words,
      });
      // THE LOG IS THE RECEIPT. The handler swallows delivery failures by design, so a line saying
      // `raised`, or `failed to deliver`, is the only place an operator (and the e2e) can tell the two
      // apart. The admin channel post is the AdminServices alert poster's, which logs its own receipt.
      if (posted) console.log(`[alarm-to-admin-channel] raised ${alarm.NewStateValue} for ${alarm.AlarmName} as an ae.alert`);
      if (recipients.length) {
        const res = await emailPeople({ personArns: recipients, kind: 'alarm', subject, bodyText: content });
        console.log('[alarm-to-admin-channel] emailed the alarm recipients', {
          emailed: res.emailed.length, skipped: res.skipped.length, failed: res.failed.length,
        });
        if (res.emailed.length) console.log(`[alarm-to-admin-channel] delivered ${alarm.NewStateValue} for ${alarm.AlarmName} by email`);
      } else if (!posted) {
        console.error('[alarm-to-admin-channel] failed to deliver: the alert was not raised and there are no recipients, so the alarm reached nobody', {
          alarm: alarm.AlarmName, state: alarm.NewStateValue,
        });
      }
    } catch (err) {
      console.error('[alarm-to-admin-channel] failed to deliver an alarm notification:', err);
    }
  }
};
