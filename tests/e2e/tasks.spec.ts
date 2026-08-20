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
 * standard/premium-only one. Basic runs the FULL task loop too (taskSupport: 'full',
 * like every profile); what it lacks is the RICH processor output (richProcessor:
 * false) — no generated-document delivery — so a basic task tracks state and
 * grounds the reply inline rather than attaching a produced file. This suite
 * exercises the task path on basic, standard, AND premium.
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
import { signIn, createConversation, sendAndWaitForResponse, looksLikeTaskPlaceholder } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { assertNoDuplicateTasks, openAndValidateAttachment } from './helpers/task-validation';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


const RUN = process.env.TASKS_E2E === '1';
// A gate that STATES ITS REASON. `test.describe.skip` records none, so a run without the flag reports
// "6 skipped" and gives the reader nothing to act on (see e2e/reporters/skip-visibility.ts). Same
// effect, with the why attached.
const suite = test.describe;
const SKIP_REASON =
  'Set TASKS_E2E=1 (the validate.mjs "tasks" phase). This suite drives real multi-step tasks against a '
  + 'live deployment and reads them back through the admin analytics API.';
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
  test.skip(!RUN, SKIP_REASON);
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('tasks');

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

      // T1 regression window: tasks opened from this point on belong to THIS single ask.
      const testStart = Date.now() - 60_000; // 60s skew buffer (task is created slightly before the reply lands)
      // Send the report prompt. A TASK_MULTI_STEP turn posts progress then the
      // deliverable; we just need the turn to complete so the task is archived.
      const resp = await sendAndWaitForResponse(page, REPORT_PROMPT, 180_000);
      expect(resp.text && resp.text.length, `[${tc.tier}] the report turn must return a response`).toBeTruthy();

      // VACUITY GUARD (must come first). A TASK_MULTI_STEP turn posts a progress placeholder that is
      // later REPLACED in place. A placeholder carries no attachment and no sticky chip, so if the
      // capture returns one, every guard below passes without ever exercising its intent — which is
      // exactly how the doc-gen guard stayed green while the bug it was written for was live. Fail
      // loudly here instead, so a capture regression can never masquerade as coverage again.
      expect(
        looksLikeTaskPlaceholder(resp.text ?? ''),
        `[${tc.tier}] captured a task progress placeholder ("${resp.text}"), not the settled reply — `
          + 'the guards below would pass vacuously',
      ).toBe(false);

      // Regression guards for two live-found bugs (this is a 1:1 conversation with a report task):
      //  1. Doc-gen: a turn that ASKS the user for requirements is conversational text, NOT a
      //     downloadable file. Two live failures sit behind this. First, the gate keyed off
      //     isDocumentRequest(userMessage), which matches the user's "...report..." ask on every
      //     turn. Then the output gate (isDeliverableDocument) keyed on length + structure alone,
      //     so a verbose model's requirements questionnaire ("Please provide the following
      //     details:" + a numbered list) cleared the bar and was uploaded as report-*.md AND marked
      //     the task complete while it was still asking. Note the turn is NOT distinguishable by
      //     its Completed status: the bug set that too. Only the reply's own text tells them apart.
      const lastBotMsg = page.locator('.assistant-message').last();
      const replyText = (await lastBotMsg.innerText()).trim();
      const asksForDetails = /\?\s*$/.test(replyText)
        || /please (provide|share|confirm|specify)|let me know|the following (details|information)/i.test(replyText);
      if (asksForDetails) {
        await expect(
          lastBotMsg.locator('.attachment-display'),
          `[${tc.tier}] a report task's clarifying turn must be a chat message, not an attachment `
            + `(reply: "${replyText.slice(0, 160)}")`,
        ).toHaveCount(0);
      } else {
        // A genuine delivery turn MAY carry the file; if it does, it must be the report artifact.
        const attachments = lastBotMsg.locator('.attachment-display');
        if (await attachments.count() > 0) {
          await expect(
            attachments.first(),
            `[${tc.tier}] a delivered report attachment should be the report artifact`,
          ).toContainText(/report-.*\.md/);
        }
      }
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
      // Analytics API is IAM-enforced (adminIamEnforcement) — sign the request; Bearer JWT 403s.
      const q = async (queryType: string) => {
        const j = await signedAnalyticsPost(ANALYTICS_API, idToken!, { queryType, dateRange: { start: start.toISOString(), end: end.toISOString() } });
        return j.data || [];
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

      // T1 REGRESSION (no duplicate tasks per ask): a single report request must open exactly ONE task in
      // its conversation, not a duplicate (the getActiveTask strongly-consistent fallback). Scope to tasks
      // opened during THIS test (started_at >= testStart) of this type, grouped by conversation channel.
      assertNoDuplicateTasks(tasks as Array<Record<string, unknown>>, {
        type: 'report_generation',
        since: testStart,
        label: `[${tc.tier}]`,
      });

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

    // Open the presigned download and validate the CONTENT is a real report — catches an empty/garbage
    // report or a conversational turn saved as a file (the reported bug), regardless of plumbing being green.
    const report = await openAndValidateAttachment(page, attachment, {
      namePattern: /\.(md|markdown|txt|pdf)$/i,
      // A one-page report is roughly 500 words. 400 characters is two paragraphs, which an OUTLINE
      // clears comfortably - and an outline is exactly what has been delivered as the report before.
      minLength: 1200,
      mustMatch: [
        {
          re: /(^|\n)#{1,3}\s|\n\s*[-*]\s|\n\s*\d+\.\s/,
          because: 'the report must have markdown structure (headings / bullets / numbered sections)',
        },
        { re: /mono-?repo|multi-?repo|repositor/, because: 'the report must be ON-TOPIC (mono/multi-repo)', lower: true },
        // THE THREE THINGS THIS TEST ASKED FOR. Structure and a topic word are satisfied by a table of
        // section titles; covering the requested subjects is not. This is the cheapest assertion that
        // separates a report from a proposal to write one.
        { re: /velocity/, because: 'the report must cover DELIVERY VELOCITY, which the request named', lower: true },
        { re: /ownership/, because: 'the report must cover CODE OWNERSHIP, which the request named', lower: true },
        { re: /\bci\b|continuous integration|build (time|cost)/, because: 'the report must cover CI COST, which the request named', lower: true },
      ],
    });

    // SUBSTANCE, NOT SHAPE. Everything above can be satisfied by an outline: headings, a table, the
    // topic words, even the three subject names as section titles. What an outline does NOT have is
    // CONTENT-BEARING BLOCKS - lines long enough to argue something rather than to name a section.
    //
    // NOT "prose paragraphs", which was the first attempt and would have failed a good document. Asked
    // to be concise, the assistant says so explicitly - "bullet points over paragraphs, tight tables"
    // (measured, live) - so a correct 1-2 page report can carry almost no paragraphs at all. Bullets
    // are how it delivers substance at that length; what separates them from an outline's stubs is
    // LENGTH, because "Executive Headline | Q2 ARR result vs. target, one-line narrative" is 60
    // characters and a real finding runs to twice that.
    const blocks = report.split(/\n\s*\n/).map((p) => p.trim());
    const proseParagraphs = blocks
      .filter((p) => !/^#{1,6}\s/.test(p))          // not a heading
      .filter((p) => !/^\s*([-*]|\d+\.)\s/.test(p)) // not a bullet or numbered stub
      .filter((p) => !p.startsWith('|'))            // not a table
      .filter((p) => p.length >= 180);
    const substantiveBullets = report
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^([-*]|\d+\.)\s/.test(l))
      .filter((l) => l.length >= 140);
    const contentBlocks = proseParagraphs.length + substantiveBullets.length;
    // Printed so the floor above stays tied to what the product actually delivers rather than to an
    // estimate. The ask here is a CONCISE report and the assistant offers considerably longer ones, so
    // a run that only just clears the floor is worth seeing before anyone raises it.
    //
    // LENGTH CONFORMANCE IS NOT ASSERTED HERE, DELIBERATELY. Whether the document is the size the
    // person agreed to is a property of the AGREEMENT, and the agreement is not a string in the
    // transcript for a test to re-derive: it is a requirement the step collects and records when the
    // person confirms it. Until the task carries that value, an assertion here would be re-deriving a
    // promise from prose and calling the result a contract. See the ownership of `requires` in
    // SPEC-TASK-STATE-TRANSITIONS section 4.
    console.log(
      `--- delivered report: ${report.length} chars, ${proseParagraphs.length} prose paragraph(s) + `
        + `${substantiveBullets.length} substantive bullet(s) = ${contentBlocks} content block(s) `
        + '(floor 1200 chars / 3 blocks) ---',
    );
    expect(
      contentBlocks,
      'the report must contain ANALYSIS, not a section list: at least three content-bearing blocks - a '
        + `prose paragraph over 180 chars, or a bullet over 140. Found ${proseParagraphs.length} `
        + `paragraph(s) + ${substantiveBullets.length} bullet(s). An outline delivered as the report is `
        + 'the defect this asserts against, and it passes every structural check above.',
    ).toBeGreaterThanOrEqual(3);
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

    // Open the presigned download and validate the CONTENT is a real structured extraction — a markdown
    // table with the requested fields, on-topic (churn / at-risk accounts), not a conversational summary.
    const extracted = await openAndValidateAttachment(page, attachment, {
      namePattern: /\.(md|markdown|txt|csv)$/i,
      minLength: 200,
      mustMatch: [
        { re: /\|.*\|\s*\n\s*\|[-:\s|]+\|/, because: 'the extraction must be a markdown table (header row + separator rule)' },
        { re: /churn|at.risk|risk/, because: 'the extraction must be ON-TOPIC (churn / at-risk accounts)', lower: true },
      ],
    });

    // GROUNDED, NOT MERELY ON-TOPIC. The checks above are satisfied by any table containing the word
    // "risk", so on their own they cannot tell a real extraction from a plausible invention - and this
    // test's whole claim is that tier-scoped retrieval fed the answer. These assert the ROWS came from
    // the seeded records (`backend/demo/context/premium/customer-accounts.json`, `churnRisk`).
    //
    // Three of four, not four of four: the ask is "every at-risk enterprise account", and which rows
    // qualify as ENTERPRISE is the model's judgement over the corpus, not a fact this test owns. Three
    // is enough to prove the corpus was read while leaving that judgement room.
    const SEEDED_CHURN_ACCOUNTS = [
      'Coastal Health Systems',
      'Precision Analytics',
      'Greenfield Energy',
      'Urban Retail Group',
    ];
    const present = SEEDED_CHURN_ACCOUNTS.filter((a) => extracted.includes(a));
    expect(
      present.length,
      `the extraction must carry the SEEDED churn-risk accounts, so this proves retrieval rather than a `
        + `plausible-looking table. Found ${present.length}/4: [${present.join(', ')}]`,
    ).toBeGreaterThanOrEqual(3);

    // And the ARR the record carries, for at least one of them: the account NAME could be echoed from
    // the request's phrasing, a figure could not. Tolerant of $155K / $155,000 / 155000 formatting.
    const SEEDED_ARR = [155, 89, 120, 98];
    const arrHit = SEEDED_ARR.some((n) =>
      new RegExp(`\\$?\\s?${n}\\s?(k\\b|,000)`, 'i').test(extracted));
    expect(
      arrHit,
      `the extraction must carry at least one seeded ARR figure (${SEEDED_ARR.map((n) => `$${n}K`).join(', ')}), `
        + 'which a name alone does not prove',
    ).toBe(true);
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
