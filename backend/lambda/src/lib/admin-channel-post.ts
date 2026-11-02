/**
 * POST AN `ae.alert` INTO THE ADMIN NOTIFICATION CHANNEL, in the `AdminServices` stack only.
 *
 * Every platform alert is raised as an event (`lib/admin-notice.ts`), and the one rule in `AdminServices`
 * hands it to `admin-alert-poster.ts`, which posts it here as the admin assistant. The channel and the agent
 * are that stack's own resources, so their ARNs are its environment (`ADMIN_ALERT_CHANNEL_ARN`,
 * `ADMIN_ALERT_BEARER_ARN`) and nothing outside the stack names either.
 *
 * The channel flow's `notify` directive turns the post into an email to the admin roster
 * (`channel-notify.ts`). What every caller needs, and once got wrong on its own:
 *
 * - CONTENT IS URI-ENCODED, as every message in this app is, and measured ENCODED. The Amazon Chime SDK
 *   caps Content at 4096 and Metadata at 1024 on the encoded string; `encodeURIComponent` turns every
 *   newline into `%0A` and every space into `%20`, so prose roughly doubles. Over the cap the send
 *   throws, so a long notice is posted as one response in ordered parts (`sendInParts`).
 * - THE SUBJECT IS `notifySubject`, the one key `parseNotifyDirective` reads; a bare `subject` is
 *   dropped in silence. It is also the only unbounded field in the Metadata, so it absorbs the trim.
 * - THE NOTICE IS KEPT OUT OF USAGE METRICS (`analytics.classification: 'admin'`): it is not a turn.
 *
 * Never throws: a caller is on a failure path already, telling somebody that something else went wrong.
 * Returns whether the notice was delivered, so a caller can log the one it could not send.
 */
import { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import type { AdminNotice } from './admin-notice.js';
import { chimeMessagingClient } from './chime/clients.js';
import { fitEncoded as fitEncodedContent, sendInParts } from './chime/send.js';
import { notifyDirective } from './notify-directive.js';

export { CHIME_CONTENT_SAFE } from './chime/send.js';
export const CHIME_METADATA_SAFE = 900;

const encodedLen = (s: string): number => encodeURIComponent(s).length;

/**
 * Trim to fit an ENCODED budget, marked for the admin reading it (`fitEncoded` in `chime/send.ts`). For the email
 * SUBJECT only, which the notify directive carries inside Metadata as one header line; the notice's body is posted in
 * parts (`sendInParts`), never cut.
 */
export function fitEncoded(text: string, budget: number): string {
  return fitEncodedContent(text, budget, '\n[truncated]');
}

let messaging: ChimeSDKMessagingClient | null = null;

/** Where the notice goes and who it is from: this stack's admin channel and its admin assistant. */
export interface AdminChannelTarget {
  channelArn: string;
  bearerArn: string;
}

export function adminChannelTarget(): AdminChannelTarget {
  return { channelArn: process.env.ADMIN_ALERT_CHANNEL_ARN || '', bearerArn: process.env.ADMIN_ALERT_BEARER_ARN || '' };
}

export async function deliverAdminNotice(notice: AdminNotice, target: AdminChannelTarget = adminChannelTarget()): Promise<boolean> {
  try {
    if (!target.channelArn || !target.bearerArn) {
      console.error(`[admin-notice] the admin channel or its agent is not configured; ${notice.messageType} logged only`, { subject: notice.subject });
      return false;
    }
    const metadataFor = (subject: string) => JSON.stringify({
      messageType: notice.messageType,
      ...notice.extra,
      timestamp: new Date().toISOString(),
      ...notifyDirective({ subject }),
      analytics: { classification: 'admin' },
    });
    // MEASURED ON THE BUILT BLOB, NOT ON THE SUBJECT ALONE: a character removed from the subject does
    // not remove the same number of encoded characters from the JSON around it.
    let subject = notice.subject;
    let metadata = metadataFor(subject);
    for (let pass = 0; pass < 4 && encodedLen(metadata) > CHIME_METADATA_SAFE; pass += 1) {
      const next = fitEncoded(subject, Math.max(0, encodedLen(subject) - (encodedLen(metadata) - CHIME_METADATA_SAFE)));
      if (next === subject) break;
      subject = next;
      metadata = metadataFor(subject);
    }
    if (encodedLen(metadata) > CHIME_METADATA_SAFE) {
      console.error(`[admin-notice] ${notice.messageType} metadata exceeds the Amazon Chime SDK cap even with the subject trimmed; it is unlikely to be delivered`);
    }
    messaging = messaging ?? chimeMessagingClient({ region: process.env.AWS_REGION || 'us-east-1' });
    // ONE NOTICE, IN AS MANY PARTS AS IT NEEDS: the first carries the directive (so the roster is emailed once), and
    // every part is kept out of usage metrics as the notice is.
    await sendInParts(messaging, {
      ChannelArn: target.channelArn,
      ChimeBearer: target.bearerArn,
      text: notice.content,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      Metadata: metadata,
      continuationExtra: { messageType: notice.messageType, analytics: { classification: 'admin' } },
    });
    return true;
  } catch (err) {
    console.error(`[admin-notice] could not deliver ${notice.messageType}:`, err);
    return false;
  }
}
