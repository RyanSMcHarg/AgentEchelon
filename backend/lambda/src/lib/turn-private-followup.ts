/**
 * SHARED FIRST, IN THE OPEN. THEN EACH PERSON PRIVATELY (DESIGN 2.4.2).
 *
 * A queue can hold several people's messages, and they are not all the same kind of thing. What is
 * everyone's belongs in the room, where everyone can see what was understood and what is being done.
 * What one person sent privately belongs with that person alone, and putting it in the same public
 * paragraph would publish it in the act of confirming it.
 *
 * ── THE ORDER IS PART OF THE RULE, NOT AN IMPLEMENTATION DETAIL ─────────────────────────────────
 *
 * Shared subjects are addressed and acted on FIRST, and they do not wait on anybody's private answer.
 * A room whose common work is blocked while one person is asked to confirm something the others
 * cannot see is a room where nothing visible is happening for no visible reason. Only once the shared
 * half has been dealt with does the assistant go to each person about theirs.
 *
 * ── AND THE ROOM IS TOLD THAT SOMETHING IS HAPPENING, WITHOUT BEING TOLD WHAT ───────────────────
 *
 * While the private half runs, the public placeholder carries a GENERIC line. It says the assistant
 * is dealing with private requests and nothing else: not whose, not how many, not what about. Silence
 * would read as the turn having stalled, and detail would defeat the point of the message being
 * private in the first place.
 */

import { templateLine } from './message-lines.js';
import type { ChimeSDKMessagingClient } from '@aws-sdk/client-chime-sdk-messaging';
import { userArnFor } from './person-arn.js';
import { sendInParts } from './chime/send.js';

export interface PrivateSubject {
  label: string;
  /** A principal id, never a full ARN: see `PendingSplitOffer`. */
  requestorId?: string;
  private?: boolean;
}

/**
 * The private subjects grouped by the person whose they are.
 *
 * BY PERSON, not by subject, because the unit of the conversation is the person: somebody with three
 * private subjects should get one message about three things, not three messages. Three notifications
 * for one turn is how a private channel becomes something people mute.
 */
export function privateSubjectsByRequestor(
  topics: PrivateSubject[],
): Array<{ requestorId: string; labels: string[] }> {
  const byPerson = new Map<string, string[]>();
  for (const topic of topics) {
    if (!topic.private || !topic.requestorId || !topic.label) continue;
    const existing = byPerson.get(topic.requestorId);
    if (existing) existing.push(topic.label);
    else byPerson.set(topic.requestorId, [topic.label]);
  }
  return [...byPerson.entries()].map(([requestorId, labels]) => ({ requestorId, labels }));
}

/**
 * The ARN that addresses a message to somebody, rebuilt from the id the record keeps.
 *
 * Derived rather than stored, which is why the record holds principal ids: the app instance is a
 * property of the DEPLOYMENT, not of the subject somebody asked about, and writing it onto every
 * queued subject would store the account and region forever to save this line.
 */
export function addressOf(appInstanceArn: string, requestorId: string): string {
  return userArnFor(appInstanceArn, requestorId);
}

/**
 * What the room sees while the private half runs.
 *
 * The `addressing-privately` message template, the assistant's own where it saved one, like every other line this path
 * can add: the words belong to the deployment and to the language the conversation is being held in, not to this file.
 * Whatever a deployment writes must stay GENERIC - naming a person or a subject here would publish exactly what
 * the private message exists to keep private.
 */
export function addressingPrivatelyLine(words?: object | null): string {
  return templateLine('addressing-privately', { copy: words });
}

/**
 * Send each person one message about their own private subjects, and nobody else's.
 *
 * BEST EFFORT, PER PERSON. One failed send costs that person a confirmation; letting it throw would
 * lose the confirmations of everybody after them in the loop, and the shared half has already
 * happened either way.
 */
export async function sendPrivateFollowUps(args: {
  chime: ChimeSDKMessagingClient;
  channelArn: string;
  botArn: string;
  /** The deployment's app instance, which is what turns a principal id back into an address. */
  appInstanceArn: string;
  groups: Array<{ requestorId: string; labels: string[] }>;
  /** Deployment copy, given the subjects to name. Defaulted when the deployment says nothing. */
  compose?: (labels: string[]) => string;
  /** The version's `copy`, with the turn's stored templates: the `private-follow-up` template's wording. */
  copy?: object | null;
}): Promise<string[]> {
  const notified: string[] = [];
  for (const group of args.groups) {
    const text = args.compose
      ? args.compose(group.labels)
      : templateLine('private-follow-up', { copy: args.copy }, { count: group.labels.length, values: { labels: group.labels.join(', ') } });
    try {
      await sendInParts(args.chime, {
        ChannelArn: args.channelArn,
        text,
        Type: 'STANDARD',
        Persistence: 'PERSISTENT',
        ChimeBearer: args.botArn,
        // THE WHOLE POINT. Without this the message is in the room, and the confirmation of a private
        // request becomes its publication.
        Target: [{ MemberArn: addressOf(args.appInstanceArn, group.requestorId) }],
      });
      notified.push(group.requestorId);
    } catch (err) {
      console.error('[turn-private-followup] could not reach a person about their private request', {
        channelArn: args.channelArn, message: (err as Error)?.message,
      });
    }
  }
  return notified;
}
