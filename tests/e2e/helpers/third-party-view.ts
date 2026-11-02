/**
 * WHAT SOMEBODY ELSE IN THE ROOM CAN SEE.
 *
 * A privacy test needs a third party. Asserting from the requester's own view proves nothing: a
 * targeted message is delivered TO its target, so the words of a private request appear there when
 * the design is working, and a test reading that view calls correct behavior a leak.
 *
 * The check is server-side and needs no heuristic. Amazon Chime SDK returns a targeted message only
 * to its sender and its target, so listing the channel AS A DIFFERENT MEMBER is the room's view by
 * construction: if a private request's words come back from this call, they are genuinely in the
 * room, whatever any metadata says.
 */
import { awsv as aws } from './aws';

/**
 * Put somebody else in the room.
 *
 * Added as the REQUESTER, who holds CreateChannelMembership for a channel they are in - the same
 * grant the product uses when a person shares a conversation. Idempotent: an existing membership
 * comes back as a conflict, which is success for this purpose.
 */
export function addMember(channelArn: string, memberArn: string, asArn: string): boolean {
  try {
    aws(['chime-sdk-messaging', 'create-channel-membership',
      '--channel-arn', channelArn, '--member-arn', memberArn,
      '--type', 'DEFAULT', '--chime-bearer', asArn]);
    return true;
  } catch (err) {
    return String((err as Error)?.message || '').includes('Conflict');
  }
}

/** One message as a given member sees it. */
export interface VisibleMessage {
  messageId: string;
  /** The sender's member ARN. An assistant's contains `/bot/`, which is how a reply is told from a send. */
  senderArn: string;
  content: string;
  createdAt: string;
  /**
   * When the message last changed. An assistant's answer is posted as a placeholder and then updated to
   * the finished text, so for an answer this is when the work finished, which createdAt is not.
   */
  lastUpdatedAt: string;
}

/**
 * Every message this member can actually see, decoded, newest last, WITH ITS SENDER AND TIME.
 *
 * The sender is the half a privacy test cannot do without: "the room cannot see it" is a claim about
 * a particular message, and content alone cannot tell an assistant's reply from the request that
 * provoked it - which matters most where both are private and the words overlap.
 */
export function messageRowsVisibleTo(channelArn: string, memberArn: string): VisibleMessage[] {
  try {
    const r = aws(['chime-sdk-messaging', 'list-channel-messages',
      '--channel-arn', channelArn, '--chime-bearer', memberArn, '--max-results', '50']);
    return (r?.ChannelMessages || []).map((m: any) => {
      const raw = String(m?.Content || '');
      let content = raw;
      try {
        content = decodeURIComponent(raw);
      } catch {
        content = raw;
      }
      return {
        messageId: String(m?.MessageId || ''),
        senderArn: String(m?.Sender?.Arn || ''),
        content,
        createdAt: String(m?.CreatedTimestamp || ''),
        lastUpdatedAt: String(m?.LastUpdatedTimestamp || m?.CreatedTimestamp || ''),
      };
    });
  } catch {
    return [];
  }
}

/** Every message this member can actually see, decoded, newest last. */
export function messagesVisibleTo(channelArn: string, memberArn: string): string[] {
  return messageRowsVisibleTo(channelArn, memberArn).map((m) => m.content);
}

/**
 * The assistant's member ARN in this conversation, read from the MEMBERSHIP.
 *
 * The alternative is to send a message and take the ARN off the reply, which is what the 1:1 specs
 * do because there it costs one turn and always works. In a group it does not: a plain message is
 * not routed to the assistant at all - the AUTO trigger counts the other non-hidden members - so
 * waiting for a reply to learn the address of the thing you have to address is circular, and fails
 * as a timeout that looks like a broken assistant rather than a wrong assumption.
 *
 * Returns '' when the channel has no bot member, which a caller should treat as a precondition.
 */
/**
 * WHAT AN ASSISTANT IS CALLED IN THIS CONVERSATION, read from the live roster (its membership name).
 *
 * The name comes from the assistant's profile version and changes at runtime (`apply-assistant-name.ts`),
 * so a spec that typed `@Assistant-premium` passed on the deployment it was written against and failed
 * after a rename for a reason that looks like routing. The membership name is the one the room shows and
 * the one the composer resolves a mention against. `botArn` picks one assistant when several are members;
 * '' when none matches, which a caller should treat as a precondition.
 */
export function assistantNameIn(channelArn: string, asArn: string, botArn?: string): string {
  try {
    const r = aws(['chime-sdk-messaging', 'list-channel-memberships',
      '--channel-arn', channelArn, '--chime-bearer', asArn, '--max-results', '50']);
    const members: Array<{ Member?: { Arn?: string; Name?: string } }> = r?.ChannelMemberships || [];
    const bot = members.find((m) => (botArn ? m?.Member?.Arn === botArn : (m?.Member?.Arn || '').includes('/bot/')));
    return bot?.Member?.Name || '';
  } catch {
    return '';
  }
}

/** Every assistant member of this conversation, with the name the live roster gives it. */
export function assistantsIn(channelArn: string, asArn: string): Array<{ arn: string; name: string }> {
  try {
    const r = aws(['chime-sdk-messaging', 'list-channel-memberships',
      '--channel-arn', channelArn, '--chime-bearer', asArn, '--max-results', '50']);
    const members: Array<{ Member?: { Arn?: string; Name?: string } }> = r?.ChannelMemberships || [];
    return members
      .filter((m) => (m?.Member?.Arn || '').includes('/bot/'))
      .map((m) => ({ arn: m.Member!.Arn!, name: m.Member?.Name || '' }));
  } catch {
    return [];
  }
}

export function assistantArnIn(channelArn: string, asArn: string): string {
  try {
    const r = aws(['chime-sdk-messaging', 'list-channel-memberships',
      '--channel-arn', channelArn, '--chime-bearer', asArn, '--max-results', '50']);
    const members: Array<{ Member?: { Arn?: string } }> = r?.ChannelMemberships || [];
    return members.map((m) => m?.Member?.Arn || '').find((arn) => arn.includes('/bot/')) || '';
  } catch {
    return '';
  }
}
