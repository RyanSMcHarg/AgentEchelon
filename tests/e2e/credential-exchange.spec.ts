/**
 * E2E — Credential Exchange API contract (docs/SPEC-CREDENTIAL-EXCHANGE.md).
 *
 * Exercises the deployed exchange end-to-end (real API Gateway Cognito authorizer →
 * real Lambda → real STS): unauthenticated requests are rejected, and an authenticated
 * request returns scoped creds + the caller's OWN userArn at their authoritative tier.
 *
 * Requires: the exchange DEPLOYED + tier test users (`npm run provision-test-users`) +
 * the endpoint URL in env. Skips cleanly otherwise (so the suite is green pre-deploy).
 *   VITE_PERSON_API_URL =
 *     CDK output AgentEchelonPersonApi.PersonApiUrl
 *
 * The BEARER-PIN enforcement (impersonation → AccessDenied) is an IAM property proven
 * by `backend/scripts/deny-test-credential-exchange.mjs`, not a UI/HTTP flow.
 */
import { test, expect } from './helpers/fixtures';
import { getTestCredentials, hasTestCredentials } from './helpers/test-credentials';
import { idTokenFor } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { PERSON_API_URL, personUrl } from './helpers/api-urls';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardBackendErrors('credential-exchange');
guardConsoleErrors();



const subOf = (idToken: string): string =>
  JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')).sub;

/** The person id the exchange mints is a UUID v7; a Cognito sub is a v4. */
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idOf = (userArn: string): string => userArn.split('/').pop() || '';

const runnable = !!PERSON_API_URL && hasTestCredentials();

test.describe('Credential Exchange API', () => {
  test.skip(!runnable, 'Set VITE_PERSON_API_URL + provision test users (needs a deploy).');

  test('rejects an unauthenticated request (Cognito authorizer)', async ({ request }) => {
    const resp = await request.post(personUrl('/exchange-credentials'), {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(401);
  });

  test('vends scoped creds for the caller\'s own AppInstanceUser at their tier', async ({ request }) => {
    const creds = await getTestCredentials();
    const idToken = idTokenFor(creds.basicUser.email, creds.basicUser.password, creds.cognitoClientId);
    const sub = subOf(idToken);

    const resp = await request.post(personUrl('/exchange-credentials'), {
      data: {},
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    expect(body.credentials?.AccessKeyId).toBeTruthy();
    expect(body.credentials?.SessionToken).toBeTruthy();
    // The userArn is the caller's OWN AppInstanceUser: the person the exchange minted for their
    // (issuer, sub), a UUID v7 and never the sub itself, and the same one provisioning recorded.
    expect(idOf(body.userArn)).toMatch(V7);
    expect(idOf(body.userArn)).not.toBe(sub);
    expect(creds.basicUser.userArn, 'provisioning recorded no userArn for basicUser (run provision-test-users)').toBeTruthy();
    expect(body.userArn).toBe(creds.basicUser.userArn);
    expect(body.tier).toBe('basic');
  });

  test('IDOR: a body-supplied sub/tier is ignored (identity from the validated token)', async ({ request }) => {
    const creds = await getTestCredentials();
    const idToken = idTokenFor(creds.basicUser.email, creds.basicUser.password, creds.cognitoClientId);
    const own = await request.post(personUrl('/exchange-credentials'), {
      data: {},
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    });
    const ownArn = (await own.json()).userArn;

    const resp = await request.post(personUrl('/exchange-credentials'), {
      data: { sub: 'attacker-sub', tier: 'premium' },
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.userArn).toBe(ownArn); // the token's person, not 'attacker-sub'
    expect(body.userArn).not.toContain('attacker-sub');
    expect(body.tier).toBe('basic');                // not 'premium'
  });
});
