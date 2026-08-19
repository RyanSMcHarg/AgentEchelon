/**
 * Profile configuration lifecycle e2e (SPEC-CONFIGURABLE-ASSISTANTS).
 *
 * Proves the FULL config lifecycle end to end against a live deployment: COPY an existing profile
 * (clone the active version to a draft), EDIT it (select a guardrail + set per-assistant task machines
 * + a versioned persona), ACTIVATE it, and validate the configuration TAKES EFFECT at runtime; then
 * round-trip it through EXPORT → UPLOAD (import) and confirm the new axes survive.
 *
 * Two live runtime levers are asserted in a single turn:
 *   - guardrail SELECTION (4.6): the deployment provisions a 'strict' alternate guardrail that adds one
 *     blocked term ('confidential-alpha'); a profile that selects it has that term MASKED in its replies.
 *   - versioned PERSONA: the edited persona instructs the assistant to prefix a signature token; its
 *     presence proves the profile's persona - not the seeded SSM default - is the live system prompt.
 * Task-machine + model config are asserted on the persisted version + manifest (deterministic).
 *
 * Gated by PROFILE_CONFIG_E2E=1 (a validate.mjs phase). Needs the admin manage-profiles API
 * (VITE_MANAGE_PROFILES_API_URL, SigV4/IAM-enforced), the SigV4 pool vars, AWS creds, and a
 * battle/config-enabled deploy of feat/configurable-assistants. Mutates the 'standard' profile and
 * rolls it back in the finally.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUN = process.env.PROFILE_CONFIG_E2E === '1';

const MANAGE_PROFILES_API = process.env.VITE_MANAGE_PROFILES_API_URL || '';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
const PROFILE = 'standard';

/**
 * The version the `active` label points at — the deployment's real rollback target.
 *
 * This test mutates the SHARED 'standard' profile, whose persona is the system prompt for every
 * standard user on the deployment. Restoring it therefore has to put back what was there, and only
 * the version pointer can do that: blanking the fields instead (`persona: ''`) assumes the profile
 * started empty, and this deployment's did not - it carries a seeded persona. A "successful"
 * blanking rollback would have left standard replies ungrounded rather than wrong, which is quieter
 * and no better.
 */
function activeVersionFromSsm(): number | null {
  const raw = execSync(
    `aws ssm get-parameter-history --region ${REGION} --name "${SSM_ROOT}/assistant/${PROFILE}/definition" `
      + `--query "Parameters[?Labels!=null].{v:Version,labels:Labels}" --output json`,
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, AWS_PROFILE, MSYS_NO_PATHCONV: '1' } },
  );
  const rows = JSON.parse(raw) as Array<{ v: number; labels: string[] }>;
  const active = rows.filter((r) => (r.labels ?? []).includes('active')).map((r) => r.v);
  return active.length ? Math.max(...active) : null;
}
const BLOCKED_TERM = 'confidential-alpha'; // the extra word the 'strict' catalog guardrail blocks
// A distinctive first-line token the versioned PERSONA instructs the assistant to emit. The base
// (SSM assistant-system-prompt) persona never mentions it, so its presence proves the profile's
// versioned persona - not the seeded default - is the system prompt in effect (resolveActiveProfile
// .persona takes precedence over resolveBaseSystemPrompt in the async processor).
const PERSONA_SIGNATURE = 'AE-PERSONA-OK';
const PERSONA = `You are the Standard assistant for this deployment. Formatting rule you must ALWAYS follow, without exception: begin EVERY reply with the exact token ${PERSONA_SIGNATURE} on the first line, then a blank line, then your answer.`;

/** The selectable guardrails a classification publishes (guardrail-catalog / assistant-profile-stack). */
function readGuardrailCatalog(classification: string): Array<{ key: string; name: string; guardrailId: string; guardrailVersion: string }> {
  const name = `${SSM_ROOT}/assistant/${classification}/guardrails`;
  const out = execSync(`aws ssm get-parameter --name "${name}" --region ${REGION} --query "Parameter.Value" --output text`, {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, AWS_PROFILE },
  }).trim();
  return JSON.parse(out);
}

/**
 * A custom task machine that is DISTINCT from the deployment default report_generation (extra state).
 *
 * DELIBERATELY AUTHORED IN THE DEPRECATED WAIT FORM (`awaitsUser`), and it stays that way. This is the
 * only place the copy -> edit -> validate -> activate -> export -> import path is exercised against a
 * live deployment, and the promise the platform makes is that a machine stored before
 * `awaits: { party: 'requester' }` existed keeps working through every one of those steps
 * (SPEC-TASK-STATE-TRANSITIONS §12.6). A fixture moved to the declared form would assert the new
 * spelling twice over and leave the compatibility promise untested where it matters most: on real
 * stored configuration rather than in a unit fixture. The declared form is covered end to end by the
 * shipped machines this profile overrides.
 */
const CUSTOM_MACHINES = {
  report_generation: {
    initial: 'collecting_requirements',
    states: {
      collecting_requirements: { transitions: ['drafting_outline'], awaitsUser: true },
      drafting_outline: { transitions: ['legal_review'] }, // <- extra state the default lacks
      legal_review: { transitions: ['generating'] },
      generating: { transitions: ['completed'] },
      completed: { transitions: [], terminal: 'success' },
    },
  },
};

test.describe('profile configuration takes effect (copy → edit → activate → upload)', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('profile-config');

  test.skip(!RUN, 'set PROFILE_CONFIG_E2E=1 (needs a config-enabled deploy + admin manage-profiles API)');
  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(MANAGE_PROFILES_API, 'VITE_MANAGE_PROFILES_API_URL must be set').toBeTruthy();
  });

  test('a copied+edited profile applies its selected guardrail and persists its machines through export/import', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    const idToken = (await page.evaluate(() => localStorage.getItem('idToken')))!;
    expect(idToken, 'admin idToken').toBeTruthy();
    const post = (action: string, body: unknown) => signedAnalyticsPost(`${MANAGE_PROFILES_API}${action}`, idToken, body);

    const strict = readGuardrailCatalog(PROFILE).find((g) => g.key === 'strict');
    expect(strict?.guardrailId, "the 'strict' guardrail must be provisioned (4.6b)").toBeTruthy();

    // The rollback target, captured BEFORE anything is mutated.
    const originalActiveVersion = activeVersionFromSsm();
    expect(originalActiveVersion, 'a profile with no active version cannot be restored afterwards').toBeTruthy();

    // COPY: clone the active version into a fresh draft.
    const copied = await post('/version', { profileName: PROFILE });
    expect(copied.draftConfigId, `copy (clone active→draft): ${JSON.stringify(copied)}`).toBeTruthy();

    try {
      // EDIT the draft: select the strict guardrail + set the custom task machines + a versioned persona.
      const edited = await post('/draft', { profileName: PROFILE, patch: { guardrailId: strict!.guardrailId, machines: CUSTOM_MACHINES, persona: PERSONA } });
      expect(edited.draftConfigId, `edit draft: ${JSON.stringify(edited)}`).toBeTruthy();

      // VALIDATE — schema + graph + §7 model boundary all pass.
      const validated = await post('/validate', { profileName: PROFILE });
      expect(validated.valid, `validate: ${JSON.stringify(validated.errors)}`).toBe(true);

      // ACTIVATE — promote the draft to a new active version.
      const activated = await post('/activate', { profileName: PROFILE });
      expect(activated.version, `activate: ${JSON.stringify(activated)}`).toBeTruthy();

      // EXPORT — the new axes must survive the instance-agnostic manifest (proves copy/edit/UPLOAD carry them).
      // The route wraps it: { manifest: { schemaVersion, profileName, body, contentHash, ... } }.
      const exported = await post('/export', { profileName: PROFILE });
      const manifest = exported.manifest;
      // The manifest must carry the guardrail's PORTABLE SELECTION KEY ('strict'), not the id this
      // instance resolved it to. That is the specified behaviour (SPEC-PORTABLE-PROFILES "Export":
      // "a guardrail by its catalog selection key ... rather than the id resolved on the authoring
      // instance"), implemented by `toPortableGuardrail` (lib/profile-manifest.ts:149), and it is the
      // point of the feature: a resolved id names nothing on any other instance, so a manifest
      // carrying one cannot be imported anywhere else.
      //
      // This previously asserted the resolved id and so failed against correct code. Had it been
      // "fixed" on the code side it would have silently broken cross-instance portability.
      expect(
        manifest?.body?.guardrailId,
        `manifest carries the PORTABLE guardrail key, not this instance's resolved id: ${JSON.stringify(exported)}`,
      ).toBe('strict');
      expect(Object.keys(manifest.body?.machines ?? {}), 'manifest carries the per-assistant machines').toContain('report_generation');
      expect(manifest.body.machines.report_generation.states.legal_review, 'the custom extra state survives export').toBeTruthy();
      expect(manifest.body?.persona, 'manifest carries the versioned persona (persona is part of the versioned bundle)').toBe(PERSONA);

      // UPLOAD (import) the raw manifest back as a draft, then activate — a full round-trip of the config.
      const imported = await post('/import', { manifest, targetProfileName: PROFILE });
      expect(imported.configId, `import: ${JSON.stringify(imported)}`).toBeTruthy();
      const reValidated = await post('/validate', { profileName: PROFILE });
      expect(reValidated.valid, `re-validate imported: ${JSON.stringify(reValidated.errors)}`).toBe(true);
      await post('/activate', { profileName: PROFILE });

      // TAKES EFFECT (live): the resolver caches the active version for ~30s; wait it out, then drive a
      // standard conversation. The two runtime axes need SEPARATE turns — a guardrail-blocked turn
      // short-circuits the model before the persona can shape a reply, so they cannot share one turn:
      await page.waitForTimeout(35_000);
      await createConversation(page, `Profile config e2e ${Date.now()}`, 'Standard');

      // Turn 1 — versioned PERSONA is the live system prompt: a normal (non-blocked) prompt comes back
      // with the persona-injected signature token, which the seeded default persona never emits.
      const personaResp = await sendAndWaitForResponse(page, 'In one short sentence, what is a feature flag?', 120_000);
      expect(personaResp.text && personaResp.text.length, 'the assistant replied to the persona turn').toBeTruthy();
      expect(personaResp.text, `the versioned persona must take effect: reply carries the persona signature "${PERSONA_SIGNATURE}" (got: ${personaResp.text})`).toContain(PERSONA_SIGNATURE);

      // Turn 2 — the SELECTED strict guardrail is applied: a prompt naming the blocked term never
      // returns that term (the guardrail blocks the turn / masks the reply); the default profile would not.
      const guardResp = await sendAndWaitForResponse(page, `Please write one short sentence that uses the word ${BLOCKED_TERM}.`, 120_000);
      expect(guardResp.text && guardResp.text.length, 'the assistant replied to the guardrail turn').toBeTruthy();
      expect(guardResp.text.toLowerCase(), `the selected strict guardrail must keep "${BLOCKED_TERM}" out of the reply (got: ${guardResp.text})`).not.toContain(BLOCKED_TERM);
    } finally {
      // Roll back: clone the active + activate with the guardrail/machines/persona cleared, restoring
      // default behavior (empty persona falls back to the seeded SSM assistant-system-prompt).
      //
      // Every call here used to end in `.catch(() => {})`. That is not a rollback, it is a rollback
      // ATTEMPT: if any step failed the test still passed and the deployment kept the test persona -
      // a bare "begin every reply with AE-PERSONA-OK" instruction that REPLACES the real Stratum
      // system prompt for every standard user, not just for this test. It was found live, long after
      // the run that leaked it, by noticing the token on the front of unrelated e2e replies.
      //
      // So: still swallow per-call errors (a failed rollback step must not mask a real test failure
      // from the body above), but VERIFY the end state and fail loudly if the persona survived.
      // Better a red test than a deployment quietly serving a test artifact.
      const rollbackErrors: string[] = [];
      const attempt = async (action: string, body: unknown) => {
        try {
          return await post(action, body);
        } catch (err) {
          rollbackErrors.push(`${action}: ${(err as Error).message}`);
          return null;
        }
      };
      // RESTORE by moving the active pointer back, which is the product's own rollback. The previous
      // teardown drafted empty fields and activated that instead, which failed twice over: `/draft`
      // did not clear the persona (so the test artifact stayed live), and had it worked it would have
      // stripped this deployment's SEEDED persona rather than restoring it.
      await attempt('/rollback', { profileName: PROFILE, version: originalActiveVersion });

      // Read back through the `active` LABEL - the pointer the async processor resolves. Reading the
      // bare parameter returns the LATEST version, which after this test is the test's own, so the
      // old check could report a leak that rollback had already fixed (and vice versa).
      let activePersona = '';
      let restoredVersion: number | null = null;
      try {
        restoredVersion = activeVersionFromSsm();
        const raw = execSync(
          `aws ssm get-parameter --name "${SSM_ROOT}/assistant/${PROFILE}/definition:active" `
            + `--region ${REGION} --query "Parameter.Value" --output text`,
          { encoding: 'utf8', timeout: 20000, env: { ...process.env, AWS_PROFILE, MSYS_NO_PATHCONV: '1' } },
        ).trim();
        activePersona = JSON.parse(raw).persona || '';
      } catch (err) {
        rollbackErrors.push(`read-back: ${(err as Error).message}`);
      }

      // The pointer is back where it started...
      expect(
        restoredVersion,
        `ROLLBACK FAILED - the '${PROFILE}' active pointer is v${restoredVersion}, not the v${originalActiveVersion} `
          + 'this test started from. The deployment is serving a version this test created. '
          + `Errors: ${rollbackErrors.join(' | ') || '(none reported)'}`,
      ).toBe(originalActiveVersion);

      // ...and specifically, the test's persona is not what standard users are being answered with.
      // Asserted on the SIGNATURE rather than on emptiness: the correct end state is whatever persona
      // the deployment had, which is usually NOT empty.
      expect(
        activePersona.includes(PERSONA_SIGNATURE),
        `ROLLBACK FAILED - the '${PROFILE}' profile is still carrying THIS TEST'S persona. Every reply at `
          + 'the standard classification on this deployment will use it until it is cleared. '
          + `Errors: ${rollbackErrors.join(' | ') || '(none reported)'}. Persona left behind: ${activePersona}`,
      ).toBe(false);
    }
  });
});
