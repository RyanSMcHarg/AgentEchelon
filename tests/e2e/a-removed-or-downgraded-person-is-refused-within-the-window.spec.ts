/**
 * A REMOVED, DOWNGRADED OR DISABLED PERSON IS REFUSED WITHIN THE STATED WINDOW (DESIGN-REVOCATION-WINDOWS section 4).
 *
 * Every probe uses the token the person held BEFORE the change: it is signed in once, at the start, and never again,
 * so the spec measures the credential a person already holds rather than a fresh sign-in. The probe is a signature
 * request for a file in the conversation (`POST /presigned-url`), which runs the shared conversation check.
 *
 *  - Downgraded (`POST /users/tier`, by the console): refused within `CLEARANCE_RECHECK_SECONDS` plus the time the
 *    re-evaluation takes to remove the membership the new clearance does not reach (R1, R4).
 *  - Removed (`POST /conversations/remove-member`, by the owner): refused at once.
 *  - Disabled (`POST /users/reject`, by the console): the person's next credential vend is refused at once. A
 *    person route stays open for the token's lifetime until R3 is built, and this spec does not claim otherwise.
 *
 * Each window is an assertion: the elapsed time of the first refusal is compared with it, a probe admitted after its
 * first refusal fails the spec, and every probe is admitted before the change, so a probe that was never working
 * cannot pass as a refusal. The person's clearance and account are restored in `finally`, and the conversation
 * archived. Offboarding, which is not a window, is held by `h1-offboard.spec.ts`.
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personApiServes } from './helpers/api-urls';
import { archive, openConversation, removeMember, shareWith, signUpload } from './helpers/person-session';
import { idTokenFor, personArnFromIdToken } from './helpers/person';
import { signedAdminContext } from './helpers/signed-analytics';
import { CLEARANCE_RECHECK_SECONDS } from '../../backend/lambda/src/lib/conversation-access';

const RUN = process.env.REVOCATION_WINDOWS_E2E === '1';
/** The re-evaluation is an asynchronous invoke; this is what it may add to the recheck window. */
const REEVAL_ALLOWANCE_S = 30;
const POLL_MS = 5_000;

/** Probe until the first refusal, then require it to hold. Returns the seconds the first refusal took. */
async function refusedWithin(probe: () => Promise<number>, windowS: number, what: string): Promise<number> {
  const started = Date.now();
  let firstRefusalS = -1;
  while ((Date.now() - started) / 1000 <= windowS + POLL_MS / 1000) {
    const status = await probe();
    if (status === 403) { firstRefusalS = (Date.now() - started) / 1000; break; }
    expect([200, 403], `${what}: an answer that is neither admitted nor refused (${status})`).toContain(status);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  expect(firstRefusalS, `${what}: never refused within ${windowS} s`).toBeGreaterThanOrEqual(0);
  expect(firstRefusalS, `${what}: refused after the ${windowS} s window`).toBeLessThanOrEqual(windowS);
  for (let i = 0; i < 3; i++) expect(await probe(), `${what}: admitted again after its first refusal`).toBe(403);
  return firstRefusalS;
}

test.describe('revocation windows', () => {
  guardBackendErrors('a-removed-or-downgraded-person-is-refused-within-the-window');
  test.skip(!RUN, 'REVOCATION_WINDOWS_E2E=1 runs the revocation windows e2e');
  test.skip(RUN && (!PERSON_API_URL || !ADMIN_API_URL), 'VITE_PERSON_API_URL and VITE_ADMIN_API_URL are required');
  test.skip(RUN && !hasTestCredentials(), 'needs the provisioned test users');

  test('a downgrade, a removal and a disable each close within their window, on the credential already held', async () => {
    test.setTimeout(900_000);
    test.skip(!personApiServes('notifications'), 'a share is the notifications capability\'s route (/share-conversation)');
    const creds = await getTestCredentials();
    const adminUser = await getAdminUser();
    const subject = await getSecondPremiumUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    test.skip(!subject?.password, missingUserReason('secondPremiumUser'));
    const clientId = creds.cognitoClientId;

    // SIGNED IN ONCE. Every probe below uses these tokens, whatever changes.
    const ownerToken = idTokenFor(creds.premiumUser.email, creds.premiumUser.password, clientId);
    const subjectToken = idTokenFor(subject!.email, subject!.password, clientId);
    expect((await exchange(subjectToken, {})).status, 'the person is vended a session before any change').toBe(200);
    const subjectArn = await personArnFromIdToken(subjectToken);
    const admin = signedAdminContext(idTokenFor(adminUser.email, adminUser.password, clientId));

    const { channelArn, conversationId } = await openConversation(ownerToken, `Revocation windows ${Date.now()}`);
    const share = () => shareWith(ownerToken, channelArn, 'Revocation windows', subject!.email);
    const sign = async () => (await signUpload(subjectToken, conversationId)).status;
    const admitted = async (what: string, withinS: number) => {
      const started = Date.now();
      let status = await sign();
      while (status !== 200 && (Date.now() - started) / 1000 < withinS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        status = await sign();
      }
      expect(status, `${what}: the probe is not admitted, so a refusal would prove nothing`).toBe(200);
    };

    try {
      expect((await share()).status, 'the owner shares the conversation').toBe(200);
      await admitted('baseline', 30);

      // DOWNGRADED: a clearance that does not reach the conversation.
      expect((await admin.post(adminUrl('user-management', '/users/tier'), { data: { username: subject!.email, tier: 'basic' } })).status()).toBe(200);
      // The live clearance read is cached for CLEARANCE_RECHECK_SECONDS, so the refusal waits on that timer.
      declareWait('the clearance recheck window after a downgrade', Date.now() + (CLEARANCE_RECHECK_SECONDS + REEVAL_ALLOWANCE_S) * 1000);
      const downgradeS = await refusedWithin(sign, CLEARANCE_RECHECK_SECONDS + REEVAL_ALLOWANCE_S, 'downgraded');
      console.log(`[revocation-windows] downgraded: refused after ${downgradeS.toFixed(1)} s`);

      // RESTORED, then REMOVED by the owner.
      expect((await admin.post(adminUrl('user-management', '/users/tier'), { data: { username: subject!.email, tier: 'premium' } })).status()).toBe(200);
      expect((await share()).status, 'the owner shares the conversation again').toBe(200);
      declareWait('the clearance recheck window after a restore', Date.now() + (CLEARANCE_RECHECK_SECONDS + REEVAL_ALLOWANCE_S) * 1000);
      await admitted('restored', CLEARANCE_RECHECK_SECONDS + REEVAL_ALLOWANCE_S);
      const removed = await removeMember(ownerToken, channelArn, subjectArn);
      expect(removed.status, JSON.stringify(removed.body).slice(0, 300)).toBe(200);
      const removalS = await refusedWithin(sign, 10, 'removed');
      console.log(`[revocation-windows] removed: refused after ${removalS.toFixed(1)} s`);

      // DISABLED: the next vend on the token already held is refused at once.
      expect((await admin.post(adminUrl('user-management', '/users/reject'), { data: { username: subject!.email } })).status()).toBe(200);
      const vend = await exchange(subjectToken, {});
      expect(vend.status, 'a disabled person is vended nothing on the token they still hold').toBe(403);
      expect(vend.body?.code).toBe('PERSON_NOT_ACTIVE');
    } finally {
      await admin.post(adminUrl('user-management', '/users/enable'), { data: { username: subject!.email } }).catch(() => undefined);
      await admin.post(adminUrl('user-management', '/users/tier'), { data: { username: subject!.email, tier: 'premium' } }).catch(() => undefined);
      await archive(ownerToken, channelArn).catch(() => undefined);
    }
  });
});
