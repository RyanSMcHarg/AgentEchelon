/**
 * Conversation archive E2E — the moderator gate, the transition, and the surviving record.
 *
 * WHY THIS SPEC EXISTS. `SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP` is `Implemented` and had no e2e.
 * Its two claims are both the kind that fail quietly:
 *
 *   1. "Gated on ChannelModerator status" — an authorisation boundary. If the gate regressed open,
 *      nothing errors; a non-moderator simply gains a control they should not have, and no user
 *      complains about being able to do more.
 *   2. "It leaves members' active list ... while the Aurora/Athena archive persists for
 *      administrators" — the entire point is that the conversation disappears for the USER and
 *      survives for the ADMIN. Asserting only the disappearance would pass just as well if the
 *      record had been destroyed, which is the failure that actually matters.
 *
 * So this asserts BOTH SIDES of the transition, from two different vantage points: the user's list
 * (browser) and the admin archive (SigV4-signed read of the deployed API). A test that checked only
 * the DOM could not tell "archived" from "lost".
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getBasicUser, getAdminUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signedAdminGet } from './helpers/signed-analytics';

guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';
const ADMIN_CONVERSATIONS_API =
  process.env.VITE_ADMIN_CONVERSATIONS_API_URL || process.env.ADMIN_CONVERSATIONS_API_URL || '';

/** The archive control, gated on `isModerator` in ConversationInterface. */
const ARCHIVE_BTN = 'button[aria-label="Archive conversation"]';

test.describe('Conversation archive — moderator gate and record survival', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users.');
  guardBackendErrors('archive-membership');

  test('the creator is a moderator and sees the archive control', async ({ page }) => {
    test.setTimeout(180_000);
    const user = await getBasicUser();
    test.skip(!user.password, missingUserReason('basicUser'));

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    await createConversation(page, `Archive gate ${Date.now()}`, 'Open');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // "The channel creator is a moderator of their own channel" — the spec's stated basis for the
    // gate. If this control is missing for a creator, the gate is wrong in the SAFE direction, but
    // it is still wrong and the feature is unreachable.
    await expect(
      page.locator(ARCHIVE_BTN),
      'the conversation creator does not see the archive control, so either they were not made a '
      + 'ChannelModerator or the gate reads the wrong signal',
    ).toBeVisible({ timeout: 15000 });
  });

  test('archiving removes it from the active list AND leaves the admin record intact', async ({ page, browser }) => {
    test.setTimeout(420_000);
    test.skip(!ADMIN_BASE_URL, 'Needs E2E_ADMIN_BASE_URL — the archive record is admin-plane.');
    test.skip(
      !ADMIN_CONVERSATIONS_API,
      'Needs VITE_ADMIN_CONVERSATIONS_API_URL (frontend/packages/admin/.env).',
    );

    const user = await getBasicUser();
    const admin = await getAdminUser();
    test.skip(!user.password, missingUserReason('basicUser'));
    test.skip(!admin.password, missingUserReason('testAdmin'));

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    const title = `Archive e2e ${Date.now()}`;
    await createConversation(page, title, 'Open');
    const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    console.log(`\n--- archiving ---\n${channelArn}`);

    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Archive through the real UI path, not an API call — the gate lives in the component.
    await page.locator(ARCHIVE_BTN).click();
    await expect(page.locator('.modal-content')).toBeVisible({ timeout: 10000 });
    await page.locator('.modal-content button:has-text("Archive")').last().click();

    // USER SIDE: it leaves the active list.
    await expect(
      page.locator(`.conversation-list-item:has-text("${title}")`),
      'the archived conversation is still in the active list',
    ).toHaveCount(0, { timeout: 30000 });

    // ADMIN SIDE: the record survives, and is marked archived rather than gone. This is the half a
    // DOM-only test cannot see, and the half that distinguishes "archived" from "destroyed".
    const adminCtx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const adminPage = await adminCtx.newPage();
    let idToken = '';
    try {
      await signIn(adminPage, admin.email, admin.password);
      idToken = (await adminPage.evaluate(() => localStorage.getItem('idToken'))) || '';
      expect(idToken, 'admin idToken').toBeTruthy();
    } finally {
      await adminCtx.close();
    }

    // Archiving is FAST — the flag reaches the admin archive in seconds, not minutes. The deadline
    // is a ceiling for a slow day, not an expectation; the elapsed time is logged so a regression in
    // propagation latency is visible rather than hidden inside a generous timeout.
    const pollStart = Date.now();
    const deadline = pollStart + 60_000;
    let row: any = null;
    for (;;) {
      const { status, body } = await signedAdminGet(ADMIN_CONVERSATIONS_API, idToken, { limit: '200', offset: '0' });
      expect(
        body?.archiveError ?? null,
        'the admin conversation list answered with an archiveError — a broken read, which renders '
        + 'as an empty list and is indistinguishable from a lost record',
      ).toBeNull();
      expect(status, `admin conversations returned ${status}`).toBe(200);

      row = (body?.conversations ?? []).find((c: any) => String(c.channel_arn ?? c.channelArn) === channelArn);
      // Poll until the STATE settles, not merely until the row exists. The archived flag reaches
      // Aurora through the channel-event stream, so the row appears first and flips to `archived`
      // moments later. Breaking on the row alone makes the assertion race that gap: it passed
      // against `archived` on one run and `live` on the next, which means it would also pass if the
      // flag never propagated at all.
      if ((row && row.state === 'archived') || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    console.log(`--- archived flag reached the admin archive in ${Date.now() - pollStart}ms ---`);

    expect(
      row,
      'the archived conversation is absent from the admin archive entirely. Archiving is supposed to '
      + 'mark it read-only and drop it from members\' active lists while the analytics archive '
      + 'PERSISTS for administrators — an absent record means the record was lost, not archived.',
    ).toBeTruthy();

    console.log(`--- admin record state: ${row?.state} ---`);
    expect(
      row?.state,
      `the admin archive reports state "${row?.state}" for a conversation that was just archived. `
      + 'The record survived but the archived flag did not propagate, so an operator reviewing the '
      + 'archive cannot tell an archived conversation from a live one.',
    ).toBe('archived');
  });
});
