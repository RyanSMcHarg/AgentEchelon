/**
 * AN INVITATION'S LINK OPENS A LANDING PAGE THAT REDEEMS NOTHING UNTIL A CLICK, AND A LINK INVITATION OPENS
 * ONE CONVERSATION FOR A WHILE, UNTIL IT IS WITHDRAWN (M-10, M-5, D-4).
 *
 * From the browser, against a deployment's chat app, which serves the landing page every invitation lands on
 * (`invitationLandingFor`):
 *
 *  1. A member invites somebody new from the share dialog with no address, so the dialog shows the link.
 *  2. The link opens the landing page in a fresh browser (no session). It names the conversation and who
 *     invited, the token leaves the address bar, and the response sends `Referrer-Policy: no-referrer`.
 *     Reloading it changes nothing: the invitation still waits.
 *  3. A sign-in invitation's Join sends the holder to the chat app's sign-in, carrying the token in that
 *     page's fragment, and the chat app takes it out of the address bar.
 *  4. A link invitation's Join opens the conversation under the guest banner; the guest's message reaches
 *     the inviter's transcript.
 *  5. The inviter withdraws it in the share dialog, and the guest's next message is not sent.
 *
 * The server's refusals (a second redemption, the wrong mode, an existing account, offboarding the inviter)
 * are proven by `backend/scripts/deny-test-invitations.mjs`.
 *
 * Gated by INVITATIONS_E2E=1, with the test users; the link rows need an `invitation-link` issuer
 * (INVITATION_LINK=1).
 *
 *   AWS_PROFILE=<p> INVITATIONS_E2E=1 npx playwright test e2e/invitations.spec.ts --config=playwright.config.ts
 */
import { test, expect } from './helpers/fixtures';
import { type Browser, type Page } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getTestCredentials, hasTestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.INVITATIONS_E2E === '1';
const LINK = process.env.INVITATION_LINK === '1';

/** Invite somebody new from the share dialog, with no address, and read the link it shows. */
async function inviteFromShareDialog(page: Page, name: string, mode: 'sign-in' | 'link'): Promise<string> {
  await page.getByRole('button', { name: 'Share conversation' }).click();
  await page.getByLabel('Their name').fill(name);
  await page.getByLabel(mode === 'link' ? 'By the link alone, as a guest for 15 minutes' : 'By signing in or creating an account').check();
  await page.getByRole('button', { name: 'Invite' }).click();
  const link = page.getByLabel('Invitation link');
  await expect(link).toBeVisible({ timeout: 30_000 });
  return link.inputValue();
}

async function landing(browser: Browser, link: string): Promise<{ page: Page; referrer: string | null }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(link);
  return { page, referrer: response?.headers()['referrer-policy'] ?? null };
}

test.describe('invitations', () => {
  guardBackendErrors('invitations');
  test.skip(!RUN, 'INVITATIONS_E2E=1 runs the invitations e2e');

  test('the landing page reads, never redeems on open, and hands a sign-in invitation to the chat app', async ({ page, browser }) => {
    test.skip(!hasTestCredentials(), 'needs the provisioned test users');
    test.setTimeout(240_000);
    const creds = await getTestCredentials();
    await signIn(page, creds.basicUser.email, creds.basicUser.password);
    await createConversation(page, `Invitations e2e ${Date.now()}`, 'Basic');
    const link = await inviteFromShareDialog(page, 'Jordan E2E', 'sign-in');
    expect(link).toMatch(/\/invite\.html#t=[A-Za-z0-9_-]{43}$/);
    // EVERY INVITATION LANDS IN THE CHAT APP (`invitationLandingFor`): the link opens this app's own origin.
    expect(new URL(link).origin).toBe(new URL(page.url()).origin);

    const { page: guest, referrer } = await landing(browser, link);
    expect(referrer).toBe('no-referrer');
    await expect(guest.getByRole('heading', { name: /invited you to/ })).toBeVisible({ timeout: 30_000 });
    await expect(guest.getByText('You are invited as Jordan E2E.')).toBeVisible();
    expect(new URL(guest.url()).hash).toBe('');
    // A reload, or a scanner fetching the page, consumes nothing: the token is gone from this page's URL,
    // and the invitation, opened again from the link, still waits.
    const again = await landing(browser, link);
    await expect(again.page.getByRole('button', { name: 'Sign in to join' })).toBeVisible({ timeout: 30_000 });

    await again.page.getByRole('button', { name: 'Sign in to join' }).click();
    await again.page.waitForURL((u) => !u.pathname.endsWith('/invite.html'), { timeout: 30_000 });
    await expect(again.page.locator('input[type="email"]')).toBeVisible({ timeout: 30_000 });
    // The chat app took the token out of its address bar before rendering the sign-in.
    expect(new URL(again.page.url()).hash).toBe('');
  });

  test('a link invitation opens the one conversation as a guest, until it is withdrawn', async ({ page, browser }) => {
    test.skip(!LINK, 'INVITATION_LINK=1 when the registry declares an invitation-link issuer');
    test.skip(!hasTestCredentials(), 'needs the provisioned test users');
    test.setTimeout(300_000);
    const creds = await getTestCredentials();
    await signIn(page, creds.basicUser.email, creds.basicUser.password);
    await createConversation(page, `Invitations link e2e ${Date.now()}`, 'Basic');
    const link = await inviteFromShareDialog(page, 'Guest E2E', 'link');
    await page.keyboard.press('Escape');

    const { page: guest } = await landing(browser, link);
    await guest.getByRole('button', { name: 'Join the conversation' }).click();
    await expect(guest.getByRole('note')).toHaveText(/joined as a guest to this conversation only/, { timeout: 60_000 });
    const input = guest.getByRole('textbox', { name: 'Message' });
    const hello = `hello from the invitation ${Date.now()}`;
    await input.fill(hello);
    await input.press('Enter');
    await expect(page.getByText(hello)).toBeVisible({ timeout: 60_000 });

    // WITHDRAWN: the membership goes, and the guest's next message is not sent.
    await page.getByRole('button', { name: 'Share conversation' }).click();
    await page.getByRole('button', { name: 'Withdraw the invitation for Guest E2E' }).click();
    await expect(page.getByText('withdrawn')).toBeVisible({ timeout: 30_000 });
    const after = `after the withdrawal ${Date.now()}`;
    await input.fill(after);
    await input.press('Enter');
    await expect(guest.getByText('Your message was not sent. Try again.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(after)).toHaveCount(0);
  });
});
