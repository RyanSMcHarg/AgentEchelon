/**
 * B12 against a deployment: ONE ROW PER STAGE FOR ONE UPGRADE, under path A and under path B.
 *
 * Each path is driven through the deployed person API as a visitor and an account would drive it, and the
 * funnel is then read back through the console's signed analytics query (`guest_to_customer_funnel`),
 * narrowed to the one journey the run made: the visitor's conversation, by its channel id. No row is joined
 * by an address.
 *
 *   Path A: guest start (`guest_started`), then a fresh account's first sign-in presenting the visitor's live
 *     refresh credential (`guest_bound`).
 *   Path B: guest start (`guest_started`), the registration (`claim_sent`), then a customer's claim
 *     (`claim_redeemed`).
 *
 * The stages whose recorders are NOT BUILT (`registration_offered`, `registration_started`, `rep_added`,
 * `rep_first_reply`, `handoff_unassigned`) are asserted absent: they are declared, never counted as zero.
 *
 * Gated by FUNNEL_E2E=1, on a non-production instance whose registry declares a guest issuer (the captcha
 * vendor's always-pass test keys). Path A creates a fresh account in this deployment's pool and deletes it;
 * path B needs a customers' pool test account, CUSTOMER_EMAIL / CUSTOMER_PASSWORD / CUSTOMER_CLIENT_ID, and the
 * test inbox: the registration's claim reaches the visitor only as the sign-in link in an email, never in the answer.
 * The archive is eventually consistent, so the read is polled until the stages arrive or the wait ends.
 *
 *   FUNNEL_E2E=1 AWS_PROFILE=<p> npx playwright test e2e/funnel.spec.ts --config=playwright.config.ts
 */
import { test, expect } from './helpers/fixtures';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { PERSON_API_URL, adminUrl } from './helpers/api-urls';
import { getTestCredentials, hasTestCredentials } from './helpers/test-credentials';
import { idTokenFor } from './helpers/person';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { awsv } from './helpers/aws';
import { stackName } from './helpers/stack-prefix';
import { getTestInbox, inboxSkipReason, waitForEmail } from './helpers/test-inbox';
import { guardBackendErrors } from './helpers/turn-guards';

const RUN = process.env.FUNNEL_E2E === '1';
const DUMMY_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX';
const NOT_BUILT = ['registration_offered', 'registration_started', 'rep_added', 'rep_first_reply', 'handoff_unassigned'];

/** A stack's outputs, by key. */
function stackOutputs(name: string): Record<string, string> {
  const r = awsv(['cloudformation', 'describe-stacks', '--stack-name', stackName(name)]);
  return Object.fromEntries((r?.Stacks?.[0]?.Outputs ?? []).map((o: { OutputKey: string; OutputValue: string }) => [o.OutputKey, o.OutputValue]));
}

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(`${PERSON_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  try { return { status: resp.status, body: JSON.parse(text) }; } catch { return { status: resp.status, body: { raw: text } }; }
}

/** The journey's stages, polled from the archive until `expected` are all present or the wait ends. */
async function journeyStages(adminToken: string, journey: string, expected: string[]): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  let stages = new Map<string, number>();
  for (let i = 0; i < 40; i += 1) {
    const r = await signedAnalyticsPost(adminUrl('analytics', '/'), adminToken, {
      queryType: 'guest_to_customer_funnel', dateRange: { start: today, end: today }, journey,
    });
    stages = new Map((r?.data ?? []).map((row: { step: string; event_count: number | string }) => [row.step, Number(row.event_count)]));
    if (expected.every((s) => stages.has(s))) return stages;
    await new Promise((res) => setTimeout(res, 15_000));
  }
  return stages;
}

async function startVisit(noticeVersion: string): Promise<{ body: any; journey: string }> {
  const visit = await post('/guest/start', { captchaToken: DUMMY_CAPTCHA, noticeVersion });
  expect(visit.status, `guest start: ${JSON.stringify(visit.body)}`).toBe(200);
  return { body: visit.body, journey: String(visit.body.channelArn).split('/').pop() || '' };
}

test.describe('the guest-to-customer funnel records one row per stage (B12)', () => {
  guardBackendErrors('funnel');
  test.skip(!RUN, 'FUNNEL_E2E=1 runs the funnel e2e');
  test.skip(RUN && !PERSON_API_URL, 'VITE_PERSON_API_URL is required');
  test.skip(RUN && !hasTestCredentials(), 'needs the provisioned test users');

  test('path A: a visit bound to a fresh account is guest_started then guest_bound, once each', async () => {
    test.setTimeout(900_000);
    const creds = await getTestCredentials();
    const identity = stackOutputs('Identity');
    const noticeVersion = identity.GuestNoticeVersion;
    test.skip(!noticeVersion, 'this deployment declares no guest issuer');
    const admin = idTokenFor(creds.testAdmin.email, creds.testAdmin.password, creds.cognitoClientId);

    const { body: visit, journey } = await startVisit(noticeVersion);
    const email = `funnel-a-${randomUUID().slice(0, 8)}@${creds.testInbox?.domain || 'example.com'}`;
    const password = `Fx${randomUUID()}!9`;
    awsv(['cognito-idp', 'admin-create-user', '--user-pool-id', creds.cognitoUserPoolId, '--username', email,
      '--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true', '--message-action', 'SUPPRESS']);
    try {
      awsv(['cognito-idp', 'admin-set-user-password', '--user-pool-id', creds.cognitoUserPoolId, '--username', email, '--password', password, '--permanent']);
      // THE HAND-OFF, as the widget makes it: a secret kept here, its hash on one refresh, the nonce back.
      const secret = randomBytes(32).toString('base64url');
      const handed = await post('/guest/refresh', { refreshToken: visit.refreshToken, bindSecretHash: createHash('sha256').update(secret).digest('base64url') });
      expect(handed.status, `the hand-off: ${JSON.stringify(handed.body)}`).toBe(200);
      const bound = await post('/exchange-credentials', { bindGuest: { nonce: handed.body.bindNonce, secret } }, idTokenFor(email, password, creds.cognitoClientId));
      expect(bound.status, `the bind: ${JSON.stringify(bound.body)}`).toBe(200);
      expect(bound.body.userArn).toBe(visit.userArn);

      const stages = await journeyStages(admin, journey, ['guest_started', 'guest_bound']);
      expect(stages.get('guest_started')).toBe(1);
      expect(stages.get('guest_bound')).toBe(1);
      for (const s of ['claim_sent', 'claim_redeemed', ...NOT_BUILT]) expect(stages.has(s), `${s} is not a path A stage, or is not built`).toBe(false);
    } finally {
      awsv(['cognito-idp', 'admin-delete-user', '--user-pool-id', creds.cognitoUserPoolId, '--username', email]);
    }
  });

  test('path B: a visit claimed by a customer is guest_started, claim_sent and claim_redeemed, once each', async () => {
    test.setTimeout(900_000);
    const { CUSTOMER_EMAIL, CUSTOMER_PASSWORD, CUSTOMER_CLIENT_ID } = process.env;
    test.skip(!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD || !CUSTOMER_CLIENT_ID, 'path B needs a customers\' pool account: CUSTOMER_EMAIL, CUSTOMER_PASSWORD and CUSTOMER_CLIENT_ID');
    const creds = await getTestCredentials();
    const identity = stackOutputs('Identity');
    const noticeVersion = identity.GuestNoticeVersion;
    test.skip(!noticeVersion, 'this deployment declares no guest issuer');
    const admin = idTokenFor(creds.testAdmin.email, creds.testAdmin.password, creds.cognitoClientId);

    const inbox = await getTestInbox();
    const address = inbox ? `funnel-${randomBytes(4).toString('hex')}@${inbox.domain}` : '';
    const noInbox = inboxSkipReason(inbox, address);
    test.skip(!!noInbox, noInbox);

    const { body: visit, journey } = await startVisit(noticeVersion);
    const since = Date.now();
    // A REGISTRATION NAMES THE ADDRESS ITS SIGN-IN LINK GOES TO, and its answer carries no claim
    // (`guest-upgrade.ts`): the claim is read from the email, as the visitor would follow it.
    const registered = await post('/guest/register', { email: address, fields: { name: 'Funnel E2E', company: 'Example' } }, visit.guestToken);
    expect(registered.status, `registration: ${JSON.stringify(registered.body)}`).toBe(200);
    expect(registered.body.claimToken, 'the answer carries no claim').toBeUndefined();
    const mail = await waitForEmail(inbox!, { to: address, since }, 180_000);
    const link = /#claim=([A-Za-z0-9_%-]{16,})/.exec(`${mail.text} ${mail.html}`.replace(/=\r?\n/g, '').replace(/=3D/gi, '='));
    expect(link, 'the email carries the sign-in link with its claim').toBeTruthy();
    const claimed = await post('/upgrade/claim', { claimToken: decodeURIComponent(link![1]) }, idTokenFor(CUSTOMER_EMAIL!, CUSTOMER_PASSWORD!, CUSTOMER_CLIENT_ID!));
    expect(claimed.status, `the claim: ${JSON.stringify(claimed.body)}`).toBe(200);
    expect(claimed.body.sourceChannelArn).toBe(visit.channelArn);

    const stages = await journeyStages(admin, journey, ['guest_started', 'claim_sent', 'claim_redeemed']);
    expect(stages.get('guest_started')).toBe(1);
    expect(stages.get('claim_sent')).toBe(1);
    expect(stages.get('claim_redeemed')).toBe(1);
    for (const s of ['guest_bound', ...NOT_BUILT]) expect(stages.has(s), `${s} is not a path B stage, or is not built`).toBe(false);
  });
});
