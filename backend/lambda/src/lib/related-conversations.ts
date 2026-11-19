/**
 * THE CONVERSATIONS A TURN MAY READ BESIDE ITS OWN (DESIGN-WORKFLOWS-AND-TASKS section 6, "A child's relation to its
 * parent").
 *
 * A `thread` child works part of its parent's subject, so a turn in either reads the other's latest summary as
 * grounding. A `move` child shares nothing: the subject left, and only the links remain. Which one a child is, is its
 * conversation type's declaration (`relation`), never a turn's judgement.
 *
 * A SUMMARY REACHES ONLY PEOPLE WHO COULD ALREADY READ IT (rule 5). A summary read into a turn may be repeated in its
 * reply, so another conversation is read only where every person in this one is a member of it, read live from Amazon
 * Chime SDK membership and never from a stored copy. The read is made as the turn's assistant, whose role reaches only
 * its own classification's conversations (ADR-042), so a conversation of another classification is refused there. A
 * conversation whose members cannot be read is not read.
 */
import type { ChannelContext } from './channel-context-client.js';
import { relationOf } from '../../../lib/config/conversation-types.js';
import { CONVERSATION_ID } from './dashboard-keys.js';
import { appInstanceArnOf } from './person-arn.js';

/** Another conversation a turn reads: this one's `thread` parent, or one of its `thread` children. */
export interface RelatedConversation {
  channelArn: string;
  relation: 'parent' | 'child';
}

/** At most this many children are read: the most recently opened of those a turn may read. */
export const MAX_CHILDREN_READ = 3;

/**
 * How many of the newest children are considered for those three. An incident that has ended and expired fails the
 * membership read, so the next older one is read in its place: one still open is not crowded out by newer ones that ended.
 */
export const CHILDREN_CONSIDERED = 6;

/** Every relative a turn names: its parent, and the children considered. The cap on what rides a dispatch and a routing record. */
export const MAX_RELATIVES_NAMED = 1 + CHILDREN_CONSIDERED;

export interface RelatedConversationDeps {
  /** The people in a conversation now, as AppInstanceUser ARNs, read as the turn's assistant; null when membership cannot be read. */
  peopleOf: (channelArn: string) => Promise<string[] | null>;
}

/**
 * The conversation a `?conversation=<id>` link names (a row's `parentRef`, or the link a creator hands back), as a
 * channel ARN under this conversation's app instance. The one parse of that server-written link: an id outside the
 * platform's conversation-id rule, or one that does not decode, names nothing.
 */
export function parentArnOf(channelArn: string, parentRef: string | undefined): string | undefined {
  const id = /[?&]conversation=([^&#]+)/.exec(typeof parentRef === 'string' ? parentRef : '')?.[1];
  const app = appInstanceArnOf(channelArn);
  if (!id || !app) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(id); } catch { return undefined; }
  return CONVERSATION_ID.test(decoded) ? `${app}/channel/${decoded}` : undefined;
}

/** The `thread` relatives a conversation's row names, before any is checked: its parent, then its newest children. */
export function threadRelatives(channelArn: string, row: Pick<ChannelContext, 'children' | 'parentRef' | 'conversationType'> | null | undefined): RelatedConversation[] {
  if (!row) return [];
  const out: RelatedConversation[] = [];
  const parent = relationOf(row.conversationType) === 'thread' ? parentArnOf(channelArn, row.parentRef) : undefined;
  if (parent) out.push({ channelArn: parent, relation: 'parent' });
  const app = appInstanceArnOf(channelArn);
  const children = (row.children ?? []).filter((c) => c?.channelId && CONVERSATION_ID.test(c.channelId) && relationOf(c.typeKey) === 'thread').slice(-CHILDREN_CONSIDERED).reverse();
  if (app) for (const c of children) out.push({ channelArn: `${app}/channel/${c.channelId}`, relation: 'child' });
  return out;
}

/**
 * The relatives this turn may read: each named relative whose members include every person here. Empty where there are
 * none, or where nothing could be read.
 */
export async function readableRelatives(
  args: { channelArn: string; candidates: readonly RelatedConversation[] },
  deps: RelatedConversationDeps,
): Promise<RelatedConversation[]> {
  const { candidates } = args;
  if (!candidates.length) return [];
  // BOTH SIDES AT ONCE: this conversation's people and each relative's, read together.
  const [here, ...theirs] = await Promise.all([args.channelArn, ...candidates.map((c) => c.channelArn)].map((arn) => deps.peopleOf(arn).catch(() => null)));
  // A CONVERSATION WITH NOBODY IN IT READS NOTHING: a summary grounded here would reach whoever joins later, unchecked.
  if (!here?.length) return [];
  const passed = candidates.filter((_, i) => {
    const members = new Set(theirs[i] ?? []);
    return here.every((p) => members.has(p));
  });
  // THE PARENT, AND THE NEWEST CHILDREN THAT PASSED, at most three of them.
  return [...passed.filter((c) => c.relation === 'parent'), ...passed.filter((c) => c.relation === 'child').slice(0, MAX_CHILDREN_READ)];
}
