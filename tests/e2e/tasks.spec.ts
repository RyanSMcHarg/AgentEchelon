/**
 * Multi-step task e2e (#32/#35 data / cluster E).
 *
 * PRODUCES REAL DATA: drives a report-generation prompt, which the intent pack
 * classifies as `report_generation` with delivery `TASK_MULTI_STEP`, so the
 * router opens a tracked task (router-agent-handler.createTask) and writes a
 * `task_id` onto the exchange. That is the data the Quality > Tasks tab reads
 * (task_metrics/task_details), and — once the eval runner's flow pass runs — it
 * is also what the Flows tab needs (intent_flows is grouped by task_id).
 *
 * ALL THREE TIERS run tasks. The router is the single Lex entry point for every
 * tier (deployed per-tier via TIER); tasks are a platform capability, not a
 * standard/premium-only one. Basic gets lightweight task support (its async
 * processor grounds the prompt + stamps task_id; the rich multi-step task-type
 * prompts stay a standard/premium enhancement). This suite exercises the task
 * path on basic, standard, AND premium.
 *
 * WHY testAdmin drives every tier: the analytics API is ADMIN-gated, so the
 * task_details read needs an admin token. testAdmin is premium AND in the admins
 * group, so it can also CREATE every tier's conversation — the conversation's
 * classification (Open/Standard/Premium) selects the tier's bot + handler
 * (effective tier = min(userTier, channelTier)), so an 'Open' conversation routes
 * to the BASIC handler even though testAdmin is premium. Using a tier user's token
 * instead would 401 the analytics read (they are not admins) — the reason an
 * earlier version of this test never actually reached its assertion.
 *
 * Gated by TASKS_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 *
 *   E2E_BASE_URL=<cf> TASKS_E2E=1 VITE_ANALYTICS_API_URL=<url> AWS_PROFILE=<p> \
 *     npx playwright test e2e/tasks.spec.ts --config=playwright.config.ts
 */
import { test, expect, request as pwRequest } from '@playwright/test';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';

const RUN = process.env.TASKS_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;
const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || '';

// A prompt the intent pack classifies as report_generation (delivery
// TASK_MULTI_STEP) — the words "report", "analysis", "compile" are its keywords,
// so both the LLM classifier (standard/premium) AND the keyword classifier
// (basic) emit report_generation → TASK_MULTI_STEP → createTask.
const REPORT_PROMPT =
  'Please compile a short report analyzing the pros and cons of a monorepo versus multi-repo for a 5-team org.';

// tier → the conversation classification card that binds the channel (and thus the
// handler) to that tier. testAdmin creates all three (premium sees every card).
const TIER_CASES: Array<{ tier: 'basic' | 'standard' | 'premium'; classification: string }> = [
  { tier: 'basic', classification: 'Open' },
  { tier: 'standard', classification: 'Standard' },
  { tier: 'premium', classification: 'Premium' },
];

suite('Multi-step task produces task_id data (Tasks + Flows) — all tiers', () => {
  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
    expect(ANALYTICS_API, 'VITE_ANALYTICS_API_URL must be set').toBeTruthy();
  });

  for (const tc of TIER_CASES) {
    test(`[${tc.tier}] a report request opens a tracked task and lands in task_details`, async ({ page }) => {
      test.setTimeout(420_000); // TASK_MULTI_STEP turn (up to 180s) + generous archival-lag poll

      // testAdmin (premium + admins group): creates this tier's conversation AND holds the
      // admin token the analytics read requires.
      await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
      await createConversation(page, `Task e2e ${tc.tier} ${Date.now()}`, tc.classification);

      // Send the report prompt. A TASK_MULTI_STEP turn posts progress then the
      // deliverable; we just need the turn to complete so the task is archived.
      const resp = await sendAndWaitForResponse(page, REPORT_PROMPT, 180_000);
      expect(resp.text && resp.text.length, `[${tc.tier}] the report turn must return a response`).toBeTruthy();

      // Regression guards for two live-found bugs (this is a 1:1 conversation with a report task):
      //  1. Doc-gen: the FIRST/clarifying turn of a report task is conversational text, NOT a
      //     downloadable file. The gate used to key off isDocumentRequest(userMessage), which matches
      //     the user's "...report..." request on every turn, so the clarifying questions were wrongly
      //     sent as an attachment. The report attachment must appear only on the delivery turn.
      const lastBotMsg = page.locator('.assistant-message').last();
      await expect(
        lastBotMsg.locator('.attachment-display'),
        `[${tc.tier}] a report task's clarifying turn must be a chat message, not an attachment`,
      ).toHaveCount(0);
      //  2. Sticky @-mention: in a 1:1 the assistant's reply is untargeted (AUTO delivery), so the
      //     sticky "replying to @assistant" chip must NOT appear (it did when the reply was wrongly
      //     stamped targetedSender). It should only set on a genuinely targeted, multi-party @-mention.
      await expect(
        page.locator('.message-input-sticky-target'),
        `[${tc.tier}] no sticky @-mention chip should appear after a 1:1 assistant reply`,
      ).toHaveCount(0);

      const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
      const api = await pwRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${idToken}` } });

      const end = new Date();
      const start = new Date(end.getTime() - 1 * 86_400_000);
      const q = async (queryType: string) => {
        const r = await api.post(ANALYTICS_API, { data: { queryType, dateRange: { start: start.toISOString(), end: end.toISOString() } } });
        return (await r.json()).data || [];
      };

      // Poll task_details until the task lands. The exchange reaches Aurora via
      // Kinesis→archival Lambda→Aurora, whose buffering can exceed a minute, so poll
      // generously (~150s) — a short window flakes even though the task is created
      // synchronously at send time (verified: it appears in task_details minutes later).
      let tasks: any[] = [];
      for (let i = 0; i < 25 && tasks.length === 0; i++) {
        tasks = await q('task_details');
        if (tasks.length === 0) await page.waitForTimeout(6000);
      }
      expect(tasks.length, `[${tc.tier}] task_details should have >=1 task after a report request`).toBeGreaterThan(0);

      // task_metrics should now roll it up too.
      const metrics = await q('task_metrics');
      expect(metrics.length, `[${tc.tier}] task_metrics should roll up the task`).toBeGreaterThan(0);

      await api.dispose();
      // Follow-up (separate assertion, may need the daily eval-runner to have run):
      // evaluation_flows (intent_flows grouped by task_id) should then score this flow.
    });
  }

  // OUTPUT VALIDITY (live-hardening): a DELIVERED report must be a real, substantial, on-topic report
  // document — not empty, not a conversational/clarifying turn wrongly saved as a file, not encoding
  // garbage. This drives the report task to delivery, downloads the attachment, and validates its
  // CONTENT (the plumbing tests above only prove a task row landed, not that the deliverable is valid).
  test('[premium] a delivered report is a valid, on-topic report document (content validated)', async ({ page }) => {
    test.setTimeout(600_000); // multi-turn report flow (collect -> outline -> generate) + download

    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    await createConversation(page, `Report validity ${Date.now()}`, 'Premium');

    // Kick off, then approve/answer each step until the model DELIVERS a downloadable document.
    await sendAndWaitForResponse(
      page,
      'Compile a concise 1-page report on the pros and cons of a monorepo vs multi-repo setup for a 5-team engineering org.',
      180_000,
    );
    const attachment = page.locator('.assistant-message .attachment-display').last();
    const approvals = [
      'Audience is engineering leadership. Focus on delivery velocity, code ownership, and CI cost. Keep it concise.',
      'The outline looks good — generate the full report now and deliver it as a downloadable document.',
      'Yes, generate and attach the report as a file.',
    ];
    let delivered = await attachment.isVisible({ timeout: 2000 }).catch(() => false);
    for (const a of approvals) {
      if (delivered) break;
      await sendAndWaitForResponse(page, a, 180_000);
      delivered = await attachment.isVisible({ timeout: 3000 }).catch(() => false);
    }
    expect(delivered, 'the report task must DELIVER a downloadable report document').toBe(true);

    // It must be a document (markdown/txt/pdf), not a spurious file type.
    const name = ((await attachment.locator('.attachment-name').textContent()) || '').trim();
    expect(name, `attachment name: "${name}"`).toMatch(/\.(md|markdown|txt|pdf)$/i);

    // Download (handleDownload → window.open the presigned S3 URL as a popup) and fetch the bytes.
    const [popup] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 30_000 }),
      attachment.locator('.attachment-file, .attachment-download-btn').first().click(),
    ]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const fileUrl = popup.url();
    await popup.close();
    expect(fileUrl, 'the download must open the presigned file URL').toMatch(/^https?:\/\//);
    const fileApi = await pwRequest.newContext();
    const fileResp = await fileApi.get(fileUrl);
    expect(fileResp.ok(), `presigned download must succeed (got ${fileResp.status()})`).toBeTruthy();
    const content = await fileResp.text();
    await fileApi.dispose();

    // Validate the CONTENT is a real report — this is what catches an empty/garbage report or a
    // conversational turn saved as a file (the reported bug), regardless of the plumbing being green.
    expect(content.length, 'the report document must be substantial (not empty/near-empty)').toBeGreaterThan(400);
    expect(content, 'the report must have markdown structure (headings / bullets / numbered sections)')
      .toMatch(/(^|\n)#{1,3}\s|\n\s*[-*]\s|\n\s*\d+\.\s/);
    expect(content.toLowerCase(), 'the report must be ON-TOPIC (mono/multi-repo)')
      .toMatch(/mono-?repo|multi-?repo|repositor/);
    // Not the clarifying questions saved as a file; and valid UTF-8 (no replacement/garbage chars).
    expect(content.toLowerCase(), 'the report must not be the clarifying questions')
      .not.toMatch(/a few quick questions|what should the report focus on|let me know your preferences/);
    expect(content, 'the report text must be valid UTF-8 (no replacement/garbage chars)').not.toContain('�');
  });

  // OUTPUT VALIDITY — data_extraction: an extraction task must hand back a real, structured, on-topic
  // data document (a markdown table of the requested records), delivered as a downloadable file — not a
  // conversational summary. Grounded in the seeded Stratum customer records (churn-risk accounts), so
  // it also proves tier-scoped RAG feeds the extraction. Same deterministic delivery path as reports.
  test('[premium] a data extraction delivers a valid, structured data document (content validated)', async ({ page }) => {
    test.setTimeout(600_000); // multi-turn extract -> format flow + download

    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    await createConversation(page, `Extraction validity ${Date.now()}`, 'Premium');

    await sendAndWaitForResponse(
      page,
      'Extract our enterprise customer accounts currently flagged as churn risk. Include the account '
        + 'name, ARR, and the reason each is at risk. Give it to me as a downloadable table.',
      180_000,
    );
    const attachment = page.locator('.assistant-message .attachment-display').last();
    const approvals = [
      'Pull from the customer accounts I have access to. Include every at-risk enterprise account, sorted by ARR descending.',
      'The results look right — format the final table and deliver it as a downloadable document.',
      'Yes, attach the extracted table as a file.',
    ];
    let delivered = await attachment.isVisible({ timeout: 2000 }).catch(() => false);
    for (const a of approvals) {
      if (delivered) break;
      await sendAndWaitForResponse(page, a, 180_000);
      delivered = await attachment.isVisible({ timeout: 3000 }).catch(() => false);
    }
    expect(delivered, 'the extraction task must DELIVER a downloadable data document').toBe(true);

    const name = ((await attachment.locator('.attachment-name').textContent()) || '').trim();
    expect(name, `attachment name: "${name}"`).toMatch(/\.(md|markdown|txt|csv)$/i);

    const [popup] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 30_000 }),
      attachment.locator('.attachment-file, .attachment-download-btn').first().click(),
    ]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const fileUrl = popup.url();
    await popup.close();
    expect(fileUrl, 'the download must open the presigned file URL').toMatch(/^https?:\/\//);
    const fileApi = await pwRequest.newContext();
    const fileResp = await fileApi.get(fileUrl);
    expect(fileResp.ok(), `presigned download must succeed (got ${fileResp.status()})`).toBeTruthy();
    const content = await fileResp.text();
    await fileApi.dispose();

    // Validate the CONTENT is a real structured extraction — a markdown table with the requested fields,
    // on-topic (churn / at-risk accounts), not a conversational summary, valid UTF-8.
    expect(content.length, 'the data document must be substantial (not empty/near-empty)').toBeGreaterThan(200);
    expect(content, 'the extraction must be a markdown table (header row + separator rule)')
      .toMatch(/\|.*\|\s*\n\s*\|[-:\s|]+\|/);
    expect(content.toLowerCase(), 'the extraction must be ON-TOPIC (churn / at-risk accounts)')
      .toMatch(/churn|at.risk|risk/);
    expect(content, 'the extraction text must be valid UTF-8 (no replacement/garbage chars)').not.toContain('�');
  });

  // guided_troubleshooting is an INTERACTIVE diagnostic task, NOT a document-producing one. It must
  // return a substantive diagnostic response (ask for symptoms / propose steps) and must NOT attach a
  // file — the regression guard that the downloadable-document gate is scoped to report/extraction only
  // and a troubleshooting turn is never wrongly saved as a file.
  test('[standard] a troubleshooting request gives a diagnostic response and attaches no file', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    await createConversation(page, `Troubleshoot ${Date.now()}`, 'Standard');

    const resp = await sendAndWaitForResponse(
      page,
      'Help me troubleshoot: a customer reports their StratumFlow workflow is broken and stopped '
        + 'running after they added a new connector. Where do we start?',
      180_000,
    );
    expect(resp.text && resp.text.length, 'the troubleshooting turn must return a response').toBeTruthy();

    // Diagnostic, not a document: NO downloadable attachment on a troubleshooting turn.
    const lastBot = page.locator('.assistant-message').last();
    await expect(
      lastBot.locator('.attachment-display'),
      'a troubleshooting turn must not attach a file (doc gate is report/extraction only)',
    ).toHaveCount(0);

    // Reads like an on-topic diagnostic — asks a question, proposes a step/check, or engages the
    // reported problem domain (workflow / connector / trigger). Lenient by design: the strict guard is
    // the no-file assertion above; here we only confirm the reply is a substantive, on-topic diagnostic
    // and not a generic deflection.
    expect(resp.text.length, 'the diagnostic reply should be substantive').toBeGreaterThan(60);
    expect(
      resp.text.toLowerCase(),
      'the response should be an on-topic diagnostic (question / step / engages the problem)',
    ).toMatch(/\?|step|check|first|which|confirm|log|reproduce|when|workflow|connector|trigger|running|issue|happen|start|gather|understand|diagnos|stratumflow/);
  });
});
