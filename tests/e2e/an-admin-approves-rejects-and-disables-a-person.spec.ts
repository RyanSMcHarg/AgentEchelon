/**
 * AN ADMIN APPROVES, REJECTS, DISABLES AND RE-ENABLES A PERSON FROM THE CONSOLE (README "Key Features", User
 * Management), and the pool records each decision.
 *
 * Two throwaway accounts are made in the deployment's own pool, in the state a confirmed sign-up is in before
 * anyone approves it: enabled, `custom:approved=false`, a requested `custom:tier`, and no clearance group. The
 * e2e admin then works the Manage Users tab the way an operator does:
 *
 *  - Approve on the first. The pool holds `custom:approved=true`, the account enabled, and exactly one clearance
 *    group, the one approved. The person signs in and the credential exchange vends them a session.
 *  - Reject on the second. The pool holds the account disabled and `custom:approved=false`, and a sign-in is
 *    refused, so no token exists to bring to the exchange.
 *  - Disable on the first (the same `POST /users/reject` as Reject). The pool holds the account disabled, the
 *    exchange refuses the token the person already holds (`PERSON_NOT_ACTIVE`), and a fresh sign-in is refused.
 *  - Re-enable on the first. The pool holds the account enabled and approved with its clearance group intact,
 *    the exchange vends the same person again on the token held, and a fresh sign-in succeeds.
 *
 * Every result is read from the AUTHORITATIVE state, Cognito's own record (`admin-get-user`,
 * `admin-list-groups-for-user`) and the exchange's answer, not from the console's rendering of it. Both
 * accounts are offboarded through `POST /users/delete` and removed from the pool in `afterAll`.
 *
 * Gated on `USER_MANAGEMENT_E2E=1` because it writes to the pool; it runs in the `admin-surfaces` phase.
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { test, expect, allowBackendError } from './helpers/fixtures';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl } from './helpers/api-urls';
import { idTokenFor } from './helpers/person';
import { signedAdminContext, type SignedAdminContext } from './helpers/signed-analytics';
import { awsOrNull, awsv } from './helpers/aws';

const RUN = process.env.USER_MANAGEMENT_E2E === '1';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

/** A throwaway account this spec made. `token` appears in both its address and its name, so its row is found either way. */
interface Throwaway { email: string; password: string; token: string; personArn?: string }

/** The pool's own record of an account. */
interface PoolState { enabled: boolean; status: string; approved: string; requestedClassification: string; groups: string[] }

function poolState(poolId: string, username: string): PoolState {
  const user = awsv(['cognito-idp', 'admin-get-user', '--user-pool-id', poolId, '--username', username]);
  const attrs: Array<{ Name: string; Value: string }> = user?.UserAttributes ?? [];
  const attr = (name: string) => attrs.find((a) => a.Name === name)?.Value ?? '';
  const groups = awsv(['cognito-idp', 'admin-list-groups-for-user', '--user-pool-id', poolId, '--username', username]);
  return {
    enabled: user?.Enabled === true,
    status: String(user?.UserStatus ?? ''),
    approved: attr('custom:approved'),
    requestedClassification: attr('custom:tier'),
    groups: (groups?.Groups ?? []).map((g: { GroupName: string }) => g.GroupName),
  };
}

/**
 * The pool's answer to a sign-in that is expected to be refused: the CLI's error text, or '' when the sign-in
 * succeeded. An argv with no shell, so the error is the CLI's and not a quoting failure.
 */
function signInRefusal(email: string, password: string, clientId: string): string {
  try {
    execFileSync('aws', [
      'cognito-idp', 'initiate-auth', '--auth-flow', 'USER_PASSWORD_AUTH', '--client-id', clientId,
      '--auth-parameters', `USERNAME=${email},PASSWORD=${password}`,
      '--query', 'AuthenticationResult.IdToken', '--output', 'text', '--region', REGION,
    ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    return '';
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return String(e.stderr || e.message || 'refused');
  }
}

/** A pending account, as a confirmed sign-up leaves it before approval, minus the group the approval places. */
function makePending(poolId: string, domain: string, label: string, requestedClassification: string): Throwaway {
  const token = `um-${label}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const email = `e2e-${token}@${domain}`;
  // The pool requires a lowercase letter, an uppercase letter, a digit and a symbol; `#` passes a shell unaltered.
  const password = `Aa1#${randomBytes(10).toString('hex')}`;
  const pool = ['--user-pool-id', poolId];
  awsv(['cognito-idp', 'admin-create-user', ...pool, '--username', email, '--message-action', 'SUPPRESS',
    '--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true', `Name=name,Value=E2E ${token}`,
    'Name=custom:approved,Value=false', `Name=custom:tier,Value=${requestedClassification}`]);
  // A permanent password confirms the account, as a completed sign-up is.
  awsv(['cognito-idp', 'admin-set-user-password', ...pool, '--username', email, '--password', password, '--permanent']);
  return { email, password, token };
}

test.describe('an admin approves, rejects and disables a person', () => {
  guardBackendErrors('an-admin-approves-rejects-and-disables-a-person');
  guardConsoleErrors();
  test.skip(!RUN, 'USER_MANAGEMENT_E2E=1 runs the user-management approve, reject and enable/disable e2e');
  test.skip(RUN && (!PERSON_API_URL || !ADMIN_API_URL), 'VITE_PERSON_API_URL and VITE_ADMIN_API_URL are required');
  test.skip(RUN && !hasTestCredentials(), 'needs the provisioned test users');

  const made: Throwaway[] = [];
  let admin: SignedAdminContext | null = null;
  let poolId = '';

  test.afterAll(async () => {
    for (const person of made.splice(0)) {
      // OFFBOARDED AS THE CONSOLE DOES IT, by person where the exchange made one, else by pool username, then
      // removed from the pool directly in case offboarding left the account.
      if (admin) {
        const body = person.personArn
          ? { personArn: person.personArn, reason: 'e2e: user-management throwaway' }
          : { username: person.email, reason: 'e2e: user-management throwaway' };
        await admin.post(adminUrl('user-management', '/users/delete'), { data: body }).catch(() => undefined);
      }
      if (poolId) awsOrNull(`cognito-idp admin-delete-user --user-pool-id "${poolId}" --username "${person.email}"`);
    }
    await admin?.dispose().catch(() => undefined);
  });

  test('approve, reject, disable and re-enable each land in the pool, and the exchange follows them', async ({ page }) => {
    test.setTimeout(600_000);
    const creds = await getTestCredentials();
    const adminUser = await getAdminUser();
    test.skip(!adminUser?.password, missingUserReason('testAdmin'));
    poolId = creds.cognitoUserPoolId;
    const clientId = creds.cognitoClientId;
    // THE DOMAIN THE TEST USERS ARE ON: the test inbox's where one is configured, else the admin's own.
    const domain = creds.testInbox?.domain || adminUser.email.split('@')[1];
    // A pending account's sign-in is refused by the pre-authentication trigger, which throws to refuse it.
    allowBackendError(/pending administrator approval/i);

    admin = signedAdminContext(idTokenFor(adminUser.email, adminUser.password, clientId));

    // THE CLEARANCE GROUPS THIS DEPLOYMENT DECLARES, from the same list the console reads.
    const listing = await admin.get(adminUrl('user-management', '/users'));
    expect(listing.status(), 'the admin reads the list of people').toBe(200);
    const clearanceGroups: Array<{ name: string; clears: string }> = (await listing.json()).clearanceGroups ?? [];
    const groupNames = clearanceGroups.map((g) => g.name);
    expect(groupNames.length, 'the deployment declares a clearance group to approve at').toBeGreaterThan(0);
    const approveAt = (clearanceGroups.find((g) => g.clears === 'basic') ?? clearanceGroups[0]).name;

    const approved = makePending(poolId, domain, 'approve', approveAt);
    made.push(approved);
    const rejected = makePending(poolId, domain, 'reject', approveAt);
    made.push(rejected);

    await test.step('both accounts are pending in the pool, and neither may sign in', async () => {
      for (const p of [approved, rejected]) {
        const s = poolState(poolId, p.email);
        expect(s, `${p.email} starts pending`).toMatchObject({ enabled: true, status: 'CONFIRMED', approved: 'false' });
        expect(s.groups.filter((g) => groupNames.includes(g)), `${p.email} holds no clearance group before approval`).toEqual([]);
        expect(signInRefusal(p.email, p.password, clientId), `${p.email}: a pending sign-in is refused`).toMatch(/pending administrator approval/i);
      }
    });

    await signInAsAdmin(page);
    await page.goto('/?admin=user_management');
    await expect(page.getByTestId('offboarding-keeps')).toBeVisible({ timeout: 30_000 });
    const card = (p: Throwaway) => page.locator('.um-card', { hasText: p.token });
    const showFilter = async (label: 'Pending' | 'Approved' | 'Disabled') => {
      await page.locator('.um-stat', { hasText: label }).click();
      await expect(page.locator('.um-toolbar h2')).toHaveText(`${label} Users`);
    };

    await test.step('Approve: approved, enabled, in exactly the clearance group approved, and vended a session', async () => {
      await showFilter('Pending');
      await expect(card(approved)).toBeVisible({ timeout: 60_000 });
      const approve = card(approved).getByRole('button', { name: 'Approve', exact: true });
      await expect(approve, 'Approve is offered on the requested clearance').toBeEnabled();
      await approve.click();
      await expect(card(approved), 'an approved person leaves the pending list').toHaveCount(0, { timeout: 30_000 });

      await expect.poll(() => poolState(poolId, approved.email), { timeout: 30_000 })
        .toMatchObject({ enabled: true, approved: 'true', requestedClassification: approveAt });
      expect(poolState(poolId, approved.email).groups.filter((g) => groupNames.includes(g)), 'exactly one clearance group, the one approved')
        .toEqual([approveAt]);

      await showFilter('Approved');
      await expect(card(approved)).toBeVisible({ timeout: 30_000 });
    });

    // SIGNED IN ONCE, after approval. The disable and re-enable below are measured on this token.
    const heldToken = idTokenFor(approved.email, approved.password, clientId);
    const firstVend = await exchange(heldToken, {});
    expect(firstVend.status, 'an approved person is vended a session').toBe(200);
    const personArn = String(firstVend.body?.userArn ?? '');
    expect(personArn, 'the exchange names a person').toContain('/user/');
    approved.personArn = personArn;

    await test.step('Reject: disabled and unapproved in the pool, and refused at sign-in', async () => {
      await showFilter('Pending');
      await expect(card(rejected)).toBeVisible({ timeout: 60_000 });
      await card(rejected).getByRole('button', { name: 'Reject', exact: true }).click();
      await expect(card(rejected), 'a rejected person leaves the pending list').toHaveCount(0, { timeout: 30_000 });

      await expect.poll(() => poolState(poolId, rejected.email), { timeout: 30_000 })
        .toMatchObject({ enabled: false, approved: 'false' });
      expect(poolState(poolId, rejected.email).groups.filter((g) => groupNames.includes(g)), 'a rejection grants no clearance group')
        .toEqual([]);
      // NO TOKEN EXISTS FOR THE EXCHANGE TO REFUSE: the pool refuses the sign-in that would mint one.
      expect(signInRefusal(rejected.email, rejected.password, clientId), 'a rejected person is refused a sign-in').not.toBe('');

      await showFilter('Disabled');
      await expect(card(rejected)).toBeVisible({ timeout: 30_000 });
    });

    await test.step('Disable: disabled in the pool, refused by the exchange on the token held, and at sign-in', async () => {
      await showFilter('Approved');
      await expect(card(approved)).toBeVisible({ timeout: 60_000 });
      await card(approved).getByRole('button', { name: 'Disable', exact: true }).click();
      await expect(card(approved), 'a disabled person leaves the approved list').toHaveCount(0, { timeout: 30_000 });

      await expect.poll(() => poolState(poolId, approved.email), { timeout: 30_000 })
        .toMatchObject({ enabled: false, approved: 'false' });
      const vend = await exchange(heldToken, {});
      expect(vend.status, 'a disabled person is vended nothing on the token they still hold').toBe(403);
      expect(vend.body?.code).toBe('PERSON_NOT_ACTIVE');
      expect(signInRefusal(approved.email, approved.password, clientId), 'a disabled person is refused a sign-in').not.toBe('');

      await showFilter('Disabled');
      await expect(card(approved)).toBeVisible({ timeout: 30_000 });
    });

    await test.step('Re-enable: enabled and approved with the clearance kept, and vended the same person again', async () => {
      await card(approved).getByRole('button', { name: 'Re-enable', exact: true }).click();
      await expect(card(approved), 'a re-enabled person leaves the disabled list').toHaveCount(0, { timeout: 30_000 });

      await expect.poll(() => poolState(poolId, approved.email), { timeout: 30_000 })
        .toMatchObject({ enabled: true, approved: 'true', requestedClassification: approveAt });
      expect(poolState(poolId, approved.email).groups.filter((g) => groupNames.includes(g)), 'the clearance group survives disable and re-enable')
        .toEqual([approveAt]);
      const vend = await exchange(heldToken, {});
      expect(vend.status, 'a re-enabled person is vended a session on the token they hold').toBe(200);
      expect(vend.body?.userArn, 'the same person as before').toBe(personArn);
      expect(signInRefusal(approved.email, approved.password, clientId), 'a re-enabled person signs in').toBe('');

      await showFilter('Approved');
      await expect(card(approved)).toBeVisible({ timeout: 30_000 });
    });
  });
});
