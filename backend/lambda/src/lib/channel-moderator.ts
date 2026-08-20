/**
 * "Is this person a moderator of this channel?" - asked of Amazon Chime SDK, every time.
 *
 * Moderation is CHANNEL-SCOPED authority (`ChannelModerator`) and is not the same thing as channel
 * membership, nor as app-instance administration. Actions that reach into other people's work in a
 * conversation - redacting a message, turning Battle Mode off, ending a duel somebody else started -
 * gate on this and not on "is signed in" or "is in the channel".
 *
 * READ LIVE, NEVER FROM A COPY. Channel-owned state may be archived, but an archive is never the
 * authority for a live decision: a stale copy grants authority that was revoked. `ListChannelModerators`
 * is the authoritative source, and `channel.Metadata` in particular is member-WRITABLE, so it can never
 * back a decision like this one.
 *
 * FAILS CLOSED. Any AWS error denies. A transient failure that quietly granted moderator authority is a
 * worse outcome than one that makes somebody retry.
 */

import {
  ChimeSDKMessagingClient,
  ListChannelModeratorsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';

const messagingClient = new ChimeSDKMessagingClient({});

/**
 * True iff `callerArn` is a current moderator of `channelArn`.
 *
 * The caller's own ARN is the bearer: a member may list the moderators of a channel they belong to, so
 * this needs no elevated identity and grants none. A non-member's call fails at Chime and returns false,
 * which is the right answer anyway.
 */
export async function callerIsChannelModerator(
  channelArn: string,
  callerArn: string,
): Promise<boolean> {
  if (!channelArn || !callerArn) return false;
  try {
    let nextToken: string | undefined;
    do {
      const res = await messagingClient.send(new ListChannelModeratorsCommand({
        ChannelArn: channelArn,
        ChimeBearer: callerArn,
        MaxResults: 50,
        NextToken: nextToken,
      }));
      if ((res.ChannelModerators || []).some((m) => m.Moderator?.Arn === callerArn)) return true;
      nextToken = res.NextToken;
    } while (nextToken);
    return false;
  } catch (err) {
    console.warn('[channel-moderator] ListChannelModerators failed (fail-closed):', err);
    return false;
  }
}
