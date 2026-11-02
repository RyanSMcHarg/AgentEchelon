/**
 * Profile configuration lifecycle e2e (SPEC-CONFIGURABLE-ASSISTANTS).
 *
 * Proves the FULL config lifecycle end to end against a live deployment: COPY an existing profile
 * (clone the active version to a draft), EDIT it (select a guardrail + set a versioned persona
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
 * (VITE_ADMIN_API_URL, SigV4/IAM-enforced), the SigV4 pool vars, AWS creds, and a
 * battle/config-enabled deploy of feat/configurable-assistants. Mutates the 'standard' profile and
 * rolls it back in the finally.
 */
import { test, expect } from './helpers/fixtures';
import { assistantServing } from './helpers/assistant-identity';
import { execSync } from 'node:child_process';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { SSM_ROOT } from './helpers/stack-prefix';
import { ADMIN_API_URL, adminUrl, profileActionUrl } from './helpers/api-urls';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUN = process.env.PROFILE_CONFIG_E2E === '1';

const MANAGE_PROFILES_API = ADMIN_API_URL ? adminUrl('assistant-admin', '/admin/profiles') : '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_PROFILE = process.env.AWS_PROFILE || 'default';
/** Resolved in `beforeAll`, NOT at import. Playwright loads every spec during collection, before any
 *  skip condition runs, so resolving this at module scope made a machine without AWS credentials fail
 *  three specs at IMPORT - specs designed to skip - and charged every unrelated run for the lookup. */
let PROFILE = '';

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

// SERIAL, because the second test reads the end state the first one's teardown produces. The rollback
// happens in that test's `finally`, so "the persona is gone again" is only a question once it has run -
// and if the apply never took effect there is nothing to prove reverted, so stopping is correct.
test.describe.serial('profile configuration takes effect (copy → edit → activate → upload)', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('profile-config');

  test.skip(!RUN, 'set PROFILE_CONFIG_E2E=1 (needs a config-enabled deploy + admin manage-profiles API)');
  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(MANAGE_PROFILES_API, 'VITE_ADMIN_API_URL must be set').toBeTruthy();
    // Resolved HERE, after the skip gates above: the lookup needs AWS credentials, and doing it at
    // import time would fail specs that are meant to skip without them.
    PROFILE = assistantServing('standard');

  });

  test('a copied+edited profile applies its selected guardrail and persona through export/import', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    const idToken = await idTokenOf(page);
    expect(idToken, 'admin idToken').toBeTruthy();
    const post = (action: string, body: unknown) => signedAnalyticsPost(profileActionUrl(action), idToken, body);

    // THE CATALOG IS THE CLASSIFICATION'S, not the assistant's: it describes what the
    // classification's infrastructure provides, and a profile version selects from it. This passed
    // PROFILE into a parameter named `classification` and hit by accident while the two were the same
    // string; an assistant named for what it does makes the read miss.
    const strict = readGuardrailCatalog('standard').find((g) => g.key === 'strict');
    expect(strict?.guardrailId, "the 'strict' guardrail must be provisioned (4.6b)").toBeTruthy();

    // The rollback target, captured BEFORE anything is mutated.
    const originalActiveVersion = activeVersionFromSsm();
    expect(originalActiveVersion, 'a profile with no active version cannot be restored afterwards').toBeTruthy();

    // ── THE BASELINE MUST NOT ALREADY BE THIS TEST'S OWN PERSONA ────────────────────────────────
    //
    // Restoring to "whatever was active when I started" is right for a test and rots silently when a
    // run FAILS: the failed run leaves its fixture persona active, and every later run then faithfully
    // preserves it. One failure poisons the baseline and every success afterwards keeps it.
    //
    // Measured: the standard assistant on the dev deployment spent an unknown period prefixing every
    // reply with this fixture's token, through nine versions, because the suite kept "restoring" to a
    // version a failed run had left behind. Checked rather than assumed, so a leak is a loud failure
    // here instead of a live assistant quietly reading from a test script.
    // Read through EXPORT, which hydrates. The stored definition carries a `personaRef` pointer when
    // the persona is offloaded to S3, so scanning the parameter value finds no persona text at all and
    // the check would pass on exactly the state it exists to catch.
    const baseline = await post('/export', { profileName: PROFILE, version: originalActiveVersion });
    const baselinePersona = String((baseline?.manifest as { body?: { persona?: string } })?.body?.persona ?? '');
    expect(
      baselinePersona.includes(PERSONA_SIGNATURE),
      `the active version already carries this test's persona (${PERSONA_SIGNATURE}), so a previous run `
      + 'leaked. Roll the profile back to a real version before re-running, or this run will preserve '
      + 'the fixture as the new baseline.',
    ).toBe(false);

    // COPY: clone the active version into a fresh draft.
    const copied = await post('/version', { profileName: PROFILE });
    expect(copied.draftConfigId, `copy (clone active→draft): ${JSON.stringify(copied)}`).toBeTruthy();
    // Whether a draft THIS TEST WROTE is still pending. Activation consumes a draft, so this is false
    // after each successful /activate and true after each write that creates one (/version, /import).
    // A run that fails between the two leaves the fixture persona in the draft, where the next person
    // to open the profile - or admin-profiles.spec.ts - would edit and activate it. The teardown reads
    // this to replace that draft rather than leave it.
    let fixtureDraftPending = true;

    try {
      // EDIT the draft: select the strict guardrail + set the custom task machines + a versioned persona.
      // NO `machines` IN THE PATCH. Task graphs are global workflows (2026-09-20): a version cannot
      // declare one, and `editDraft` refuses a patch that tries - so sending it here would fail this
      // test at the edit step, before it reached anything it is actually about.
      const edited = await post('/draft', { profileName: PROFILE, patch: { guardrailId: strict!.guardrailId, persona: PERSONA } });
      expect(edited.draftConfigId, `edit draft: ${JSON.stringify(edited)}`).toBeTruthy();

      // VALIDATE — schema + graph + §7 model boundary all pass.
      const validated = await post('/validate', { profileName: PROFILE });
      expect(validated.valid, `validate: ${JSON.stringify(validated.errors)}`).toBe(true);

      // ACTIVATE — promote the draft to a new active version.
      const activated = await post('/activate', { profileName: PROFILE });
      expect(activated.version, `activate: ${JSON.stringify(activated)}`).toBeTruthy();
      fixtureDraftPending = false;

      // EXPORT — the new axes must survive the instance-agnostic manifest (proves copy/edit/UPLOAD carry them).
      // The route wraps it: { manifest: { schemaVersion, profileName, body, contentHash, ... } }.
      const exported = await post('/export', { profileName: PROFILE });
      const manifest = exported.manifest;
      // The manifest must carry the guardrail's PORTABLE SELECTION KEY ('strict'), not the id this
      // instance resolved it to. That is the specified behavior (SPEC-PORTABLE-PROFILES "Export":
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
      // A MANIFEST NO LONGER CARRIES TASK GRAPHS, because a version does not hold them. This asserted
      // the opposite and would now throw on the property access, not merely fail.
      expect(manifest.body?.machines, 'a manifest must not carry task graphs').toBeUndefined();
      expect(manifest.body?.persona, 'manifest carries the versioned persona (persona is part of the versioned bundle)').toBe(PERSONA);

      // UPLOAD (import) the raw manifest back as a draft, then activate — a full round-trip of the config.
      const imported = await post('/import', { manifest, targetProfileName: PROFILE });
      fixtureDraftPending = true;
      expect(imported.configId, `import: ${JSON.stringify(imported)}`).toBeTruthy();
      const reValidated = await post('/validate', { profileName: PROFILE });
      expect(reValidated.valid, `re-validate imported: ${JSON.stringify(reValidated.errors)}`).toBe(true);
      const reActivated = await post('/activate', { profileName: PROFILE });
      expect(reActivated.version, `activate imported: ${JSON.stringify(reActivated)}`).toBeTruthy();
      fixtureDraftPending = false;

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
      // A FAILED RUN'S DRAFT IS REPLACED, AFTER the rollback so the clone is of the restored version.
      // There is no route that deletes a draft, and `/version` overwrites it with a clone of what is
      // serving, which carries none of this test's content. A clean pending draft is left in place of
      // the fixture; that is visible in the console and harmless to activate.
      if (fixtureDraftPending) await attempt('/version', { profileName: PROFILE });

      // Read back through the `active` LABEL - the pointer the async processor resolves. Reading the
      // bare parameter returns the LATEST version, which after this test is the test's own, so the
      // old check could report a leak that rollback had already fixed (and vice versa).
      let activePersona = '';
      let restoredVersion: number | null = null;
      try {
        restoredVersion = activeVersionFromSsm();
        // READ THROUGH EXPORT, WHICH HYDRATES - the same correction the baseline check at the top of
        // this test already carries, and this teardown did not. `offloadBodies` moves ANY non-empty
        // persona to S3 when a body bucket is configured (no size threshold), so the stored parameter
        // holds a `personaRef` pointer and never the persona text. Scanning it made `activePersona`
        // always empty on such a deployment, and the "still carrying THIS TEST'S persona" assertion
        // below could therefore never fire - the exact leak this teardown exists to catch passed it
        // every time. That is how the fixture reached the live assistant unnoticed.
        const exported = await post('/export', { profileName: PROFILE, version: restoredVersion ?? undefined });
        activePersona = String((exported?.manifest as { body?: { persona?: string } })?.body?.persona ?? '');
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

  /**
   * ROLLBACK IS A BEHAVIOUR CLAIM, AND UNTIL NOW IT WAS ONLY A CONFIGURATION ONE.
   *
   * The test above proves APPLY in the web client - after activation the reply carries the persona
   * signature - and its teardown proves the pointer moved back and the stored persona no longer holds
   * that signature. Both are reads of CONFIGURATION. Neither sends a message afterwards, so nothing
   * established that the assistant stopped SAYING it.
   *
   * That gap matters more than it looks, because the two can disagree in the direction that is quiet:
   * the active pointer is correct, the stored persona is clean, and a warm container keeps serving the
   * version it resolved earlier. `resolveActiveProfile` caches for about 30 seconds, which is exactly
   * the window a demo moves through - activate, show it working, roll back, show it reverted. A
   * configuration-only assertion passes while the person watching sees the test artifact.
   *
   * So this drives the same probe the apply turn used and requires the signature to be ABSENT.
   * Asserted on the signature rather than on the reply matching some baseline text: the correct end
   * state is whatever persona the deployment had, which is not empty and not predictable.
   *
   * THE GUARDRAIL IS DELIBERATELY NOT RE-ASSERTED. After rollback the strict guardrail is gone, so the
   * blocked term COULD come back - but whether a model chooses to use a word it was asked to use is
   * not a property of the platform, and an assertion that the term reappears would fail on a model
   * that simply declined. The persona signature is an instruction the profile either carries or does
   * not, which is why it is the one that can be asserted both ways.
   */
  test('and the ROLLBACK is visible in the web client: the persona signature is gone', async ({ page }) => {
    test.skip(!RUN, 'set PROFILE_CONFIG_E2E=1 (needs a config-enabled deploy + admin manage-profiles API)');
    test.setTimeout(4 * 60_000);

    // A FRESH PAGE PER TEST, so this signs in again. Playwright gives each test its own context, so the
    // sign-in the apply test performed is not inherited - without this, `createConversation` waits for
    // a modal that an unauthenticated page never shows and the failure reads as a broken helper.
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);

    // The resolver caches the active version for ~30s, the same wait the apply turn needs. Without it
    // this reads a warm container still holding the rolled-back version and would pass for the wrong
    // reason - or fail for one.
    await page.waitForTimeout(35_000);
    await createConversation(page, `Profile rollback e2e ${Date.now()}`, 'Standard');

    const reverted = await sendAndWaitForResponse(page, 'In one short sentence, what is a feature flag?', 120_000);
    expect(reverted.text && reverted.text.length, 'the assistant replied to the post-rollback turn').toBeTruthy();
    expect(
      reverted.text,
      `ROLLBACK IS NOT LIVE - the reply still carries "${PERSONA_SIGNATURE}", so the assistant is still `
        + `being answered by the version this test created even though the pointer and the stored persona `
        + `say otherwise (got: ${reverted.text})`,
    ).not.toContain(PERSONA_SIGNATURE);
  });
});
