/**
 * `v_task_resolution` measures a real task (tracker row 104).
 *
 * WHY THIS EXISTS. The view aggregates three ledger kinds - `task_opened`, `task_transition` and
 * `task_terminal` - and for 47 days nothing emitted any of them, so the query returned zero rows over
 * real task traffic. An empty result reads as "no task resolved in this window", which is a claim
 * about the PRODUCT, when the truth was "this was never measured", which is a claim about the
 * PIPELINE. The unit test (`turn-events-task-kinds.test.ts`) proves the projection emits the kinds
 * from a synthesized archive record. It cannot prove that a real turn, archived by the real consumer,
 * reaches the view - which is precisely the gap that let the inert version ship, pass and measure
 * nothing.
 *
 * WHAT MAKES THIS NON-VACUOUS. It binds to THIS conversation's `channel_arn`. The view is capped at
 * 200 rows over the window, so asserting "some row exists" would pass on any historical task and would
 * have passed against the inert build too, since the fix is not backfilled. It also asserts
 * `opened_at` is populated: a task opened BEFORE the producer shipped shows a NULL `opened_at`, so a
 * non-null value is the part that can only come from this deploy's `task_opened`.
 *
 * Gated by TASK_RESOLUTION_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 *   E2E_BASE_URL=<cf> TASK_RESOLUTION_E2E=1 VITE_ANALYTICS_API_URL=<url> VITE_USER_POOL_ID=<id> \
 *     VITE_IDENTITY_POOL_ID=<id> AWS_PROFILE=<p> npx playwright test e2e/task-resolution.spec.ts
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const RUN = process.env.TASK_RESOLUTION_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || '';

// The same multi-step report prompt tasks.spec uses to open a task. A task-shaped turn is the
// precondition for the whole assertion: a turn that answers inline opens nothing and would leave the
// view legitimately empty, which is indistinguishable from the defect.
const REPORT_PROMPT =
  'Please compile a short report analyzing the pros and cons of a monorepo versus multi-repo for a 5-team org.';

interface ResolutionRow {
  task_id: string;
  channel_arn: string;
  opened_at: string | null;
  terminal_at: string | null;
  terminal_kind: string | null;
  is_resolved: boolean;
  resolve_ms: number | null;
  agent_ms: number | null;
  transitions: number;
  turns: number;
}

suite('task resolution is measured on a real task', () => {
  guardBackendErrors('task-resolution');

  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
  });

  test('a task-shaped turn appears in v_task_resolution with a populated opened_at', async ({ page }) => {
    test.setTimeout(420_000); // turn (up to 180s) + archival lag (Chime -> Kinesis -> Aurora)

    // testAdmin drives it: the analytics API is admin-gated and IAM-enforced, so the read is signed.
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);

    // Capture the ARN from the create response - the binding that makes this about THIS task.
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await createConversation(page, `Task resolution e2e ${Date.now()}`, 'Premium');
    const channelArn = (await (await createResp).json()).conversation.conversationArn as string;
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    console.log(`\n--- task-resolution channel ---\n${channelArn}`);

    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    const resp = await sendAndWaitForResponse(page, REPORT_PROMPT, 180_000);
    expect(resp.text && resp.text.length, 'the report turn must return a response').toBeTruthy();

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    const end = new Date();
    const start = new Date(end.getTime() - 86_400_000); // -> days=1

    const rowsForThisChannel = async (): Promise<ResolutionRow[]> => {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, {
        queryType: 'task_resolution',
        dateRange: { start: start.toISOString(), end: end.toISOString() },
      });
      const all = (j.data || []) as ResolutionRow[];
      return all.filter((r) => r.channel_arn === channelArn);
    };

    // Poll: archival buffers up to ~2 min before the turn reaches Aurora, so the row appears later
    // than the answer does.
    let mine: ResolutionRow[] = [];
    for (let i = 0; i < 30 && mine.length === 0; i++) {
      mine = await rowsForThisChannel();
      if (mine.length === 0) await page.waitForTimeout(6_000);
    }

    expect(
      mine.length,
      'v_task_resolution should carry a row for the channel whose task was just opened - an empty '
        + 'result here is the inert-view defect, not an idle window',
    ).toBeGreaterThan(0);

    const row = mine[0];
    console.log('[task-resolution-e2e] row:', JSON.stringify(row));

    // `opened_at` is the assertion that can only pass on this deploy's producer: the ledger is not
    // backfilled, so a task opened before it shipped reports NULL here. Its first live pass came
    // after THREE inert links were fixed (no producer for the open edge; then archival truthiness
    // dropping the empty `from`), each found by this spec against a deployment.
    expect(row.opened_at, 'opened_at is populated (task_opened reached the ledger)').toBeTruthy();

    // A just-opened, clarify-first task has moved NOWHERE yet: transitions=0 and turns=0 are the
    // CORRECT reading of a task whose only event is its open (the open edge is `task_opened`, not a
    // transition). The first version of this spec asserted >= 1 for both and failed against a correct
    // product - the strong claims belong to a test that drives a task to terminal. What must hold
    // here is the OPEN shape: not resolved, no terminal, and the counts non-negative numbers.
    expect(row.is_resolved, 'a just-opened task is not resolved').toBeFalsy();
    expect(row.terminal_at, 'a just-opened task has no terminal_at').toBeFalsy();
    expect(Number(row.turns), 'turns is a non-negative number').toBeGreaterThanOrEqual(0);
    expect(Number(row.transitions), 'transitions is a non-negative number').toBeGreaterThanOrEqual(0);

    // Resolution is NOT asserted. A report task stays open until the user accepts or abandons it, so
    // requiring `is_resolved` here would fail on correct behaviour. What this test owns is that the
    // task is MEASURED; the terminal half belongs to a test that drives a task to a terminal state.
  });
});
