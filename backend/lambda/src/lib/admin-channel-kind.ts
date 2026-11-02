/**
 * Which conversation is the admin notification channel, read from the live channel.
 *
 * The provisioner stamps `aeChannelKind=admin-notifications` on the channel IN its CreateChannel call,
 * the alert grant already authorizes on that tag, and a tag is not member-writable. So "is this the
 * admin conversation" is answered from the Amazon Chime SDK itself rather than from any stored copy.
 */
import type { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { readChannelTags } from './channel-classification.js';

export const ADMIN_CHANNEL_TAG_KEY = 'aeChannelKind';
export const ADMIN_CHANNEL_TAG_VALUE = 'admin-notifications';

/** True only when the channel carries the admin kind tag. An unreadable tag is false (fail closed). */
export async function isAdminNotificationChannel(client: ChimeSDKMessagingClient, channelArn: string): Promise<boolean> {
  try {
    return (await readChannelTags(client, channelArn))[ADMIN_CHANNEL_TAG_KEY] === ADMIN_CHANNEL_TAG_VALUE;
  } catch (err) {
    console.warn('[admin-channel-kind] could not read the channel tags; treating it as not the admin conversation', {
      channelArn, err: (err as Error)?.name,
    });
    return false;
  }
}
