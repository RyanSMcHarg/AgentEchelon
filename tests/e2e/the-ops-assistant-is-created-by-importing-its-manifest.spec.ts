/**
 * THE OPS ASSISTANT IS CREATED BY IMPORTING ITS SHIPPED MANIFEST (SPEC-PORTABLE-PROFILES FR14, ADR-048).
 *
 * Creating the ops assistant (`ops-premium`, the premium classification's `ops` role) is `npm run add-assistant-role --
 * ops-premium`, which deploys the role, seeds the assistant's identity and, as its last step, imports its first version
 * from the manifest `demo/portable-assistants/ops-assistant-manifest.ts` builds. This drives the same import calls
 * through the deployed profile API, signed as an administrator: the manifest lands as a draft (never active), validates,
 * activates by the configId the import answered with, and the active version then says what the manifest says, field by
 * field. Its export carries the same body and the same contentHash, so the version round-trips, and the stored version
 * keeps its persona and pack in this deployment's own body store, under its own configId.
 *
 * It activates a version of a deployed assistant, so it runs only when named: `OPS_IMPORT_E2E=1` (validate.mjs
 * --only=ops-role). When the assistant had an active version before, the spec rolls back to it afterwards; when it had
 * none, the imported version stays active, which is the state `npm run add-assistant-role -- ops-premium` leaves.
 *
 * **Coverage:** `e2e/the-ops-assistant-is-created-by-importing-its-manifest.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { signIn, idTokenOf } from './helpers/agent-helpers';
import { getAdminUser, missingUserReason } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { SSM_ROOT } from './helpers/stack-prefix';
import { ADMIN_API_URL, profileActionUrl } from './helpers/api-urls';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';
import { aws, awsOrNull } from './helpers/aws';
import { opsAssistantManifest, OPS_ASSISTANT } from '../../demo/portable-assistants/ops-assistant-manifest';

// It signs in through the console to read the administrator's token, so the console guard watches that page.
guardConsoleErrors();

const RUN = process.env.OPS_IMPORT_E2E === '1';
const REGION = process.env.AWS_REGION || 'us-east-1';
const DEFINITION = `${SSM_ROOT}/assistant/${OPS_ASSISTANT}/definition`;

/** A signed call to the profile API. A refusal is answered as data (its `error` and `code`), so each step can read it. */
async function api(idToken: string, action: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await signedAnalyticsPost(profileActionUrl(action), idToken, body);
  } catch (err) {
    return { __error: String((err as Error).message || err) };
  }
}

/** The version the `active` label is on, read from the parameter itself rather than from an API's own answer. */
function activeVersion(): number | null {
  const rows = awsOrNull(`ssm get-parameter-history --name "${DEFINITION}" --query "Parameters[?Labels!=null].{v:Version,labels:Labels}"`) as Array<{ v: number; labels: string[] }> | null;
  const active = (rows ?? []).filter((r) => (r.labels ?? []).includes('active')).map((r) => r.v);
  return active.length ? Math.max(...active) : null;
}

/** The stored active definition, as SSM holds it: bodies as pointers into this deployment's store. */
function storedActive(): Record<string, any> {
  return JSON.parse(aws<string>(`ssm get-parameter --name "${DEFINITION}:active" --query Parameter.Value`));
}

test.describe.serial('the ops assistant is created by importing its manifest', () => {
  guardBackendErrors('ops-assistant-import');

  const manifest = opsAssistantManifest();
  let idToken = '';
  /** The version active before this spec, the rollback target; null when the assistant had none. */
  let before: number | null = null;
  let activated = false;

  test.beforeAll(async ({ browser }) => {
    test.skip(!RUN, "activates a version of the deployed ops assistant; set OPS_IMPORT_E2E=1 to run it (validate.mjs --only=ops-role)");
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL must be set (run via validate.mjs)');
    const opsLive = awsOrNull(`ssm get-parameter --name ${SSM_ROOT}/assistant-assignments/premium/ops/assistants/${OPS_ASSISTANT} --query Parameter.Value`);
    test.skip(!opsLive, 'premium has no ops assistant on this deployment; declare it with npm run add-assistant-role (ops-premium in profiles)');
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signIn(page, admin.email, admin.password);
      idToken = await idTokenOf(page);
      expect(idToken, 'admin idToken').toBeTruthy();
    } finally {
      await ctx.close();
    }
    before = activeVersion();
  });

  test('the manifest lands as a draft, validates, and activates', async () => {
    test.setTimeout(180_000);
    const text = JSON.stringify(manifest);
    expect(text, 'the shipped manifest carries an ARN').not.toMatch(/arn:aws:/);
    expect(text, `the shipped manifest names this deployment's region`).not.toContain(REGION);

    const imported = await replacingDraft((b) => api(idToken, '/import', b), { manifest, targetProfileName: OPS_ASSISTANT });
    expect(imported.error, `the import was refused: ${JSON.stringify(imported).slice(0, 600)}`).toBeUndefined();
    expect(imported.__error).toBeUndefined();
    expect(imported.imported, 'the import names the assistant it landed on').toBe(OPS_ASSISTANT);
    expect(imported.landedAs, 'an import that activated itself would change what serves').toBe('draft');
    expect(activeVersion(), 'the active version moved during the import').toBe(before);

    const validated = await api(idToken, '/validate', { profileName: OPS_ASSISTANT });
    expect(validated.valid, `the imported draft did not validate: ${JSON.stringify(validated.errors ?? validated).slice(0, 600)}`).toBe(true);
    expect(validated.configId, 'validation read the draft the import landed').toBe(draftIdOf(imported));

    const done = await api(idToken, '/activate', { profileName: OPS_ASSISTANT, configId: draftIdOf(imported) });
    expect(done.error, `the activation was refused: ${JSON.stringify(done).slice(0, 600)}`).toBeUndefined();
    expect(typeof done.version, 'the activation names the version it made').toBe('number');
    activated = true;
    expect(activeVersion(), 'the active label is not on the version the activation made').toBe(done.version);
  });

  test('the active version says what the manifest says, and its export round-trips', async () => {
    test.setTimeout(120_000);
    expect(activated, 'needs the activation above').toBe(true);
    const exported = (await api(idToken, '/export', { profileName: OPS_ASSISTANT })).manifest;
    expect(exported, 'the export returned no manifest').toBeTruthy();
    expect(exported.provenance?.sourceVersion, 'the export read the active version').toBe('active');
    const body = exported.body;
    expect(body.persona, 'the persona').toBe(manifest.body.persona);
    expect(body.intentPack, 'the intent pack').toEqual(manifest.body.intentPack);
    expect(body.tools, 'the tools').toEqual(manifest.body.tools);
    expect(body.boundary, 'the boundary').toBe(manifest.body.boundary);
    expect(body.eventWorkflows, 'the welcome workflows').toEqual(manifest.body.eventWorkflows);
    expect(body, 'the whole body').toEqual(manifest.body);
    expect(exported.contentHash, 'the export hashes the body the manifest hashes').toBe(manifest.contentHash);

    // STORED IN THIS DEPLOYMENT'S OWN BODY STORE: the manifest carried the persona and pack inline, and the version
    // keeps pointers under its own configId, never a location the manifest could have named.
    const stored = storedActive();
    for (const field of ['persona', 'intentPack'] as const) {
      const ref = stored[`${field}Ref`];
      if (!ref) {
        expect(stored[field], `the stored version holds neither a ${field} nor a pointer to one`).toBeTruthy();
        continue;
      }
      expect(ref.key, `the ${field} pointer names this assistant and this version`).toBe(`profiles/${OPS_ASSISTANT}/${stored.configId}/${field}`);
    }
  });

  test.afterAll(async () => {
    if (!idToken || !activated || before === null) return;
    // The assistant had a version before this spec: it is put back, and checked by read-back.
    const rolled = await api(idToken, '/rollback', { profileName: OPS_ASSISTANT, version: before });
    expect(rolled.error, `the rollback to v${before} was refused; roll it back by hand`).toBeUndefined();
    expect(activeVersion(), `${OPS_ASSISTANT} is not back on v${before}; roll it back by hand`).toBe(before);
  });
});
