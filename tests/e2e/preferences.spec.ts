/**
 * B9 against a deployment: a mail a person can stop carries its one-click unsubscribe, the one click stops
 * that kind for that person, and the next mail of that kind is not sent. READ FROM THE TEST INBOX.
 *
 *  1. An assistant's mention emails the named member. The stored message carries `List-Unsubscribe` and
 *     `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and, where the deployment receives replies, a
 *     `Reply-To` on the reply subdomain.
 *  2. A `GET` of the link changes nothing (a link scanner unsubscribes nobody).
 *  3. The one-click `POST` the header names, with no sign-in, mutes `email:conversation` on the person's
 *     own `<personId>#notices` item, keyed by their AppInstanceUser, never by their address.
 *  4. The next mention of that person is not emailed. ABSENCE IS ORDERED, not timed: a mention of the
 *     sender, who has muted nothing, is posted after it in the same room, and its arrival proves the muted
 *     one had its turn.
 *
 * The reply half (B10: mail without a valid token posts nothing) is `backend/scripts/deny-test-reply-token.mjs`,
 * because it needs mail sent INTO the deployment, which this suite has no sender for.
 *
 *   AWS_PROFILE=<p> npx playwright test e2e/preferences.spec.ts --config=playwright.config.ts
 */
import { test, expect } from './helpers/fixtures';
import { execFileSync } from 'child_process';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { personArnOf, personIdOf } from './helpers/person';
import { getTestInbox, inboxSkipReason, waitForEmail, emailsTo } from './helpers/test-inbox';
import { SSM_ROOT } from './helpers/stack-prefix';
import { awsv } from './helpers/aws';
import { profileTable } from './helpers/profile-store';

guardBackendErrors('preferences');
guardConsoleErrors();

const REGION = process.env.AWS_REGION || 'us-east-1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const ssmValue = (name: string): string => {
  try { return String(awsv(['ssm', 'get-parameter', '--name', name])?.Parameter?.Value || ''); } catch { return ''; }
};
/** The raw stored message's header block, which the inbox helper does not keep. */
const rawHeaders = (bucket: string, key: string): string => execFileSync('aws', ['s3', 'cp', `s3://${bucket}/${key}`, '-', '--region', REGION], {
  encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' },
}).split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
const header = (headers: string, name: string): string => new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headers)?.[1]?.trim() ?? '';

test.describe('A mail a person can stop carries one-click unsubscribe, and the click stops it (B9)', () => {
  test('the headers, a GET that changes nothing, the one click, and the next mail not sent', async ({ page }) => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'needs the provisioned test users');
    test.setTimeout(600_000);

    const creds = await getTestCredentials();
    const sender = creds.premiumUser;
    const named = creds.secondPremiumUser;
    test.skip(!sender?.password, missingUserReason('premiumUser'));
    test.skip(!named?.password, missingUserReason('secondPremiumUser'));
    const inbox = await getTestInbox();
    const unavailable = inboxSkipReason(inbox, sender.email, named!.email);
    test.skip(Boolean(unavailable), unavailable);

    const senderArn = await personArnOf(sender);
    const namedArn = await personArnOf(named!);
    const serviceAdminArn = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(serviceAdminArn, 'the service app-instance-admin ARN must be published').toContain('/user/');
    const prefsKey = JSON.stringify({ personId: { S: `${personIdOf(namedArn)}#notices` } });
    const clearPrefs = () => awsv(['dynamodb', 'delete-item', '--table-name', profileTable(), '--key', prefsKey]);
    clearPrefs();

    try {
      await signIn(page, sender.email, sender.password);
      await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
      const createResp = page.waitForResponse((r) => r.url().includes('/create-conversation') && r.request().method() === 'POST', { timeout: 30000 });
      await createConversation(page, `Preferences e2e ${Date.now()}`, 'Premium');
      const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
      expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
      const channelId = channelArn.split('/channel/').pop() || '';
      awsv(['chime-sdk-messaging', 'create-channel-membership', '--channel-arn', channelArn,
        '--member-arn', namedArn, '--type', 'DEFAULT', '--chime-bearer', serviceAdminArn]);
      let botArn = '';
      for (let i = 0; i < 12 && !botArn; i += 1) {
        const r = awsv(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn, '--chime-bearer', serviceAdminArn]);
        botArn = ((r?.ChannelMemberships ?? []) as any[]).map((m) => String(m?.Member?.Arn || '')).find((a) => a.includes('/bot/')) || '';
        if (!botArn) await page.waitForTimeout(5_000);
      }
      expect(botArn, 'the conversation has no assistant member to post as').toBeTruthy();
      const post = (who: string, subject: string) => awsv(['chime-sdk-messaging', 'send-channel-message',
        '--channel-arn', channelArn, '--content', `@<Member|${personIdOf(who)}> the report is ready.`, '--type', 'STANDARD',
        '--persistence', 'PERSISTENT', '--metadata', JSON.stringify({ notify: { email: true }, notifySubject: subject, notifyConversationId: channelId }),
        '--chime-bearer', botArn]);

      // ── 1. THE HEADERS ─────────────────────────────────────────────────────────────────────────────
      const run = `${Date.now()}`;
      const since = Date.now() - 5_000;
      const first = `Preferences e2e first ${run}`;
      post(namedArn, first);
      const got = await waitForEmail(inbox!, { to: named!.email, since, subjectIncludes: first });
      const headers = rawHeaders(inbox!.bucket, got.key);
      const unsubscribe = /^<(https:[^>]+)>$/.exec(header(headers, 'List-Unsubscribe'))?.[1] ?? '';
      expect(unsubscribe, 'List-Unsubscribe names an https URL').toMatch(/\/email\/preferences\?t=/);
      expect(header(headers, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
      const replyTo = header(headers, 'Reply-To');
      if (replyTo) expect(replyTo, 'a reply address carries a reply token').toMatch(/^reply\+[a-z2-7]{52}@/);
      else console.log('  this deployment takes no replies (no replyDomain), so the mail carries no Reply-To');

      // ── 2. A GET CHANGES NOTHING ───────────────────────────────────────────────────────────────────
      const viewed = await fetch(unsubscribe);
      expect(viewed.status).toBe(200);
      expect(awsv(['dynamodb', 'get-item', '--table-name', profileTable(), '--key', prefsKey])?.Item, 'a GET wrote a preference').toBeUndefined();

      // ── 3. THE ONE CLICK ───────────────────────────────────────────────────────────────────────────
      const clicked = await fetch(unsubscribe, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
      expect(clicked.status).toBe(200);
      const item = awsv(['dynamodb', 'get-item', '--table-name', profileTable(), '--key', prefsKey])?.Item;
      expect(item?.personArn?.S, 'the preference is the person\'s, by AppInstanceUser').toBe(namedArn);
      expect(Object.keys(item?.muted?.M ?? {})).toEqual(['email:conversation']);
      expect(JSON.stringify(item)).not.toContain(named!.email);

      // ── 4. THE NEXT MAIL OF THAT KIND IS NOT SENT ──────────────────────────────────────────────────
      const muted = `Preferences e2e muted ${run}`;
      const control = `Preferences e2e control ${run}`;
      post(namedArn, muted);
      post(senderArn, control);
      await waitForEmail(inbox!, { to: sender.email, since, subjectIncludes: control });
      expect(emailsTo(inbox!, { to: named!.email, since, subjectIncludes: muted }), 'a muted kind was emailed').toEqual([]);
    } finally {
      clearPrefs();
    }
  });
});
