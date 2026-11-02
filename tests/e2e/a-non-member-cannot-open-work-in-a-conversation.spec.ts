/**
 * POST /tasks REFUSES A NON-MEMBER, AND THAT NEEDS TWO REAL PEOPLE.
 *
 * WHY THIS IS AN E2E AND NOT A UNIT TEST. The unit suite covers the branch by mocking
 * `DescribeChannel` into a rejection, which proves the handler reacts to a refusal it was handed. It
 * cannot prove the refusal HAPPENS: that depends on Amazon Chime SDK authorizing `DescribeChannel`
 * against the `ChimeBearer` as well as against the function's role, which is the bearer pinning the
 * whole check rests on. Only a real non-member against a real channel exercises that.
 *
 * WHY IT CREATES ITS OWN NON-MEMBER CASE RATHER THAN LOOKING FOR ONE. A hand-run version of this
 * searched existing channel ARNs for the strings "admin" or "notification" and skipped when it found
 * none - which it never could, because channel ids here are `conv-<timestamp>-<hex>`. The filter was
 * dead on arrival, the case self-skipped, and the skip was reported as a pass. A conversation created
 * seconds ago by somebody else is a non-member case by construction and cannot rot into a no-op.
 *
 * THE CONTROL IS THE HALF THAT MAKES IT MEAN ANYTHING. The same conversation accepts a work item from
 * the person who owns it. Without that, a 403 proves only that something refused - a broken route, a
 * missing grant and a correct boundary all look identical from one failing call.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getPremiumUser, getStandardUser, missingUserReason } from './helpers/test-credentials';
import { personArnOf } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { SSM_ROOT } from './helpers/stack-prefix';
import { aws as awsJson } from './helpers/aws';
import { PERSON_API_URL, personUrl } from './helpers/api-urls';

guardConsoleErrors();

/** Sign in in a fresh context and return that person's id token, the way the app itself holds it. */
async function tokenFor(browser: any, email: string, password: string): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await signIn(page, email, password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const token = await idTokenOf(page);
    expect(token, `idToken in localStorage after signing in as ${email}`).toBeTruthy();
    return token;
  } finally {
    await ctx.close();
  }
}

test.describe('a non-member cannot open work in a conversation', () => {
  guardBackendErrors('a-non-member-cannot-open-work-in-a-conversation');
  test('the refusal binds on the bearer, and the owner can still open one', async ({ browser, request }) => {
    test.setTimeout(240_000);
    const standard = await getStandardUser();
    const premium = await getPremiumUser();
    test.skip(!standard.password, missingUserReason('standardUser'));
    test.skip(!premium.password, missingUserReason('premiumUser'));
    test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL must be set (run via validate.mjs)');

    const standardToken = await tokenFor(browser, standard.email, standard.password);
    const premiumToken = await tokenFor(browser, premium.email, premium.password);

    // ── A conversation that belongs to the standard user alone ──────────────────────────────────
    const created = await request.post(personUrl('/create-conversation'), {
      headers: { Authorization: `Bearer ${standardToken}`, 'Content-Type': 'application/json' },
      data: {
        title: `Not-a-member probe ${Date.now()}`,
        modelId: 'anthropic.claude-sonnet-4-5',
        modelName: 'Sonnet 4.5',
        modelTier: 'standard',
      },
    });
    expect(created.status(), 'the probe conversation must be created').toBe(200);
    const channelArn = (await created.json())?.conversation?.conversationArn as string;
    expect(channelArn, 'the create response must carry the conversation ARN').toContain('/channel/');
    console.log(`[non-member] probe conversation ${channelArn.split('/').pop()}`);

    // ── THE PREMISE, ASSERTED. A 403 below means nothing if the caller is in fact a member. ─────
    const adminArn = String(awsJson(
      `ssm get-parameter --name "${SSM_ROOT}/app-instance-admin-arn" `
      + '--query Parameter.Value',
    ) || '');
    expect(adminArn, 'the service admin ARN must resolve, to read the roster').toContain('/user/');
    const members: string[] = awsJson(
      `chime-sdk-messaging list-channel-memberships --channel-arn "${channelArn}" `
      + `--chime-bearer "${adminArn}" --query "ChannelMemberships[].Member.Arn"`,
    ) || [];
    const premiumArn = await personArnOf(premium);
    expect(premiumArn, 'the premium person must resolve to an AppInstanceUser').toContain('/user/');
    expect(
      members.filter((m) => m === premiumArn),
      'PREMISE: the premium user must NOT be a member of the probe conversation',
    ).toEqual([]);

    // ── THE REFUSAL ────────────────────────────────────────────────────────────────────────────
    const denied = await request.post(personUrl('/tasks'), {
      headers: { Authorization: `Bearer ${premiumToken}`, 'Content-Type': 'application/json' },
      data: { channelArn, taskType: 'action_item' },
    });
    const deniedBody = await denied.json().catch(() => ({}));
    expect(
      `${denied.status()} ${deniedBody?.code}`,
      'a non-member must be refused with NOT_A_MEMBER, not merely with some error',
    ).toBe('403 NOT_A_MEMBER');

    // ── THE CONTROL, which is what makes the refusal mean "membership" ──────────────────────────
    const allowed = await request.post(personUrl('/tasks'), {
      headers: { Authorization: `Bearer ${standardToken}`, 'Content-Type': 'application/json' },
      data: { channelArn, taskType: 'action_item', requestExcerpt: 'the owner may open work here' },
    });
    const allowedBody = await allowed.json().catch(() => ({}));
    expect(
      allowed.status(),
      `the conversation's own member must be able to open work (got ${allowed.status()} ${JSON.stringify(allowedBody)})`,
    ).toBe(201);
    expect(allowedBody?.task?.taskId, 'the created item must carry an id').toBeTruthy();
    // The server assigns the reference, and the room counts from one.
    expect(allowedBody?.task?.taskRef, 'the item must carry a server-assigned reference').toBeGreaterThan(0);
  });
});
