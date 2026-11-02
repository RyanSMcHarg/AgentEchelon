/**
 * AN ANONYMOUS VISITOR IN THE WIDGET GETS AN ANSWER, AND THE WIDGET SHOWS EACH REFUSAL'S REASON (C0, A7, D-4).
 *
 * The widget is framed the way a customer's site frames it: on the sample host page (`examples/widget-host`,
 * the `<prefix>WidgetHost` stack), the origin a guest deployment's issuer admits as `allowedOrigins:
 * ["widget-host"]` and the widget's `frame-ancestors` names. The page's own `host.js` loads `embed.js` and
 * mounts the widget; the spec only opens the page. Then, inside the frame:
 *
 *  1. The privacy notice shows before the first message, and accepting it runs the captcha (the vendor's
 *     always-pass test key outside production) and guest start.
 *  2. The visitor's question gets an answer from the guest classification's assistant, which arrives in
 *     the transcript's live region.
 *  3. Each guest-start refusal the server can give (`paused`, `rate_limited`, `captcha_failed`,
 *     `unavailable`) is shown as its own settled state. These answers are fulfilled by the spec at the
 *     network layer: the server's own refusals are proven by `backend/scripts/deny-test-guest.mjs`, and
 *     what this spec proves is that the widget shows each one as a state, never a raw error.
 *
 * Gated by GUEST_WIDGET_E2E=1. Needs WIDGET_HOST_URL (the WidgetHost stack's `WidgetHostUrl`, read from the
 * stack when unset), WIDGET_URL (the Widget stack's `WidgetDistributionUrl`) and VITE_PERSON_API_URL.
 */
import { test, expect } from './helpers/fixtures';
import { type FrameLocator, type Page } from '@playwright/test';
import { PERSON_API_URL } from './helpers/api-urls';
import { awsOrNull } from './helpers/aws';
import { stackName } from './helpers/stack-prefix';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.GUEST_WIDGET_E2E === '1';
const WIDGET_URL = (process.env.WIDGET_URL || '').replace(/\/$/, '');
const QUESTION = 'What can you help me with?';

/** The sample host page: WIDGET_HOST_URL, or the WidgetHost stack's `WidgetHostUrl` output. */
function widgetHostUrl(): string {
  const set = (process.env.WIDGET_HOST_URL || '').replace(/\/$/, '');
  if (set || !RUN) return set;
  const r = awsOrNull(`cloudformation describe-stacks --stack-name ${stackName('WidgetHost')} --query "Stacks[0].Outputs[?OutputKey=='WidgetHostUrl'].OutputValue | [0]"`);
  return typeof r === 'string' ? r.replace(/\/$/, '') : '';
}
const HOST_URL = widgetHostUrl();

/** Open the sample host page, whose own script mounts the widget; the frame's locator. */
async function mountOnHost(page: Page): Promise<FrameLocator> {
  await page.goto(HOST_URL);
  const frame = page.frameLocator(`iframe[src^="${WIDGET_URL}"]`);
  await expect(page.locator(`iframe[src^="${WIDGET_URL}"]`)).toHaveAttribute('title', /.+/);
  return frame;
}

async function openAndStart(frame: FrameLocator): Promise<void> {
  await frame.getByRole('button', { name: 'Open the assistant' }).click();
  await expect(frame.getByRole('dialog')).toBeVisible();
  await expect(frame.getByText('Before you start')).toBeVisible();
  await frame.getByRole('button', { name: 'Start the conversation' }).click();
}

test.describe('the guest widget', () => {
  guardBackendErrors('guest-widget');
  test.skip(!RUN, 'GUEST_WIDGET_E2E=1 runs the guest widget e2e');
  test.skip(RUN && (!WIDGET_URL || !PERSON_API_URL || !HOST_URL), 'WIDGET_URL, VITE_PERSON_API_URL and the sample host page (WIDGET_HOST_URL, or a deployed WidgetHost stack) are required');

  test('an anonymous visitor gets an answer from the guest assistant', async ({ page }) => {
    test.setTimeout(180_000);
    const frame = await mountOnHost(page);
    await openAndStart(frame);
    const input = frame.getByRole('textbox', { name: 'Message' });
    await expect(input).toBeVisible({ timeout: 60_000 });
    await input.fill(QUESTION);
    await input.press('Enter');
    const log = frame.getByRole('log', { name: 'Conversation' });
    await expect(log).toContainText(QUESTION, { timeout: 30_000 });
    // The answer is a message from the assistant, after the question.
    await expect(log.locator('.aeaw__row--other .aeaw__msg').last()).not.toBeEmpty({ timeout: 120_000 });
  });

  for (const [code, status, body, text] of [
    ['paused', 503, { code: 'paused' }, 'The assistant is paused'],
    ['rate_limited', 429, { code: 'rate_limited', retryAfterSeconds: 90 }, 'Try again in 90 seconds.'],
    ['captcha_failed', 403, { code: 'captcha_failed' }, 'The check did not pass'],
    ['unavailable', 503, { code: 'unavailable' }, 'The assistant is unavailable'],
  ] as const) {
    test(`a ${code} guest start is shown as its own state`, async ({ page }) => {
      await page.context().route(`${PERSON_API_URL}/guest/start`, (route) => route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': WIDGET_URL },
        body: JSON.stringify(body),
      }));
      const frame = await mountOnHost(page);
      await openAndStart(frame);
      const alert = frame.getByRole('alert');
      await expect(alert).toHaveAttribute('data-code', code, { timeout: 60_000 });
      await expect(alert).toContainText(text);
    });
  }
});
