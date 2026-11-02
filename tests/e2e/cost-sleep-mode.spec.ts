/**
 * SPEC-COST-SLEEP-MODE — the opt-in surface matches what is actually deployed.
 *
 * Sleep mode is opt-in (`-c sleepMode=true`, Aurora mode only), and the spec's coverage was recorded
 * as blocked on that: driving sleep/wake would mean deploying with the flag on and waiting out an
 * idle window. True — but it left the configuration that ACTUALLY ships, the off one, unchecked, and
 * the off configuration has a documented foot-gun of its own. From the stack:
 *
 *   "When sleep mode is off the GET /deployment/state route is never created, so the frontend must
 *    not poll it (else every poll gets API Gateway's 403 for good)."
 *
 * Three things therefore have to agree, and a deployment where they disagree is broken in a way
 * nothing else would catch:
 *
 *   1. the `SleepModeEnabled` stack output — the authoritative statement of intent,
 *   2. whether `/deployment/state` exists on the analytics API,
 *   3. whether the DEPLOYED chat SPA actually probes that route.
 *
 * This asserts all three against each other, so it is meaningful in EITHER configuration rather than
 * skipping when the feature is off. With sleep mode on it additionally drives the live state
 * endpoint; with it off it proves the surface is absent and the SPA leaves it alone.
 *
 *   AWS_PROFILE=<p> E2E_BASE_URL=<cf> npx playwright test e2e/cost-sleep-mode.spec.ts
 */
import { test, expect } from './helpers/fixtures';
import { signIn } from './helpers/agent-helpers';
import { getStandardUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { stackName } from './helpers/stack-prefix';
import { aws } from './helpers/aws';
import { PERSON_API_URL, personUrl } from './helpers/api-urls';

guardConsoleErrors();

const AWS_PROFILE = process.env.AWS_PROFILE || '';
const AURORA_STACK = process.env.E2E_AURORA_STACK || stackName('Archive');
const haveCreds = () => Boolean(AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);

const STATE_PATH = '/deployment/state';

test.describe('Cost sleep mode is deployed exactly as far as its flag says (SPEC-COST-SLEEP-MODE)', () => {
  guardBackendErrors('cost-sleep-mode');

  test('the flag, the API route and the SPA probe all agree', async ({ page }) => {
    test.skip(!haveCreds(), 'needs AWS credentials — set AWS_PROFILE');
    test.setTimeout(180_000);

    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));

    // 1) INTENT — the authoritative flag. Emitted unconditionally precisely so consumers can gate on
    //    it, so its absence is itself a failure rather than something to skip over.
    const outputs: Array<{ OutputKey: string; OutputValue: string }> =
      aws(`cloudformation describe-stacks --stack-name ${AURORA_STACK}`)?.Stacks?.[0]?.Outputs ?? [];
    const flag = outputs.find((o) => o.OutputKey === 'SleepModeEnabled')?.OutputValue;
    expect(
      flag,
      `${AURORA_STACK} must emit SleepModeEnabled — the frontend gates its probe on it`,
    ).toBeDefined();
    const enabled = flag === 'true';

    // The person API, which serves the state probe when sleep mode is deployed. This check needs the API
    // either way, so it is the API's own URL rather than the probe's.
    expect(PERSON_API_URL, 'VITE_PERSON_API_URL must be set').toBeTruthy();
    const apiId = new URL(PERSON_API_URL).hostname.split('.')[0];

    console.log(`\n--- sleep mode: ${enabled ? 'ENABLED' : 'disabled'} (api ${apiId}) ---`);

    // 2) BACKEND — the route exists if and only if the flag says so. Read from API Gateway rather
    //    than by probing over HTTP: a 403 from a missing route and a 403 from an authorizer are
    //    indistinguishable to a client, which is exactly how this drifts unnoticed.
    // An HTTP API names a route by its key, `GET /deployment/state`.
    const routeKeys: string[] = (aws(`apigatewayv2 get-routes --api-id ${apiId}`)?.Items ?? []).map(
      (i: any) => i.RouteKey,
    );
    const routeExists = routeKeys.includes(`GET ${STATE_PATH}`);
    console.log(`  ${STATE_PATH} present on the API: ${routeExists}`);

    expect(
      routeExists,
      enabled
        ? `sleep mode is ENABLED but ${STATE_PATH} is not on the API — the paused banner can never resolve`
        : `sleep mode is DISABLED but ${STATE_PATH} exists on the API — the surface outlived its flag`,
    ).toBe(enabled);

    // 3) FRONTEND — what the DEPLOYED bundle actually does. The local .env is not evidence: it is a
    //    build input that may be newer than the bundle CloudFront is serving.
    const probes: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(STATE_PATH)) probes.push(`${r.method()} ${r.url()}`);
    });

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    // The banner probes on mount and then on an interval; give the mounted app room to do it.
    await page.waitForTimeout(8000);

    console.log(`  SPA probes of ${STATE_PATH}: ${probes.length}${probes.length ? ` (${probes[0]})` : ''}`);

    if (enabled) {
      expect(
        probes.length,
        `sleep mode is ENABLED but the SPA never probed ${STATE_PATH} — the paused banner is dead code`,
      ).toBeGreaterThan(0);

      // With the feature on, the endpoint must also answer with a state the banner understands.
      const res = await page.request.get(personUrl('/deployment/state'));
      expect(res.status(), `${STATE_PATH} should answer (it is public by design)`).toBe(200);
      const body = await res.json();
      expect(
        ['awake', 'asleep'],
        `${STATE_PATH} returned an unusable state: ${JSON.stringify(body)}`,
      ).toContain(String(body?.state));
    } else {
      // The documented foot-gun: a frontend built with the flag ON against a backend with it OFF
      // polls a route that does not exist and takes API Gateway's 403 forever.
      expect(
        probes,
        `sleep mode is DISABLED but the deployed SPA still polls ${STATE_PATH}; every poll gets a 403`,
      ).toEqual([]);
    }
  });
});
