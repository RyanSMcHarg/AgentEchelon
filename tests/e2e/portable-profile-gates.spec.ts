/**
 * Portable assistant WRITE-PATH GATES (SPEC-PORTABLE-PROFILES + SPEC-CONTEXT-SOURCES-AND-STORES section 6).
 *
 * A profile is the portable artifact: it names capabilities by KEY and travels between deployments.
 * Two gates decide whether a version is allowed to become active here, and both were CLAIMED before
 * they existed:
 *
 *   1. Every `contextSources` key must be published by this classification's catalog. A comment
 *      asserted this was "checked at the write path and at import"; only import checked. An operator
 *      could activate a version naming a key the deployment does not publish, get no error, and find
 *      out from a per-turn `not-in-catalog` metric - a silently partial assistant.
 *   2. A version's persona must fit its cap. Which cap that is CHANGED, and the two cases below are
 *      deliberately kept as a pair. The persona used to ride inside the definition parameter, so the
 *      parameter's 4096-character limit was the real ceiling while the schema advertised 20000 - a
 *      persona in that gap validated cleanly and then failed at PutParameter with an opaque AWS
 *      ValidationException. The body now lives in S3 and the definition holds a pointer, so a persona
 *      in that gap is STORABLE and the first case asserts it is accepted; MAX_PERSONA_LENGTH is still
 *      the ceiling, and the second asserts a persona past it is still refused by name. Asserting only
 *      the second would let the indirection silently regress: an implementation that quietly kept the
 *      body inline would pass it.
 *
 * These drive the LIVE manage-profiles API through the admin origin, because that is the path an
 * operator uses and the path where both gates were missing.
 *
 * SAFETY. Nothing here activates anything - every case stops at a draft, and the draft is reset to the
 * active body afterwards. That discipline is not incidental: a previous run of a profile spec left a
 * test persona live on the deployment because its rollback swallowed errors, so the cleanup here
 * verifies by READ-BACK rather than trusting the call to have worked.
 */
import { test, expect } from '@playwright/test';
import { signIn } from './helpers/agent-helpers';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { getAdminUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();

const PROFILE = 'standard';

const MANAGE_PROFILES_API = process.env.VITE_MANAGE_PROFILES_API_URL || '';

/**
 * Node-side SigV4 POST to the live manage-profiles API, matching profile-config.spec.ts.
 *
 * Deliberately NOT a page.evaluate: the API is IAM-enforced, so the browser cannot sign a request,
 * and referencing `import.meta` inside evaluate forces the whole spec into ESM scope, which breaks
 * Playwright's loader for the entire file.
 */
async function api(idToken: string, action: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await signedAnalyticsPost(`${MANAGE_PROFILES_API}${action}`, idToken, body);
  } catch (err) {
    // The API answers 4xx for a REJECTED draft, which is the expected result in most cases here.
    return { __error: String((err as Error).message || err) };
  }
}

test.describe.serial('portable profile write-path gates', () => {
  guardBackendErrors('portable-profile-gates');

  // Needs the IAM-enforced manage-profiles API, same gate profile-config uses.
  test.skip(!MANAGE_PROFILES_API, 'VITE_MANAGE_PROFILES_API_URL must be set (run via validate.mjs)');

  let idToken = '';

  test.beforeEach(async ({ page }) => {
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    await signIn(page, admin.email, admin.password);
    idToken = (await page.evaluate(() => localStorage.getItem('idToken'))) || '';
    expect(idToken, 'admin idToken').toBeTruthy();
  });

  test('the Profiles tab loads the portable artifacts from the live API', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?admin=profiles');

    await expect(page.locator('h3:has-text("Assistant Profiles")')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 20000 });

    const rows = page.locator('.admin-content table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    const listed = (await page.locator('.admin-content table').innerText()).toLowerCase();
    expect(listed, 'the seeded profiles should be listed').toMatch(/basic|standard|premium/);
  });

  test('activation is REFUSED for a context key this deployment does not publish', async () => {
    test.setTimeout(180_000);

    const bogus = 'x-e2e-key-that-is-not-published';
    await api(idToken, '/version', { profileName: PROFILE });
    await api(idToken, '/draft', { profileName: PROFILE, patch: { contextSources: [bogus] } });

    const validated = await api(idToken, '/validate', { profileName: PROFILE });
    const seen = JSON.stringify(validated);

    expect(
      seen,
      'validate accepted a context key the deployment does not publish. The write path is not '
      + 'consulting the published catalog, so this would only surface as a per-turn metric.',
    ).toContain(bogus);
    expect(validated.valid, 'the draft must not be reported valid').toBe(false);

    // Activation must refuse too: a caller can skip validate entirely, so it is the real gate.
    const activated = await api(idToken, '/activate', { profileName: PROFILE });
    expect(
      JSON.stringify(activated),
      'activate accepted a version naming an unpublished context key',
    ).toMatch(/not published|__error/);
  });

  test('a persona LARGER than the definition parameter is accepted, because the body is not in it', async () => {
    test.setTimeout(180_000);

    await api(idToken, '/version', { profileName: PROFILE });
    // Comfortably over the 4096-character limit the definition parameter has, comfortably inside the
    // 20000-character persona cap. This exact edit used to be REJECTED, and this test used to assert
    // the rejection: the persona rode inside the parameter, so the parameter's limit was the persona's
    // limit. It is not any more - the body is stored in S3 and the definition carries a pointer
    // (SPEC-PORTABLE-PROFILES, "Where it lives"), which is the whole point of the indirection.
    const persona = `E2E oversize persona. ${'x'.repeat(6000)}`;
    const edited = await api(idToken, '/draft', { profileName: PROFILE, patch: { persona } });

    expect(
      JSON.stringify(edited),
      'a persona between the parameter limit and the persona cap was refused. That is the '
      + 'pre-indirection behaviour: it means the body is still being stored inside the definition, '
      + 'so the parameter limit is silently acting as the persona limit again.',
    ).not.toMatch(/SSM Standard-tier limit/i);
    expect(edited.draftConfigId, `the edit did not land a draft: ${JSON.stringify(edited)}`).toBeTruthy();

    // And it is genuinely storable, not merely accepted: validate reads the draft back off the
    // parameter, so a body that could not be written could not be validated either.
    const validated = await api(idToken, '/validate', { profileName: PROFILE });
    expect(
      validated.valid,
      `the oversize-persona draft did not validate: ${JSON.stringify(validated)}`,
    ).toBe(true);
  });

  test('a persona over the persona CAP is still refused, with an actionable message', async () => {
    test.setTimeout(180_000);

    // The storage indirection removed the parameter's limit as the persona's ceiling; it did not
    // remove the ceiling. MAX_PERSONA_LENGTH (20000) still bounds what a version may carry, so an
    // import or edit cannot smuggle an unbounded prompt into a turn. Asserted on the EDIT because
    // that is where the operator's change is, and a bare 500 here would name neither field nor size.
    await api(idToken, '/version', { profileName: PROFILE });
    const edited = await api(idToken, '/draft', {
      profileName: PROFILE,
      patch: { persona: `E2E past the cap. ${'x'.repeat(21000)}` },
    });

    expect(
      JSON.stringify(edited),
      'a persona past MAX_PERSONA_LENGTH was accepted - the version cap is not being enforced on the '
      + 'write path, so an edit or an imported manifest can carry an unbounded system prompt.',
    ).toMatch(/persona must be at most/i);

    // The refused edit left the draft alone: it still holds a body that validates. Otherwise the
    // operator is left with a draft they cannot activate and no way to see why.
    const validated = await api(idToken, '/validate', { profileName: PROFILE });
    expect(
      validated.valid,
      `a refused edit must not corrupt the existing draft: ${JSON.stringify(validated)}`,
    ).toBe(true);
  });

  test.afterAll(async () => {
    // Reset the draft to a copy of the ACTIVE version, and verify by READ-BACK rather than trusting
    // the call. A rollback that swallowed its own errors is how a test persona was once left live on
    // this deployment. Nothing here ever activated, so the active version is untouched either way.
    if (!idToken) return;
    await api(idToken, '/version', { profileName: PROFILE });
    const check = await api(idToken, '/validate', { profileName: PROFILE });
    expect(
      check.valid,
      'CLEANUP FAILED - the standard profile still has an invalid draft. Nothing is active, but it '
      + 'will block the next legitimate activation.',
    ).toBe(true);
  });
});
