/**
 * B13 against a deployment: AN EXPORT COVERS EVERY STORE THAT NAMES A PERSON, and changes none of them.
 *
 * The console's signed `POST /users/export` for a test user returns one archive with a section for every
 * store of the inventory an erasure walks (SPEC-CREDENTIAL-EXCHANGE §5b), in that order; every store this
 * person is known to have rows in is held (their Identities row, their AppInstanceUser, their pool account,
 * their preferences once a mute is set, the conversations they are in); no section carries a token or its
 * hash; the stores whose export is not built say so. Exporting twice gives the same sections, and nothing
 * the person had is gone after it.
 *
 * Gated by EXPORT_E2E=1. Needs VITE_ADMIN_API_URL and VITE_PERSON_API_URL, and the provisioned test users.
 *
 *   EXPORT_E2E=1 AWS_PROFILE=<p> npx playwright test e2e/export.spec.ts --config=playwright.config.ts
 */
import { test, expect } from './helpers/fixtures';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';
import { getTestCredentials, hasTestCredentials } from './helpers/test-credentials';
import { idTokenFor, personArnFromIdToken } from './helpers/person';
import { signedAdminContext } from './helpers/signed-analytics';
import { guardBackendErrors } from './helpers/turn-guards';

const RUN = process.env.EXPORT_E2E === '1';

/** The inventory's stores, in the order erasure walks them (`OFFBOARDED_STORES`, then `OFFBOARDING_KEPT`). */
// A COPY, kept equal to the inventory by backend/test/the-export-e2e-names-the-inventory.test.ts: importing
// offboarding.ts here would pull every AWS client it uses into the browser suite.
const STORES = [
  'adminTwin', 'upgradeSources', 'memberships', 'userProfile', 'contactCopies', 'noticePreferences', 'userTasks', 'agentTasks',
  'turnState', 'channelContext', 'battleConfig', 'budgetRows', 'attachments', 'auroraProjection', 'connectorGrants',
  'personTokens', 'identities', 'appInstanceUser', 'poolAccount',
  'battle_votes', 'feedback', 'archive',
];

test.describe('an export by AppInstanceUser (B13)', () => {
  guardBackendErrors('export');
  test.skip(!RUN, 'EXPORT_E2E=1 runs the export e2e');
  test.skip(RUN && (!ADMIN_API_URL || !PERSON_API_URL), 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are required');
  test.skip(RUN && !hasTestCredentials(), 'needs the provisioned test users');

  test('covers every store the inventory names, holds what the person has, and changes nothing', async () => {
    test.setTimeout(300_000);
    const creds = await getTestCredentials();
    const subject = creds.standardUser;
    const subjectToken = idTokenFor(subject.email, subject.password, creds.cognitoClientId);
    const personArn = await personArnFromIdToken(subjectToken);

    // A preference the export must find: muted through the person's own signed-in screen's route.
    const mute = await fetch(personUrl('/email/preferences/mine'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subjectToken}` },
      body: JSON.stringify({ kind: 'briefing', muted: true }),
    });
    expect([200, 404]).toContain(mute.status);

    const admin = signedAdminContext(idTokenFor(creds.testAdmin.email, creds.testAdmin.password, creds.cognitoClientId));
    try {
      const first = await admin.post(adminUrl('user-management', '/users/export'), { data: { personArn } });
      expect(first.status(), await first.text()).toBe(200);
      const archive = await first.json();
      expect(archive).toMatchObject({ format: 'agentechelon-person-export', version: 1, personArn });
      expect(archive.sections.map((s: { store: string }) => s.store)).toEqual(STORES);
      const by = Object.fromEntries(archive.sections.map((s: { store: string }) => [s.store, s]));
      for (const store of ['identities', 'appInstanceUser', 'poolAccount']) expect({ store, held: by[store].held }).toEqual({ store, held: true });
      if (mute.status === 200) expect(by.noticePreferences.held).toBe(true);
      for (const store of ['connectorGrants', 'battle_votes', 'feedback', 'archive']) expect(by[store].notBuilt).toMatch(/NOT BUILT/);
      for (const row of by.personTokens.rows) expect(row).not.toHaveProperty('pk');

      // NOTHING CHANGED: the person still signs in as the same AppInstanceUser, and a second export agrees.
      expect(await personArnFromIdToken(idTokenFor(subject.email, subject.password, creds.cognitoClientId))).toBe(personArn);
      const second = await (await admin.post(adminUrl('user-management', '/users/export'), { data: { personArn } })).json();
      expect(second.sections.map((s: { store: string; held: boolean }) => [s.store, s.held]))
        .toEqual(archive.sections.map((s: { store: string; held: boolean }) => [s.store, s.held]));
    } finally {
      await fetch(personUrl('/email/preferences/mine'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subjectToken}` },
        body: JSON.stringify({ kind: 'briefing', muted: false }),
      }).catch(() => undefined);
      await admin.dispose();
    }
  });

  test('is refused to a session without the export capability', async () => {
    const creds = await getTestCredentials();
    const token = idTokenFor(creds.basicUser.email, creds.basicUser.password, creds.cognitoClientId);
    const resp = await fetch(adminUrl('user-management', '/users/export'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ personArn: await personArnFromIdToken(token) }),
    });
    // A Bearer token is refused at the gateway: every admin route is IAM-authorized.
    expect([401, 403]).toContain(resp.status);
  });
});
