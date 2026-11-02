/**
 * STILL VALID, BUT ITS PRECONDITION IS STALE (2026-09-30). The behavior it protects survives: a
 * member over the membership limit must not switch drift off for the room. What changed is WHO ASKS
 * FIRST. The serving assistant now bears the search and a human is the fallback, so "the heavy user
 * is the FIRST human the channel lists" no longer describes the bearer the router tries first, and
 * the assertion can pass without exercising the handover. Fix the precondition before trusting a
 * pass: the assistant must be the one refused, or a human must be refused after it.
 *
 * DRIFT SCOPING SURVIVES A MEMBER WHO IS IN TOO MANY CONVERSATIONS (SPEC-DRIFT-CONVERGENCE).
 *
 * THE DEFECT. The related-conversation scope is the intersection of every human member's channels,
 * asked of Amazon Chime SDK with `SearchChannels` (`lib/scoped-channels.ts`). The service refuses that
 * search when the SEARCHING user belongs to too many channels ("exceeds channel membership limit to
 * perform search", measured at 1038 on the dev deployment). The first human listed was always the
 * bearer, so a conversation whose first member was a heavy user failed closed - drift suggestions
 * switched off, permanently and invisibly, for exactly the people who use the product most. The fix is
 * a bearer retry: the intersection is the same whoever asks, so the search is re-asked as the next member.
 *
 * WHY AN E2E AT ALL. `scoped-channels.test.ts` pins the retry against a mocked client. It cannot show the
 * two things the fix rests on: that the live service really refuses a heavy bearer and answers a light
 * one for the same filter, and that the deployed router takes the retry. Both are asserted here.
 *
 * WHAT IS ASSERTED, AND WHY EACH IS NECESSARY.
 *
 *   1. PRECONDITIONS, as data, so the assertion below cannot pass for free:
 *      - one test user IS over the limit (its own search is refused with the limit message), and the
 *        other is not;
 *      - the heavy user is the FIRST human the channel lists, i.e. the bearer the router tries first.
 *        With the light user first there is nothing to retry, and the regression would pass too, so
 *        that ordering SKIPS rather than passing;
 *      - searched as the light user, the exact filter the router builds (both humans plus the serving
 *        assistant, paginated to the end) returns this conversation. That is the answer the retry has
 *        to find, read from the service itself.
 *   2. THE TURN reaches drift: a deterministic explicit-routing pivot, sent as the heavy user, fires the
 *      drift suggestion. The scope is resolved on that branch before `detectDrift` runs, so a suggestion
 *      is proof the scoping ran for this conversation.
 *   3. THE ASSERTION: the router's log carries no `[scoped-channels]` failure naming this conversation.
 *      Without the retry, the heavy bearer's refusal is logged there as "channel search failed;
 *      suggesting nothing (fail closed)" with this channel's ARN, and this fails. The same log groups are
 *      first required to show the suggestion firing in the window, so an unread or renamed log group
 *      cannot satisfy the absence.
 *
 * WHAT IS NOT ASSERTED, AND WHY. The scope itself never leaves the router - it is passed into the data
 * plane and used inside a pgvector WHERE clause - so no deployed read returns it, and a
 * related-conversation REDIRECT (the one outcome that shows the set) depends on the summary updater
 * having embedded an earlier shared conversation, which no test can make deterministic. And a scope
 * spanning more than one 50-item page would need over fifty conversations shared by both users; the
 * pagination loop is covered by the unit test, not here.
 *
 * Gated by DRIFT_SCOPE_E2E=1 (validate.mjs --only=drift-scope). Needs Aurora mode with
 * `-c enableLiveDrift=true`, two distinct premium test users, and one of them over the
 * `SearchChannels` membership limit - a long-lived test account usually is; a fresh deployment is not,
 * and the test skips saying so.
 */
import { test, expect } from './helpers/fixtures';
import { getTestCredentials, hasTestCredentials, type TestUser } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { openGroupConversation, closeGroup, type GroupConversation } from './helpers/group-conversation';
import { assistantArnIn, messageRowsVisibleTo } from './helpers/third-party-view';
import { personArnOf } from './helpers/person';
import { sendTargetedAs } from './helpers/turn-state-record';
import { INSTANCE, STACK_PREFIX } from './helpers/stack-prefix';
import { awsv } from './helpers/aws';

guardConsoleErrors();

const RUN = process.env.DRIFT_SCOPE_E2E === '1';

// The explicit-routing fast path fires on the first message with no summary (see drift-detection.spec.ts).
const DRIFT_TRIGGER = "let's start a new conversation about quarterly revenue forecasting";
// Stable substring of SUGGESTION_CONFIRM_TEMPLATE (analytics-aurora/drift-detection.ts).
const SUGGESTION_MARKER = 'start a separate conversation for this';
const LIMIT_REFUSAL = /exceeds channel membership limit/i;

/** The error text of a failed CLI call, stderr included. */
function failureText(err: unknown): string {
  const e = err as { message?: string; stderr?: Buffer | string };
  return `${e?.message || ''}\n${e?.stderr ? String(e.stderr) : ''}`;
}

/**
 * Every channel `bearer` finds with a MEMBERS filter of `values`, paginated to the end - the exact
 * question `resolveScopedChannelArns` asks. Throws what the service said on refusal.
 */
function searchMembers(bearer: string, values: string[]): string[] {
  const arns: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const r = awsv(['chime-sdk-messaging', 'search-channels', '--chime-bearer', bearer,
      '--fields', JSON.stringify([{ Key: 'MEMBERS', Values: values, Operator: 'INCLUDES' }]),
      '--max-results', '50', ...(token ? ['--next-token', token] : [])]);
    arns.push(...((r?.Channels ?? []) as any[]).map((c) => String(c?.ChannelArn || '')).filter(Boolean));
    token = r?.NextToken;
    if (!token) break;
  }
  return arns;
}

/** True when this user's own search is refused for the membership limit; false when it is answered. */
function overSearchLimit(userArn: string): boolean {
  try {
    awsv(['chime-sdk-messaging', 'search-channels', '--chime-bearer', userArn,
      '--fields', JSON.stringify([{ Key: 'MEMBERS', Values: [userArn], Operator: 'INCLUDES' }]),
      '--max-results', '1']);
    return false;
  } catch (err) {
    const text = failureText(err);
    if (LIMIT_REFUSAL.test(text)) return true;
    throw new Error(`search as ${userArn} failed for a reason other than the membership limit: ${text.slice(0, 400)}`);
  }
}

/** Router log groups (the Lex handler for every classification), the family `backend-errors.ts` watches. */
function routerLogGroups(): string[] {
  const groups: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const r = awsv(['logs', 'describe-log-groups', '--log-group-name-prefix', `/aws/lambda/${STACK_PREFIX}`,
      ...(token ? ['--next-token', token] : [])]);
    groups.push(...((r?.logGroups ?? []) as any[]).map((g) => String(g?.logGroupName || '')));
    token = r?.nextToken;
    if (!token) break;
  }
  return groups.filter((g) => g.includes('AgentHandler'));
}

function logLines(groups: string[], since: number, pattern: string): string[] {
  const out: string[] = [];
  for (const group of groups) {
    try {
      const r = awsv(['logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(since),
        '--filter-pattern', pattern, '--query', 'events[].message']);
      out.push(...((r ?? []) as unknown[]).map((l) => String(l)));
    } catch { /* a group deleted mid-run contributes nothing; the positive control below still has to pass */ }
  }
  return out;
}

test.describe.serial('drift scoping with a member over the search membership limit', () => {
  guardBackendErrors('drift-scope-heavy-member');
  test.skip(!RUN, 'set DRIFT_SCOPE_E2E=1 (runs via validate.mjs --only=drift-scope)');

  let group: GroupConversation | null = null;
  test.afterAll(async () => { await closeGroup(group); });

  test('the scope is resolved by retrying as a lighter member, not abandoned at the heavy one', async ({ page }) => {
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.setTimeout(420_000);

    const creds = await getTestCredentials();
    const candidates: TestUser[] = [creds.premiumUser, creds.secondPremiumUser]
      .filter((u): u is TestUser => !!u?.password);
    test.skip(
      candidates.length < 2 || candidates[0].email === candidates[1].email,
      'needs two DISTINCT premium test users (premiumUser and secondPremiumUser)',
    );

    const adminArn = String(awsv(['ssm', 'get-parameter', '--name', `/${INSTANCE}/app-instance-admin-arn`])?.Parameter?.Value || '');
    expect(adminArn, 'the app-instance-admin ARN resolves, which is where the instance ARN comes from').toContain('/user/');
    const instanceArn = adminArn.split('/user/')[0];
    const people = await Promise.all(candidates.map(async (user) => {
      const arn = await personArnOf(user);
      expect(arn.startsWith(`${instanceArn}/user/`), `${user.email} must be an AppInstanceUser of this instance`).toBe(true);
      return { user, arn, heavy: overSearchLimit(arn) };
    }));
    console.log(`\n--- search limit: ${people.map((p) => `${p.user.email}=${p.heavy ? 'OVER' : 'under'}`).join(', ')}`);
    const heavy = people.find((p) => p.heavy);
    const light = people.find((p) => !p.heavy);
    test.skip(!heavy, 'no premium test user is over the SearchChannels membership limit, so the retry cannot be exercised');
    test.skip(!light, 'both premium test users are over the limit; the retry has no member to go to and fails closed by design');

    // The heavy user CREATES the conversation: the creator's membership is written first.
    group = await openGroupConversation({
      page,
      creator: heavy!.user,
      others: [light!.user],
      title: `Drift scope ${Date.now()}`,
      classification: 'Premium',
    });
    expect(group, 'the two-person conversation could not be assembled').toBeTruthy();
    const { channelArn } = group!;
    const botArn = assistantArnIn(channelArn, heavy!.arn);
    expect(botArn, 'the conversation has no assistant member to address').toBeTruthy();

    // ── PRECONDITION: the heavy user is the bearer tried FIRST ──────────────────────────────────
    // Listed as the assistant, which is the bearer the router lists with.
    const listed = ((awsv(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn,
      '--chime-bearer', botArn, '--max-results', '50'])?.ChannelMemberships ?? []) as any[])
      .map((m) => String(m?.Member?.Arn || ''))
      .filter((a) => a.includes('/user/'));
    console.log(`--- humans, in the order the router reads them: ${listed.join(', ')}`);
    expect([...listed].sort(), 'the conversation holds exactly the two people').toEqual([heavy!.arn, light!.arn].sort());
    test.skip(
      listed[0] !== heavy!.arn,
      'the light member is listed first, so the router would never try the heavy bearer and the retry is not exercised',
    );

    // ── PRECONDITION: the retry has an answer to find ────────────────────────────────────────────
    const scope = searchMembers(light!.arn, [heavy!.arn, light!.arn, botArn]);
    console.log(`--- the scope, searched as the light member: ${scope.length} conversation(s)`);
    expect(scope, 'searched as the light member, the router\'s own filter does not return this conversation').toContain(channelArn);

    // ── THE TURN ─────────────────────────────────────────────────────────────────────────────────
    const since = Date.now() - 5_000;
    sendTargetedAs(channelArn, heavy!.arn, botArn, DRIFT_TRIGGER);

    let fired = false;
    for (let i = 0; i < 30 && !fired; i += 1) {
      fired = messageRowsVisibleTo(channelArn, heavy!.arn)
        .some((m) => m.senderArn.includes('/bot/') && new Date(m.createdAt).getTime() >= since
          && m.content.toLowerCase().includes(SUGGESTION_MARKER));
      if (!fired) await page.waitForTimeout(3_000);
    }
    expect(
      fired,
      'PRECONDITION: the drift suggestion did not fire, so the scope was never resolved for this conversation '
        + 'and the log assertion below would be testing nothing. Is live drift enabled on this deployment?',
    ).toBe(true);

    // ── THE ASSERTION ────────────────────────────────────────────────────────────────────────────
    const groups = routerLogGroups();
    expect(groups.length, 'no router (AgentHandler) log group was found').toBeGreaterThan(0);
    let firedLines: string[] = [];
    for (let i = 0; i < 12 && !firedLines.length; i += 1) {
      firedLines = logLines(groups, since, '"suggestion fired"');
      if (!firedLines.length) await page.waitForTimeout(5_000);
    }
    expect(
      firedLines.length,
      'the router log groups read here show no drift suggestion in the window, although one was delivered: '
        + 'these are not the groups the turn logged to, so an absence in them proves nothing',
    ).toBeGreaterThan(0);

    const channelId = channelArn.split('/').pop()!;
    const scopeFailures = logLines(groups, since, '"scoped-channels"').filter((l) => l.includes(channelId));
    console.log(`--- [scoped-channels] lines for this conversation: ${scopeFailures.length}`);
    expect(
      scopeFailures.map((l) => l.slice(0, 400)),
      'the router gave up on this conversation\'s scope. With a heavy member listed first, the search refuses '
        + 'that bearer, and the scope must be re-asked as the next member - failing closed here switches drift '
        + 'suggestions off for every conversation a heavy user is first in',
    ).toEqual([]);
  });
});
