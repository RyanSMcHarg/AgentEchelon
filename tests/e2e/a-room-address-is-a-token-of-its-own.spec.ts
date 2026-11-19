/**
 * A ROOM ADDRESS IS A TOKEN OF ITS OWN, AND `@humans` ADDRESSES THE PEOPLE (MESSAGE-FLOW, SPEC-NOTIFICATION-BRIDGE).
 *
 * In a room of two people an ordinary message starts no assistant turn, so the turns counted here are the ones an
 * address starts:
 *  - `@humans`, picked from the composer's list (badged PEOPLE), reaches the room and no assistant takes a turn on it;
 *  - `@all` after punctuation is still `@all`, and is answered exactly once;
 *  - `hey@all`, `x@all.example` and `@all-hands` address nobody, so they start no turn.
 *
 * Counts are read from the channel as stored, never from a page: "no reply yet" and "no reply" look the same in a DOM.
 * The room is opened through the person routes and archived at the end.
 */
import { test, expect } from './helpers/fixtures';
import type { Page } from '@playwright/test';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signIn } from './helpers/agent-helpers';
import { getPremiumUser, getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { idTokenFor, personArnFromIdToken } from './helpers/person';
import { archive, openConversation, shareWith } from './helpers/person-session';
import { assistantResponseCount } from './helpers/drift-backend';
import { messagesVisibleTo } from './helpers/third-party-view';
import { awsv } from './helpers/aws';
import { PERSON_API_URL } from './helpers/api-urls';

guardBackendErrors('a-room-address-is-a-token-of-its-own');
guardConsoleErrors();

/** Long enough that a turn a message started has posted its answer: a turn answers in seconds. */
const SETTLE_MS = 25_000;

test.describe.serial('a room address is a token of its own', () => {
  test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is required');
  test.skip(!hasTestCredentials(), 'needs the provisioned test users');

  let ownerToken = '';
  let ownerArn = '';
  let otherArn = '';
  let channelArn = '';
  let page: Page;

  /** Post as a member of the room, as their own bearer. */
  const postAs = (bearer: string, content: string) => awsv(['chime-sdk-messaging', 'send-channel-message',
    '--channel-arn', channelArn, '--content', content, '--type', 'STANDARD', '--persistence', 'PERSISTENT', '--chime-bearer', bearer]);

  test.beforeAll(async ({ browser }) => {
    const creds = await getTestCredentials();
    const owner = await getPremiumUser();
    const other = await getSecondPremiumUser();
    test.skip(!owner.password, missingUserReason('premiumUser'));
    test.skip(!other?.password, missingUserReason('secondPremiumUser'));
    ownerToken = idTokenFor(owner.email, owner.password, creds.cognitoClientId);
    ownerArn = await personArnFromIdToken(ownerToken);
    otherArn = await personArnFromIdToken(idTokenFor(other!.email, other!.password, creds.cognitoClientId));
    ({ channelArn } = await openConversation(ownerToken, `Room address e2e ${Date.now()}`));
    const shared = await shareWith(ownerToken, channelArn, 'Room address e2e', other!.email);
    expect(shared.status, JSON.stringify(shared.body).slice(0, 300)).toBe(200);
    // The welcome and the share's own lines settle before anything is counted.
    await new Promise((r) => setTimeout(r, 15_000));
    page = await browser.newPage();
    await signIn(page, owner.email, owner.password);
  });

  test.afterAll(async () => {
    await page?.close();
    if (channelArn) await archive(ownerToken, channelArn);
  });

  test('@humans is picked from the composer, reaches the room, and starts no assistant turn', async () => {
    test.setTimeout(180_000);
    const channelId = channelArn.split('/channel/')[1];
    await page.goto(`/?conversation=${channelId}`);
    const input = page.locator('.message-textarea');
    await expect(input).toBeEnabled({ timeout: 30_000 });

    const before = await assistantResponseCount(channelArn);
    await input.fill('@');
    const people = page.locator('.mention-option', { has: page.locator('.mention-option-badge', { hasText: 'PEOPLE' }) });
    await expect(people, 'the composer offers @humans, badged PEOPLE').toBeVisible({ timeout: 10_000 });
    await expect(people.locator('.mention-option-name')).toContainText('humans');
    await people.click();
    await expect(input).toHaveValue(/^@humans /);
    const said = `HUMANS${Date.now().toString(36).toUpperCase()}`;
    await input.press('End');
    await input.pressSequentially(`the deck is ready for review ${said}`);
    await input.press('Enter');

    await page.waitForTimeout(SETTLE_MS);
    expect(await assistantResponseCount(channelArn), 'an assistant took a turn on @humans').toBe(before);
    expect(messagesVisibleTo(channelArn, otherArn).some((c) => c.includes(said)), 'the other person in the room reads the @humans message').toBe(true);
  });

  test('a token run into a word or an address addresses nobody', async () => {
    test.setTimeout(120_000);
    const before = await assistantResponseCount(channelArn);
    postAs(ownerArn, 'hey@all could someone check the numbers');
    postAs(ownerArn, 'write to x@all.example about the invoice');
    postAs(ownerArn, 'see you at the @all-hands meeting');
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await assistantResponseCount(channelArn), 'a room address inside a word or an address started an assistant turn').toBe(before);
  });

  test('@all after punctuation is still @all, and is answered once', async () => {
    test.setTimeout(180_000);
    const before = await assistantResponseCount(channelArn);
    postAs(ownerArn, '(@all) name one planet in our solar system, in one word.');
    let after = before;
    for (let i = 0; i < 12 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 5_000));
      after = await assistantResponseCount(channelArn);
    }
    // A second answer would land within the same window, so the count is read again once the first has settled.
    await new Promise((r) => setTimeout(r, 15_000));
    expect(await assistantResponseCount(channelArn), '(@all) is answered exactly once').toBe(before + 1);
  });
});
