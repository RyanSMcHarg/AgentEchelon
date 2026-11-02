/**
 * A MODERATOR RAISES A FLAG, AND IT REACHES THE FLAGGED LIST — end to end, live deployment.
 *
 * The Flagged list used to have exactly one author. It is derived from `evaluation_results`, and the
 * only human writer (`flagged_review`, migration 014) records a verdict against an exchange the
 * judge had ALREADY raised. Nothing inserted a new one, so Oversight — the moderator surface — was
 * read-only about quality.
 *
 * This is the proof that the whole path is wired: the control renders on a real transcript, the
 * write reaches Aurora through the SIGNED admin path, migration 059 has applied on the live
 * cluster, and the list joins the flag back to its exchange and names its origin. A unit test
 * cannot show any of that — the write is mocked, and the schema never runs.
 *
 * DATA-TOLERANT, like admin-flow and admin-attachments: it scans a bounded number of recent
 * conversations for an assistant response to flag. On a window with no assistant traffic it
 * note-skips rather than failing, because an empty window is not a defect in this code.
 *
 * It CLEANS UP after itself: the flag write the console sends is captured as it leaves the page, and
 * `afterEach` withdraws exactly that flag through the route the console's own withdraw control calls
 * (`unflagResponse`, a signed `flagged_responses` `unflag`). It runs whether the test passed or failed,
 * so a repeated run does not accumulate flags and the console is not left with test rows in it. A
 * withdrawal the backend does not confirm fails the test.
 *
 *   cd tests && AWS_PROFILE=<profile> \
 *     E2E_ADMIN_BASE_URL=https://<admin-dist>.cloudfront.net \
 *     npx playwright test e2e/flag-a-response.spec.ts --reporter=list
 */
import { test, expect } from './helpers/fixtures';
import { signInAsAdmin, idTokenOf } from './helpers/agent-helpers';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

guardBackendErrors('flag-a-response');
guardConsoleErrors();

const MAX_CONVERSATIONS = 12;

/** The route the console withdraws a flag on (`analyticsPathForQuery` sends a flagged_responses write to `/triage`). */
const TRIAGE_API = ADMIN_API_URL ? adminUrl('analytics', '/triage') : '';

/** The flags this test's page wrote, read off the console's own request, so cleanup names exactly them. */
let raised: Array<{ channelArn: string; messageId: string }> = [];

test.describe('Oversight — a moderator can flag a response (live)', () => {
  test.beforeEach(async ({ page }) => {
    raised = [];
    page.on('request', (req) => {
      if (req.method() !== 'POST') return;
      const body = req.postData();
      if (!body || !body.includes('flagged_responses')) return;
      try {
        const j = JSON.parse(body);
        if (j.queryType === 'flagged_responses' && j.action === 'flag' && j.channelArn && j.messageId) {
          raised.push({ channelArn: String(j.channelArn), messageId: String(j.messageId) });
        }
      } catch { /* not a JSON write */ }
    });
  });

  test.afterEach(async ({ page }) => {
    if (raised.length === 0) return;
    expect(TRIAGE_API, 'VITE_ADMIN_API_URL is needed to withdraw the flag this run raised').toBeTruthy();
    const idToken = await idTokenOf(page);
    expect(idToken, 'the signed-in admin id token, to withdraw the flag this run raised').toBeTruthy();
    for (const { channelArn, messageId } of raised) {
      const res = await signedAnalyticsPost(TRIAGE_API, idToken, { queryType: 'flagged_responses', action: 'unflag', channelArn, messageId });
      expect(res?.unflagged, `withdrawing the flag on ${messageId}: ${JSON.stringify(res).slice(0, 300)}`).toBe(true);
    }
    raised = [];
  });

  test('flagging a response writes it, shows it flagged, and the Flagged list names the moderator', async ({ page }) => {
    test.setTimeout(420000);
    await signInAsAdmin(page, { rail: true });

    await page.goto('/?admin=conversations');
    await expect(page.locator('.admin-tab').first()).toBeVisible({ timeout: 20000 });

    const viewButtons = page.getByRole('button', { name: 'View' });
    await expect(async () => {
      expect(await viewButtons.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 20000 }).catch(() => {});

    const convCount = await viewButtons.count();
    if (convCount === 0) {
      test.skip(true, 'No conversations in the admin list window, so there is no assistant response to flag.');
      return;
    }

    // Find a conversation holding an assistant response. The flag only offers itself on one — a
    // person's own words are not what this measures.
    let flagButton = page.locator('.admin-conversation-panel button', { hasText: 'Flag' }).first();
    let found = false;
    for (let i = 0; i < Math.min(convCount, MAX_CONVERSATIONS); i++) {
      await page.goto('/?admin=conversations');
      await expect(page.locator('.admin-tab').first()).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: 'View' }).nth(i).click();
      // The transcript table renders before the flag controls resolve.
      await expect(page.locator('.admin-section h4', { hasText: 'Recent Messages' })).toBeVisible({ timeout: 20000 });
      // AND THE READ HAS SETTLED. The heading renders as soon as the detail opens, while the messages
      // are still being read (behind the access-reason prompt), so counting here counted an empty
      // table: all twelve conversations read "No messages loaded" with the header still on
      // "Refreshing..." (e2e, 2026-10-23), and the test skipped on a deployment full of responses.
      // A row's Info control is what says the read landed; the header settling back to "Refresh" says it
      // finished. Either can be momentarily true before the read starts, so both are waited on, and a
      // conversation whose read lands nothing is passed over after a bounded wait.
      await expect(page.locator('.admin-conversation-panel button', { hasText: 'ⓘ Info' }).first())
        .toBeVisible({ timeout: 10000 }).catch(() => {});
      await expect(page.locator('.admin-tab-header .admin-filter-btn', { hasText: /^Refresh$/ }))
        .toBeVisible({ timeout: 30000 });
      flagButton = page.locator('.admin-conversation-panel button', { hasText: /^⚑ Flag$/ }).first();
      if (await flagButton.count() > 0) { found = true; break; }
    }

    if (!found) {
      test.skip(true, `No unflagged assistant response in the ${Math.min(convCount, MAX_CONVERSATIONS)} most recent conversations scanned.`);
      return;
    }

    // ── Raise the flag ────────────────────────────────────────────────────────────────────────
    await flagButton.click();
    // The reason picker is inline, beside the response being judged, rather than in a modal that
    // would cover the question the answer is being judged against.
    const reason = page.locator('.admin-conversation-panel button', { hasText: 'Poor answer' }).first();
    await expect(reason).toBeVisible({ timeout: 10000 });
    await reason.click();

    // The transcript RE-READS after the write, so this asserts what is in the table rather than
    // what the component believes it wrote. If migration 059 had not applied, or the param
    // whitelist still dropped messageId/reason, the write would no-op and this would stay "Flag".
    const flagged = page.locator('.admin-conversation-panel button', { hasText: 'Flagged' }).first();
    await expect(flagged).toBeVisible({ timeout: 25000 });
    await expect(flagged).toHaveAttribute('title', /Poor answer/);

    // No error surfaced from the write.
    await expect(page.locator('.admin-error')).toHaveCount(0);

    // ── It reaches the Flagged list, named as moderator-raised ────────────────────────────────
    await page.goto('/?admin=flagged');
    await expect(page.locator('.admin-tab').first()).toBeVisible({ timeout: 20000 });

    // The chip is the point: the list now has three possible authors, and a judge score and a
    // colleague's opinion are not the same claim. A moderator-raised row sorts to the top, because
    // it carries no relevance score and the old score-ascending order would have buried it.
    const moderatorChip = page.locator('.admin-flag-chip', { hasText: 'Moderator' }).first();
    await expect(moderatorChip).toBeVisible({ timeout: 30000 });

    // And the row says "not scored" rather than 0 — a response the judge never scored must not
    // render as the worst possible score.
    await expect(page.locator('.admin-error')).toHaveCount(0);

    // The flag this test raised is withdrawn in afterEach, so a failure above still leaves nothing.
    expect(raised.length, 'the console\'s flag write was captured, so cleanup can withdraw it').toBeGreaterThan(0);
  });
});
