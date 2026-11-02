/**
 * A conversation's recent messages, and the one decode of a message's content.
 *
 * Every reader of a conversation's history lists it here: the turn's prompt history
 * (`loadChannelHistory`), the placeholder scan, the inbound-message match (`findInboundMessage`) and
 * the router's attachment read-back. Each applies its own filter to what is listed; the listing, its
 * order and its bound are the same for all of them.
 */
import { ListChannelMessagesCommand, type ChannelMessageSummary } from '@aws-sdk/client-chime-sdk-messaging';

type MessageLister = {
  send: (cmd: ListChannelMessagesCommand) => Promise<{ ChannelMessages?: ChannelMessageSummary[]; NextToken?: string }>;
};

/** The most a single listing returns (the Amazon Chime SDK limit). */
export const MAX_LISTED_MESSAGES = 50;

/**
 * The channel's newest messages, newest first, as `bearer` sees them. Throws when the read fails: a
 * caller decides whether an unreadable history is an empty one.
 */
export async function recentChannelMessages(
  client: MessageLister,
  channelArn: string,
  bearer: string,
  maxResults = 20,
): Promise<ChannelMessageSummary[]> {
  const res = await client.send(new ListChannelMessagesCommand({
    ChannelArn: channelArn,
    ChimeBearer: bearer,
    MaxResults: Math.min(maxResults, MAX_LISTED_MESSAGES),
    SortOrder: 'DESCENDING',
  }));
  return res?.ChannelMessages || [];
}

/**
 * EVERY message of the channel, page by page, as `bearer` sees them: for erasure, which must reach the
 * oldest message as well as the newest (`lib/offboarding.ts`). Throws when a read fails.
 */
export async function everyChannelMessage(client: MessageLister, channelArn: string, bearer: string): Promise<ChannelMessageSummary[]> {
  const out: ChannelMessageSummary[] = [];
  let NextToken: string | undefined;
  do {
    const res = await client.send(new ListChannelMessagesCommand({ ChannelArn: channelArn, ChimeBearer: bearer, MaxResults: MAX_LISTED_MESSAGES, NextToken }));
    out.push(...(res?.ChannelMessages || []));
    NextToken = res?.NextToken;
  } while (NextToken);
  return out;
}

/** Amazon Chime SDK may carry content URL-encoded. Content that will not decode is returned as sent. */
export function decodeContent(content: string): string {
  try {
    return decodeURIComponent(content);
  } catch {
    return content;
  }
}
