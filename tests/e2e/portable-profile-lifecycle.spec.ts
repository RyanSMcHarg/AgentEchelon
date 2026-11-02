/**
 * Portable profiles — the whole lifecycle, driven against the live manage-profiles API.
 *
 * WHAT WAS MISSING. The portable-profile story is "an assistant is a versioned, portable artifact:
 * set one up, improve it, export it, import it elsewhere, promote it, roll it back." Coverage
 * exercised almost none of that. `portable-profile-gates` drives three REFUSAL paths (an unpublished
 * context key, an oversize definition, and the list rendering); `profile-config` drives one
 * copy-edit-export flow but is gated behind PROFILE_CONFIG_E2E=1 so it does not run by default;
 * `admin-profiles` asserts the list loads. Nothing proved that ACTIVATE promotes, that ROLLBACK moves
 * the pointer back, or that an EXPORTED manifest can be IMPORTED - which is the "portable" claim
 * itself. Refusals are worth testing, but a suite made only of refusals never proves the feature
 * works, only that it says no.
 *
 * WHY IT IS SAFE TO RUN ON A LIVE DEPLOYMENT. Activation changes which assistant definition serves
 * traffic, so this suite never activates EDITED content. It activates a clone of whatever is already
 * active - byte-identical behavior, a new version number - proves the pointer moved, then rolls back
 * to the original version and verifies the pointer by READ-BACK. The draft-edit path is proven
 * separately without activating, the way the gates suite does it. If this file fails midway, the worst
 * state it can leave is an unactivated draft, which `afterAll` resets.
 *
 * Ordered, not independent: each stage consumes the previous stage's state, which is what a lifecycle
 * IS. Serial also keeps two tests from fighting over one profile's single draft.
 */
import { test, expect } from './helpers/fixtures';
import { execSync } from 'child_process';
import { assistantServing } from './helpers/assistant-identity';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getAdminUser, missingUserReason } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { SSM_ROOT } from './helpers/stack-prefix';
import { ADMIN_API_URL, adminUrl, profileActionUrl } from './helpers/api-urls';

guardConsoleErrors();

const MANAGE_PROFILES_API = ADMIN_API_URL ? adminUrl('assistant-admin', '/admin/profiles') : '';
/** Resolved in `beforeAll`, NOT at import. Playwright loads every spec during collection, before any
 *  skip condition runs, so resolving this at module scope made a machine without AWS credentials fail
 *  three specs at IMPORT - specs designed to skip - and charged every unrelated run for the lookup. */
let PROFILE = '';
const REGION = process.env.AWS_REGION || 'us-east-1';
/** Derived from PROFILE, so it is built where PROFILE is known rather than at import. */
function definitionParam(): string { return `${SSM_ROOT}/assistant/${PROFILE}/definition`; }

/**
 * Node-side SigV4 call to the IAM-enforced manage-profiles API (the browser cannot sign one).
 * Mirrors `portable-profile-gates`: a 4xx is a legitimate outcome for a refusal case, so the error is
 * returned as data rather than thrown.
 */
async function api(idToken: string, action: string, body: Record<string, unknown> = {}): Promise<any> {
  try {
    return await signedAnalyticsPost(profileActionUrl(action), idToken, body);
  } catch (err) {
    return { __error: String((err as Error).message || err) };
  }
}

/**
 * The ACTIVE version number, read from the source of truth.
 *
 * Not from the API: the list is a GET and `signedAnalyticsPost` only speaks POST, and an unpinned
 * `/export` reports `provenance.sourceVersion: 'active'` rather than a number (the type is
 * `number | 'active' | 'seed'`) - correct for a portable artifact, useless as a pointer assertion.
 * The pointer IS the `active` label on the SSM parameter version, so read that. Asserting the promote
 * and rollback against the label rather than against the mutation's own return value is the point:
 * a call that reported success while the pointer stayed put is exactly the failure worth catching.
 */
function activeVersionFromSsm(): number | null {
  const raw = execSync(
    `aws ssm get-parameter-history --region ${REGION} --name "${definitionParam()}" `
      + `--query "Parameters[?Labels!=null].{v:Version,labels:Labels}" --output json`,
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const rows = JSON.parse(raw) as Array<{ v: number; labels: string[] }>;
  const active = rows.filter((r) => (r.labels ?? []).includes('active')).map((r) => r.v);
  return active.length ? Math.max(...active) : null;
}

test.describe.serial('portable profiles — set up, improve, export, import, promote, roll back', () => {
  guardBackendErrors('portable-profile-lifecycle');

  test.skip(!MANAGE_PROFILES_API, 'VITE_ADMIN_API_URL must be set (run via validate.mjs)');

  let idToken = '';
  /** The version that was active before this suite touched anything — the rollback target. */
  let originalActiveVersion: number | null = null;
  /** The manifest exported from the original active version, reused by the import stage. */
  let exportedManifest: Record<string, unknown> | null = null;

  test.beforeAll(async ({ browser }) => {
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    // Resolved HERE, after the skip gates above: the lookup needs AWS credentials, and doing it at
    // import time would fail specs that are meant to skip without them.
    PROFILE = assistantServing('standard');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, admin.email, admin.password);
      idToken = await idTokenOf(page);
      expect(idToken, 'admin idToken').toBeTruthy();
    } finally {
      await ctx.close();
    }
  });

  test('EXPORT serializes the active version as an instance-agnostic manifest', async () => {
    test.setTimeout(120_000);
    const exported = await api(idToken, '/export', { profileName: PROFILE });
    expect(
      JSON.stringify(exported).slice(0, 300),
      'export failed; every later stage depends on this manifest',
    ).not.toMatch(/__error/);

    const manifest = exported.manifest;
    expect(manifest, 'export must return a manifest').toBeTruthy();
    expect(manifest.profileName, 'the manifest names its profile').toBe(PROFILE);
    expect(manifest.kind, 'the manifest declares what it is').toBe('assistant-profile');
    expect(typeof manifest.schemaVersion, 'the manifest is versioned by SCHEMA, so an older importer can refuse it')
      .not.toBe('undefined');
    // `sourceVersion` is `number | 'active' | 'seed'` — an unpinned export reports which POINTER it
    // followed rather than inventing a number, which is right for a portable artifact.
    expect(
      manifest.provenance?.sourceVersion,
      'the manifest records where it came from, under provenance',
    ).toBeDefined();
    expect(manifest.provenance?.sourceProfileName, 'provenance names the source profile').toBe(PROFILE);

    // INSTANCE-AGNOSTIC is the whole point of "portable": a manifest carrying this deployment's
    // account, region or ARNs could not land anywhere else. Assert on the serialized text so a nested
    // field cannot smuggle one through.
    const text = JSON.stringify(manifest);
    expect(text, 'a manifest carrying an account id is not portable').not.toMatch(/\b\d{12}\b/);
    expect(text, 'a manifest carrying an ARN is not portable').not.toMatch(/arn:aws:/);

    exportedManifest = manifest;
    originalActiveVersion = activeVersionFromSsm();
    expect(originalActiveVersion, 'a profile with no active version cannot be rolled back to').toBeTruthy();
    console.log(`--- exported ${PROFILE} v${originalActiveVersion} ---`);
  });

  test('IMPORT lands a manifest as a DRAFT, never as the active version', async () => {
    test.setTimeout(120_000);
    expect(exportedManifest, 'needs the exported manifest').toBeTruthy();

    // The target is named, as every import must: the manifest's own name never decides where it lands.
    const imported = await api(idToken, '/import', { manifest: exportedManifest, targetProfileName: PROFILE });
    expect(JSON.stringify(imported), 'import rejected the manifest this deployment just exported')
      .not.toMatch(/__error/);
    expect(imported.imported, 'import names the profile it landed').toBe(PROFILE);
    // The safety property: importing must NEVER silently change what serves traffic.
    expect(imported.landedAs, 'an import that activated itself would swap the live assistant').toBe('draft');

    expect(
      activeVersionFromSsm(),
      'the active version moved during an import; import must land a draft only',
    ).toBe(originalActiveVersion);
  });

  test('a draft EDIT persists and validates (improving a profile)', async () => {
    test.setTimeout(180_000);
    // Fresh draft from the active version, then a small, legal edit.
    const versioned = await api(idToken, '/version', { profileName: PROFILE });
    expect(JSON.stringify(versioned)).not.toMatch(/__error/);
    expect(versioned.draftConfigId, 'the fresh draft names its configId').toBeTruthy();

    // THE EDIT IS PROVEN KEPT BY THE DRAFT'S OWN ID. `configId` hashes what a version says, so a kept
    // edit to a body key changes it, and a key the body does not hold (`description`) leaves it as it was:
    // a patch the API dropped would pass every other check here.
    const ignored = await api(idToken, '/draft', { profileName: PROFILE, patch: { description: `ignored ${Date.now()}` } });
    expect(ignored.draftConfigId, 'a key that is not part of a version changes nothing').toBe(versioned.draftConfigId);

    // The persona addendum is a short, free-text body key, so a unique marker is always a change. (What the assistant
    // says is its message templates, ADR-062: a `copy` line is refused at the draft, so it cannot be the probe.)
    const marker = `E2E lifecycle probe ${Date.now()}`;
    const edited = await api(idToken, '/draft', {
      profileName: PROFILE,
      patch: { systemPromptAddendum: marker },
    });
    // A refusal arrives either as a transport error or as a 4xx body naming its `error`.
    expect(JSON.stringify(edited), 'the draft edit was refused').not.toMatch(/__error/);
    expect(edited.error, 'the draft edit was refused').toBeUndefined();
    expect(edited.draftConfigId, 'a kept edit gives the draft a new configId').toBeTruthy();
    expect(edited.draftConfigId).not.toBe(versioned.draftConfigId);

    const validated = await api(idToken, '/validate', { profileName: PROFILE });
    expect(
      validated.valid,
      `a legal draft edit did not validate: ${JSON.stringify(validated.errors ?? []).slice(0, 300)}`,
    ).toBe(true);
  });

  test('ACTIVATE promotes a version, and ROLLBACK puts the pointer back', async () => {
    test.setTimeout(240_000);
    expect(originalActiveVersion, 'needs the original active version').toBeTruthy();

    // Activate a CLONE of the active definition, not the edited draft above: this proves the pointer
    // moves without changing a single byte of what the assistant says. `/version` re-clones active,
    // discarding the probe edit.
    await api(idToken, '/version', { profileName: PROFILE });
    const activated = await api(idToken, '/activate', { profileName: PROFILE });
    expect(JSON.stringify(activated), 'activation was refused for a clone of the active version')
      .not.toMatch(/__error/);
    expect(typeof activated.version, 'activate reports the new version number').toBe('number');
    expect(
      activated.version,
      'activate did not produce a NEW version; the pointer never moved',
    ).toBeGreaterThan(originalActiveVersion!);

    expect(activeVersionFromSsm(), 'the active pointer did not follow the activation')
      .toBe(activated.version);

    // ROLLBACK — the operation with no coverage at all until now, and the one an operator reaches for
    // when a promotion misbehaves. Asserted by READ-BACK, not by the call's own return.
    const rolled = await api(idToken, '/rollback', {
      profileName: PROFILE,
      version: originalActiveVersion,
    });
    expect(JSON.stringify(rolled), 'rollback was refused').not.toMatch(/__error/);

    expect(
      activeVersionFromSsm(),
      'ROLLBACK DID NOT RESTORE THE ORIGINAL VERSION. This deployment is now serving a version this '
      + 'test promoted. Roll it back by hand.',
    ).toBe(originalActiveVersion);
    console.log(`--- ${PROFILE} restored to v${originalActiveVersion} ---`);
  });

  test.afterAll(async () => {
    // Leave the draft as a clean copy of active, and verify by read-back — the same discipline the
    // gates suite uses, for the same reason: a cleanup that swallowed its own error is how a test
    // definition gets left behind where a later legitimate activation trips over it.
    if (!idToken) return;
    await api(idToken, '/version', { profileName: PROFILE });
    const check = await api(idToken, '/validate', { profileName: PROFILE });
    expect(
      check.valid,
      'CLEANUP FAILED - the standard profile has an invalid draft. Nothing this suite activated is '
      + 'still active, but the draft will block the next legitimate activation.',
    ).toBe(true);

    if (originalActiveVersion !== null) {
      expect(
        activeVersionFromSsm(),
        'CLEANUP CHECK - the active version is not the one this suite started from.',
      ).toBe(originalActiveVersion);
    }
  });
});
