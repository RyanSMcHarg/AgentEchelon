/**
 * A MESSAGE WHOSE `Target` DISAGREES WITH WHAT IT SAYS IS AN ERROR IN THE CLIENT, AND THE SUITE WATCHES FOR IT.
 *
 * Who can see a message is the `Target` Amazon Chime SDK set. The client compares it with what the platform wrote about
 * the message (the composer's private address, the recipient an assistant stamps) and reports a disagreement as an error
 * on the message and in the console under one marker (`[target-mismatch]`, `targetIntegrity.ts`). Every test in this
 * suite fails if a page logs that marker undeclared (`helpers/fixtures.ts`), so this spec is the other half: it makes
 * the disagreements on purpose and proves the client reports each, and reports nothing for a message that agrees.
 *
 * What it proves, against the deployed app, as a signed-in person with an assistant in the room:
 *  - the live event for a targeted message carries its `Target`, and the message reads as visible to two people;
 *  - an assistant's reply stamped for this person and sent with no `Target` is shown with an error, and logged;
 *  - a message opening with a private address to this person and sent with no `Target` is shown with an error, and logged;
 *  - after a reload, history shows the same two errors and logs them again, and the agreeing message has none.
 */
import { execFileSync } from 'child_process';
import { test, expect, expectTargetMismatch, targetMismatchesSeen, TARGET_MISMATCH_LOG } from './helpers/fixtures';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getPremiumUser } from './helpers/test-credentials';
import { personIdOf } from './helpers/person';
import { allowConsoleError, guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardBackendErrors('target-integrity');
guardConsoleErrors();

const region = process.env.AWS_REGION || 'us-east-1';
/** The service, called as the deployment's operator, bearing the room's assistant: what an assistant's own send is. */
const chime = (args: string[]): string => execFileSync('aws', ['chime-sdk-messaging', ...args, '--region', region, '--output', 'json'],
  { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', PYTHONUTF8: '1' } });

test.describe('a message that disagrees with its Target', () => {
  test('is an error on the message and in the console, live and in history; one that agrees is not', async ({ page }) => {
    test.setTimeout(240_000);
    expectTargetMismatch();
    // The client's own target-mismatch errors are this test's subject; any other console error still fails it.
    allowConsoleError(TARGET_MISMATCH_LOG);

    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    page.on('websocket', (ws) => ws.on('framereceived', (f) => {
      try {
        const outer = JSON.parse(String(f.payload)) as { Headers?: Record<string, string>; Payload?: string };
        frames.push({ type: outer.Headers?.['x-amz-chime-event-type'] || '', payload: outer.Payload ? JSON.parse(outer.Payload) as Record<string, unknown> : {} });
      } catch { /* not a messaging frame */ }
    }));

    const user = await getPremiumUser();
    await signIn(page, user.email, user.password);
    await createConversation(page, 'target integrity', 'Premium');

    // The conversation and its assistant, from the welcome this session receives.
    const fromAssistant = (f: { type: string; payload: Record<string, unknown> }) =>
      f.type === 'CREATE_CHANNEL_MESSAGE' && String((f.payload.Sender as { Arn?: string } | undefined)?.Arn).includes('/bot/');
    await expect.poll(() => frames.some(fromAssistant), { timeout: 60_000 }).toBe(true);
    const welcome = [...frames].reverse().find(fromAssistant)!;
    const channelArn = String(welcome.payload.ChannelArn);
    const botArn = String((welcome.payload.Sender as { Arn: string }).Arn);
    const members = JSON.parse(chime(['list-channel-memberships', '--channel-arn', channelArn, '--chime-bearer', botArn])) as { ChannelMemberships: Array<{ Member: { Arn: string } }> };
    const userArn = members.ChannelMemberships.map((m) => m.Member.Arn).find((a) => a.includes('/user/'))!;
    expect(userArn, 'this person is a member of the conversation').toBeTruthy();

    const run = Date.now();
    const send = (content: string, opts: { target?: boolean; metadata?: Record<string, unknown> }) => chime([
      'send-channel-message', '--channel-arn', channelArn, '--chime-bearer', botArn, '--content', content, '--type', 'STANDARD', '--persistence', 'PERSISTENT',
      ...(opts.metadata ? ['--metadata', JSON.stringify(opts.metadata)] : []),
      ...(opts.target ? ['--target', `MemberArn=${userArn}`] : []),
    ]);
    const agrees = `agrees-${run}`;
    const stamped = `stamped-${run}`;
    const addressed = `addressed-${run}`;

    // 1. AGREES: targeted to this person, and stamped for them.
    send(agrees, { target: true, metadata: { botResponse: true, targetedSender: userArn } });
    await expect(page.getByText(agrees)).toBeVisible({ timeout: 30_000 });
    const created = frames.find((f) => f.type === 'CREATE_CHANNEL_MESSAGE' && String(f.payload.Content || '').includes(agrees));
    expect(created?.payload.Target, 'the live event carries the Target to its recipient').toEqual([{ MemberArn: userArn }]);
    const agreeing = page.locator('.message', { hasText: agrees });
    await expect(agreeing.getByTestId('targeted-label')).toBeVisible();
    await expect(agreeing.getByTestId('target-mismatch')).toHaveCount(0);
    expect(targetMismatchesSeen(), 'a message that agrees with its Target logs nothing').toEqual([]);

    // 2. AN ASSISTANT'S STAMP WITH NO TARGET: marked private to this person, delivered to the room.
    send(stamped, { metadata: { botResponse: true, targetedSender: userArn } });
    const stampedMessage = page.locator('.message', { hasText: stamped });
    await expect(stampedMessage.getByTestId('target-mismatch')).toBeVisible({ timeout: 30_000 });
    await expect(stampedMessage.getByTestId('targeted-label'), 'it does not also read as private').toHaveCount(0);
    await expect.poll(() => targetMismatchesSeen().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

    // 3. A PRIVATE ADDRESS WITH NO TARGET: the composer's own token for this person, delivered to the room.
    send(`.<${user.email.split('@')[0]}|${personIdOf(userArn)}> ${addressed}`, { metadata: { botResponse: true } });
    const addressedMessage = page.locator('.message', { hasText: addressed });
    await expect(addressedMessage.getByTestId('target-mismatch')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => targetMismatchesSeen().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    for (const line of targetMismatchesSeen()) expect(line).toContain(TARGET_MISMATCH_LOG);

    // 4. HISTORY SAYS THE SAME: after a reload the page of messages is read from the service, not from the socket.
    const live = targetMismatchesSeen().length;
    await page.reload();
    await expect(page.locator('.message', { hasText: stamped }).getByTestId('target-mismatch')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.message', { hasText: addressed }).getByTestId('target-mismatch')).toBeVisible();
    await expect(page.locator('.message', { hasText: agrees }).getByTestId('target-mismatch')).toHaveCount(0);
    await expect(page.locator('.message', { hasText: agrees }).getByTestId('targeted-label')).toBeVisible();
    await expect.poll(() => targetMismatchesSeen().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(live + 2);
  });
});
