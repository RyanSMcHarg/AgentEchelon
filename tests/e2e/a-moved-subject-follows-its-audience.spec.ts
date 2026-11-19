/**
 * A MOVED SUBJECT FOLLOWS THE AUDIENCE OF THE MESSAGE THAT CHANGED IT (SPEC-WORKFLOWS-AND-TASKS WT88-WT93).
 *
 * Two people in one conversation, because each claim here is about somebody other than the sender:
 *  - a message to the room is offered to the room, only its sender's reply answers the offer, and the new conversation
 *    holds everyone in the room;
 *  - a private message's offer reaches its sender alone, the room is told nothing, and the new conversation holds the
 *    sender alone.
 *
 * What the other person can see is read from the service as that person (`third-party-view`): Amazon Chime SDK lists a
 * targeted message only to its sender and its target, so that call is the room's view by construction.
 */
import { test, expect } from './helpers/fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getPremiumUser, getSecondPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { driftRedirectMessage } from './helpers/drift-backend';
import { addMember, messageRowsVisibleTo, messagesVisibleTo, peopleIn } from './helpers/third-party-view';
import { personArnOf } from './helpers/person';

guardBackendErrors('a-moved-subject-follows-its-audience');
guardConsoleErrors();

const TRIGGER = "let's start a new conversation about quarterly revenue forecasting";
const OFFER = 'start a separate conversation for this';
const NAVIGATE = /NAVIGATE_CHANNEL:(arn:[^|\s]+)/;
/** The token the picker writes for an address. The new conversation quotes what the person said, not whom they said it to. */
const ADDRESS = /[.@]<[^|>]+\|/;

/** The new conversation's welcome, once it has one, for checking what it quotes. */
async function expectWelcomeWithoutAddress(child: string, asArn: string) {
  await expect.poll(() => messagesVisibleTo(child, asArn).length, { message: 'the new conversation has its welcome', timeout: 30000, intervals: [1000] }).toBeGreaterThan(0);
  expect(messagesVisibleTo(child, asArn).filter((c) => ADDRESS.test(c)), 'the welcome quotes no address').toEqual([]);
}

async function openById(page: Page, channelId: string) {
  // A just-added member's list may not hold the conversation on its first fetch, and each load fetches it again.
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(`/?conversation=${channelId}`);
    await page.waitForLoadState('networkidle');
    if (await page.locator('.message-textarea').isEnabled({ timeout: 10000 }).catch(() => false)) return;
    await page.waitForTimeout(3000);
  }
  throw new Error(`conversation ${channelId} never became selectable`);
}

/** Says a message to the assistant the way a person does: `@` or `.`, the assistant picked from the list, then the words. */
async function say(page: Page, gesture: '@' | '.', text: string) {
  const clear = page.locator('.message-input-sticky-target-clear');
  if (await clear.isVisible({ timeout: 1000 }).catch(() => false)) await clear.click();
  const box = page.locator('.message-textarea');
  await box.fill(gesture);
  const list = gesture === '.' ? page.locator('.mention-dropdown--private') : page;
  const assistant = list.locator('.mention-option', { has: page.locator('.mention-option-badge', { hasText: 'BOT' }) }).first();
  await expect(assistant).toBeVisible({ timeout: 10000 });
  await assistant.click();
  await box.press('End');
  await box.pressSequentially(text);
  await page.keyboard.press('Enter');
}

test.describe.serial('a moved subject follows the audience of its message', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let arnA: string;
  let arnB: string;

  test.beforeAll(async ({ browser }) => {
    const a = await getPremiumUser();
    const b = await getSecondPremiumUser();
    test.skip(!a.password, missingUserReason('premiumUser'));
    test.skip(!b?.password, 'Needs a second premium test user: a premium conversation admits only people cleared for it.');
    arnA = await personArnOf(a);
    arnB = await personArnOf(b!);
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    await signIn(pageA, a.email, a.password);
    await signIn(pageB, b!.email, b!.password);
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  /** A premium conversation with both people in it, open in both browsers. */
  async function roomOfTwo(title: string): Promise<string> {
    const created = pageA.waitForResponse((r) => r.url().includes('/create-conversation') && r.request().method() === 'POST', { timeout: 30000 });
    await createConversation(pageA, title, 'Premium');
    const channelArn: string = (await (await created).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'the conversation was created').toBeTruthy();
    expect(addMember(channelArn, arnB, arnA), 'the second person joined').toBe(true);
    const channelId = channelArn.split('/').pop()!;
    await openById(pageA, channelId);
    await openById(pageB, channelId);
    return channelArn;
  }

  test('a message to the room: the room sees the offer, only the sender answers it, and everyone moves', async () => {
    test.setTimeout(300000);
    const origin = await roomOfTwo(`E2E Drift Room ${Date.now()}`);

    await say(pageA, '@', TRIGGER);
    await expect.poll(() => messagesVisibleTo(origin, arnB).some((c) => c.toLowerCase().includes(OFFER)), {
      message: 'the second person sees the offer', timeout: 60000, intervals: [2000],
    }).toBe(true);

    // ONLY THE SENDER'S REPLY ANSWERS: a yes from anyone else moves nothing, and the offer is still there to answer.
    await say(pageB, '@', 'yes');
    await pageB.waitForTimeout(30000);
    expect(await driftRedirectMessage(origin), "another person's yes moved nothing").toBeNull();

    await say(pageA, '@', 'yes');
    await expect.poll(async () => (await driftRedirectMessage(origin))?.childChannelArn ?? '', {
      message: "the sender's yes moved the subject", timeout: 90000, intervals: [2000],
    }).not.toBe('');
    const child = (await driftRedirectMessage(origin))!.childChannelArn;
    expect(peopleIn(child, arnA), 'the new conversation holds everyone in the room').toEqual(expect.arrayContaining([arnA, arnB]));
    await expectWelcomeWithoutAddress(child, arnA);

    // The link that navigates goes to its sender alone, since it moves whoever receives it.
    expect(messagesVisibleTo(origin, arnA).some((c) => NAVIGATE.test(c)), 'the sender is told where').toBe(true);
    expect(messagesVisibleTo(origin, arnB).some((c) => NAVIGATE.test(c)), 'the other person is not navigated').toBe(false);
  });

  test('a private message: its sender alone is offered, the room is told nothing, and its sender alone moves', async () => {
    test.setTimeout(300000);
    const origin = await roomOfTwo(`E2E Drift Private ${Date.now()}`);

    await say(pageA, '.', TRIGGER);
    await expect.poll(() => messagesVisibleTo(origin, arnA).some((c) => c.toLowerCase().includes(OFFER)), {
      message: 'the sender is offered the move', timeout: 60000, intervals: [2000],
    }).toBe(true);

    await say(pageA, '.', 'yes');
    const childOf = () => messageRowsVisibleTo(origin, arnA).map((m) => m.content.match(NAVIGATE)?.[1]).find(Boolean) ?? '';
    await expect.poll(childOf, { message: 'the sender is told where', timeout: 90000, intervals: [2000] }).not.toBe('');
    const child = childOf();

    const people = peopleIn(child, arnA);
    expect(people, 'the sender moved').toContain(arnA);
    expect(people, 'nobody else moved with a private message').not.toContain(arnB);
    await expectWelcomeWithoutAddress(child, arnA);

    // THE ROOM IS TOLD NOTHING, and it can read the conversation, so its seeing none of this means something.
    expect(await driftRedirectMessage(origin), 'no link is left in the room').toBeNull();
    const roomSees = messagesVisibleTo(origin, arnB);
    expect(roomSees.length, 'the second person can read the conversation at all').toBeGreaterThan(0);
    expect(roomSees.filter((c) => c.includes(TRIGGER) || c.toLowerCase().includes(OFFER) || NAVIGATE.test(c)), 'the private exchange stayed private').toEqual([]);
  });
});
