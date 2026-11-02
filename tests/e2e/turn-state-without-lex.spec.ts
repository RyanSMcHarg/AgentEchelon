/**
 * TURN STATE DOES NOT RIDE THE AMAZON LEX SESSION (live).
 *
 * The drift offer and the onboarding intake used to keep their state in Lex `sessionAttributes`. That
 * session exists only when Lex is the entry: a turn the channel flow answers - `@<assistant>` and `@all`
 * in a group - starts with it empty and its writes are discarded, and Lex drops it after five idle
 * minutes on its own. The state now lives in stores AgentEchelon owns (Aurora for the open offer, the
 * channel context row for the intake), and these tests exercise the paths where the old design broke.
 *
 * Every assertion that matters is read from the BACKEND - the channel's own messages, the drift-created
 * channel resolved by its parent pointer, the channel flow's addressing log - not inferred from the DOM.
 *
 * Deliberately NOT here, because a browser cannot trigger them deterministically, and where they ARE
 * covered:
 *   - a DECLINED topic is not offered again (the known-topic check). It needs a cosine offer, which
 *     needs a summary embedding and a model-dependent distance; the explicit-routing offer these tests
 *     use keeps no embedding by design.
 *       -> backend/test/analytics-aurora/drift-detection.test.ts, backend/test/lib/live-drift-flow.test.ts
 *   - a REDELIVERED offering message, or a message sent before the offer, does not decline it. Needs a
 *     duplicate delivery on demand.
 *       -> backend/test/lib/live-drift-flow.test.ts
 *   - a duplicate processor run does not release the live turn lock.
 *       -> backend/test/lib/a-duplicate-run-does-not-release-the-live-lock.test.ts
 *   - the intake advances once per answer under a duplicate delivery.
 *       -> backend/test/lib/an-intake-is-advanced-only-by-its-subject.test.ts,
 *          backend/test/lib/channel-context-client.test.ts
 *   - the stored intake itself, live: e2e/onboarding-intake.spec.ts (gated on ONBOARDING_E2E=1).
 */
import { test, expect } from './helpers/fixtures';
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  WebSocketMonitor,
} from './helpers/agent-helpers';
import {
  hasTestCredentials,
  getPremiumUser,
  getSecondPremiumUser,
  missingUserReason,
} from './helpers/test-credentials';
import { driftChannelForParent, assertNotAnErrorReply } from './helpers/drift-backend';
import { openGroupConversation, closeGroup, type GroupConversation } from './helpers/group-conversation';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { stackName, physicalIdsIn } from './helpers/stack-prefix';
import { awsv as aws } from './helpers/aws';

// THE TWO GUARDS THAT WATCH WHAT THE ASSERTIONS BELOW CANNOT. This spec reads its evidence from the
// backend on purpose, which is exactly the shape that stays green while a handler logs AccessDenied
// on every request; and it drives a browser, so a React error on the drift path would otherwise be
// invisible.
guardBackendErrors('turn-state-without-lex');
guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();

// An unambiguous explicit-routing phrase (lib/explicit-routing.ts): drift offers on the FIRST message,
// with no dependence on a summary having been written.
const DRIFT_TRIGGER = "let's start a new conversation about quarterly revenue forecasting";
// Stable substring of SUGGESTION_CONFIRM_TEMPLATE (analytics-aurora/drift-detection.ts).
const SUGGESTION_MARKER = 'start a separate conversation for this';

interface ChannelMember { arn: string; name: string }

/** The conversation's members with their display names, which is what `@name` and `.name` resolve against. */
function membersOf(channelArn: string, asArn: string): ChannelMember[] {
  const r = aws(['chime-sdk-messaging', 'list-channel-memberships',
    '--channel-arn', channelArn, '--chime-bearer', asArn, '--max-results', '50']);
  return (r?.ChannelMemberships || []).map((m: any) => ({ arn: m?.Member?.Arn || '', name: m?.Member?.Name || '' }));
}

/**
 * Send AS a member, the way a non-web ingress would: admin IAM credentials, the member's own bearer.
 * `target` sets a Chime `Target`, which is what makes a message private.
 */
function sendAsMember(channelArn: string, senderArn: string, content: string, target?: string): string {
  const res = aws([
    'chime-sdk-messaging', 'send-channel-message',
    '--channel-arn', channelArn,
    '--content', content,
    '--type', 'STANDARD',
    '--persistence', 'PERSISTENT',
    '--chime-bearer', senderArn,
    ...(target ? ['--target', `MemberArn=${target}`] : []),
  ]);
  return res?.MessageId as string;
}

interface ListedMessage { id: string; sender: string; content: string; createdAt: number }

/** The channel's recent messages as `asArn` sees them, decoded, newest first. */
function recentMessages(channelArn: string, asArn: string): ListedMessage[] {
  const r = aws(['chime-sdk-messaging', 'list-channel-messages',
    '--channel-arn', channelArn, '--chime-bearer', asArn, '--max-results', '50', '--sort-order', 'DESCENDING']);
  return (r?.ChannelMessages || []).map((m: any) => {
    const raw = String(m?.Content || '');
    let content = raw;
    try { content = decodeURIComponent(raw); } catch { /* not encoded */ }
    return { id: m?.MessageId || '', sender: m?.Sender?.Arn || '', content, createdAt: Date.parse(m?.CreatedTimestamp || '') || 0 };
  });
}

async function pollFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs: number, stepMs = 2500): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

/** The channel flow's addressing decision for one message, from its own log line. The processor's
 *  name is read from its stack rather than built from it (helpers/stack-prefix.ts). */
function flowAddressingLog(messageId: string, sinceMs: number): string {
  const [processor] = physicalIdsIn([stackName('ChannelFlow')], { type: 'AWS::Lambda::Function', logicalId: /^ChannelFlowProcessor/ });
  const groups = processor
    ? aws(['logs', 'describe-log-groups', '--log-group-name-prefix', `/aws/lambda/${processor}`])
      ?.logGroups?.map((g: any) => g.logGroupName) || []
    : [];
  for (const group of groups) {
    const events = aws(['logs', 'filter-log-events', '--log-group-name', group,
      '--start-time', String(sinceMs), '--filter-pattern', `"${messageId}"`])?.events || [];
    const line = events.map((e: any) => String(e.message || '')).find((m: string) => m.includes('[ChannelFlow] addressing'));
    if (line) return line.replace(/\s+/g, ' ');
  }
  return '';
}

test.describe('Turn state without the Amazon Lex session (live)', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + a live E2E_BASE_URL.');

  test('an ordinary reply to a drift offer declines it, so a later "yes" has nothing to accept', async ({ page }) => {
    // The offer says "Reply 'yes' to create one, or anything else to keep going here". A person who simply
    // carries on has answered it. Before, that reply left the offer pending in the Lex session, so a "yes"
    // minutes later could still split a conversation the person had long since continued.
    //
    // THE BUDGET, WHICH THIS TEST WAS MISSING. It drives THREE real turns as a premium user, so every
    // one of them is an Opus answer, and LATENCY-TARGETS records that the placeholder lands in
    // seconds while the update carrying the full reply can take far longer. Its two siblings below
    // already carry 240s and 180s for exactly this; this one was left on Playwright's 120s default
    // and timed out against the live deployment with no assertion failing - the run said nothing
    // about the behavior under test, which is the worst kind of red.
    test.setTimeout(240_000);
    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));
    const ws = new WebSocketMonitor();
    await signIn(page, user.email, user.password, ws);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, 'E2E Drift Carry On', 'Premium');
    const originArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(originArn, 'origin channelArn from create-conversation').toBeTruthy();
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const offer = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, ws);
    expect(offer.text.toLowerCase(), 'the pivot should produce a drift offer').toContain(SUGGESTION_MARKER);

    // Carry on instead of answering: this is the decline.
    const carriedOn = await sendAndWaitForResponse(page, 'Before that, what is 17 multiplied by 3?', 90000, ws);
    assertNotAnErrorReply(carriedOn.text, 'the reply to a message that carried on');
    expect(carriedOn.text.toLowerCase(), 'carrying on must be answered, not offered again').not.toContain(SUGGESTION_MARKER);
    expect(carriedOn.text).not.toContain('NAVIGATE_CHANNEL');

    // A late "yes" now answers nothing: the offer is closed.
    await sendAndWaitForResponse(page, 'yes', 60000, ws);
    const child = await pollFor(() => driftChannelForParent(originArn), 20000);
    expect(child, 'a "yes" after the person carried on must not create the split-out conversation').toBeNull();
  });

  test('a drift offer made and accepted through the channel flow, where there is no Lex session, is honored', async ({ page }) => {
    // In a group, `@<assistant>` is routed by the channel flow straight to the agent handler: no Lex, no Lex
    // session. The open offer used to live in that session, so the "yes" that answered it found nothing.
    test.setTimeout(240_000);
    const creator = await getPremiumUser();
    const other = await getSecondPremiumUser();
    test.skip(!creator.password, missingUserReason('premiumUser'));
    test.skip(!other?.password, missingUserReason('secondPremiumUser'));

    let group: GroupConversation | null = null;
    try {
      group = await openGroupConversation({ page, creator, others: [other!], title: 'E2E Drift Via Flow', classification: 'Premium' });
      test.skip(!group, 'the group conversation could not be assembled on this deployment');
      const { channelArn } = group!;
      const me = group!.creator.arn;

      const bot = membersOf(channelArn, me).find((m) => m.arn.includes('/bot/'));
      expect(bot?.name, 'the conversation has an assistant member to address').toBeTruthy();

      const sentAt = Date.now() - 2000;
      sendAsMember(channelArn, me, `@${bot!.name} ${DRIFT_TRIGGER}`);
      const offer = await pollFor(
        () => recentMessages(channelArn, me).find((m) => m.sender.includes('/bot/') && m.createdAt >= sentAt
          && m.content.toLowerCase().includes(SUGGESTION_MARKER)),
        90000,
      );
      expect(offer, 'the @-addressed pivot should produce a drift offer through the channel flow').not.toBeNull();

      sendAsMember(channelArn, me, `@${bot!.name} yes`);
      const child = await pollFor(() => driftChannelForParent(channelArn), 90000);
      expect(child, 'the @-addressed "yes" should accept the durable offer and create the conversation').not.toBeNull();
    } finally {
      await closeGroup(group);
    }
  });

  test('a private message that also names the assistant is not taken by the channel flow and answered in public', async ({ page }) => {
    // `.<member> @<assistant> ...` is readable by two people. A flow-dispatched turn answers untargeted, so
    // taking it would put the answer in front of the room. The web composer refuses the combination; this
    // sends it the way another ingress would.
    test.setTimeout(180_000);
    const creator = await getPremiumUser();
    const other = await getSecondPremiumUser();
    test.skip(!creator.password, missingUserReason('premiumUser'));
    test.skip(!other?.password, missingUserReason('secondPremiumUser'));

    let group: GroupConversation | null = null;
    try {
      group = await openGroupConversation({ page, creator, others: [other!], title: 'E2E Private With Mention', classification: 'Premium' });
      test.skip(!group, 'the group conversation could not be assembled on this deployment');
      const { channelArn } = group!;
      const me = group!.creator.arn;
      const members = membersOf(channelArn, me);
      const bot = members.find((m) => m.arn.includes('/bot/'));
      const person = members.find((m) => m.arn === group!.others[0].arn);
      expect(bot?.name && person?.name, 'both the assistant and the other person have display names').toBeTruthy();

      const sentAt = Date.now() - 2000;
      const messageId = sendAsMember(
        channelArn,
        me,
        `.<${person!.name}> @${bot!.name} what is the capital of France?`,
        person!.arn,
      );
      expect(messageId, 'the private message was accepted').toBeTruthy();

      // POSITIVE EVIDENCE FIRST: the flow resolved the private address and did not take the turn.
      const decision = await pollFor(() => flowAddressingLog(messageId, sentAt), 60000, 5000);
      expect(decision, 'the channel flow logged its addressing decision for this message').toBeTruthy();
      expect(decision, `the flow must see the private address: ${decision}`).toMatch(/privatelyAddressed: true/);
      expect(decision, `the flow must not own a private message's turn: ${decision}`).toMatch(/ownsTheTurn: false/);

      // And nothing was answered in public: the room (the other member's view) has no new assistant reply.
      await page.waitForTimeout(20000);
      const botRepliesSeenByRoom = recentMessages(channelArn, group!.others[0].arn)
        .filter((m) => m.sender.includes('/bot/') && m.createdAt >= sentAt);
      expect(botRepliesSeenByRoom.map((m) => m.content), 'no assistant reply to a private message was posted to the room')
        .toEqual([]);
    } finally {
      await closeGroup(group);
    }
  });
});
