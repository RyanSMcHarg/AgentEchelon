/**
 * THE PERSON-FACING CREATION PATH NOW GOES THROUGH THE CANONICAL CREATOR (ADR-053 consolidation).
 *
 * WHY THIS NEEDS A LIVE TEST RATHER THAN A UNIT ONE. The claim is not "the function was called" - it is
 * that a conversation a person opens now carries the things the canonical creator gives it, and every
 * one of those is a property of the deployed channel rather than of the code: the channel flow is
 * attached, the conversation has the TYPE's retention rather than none, and the service admin that
 * created it is not left sitting in the roster. A unit test can only assert the arguments.
 *
 * WHAT IT REPLACED. `lambda/create-conversation/index.js` was raw JavaScript deployed with
 * `Code.fromAsset`, so it could not import `lib/*`: it hand-mirrored classification admission and read
 * its default retention from env vars the stack copied out of the conversation-type registry, and it
 * created its own channel. That is why a conversation TYPE meant nothing for the conversations people
 * actually open - only `typed-conversation-from-event` honored one.
 *
 * HOW THE NEW CHANNEL IS FOUND, after two wrong answers worth recording. Diffing
 * `list-channel-memberships-for-app-instance-user` fails because it pages at 50 and is not ordered by
 * recency, so on an account whose test user holds dozens of conversations the new one is simply not on
 * the page - and the test then reports "no conversation was created" for a creation that plainly worked.
 * Reading `?conversation=` from the app's URL fails too: that parameter is how a DEEP LINK arrives, not
 * something creation sets. What is reliable is the channel-context row, which the creator writes with an
 * `updatedAt` BEFORE the channel exists - so the newest row is the conversation just created, and it is
 * server-side state rather than a client's account of itself.
 *
 * EVERY ASSERTION IS STILL READ FROM THE DEPLOYMENT rather than from the response body: the body is the
 * handler's own account of itself, and what matters is what the channel carries.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getPremiumUser, missingUserReason } from './helpers/test-credentials';
import { personArnOf } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { MAX_CONVERSATION_TTL_DAYS } from '../../backend/lib/config/conversation-types';
import { SSM_ROOT } from './helpers/stack-prefix';
import { aws as awsJson } from './helpers/aws';

guardConsoleErrors();

/**
 * The service admin ARN the Chime stack publishes, and the app instance it belongs to.
 *
 * BOTH ARE KEPT. Discarding the `/user/...` tail and hard-coding the admin's id in the assertion below
 * made that assertion vacuous on any deployment whose resource prefix is not the default: the admin is
 * created as `${RES_PREFIX}-admin`, so a literal filter matches nothing and the guard passes without
 * testing anything. The published ARN is the identity itself, so it is what the roster is compared to.
 */
function serviceAdmin(): { adminArn: string; appArn: string } {
  const adminArn = String(awsJson(
    `ssm get-parameter --name "${SSM_ROOT}/app-instance-admin-arn" `
    + '--query Parameter.Value',
  ) || '');
  return { adminArn, appArn: adminArn.replace(/\/user\/.*$/, '') };
}

/**
 * Every person-opened conversation this deployment holds, newest first, read from the context rows the
 * creator writes. `conv-` only: a drift child is `conv-drift-` and an event-opened room `conv-<type>-`,
 * and neither is what this spec is about.
 */
function personConversations(): string[] {
  const table = process.env.CHANNEL_CONTEXT_TABLE || '';
  if (!table) return [];
  const out: any = awsJson(
    `dynamodb scan --table-name "${table}" --projection-expression "channelArn,updatedAt"`,
  );
  return (out?.Items || [])
    .map((i: any) => ({ arn: i.channelArn?.S as string, at: i.updatedAt?.S as string }))
    .filter((r: any) => r.arn && r.at && /\/channel\/conv-\d/.test(r.arn))
    .sort((a: any, b: any) => String(b.at).localeCompare(String(a.at)))
    .map((r: any) => r.arn);
}

const newestPersonConversation = () => personConversations()[0] || '';

test.describe('a person-opened conversation goes through the canonical creator', () => {
  guardBackendErrors('person-creation-consolidated');

  test('it is created with a flow, the type\'s retention, and no service admin left behind', async ({ page }) => {
    test.setTimeout(240_000);
    const premium = await getPremiumUser();
    test.skip(!premium.password, missingUserReason('premiumUser'));
    test.skip(!process.env.VITE_USER_POOL_ID, 'VITE_USER_POOL_ID must be set (run via validate.mjs)');
    test.skip(!process.env.CHANNEL_CONTEXT_TABLE, 'CHANNEL_CONTEXT_TABLE must be set to find the created conversation');

    const { adminArn, appArn: app } = serviceAdmin();
    expect(app, 'could not resolve the app instance from the published admin ARN').toMatch(/app-instance\//);
    expect(adminArn, 'could not resolve the service admin ARN, so step 3 below would prove nothing')
      .toMatch(/\/user\/.+$/);
    const userArn = await personArnOf(premium);
    expect(userArn.startsWith(`${app}/user/`), 'the person is not an AppInstanceUser of this instance').toBe(true);

    const before = new Set(personConversations());
    await signIn(page, premium.email, premium.password);
    await createConversation(page, `Consolidated creation ${Date.now()}`, 'premium');

    // The newest context row is the conversation just created. Polled rather than read once: creation
    // is a round trip, and the row is written at its start.
    let created = '';
    for (let i = 0; i < 12 && !created; i += 1) {
      await new Promise((r) => setTimeout(r, 2500));
      const arn = newestPersonConversation();
      if (arn && !before.has(arn)) created = arn;
    }
    expect(created, 'no new conversation appeared after creating one').toBeTruthy();
    console.log(`[person-creation] created ${created.split('/').pop()}`);

    const channel = awsJson(
      `chime-sdk-messaging describe-channel --channel-arn "${created}" --chime-bearer "${userArn}" `
      + '--query "Channel.{Flow:ChannelFlowArn,Exp:ExpirationSettings}"',
    );

    // 1. THE FLOW IS ATTACHED. Without it the conversation has no mention routing, no marker stripping
    //    and no private-address enforcement, while creation reports success.
    expect(channel?.Flow, 'the conversation was created with NO channel flow').toMatch(/channel-flow\//);

    // 2. IT HAS THE TYPE'S RETENTION. The handler used to read a default from an env var the stack
    //    mirrored out of the registry, and the deployed function had none of those vars - so a
    //    person-opened conversation never expired at all. The creator applies the type's own.
    expect(channel?.Exp, 'the conversation has no expiration; retention toggle 2 is not applied').toBeTruthy();
    expect(channel?.Exp?.ExpirationDays).toBeGreaterThan(0);
    expect(
      channel?.Exp?.ExpirationDays,
      `a conversation may not outlive this deployment's limit of ${MAX_CONVERSATION_TTL_DAYS} days`,
    ).toBeLessThanOrEqual(MAX_CONVERSATION_TTL_DAYS);

    // 3. THE SERVICE ADMIN IS NOT A MEMBER. It creates the channel so the flow is attached before any
    //    assistant is added, then leaves. A conversation carrying a member nobody added shows in the
    //    roster and counts toward the AUTO trigger's member test.
    const members: string[] = awsJson(
      `chime-sdk-messaging list-channel-memberships --channel-arn "${created}" `
      + `--chime-bearer "${userArn}" --query "ChannelMemberships[].Member.Arn"`,
    ) || [];
    // Compared against the PUBLISHED admin ARN, not a literal: see `serviceAdmin()`.
    expect(
      members.filter((m) => m === adminArn),
      'the service admin created the conversation and did not leave it',
    ).toEqual([]);

    // 4. AND THE PERSON AND AN ASSISTANT ARE BOTH IN IT, which is what makes the three above meaningful
    //    rather than true of an empty room.
    expect(members.some((m) => m === userArn), 'the person is not in their own conversation')
      .toBe(true);
    expect(members.some((m) => m.includes('/bot/')), 'no assistant is in the conversation').toBe(true);
  });
});
