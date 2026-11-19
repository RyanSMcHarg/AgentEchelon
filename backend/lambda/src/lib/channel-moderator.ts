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
  DescribeChannelModeratorCommand,
  ListChannelModeratorsCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { sessionClient } from './assistant-session.js';

const messagingClient = sessionClient(ChimeSDKMessagingClient, {});

/** What asks Amazon Chime SDK messaging one command: a messaging client, or a test's. */
export interface ModeratorReader { send(command: unknown): Promise<unknown> }

/**
 * WHETHER A PERSON MODERATES A CONVERSATION, asked of Amazon Chime SDK for that one moderator (`DescribeChannelModerator`)
 * with the person as their own bearer, through the caller's client. The one per-person check every meeting decision and
 * every other caller holding that action reads; any failure denies, and one that is not the service's plain "no" is logged.
 * A function that acts as the app instance's service admin asks with that bearer (`opts.bearer`), never as the person.
 */
export async function personModeratesChannel(
  messaging: ModeratorReader, channelArn: string, personArn: string, opts: { bearer?: string } = {},
): Promise<boolean> {
  const bearer = opts.bearer ?? personArn;
  if (!channelArn || !personArn || !bearer) return false;
  try {
    await messaging.send(new DescribeChannelModeratorCommand({ ChannelArn: channelArn, ChannelModeratorArn: personArn, ChimeBearer: bearer }));
    return true;
  } catch (err) {
    const name = (err as Error)?.name;
    if (name !== 'NotFoundException' && name !== 'ForbiddenException') console.warn('[channel-moderator] a moderator read failed; it denies', { err: name });
    return false;
  }
}

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
