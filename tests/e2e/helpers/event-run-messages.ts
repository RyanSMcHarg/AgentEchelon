/**
 * A ROOM'S MESSAGES AS ONE MEMBER SEES THEM, WITH WHAT THE PLATFORM RECORDED ON EACH (ADR-061, ADR-062).
 *
 * Amazon Chime SDK returns a targeted message only to its sender and its targets, so listing a channel as a
 * given member is that member's view by construction. Each message carries its Metadata, which is where an
 * event workflow records itself: `eventStep` names the workflow, the step, the event and the outcome, and
 * `eventRun.runKey` names the run (`person-joined#...`, `invitation-sent#invitation-<id>#...`). A spec reads
 * which step posted a message from there, never from its words.
 */
import { awsv } from './aws';
import { trackConversation } from './watchdog/current';
import { untilRoomChanges } from './watchdog/wire-wait';

/** One message as a member sees it. */
export interface RoomMessage {
  messageId: string;
  senderArn: string;
  /** The content as posted, URI-decoded where it was encoded. */
  content: string;
  /** The words a person reads: the hidden turn markers stripped. */
  text: string;
  /** The members a targeted message is addressed to; empty for a room message. */
  target: string[];
  /** The parsed Metadata, or an empty object when the message carries none. */
  meta: Record<string, any>;
  createdAt: string;
}

const decode = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const parse = (raw: unknown): Record<string, any> => {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** Every message `memberArn` can see in the room, oldest first, read as that member. */
export function roomMessagesSeenBy(channelArn: string, memberArn: string): RoomMessage[] {
  trackConversation(channelArn);
  const out: RoomMessage[] = [];
  let next = '';
  for (let page = 0; page < 10; page += 1) {
    const r = awsv(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', channelArn,
      '--chime-bearer', memberArn, '--max-results', '50', ...(next ? ['--next-token', next] : [])]);
    for (const m of (r?.ChannelMessages ?? []) as any[]) {
      const content = decode(String(m?.Content || ''));
      out.push({
        messageId: String(m?.MessageId || ''),
        senderArn: String(m?.Sender?.Arn || ''),
        content,
        text: content.replace(/<!--[\s\S]*?-->/g, '').trim(),
        target: ((m?.Target ?? []) as any[]).map((t) => String(t?.MemberArn || '')).filter(Boolean),
        meta: parse(m?.Metadata),
        createdAt: String(m?.CreatedTimestamp || ''),
      });
    }
    next = String(r?.NextToken || '');
    if (!next) break;
  }
  return out.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * The room as `memberArn` sees it, once `done` accepts it: read now, then again on each of the room's message
 * events. Returns the last view when `timeoutMs` passes, so an assertion on it reports what was seen.
 */
export function roomMessagesUntil(
  channelArn: string, memberArn: string, done: (ms: RoomMessage[]) => boolean, opts: { timeoutMs?: number } = {},
): Promise<RoomMessage[]> {
  return untilRoomChanges(channelArn, memberArn, () => roomMessagesSeenBy(channelArn, memberArn), done, opts);
}

/** The event workflow step that posted a message, or '' for a message no run posted. */
export const stepOf = (m: RoomMessage): string => String(m.meta?.eventStep?.step || '');

/**
 * Whether a message is a continuation part of a long response: one response may be split across continuation messages
 * (`sendInParts`, `lib/chime/send.ts`), each naming the message it continues as `parentMessageId`.
 */
export const isContinuation = (m: RoomMessage): boolean => m.meta?.continuation === true;

/** The parts of the response `head` starts, as `ms` holds them: the head, then its continuations in part order. */
export function partsOf(head: RoomMessage, ms: RoomMessage[]): RoomMessage[] {
  const rest = ms.filter((m) => isContinuation(m) && m.meta?.parentMessageId === head.messageId)
    .sort((a, b) => Number(a.meta?.part ?? 0) - Number(b.meta?.part ?? 0));
  return [head, ...rest];
}

/** The event a run that posted the message was started by, or ''. */
export const eventOf = (m: RoomMessage): string => String(m.meta?.eventStep?.event || '');

/** The run key a message carries, or ''. */
export const runKeyOf = (m: RoomMessage): string => String(m.meta?.eventRun?.runKey || '');

/**
 * Whether a message is an assistant's join greeting, the `WelcomeIntent` answer: declared `welcome`, on its Metadata
 * or by the `<!--turn:kind=welcome-->` declaration it carries (`withTurnDeclaration`).
 */
export function isJoinGreeting(m: RoomMessage): boolean {
  return m.senderArn.includes('/bot/') && (m.meta?.turnKind === 'welcome' || /<!--turn:[^>]*\bkind=welcome\b/.test(m.content));
}

/**
 * Whether a message is a welcome addressed to `personArn`: a run's send to them, the share's `memberWelcome`
 * (`systemAnnouncement: 'join_summary'`), or a join's greeting (`isJoinGreeting`). A join recap is a catch-up, not a
 * welcome, and is counted apart.
 */
export function isWelcomeTo(m: RoomMessage, personArn: string): boolean {
  if (!m.target.includes(personArn) || !m.senderArn.includes('/bot/')) return false;
  if (m.meta?.systemAnnouncement === 'join_summary' || isJoinGreeting(m)) return true;
  const step = stepOf(m);
  return Boolean(step) && !step.startsWith('join-recap--') && m.meta?.turnKind !== 'event_step';
}
