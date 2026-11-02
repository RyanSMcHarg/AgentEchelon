/**
 * SPEC-COST-SLEEP-MODE - a FAILED manual sleep or wake publishes to the sleep topic.
 *
 * THE DEFECT. The admin POST path (`/deployment/sleep`, `/deployment/wake`) had no alert on failure,
 * while the auto-idle path did. A manual transition that failed threw a 500 into one operator's HTTP
 * response and told nobody else - during a cost incident, which is exactly when someone drives sleep and
 * wake by hand. `deployment-sleep.ts` now publishes a FAILED notice on the same topic before answering
 * 500. `cost-sleep-mode.spec.ts` covers the configuration and the happy path; nothing covered this.
 *
 * WHY THIS IS NOT PART OF ANY RUN, AND ONLY RUNS WITH SLEEP_FAILURE_E2E=1.
 *
 * The failure path is reached only when `transition` throws, and on a real deployment the one thing in
 * it that can be made to throw from outside is `rds:ModifyDBCluster`. There is no safe lever for that:
 * nothing in the API takes a fault flag (and adding one would be a test seam in production code), and
 * changing the function's configuration or role to force a throw is a deploy-shaped mutation of a shared
 * environment. What remains is a REAL refusal: ask for a wake while the cluster is still applying the
 * sleep just requested, which Aurora can refuse because a modification is in progress. That pauses
 * Aurora (0 ACU) on the deployment for as long as it takes, and whether Aurora refuses is not something
 * this test controls. So it is run deliberately, by name (`validate.mjs --only=sleep-failure`), on a
 * deployment where pausing the data plane for a few minutes is acceptable - never by an unattended sweep.
 *
 * IT DOES NOT FAKE A FAILURE. If no transition fails in the attempts it makes, the test SKIPS saying so:
 * the alert path was not reached, so nothing about it is proven, and a green would be a lie.
 *
 * HOW THE PUBLISH IS OBSERVED. The topic is SNS, and there is no mailbox. `AWS/SNS
 * NumberOfMessagesPublished` for the topic is the deployed topic's own count. Every transition this test
 * causes publishes exactly one message - a successful one "Deployment asleep/awake", a failed one the
 * FAILED notice - so the count over the window must reach (successes + failures). With the failure
 * alert removed it reaches only the successes, and this fails.
 *
 * AND THE TOPIC HAS A SUBSCRIBER. An unsubscribed topic accepts a publish and delivers it to nobody,
 * which looks identical to success in every log; that is the live check this spec also owes.
 *
 * It always ends by waking the deployment, retrying until the API reports `awake`, and fails loudly if it
 * cannot. Needs Aurora mode with `-c sleepMode=true` and the `admin` capability: the public state probe is
 * the archive's, and the manual sleep and wake are admin routes on the AdminServices analytics API, signed
 * with a console session.
 *
 *   AWS_PROFILE=<p> SLEEP_FAILURE_E2E=1 npx playwright test e2e/cost-sleep-failure-alert.spec.ts
 */
import { test, expect } from './helpers/fixtures';
import { idTokenFor } from './helpers/person';
import { getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors } from './helpers/turn-guards';
import { sumMetric } from './helpers/cw-metrics';
import { stackName } from './helpers/stack-prefix';
import { aws } from './helpers/aws';
import { signedAdminContext } from './helpers/signed-analytics';
import { PERSON_API_URL, ADMIN_API_URL, personUrl, adminUrl } from './helpers/api-urls';

const RUN = process.env.SLEEP_FAILURE_E2E === '1';
const AWS_PROFILE = process.env.AWS_PROFILE || '';
const AURORA_STACK = process.env.E2E_AURORA_STACK || stackName('Archive');
const haveCreds = () => Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('A failed manual sleep/wake is announced on the sleep topic (SPEC-COST-SLEEP-MODE)', () => {
  test.skip(!RUN, 'set SLEEP_FAILURE_E2E=1 (validate.mjs --only=sleep-failure) - it pauses Aurora on the deployment; see the header');
  guardBackendErrors('cost-sleep-failure-alert');

  test('a manual transition Aurora refuses answers 500 AND publishes its FAILED notice to a subscribed topic', async () => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'needs the provisioned test users');
    test.setTimeout(1_200_000);

    const outputs: Array<{ OutputKey: string; OutputValue: string }> =
      aws(`cloudformation describe-stacks --stack-name ${AURORA_STACK}`)?.Stacks?.[0]?.Outputs ?? [];
    const enabled = outputs.find((o) => o.OutputKey === 'SleepModeEnabled')?.OutputValue === 'true';
    test.skip(!enabled, `${AURORA_STACK} reports SleepModeEnabled != true: there is no manual sleep/wake path to fail`);
    // The state probe is on the person API; the manual sleep and wake are admin routes on the analytics surface.
    expect(PERSON_API_URL, 'VITE_PERSON_API_URL must be set').toBeTruthy();
    expect(ADMIN_API_URL, 'VITE_ADMIN_API_URL must be set').toBeTruthy();

    // THE TOPIC, read off the function that publishes to it rather than guessed from a name.
    const fns: Array<{ n: string; t?: string }> =
      aws('lambda list-functions --query Functions[].{n:FunctionName,t:Environment.Variables.SLEEP_TOPIC_ARN}') ?? [];
    const sleepFn = fns.find((f) => f.t && f.n.startsWith(AURORA_STACK.slice(0, 20)) && f.n.includes('DeploymentSleep'));
    expect(sleepFn?.t, 'the deployment-sleep function carries no SLEEP_TOPIC_ARN, so notify() publishes nothing').toBeTruthy();
    const topicArn = sleepFn!.t!;
    const topicName = topicArn.split(':').pop()!;

    const subs: Array<{ SubscriptionArn: string; Protocol: string }> =
      aws(`sns list-subscriptions-by-topic --topic-arn ${topicArn}`)?.Subscriptions ?? [];
    console.log(`\n--- sleep topic ${topicName}: ${subs.map((s) => `${s.Protocol}:${s.SubscriptionArn.slice(-12)}`).join(', ') || 'no subscriptions'}`);
    expect(
      subs.filter((s) => s.SubscriptionArn.startsWith('arn:')),
      'the sleep topic has no CONFIRMED subscriber (none, or only PendingConfirmation). A publish to it is '
        + 'accepted and delivered to nobody - set sleepRecipients and confirm the subscription',
    ).not.toEqual([]);

    const creds = await getTestCredentials();
    test.skip(!creds.testAdmin.password, missingUserReason('testAdmin'));
    const idToken = idTokenFor(creds.testAdmin.email, creds.testAdmin.password, creds.cognitoClientId);
    expect(idToken && idToken !== 'None', 'an admin id token').toBeTruthy();

    const state = async (): Promise<string> => {
      const r = await fetch(personUrl('/deployment/state'));
      return String((await r.json())?.state);
    };
    const admin = signedAdminContext(idToken);
    const post = async (action: 'sleep' | 'wake'): Promise<{ status: number; body: any }> => {
      const r = await admin.post(
        action === 'sleep' ? adminUrl('analytics', '/deployment/sleep') : adminUrl('analytics', '/deployment/wake'),
        { data: {} },
      );
      const text = await r.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
      return { status: r.status(), body };
    };

    test.skip((await state()) !== 'awake', 'the deployment is not awake; this test does not start from, or leave, a paused deployment it did not pause');

    // Round down to the minute, as `sumMetric` does, so our first publish cannot fall before the window.
    const since = Date.now() - 60_000;
    let successes = 0;
    let failures = 0;
    const record = (label: string, r: { status: number; body: any }) => {
      console.log(`  POST ${label} -> ${r.status} ${JSON.stringify(r.body)}`);
      if (r.status === 200 && r.body?.changed === true) successes += 1;
      if (r.status === 500) failures += 1;
    };

    try {
      // ── INDUCE: a wake requested while the sleep just requested is still being applied ────────
      for (let attempt = 0; attempt < 2 && failures === 0; attempt += 1) {
        const slept = await post('sleep');
        record('sleep', slept);
        expect(
          [200, 500],
          `the admin sleep route answered ${slept.status}; the test cannot reach the transition at all`,
        ).toContain(slept.status);
        if (slept.status === 500) break; // the sleep itself was refused: that IS the failure path
        record('wake', await post('wake'));
      }
    } finally {
      // ── RESTORE: awake, however long Aurora takes to accept it ──────────────────────────────────
      for (let i = 0; i < 30 && (await state()) !== 'awake'; i += 1) {
        await sleep(20_000);
        record('wake (restore)', await post('wake'));
      }
    }
    const finalState = await state();
    expect(finalState, 'THE DEPLOYMENT WAS LEFT ASLEEP. Wake it by hand: POST /deployment/wake as an admin').toBe('awake');

    test.skip(
      failures === 0,
      `no manual transition failed (${successes} succeeded), so the failure alert was never reached and nothing about it is proven`,
    );

    // ── THE ASSERTION: every transition published, the failed ones included ─────────────────────
    const expected = successes + failures;
    let published = 0;
    for (let i = 0; i < 20 && published < expected; i += 1) {
      published = await sumMetric({
        namespace: 'AWS/SNS',
        metricName: 'NumberOfMessagesPublished',
        dimensions: { TopicName: topicName },
        sinceEpochMs: since,
      });
      if (published < expected) await sleep(30_000);
    }
    console.log(`--- ${topicName}: published ${published}, expected at least ${expected} (${successes} succeeded + ${failures} failed)`);
    expect(
      published,
      `${failures} manual transition(s) failed and answered 500, but the sleep topic recorded only ${published} `
        + `publish(es) against ${successes} successful transition(s). A failed manual sleep/wake is not being announced: `
        + 'the operator who hit the 500 is the only one who knows the deployment may be at the wrong capacity',
    ).toBeGreaterThanOrEqual(expected);
  });
});
