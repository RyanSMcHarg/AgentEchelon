import { test, expect } from '@playwright/test';
import {
  signIn,
  createConversation,
  sendAndWaitForResponse,
  validateBaseQuality,
  validateResponse,
  validateResponseTime,
  checkForTaskIndicator,
  logResult,
  assertBotResponse,
  BotResponse,
  WebSocketMonitor,
  ConsoleMonitor,
} from './helpers/agent-helpers';
import { getBasicUser, getStandardUser, getPremiumUser, getAdminUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signedAnalyticsPost } from './helpers/signed-analytics';
import { assistantResponseCount } from './helpers/drift-backend';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


test.describe.serial('Agent Intents — Basic Tier', () => {
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('agent-intents');

  let wsMonitor: WebSocketMonitor;
  let consoleMonitor: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getBasicUser();
    test.skip(!user.password, missingUserReason('basicUser'));
    wsMonitor = new WebSocketMonitor();
    consoleMonitor = new ConsoleMonitor();
    await signIn(page, user.email, user.password, wsMonitor, consoleMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('should create a new conversation', async ({ page }) => {
    await createConversation(page, 'E2E Basic Test', 'Claude Haiku');

    await expect(page.locator('.conversation-header')).toBeVisible({ timeout: 15000 });
    console.log('\n--- create-conversation ---');
    console.log('Conversation created successfully');

    consoleMonitor.assertNoErrors();
  });

  test('should receive greeting message in new conversation', async ({ page }) => {
    await createConversation(page, 'E2E Greeting Test', 'Claude Haiku');

    // The bot now ALWAYS welcomes on channel create — contextual when a
    // topic was supplied, generic otherwise (create-conversation
    // buildWelcome). We assert the generic-welcome path: a real bot
    // message should land within ~10s of creation, with non-empty text.
    const greeting = page.locator('.message .message-text').first();
    await expect(greeting).toBeVisible({ timeout: 15000 });

    const text = (await greeting.textContent()) || '';

    console.log('\n--- greeting-message ---');
    console.log(`Greeting: ${text.substring(0, 200)}`);

    expect(text.length).toBeGreaterThan(0);

    consoleMonitor.assertNoErrors();
  });

  test('general question — should answer a basic factual question', async ({ page }) => {
    // Capture the ARN so the reply COUNT can be read from the channel itself (below), not the DOM.
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, 'E2E General Q', 'Claude Haiku');
    const channelArn = (await (await createResp).json()).conversation.conversationArn as string;

    // Wait for conversation to be ready (greeting message visible)
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Let the add-triggered welcome land BEFORE the baseline is taken. The welcome is produced by a
    // different path (WelcomeIntent), so counting it as part of this turn would make the assertion
    // below fail for the wrong reason - and, worse, pass for the wrong reason if it raced the other way.
    await expect.poll(async () => assistantResponseCount(channelArn), { timeout: 30000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(3000);
    const botsBefore = await assistantResponseCount(channelArn);

    const response = await sendAndWaitForResponse(page, 'What is the capital of France?', 60000, wsMonitor);
    assertBotResponse(response, 'general-factual');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    // Shape only — NOT the trivia answer.
    //
    // Requiring 'Paris' assumes an UNGROUNDED assistant. A deployment with a seeded persona is
    // grounded to its own company and may answer world trivia or decline it as off-topic, and which
    // one it does is not deterministic: this exact assertion passed in two consecutive sweeps and
    // failed in the third, on identical code, purely on how the model chose to handle an off-topic
    // question that turn. A test that a working deployment fails at random is worse than no test.
    //
    // The off-topic rejection is DESIRED behaviour the grounding and drift specs assert positively,
    // so demanding the answer here put two suites in direct conflict. What this test can honestly
    // claim about a basic-tier turn is that it answered promptly, briefly and coherently; the intent
    // and model claims belong to the archive block at the foot of this file, which asserts them
    // exactly rather than through prose.
    const contentIssues = validateResponse(response.text, {
      maxSentences: 5,
      minLength: 10,
    });

    logResult('general-factual', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);
    expect(response.latencyMs).toBeLessThan(30000);

    // EXACTLY ONE assistant RESPONSE for one normal turn.
    //
    // This is the NORMAL Lex path: Chime materialises a placeholder from the Lex fulfillment response,
    // and the async processor UPDATES that same message in place with the answer. A second response
    // means a duplicate fulfillment produced its own placeholder and its own answer, which is the
    // defect the derived correlation id and the router's `fulfil-<corr>` claim exist to prevent
    // (ADR-022).
    //
    // RESPONSE, NOT MESSAGE. A long reply is split at the Chime content cap and its tail sent as
    // consecutive continuation messages (`handleLongResponse`), so one turn can legitimately add
    // several messages. Counting messages would report a duplicate for a reply that was merely long.
    // Both counts below therefore exclude continuations, which is also how the client groups them.
    //
    // Nothing else in the suite watched this. Every other reply assertion is about CONTENT (the text
    // came back, it was short enough, it was quick enough), all of which a duplicated reply satisfies
    // perfectly. `fulfillment-retry.spec.ts` asserts exactly-one only when the test itself injects a
    // duplicate; this asserts it for an ordinary turn nobody interfered with.
    //
    // The settle wait is load-bearing - a duplicate lands AFTER the winner, so counting the instant the
    // answer renders would miss exactly what this guards.
    await page.waitForTimeout(15000);

    // Backend truth: what the channel actually holds.
    const botsAfter = await assistantResponseCount(channelArn);
    console.log(`normal-path assistant responses: ${botsBefore} -> ${botsAfter}`);
    expect(botsAfter - botsBefore, 'one normal turn produced exactly one assistant response').toBe(1);

    // And what the user was actually shown. These can disagree: a client that rendered an in-place
    // UPDATE as a new bubble would show a duplicate the channel never held.
    const renderedResponses = await page.locator('.message.assistant-message:not(.continuation)').count();
    console.log(`normal-path rendered assistant responses: ${renderedResponses}`);
    expect(
      renderedResponses,
      'the DOM shows the same number of assistant responses the channel holds',
    ).toBe(botsAfter);

    consoleMonitor.assertNoErrors();
  });

  test('follow-up — should maintain conversation context', async ({ page }) => {
    await createConversation(page, 'E2E Context Test', 'Claude Haiku');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // A fact that exists ONLY in this conversation, and is not about the user's identity.
    //
    // The old probe established "My name is TestBot and I like purple elephants" and asked for it
    // back, which was the wrong shape twice over:
    //
    //  1. It did not isolate what it claims to test. The assistant already knows who the user is -
    //     it resolves their name from the profile and opens with it ("Hi Demo") - so "what is my
    //     name" is ambiguous between recall from THIS THREAD and an identity lookup. The test could
    //     pass with the context window completely broken.
    //  2. It asked the assistant to adopt a SELF-ASSERTED identity that contradicted the one it
    //     already had, and asserted it play along. Whether an assistant should accept "my name is X"
    //     from a user it knows to be someone else is a live product question, not something a
    //     context test should quietly settle by demanding one answer.
    //
    // A cutover date is unambiguous: nothing but this conversation could supply it, it is in-domain
    // so drift stays out of the way (the off-topic elephants triggered a "shifting topics" suggestion
    // and the follow-up was never answered at all), and getting it back proves the turn carried prior
    // context rather than re-derived something the platform already knew.
    const firstResponse = await sendAndWaitForResponse(
      page, 'I am reviewing the billing migration and the cutover date is March 14.', 60000, wsMonitor
    );
    assertBotResponse(firstResponse, 'context-setup');

    // Follow-up referencing prior context
    let response = await sendAndWaitForResponse(
      page, 'What cutover date did I mention?', 60000, wsMonitor
    );

    // DRIFT CAN INTERCEPT THIS TURN, and when it does the follow-up is never answered at all - the
    // reply is a "want me to start a separate conversation?" suggestion. It happens when the assistant
    // DEFLECTED the setup turn ("I do not have access to any information about a billing migration"),
    // so the summary never carried the topic and the follow-up reads as a pivot against it. That is
    // model-dependent, which made this test fail as a coin flip rather than on a defect.
    //
    // Declining keeps the thread and settles the drift decision, so the re-ask is answered normally.
    // The assertion itself is unchanged: the date must still come back, and it can still only come
    // from the previous turn.
    if (/shifting topics|separate conversation/i.test(response.text)) {
      console.log('[follow-up-context] drift intercepted the follow-up; declining and re-asking');
      await sendAndWaitForResponse(page, 'No, keep going here.', 60000, wsMonitor);
      response = await sendAndWaitForResponse(
        page, 'What cutover date did I mention?', 60000, wsMonitor
      );
    }

    assertBotResponse(response, 'follow-up-context');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    // The DATE is the whole assertion. It cannot be answered from the profile, the persona, or the
    // company context - only from the previous turn.
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['March 14', 'March 14th', 'march 14', '03/14', '3/14'],
    });

    logResult('follow-up-context', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });

  test('concise response — should not be overly verbose for simple questions', async ({ page }) => {
    await createConversation(page, 'E2E Concise Test', 'Claude Haiku');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(page, 'What is 2 + 2?', 60000, wsMonitor);
    assertBotResponse(response, 'concise-response');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['4', 'four'],
      maxSentences: 3,
    });

    logResult('concise-response', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });
});

test.describe.serial('Agent Intents — Standard Tier', () => {
  let wsMonitor: WebSocketMonitor;
  let consoleMonitor: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getStandardUser();
    test.skip(!user.password, missingUserReason('standardUser'));
    wsMonitor = new WebSocketMonitor();
    consoleMonitor = new ConsoleMonitor();
    await signIn(page, user.email, user.password, wsMonitor, consoleMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('analysis request — should provide detailed analysis', async ({ page }) => {
    await createConversation(page, 'E2E Analysis Test', 'Claude Sonnet');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(
      page,
      'Analyze the pros and cons of using microservices vs monolithic architecture.',
      90000,
      wsMonitor,
    );
    assertBotResponse(response, 'analysis-request');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['microservice', 'monolith', 'scalab', 'complex'],
      minLength: 100,
    });

    logResult('analysis-request', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });

  // NOTE: this is a UI smoke check (the task indicator is optional). The AUTHORITATIVE task-state
  // assertion — persisted taskState + a well-formed §6 stateHistory read from the source-of-truth
  // agent-tasks row — lives in task-state-machine.spec.ts (TASKS_E2E-gated, SPEC-TASK-STATE-TRANSITIONS).
  test('task tracking — should show task indicator for complex request', async ({ page }) => {
    // Complex-prompt Sonnet turns regularly stretch past Playwright's
    // default 120s test budget on cold start (the placeholder lands in 2-3s
    // but the UPDATE with the full reply can take 90-150s). Give the test
    // 4 minutes and the WS monitor 3, so we measure "did the bot actually
    // respond" instead of "did Bedrock happen to be warm."
    test.setTimeout(240000);

    await createConversation(page, 'E2E Task Tracking', 'Claude Sonnet');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(
      page,
      'Write a detailed comparison of Python and JavaScript for backend development.',
      180000,
      wsMonitor,
    );
    assertBotResponse(response, 'task-tracking');
    // Lenient latency budget — this test verifies task-indicator behavior,
    // not response speed. The Sonnet path on complex prompts can stretch
    // past the default 45s threshold under shared-account Bedrock load.
    validateResponseTime(response, { ttfrFailMs: 200_000, ttfrWarnMs: 30_000 });

    const taskIndicator = await checkForTaskIndicator(page);
    const qualityIssues = validateBaseQuality(response.text);

    logResult('task-tracking', response, qualityIssues);
    console.log(`Task indicator found: ${taskIndicator.found}`);
    if (taskIndicator.label) console.log(`Task label: ${taskIndicator.label}`);

    expect(qualityIssues).toHaveLength(0);
    // Task indicator is optional -- depends on whether the bot handler emits task metadata

    consoleMonitor.assertNoErrors();
  });

  test('code generation — should generate working code', async ({ page }) => {
    await createConversation(page, 'E2E Code Gen', 'Claude Sonnet');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(
      page,
      'Write a TypeScript function that reverses a string without using the built-in reverse method.',
      60000,
      wsMonitor,
    );
    assertBotResponse(response, 'code-generation');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['function', 'string', 'return'],
      minLength: 50,
      mustNotContain: ['<!--ACTIVE_TASK:', '<!--corr:'],
    });

    logResult('code-generation', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });
});

test.describe.serial('Agent Intents — Premium Tier', () => {
  let wsMonitor: WebSocketMonitor;
  let consoleMonitor: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));
    wsMonitor = new WebSocketMonitor();
    consoleMonitor = new ConsoleMonitor();
    await signIn(page, user.email, user.password, wsMonitor, consoleMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
  });

  test('should access Opus model', async ({ page }) => {
    await createConversation(page, 'E2E Opus Test', 'Claude Opus');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(
      page,
      'Explain the concept of quantum entanglement in simple terms.',
      90000,
      wsMonitor,
    );
    assertBotResponse(response, 'opus-model');
    validateResponseTime(response);

    // THE TEST'S OWN NAME IS A BACKEND CLAIM. Asserting the reply mentions "quantum" does not
    // establish which model produced it — a Haiku reply passes identically, and this test would
    // have stayed green through a routing regression that quietly served every premium turn on the
    // cheapest model. The turn's Metadata carries the model that actually ran it.
    const meta = wsMonitor.lastBotMetadata;
    const servedBy = String(meta?.bedrockModel ?? meta?.model ?? '');
    console.log(`\n--- opus-model served by ---\n${servedBy || '(no model in metadata)'}`);
    expect(
      servedBy,
      'the bot message carried no model attribution, so this test cannot verify the claim in its '
      + 'name. Check that the processor still stamps bedrockModel into message Metadata — the '
      + 'Effectiveness cost/model views read the same field.',
    ).not.toBe('');
    expect(
      servedBy.toLowerCase(),
      `a premium conversation was served by "${servedBy}", not an Opus model. The reply may well be `
      + 'good — that is the point: quality is not evidence of routing.',
    ).toContain('opus');

    const qualityIssues = validateBaseQuality(response.text);
    // Length and base quality only — NOT subject keywords.
    //
    // This used to require 'quantum'/'entangle'/'particle'/'state', which assumes the assistant
    // answers a physics question. On a GROUNDED deployment it correctly does not: the seeded persona
    // is an internal assistant for a specific company, and it declined with "I appreciate the
    // curiosity, but my role here ...". That is the off-topic rejection the drift and grounding specs
    // assert elsewhere as desired behaviour, so keeping the keyword check here meant two suites
    // demanding opposite things, and this one failing whenever grounding was working.
    //
    // The keyword check was never evidence for this test's claim anyway - its own comment above says
    // so: a Haiku reply mentioning "quantum" passes identically. The claim is the model attribution
    // asserted above, which is exact and cannot be satisfied by prose.
    const contentIssues = validateResponse(response.text, { minLength: 50 });

    logResult('opus-model', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });

  test('corporate travel — should engage the booking (action_item) flow', async ({ page }) => {
    // Exercises the corporate-travel booking example (the mock `search_corporate_travel`
    // executed tool + the generic action_item flow). The tool is OPT-IN, so:
    //  - Always: assert the assistant engages the request (gathers trip details or
    //    presents options) — this holds whether or not the tool is enabled.
    //  - Strict (E2E_TRAVEL_TOOL=true, i.e. the deployment set ENABLE_TRAVEL_TOOL +
    //    a book_travel intent pack): additionally assert it surfaces bookable options
    //    with a portal booking link.
    await createConversation(page, 'E2E Corporate Travel', 'Claude Opus');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(
      page,
      'I need to book corporate travel: round-trip from Seattle to New York, departing ' +
        '2026-08-10, returning 2026-08-13, economy for 1 traveler. What are my options?',
      90000,
      wsMonitor,
    );
    assertBotResponse(response, 'corporate-travel');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    // Engagement check (tool-agnostic): the reply is on-topic for a travel booking.
    const engagementIssues = validateResponse(response.text, {
      mustContainAny: ['flight', 'hotel', 'travel', 'trip', 'book', 'option', 'itinerary', 'fare'],
      minLength: 40,
    });

    logResult('corporate-travel', response, qualityIssues, engagementIssues);
    expect(qualityIssues).toHaveLength(0);
    expect(engagementIssues).toHaveLength(0);

    if (process.env.E2E_TRAVEL_TOOL === 'true') {
      // Tool enabled: expect concrete, policy-checked options + a portal booking link.
      const toolIssues = validateResponse(response.text, {
        mustContainAny: ['option', 'nonstop', 'policy', 'book'],
      });
      expect(toolIssues).toHaveLength(0);
      expect(response.text).toMatch(/https?:\/\/\S+/);
    }

    consoleMonitor.assertNoErrors();
  });

  test('no internal markers — should strip all metadata from display', async ({ page }) => {
    await createConversation(page, 'E2E Marker Strip', 'Claude Haiku');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(page, 'Tell me a short joke.', 60000, wsMonitor);
    assertBotResponse(response, 'no-internal-markers');
    validateResponseTime(response);

    // THIS ASSERTION WAS VACUOUS ON ITS OWN. "The joke reply contains no ACTIVE_TASK marker" is
    // satisfied both by stripping working AND by no marker ever existing on a one-shot joke turn —
    // and the second is the likely case, so the test proved nothing about stripping.
    //
    // Stripping happens CLIENT-side (frontend/packages/shared/src/utils/messageParser.ts): control
    // markers travel over the wire and the parser removes them for display. That makes the real
    // invariant observable from here — compare the RAW frame against the RENDERED text. When the
    // wire carried a marker and the display does not, stripping demonstrably ran.
    const raw = response.wsTimings?.responseContent ?? '';
    const MARKERS = ['<!--ACTIVE_TASK:', '<!--corr:', '<!--battle', '<!--sources:', '<!--suggestions:'];
    const onWire = MARKERS.filter((m) => raw.includes(m));

    if (onWire.length) {
      for (const m of onWire) {
        expect(
          response.text,
          `the wire carried ${m} and it survived into the rendered reply — the display parser did `
          + 'not strip it. Control markers in visible text are readable by the user and by a '
          + 'prompt-injection attempt reading its own transcript.',
        ).not.toContain(m);
      }
      console.log(`[markers] wire carried ${onWire.join(', ')}; display is clean — stripping ran`);
    } else {
      // Not a silent pass. Say plainly that the strong form did not run, so a reader does not
      // mistake this for proof that stripping works.
      console.log(
        '[markers] no control markers on the wire for this turn — only the weak absence check ran. '
        + 'The authoritative stripping coverage is messageParser.test.ts (unit).',
      );
    }

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustNotContain: ['<!--ACTIVE_TASK:', '<!--corr:', '<TASK_STATUS>'],
    });

    logResult('no-internal-markers', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });

  // (Removed) "admin dashboard — accessible for premium users" tested reaching the
  // admin console from INSIDE the chat app (the old embedded `?admin` model). The
  // admin console is now its own app (DESIGN-SEPARATE-ADMIN-APP.md) and is covered by
  // admin-dashboard.spec.ts / admin-dashboard-render.spec.ts against the admin origin.
});

// ─────────────────────────────────────────────────────────────────────────────
// The classifier and the router, asserted from the archive.
//
// WHY THIS BLOCK EXISTS. This file is the named coverage for SPEC-CONFIGURABLE-INTENT-PACK
// ("the taxonomy mechanism"), SPEC-CONTEXT-AWARE-MODEL-ROUTING and SPEC-MESSAGE-METADATA-CODEBOOK -
// and every test above it asserts the REPLY PROSE (`mustContainAny: ['function','string','return']`).
// Prose is downstream of everything those three specs actually claim. A turn can produce a perfect
// answer while the classifier emitted the wrong intent, the router picked the wrong model, or the
// metadata never landed, and not one assertion above would notice.
//
// The archive records what actually happened: `exchanges.intent` (what the classifier emitted) and
// the model that served the turn. Asserting a DELTA rather than an absolute count keeps this honest
// on a busy deployment - the environment is shared, so "there exist rows with intent X" proves
// nothing about THIS turn.
//
// TAXONOMY NOTE, since it is easy to get wrong: the intent-pack keys are `guided_troubleshooting`,
// `data_extraction`, `image_generation`, `report_generation` (+ the general/greeting fallbacks).
// `code_generation` is NOT one of them - that is a RouteKey from the model-strategy table, a
// different taxonomy. This block asserts the intent-pack key, which is what the spec it covers is
// about.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Agent Intents — the classifier reaches the archive', () => {
  guardBackendErrors('agent-intents-classifier');

  const ANALYTICS_API = process.env.VITE_ANALYTICS_API_URL || process.env.ANALYTICS_API_URL || '';

  const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || '';

  test('a data_extraction request is CLASSIFIED as data_extraction, not merely answered', async ({ page, browser }) => {
    test.setTimeout(420_000);
    test.skip(
      !ANALYTICS_API,
      'Needs VITE_ANALYTICS_API_URL (written into frontend/packages/admin/.env by gen-frontend-env).',
    );
    test.skip(!ADMIN_BASE_URL, 'Needs E2E_ADMIN_BASE_URL — the archive read is admin-plane.');

    const user = await getStandardUser();
    const admin = await getAdminUser();
    test.skip(!user.password, missingUserReason('standardUser'));
    test.skip(!admin.password, missingUserReason('testAdmin'));

    // The analytics API is ADMIN-PLANE. Reading it with the chat user's credentials returns
    // `{message: "...is not authorized to perform: execute-api:Invoke..."}` with NO `data` key - and
    // the first version of this test did `(j?.data ?? [])`, turning that authorization failure into
    // a count of 0. It then reported "the classifier never emitted data_extraction" when the truth
    // was "this identity cannot read the archive at all". Two fixes, and both matter: read as the
    // admin, and refuse to coerce an error body into an empty result.
    const adminCtx = await browser.newContext({ baseURL: ADMIN_BASE_URL });
    const adminPage = await adminCtx.newPage();
    let idToken = '';
    try {
      await signIn(adminPage, admin.email, admin.password);
      idToken = (await adminPage.evaluate(() => localStorage.getItem('idToken'))) || '';
      expect(idToken, 'admin idToken for the analytics read').toBeTruthy();
    } finally {
      await adminCtx.close();
    }

    const window = () => {
      const end = new Date();
      return { start: new Date(end.getTime() - 86_400_000).toISOString(), end: end.toISOString() };
    };
    const intentCount = async (key: string): Promise<number> => {
      const j = await signedAnalyticsPost(ANALYTICS_API, idToken, {
        queryType: 'intent_distribution',
        dateRange: window(),
      });
      // Fail loudly on anything that is not a result set. An error body has no `data`, and
      // defaulting it to [] is what made an auth failure look like a classifier failure.
      if (!Array.isArray(j?.data)) {
        throw new Error(
          `intent_distribution did not return a result set. This is an API/authorization failure, `
          + `NOT an empty archive - do not read it as "the intent was never emitted". Response: `
          + `${JSON.stringify(j).slice(0, 400)}`,
        );
      }
      const row = j.data.find((r: any) => String(r.intent) === key);
      return row ? Number(row.count) : 0;
    };

    const ws = new WebSocketMonitor();
    await signIn(page, user.email, user.password, ws);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    const before = await intentCount('data_extraction');
    console.log(`[intent] data_extraction before: ${before}`);

    await createConversation(page, `E2E Intent Extract ${Date.now()}`, 'Claude Sonnet');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Phrased to sit squarely inside the pack's data_extraction description (STRUCTURED / BULK),
    // not the single-fact GENERAL case the pack explicitly carves out (ADR-018).
    const reply = await sendAndWaitForResponse(
      page,
      'Extract the full employee roster as a table with name, role and team.',
      120_000,
      ws,
    );
    assertBotResponse(reply, 'intent-data-extraction');

    // Kinesis -> archival -> Aurora buffering routinely exceeds a minute (see tasks.spec.ts).
    let after = before;
    for (let i = 0; i < 30 && after <= before; i += 1) {
      await page.waitForTimeout(8000);
      after = await intentCount('data_extraction');
    }
    console.log(`[intent] data_extraction after: ${after}`);

    expect(
      after,
      'the archive never recorded a data_extraction exchange for a request that sits squarely in '
      + 'that intent. The reply may still have been fine - which is the point: every other test in '
      + 'this file would pass while the classifier emitted the wrong intent-pack key, and the '
      + 'delivery class that key selects would be wrong with it.',
    ).toBeGreaterThan(before);
  });
});
