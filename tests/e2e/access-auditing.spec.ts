/**
 * Access & controls auditing E2E — a real membership change reaches the append-only record.
 *
 * WHY THIS SPEC EXISTS. `SPEC-ACCESS-AND-CONTROLS-AUDITING.md` says "Implemented (audit capture and
 * the membership-history view)" and cited only unit tests. An audit trail is the one surface where
 * silence is indistinguishable from health: if the Kinesis subscription is disabled, the archival
 * Lambda is failing, or the view's read is broken, nothing errors for any user, no alarm fires, and
 * the console shows an empty history that looks exactly like a conversation nobody touched. The
 * record is trusted precisely because nobody re-derives it, which is what makes an unnoticed gap
 * worse than having no record at all.
 *
 * TWO FAIL-QUIET PATHS THIS ASSERTS AGAINST, both of which a naive test would sail through:
 *
 *   1. `membershipHistory` answers **200 with `{ history: [], archiveError }`** when the underlying
 *      read throws (admin-conversations.ts). A test that asserted `status === 200` would pass
 *      against a completely broken archive. So the body is asserted, not the status.
 *   2. An empty `history` is a legal response for a channel with no events. So this drives a REAL
 *      membership change first and then requires that specific channel to have a record - an
 *      assertion that cannot be satisfied by an archive that returns nothing.
 *
 * The archive endpoints are AWS_IAM-authorized (A14 `adminIamEnforcement`), so the request is
 * SigV4-signed Node-side via `helpers/signed-analytics.ts`. A Cognito Bearer token is rejected 403
 * and the browser cannot sign it.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getBasicUser, getAdminUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signedAdminGet } from './helpers/signed-analytics';

guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();
const REGION = process.env.AWS_REGION || 'us-east-1';
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';
const ADMIN_CONVERSATIONS_API =
  process.env.VITE_ADMIN_CONVERSATIONS_API_URL || process.env.ADMIN_CONVERSATIONS_API_URL || '';

function aws(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

test.describe('Access auditing — the capture path is deployed and enabled', () => {
  test.skip(!E2E_RUNNABLE, 'Needs AWS credentials to read the deployed event-source wiring.');
  guardBackendErrors('access-auditing-wiring');

  test('the archival consumer is subscribed to the channel event stream, and ENABLED', async () => {
    const fns: string[] = aws(
      `lambda list-functions --query "Functions[?contains(FunctionName,'AgentEchelon') `
      + `&& (contains(FunctionName,'Archival') || contains(FunctionName,'KinesisArchival'))].FunctionName"`,
    );
    expect(
      fns?.length,
      'no AgentEchelon archival Lambda found. The audit record is produced by the Chime channel '
      + 'event stream -> Kinesis -> archival path; without that consumer there is no append-only '
      + 'record at all, however healthy the console looks.',
    ).toBeGreaterThan(0);

    const mappings = aws(`lambda list-event-source-mappings --function-name ${fns[0]}`);
    const kinesis = (mappings?.EventSourceMappings ?? []).filter((m: any) =>
      String(m.EventSourceArn || '').includes(':kinesis:'),
    );
    expect(
      kinesis.length,
      `${fns[0]} has no Kinesis event-source mapping. Channel events would be produced and never `
      + 'consumed - the stream fills and expires, and the audit view stays silently empty.',
    ).toBeGreaterThan(0);

    // State, not just existence. A DISABLED mapping is the exact fail-quiet shape this spec is for:
    // the infrastructure is all present, nothing errors, and no record is ever written.
    const enabled = kinesis.filter((m: any) => m.State === 'Enabled');
    expect(
      enabled.map((m: any) => m.State),
      `every Kinesis mapping on ${fns[0]} is present but not Enabled (states: `
      + `${kinesis.map((m: any) => m.State).join(', ')}). Audit capture is stopped.`,
    ).not.toEqual([]);

    console.log(`\n--- audit capture ---\n${fns[0]}: ${enabled.length} enabled Kinesis mapping(s)`);
  });
});

test.describe('Access auditing — a membership change lands in the record', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + AWS credentials.');
  test.skip(!ADMIN_BASE_URL, 'Needs E2E_ADMIN_BASE_URL (the admin console origin) to obtain an admin token.');
  test.skip(
    !ADMIN_CONVERSATIONS_API,
    'Needs VITE_ADMIN_CONVERSATIONS_API_URL. It is written into frontend/packages/admin/.env by '
    + 'gen-frontend-env; export it, or source that file, before running.',
  );
  guardBackendErrors('access-auditing-record');

  test('creating a conversation produces a membership record the admin view can read', async ({ browser }) => {
    test.setTimeout(420_000);

    const user = await getBasicUser();
    const admin = await getAdminUser();
    test.skip(!user.password, missingUserReason('basicUser'));
    test.skip(!admin.password, missingUserReason('testAdmin'));

    // --- 1. Drive a real membership change on the chat origin. -------------------------------
    // Creating a conversation creates the channel AND the creator's membership, which is the
    // event the capture path is supposed to record.
    const chatCtx = await browser.newContext();
    const chatPage = await chatCtx.newPage();
    let channelArn = '';
    try {
      await signIn(chatPage, user.email, user.password);
      await expect(chatPage.locator('.app-header')).toBeVisible({ timeout: 30000 });

      const createResp = chatPage.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30000 },
      );
      const title = `Audit e2e ${Date.now()}`;
      await createConversation(chatPage, title, 'Open');
      const body = await (await createResp).json();
      channelArn = body?.conversation?.conversationArn || '';
      expect(channelArn, 'channelArn from the create-conversation response').toBeTruthy();
      console.log(`\n--- audited channel ---\n${channelArn}`);
    } finally {
      await chatCtx.close();
    }

    // --- 2. Obtain an admin token on the ADMIN origin. ---------------------------------------
    // The archive routes are admin-plane; the console signs its own requests with Identity-Pool
    // credentials derived from this token.
    const adminCtx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const adminPage = await adminCtx.newPage();
    let idToken = '';
    try {
      await signIn(adminPage, admin.email, admin.password);
      idToken = (await adminPage.evaluate(() => localStorage.getItem('idToken'))) || '';
      expect(idToken, 'admin idToken after signing in to the admin console').toBeTruthy();
    } finally {
      await adminCtx.close();
    }

    // --- 3. Poll the append-only record for THIS channel. ------------------------------------
    // Chime -> Kinesis -> archival is asynchronous, so poll rather than assume. Polling also keeps
    // a fast path fast instead of sleeping a fixed worst case.
    const deadline = Date.now() + 300_000;
    let last: { status: number; body: any } | null = null;
    let history: any[] = [];

    for (;;) {
      last = await signedAdminGet(ADMIN_CONVERSATIONS_API + '/membership-history', idToken, { channelArn });

      // Fail-quiet path #1: a 200 carrying archiveError is a BROKEN read, not an empty history.
      expect(
        last.body?.archiveError ?? null,
        'membership-history answered 200 with an archiveError, which is how a broken archive read '
        + 'presents itself. The console renders this as an empty history - indistinguishable from a '
        + 'conversation nobody touched.',
      ).toBeNull();

      expect(
        last.status,
        `membership-history returned ${last.status}. 403 means the SigV4 signing or the admin `
        + 'capability is wrong, not that the record is missing.',
      ).toBe(200);

      history = Array.isArray(last.body?.history) ? last.body.history : [];
      if (history.length > 0) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 15_000));
    }

    // Fail-quiet path #2: the assertion is scoped to a channel we just created, so an archive that
    // returns nothing cannot satisfy it.
    expect(
      history.length,
      'no membership record for a channel created moments ago. The capture path is subscribed and '
      + 'enabled (asserted above), so the event is being produced and not landing: check the '
      + 'archival Lambda log group for write failures, and that the admin read targets the same '
      + 'store the archiver writes.',
    ).toBeGreaterThan(0);

    console.log(`\n--- membership history (${history.length} row(s)) ---`);
    console.log(JSON.stringify(history.slice(0, 3), null, 2));

    // The record must identify WHO and WHAT — an audit row with neither is not an audit row.
    const serialised = JSON.stringify(history).toLowerCase();
    expect(
      serialised,
      'the membership history carries no member identity. "Who could act" is the question this '
      + 'record exists to answer.',
    ).toMatch(/member|user|sub|arn/);
  });
});
