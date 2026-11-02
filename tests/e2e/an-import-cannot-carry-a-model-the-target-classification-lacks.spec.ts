/**
 * THE CROSS-CLASSIFICATION IMPORT, WHICH IS THE ONE DIRECTION PORTABILITY EXISTS FOR.
 *
 * ADR-054 Appendix A says an assistant team reuses an assistant in a second classification by
 * exporting the manifest and importing it there, and that the target's own catalogs refuse anything
 * the target cannot reach. `portable-profile-lifecycle.spec.ts` round-trips an export back into the
 * SAME profile, which proves the format and proves nothing about the boundary: a same-profile import
 * cannot carry a model the target lacks, because the target IS the source. The claim that carries the
 * weight had unit coverage over the manifest and no live coverage at all.
 *
 * ── THE TWO CASES, AND WHY BOTH ARE NEEDED ──────────────────────────────────────────────────────
 *
 * REFUSE DOWNWARD: the premium assistant's definition names a premium-only model. Imported onto the
 * standard assistant it must be REJECTED, naming the model, because standard's processor role is
 * denied that model by IAM (`a-classification-is-denied-a-model-it-does-not-declare.spec.ts` proves
 * the denial against AWS). An import that landed it would land a draft that cannot run: activate it
 * and every turn degrades on an AccessDenied the operator did not ask for.
 *
 * ACCEPT SIDEWAYS: the basic assistant's definition names a model standard also declares. Imported
 * onto the standard assistant it must LAND, as a draft. Without this case the refusal above is
 * satisfied by an importer that refuses every cross-classification import, which would break the
 * feature while passing the test.
 *
 * ── WHAT IT ASSERTS BEYOND THE VERDICT ──────────────────────────────────────────────────────────
 *
 * That the target's ACTIVE pointer does not move in either case. A refusal that nonetheless wrote,
 * or an acceptance that activated itself, are the two ways this could be unsafe on a live deployment,
 * and neither is visible in the response body.
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
const REGION = process.env.AWS_REGION || 'us-east-1';

async function api(idToken: string, action: string, body: Record<string, unknown> = {}): Promise<any> {
  try {
    return await signedAnalyticsPost(profileActionUrl(action), idToken, body);
  } catch (err) {
    return { __error: String((err as Error).message || err) };
  }
}

/** The `active` label's version for one profile, read from the parameter rather than from a response. */
function activeVersionOf(profile: string): number | null {
  const raw = execSync(
    `aws ssm get-parameter-history --region ${REGION} --name "${SSM_ROOT}/assistant/${profile}/definition" `
      + `--query "Parameters[?Labels!=null].{v:Version,labels:Labels}" --output json`,
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const rows = JSON.parse(raw) as Array<{ v: number; labels: string[] }>;
  const active = rows.filter((r) => (r.labels ?? []).includes('active')).map((r) => r.v);
  return active.length ? Math.max(...active) : null;
}

test.describe.serial('an import cannot carry a model the target classification lacks (ADR-054)', () => {
  guardBackendErrors('an-import-cannot-carry-a-model-the-target-classification-lacks');

  test.skip(!MANAGE_PROFILES_API, 'VITE_ADMIN_API_URL must be set (run via validate.mjs)');

  let idToken = '';
  let PREMIUM = '';
  let STANDARD = '';
  let BASIC = '';
  let targetActiveBefore: number | null = null;

  test.beforeAll(async ({ browser }) => {
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    // Resolved after the skip gates: the lookup needs AWS credentials.
    PREMIUM = assistantServing('premium');
    STANDARD = assistantServing('standard');
    BASIC = assistantServing('basic');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, admin.email, admin.password);
      idToken = await idTokenOf(page);
      expect(idToken, 'admin idToken').toBeTruthy();
    } finally {
      await ctx.close();
    }
    targetActiveBefore = activeVersionOf(STANDARD);
    console.log(`--- source ${PREMIUM} / ${BASIC}, target ${STANDARD} (active v${targetActiveBefore}) ---`);
  });

  test('a premium definition is REFUSED onto the standard assistant, naming the model', async () => {
    test.setTimeout(180_000);

    const exported = await api(idToken, '/export', { profileName: PREMIUM });
    expect(JSON.stringify(exported).slice(0, 300), 'export of the premium profile failed').not.toMatch(/__error/);
    const manifest = exported.manifest;
    expect(manifest, 'export must return a manifest').toBeTruthy();

    // THE PREMISE, ASSERTED RATHER THAN ASSUMED. If the premium definition does not actually name a
    // model standard lacks, the refusal below would be testing nothing - and the manifest's model can
    // be the `'default'` sentinel, which is legal on any target by design. Fail loudly instead of
    // passing an empty test.
    const named = [manifest.body?.modelKey, manifest.body?.models?.default].filter(Boolean);
    expect(
      named.some((m: string) => m && m !== 'default'),
      `the ${PREMIUM} manifest pins no concrete model (${JSON.stringify(named)}), so an import of it `
      + 'cannot exercise the target model check and this test proves nothing',
    ).toBe(true);

    const imported = await api(idToken, '/import', { manifest, targetProfileName: STANDARD });
    const text = JSON.stringify(imported);

    expect(
      text,
      `importing ${PREMIUM} onto ${STANDARD} was ACCEPTED. The landed draft names a model the `
      + `standard processor role is DENIED by IAM, so activating it degrades every turn on an `
      + 'AccessDenied. Import is specified to reject or remap, never to widen. Response: ' + text,
    ).toMatch(/__error|error/);
    expect(
      text,
      'the refusal does not name the model, so an operator cannot tell what to remap. Response: ' + text,
    ).toMatch(/model|catalog|allowlist/i);

    expect(
      activeVersionOf(STANDARD),
      'the target active pointer moved during a REFUSED import',
    ).toBe(targetActiveBefore);
  });

  test('a basic definition LANDS onto the standard assistant, as a draft', async () => {
    test.setTimeout(180_000);

    const exported = await api(idToken, '/export', { profileName: BASIC });
    expect(JSON.stringify(exported).slice(0, 300), 'export of the basic profile failed').not.toMatch(/__error/);
    const manifest = exported.manifest;
    expect(manifest, 'export must return a manifest').toBeTruthy();

    const imported = await api(idToken, '/import', { manifest, targetProfileName: STANDARD });
    expect(
      JSON.stringify(imported),
      `importing ${BASIC} onto ${STANDARD} was refused. Every model it names is one standard also `
      + 'declares, so a refusal here means the importer rejects cross-classification imports wholesale '
      + 'and the refusal in the previous test is not about the model at all.',
    ).not.toMatch(/__error/);
    expect(imported.imported, 'the import binds to the TARGET profile, not the source').toBe(STANDARD);
    expect(imported.landedAs, 'an import that activated itself would swap the live assistant').toBe('draft');

    expect(
      activeVersionOf(STANDARD),
      'the target active pointer moved during an import; import must land a draft only',
    ).toBe(targetActiveBefore);
  });

  test.afterAll(async () => {
    // Leave the target's draft as a clean copy of its own active version, so a later legitimate
    // activation does not promote the basic definition this suite landed. Verified by read-back for
    // the reason the lifecycle suite gives: a cleanup that swallowed its error leaves the trap.
    if (!idToken || !STANDARD) return;
    const reset = await api(idToken, '/version', { profileName: STANDARD });
    expect(JSON.stringify(reset), `failed to reset ${STANDARD}'s draft to a copy of active`).not.toMatch(/__error/);
    expect(activeVersionOf(STANDARD), 'cleanup moved the active pointer').toBe(targetActiveBefore);
  });
});
