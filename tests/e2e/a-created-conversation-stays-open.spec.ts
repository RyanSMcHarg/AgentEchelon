/**
 * A CONVERSATION THE PERSON CREATES IS THE ONE THAT STAYS OPEN, after they have opened another from the list.
 *
 * Opening a conversation from the sidebar writes its id into the URL (`?conversation=<id>`), and the app opens
 * the conversation a link names. Creating a conversation changes the list; a link reader that ran again on that
 * change read the URL, which still named the conversation opened before, and sent the person back to it. A first
 * conversation after sign-in never showed it, because nothing had written the URL yet, so this opens one from the
 * sidebar first.
 *
 * Asserted on what the person sees: which sidebar item is the open one, and the URL that names it, after the
 * list has settled. Gated behind a live E2E_BASE_URL and a provisioned premium user.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import type { Page } from '@playwright/test';

guardConsoleErrors();
guardBackendErrors('created-conversation-stays-open');

const RUNNABLE = !!process.env.E2E_BASE_URL;

/** Create a conversation through the modal, and return the id the server gave it. */
async function create(page: Page): Promise<string> {
  const resp = page.waitForResponse((r) => r.url().includes('/create-conversation') && r.request().method() === 'POST', { timeout: 30000 });
  await createConversation(page, 'stays open', 'Premium');
  const arn: string = (await (await resp).json())?.conversation?.conversationArn || '';
  expect(arn, 'create-conversation returns the new conversation').toBeTruthy();
  return arn.split('/').pop()!;
}

const urlNames = (page: Page) => new URL(page.url()).searchParams.get('conversation');

test('a created conversation stays open after another was opened from the sidebar', async ({ page }) => {
  test.skip(!RUNNABLE, 'Needs a live E2E_BASE_URL.');
  const user = await getPremiumUser();
  test.skip(!user?.password, missingUserReason('premiumUser'));
  await signIn(page, user.email, user.password);

  const first = await create(page);
  const second = await create(page);
  expect(second).not.toBe(first);

  // The person opens the earlier conversation from the sidebar, which writes it into the URL. By its id, not its place:
  // the list is ordered by activity, so a welcome landing in the first conversation after the second was created moves it
  // back to the top.
  await page.locator(`.conversation-item[data-conversation-id="${first}"]`).click();
  await expect.poll(() => urlNames(page), { timeout: 15000 }).toBe(first);

  // Then creates a third. It is the open conversation, and it stays that way once the list has changed.
  const third = await create(page);
  await expect.poll(() => urlNames(page), { timeout: 15000 }).toBe(third);
  await expect(page.locator('.conversation-item').first()).toHaveClass(/\bactive\b/);
  // HELD, not sampled once: a late reopen of the earlier conversation would come AFTER the new one was shown.
  await page.waitForTimeout(5000);
  expect(urlNames(page), 'the URL still names the conversation just created').toBe(third);
  await expect(page.locator('.conversation-item.active')).toHaveCount(1);
  await expect(page.locator('.conversation-item').first()).toHaveClass(/\bactive\b/);
});
