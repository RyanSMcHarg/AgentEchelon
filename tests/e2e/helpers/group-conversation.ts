/**
 * A CONVERSATION WITH MORE THAN TWO PEOPLE IN IT, which several requirements need and no spec had.
 *
 * The queue specs are 1:1 by design and that is the right shape for what they assert - but three
 * behaviors are inert below three members, so testing them there proves nothing:
 *
 *   - THE ADDRESSED REPLY. `resolveTaskAnswer` returns null when `channelMembers.length <= 2`
 *     (MessageInput.tsx), deliberately: in a 1:1 the AUTO trigger routes every message to the
 *     assistant, so addressing would only make the person's own message private for no reason. A 1:1
 *     therefore has no addressed path at all.
 *   - A SPLIT OFFER COVERING TWO PEOPLE. An offer deliberately holds several speakers' subjects and
 *     is read per speaker; with one speaker there is no second offer to destroy.
 *   - ANYTHING ABOUT WHAT THE ROOM SEES, where a room of two is no room.
 *
 * WHY MEMBERSHIP RATHER THAN A SECOND CONVERSATION. The membership is what the product changes when
 * somebody shares a conversation, and it is the number the client reads to decide whether addressing
 * is available. Standing up a second 1:1 would exercise neither.
 *
 * The extra members are added AS THE CREATOR, who holds `CreateChannelMembership` for a channel they
 * are in - the same grant the product uses - rather than as the operator's own admin rights, so a
 * deployment where that grant is missing fails here rather than passing on borrowed authority.
 */
import type { Page, Browser } from '@playwright/test';
import { signIn, createConversation } from './agent-helpers';
import { addMember } from './third-party-view';
import { personArnOf, personIdOf } from './person';
import type { TestUser } from './test-credentials';

export interface GroupMember {
  user: TestUser;
  /** The person id, the AppInstanceUser id the exchange minted. */
  personId: string;
  /** The app-instance user ARN, which is what a task's assignee and a message's sender are keyed on. */
  arn: string;
  /** A signed-in page for this member, present only for members asked for with a page. */
  page?: Page;
}

export interface GroupConversation {
  channelArn: string;
  /** The person who created it. Their page is the one the conversation was made in. */
  creator: GroupMember;
  /** Everybody else, in the order they were asked for. */
  others: GroupMember[];
  /** Creator plus others - the whole room, which is what a member-count assertion wants. */
  members: GroupMember[];
}

/**
 * Open a conversation and put `others` in it.
 *
 * `withPages` decides whether each other member also gets a signed-in browser context. A member who
 * only needs to EXIST in the room (a third party whose view is read server-side, or a body making
 * the count exceed two) needs no page; a member who has to SPEAK does. Pages are expensive, so they
 * are opt-in rather than the default.
 *
 * Returns null when the room could not be assembled - a missing credential, or a membership the
 * creator was refused. Null rather than a throw so a caller can skip with a stated reason instead of
 * failing a suite for a deployment that is provisioned differently.
 */
export async function openGroupConversation(args: {
  page: Page;
  creator: TestUser;
  others: TestUser[];
  title?: string;
  /**
   * The classification the conversation is opened at, named as the composer labels it.
   *
   * Defaults to Premium because every caller so far is testing the QUEUE, and a queue only forms
   * while a turn is still running - a fast classification answers each message before the next
   * arrives, so the precondition never holds and the queue looks broken when it was never exercised.
   */
  classification?: string;
  /** Give each other member a signed-in page of their own. Needs `browser`. */
  withPages?: boolean;
  browser?: Browser;
}): Promise<GroupConversation | null> {
  const { page, creator, others, withPages, browser } = args;
  if (!creator.password || others.some((o) => !o.password)) return null;
  if (withPages && !browser) return null;

  await signIn(page, creator.email, creator.password);
  const createResp = page.waitForResponse(
    (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30000 },
  );
  await createConversation(page, args.title || `Group ${Date.now()}`, args.classification || 'Premium');
  const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
  if (!channelArn) return null;

  const creatorArn = await personArnOf(creator).catch(() => '');
  if (!creatorArn) return null;

  const assembled: GroupMember[] = [];
  for (const other of others) {
    const arn = await personArnOf(other).catch(() => '');
    if (!arn) return null;
    // As the CREATOR, not as the operator. See the header.
    if (!addMember(channelArn, arn, creatorArn)) return null;

    let memberPage: Page | undefined;
    if (withPages && browser) {
      // A CONTEXT OF ITS OWN, not a second tab. Sign-in state lives in storage, so two members
      // sharing a context are one member twice - and the second sign-in would silently replace the
      // first, which reads as the wrong person speaking rather than as a broken fixture.
      const ctx = await browser.newContext();
      memberPage = await ctx.newPage();
      await signIn(memberPage, other.email, other.password!);
    }
    assembled.push({ user: other, personId: personIdOf(arn), arn, ...(memberPage ? { page: memberPage } : {}) });
  }

  const creatorMember: GroupMember = { user: creator, personId: personIdOf(creatorArn), arn: creatorArn, page };
  return {
    channelArn,
    creator: creatorMember,
    others: assembled,
    members: [creatorMember, ...assembled],
  };
}

/** Close the browser contexts a group opened, leaving the caller's own page alone. */
export async function closeGroup(group: GroupConversation | null): Promise<void> {
  if (!group) return;
  for (const m of group.others) {
    if (m.page) await m.page.context().close().catch(() => { /* best effort */ });
  }
}

/**
 * Open the same conversation in another member's page.
 *
 * A member added by membership does not have the conversation SELECTED in their client, and the
 * queue behaviors under test are all about who is speaking into one room. Navigating by title is
 * what a person does, so it is what this does.
 */
export async function openConversationAs(member: GroupMember, title: string): Promise<boolean> {
  if (!member.page) return false;
  const item = member.page.locator('.conversation-item', { hasText: title }).first();
  try {
    await item.waitFor({ state: 'visible', timeout: 30000 });
    await item.click();
    await member.page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}
