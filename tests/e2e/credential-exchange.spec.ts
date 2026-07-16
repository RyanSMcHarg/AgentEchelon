/**
 * E2E — Credential Exchange API contract (docs/SPEC-CREDENTIAL-EXCHANGE.md).
 *
 * Exercises the deployed exchange end-to-end (real API Gateway Cognito authorizer →
 * real Lambda → real STS): unauthenticated requests are rejected, and an authenticated
 * request returns scoped creds + the caller's OWN userArn at their authoritative tier.
 *
 * Requires: the exchange DEPLOYED + tier test users (`npm run provision-test-users`) +
 * the endpoint URL in env. Skips cleanly otherwise (so the suite is green pre-deploy).
 *   VITE_CREDENTIAL_EXCHANGE_API_URL (or EXCHANGE_API_URL) =
 *     CDK output AgentEchelonCognitoAuth.CredentialExchangeApiUrl
 *
 * The BEARER-PIN enforcement (impersonation → AccessDenied) is an IAM property proven
 * by `backend/scripts/deny-test-credential-exchange.mjs`, not a UI/HTTP flow.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { getTestCredentials, hasTestCredentials } from './helpers/test-credentials';

const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const REGION = 'us-east-1';
const EXCHANGE_URL = (process.env.VITE_CREDENTIAL_EXCHANGE_API_URL || process.env.EXCHANGE_API_URL || '').replace(/\/$/, '');

/** Get a Cognito ID token via the AWS CLI (mirrors test-credentials.ts's CLI approach,
 *  so the tests project needs no extra SDK dependency). */
function getIdToken(email: string, password: string, clientId: string): string {
  const raw = execSync(
    `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ` +
      `--client-id "${clientId}" ` +
      `--auth-parameters USERNAME="${email}",PASSWORD="${password}" ` +
      `--query AuthenticationResult.IdToken --output text --region ${REGION}`,
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, AWS_PROFILE } },
  ).trim();
  if (!raw || raw === 'None') throw new Error(`No IdToken for ${email}`);
  return raw;
}

const subOf = (idToken: string): string =>
  JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')).sub;

const runnable = !!EXCHANGE_URL && hasTestCredentials();

test.describe('Credential Exchange API', () => {
  test.skip(!runnable, 'Set VITE_CREDENTIAL_EXCHANGE_API_URL + provision test users (needs a deploy).');

  test('rejects an unauthenticated request (Cognito authorizer)', async ({ request }) => {
    const resp = await request.post(`${EXCHANGE_URL}/exchange-credentials`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(401);
  });

  test('vends scoped creds for the caller\'s own AppInstanceUser at their tier', async ({ request }) => {
    const creds = await getTestCredentials();
    const idToken = getIdToken(creds.basicUser.email, creds.basicUser.password, creds.cognitoClientId);
    const sub = subOf(idToken);

    const resp = await request.post(`${EXCHANGE_URL}/exchange-credentials`, {
      data: {},
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();

    expect(body.credentials?.AccessKeyId).toBeTruthy();
    expect(body.credentials?.SessionToken).toBeTruthy();
    // The userArn is the caller's OWN AppInstanceUser (= their sub) — the pinned identity.
    expect(body.userArn).toContain(`/user/${sub}`);
    expect(body.tier).toBe('basic');
  });

  test('IDOR: a body-supplied sub/tier is ignored (identity from the validated token)', async ({ request }) => {
    const creds = await getTestCredentials();
    const idToken = getIdToken(creds.basicUser.email, creds.basicUser.password, creds.cognitoClientId);
    const sub = subOf(idToken);

    const resp = await request.post(`${EXCHANGE_URL}/exchange-credentials`, {
      data: { sub: 'attacker-sub', tier: 'premium' },
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.userArn).toContain(`/user/${sub}`); // not 'attacker-sub'
    expect(body.tier).toBe('basic');                // not 'premium'
  });
});
