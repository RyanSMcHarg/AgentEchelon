/**
 * "Waiting on you" is ONE queue, across conversations (ADR-024/ADR-029).
 *
 * WHY THIS EXISTS. A person accumulates open items from several assistants and several workflows at
 * once, and each is the same thing to them: something is blocked on me. `GET /tasks/mine` is the only
 * component that can answer that, because it is explicitly cross-conversation - anything derived from
 * messages is blind to the conversation the user is not looking at, which is exactly the item they
 * have forgotten.
 *
 * WHAT THE UNIT TESTS CANNOT COVER, and why this is an e2e. The endpoint's own tests prove the mirror
 * is read and shaped correctly. They cannot prove that a real task, opened by a real turn, is OWNED by
 * the user at creation - which is the fix that actually made a duel's wait visible (08-14). Ownership
 * at creation is a property of the writer, not of the reader, so only a live turn exercises it.
 *
 * WHAT MAKES IT NON-VACUOUS. It opens tasks in TWO separate conversations and asserts the single queue
 * carries BOTH channel ARNs. A one-conversation assertion passes on any implementation that returns
 * the current channel's tasks, which is the pre-fix behaviour and the very thing the row is about.
 *
 * Gated by OPEN_WORK_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 *   E2E_BASE_URL=<cf> OPEN_WORK_E2E=1 VITE_USER_TASKS_API_URL=<url> npx playwright test \
 *     e2e/open-work-items.spec.ts
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.OPEN_WORK_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const TASKS_API = process.env.VITE_USER_TASKS_API_URL || '';

// A report prompt with the scope deliberately left open. The assistant opens a task and comes back to
// the user for scope, so the task's first state awaits THEM - which is the state that must be owned by
// the user at creation rather than handed over later.
const OPEN_SCOPE_PROMPT =
  'Please compile a report on our options here. Ask me for whatever scope you need before you start.';

interface OpenWorkItem {
  taskId: string;
  taskType: string;
  channelArn: string;
  status: string;
  title?: string;
  updatedAt?: string;
  assistantId?: string;
}

suite('open work items are one cross-conversation queue', () => {
  guardBackendErrors('open-work-items');

  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(TASKS_API, 'VITE_USER_TASKS_API_URL must be set').toBeTruthy();
  });

  test('a task opened in each of two conversations appears in one queue', async ({ page }) => {
    test.setTimeout(600_000); // two task-opening turns + the mirror's write

    // A premium account, because both conversations are Premium; the queue itself is classification-agnostic.
    await signIn(page, creds.premiumUser.email, creds.premiumUser.password);

    // Open a task in conversation A, then in conversation B, capturing both ARNs.
    const openTaskIn = async (label: string): Promise<string> => {
      const createResp = page.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await createConversation(page, `${label} ${Date.now()}`, 'Premium');
      const arn = (await (await createResp).json()).conversation.conversationArn as string;
      expect(arn, `channelArn for ${label}`).toBeTruthy();
      await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });
      const resp = await sendAndWaitForResponse(page, OPEN_SCOPE_PROMPT, 180_000);
      expect(resp.text && resp.text.length, `${label} must return a response`).toBeTruthy();
      return arn;
    };

    const channelA = await openTaskIn('Open work A');
    const channelB = await openTaskIn('Open work B');
    console.log(`\n--- open-work channels ---\nA: ${channelA}\nB: ${channelB}`);

    // Read the queue exactly as the client does: Cognito id token, Bearer scheme. The owner comes from
    // the token's `sub` - there is no parameter by which this could be asked for another user, which is
    // the whole access-control story for the endpoint.
    const queue = async (): Promise<OpenWorkItem[]> => {
      const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
      const body = await page.evaluate(
        async ([url, token]) => {
          const r = await fetch(url as string, {
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          });
          return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
        },
        [TASKS_API, idToken],
      );
      expect(body.ok, `GET /tasks/mine should answer 200 (got ${body.status})`).toBeTruthy();
      const items = (body.json?.items ?? []) as OpenWorkItem[];
      return items;
    };

    // Poll: the task mirror is written as the turn settles, so the second item can trail the answer.
    let items: OpenWorkItem[] = [];
    let arns = new Set<string>();
    for (let i = 0; i < 20; i++) {
      items = await queue();
      arns = new Set(items.map((it) => it.channelArn));
      if (arns.has(channelA) && arns.has(channelB)) break;
      await page.waitForTimeout(6_000);
    }
    console.log('[open-work-e2e] items:', JSON.stringify(items, null, 2));

    // THE ASSERTION THE ROW IS ABOUT: one queue, both conversations. Checked as a pair rather than
    // separately, because a queue returning only the current channel satisfies either half alone.
    expect(arns.has(channelA), 'the queue carries the task from conversation A').toBeTruthy();
    expect(arns.has(channelB), 'the queue carries the task from conversation B').toBeTruthy();

    // Every item is nameable and belongs to a conversation. An unnamed row in a to-do queue cannot be
    // acted on, which is why the server never returns an empty title.
    for (const it of items) {
      expect(it.taskId, 'each item has a taskId').toBeTruthy();
      expect(it.channelArn, 'each item names its conversation').toBeTruthy();
      expect(String(it.title || '').length, 'each item has a non-empty title').toBeGreaterThan(0);
    }
  });
});
