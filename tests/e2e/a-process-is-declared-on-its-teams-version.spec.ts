/**
 * A PROCESS IS DECLARED ON ITS TEAM'S VERSION (SPEC-PROCESSES P1), against the deployed stacks.
 *
 * The unit suite proves each refusal (`a-process-definition-is-refused-when-incomplete.test.ts`). What only a deployment proves is
 * the console's path: a `processes` entry saved on a draft of the ops assistant's version is validated with the version, a linked
 * workflow the version does not declare is refused with its coded reason, a complete entry validates, and the active version's
 * listing names the process with the edition its metrics are computed for once activated. The run returns the version.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with PROCESS_E2E=1.
 *
 * **Coverage:** `e2e/a-process-is-declared-on-its-teams-version.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { idTokenFor } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';

const RUN = process.env.PROCESS_E2E === '1';
const PROCESS = 'incident-response';

test.describe('a process is declared on its team\'s version (P1)', () => {
  guardBackendErrors('a-process-is-declared-on-its-teams-version');
  test.describe.configure({ mode: 'serial' });
  let admin: VendedCredentials | undefined;
  let owner = '';
  let previousVersion: number | undefined;

  test.beforeAll(async () => {
    test.skip(!RUN, 'set PROCESS_E2E=1: this run changes the ops assistant\'s active version');
    test.skip(!hasTestCredentials() || !ADMIN_API_URL, 'no test credentials or admin API on this deployment');
    const adminUser = await getAdminUser();
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser!.email, adminUser!.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status).toBe(200);
    admin = session.body.credentials;
    owner = liveAssistantFor('premium', 'ops');
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeVersion;
  });

  test.afterAll(async () => {
    if (admin && previousVersion !== undefined) await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName: owner, version: previousVersion }).catch(() => undefined);
  });

  test('an undeclared workflow is refused with its coded reason, a complete entry validates and is listed with its edition', async () => {
    test.setTimeout(180_000);
    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: owner });
    expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);

    const bad = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', {
      profileName: owner, configId: draftIdOf(created), patch: { processes: { [PROCESS]: { label: 'Incident response', workflows: ['no-such-workflow'] } } },
    });
    const refused = bad.status === 200 ? await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin!, 'POST', { profileName: owner }) : bad;
    expect(JSON.stringify(refused.body)).toContain('PROCESS_WORKFLOW_UNDECLARED');

    const good = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', {
      profileName: owner, configId: draftIdOf(bad.status === 200 ? bad : created),
      patch: { processes: { [PROCESS]: { label: 'Incident response', workflows: ['ops-room', 'incident-triage'], metrics: [{ id: 'resolved-in-4h', label: 'Resolved within 4 hours', workflow: 'ops-room', within: 'PT4H', target: 0.8 }] } } },
    });
    expect(good.status, JSON.stringify(good.body).slice(0, 300)).toBe(200);
    const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin!, 'POST', { profileName: owner });
    expect(valid.body?.valid, JSON.stringify(valid.body).slice(0, 400)).toBe(true);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: owner, configId: draftIdOf(good) });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 300)).toBe(200);

    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    const processes = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeProcesses ?? {};
    expect(processes[PROCESS]?.label).toBe('Incident response');
    expect(processes[PROCESS]?.edition).toMatch(/^[a-f0-9]{12}$/);
  });
});
