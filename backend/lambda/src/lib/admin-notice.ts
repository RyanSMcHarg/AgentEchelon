/**
 * TELL THE OPERATORS SOMETHING: the one way a platform alert leaves the code that noticed it.
 *
 * An alert is a FACT, put on the account's default EventBridge bus as an `ae.alert` event (tenet D6: an
 * event, not a channel a core stack has to know about). The core never names the admin channel and never
 * learns whether one exists. The `AdminServices` stack, present with the `admin` capability, holds the one
 * rule that takes these events and posts each into the admin notification channel
 * (`admin-alert-poster.ts`, `lib/admin-channel-post.ts`), whose `notify` directive emails the admin roster.
 * A deployment without `admin` has no rule, so the event is recorded by EventBridge and delivered nowhere,
 * and the CloudWatch line written here is the operator's record.
 *
 * The event carries this instance's name, and the rule matches it, so two instances in one account never
 * post into each other's channel.
 *
 * Never throws: a caller is on a failure path already, telling somebody that something else went wrong.
 * Returns whether the event was accepted by the bus, so a caller can log the one it could not send.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { shippedAdminNoticeText, type AdminNoticeWords } from './admin-notice-templates.js';

export { fitEncoded, CHIME_CONTENT_SAFE, CHIME_METADATA_SAFE } from './admin-channel-post.js';

/** The source every platform alert carries, which the `AdminServices` rule matches. */
export const ALERT_SOURCE = 'ae.alert';

export interface AdminNotice {
  /** Markdown body, as an operator reads it. */
  content: string;
  /** The email subject line. */
  subject: string;
  /** What kind of notice this is, for whoever reads the channel's metadata. Also the event's detail-type. */
  messageType: string;
  /** Further metadata fields for this kind of notice. */
  extra?: Record<string, unknown>;
  /**
   * The template the notice is said from and its values (ADR-062 decision 6): the poster says it from the admin assistant's
   * own template of that name, else the shipped one, and `content` and `subject` are the shipped wording it falls back to.
   */
  words?: AdminNoticeWords;
}

/**
 * AN OPERATOR NOTICE NAMED BY ITS TEMPLATE (ADR-062 decision 6): the template and its values, with the shipped wording as
 * its `content` and `subject`, which the CloudWatch line and a deployment with no admin channel read.
 */
export function adminNotice(words: AdminNoticeWords, messageType: string, extra?: Record<string, unknown>): AdminNotice {
  return { ...shippedAdminNoticeText(words), messageType, ...(extra ? { extra } : {}), words };
}

/** The detail of an `ae.alert` event. */
export interface AlertDetail {
  /** The instance that raised it (`AE_INSTANCE_NAME`), which the rule matches. */
  instance: string;
  notice: AdminNotice;
}

let events: EventBridgeClient | null = null;

export async function postAdminNotice(notice: AdminNotice): Promise<boolean> {
  console.log(JSON.stringify({ _alert: notice.messageType, subject: notice.subject }));
  try {
    const instance = process.env.ALERT_INSTANCE || '';
    if (!instance) {
      console.warn(`[admin-notice] ALERT_INSTANCE is not set; ${notice.messageType} logged only`, { subject: notice.subject });
      return false;
    }
    events = events ?? new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const detail: AlertDetail = { instance, notice };
    const out = await events.send(new PutEventsCommand({
      Entries: [{ Source: ALERT_SOURCE, DetailType: notice.messageType, Detail: JSON.stringify(detail) }],
    }));
    if (out.FailedEntryCount) {
      console.error(`[admin-notice] the bus refused ${notice.messageType}`, { code: out.Entries?.[0]?.ErrorCode });
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[admin-notice] could not raise ${notice.messageType}:`, err);
    return false;
  }
}
