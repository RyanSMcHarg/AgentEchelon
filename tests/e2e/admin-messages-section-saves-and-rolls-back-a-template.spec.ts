/**
 * THE CONSOLE'S MESSAGES SECTION LISTS, CREATES, EDITS, SAVES AND ROLLS BACK AN ASSISTANT'S TEMPLATE (ADR-062).
 *
 * On the basic primary's page it reads the list (a shipped message, previewed with sample values), then works on a
 * template under a name of its own, which no message uses until a version picks it, so the assistant says nothing new:
 *  - created once, under `e2e-messages-section`, when the assistant does not hold it yet;
 *  - edited with this run's marker, which the preview shows before anything is saved;
 *  - saved, and read back after a reload, which is the server's copy and not the page's;
 *  - rolled back, after which the server's copy is the one from before the edit.
 */
import { test, expect } from './helpers/fixtures';
import type { Page } from '@playwright/test';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { awsOrNull } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

guardBackendErrors('admin-messages-section');
guardConsoleErrors();

const CLASSIFICATION = 'basic';

/** The template with the mark added to the first line of every section, its headings kept: a template is its sections. */
const withMark = (source: string, mark: string) => source.replace(/^(# [^\n]+\n)([^\n]*)/gm, (_m, heading: string, line: string) => `${heading}${line} ${mark}`);
const NAME = 'e2e-messages-section';

/** The basic primary's name, as the deployment assigns it. */
function basicPrimary(): string | null {
  const r = awsOrNull(`ssm get-parameters-by-path --path ${SSM_ROOT}/assistant-assignments/${CLASSIFICATION}/primary/assistants --query Parameters[].Name`);
  const names = Array.isArray(r) ? (r as string[]) : [];
  return names.length ? names[0].split('/').pop()! : null;
}

async function openMessages(page: Page, assistant: string): Promise<void> {
  await page.goto('/?admin=profiles');
  await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 30_000 });
  const row = page.locator(`tr[data-assistant="${assistant}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.locator('button.btn-link').first().click();
  await page.getByTestId('assistant-nav-messages').click();
  await expect(page.getByTestId('message-template-messages'), 'the section lists the messages').toBeVisible({ timeout: 30_000 });
}

test('the Messages section creates, edits, saves and rolls back a template of the assistant\'s own', async ({ page }) => {
  test.setTimeout(300_000);
  const assistant = basicPrimary();
  test.skip(!assistant, `no ${CLASSIFICATION} primary is assigned here`);
  const run = `E2EMARK${Date.now().toString(36).toUpperCase()}`;
  page.on('dialog', (d) => void d.accept());

  await signInAsAdmin(page);
  await openMessages(page, assistant!);

  // ── THE LIST: a shipped message opens to its preview, and the search narrows the list ──
  const firstRow = page.locator('[data-testid^="message-template-row-"]').first();
  const firstName = (await firstRow.getAttribute('data-testid'))!.slice('message-template-row-'.length);
  await page.getByTestId(`message-template-open-${firstName}`).click();
  await expect(page.getByTestId('message-template-preview').or(page.getByTestId('message-template-error'))).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('message-template-error'), 'the template in use renders').toHaveCount(0);
  await page.getByTestId(`message-template-open-${firstName}`).click();
  await page.getByTestId('message-template-find').fill(firstName);
  await expect(page.locator('[data-testid^="message-template-row-"]').filter({ hasText: firstName }).first()).toBeVisible();
  await page.getByTestId('message-template-find').fill('');

  // ── CREATED ONCE, under a name of its own ──
  const held = page.getByTestId(`message-template-own-named-${NAME}`);
  if (!(await held.isVisible().catch(() => false))) {
    await page.getByTestId('message-template-new').click();
    const form = page.getByTestId('message-template-own-form');
    await form.getByTestId('message-template-new-name').fill(NAME);
    await form.getByTestId('message-template-new-description').fill('End-to-end check of the Messages section');
    // It starts from what the message says now, which is a whole template.
    await expect(form.getByTestId('message-template-new-error')).toHaveCount(0);
    await form.getByTestId('message-template-new-save').click();
    await expect(form.getByTestId('message-template-new-status')).toHaveAttribute('role', 'status', { timeout: 30_000 });
    await form.getByTestId('message-template-new-close').click();
  }
  await expect(held, 'the template of its own is listed').toBeVisible({ timeout: 30_000 });

  // ── EDITED: the preview shows the marker before it is saved ──
  await page.getByTestId(`message-template-open-own-${NAME}`).click();
  const form = page.getByTestId('message-template-own-form');
  const text = form.getByTestId('message-template-new-text');
  const before = await text.inputValue();
  expect(before, 'a run that died between its save and its rollback left its marker behind').not.toMatch(/E2EMARK/);
  // A template no version picks says which message it words before it is saved: the one it was created for, first in the list.
  const message = form.getByTestId('message-template-new-message');
  if (!(await message.inputValue())) await message.selectOption({ index: 1 });
  await text.fill(withMark(before, run));
  await expect(form.getByTestId('message-template-new-error'), 'the edit keeps every section').toHaveCount(0);
  await expect(form.getByTestId('message-template-new-preview'), 'the preview renders the edit').toContainText(run);

  // ── SAVED, and read back from the server ──
  await form.getByTestId('message-template-new-save').click();
  await expect(form.getByTestId('message-template-new-status')).toHaveAttribute('role', 'status', { timeout: 30_000 });
  await page.reload();
  await openMessages(page, assistant!);
  await page.getByTestId(`message-template-open-own-${NAME}`).click();
  await expect(page.getByTestId('message-template-own-form').getByTestId('message-template-new-text'), 'the saved text is what the server holds').toHaveValue(new RegExp(run), { timeout: 30_000 });

  // ── ROLLED BACK: the server's copy is the one from before the edit ──
  await page.getByTestId('message-template-own-form').getByTestId('message-template-new-rollback').click();
  await expect(page.getByTestId('message-template-own-form')).toHaveCount(0, { timeout: 30_000 });
  await page.reload();
  await openMessages(page, assistant!);
  const after = page.getByTestId(`message-template-own-named-${NAME}`);
  await expect(after).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`message-template-open-own-${NAME}`).click();
  await expect(page.getByTestId('message-template-own-form').getByTestId('message-template-new-text'), 'the rollback restores the text from before the edit').toHaveValue(before, { timeout: 30_000 });
});
