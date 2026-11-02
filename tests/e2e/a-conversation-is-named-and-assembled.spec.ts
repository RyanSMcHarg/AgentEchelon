/**
 * A person-created conversation is assembled by the service admin and named on its first turn.
 *
 * WHAT THIS PROVES THAT UNIT TESTS CANNOT. Person-created conversations are created by the service admin
 * (channel-creation.ts CREATOR_BEARER_ARN), which then hands the room over and leaves. Two things broke
 * with that change and no spec noticed, because none drove them:
 *
 *  1. The first-turn title rename refused every room the assistant had not created, so no conversation
 *     was ever named. Asserted on the `UPDATE_CHANNEL` event the client receives, then on the header the
 *     chat app renders from it: the person's own path, not a read of the channel on a timer.
 *  2. The admin must not remain a member or a moderator of the room it assembled, where every human count
 *     would read it as a person. Asserted against the live Amazon Chime SDK membership, read once after
 *     creation returns, since creation finishes the hand-over before it returns.
 *
 * Gated behind a live E2E_BASE_URL and provisioned users.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse, WebSocketMonitor, ConsoleMonitor } from './helpers/agent-helpers';
import { getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { SSM_ROOT } from './helpers/stack-prefix';
import { awsvText as aws } from './helpers/aws';

guardConsoleErrors();

const RUNNABLE = !!process.env.E2E_BASE_URL;

test.describe.serial('A person-created conversation (service-admin assembly)', () => {
  guardBackendErrors('a-conversation-is-named-and-assembled');

  test('is named on its first turn, by the event the client receives', async ({ page }) => {
    test.skip(!RUNNABLE, 'Needs a live E2E_BASE_URL.');
    const user = await getPremiumUser();
    test.skip(!user?.password, missingUserReason('premiumUser'));
    const ws = new WebSocketMonitor();
    const cons = new ConsoleMonitor();
    await signIn(page, user.email, user.password, ws, cons);

    const createResp = page.waitForResponse((r) => r.url().includes('/create-conversation') && r.request().method() === 'POST', { timeout: 30000 });
    await createConversation(page, 'Naming check', 'Premium');
    const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // 2. THE ADMIN HAS LEFT. Read once: creation returned, so the hand-over is complete. The admin bears the
    //    read because an app instance admin may list any channel without being in it.
    const adminArn = aws(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/app-instance-admin-arn`, '--query', 'Parameter.Value', '--output', 'text']);
    const members = JSON.parse(aws(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn, '--chime-bearer', adminArn, '--output', 'json']));
    const memberArns: string[] = (members.ChannelMemberships ?? []).map((m: { Member?: { Arn?: string } }) => m.Member?.Arn ?? '');
    expect(memberArns, 'the service admin must not remain a member of the room it assembled').not.toContain(adminArn);
    expect(memberArns.some((a) => a.includes('/bot/')), 'the primary assistant is a member').toBe(true);

    // 1. NAMED ON THE FIRST TURN. Registered before the send, so an event that beats the reply is kept.
    const renamed = ws.waitForChannelRename(channelArn, 90000);
    await sendAndWaitForResponse(page, 'What is our current net revenue retention?', 90000, ws);
    const name = await renamed;
    expect(name, 'the derived title replaces the placeholder').not.toBe('New conversation');
    console.log(`[naming-e2e] renamed to "${name}"`);
    // And the client applied the event: the conversation shows the same name.
    await expect(page.locator('.conversation-header')).toContainText(name, { timeout: 15000 });
    cons.assertNoErrors();
  });
});
