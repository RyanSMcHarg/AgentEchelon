/**
 * Battle E2E setup helpers.
 *
 * The /battle behavioral specs require a live battle-enabled deploy: the
 * AgentEchelonBattle stack (orchestrator + channel-battle API; each classification stack provisions its alt)
 * and a premium/admin test user. Plain `cd tests && npm test` must NOT run them
 * (no battle deploy guaranteed, real model duels are slow), so every battle
 * behavioral test calls `requireBattleE2E()` and is SKIPPED unless BATTLE_E2E=1.
 *
 * Run them against a provisioned stack (frontend dev server up + backend
 * deployed with battle in capabilities):
 *   cd tests
 *   BATTLE_E2E=1 AWS_PROFILE=<your-profile> npx playwright test e2e/battle.spec.ts \
 *     --config=playwright.config.ts
 *
 * These arm an experiment on the admin origin, enable Battle Mode on a premium
 * channel, and fire a real duel — hard-asserting the UX. The selectors are the
 * real frontend ones.
 */
import { signedAdminContext, type SignedAdminContext } from './signed-analytics';
import { Page, expect, test, request } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { signIn, idTokenOf, createConversation } from './agent-helpers';
import { getTestCredentials } from './test-credentials';
import { aws } from './task-backend';
import { BATTLE_EXP_FILE } from '../../playwright.config';
import { raceBackendErrors } from './backend-errors';
import { retireStrandedE2eExperiments } from './experiment-sweep';
import { SSM_ROOT } from './stack-prefix';
import { adminApiServes, adminUrl, personApiServes } from './api-urls';
import { fillSecret } from './unrecorded-secret';

export const BATTLE_E2E_ENABLED = process.env.BATTLE_E2E === '1' || process.env.BATTLE_E2E === 'true';

/** Skip the calling test/suite unless BATTLE_E2E=1. */
export function requireBattleE2E(): void {
  test.skip(
    !BATTLE_E2E_ENABLED,
    'Battle E2E — set BATTLE_E2E=1 and point at a deployed battle-enabled stack (frontend running)',
  );
  // The deployment states whether it serves battle: the person API lists `battle` among its capabilities
  // when the battle routes exist. Without it there is no battle to drive, so the suite has nothing to test.
  test.skip(
    !personApiServes('battle'),
    'this deployment does not serve battle (VITE_PERSON_API_CAPABILITIES does not name battle)',
  );
}

/**
 * The RUN's battle experiment ids: minted once, then reused by every test in that run.
 *
 * NOT a fixed constant, deliberately. A fixed id ('e2e-battle-sonnet-vs-opus') survives only until some
 * run completes it, and `completed` is TERMINAL - `admin-experiments.ts` answers "'completed' and
 * 'deleted' are terminal - re-run with a new experiment id". `activateBattleExperiment` works by
 * RESUMING a paused experiment, which a terminal row can never be, so the whole behavioral suite was
 * permanently blocked in beforeAll once that happened (observed: the shared row went terminal on
 * 2026-07-28 and stayed there). Minting per run makes the suite independent of every previous run,
 * which is what a test that mutates a live environment has to be.
 *
 * Bounded: MAX_ACTIVE_EXPERIMENTS is 50 and `activateBattleExperiment` pauses the sibling, so a run
 * leaves at most one active battle experiment behind.
 */
function mintExpIds(): { text: string; image: string } {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { text: `e2e-battle-${stamp}`, image: `e2e-battle-image-${stamp}` };
}

function readOrMintExpIds(): { text: string; image: string } {
  const file = path.resolve(BATTLE_EXP_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.text && parsed?.image) return parsed;
  } catch { /* not written yet, or unreadable - mint below */ }
  const ids = mintExpIds();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ids), 'utf8');
  return ids;
}

/**
 * Mint a fresh pair and forget the persisted one. Used when arming discovers the recorded id is
 * TERMINAL, which happens whenever the setup project did not run for this invocation.
 *
 * The setup project mints per run, but it is a TEST like any other, so `--grep` filters it out:
 * running `npx playwright test e2e/battle.spec.ts -g "generation-out"` skips it silently, and the
 * suite then reads the previous run's file - whose experiment its own teardown completed. `completed`
 * is terminal, so arming answers `409 EXPERIMENT_TERMINAL` and the failure names the experiment,
 * pointing at the environment rather than at the invocation that caused it.
 *
 * Re-minting here makes the suite independent of HOW it was invoked, which is the same property
 * `initBattleExpIds` was written to give it.
 */
let remintedThisProcess: { text: string; image: string } | null = null;

export function remintBattleExpIds(): { text: string; image: string } {
  // ONCE PER PROCESS. Minting on every terminal answer cascades: this hook arms the text pair and the
  // image pair, and the retire loop completes any `e2e-battle-*` that is not the CURRENT pair. So a
  // second mint retires what the first one just armed, the next call finds ITS id terminal, and the
  // run mints again — observed three times in one run, each orphaning the last. Bounding it to one
  // keeps the recovery without the loop: after the first re-mint every caller shares that pair.
  if (remintedThisProcess) return remintedThisProcess;
  const ids = mintExpIds();
  const file = path.resolve(BATTLE_EXP_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ids), 'utf8');
  console.log(`[battle-setup] recorded experiment id was terminal; re-minted ${ids.text} (once per run)`);
  remintedThisProcess = ids;
  return ids;
}

/**
 * Ids THIS PROCESS has armed. The retire loop below skips them.
 *
 * The persisted pair is not sufficient for that skip, and the gap is what completed a live experiment
 * mid-run. The file is shared mutable state: `initBattleExpIds`, `readOrMintExpIds` and
 * `remintBattleExpIds` all write it, `path.resolve` makes it cwd-relative, and a re-mint that hits the
 * once-per-process guard returns its cached pair WITHOUT rewriting it. So `battleExpId()` can answer
 * with a pair this process never armed, the skip misses, and the loop completes the experiment the
 * beforeAll just armed - which then reads `completed` mid-run with the challenger still named, and the duel
 * that followed had no armed experiment to run against.
 *
 * What this process armed is not inferable from a file; record it directly.
 */
const armedThisProcess = new Set<string>();

/** This run's TEXT battle experiment id. */
export function battleExpId(): string {
  // The RE-MINTED pair wins over the file. Once this process has re-minted, those are its ids whatever
  // another process wrote afterwards, and every caller that defaults to this accessor (activate, enable,
  // retire) must agree with the arm that actually happened.
  return remintedThisProcess?.text ?? readOrMintExpIds().text;
}
/** This run's IMAGE generation-out experiment id (both variants carry an image-gen model). */
export function battleImageExpId(): string {
  return remintedThisProcess?.image ?? readOrMintExpIds().image;
}
/**
 * Mint a FRESH pair for this run (called by the setup project), so every test in the run agrees on
 * them and no run inherits the last one's.
 *
 * Deliberately not `readOrMintExpIds`. That reads the persisted file when present, which made the ids
 * per-FILE rather than per-run - they survived indefinitely once written. That was survivable while
 * nothing retired them, and fatal the moment the suite started completing its own experiments at
 * teardown: `completed` is TERMINAL, so the next run tried to arm a dead id and every duel failed with
 * `EXPERIMENT_TERMINAL ... Create a new experiment (new id) to run it again`. The two halves were each
 * reasonable and could not coexist.
 *
 * Minting here is what makes both work: the run gets its own experiment, retires it on the way out,
 * and leaves nothing behind for the next one to trip over. `battleExpId()` still reads the file, so
 * tests within the run share what this wrote.
 */
export function initBattleExpIds(): { text: string; image: string } {
  const file = path.resolve(BATTLE_EXP_FILE);
  const ids = mintExpIds();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ids), 'utf8');
  return ids;
}

/** Sign in as the admin test user (admin tab for arming + premium for the duel). */
export async function signInAdmin(page: Page): Promise<void> {
  const creds = await getTestCredentials();
  await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
}

// The admin console is its own app on its own origin (DESIGN-SEPARATE-ADMIN-APP.md).
// Experiment SETUP happens on the admin origin; the battle DUEL runs on the chat
// origin. That makes this a CROSS-ORIGIN flow with per-origin auth.
// >>> DEPLOY-VERIFY REQUIRED: this cross-origin path (admin-origin setup + chat-origin
//     duel + a sign-in on each origin) has not been run end-to-end; confirm on a
//     battle-enabled deploy with BATTLE_E2E=1. The old-structure selectors
//     (admin-button, admin-back-btn) are removed; the two-origin handling below is
//     the intended shape, pending that verification.
const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';

async function openAdminExperiments(page: Page): Promise<void> {
  // Deep-link straight to the Experiments tab on the admin app; auth is per-origin,
  // so sign in here if the login screen shows (the section rail is the mounted proof).
  await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
  const needsLogin = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (needsLogin) {
    const creds = await getTestCredentials();
    // Sign in ON THE ADMIN ORIGIN — the login form is already on screen (we just
    // navigated here and detected it). Do NOT delegate to the shared signIn(),
    // which navigates via page.goto('/') → the CHAT baseURL: that origin is
    // already authenticated (the duel-side sign-in ran first), so its login form
    // never renders and the helper times out waiting for the email field. Auth is
    // per-origin (localStorage), so the admin origin must be signed into here,
    // directly against the form in front of us.
    await page.locator('input[type="email"]').fill(creds.testAdmin.email);
    await fillSecret(page.locator('input[type="password"]'), creds.testAdmin.password);
    await page.locator('button[type="submit"]').click();
    // Admin auth lands on the dashboard shell; then re-deep-link to Experiments.
    await page.waitForSelector('.admin-dashboard, .admin-section-rail', { timeout: 30_000 });
    await page.goto(new URL('/?admin=experiments', ADMIN_BASE_URL).toString());
  }
  await page.waitForSelector('.admin-section-rail', { timeout: 15_000 });
  await expect(page.locator('h3:has-text("A/B Experiments")')).toBeVisible({ timeout: 15_000 });
}

async function leaveAdmin(page: Page): Promise<void> {
  // The standalone admin app has no "close console"; the duel runs on the chat
  // origin, so navigate there (a chat-origin sign-in happens in the duel flow).
  await page.goto(CHAT_BASE_URL);
}

/*
 * The UI-driven `pauseBattleExperimentIfActive` / `resumeBattleExperimentIfPaused` helpers lived here.
 * They clicked Pause/Resume in the admin table and each began "row not present -> nothing to do".
 * Every run leaves two completed `e2e-battle-*` rows behind and nothing prunes them, so once the table
 * paginated past them both helpers no-oped in silence and the failure appeared at the channel enable
 * instead: "The challenger is named by another active battle experiment" (sibling never paused) or "Experiment is
 * not active" (own never resumed). `activateBattleExperiment` now drives the admin API, which is the
 * same authority the arming read-back already uses for the same stated reason.
 */

/**
 * THE ALT'S ASSIGNMENT RECORD FOR A CLASSIFICATION, as its classification stack publishes it (§3.7):
 * `${SSM_ROOT}/assistant-assignments/{classification}/primary/alt`, naming the alt's bot and its own
 * Amazon Lex bot. Asserted present, because a battle arms only where the classification provisions one.
 */
function altRecordFor(classification: string): { botArn?: string; lexBotId?: string } {
  const name = `${SSM_ROOT}/assistant-assignments/${classification}/primary/alt`;
  const raw = aws(`ssm get-parameter --name "${name}"`)?.Parameter?.Value;
  const record = JSON.parse(raw || '{}') as { botArn?: string; lexBotId?: string };
  expect(
    record.botArn,
    `no alt is provisioned for '${classification}' (${name} is ${raw || 'unreadable'}). Deploy the `
    + `${classification} classification stack with battle enabled, which provisions its alt.`,
  ).toBeTruthy();
  return record;
}

/**
 * THE ASSISTANT THAT HOLDS A CLASSIFICATION'S ROLE LIVE, by its profile name, read from its assignment
 * record. A profile is named for its assistant (`advisor`), never for its classification (`premium`), and a
 * deployment may rename it, so a spec reads it rather than spelling it.
 */
export function liveAssistantFor(classification: string, role = 'primary'): string {
  // The declared assistant's record, at the one path every live assistant's record has (ADR-048, amended
  // 2026-10-23); the declared one is the record that is not a console-created (`runtime`) one.
  const name = `${SSM_ROOT}/assistant-assignments/${classification}/${role}/assistants`;
  const values = (aws(`ssm get-parameters-by-path --path "${name}"`)?.Parameters ?? []) as Array<{ Value?: string }>;
  const records = values.map((p) => { try { return JSON.parse(p.Value || '{}') as { assistant?: string; source?: string }; } catch { return {}; } });
  const assistant = records.find((r) => r.source !== 'runtime' && r.assistant)?.assistant || '';
  expect(assistant, `no declared assistant holds '${classification}' ${role} live (${name})`).toBeTruthy();
  return assistant;
}

/**
 * THE CHALLENGER AN EXPERIMENT NAMES, as `challengerAssistant`: the alt of the experiment's own
 * classification, by assistant id, checked against a provisioned alt so a spec cannot arm a battle the
 * deployment cannot field. The server refuses any other id for that classification.
 */
export function challengerFor(classification: string): string {
  altRecordFor(classification);
  return `alt-primary-${classification}`;
}

/**
 * THE ALT BOT SERVING A CLASSIFICATION, read from its assignment record, never hardcoded. The name is
 * what its classification stack gives the bot, so a test that addressed a name of its own invention
 * would pass or fail on the fixture rather than on the product.
 */
export function altBotArnFor(classification: string): string {
  return altRecordFor(classification).botArn || '';
}

/**
 * TURN BATTLE ON for a classification, through the deployed admin API.
 *
 * Battle is OFF until an operator turns it on (ADR-049), classification-level and runtime, so a fresh
 * or upgraded deployment refuses every enable until this runs. Without it the whole battle suite fails
 * at `newBattleChannel` with 403 `TIER_FORBIDDEN`, which reads like a product regression and is not.
 *
 * THROUGH THE SIGNED API, NOT BY WRITING THE PARAMETER. The route refuses a classification the
 * deployment did not wire, and that refusal is part of what this suite should be exercising; reaching
 * around it with a direct SSM write would arrange a state the product would not have allowed and prove
 * nothing about the path an operator actually takes.
 */
export async function enableBattleForClassification(page: Page, classification = 'premium'): Promise<void> {
  const experimentsApi = adminApiServes('experiments') ? adminUrl('assistant-admin', '/admin/experiments') : '';
  expect(
    experimentsApi,
    'VITE_ADMIN_API_CAPABILITIES must name experiments to turn battle on (run via validate.mjs, or export it)',
  ).toBeTruthy();
  await page.goto(CHAT_BASE_URL);
  const idToken = await idTokenOf(page);
  expect(idToken, 'no idToken on the current origin - enableBattleForClassification needs a signed-in page').toBeTruthy();
  const api = signedAdminContext(idToken!);
  try {
    const resp = await api.post(adminUrl('assistant-admin', `/admin/experiments/battle-settings`), {
      data: { classification, enabled: true },
    });
    // FAIL LOUD. A 409 here means this deployment does not build battle for the classification, which
    // is a real answer and not something to retry around: the suite cannot run and should say why.
    expect(
      resp.ok(),
      `turn battle on for '${classification}': ${resp.status()} ${await resp.text()}`,
    ).toBeTruthy();
  } finally {
    await api.dispose();
  }
}

/**
 * Ensure a battle-enabled premium experiment EXISTS (create-if-missing) — the expensive form-fill create
 * paid ONCE, not per test. Idempotent: if `expId` already shows in the list, this is a no-op reuse
 * (avoids the duplicate-id create error AND avoids clobbering a hand-tuned config — a re-create resets
 * both variants to the form defaults). Does NOT enforce active/paused exclusivity — that is
 * activateBattleExperiment's job, called per test. Returns with admin left (chat origin).
 */
export async function ensureBattleExperimentExists(
  page: Page,
  opts: { challenger?: string; control?: string; treatment?: string; expId?: string; image?: boolean } = {},
): Promise<void> {
  const challenger = opts.challenger ?? challengerFor('premium');
  const expId = opts.expId ?? battleExpId();
  await openAdminExperiments(page);

  // Already armed (this or a prior run)? Reuse it. openAdminExperiments already waited for the list
  // heading, but the row itself can lag the initial render; give it a real window (not 3s) so a slow
  // list never forces a spurious re-create.
  const existing = page.locator(`tr:has-text("${expId}")`).first();
  if (await existing.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await leaveAdmin(page);
    return;
  }

  // Not armed yet. BOTH battle kinds arm via the admin API — deterministic, and it bypasses the
  // interaction-flaky create FORM that was timing out this beforeAll hook (the handler stamps
  // boundBy from the caller, so we don't pass it).
  //
  // The image battle used to keep the form, on the reasoning that its image-model dropdowns are
  // "deploy-dependent" so the UI had to discover them. That was the wrong conclusion from a true
  // premise: the dropdown is populated from `IMAGE_GEN_MODELS`, a FIXED catalog in the repo, so the
  // keys can be named directly and the two AWS-hosted `active` ones need no external API key. Keeping
  // the form to read a list we already know cost the image duel every run it was gated into — the
  // hook stalled filling the Experiment ID field and aborted the whole serial block, so the one test
  // this path exists for has never executed.
  //
  // An image battle is an `intent` experiment on `image_generation` (the frontend's own
  // `isImageIntentExperiment`), with the image model carried per variant.
  {
    const idToken = await idTokenOf(page);
    // REQUIRED, not best-effort. This defaulted to '' when unset, and a POST to an empty URL still
    // satisfied `resp.ok()` - so arming silently created nothing and the suite failed much later
    // looking like a product bug. `validate.mjs` injects this; a bare `npx playwright test` does not,
    // which is exactly when the silent version bit.
    const experimentsApi = adminApiServes('experiments') ? adminUrl('assistant-admin', '/admin/experiments') : '';
    expect(
      experimentsApi,
      'VITE_ADMIN_API_CAPABILITIES must name experiments to arm a battle experiment (run via validate.mjs, or export it)',
    ).toBeTruthy();
    const api = signedAdminContext(idToken!);
    try {
      // FREE PREMIUM BEFORE ARMING. The create below is `active` on premium, and a classification holds
      // one live experiment (§3.2.1), so anything live there turns it into a 409. Two sources: this
      // run's own sibling (the text and image battles are a pair, and only one may be active - the
      // same rule activateBattleExperiment applies), which is PAUSED so it can be resumed; and any
      // `e2e-` experiment a killed run stranded, which is retired.
      const sibling = expId === battleExpId() ? battleImageExpId() : battleExpId();
      const before = await api.get(experimentsApi);
      expect(before.ok(), `list experiments before arming ${expId}: ${before.status()}`).toBeTruthy();
      const beforeBody = await before.json().catch(() => ({} as Record<string, unknown>));
      const beforeRows = beforeBody.experiments ?? beforeBody.data ?? beforeBody;
      const siblingRow = (Array.isArray(beforeRows) ? beforeRows : []).find(
        (e: Record<string, unknown>) => (e.experimentId ?? e.id) === sibling,
      );
      if (siblingRow?.status === 'active') {
        const paused = await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(sibling)}/status`), { data: { status: 'paused' } });
        expect(paused.ok(), `pause sibling ${sibling} before arming: ${paused.status()} ${await paused.text()}`).toBeTruthy();
      }
      await retireStrandedE2eExperiments(api, experimentsApi, {
        keep: [battleExpId(), battleImageExpId(), ...armedThisProcess],
        label: 'battle-setup',
      });

      let armId = expId;
      // A BATTLE ARMS IN ONE CALL (§3.7), the same call the console makes: the experiment is created
      // `active` as set, and the server derives both duel sides' pinned versions as it arms it (the control
      // under the live assistant, the treatment under the alt) and stores them on the variants.
      const armBody = (id: string) => ({
          experimentId: id,
          status: 'active',
          // An image battle is an `intent` experiment on `image_generation`; a text battle varies
          // the base model. Same arming path either way.
          experimentType: opts.image ? 'intent' : 'base_model',
          // Carried so the channel config gets a `briefingIntent` (channel-battle.ts sets it from
          // `exp.intent` whatever the type), which is what steers the briefing's coaching line and
          // starter chips. A base_model experiment IGNORES intent for resolution - validation says so
          // explicitly - so this changes the briefing and nothing else. Without it the banner falls back
          // to GENERIC steering, and B-E2 ("chips match the experiment intent") asserts a claim the
          // arranged experiment never made.
          intent: opts.image ? 'image_generation' : 'general',
          tiers: ['premium'], // BATTLE_TIER_PREMIUM_ONLY guard
          battleEnabled: true,
          challengerAssistant: challenger,
          variants: [
            // The two AWS-hosted Stability image models from IMAGE_GEN_MODELS. Named directly rather than
            // discovered through a dropdown: the catalog is in the repo, and neither needs an external
            // API key, so an image battle arms on any deployment that has Bedrock.
            ...(opts.image
              ? [
                { variantId: 'control', ...(opts.control ? { modelKey: opts.control } : {}), imageGenModelKey: 'stability_image_core', weight: 50 },
                { variantId: 'treatment', modelKey: opts.treatment ?? 'sonnet', imageGenModelKey: 'stability_image_ultra', weight: 50 },
              ]
              : [
                // The control is the live assistant's active version (§3.5); it names a model only when asked to.
                { variantId: 'control', ...(opts.control ? { modelKey: opts.control } : {}), weight: 50 },
                { variantId: 'treatment', modelKey: opts.treatment ?? 'opus', weight: 50 },
              ]),
          ],
          objective: { metric: 'quality', target: 10, statement: 'E2E battle: decide the premium base model.' },
      });
      const armOnce = (id: string) => api.post(experimentsApi, { data: armBody(id) });

      // AN EXPERIMENT THIS RUN ALREADY ARMED IS REUSED, not re-armed. Active with both sides pinned is
      // already armed; paused (its sibling took premium) is resumed, which derives again and reuses the pins
      // that still say the same thing. Anything else is armed in one call.
      const selfRow = (Array.isArray(beforeRows) ? beforeRows : []).find(
        (e: Record<string, unknown>) => (e.experimentId ?? e.id) === armId,
      ) as Record<string, unknown> | undefined;
      const selfVariants = Array.isArray(selfRow?.variants) ? selfRow!.variants as Array<Record<string, unknown>> : [];
      const selfPinned = selfVariants.some((v) => v.variantId === 'treatment' && !!v.altPin)
        && selfVariants.some((v) => v.variantId === 'control' && !!v.controlPin);
      let resp = selfRow?.status === 'active' && selfPinned
        ? before
        : selfRow?.status === 'paused' && selfPinned
          ? await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(armId)}/status`), { data: { status: 'active' } })
          : await armOnce(armId);
      // A TERMINAL id means the recorded pair belongs to a finished run — the setup project did not
      // run for this invocation (a `--grep` filters it out like any other test). Re-mint and arm
      // again, once, so the suite does not depend on how it was started. Any other failure is real
      // and is asserted below unchanged.
      if (!resp.ok() && resp.status() === 409 && /EXPERIMENT_TERMINAL/.test(await resp.text())) {
        armId = opts.image ? remintBattleExpIds().image : remintBattleExpIds().text;
        resp = await armOnce(armId);
      }
      expect(resp.ok(), `arm battle experiment via API: ${resp.status()} ${await resp.text()}`).toBeTruthy();
      armedThisProcess.add(armId);

      // Verify against the API, NOT the admin table. The table was the original check and it is the
      // wrong authority twice over: the list can filter or paginate a row out, and a 2xx create whose
      // row never became usable (the terminal-status case) failed here as a 15s UI timeout that read
      // like a render bug. Assert the thing that actually matters - the experiment exists and is
      // ACTIVE, so `activateBattleExperiment` has something it can resume.
      // LIST and find: the admin experiments API has no per-id GET, only `GET /admin/experiments`.
      // (Reading `${api}/${id}` returns the list itself, so a naive read looks 2xx and yields no
      // status - which is exactly how this assertion caught itself being wrong.)
      const check = await api.get(experimentsApi);
      expect(check.ok(), `list experiments to read back ${armId}: ${check.status()}`).toBeTruthy();
      const listed = await check.json().catch(() => ({} as Record<string, unknown>));
      const rows = listed.experiments ?? listed.data ?? listed;
      const armed = (Array.isArray(rows) ? rows : []).find(
        (e: Record<string, unknown>) => (e.experimentId ?? e.id) === armId,
      );
      const status = armed?.status as string | undefined;

      // RETIRE PREVIOUS RUNS' BATTLE EXPERIMENTS. There is ONE challenger per classification, and enabling a channel
      // binds it to THE single active battle experiment; a second active one makes that ambiguous and
      // the enable fails with "The challenger is named by another active battle experiment".
      //
      // The old fixed-id design got this for free by reusing one experiment forever - which is exactly
      // why it could never recover once that row went terminal. Per-run ids fix the terminal trap but
      // reintroduce challenger contention unless each run cleans up after the last, so it does that here.
      //
      // Scoped to `e2e-battle-*` ids and skipping THIS run's pair, so an operator's own experiment is
      // never completed by a test run.
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const id = (row.experimentId ?? row.id) as string | undefined;
        if (!id || !/^e2e-battle-/.test(id)) continue;
        // Skip this run's pair AND anything this process armed. The second half is the one that binds:
        // `armId` may be a re-minted id that the persisted pair no longer names (see `armedThisProcess`),
        // and completing it here retires the experiment the duel is about to run on.
        if (id === battleExpId() || id === battleImageExpId() || armedThisProcess.has(id)) continue;
        if (row.status !== 'active' && row.status !== 'paused') continue;
        await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), {
          data: { status: 'completed' },
        }).catch(() => { /* best-effort: a leftover we cannot retire will surface as a challenger conflict */ });
      }
      expect(
        status,
        `armed experiment ${armId} must be active (a terminal row can never be resumed); got '${status}'`,
      ).toBe('active');
    } finally {
      await api.dispose();
    }
    await leaveAdmin(page);
    return;
  }

  // NO FORM PATH. Both battle kinds arm through the API above, so this function never touches the
  // create form. The form-fill path that used to live here is what made the image duel unrunnable:
  // it stalled filling the Experiment ID field, timed out the beforeAll hook, and aborted the whole
  // serial block — so the one test it existed for never executed in three separate attempts.
  //
  // It was kept on the belief that image models had to be DISCOVERED from the dropdown. They do not:
  // the dropdown is rendered from IMAGE_GEN_MODELS, a fixed catalog in this repo.
}

/**
 * Make `expId` the SOLE ACTIVE battle experiment for its classification — the cheap per-test step
 * (no form fill; the row already exists from the beforeAll create). Preserves the exclusivity
 * invariant: only ONE battle experiment may be active at a time (the channel enable auto-resolves the
 * single active one, and the challenger is named by only an active one), so this PAUSES the sibling e2e
 * battle experiment and RESUMES `expId` if it was paused. Idempotent + independent per test: a test
 * that ran before may have paused this one for its own exclusivity, so re-activating here keeps each
 * test self-contained (one failure never leaves the wrong experiment active for the next).
 *
 * Drives the ADMIN API rather than clicking the admin table, so it no longer round-trips through the
 * admin console. It still lands the page on the chat origin, which is where the duel runs and what the
 * caller relies on next.
 */
export async function activateBattleExperiment(page: Page, expId: string = battleExpId()): Promise<void> {
  const sibling = expId === battleExpId() ? battleImageExpId() : battleExpId();
  const experimentsApi = adminApiServes('experiments') ? adminUrl('assistant-admin', '/admin/experiments') : '';
  expect(
    experimentsApi,
    'VITE_ADMIN_API_CAPABILITIES must name experiments to activate a battle experiment (run via validate.mjs, or export it)',
  ).toBeTruthy();
  // Land on the CHAT origin first, and do it unconditionally. Two things depend on it and both used to
  // happen by accident: the duel runs here (newBattleChannel drives the chat app immediately after this
  // returns, and the old implementation reached it only via leaveAdmin() at the end of an admin round
  // trip), and loading the origin is what applies the project storageState - a page that has navigated
  // nowhere reads about:blank's empty localStorage, which is precisely the bug that made the battle
  // teardown silently retire nothing for weeks.
  await page.goto(CHAT_BASE_URL);

  // REQUIRED, not best-effort: a null token still produces a syntactically valid `Bearer null` header,
  // the calls 401, and the failure surfaces later as a battle enable error - the same class of
  // silent-empty bug the arming path records above.
  const idToken = await idTokenOf(page);
  expect(
    idToken,
    'no idToken on the current origin - activateBattleExperiment must run on a signed-in page',
  ).toBeTruthy();
  const api = signedAdminContext(idToken!);
  try {
    // Read the CURRENT statuses from the API and drive the transitions there. This used to click Pause
    // and Resume in the admin table, which is the wrong authority for exactly the reason the arming
    // read-back above already records: the list paginates. Every e2e run leaves two completed rows
    // behind and nothing prunes them, so `tr:has-text(<id>)` eventually matches nothing, both helpers
    // took their "row not present -> nothing to do" branch, and the run failed at the CHANNEL ENABLE
    // with "The challenger is named by another active battle experiment" (sibling never paused) or "Experiment is
    // not active" (own never resumed). A silent no-op in a setup helper reads as a product fault.
    const list = await api.get(experimentsApi);
    expect(list.ok(), `list experiments to activate ${expId}: ${list.status()}`).toBeTruthy();
    const body = await list.json().catch(() => ({} as Record<string, unknown>));
    const rows = body.experiments ?? body.data ?? body;
    const statusOf = (id: string): string | undefined =>
      (Array.isArray(rows) ? rows : []).find((e: Record<string, unknown>) => (e.experimentId ?? e.id) === id)
        ?.status as string | undefined;

    const setStatus = (id: string, status: 'active' | 'paused') =>
      api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), { data: { status } });

    // Exclusivity: at most ONE active battle experiment per classification. The channel enable carries
    // no experimentId (the toggle has no picker), so the backend auto-resolves the single active one -
    // two actives is ambiguous and one active sibling holds the challenger.
    const siblingStatus = statusOf(sibling);
    if (siblingStatus === 'active') {
      const resp = await setStatus(sibling, 'paused');
      expect(resp.ok(), `pause sibling ${sibling}: ${resp.status()} ${await resp.text()}`).toBeTruthy();
    }

    const own = statusOf(expId);
    if (own === 'paused') {
      const resp = await setStatus(expId, 'active');
      expect(resp.ok(), `resume ${expId}: ${resp.status()} ${await resp.text()}`).toBeTruthy();
    }

    // Fail LOUD on a terminal row. `completed`/`deleted` cannot be resumed, so proceeding would fail at
    // the enable with a message that names the channel rather than the cause.
    const finalStatus = own === 'paused' ? 'active' : own;
    expect(
      finalStatus,
      `${expId} must be ACTIVE before enabling battle (terminal rows can never be resumed); got '${own}'`,
    ).toBe('active');
  } finally {
    await api.dispose();
  }
}

/**
 * Create a premium conversation and enable Battle Mode on it for this run's battle experiment.
 * Throws (fails the test) if the alt or the battle API is unreachable —
 * that IS the regression signal for the AgentEchelonBattle relocation.
 */
export async function newBattleChannel(page: Page, title: string, expId: string = battleExpId()): Promise<void> {
  // THE PREMIUM CARD BY ITS NAME (`createConversation`), or a failure naming what was offered - never the
  // first card, which opened a conversation where battle does not exist and failed every test after it.
  await createConversation(page, title, 'Premium');
  await page.locator('.message-textarea').waitFor({ state: 'visible', timeout: 15_000 });

  await page.locator('button[aria-label="Show channel members"]').click();
  const section = page.locator('section.channel-members-panel-battle');
  await expect(section).toBeVisible({ timeout: 10_000 });
  // Battle enable is a plain ON/OFF toggle: the backend auto-resolves the
  // single battle-enabled experiment for the channel's classification, so there
  // is no experiment picker. Stay tolerant of an older build that still renders
  // #battle-experiment-select (select it if present); either way, click Enable.
  const expSelect = section.locator('#battle-experiment-select');
  if (await expSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await expSelect.selectOption(expId).catch(() => {});
  }
  const enableBtn = section.locator('.channel-members-panel-battle-btn--enable');
  await enableBtn.waitFor({ state: 'visible', timeout: 25_000 });
  await enableBtn.click();

  const live = section.locator('.status-badge--live');
  const err = section.locator('.channel-members-panel-battle-error');
  await Promise.race([
    live.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
    err.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
  ]);
  if (await err.isVisible({ timeout: 500 }).catch(() => false)) {
    throw new Error(`Battle enable failed: ${await err.innerText().catch(() => 'unknown error')}`);
  }
  await expect(live).toBeVisible();
  // Close the members panel so it doesn't overlay the composer. The toggle
  // button's label flips to "Hide channel members" while the panel is OPEN —
  // clicking the "Show…" label here is a no-op that leaves the panel covering
  // the textarea (every subsequent composer action then hangs).
  await page.locator('button[aria-label="Hide channel members"]').first().click({ timeout: 5000 }).catch(() => {});
  await page.locator('section.channel-members-panel-battle').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * `newBattleChannel`, returning the new conversation's channel id, by which the backend addresses the duel
 * pointer, each side's state and a reply targeted at a side.
 */
export async function newBattleChannelWithId(page: Page, title: string, expId: string = battleExpId()): Promise<string> {
  const createResp = page.waitForResponse(
    (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await newBattleChannel(page, title, expId);
  const body = await (await createResp).json();
  return (body.conversation.conversationArn as string).split('/').pop()!;
}

/**
 * Fire a /battle prompt and wait for the dual reply to RESOLVE. Returns the
 * number of .battle-message bubbles. Resolution is signaled by the scorecard's
 * first response-time cell carrying a digit (the per-bot placeholders + an
 * empty-dash scorecard render immediately, so bubble count alone lies).
 */
/**
 * Type a /battle prompt into the composer and send it — no readiness wait. The building block behind
 * fireBattle (which layers the resolved-duel wait on top). Explicit fill timeout so a blocked composer
 * (an overlay) fails fast with a clear error.
 */
async function fireBattleRaw(page: Page, prompt: string): Promise<void> {
  await page.locator('.message-textarea').fill(prompt, { timeout: 30_000 });
  await page.keyboard.press('Enter');
}

export async function fireBattle(page: Page, prompt: string, timeoutMs = 260_000): Promise<number> {
  // Window opens BEFORE the send: the handler can log before the UI registers anything.
  const windowStart = Date.now() - 2_000;
  await fireBattleRaw(page, prompt);

  // A duel that never renders is nearly always a handler that already failed, and this wait is 260s -
  // four minutes to arrive at "expected >= 2 battle messages", which names the symptom while the
  // handler log names the cause. Racing the wait against the backend check turns that into seconds,
  // and reports the CAUSE. Same predicate and window as the afterAll sweep, which still runs.
  return raceBackendErrors(async () => {
    await expect
      .poll(async () => page.locator('.message.battle-message').count(), { timeout: timeoutMs })
      .toBeGreaterThanOrEqual(2);
    const card = page.locator('.battle-scorecard').last();
    await card.waitFor({ state: 'visible', timeout: timeoutMs });
    await expect
      .poll(async () => card.locator('.battle-scorecard-cell').first().innerText().catch(() => ''), {
        timeout: timeoutMs,
      })
      .toMatch(/\d/);
    return page.locator('.message.battle-message').count();
  }, windowStart, 'battle turn');
}

/**
 * Retire THIS run's battle experiments, so the suite does not leave the deployment's premium routing
 * altered behind it.
 *
 * An active experiment takes precedence over the active profile for the model it governs, and a
 * battle experiment is premium with a non-Opus control. Leaving one active means premium traffic keeps
 * splitting after the suite ends: the very next run of `agent-intents` reports "a premium conversation
 * was served by ... sonnet, not an Opus model" and reads as a routing regression rather than as
 * leftover test state. Observed exactly that in the first full validate sweep, where the `user` phase
 * failed on an experiment a previous standalone battle run had left behind.
 *
 * The start-of-run cleanup retires PREVIOUS runs, which cannot help here - it runs too early to retire
 * the run doing the retiring. Best-effort: a failure to retire is reported, never thrown, because it
 * must not turn a green suite red at teardown.
 */
export async function retireThisRunsBattleExperiments(page: Page): Promise<void> {
  const experimentsApi = adminApiServes('experiments') ? adminUrl('assistant-admin', '/admin/experiments') : '';
  if (!experimentsApi) {
    // Loudly, not silently. This returned quietly for as long as it has existed, so a run that
    // retired NOTHING was indistinguishable from one that retired everything.
    console.warn(
      '[battle-setup] VITE_ADMIN_API_CAPABILITIES does not name experiments, so this run\'s battle experiments were NOT '
      + 'retired and premium routing stays split. Regenerate the per-package env (gen-frontend-env).',
    );
    return;
  }

  // NAVIGATE FIRST. `storageState` is applied to an origin the first time that origin is loaded, so
  // a page straight from `newContext().newPage()` sits on about:blank and reads about:blank's
  // localStorage - which never holds `idToken`. This read therefore returned null on every run, the
  // helper returned early, and EVERY battle run stranded an active premium experiment. Confirmed on
  // 2026-08-06: `e2e-battle-msi875jcjmbl` was still `active` after a full suite whose teardown "ran".
  const origin = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || '';
  if (origin) await page.goto(origin).catch(() => { /* fall through to the token check */ });

  const idToken = await page.evaluate(() => localStorage.getItem('idToken')).catch(() => null);
  if (!idToken) {
    console.warn(
      `[battle-setup] no idToken on ${origin || '(no origin)'}, so this run's battle experiments were `
      + 'NOT retired and premium routing stays split. Complete them from the admin console.',
    );
    return;
  }

  const api = signedAdminContext(idToken!);
  try {
    for (const id of [battleExpId(), battleImageExpId()]) {
      const resp = await api
        .post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), { data: { status: 'completed' } })
        .catch(() => null);
      if (resp?.ok()) continue;

      // A 404 IS NOT A FAILURE, and reporting it as one taught readers to ignore this warning.
      //
      // Both ids are minted at setup, but the IMAGE experiment is only CREATED by the image duel, which
      // is opt-in (BATTLE_IMAGE_E2E). An ordinary run therefore tried to retire an experiment that had
      // never existed, got a 404, and printed a warning claiming premium routing "may still be split by
      // it" - about an experiment that cannot split anything because there is nothing there. Every
      // green run ended on an alarm that was not true, which is how a real one comes to be scrolled
      // past. Nothing to retire is the desired end state, so it is silent.
      if (resp?.status() === 404) continue;

      console.warn(
        `[battle-setup] could not retire ${id} (${resp ? `HTTP ${resp.status()}` : 'request failed'}); `
        + 'premium routing may still be split by it. Complete it from the admin console, or the next '
        + 'agent-intents run will report a premium conversation served by the control model.',
      );
    }
  } finally {
    await api.dispose();
  }
}
