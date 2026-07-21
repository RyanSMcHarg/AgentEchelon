/**
 * Admin conversation attachment review — end to end (live deployment).
 *
 * Validates the privileged, plane:'admin' attachment path: from the admin console, opening a
 * message's inspect drawer surfaces its attachment, and "Open attachment" vends CHANNEL-SCOPED,
 * short-lived, AUDITED S3 creds via the Credential Exchange and opens a presigned GetObject. The
 * whole point is that the console holds NO standing S3 access — the read rides a per-request,
 * per-channel session policy — so this asserts the opened URL is a genuine S3 PRESIGNED url
 * (SigV4 query auth) and that it fetches the REAL delivered document, not an error or empty body.
 *
 * Data-tolerant (mirrors admin-flow.spec.ts): it scans a bounded number of recent conversations
 * for a message carrying an attachment. In the validate.mjs admin phase (which runs AFTER the
 * tasks e2e, whose report/extraction tasks deliver generated-docs attachments) one is present, so
 * this exercises fully; on a clean window it note-skips rather than failing.
 *
 * Runs against the admin origin:
 *   cd tests && AWS_PROFILE=<your-profile> \
 *     E2E_ADMIN_BASE_URL=https://<admin-dist>.cloudfront.net \
 *     npx playwright test e2e/admin-attachments.spec.ts --reporter=list
 */
import { test, expect, request as pwRequest, Page } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { getAdminUser } from './helpers/test-credentials';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

const MAX_CONVERSATIONS = 12; // bound the scan for runtime
const MAX_MESSAGES = 15;      // per conversation

async function signInAsAdmin(page: Page): Promise<void> {
  const admin = await getAdminUser();
  await signIn(page, admin.email, admin.password);
  await expect(page.locator('.admin-section-rail')).toBeVisible({ timeout: 15000 });
}

test.describe('Admin console — conversation attachment review (live)', () => {
  test('opening a message attachment vends scoped creds and serves the real document', async ({ page }) => {
    test.setTimeout(180000);
    // A user-uploaded file prompts a confirm() before opening (audited action) — auto-accept so
    // the scan never stalls, whichever attachment kind we land on first.
    page.on('dialog', (d) => d.accept().catch(() => {}));

    await signInAsAdmin(page);
    await page.goto('/?admin=conversations');
    await expect(page.locator('.admin-tab').first()).toBeVisible({ timeout: 20000 });

    // The conversation list ("View" opens each). Empty window ⇒ nothing to review.
    const viewButtons = page.getByRole('button', { name: 'View' });
    await expect(async () => {
      const n = await viewButtons.count();
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 20000 }).catch(() => {});
    const convCount = await viewButtons.count();
    if (convCount === 0) {
      test.info().annotations.push({ type: 'note', description: 'No conversations in window — attachment review skipped.' });
      return;
    }

    // Scan conversations for a message that carries an attachment (the drawer renders an
    // "Open attachment" button only when message.metadata.attachment is present).
    let openBtn = null as ReturnType<Page['locator']> | null;
    const scan = Math.min(convCount, MAX_CONVERSATIONS);
    outer: for (let c = 0; c < scan; c++) {
      await page.goto('/?admin=conversations');
      await page.getByRole('button', { name: 'View' }).nth(c).click();
      // Wait for the messages panel.
      await expect(page.getByText('Recent Messages')).toBeVisible({ timeout: 15000 });
      const infoButtons = page.getByRole('button', { name: /Info/ });
      const msgCount = Math.min(await infoButtons.count(), MAX_MESSAGES);
      for (let m = 0; m < msgCount; m++) {
        await page.getByRole('button', { name: /Info/ }).nth(m).click();
        const drawer = page.locator('.admin-drawer');
        await expect(drawer).toBeVisible({ timeout: 10000 });
        const candidate = drawer.getByRole('button', { name: /Open attachment/ });
        if (await candidate.count()) {
          openBtn = candidate.first();
          break outer;
        }
        // Not this message — close the drawer and try the next.
        await drawer.getByRole('button', { name: 'Close' }).click();
        await expect(drawer).toBeHidden({ timeout: 5000 });
      }
    }

    if (!openBtn) {
      test.info().annotations.push({ type: 'note', description: 'No message with an attachment found in the scanned window — open-path skipped.' });
      return;
    }

    // Open the attachment — a new tab navigates to the presigned S3 URL.
    const [popup] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 30000 }),
      openBtn.click(),
    ]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const fileUrl = popup.url();
    await popup.close();

    // It must be a genuine S3 PRESIGNED url (SigV4 query auth) — proof the read rode a vended,
    // scoped credential, not a standing server-side bearer or a public object.
    expect(fileUrl, `opened URL: ${fileUrl}`).toMatch(/^https?:\/\/[^/]*s3[^/]*\.amazonaws\.com\//i);
    expect(fileUrl, 'the URL must be SigV4-presigned (X-Amz-Signature)').toContain('X-Amz-Signature');
    expect(fileUrl, 'the presign must carry a credential scope').toContain('X-Amz-Credential');

    // And it must fetch the REAL document (the vended session policy authorizes this exact key).
    const api = await pwRequest.newContext();
    try {
      const resp = await api.get(fileUrl);
      expect(resp.ok(), `presigned GET must succeed (got ${resp.status()})`).toBeTruthy();
      const body = await resp.text();
      expect(body.length, 'the delivered document must be non-empty').toBeGreaterThan(50);
      // Not an S3 access-denied / error XML surfacing as the body.
      expect(body, 'must not be an S3 error document').not.toMatch(/<Error>[\s\S]*<Code>(AccessDenied|NoSuchKey)/i);
      expect(body, 'the document text must be valid UTF-8 (no replacement chars)').not.toContain('�');
    } finally {
      await api.dispose();
    }
  });
});
