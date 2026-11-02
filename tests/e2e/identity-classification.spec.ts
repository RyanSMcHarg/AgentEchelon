/**
 * THE CORE DESIGN, CHECKED AGAINST THE DEPLOYMENT: every classification-bearing principal carries its
 * classification as an immutable tag.
 *
 * The platform's premise is that access is an IAM decision keyed on an immutable `classification`
 * tag, and that people, assistants and conversations are all ARN'd principals judged the same way.
 * CONVERSATIONS were tagged from the first commit. IDENTITIES never were: `CreateAppInstanceBot` and
 * every `CreateAppInstanceUser` call site passed `Name` and no `Tags` from 2025-12-26, and no commit
 * in 503 added one. The gap survived nine months, repeated testing and repeated doc review.
 *
 * ── WHY THIS TEST EXISTS AND WHY IT IS AN E2E ───────────────────────────────────────────────────
 *
 * Nothing could catch it. Every unit test passed, correctly - enforcement works through the vended
 * per-classification role, so the missing tag had no behavioural consequence until analytics needed
 * the fact and guessed instead. And review is drawn to what EXISTS: reading `create-bot.ts` shows a
 * correct provisioner, because you cannot review a parameter that was never written.
 *
 * The source guards in `backend/test/lib/an-assistant-is-assigned-one-classification.test.ts` pin the
 * call sites. They cannot tell you the tag reached AWS. This does: it asks the deployment what tags
 * the live principals actually carry. A tag is either on the resource or it is not - an observation,
 * not an assertion about code.
 *
 * ── WHAT A FAILURE HERE MEANS ───────────────────────────────────────────────────────────────────
 *
 * NOT that the boundary is open. Classification enforcement is layered: the credential exchange vends
 * a classification-bound, bearer-pinned role and the channel tag gates every channel action. A
 * failure here means the platform's stated mechanism is not present on the principals - the thing
 * that was true for nine months - so every reader is back to deriving it three different ways.
 *
 * Gated by IDENTITY_CLASSIFICATION_E2E=1 because it reads AWS directly and needs credentials.
 */
import { test, expect } from './helpers/fixtures';
import { getTestCredentials, type TestUser } from './helpers/test-credentials';
import { personArnOf } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
// The registry is the ONE place that maps a group to a clearance. Imported rather than restated so
// the expected value in this test and the value the exchange writes come from the same function -
// a second copy here would pass while disagreeing with what the platform actually does.
import { defaultProfileRegistry as profiles } from '../../backend/lib/profile-registry';
import { SSM_ROOT } from './helpers/stack-prefix';
import { aws } from './helpers/aws';

// THE BACKEND GUARD, even though this spec drives no browser. It reads CloudWatch, so it applies to
// a spec that talks to AWS directly exactly as it does to one that clicks: the failure it exists to
// catch is a handler logging AccessDenied on every request while the assertions stay green.
guardBackendErrors('identity-classification');

const RUN = process.env.IDENTITY_CLASSIFICATION_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;

/** Any published assistant ARN, used only to derive the app-instance ARN it is prefixed with. */
function anyBotArn(): string | null {
  for (const classification of (process.env.E2E_CLASSIFICATIONS || 'basic,standard,premium').split(',')) {
    try {
      const v = aws<{ Parameter?: { Value?: string } }>(
        `ssm get-parameter --name "${SSM_ROOT}/assistant/${classification}/bot-arn"`,
      ).Parameter?.Value;
      if (v) return v;
    } catch { /* this deployment does not run that classification */ }
  }
  return null;
}

/** The `classification` tag on a Chime resource, or null. */
function classificationTagOf(arn: string): string | null {
  const resp = aws<{ Tags?: Array<{ Key: string; Value: string }> }>(
    `chime-sdk-identity list-tags-for-resource --resource-arn "${arn}"`,
  );
  return (resp.Tags || []).find((t) => t.Key === 'classification')?.Value ?? null;
}

suite('every classification-bearing principal carries its classification', () => {
  test('each assistant identity is tagged with the classification it is assigned', () => {
    // The published bot ARN per classification is the deployment's own record of which assistant
    // serves which classification. The TAG must agree with the path it was published under - if they
    // disagree, one of the two is lying about the assistant and the auditor keys on the tag.
    const classifications = (process.env.E2E_CLASSIFICATIONS || 'basic,standard,premium').split(',');
    const checked: string[] = [];

    for (const classification of classifications) {
      let botArn: string;
      try {
        const p = aws<{ Parameter?: { Value?: string } }>(
          `ssm get-parameter --name "${SSM_ROOT}/assistant/${classification}/bot-arn"`,
        );
        botArn = p.Parameter?.Value || '';
      } catch {
        // A classification this deployment does not run is not a failure.
        continue;
      }
      if (!botArn) continue;

      const tag = classificationTagOf(botArn);
      expect(
        tag,
        `the ${classification} assistant (${botArn}) carries no classification tag. `
        + 'The platform keys access on an immutable classification tag and states that assistants are '
        + 'governed by it; without the tag every reader derives it instead - which is how an ARN '
        + 'substring guess ended up in the analytics pipeline. Redeploy: the bot provisioner tags on '
        + 'create AND re-tags an existing bot on update.',
      ).not.toBeNull();
      expect(tag, `the ${classification} assistant is tagged '${tag}'`).toBe(classification);
      checked.push(classification);
    }

    // A pass that checked nothing is not a pass. If no classification published a bot ARN, the test
    // proved only that the lookup failed.
    expect(checked.length, 'no assistant ARNs resolved, so nothing was actually checked').toBeGreaterThan(0);
  });

  test('a person\'s identity is tagged with their clearance', async () => {
    // The seeded test users have known clearances, so the tag is checkable against an expected value
    // rather than merely being present.
    const creds = await getTestCredentials();
    // DERIVED FROM A BOT ARN rather than looked up. An AppInstanceBot ARN is
    // `<app-instance-arn>/bot/<uuid>`, so the prefix IS the app instance - no parameter to guess the
    // name of, and nothing that can drift away from the resources being checked.
    const appInstanceArn =
      process.env.APP_INSTANCE_ARN
      || process.env.VITE_APP_INSTANCE_ARN
      || (anyBotArn() || '').split('/bot/')[0]
      || '';
    expect(appInstanceArn, 'could not resolve the app instance ARN').not.toBe('');

    // The AppInstanceUser id is the one the credential exchange minted for the person, not a claim of
    // their sign-in, so it is read from provisioning's record or the exchange's answer (`personArnOf`).
    /** A user's Cognito groups, by sign-in name. Empty when the record cannot be read. */
    const groupsOf = (email: string): string[] => {
      try {
        const g = aws<{ Groups?: Array<{ GroupName?: string }> }>(
          `cognito-idp admin-list-groups-for-user --user-pool-id "${creds.cognitoUserPoolId}" --username "${email}"`,
        );
        return (g.Groups || []).map((x) => x.GroupName).filter((n): n is string => !!n);
      } catch {
        return [];
      }
    };

    const people: Array<{ who: string; user?: TestUser }> = [
      { who: 'basicUser', user: creds.basicUser },
      { who: 'standardUser', user: creds.standardUser },
      { who: 'premiumUser', user: creds.premiumUser },
    ];

    const checked: string[] = [];
    for (const person of people) {
      if (!person.user?.email) continue;
      const arn = await personArnOf(person.user).catch(() => '');
      if (!arn.startsWith(`${appInstanceArn}/user/`)) continue;
      let tag: string | null;
      try {
        tag = classificationTagOf(arn);
      } catch {
        // The identity is created lazily on first exchange; a user who has never signed in has no
        // AppInstanceUser to tag, which is not this test's finding.
        continue;
      }
      expect(
        tag,
        `${person.who} (${arn}) carries no classification tag. The exchange stamps the clearance `
        + 'on every vend, including the conflict branch that backfills existing identities, '
        + 'so an untagged identity means that path did not run, lacks chime:TagResource, or the '
        + 'person has not signed in since identity tagging shipped (backfill-identity-classifications.mjs).',
      ).not.toBeNull();

      // ── THE EXPECTED VALUE IS RESOLVED, NOT ASSUMED ────────────────────────────────────────────
      //
      // This named a clearance per user ('premiumUser' -> 'premium'), which is only right when that
      // user holds exactly that one classification group. The seeded premium user on this deployment
      // is ALSO in `admins`, so their true clearance is `admin` - and the test failed reporting a
      // correct tag as wrong.
      //
      // The invariant worth pinning is not "this person is premium". It is that the tag equals the
      // clearance their REAL groups resolve to, through the SAME function the exchange chooses the
      // vended role with - so a tag and the role it was handed cannot disagree. That holds however
      // many groups somebody accumulates, which is the whole point of one resolver.
      const groups = groupsOf(person.user.email);
      expect(groups.length, `${person.who} is in no Cognito group at all`).toBeGreaterThan(0);
      const expected = profiles.clearanceForGroups(groups);
      expect(
        tag,
        `${person.who} is tagged '${tag}' but their groups [${groups.join(', ')}] clear them for '${expected}'`,
      ).toBe(expected);
      checked.push(`${person.who}=${tag}`);
    }

    expect(checked.length, 'no seeded identities resolved, so nothing was actually checked').toBeGreaterThan(0);
  });

  test('an assistant and the conversation it serves agree, so the tag means one thing', () => {
    // The point of tagging BOTH sides is that `aws:ResourceTag/classification` compares like with
    // like. This asserts the two vocabularies are the same one: whatever value a bot carries is a
    // classification this deployment declares, so a channel tagged with it and a bot tagged with it
    // are comparable rather than coincidentally similar strings.
    const classifications = (process.env.E2E_CLASSIFICATIONS || 'basic,standard,premium').split(',');
    for (const classification of classifications) {
      let botArn = '';
      try {
        botArn = aws<{ Parameter?: { Value?: string } }>(
          `ssm get-parameter --name "${SSM_ROOT}/assistant/${classification}/bot-arn"`,
        ).Parameter?.Value || '';
      } catch { continue; }
      if (!botArn) continue;
      const tag = classificationTagOf(botArn);
      if (tag === null) continue; // already reported by the first test; do not double-fail
      expect(
        classifications,
        `the ${classification} assistant is tagged '${tag}', which is not a classification this `
        + 'deployment declares - the identity and channel tags would then be different vocabularies',
      ).toContain(tag);
    }
  });
});
