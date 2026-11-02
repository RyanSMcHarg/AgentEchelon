/**
 * THE CONSOLE EDITS AN INTENT'S IMAGE MODEL AND ONE STEP'S MODEL, AND EFFECTIVENESS READS THE STEP (ADR-064 slice 5).
 *
 * As an admin, on the premium primary's page: start a draft, open Scope and models, choose the `image_generation` card's
 * Image model and override its `gather` step with a text model the classification selects, save, Validate (the draft is
 * valid, and no refusal sits under the card) and Activate. The active version then holds the image model in the route's
 * image part and the override under `steps.gather`, and nothing in `models.image`. A turn of the image workflow that
 * starts in `gather` runs on the override, and the intent's step breakdown (`intent_steps`, `?step=gather`) reads that
 * step with that model, through the API and on the Effectiveness page the step's link opens. No image is drawn.
 *
 * GATED: it sends real premium turns, so it runs only with `E2E_MODEL_ROUTES=1`. The version active before it is
 * restored afterwards.
 *
 * **Coverage:** `e2e/a-console-edits-an-intents-image-and-step-models.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { signInAsAdmin } from './helpers/agent-helpers';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { channelArnFor } from './helpers/battle-state-backend';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { PROFILE, activeVersionOf, messagesSeenBy, openConversation, rollBack, sleep } from './helpers/workflow-task';
import { ANALYTICS_API, activeBody, adminSessionOrSkip, discardDraft, modelKeyOf } from './helpers/model-routes';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
test.use({ baseURL: ADMIN_BASE_URL });

const MARK = `CONSOLESTEP-${Date.now().toString(36)}`;

test.describe.serial('the console edits an intent\'s image and step models', () => {
  guardBackendErrors('a-console-edits-an-intents-image-and-step-models');
  guardConsoleErrors();
  let admin: any;
  let idToken = '';
  let previous: number | undefined;
  let imageModel = '';
  let gatherModel = '';

  test.beforeAll(async () => {
    test.skip(process.env.E2E_MODEL_ROUTES !== '1', 'sends real premium turns; set E2E_MODEL_ROUTES=1 to run it');
    const s = await adminSessionOrSkip();
    test.skip(!!s.skip, s.skip);
    admin = s.admin;
    idToken = s.idToken!;
    previous = await activeVersionOf(admin);
  });

  test.afterAll(async () => {
    if (!admin) return;
    await discardDraft(admin).catch(() => undefined);
    await rollBack(admin, previous);
  });

  test('a draft chooses the image model and a step override on the card, validates and activates', async ({ page }) => {
    test.setTimeout(6 * 60_000);
    await signInAsAdmin(page);
    await page.goto('/?admin=profiles');
    await expect(page.locator('.admin-tab-loading')).toHaveCount(0, { timeout: 30_000 });
    const row = page.locator(`tr[data-assistant="${PROFILE}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button.btn-link').first().click();

    // A draft, started from the header (or the one already open).
    const draftToggle = page.getByTestId('assistant-mode-draft');
    if (await draftToggle.count()) await draftToggle.click(); else await page.getByTestId('new-version').click();
    await expect(page.getByTestId('assistant-draft')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('assistant-nav-scope').click();
    const editor = page.getByTestId('draft-step-models');
    await expect(editor).toBeVisible({ timeout: 20_000 });

    // The image model: an image model the classification selects, offered only in the card's Image model select.
    const imageSelect = page.getByTestId('draft-route-image_generation-image');
    await expect(imageSelect).toBeVisible();
    const imageOptions = (await imageSelect.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(Boolean);
    expect(imageOptions.length, 'premium selects an image model').toBeGreaterThan(0);
    imageModel = imageOptions[imageOptions.length - 1];
    await imageSelect.selectOption(imageModel);

    // The gather step's override: a text model, the only kind its select offers.
    const gatherSelect = page.getByTestId('draft-step-image_generation-gather');
    const textOptions = (await gatherSelect.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(Boolean);
    expect(textOptions.length, 'the gather step offers text models').toBeGreaterThan(0);
    expect(textOptions).not.toContain(imageModel);
    gatherModel = textOptions.includes('haiku') ? 'haiku' : textOptions[0];
    await gatherSelect.selectOption(gatherModel);
    await expect(page.getByTestId('draft-step-models-unsaved')).toBeVisible();
    await editor.getByTestId('draft-step-save').click();
    await expect(page.getByTestId('draft-step-models-unsaved')).toHaveCount(0, { timeout: 30_000 });

    // Validate: valid, and nothing anchored under the card or its steps.
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByTestId('draft-valid')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="intent-refusals-image_generation"], [data-testid^="intent-step-refusals-image_generation"]')).toHaveCount(0);

    await page.getByRole('button', { name: /^Activate draft as v/ }).click();
    await expect(page.getByTestId('assistant-draft')).toHaveCount(0, { timeout: 60_000 });

    const body = await activeBody(admin);
    const route = body.models?.byIntent?.image_generation ?? {};
    expect(route.image?.primary, 'the image model is in the route\'s image part').toBe(imageModel);
    expect(route.steps?.gather?.primary, 'the step override is under steps').toBe(gatherModel);
    expect(route.primary === imageModel, 'the image model is never the route\'s text model').toBe(false);
    expect(body.models?.image, 'the retired models.image is never written').toBeUndefined();
  });

  test('a turn in the gather step runs on the override, and Effectiveness reads the step with that model', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    expect(gatherModel, 'the draft test chose a step model').toBeTruthy();
    const conv = await openConversation(`Console steps ${MARK}`);
    const say = (text: string) => aws(`chime-sdk-messaging send-channel-message --channel-arn ${channelArnFor(conv.channelId)} --chime-bearer ${conv.personArn} --type STANDARD --persistence PERSISTENT --content "${encodeURIComponent(text)}"`);
    // Oldest first: the channel lists its messages newest first, and a reply is read by the turn it answers.
    const finals = () => messagesSeenBy(conv.channelId, conv.personArn).filter((m) => m.sender !== conv.personArn && m.metadata?.respPhase === 'final').reverse();
    let answered = 0;
    const next = async (text: string) => {
      say(text);
      const want = ++answered;
      for (const deadline = Date.now() + 6 * 60_000; Date.now() < deadline; await sleep(5_000)) {
        const f = finals();
        if (f.length >= want) return f[want - 1];
      }
      throw new Error(`no final reply to "${text.slice(0, 40)}"`);
    };

    await sleep(15_000);
    const asked = await next(`${MARK}: generate an image for our team newsletter.`);
    expect(asked.metadata?.activeTask?.type, 'the request opened an image task').toBe('image_generation');
    // The task is in gather when this turn starts, so the override serves it. No brief is confirmed, so nothing is drawn.
    const inGather = await next('Something about teamwork; I have not decided the details yet.');
    expect(Number(inGather.metadata?.imageCount ?? 0)).toBe(0);
    expect(modelKeyOf(inGather.metadata?.bedrockModel), 'the gather turn ran on the step override').toBe(gatherModel);

    // The step breakdown, as the API serves it under ?step=gather.
    let gather: any;
    let gatherCall: any;
    for (const deadline = Date.now() + 10 * 60_000; Date.now() < deadline && !(gather && gatherCall); await sleep(15_000)) {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, { queryType: 'intent_steps', intent: 'image_generation', step: 'gather', agentType: PROFILE, days: 1 });
      const rows = (j?.data ?? []) as any[];
      gather = rows.find((r) => r?.dimension === 'task_step' && r?.group_key === 'gather'
        && (r.models ?? []).some((m: string) => modelKeyOf(m) === gatherModel));
      // The turn's own model call, under the task step it started in.
      gatherCall = rows.find((r) => r?.dimension === 'step' && r?.task_step === 'gather' && r?.step_kind === 'model'
        && modelKeyOf(r.step_key) === gatherModel);
    }
    expect(gather, 'the gather task-step row names the override model').toBeDefined();
    expect(Number(gather.turns)).toBeGreaterThan(0);
    expect(Number(gather.cost_usd ?? 0), 'the step is priced from what it recorded').toBeGreaterThan(0);
    expect(gatherCall, 'the gather turn\'s model call is a step under gather').toBeDefined();
    expect(Number(gatherCall.calls)).toBeGreaterThan(0);

    // And on the Effectiveness page the step's link opens.
    await signInAsAdmin(page);
    await page.goto(`/?admin=effectiveness&as=${PROFILE}&intent=image_generation&step=gather`);
    const breakdown = page.getByTestId('intent-step-breakdown');
    await expect(breakdown).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('intent-step-filter')).toContainText('gather');
    await expect(page.getByTestId('intent-steps-table')).toContainText('gather', { timeout: 60_000 });
  });
});
