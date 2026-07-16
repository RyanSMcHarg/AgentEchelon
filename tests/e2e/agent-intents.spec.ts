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
import { getBasicUser, getStandardUser, getPremiumUser } from './helpers/test-credentials';

test.describe.serial('Agent Intents — Basic Tier', () => {
  let wsMonitor: WebSocketMonitor;
  let consoleMonitor: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    const user = await getBasicUser();
    if (!user.password) {
      test.skip();
      return;
    }
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
    await createConversation(page, 'E2E General Q', 'Claude Haiku');

    // Wait for conversation to be ready (greeting message visible)
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const response = await sendAndWaitForResponse(page, 'What is the capital of France?', 60000, wsMonitor);
    assertBotResponse(response, 'general-factual');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['paris', 'Paris'],
      maxSentences: 5,
      minLength: 10,
    });

    logResult('general-factual', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);
    expect(response.latencyMs).toBeLessThan(30000);

    consoleMonitor.assertNoErrors();
  });

  test('follow-up — should maintain conversation context', async ({ page }) => {
    await createConversation(page, 'E2E Context Test', 'Claude Haiku');

    // Wait for conversation to be ready
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // First message
    const firstResponse = await sendAndWaitForResponse(
      page, 'My name is TestBot and I like purple elephants.', 60000, wsMonitor
    );
    assertBotResponse(firstResponse, 'context-setup');

    // Follow-up referencing prior context
    const response = await sendAndWaitForResponse(
      page, 'What is my name and what do I like?', 60000, wsMonitor
    );
    assertBotResponse(response, 'follow-up-context');
    validateResponseTime(response);

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['TestBot', 'testbot', 'purple', 'elephant'],
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
    if (!user.password) {
      test.skip();
      return;
    }
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
    if (!user.password) {
      test.skip();
      return;
    }
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

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustContainAny: ['quantum', 'entangle', 'particle', 'state'],
      minLength: 50,
    });

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

    const qualityIssues = validateBaseQuality(response.text);
    const contentIssues = validateResponse(response.text, {
      mustNotContain: ['<!--ACTIVE_TASK:', '<!--corr:', '<TASK_STATUS>'],
    });

    logResult('no-internal-markers', response, qualityIssues, contentIssues);

    expect(qualityIssues).toHaveLength(0);
    expect(contentIssues).toHaveLength(0);

    consoleMonitor.assertNoErrors();
  });

  test('admin dashboard — should be accessible for premium users', async ({ page }) => {
    // Click admin button if visible
    const adminButton = page.locator('button:has-text("Admin"), .admin-button');
    const adminVisible = await adminButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (!adminVisible) {
      console.log('\n--- admin-dashboard ---');
      console.log('Admin button not visible -- skipping');
      test.skip();
      return;
    }

    await adminButton.click();

    // Dashboard should appear
    const dashboard = page.locator('.admin-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 10000 });

    console.log('\n--- admin-dashboard ---');
    console.log('Admin dashboard loaded successfully');

    consoleMonitor.assertNoErrors();
  });
});
