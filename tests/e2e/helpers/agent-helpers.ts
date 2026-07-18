import { Page, expect } from '@playwright/test';
import { WebSocketMonitor, WebSocketTimings, isPlaceholder } from './websocket-monitor';
import { ConsoleMonitor } from './console-monitor';

// Re-export monitors so tests can access them directly
export { WebSocketMonitor, WebSocketTimings } from './websocket-monitor';
export { ConsoleMonitor } from './console-monitor';
export { isPlaceholder } from './websocket-monitor';

export interface BotResponse {
  text: string;
  sawPlaceholder: boolean;
  latencyMs: number;
  allNewMessages: string[];
  /** WebSocket-based timings -- accurate per-event timestamps without polling overhead */
  wsTimings?: WebSocketTimings;
}

export interface ValidationOptions {
  mustContainAny?: string[];
  mustNotContain?: string[];
  maxSentences?: number;
  minLength?: number;
  expectTaskCreation?: boolean;
}

// ---- Response Time Enforcement ----

export interface ResponseTimeThresholds {
  /** TTFF warn threshold in ms -- logs a warning if exceeded */
  ttffWarnMs?: number;
  /** TTFF hard fail threshold in ms -- throws if exceeded */
  ttffFailMs?: number;
  /** TTFR warn threshold in ms -- logs a warning if exceeded */
  ttfrWarnMs?: number;
  /** TTFR hard fail threshold in ms -- throws if exceeded */
  ttfrFailMs?: number;
}

// Defaults — informational warn thresholds at the "healthy steady state"
// envelope; hard-fail thresholds at the "Bedrock is broken / processor is
// hung" envelope. These have to tolerate cold-start + shared-account
// throttling on complex prompts (Sonnet / Opus long generations regularly
// take 30–90s when Bedrock is warming up). A test that genuinely wants to
// assert a tight latency SLA can pass its own thresholds; the default's
// job is to catch real outages, not flake on busy days.
export const DEFAULT_RESPONSE_THRESHOLDS: ResponseTimeThresholds = {
  ttffWarnMs: 5_000,
  ttffFailMs: 30_000,
  ttfrWarnMs: 15_000,
  ttfrFailMs: 180_000,
};

/**
 * Validate agent response times against thresholds.
 * Uses WebSocket timings when available (accurate), falls back to DOM latency.
 *
 * - Exceeding a warn threshold logs a console.warn (visible in test output)
 * - Exceeding a fail threshold throws an error (fails the test)
 */
export function validateResponseTime(
  response: BotResponse,
  thresholds: ResponseTimeThresholds = DEFAULT_RESPONSE_THRESHOLDS,
): void {
  const ws = response.wsTimings;
  const ttff = ws?.ttffMs ?? null;
  const ttfr = ws?.ttfrMs ?? response.latencyMs;

  // TTFF checks (only when we have WebSocket data)
  if (ttff !== null) {
    if (thresholds.ttffFailMs && ttff > thresholds.ttffFailMs) {
      throw new Error(
        `Agent TTFF ${ttff}ms exceeds fail threshold (${thresholds.ttffFailMs}ms)`
      );
    }
    if (thresholds.ttffWarnMs && ttff > thresholds.ttffWarnMs) {
      console.warn(
        `[Agent TTFF] ${ttff}ms exceeds warn threshold (${thresholds.ttffWarnMs}ms)`
      );
    }
  }

  // TTFR checks
  if (thresholds.ttfrFailMs && ttfr > thresholds.ttfrFailMs) {
    throw new Error(
      `Agent TTFR ${ttfr}ms exceeds fail threshold (${thresholds.ttfrFailMs}ms)`
    );
  }
  if (thresholds.ttfrWarnMs && ttfr > thresholds.ttfrWarnMs) {
    console.warn(
      `[Agent TTFR] ${ttfr}ms exceeds warn threshold (${thresholds.ttfrWarnMs}ms)`
    );
  }
}

// ---- Navigation and Auth ----

/**
 * Navigate to the app and wait for it to load.
 */
export async function navigateToApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

/**
 * Register a new user account.
 */
export async function registerUser(
  page: Page,
  email: string,
  password: string,
  tier: string = 'basic'
): Promise<void> {
  await navigateToApp(page);

  // Click "Create account" link
  await page.locator('button:has-text("Create account")').click();
  await page.waitForSelector('input[type="email"]');

  // Fill registration form
  await page.locator('input[type="email"]').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#confirmPassword').fill(password);

  // Select tier if available
  const tierSelect = page.locator(`[data-tier="${tier}"], input[value="${tier}"]`);
  if (await tierSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
    await tierSelect.click();
  }

  // Submit
  await page.locator('button[type="submit"]').click();
}

/**
 * Sign in with email and password.
 *
 * @param monitor Optional WebSocketMonitor -- attaches before navigation
 *   to capture the Chime SDK WebSocket when the conversation loads.
 * @param consoleMonitor Optional ConsoleMonitor -- attaches before navigation
 *   to capture all browser console errors and warnings.
 */
export async function signIn(
  page: Page,
  email: string,
  password: string,
  monitor?: WebSocketMonitor,
  consoleMonitor?: ConsoleMonitor,
): Promise<void> {
  // Attach monitors BEFORE any navigation
  if (consoleMonitor) {
    consoleMonitor.attach(page);
  }
  if (monitor) {
    monitor.attach(page);
  }

  await navigateToApp(page);

  // Wait for login screen
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });

  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();

  // Wait for authenticated UI
  await page.waitForSelector('.app-header', { timeout: 30000 });
}

/**
 * Create a new conversation and wait for it to load.
 */
export async function createConversation(
  page: Page,
  title: string,
  classificationOrModel: string = 'Open'
): Promise<void> {
  // Click new conversation button. Use the class selector, NOT
  // button:has-text("New conversation") — the latter strict-matches the
  // sidebar "+ New conversation" button AND every channel item whose
  // auto-derived title is still the default "New conversation", which
  // accumulates across runs and throws a strict-mode violation.
  await page.locator('button.app-new-conversation-btn').click();
  await page.waitForSelector('.ncm-modal', { timeout: 5000 });

  // Select classification card — matches by classification name or model name
  // (card text contains both, e.g. "Open Claude Haiku Public information only...")
  const classCard = page.locator(`.ncm-class-card:has-text("${classificationOrModel}")`);
  if (await classCard.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await classCard.first().click();
  } else {
    // Click the first available classification
    await page.locator('.ncm-class-card').first().click();
  }

  // Title input was removed in commit 8377f1c (auto-derive title
  // from first user message). The `title` argument is retained for caller
  // intent / log readability but is no longer filled into the modal.
  void title;

  // Submit
  await page.locator('button:has-text("Create Conversation")').click();

  // Wait for conversation to load
  await page.waitForSelector('.conversation-header', { timeout: 15000 });

  // Confirm the assistant's welcome before returning. The bot greets when the
  // ASSISTANT joins the channel (Chime fires the per-tier bot's WelcomeIntent on
  // the assistant being added, NOT on the creator's join) — correct product
  // behaviour, but the greeting can land
  // a beat AFTER the conversation view renders (cold Lambda + context lookup).
  // Waiting for it here means a test's first real message and its answer are
  // never conflated with the separate, earlier welcome. Best-effort: a 30s
  // budget covers a cold welcome; if none shows we proceed (the per-test
  // response wait still asserts the actual answer) rather than fail on the
  // greeting alone.
  const welcomeLocator = page.locator('.assistant-message .message-text').first();
  const welcomeAppeared = await welcomeLocator
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => {
      console.warn('[createConversation] No welcome message appeared within 30s');
      return false;
    });
  if (welcomeAppeared) {
    // The on-add welcome must render as human text — never the raw Lex
    // fulfillment envelope (`{"Messages":[…]}`). Guards the frontend unwrap so
    // users never see raw JSON.
    const welcomeText = ((await welcomeLocator.textContent()) || '').trim();
    expect(welcomeText.startsWith('{') && welcomeText.includes('"Messages"')).toBe(false);
  }
}

/**
 * True if `text` is the assistant's add-triggered WELCOME (in any form) rather
 * than an answer to a user message. The welcome is produced by the Lex
 * fulfillment, which Chime posts as a JSON envelope `{"Messages":[{"Content":…}]}`
 * — and the frontend renders that envelope inconsistently (sometimes raw,
 * sometimes parsed), so the WS-captured form (raw) can differ from the DOM
 * form (parsed). Excluding by signature (matching BOTH the raw envelope and the
 * parsed greeting copy) is robust where an exact-text compare leaks. Real
 * answers are posted clean via UpdateChannelMessage, so they never match.
 */
function looksLikeWelcomeOrEnvelope(text: string): boolean {
  if (!text) return false;
  return (
    /"Messages"\s*:\s*\[\s*\{\s*"Content"/.test(text) || // raw Lex-fulfillment JSON envelope
    text.includes('your assistant for this conversation') || // router/tier welcome (parsed)
    text.includes("I'm your AI assistant") // basic welcome (parsed)
  );
}

/**
 * Send a message and wait for bot response.
 *
 * When a WebSocketMonitor is provided, uses WebSocket-based detection as the
 * primary path for accurate latency measurement. Falls back to DOM polling
 * when WebSocket is not available.
 *
 * @param monitor Optional WebSocketMonitor for accurate latency measurement
 */
export async function sendAndWaitForResponse(
  page: Page,
  message: string,
  timeoutMs: number = 60000,
  monitor?: WebSocketMonitor,
): Promise<BotResponse> {
  // Start WebSocket monitoring BEFORE sending the message
  const wsPromise = monitor?.startMonitoring(timeoutMs);

  const start = Date.now();

  // The assistant's add-triggered welcome is already on screen (createConversation
  // waited for it). Record it so neither the WS nor DOM path mistakes that
  // earlier greeting for the answer to THIS message.
  const priorLastText = (
    (await page.locator('.assistant-message .message-text').last().textContent().catch(() => '')) || ''
  ).trim();

  // Type and send message
  await page.locator('.message-textarea').fill(message);
  await page.keyboard.press('Enter');
  console.log(`Sent: "${message}"`);

  // -- Primary path: WebSocket-driven --
  // Listen for the bot response via WebSocket, then confirm it rendered in the UI.
  if (wsPromise && monitor?.connected) {
    const wsTimings = await wsPromise;
    const elapsed = Date.now() - start;
    const text = wsTimings.responseContent
      .replace(/<!--[a-zA-Z_]+(?::[^>]*)?-->/gs, '')
      .trim();

    if (text.length > 0 && text !== priorLastText && !looksLikeWelcomeOrEnvelope(text)) {
      const ttfrLabel = wsTimings.ttfrMs ? ` [TTFR: ${wsTimings.ttfrMs}ms]` : '';
      console.log(`Response (${elapsed}ms${ttfrLabel}): "${text.substring(0, 80)}..."`);

      // Confirm the message rendered in the UI
      const snippet = text.substring(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await expect(page.locator(`.message-text:has-text("${snippet.substring(0, 20)}")`).last())
        .toBeVisible({ timeout: 5000 })
        .catch(() => console.warn('[sendAndWaitForResponse] WS response received but not found in DOM'));

      return {
        text,
        sawPlaceholder: wsTimings.ttffMs !== null && wsTimings.ttfrMs !== null && !wsTimings.isDirect,
        latencyMs: elapsed,
        allNewMessages: [],
        wsTimings,
      };
    }
    console.warn('[sendAndWaitForResponse] WebSocket returned empty content');
  }

  // -- Fallback: DOM polling --
  // The previous fallback counted `.message` elements and waited for the
  // count to grow past existingMessages+1. That was broken-by-design: the
  // bot's UPDATE replaces the placeholder's content but does NOT add a new
  // DOM node, so the count can never reach that threshold in the normal
  // happy path. The test only ever passed via the WebSocket primary path;
  // the fallback would have failed any time the WS monitor missed the
  // UPDATE event (Bedrock slow, WS reconnect, etc.).
  //
  // Wait instead for the LAST `.message .message-text` to leave the
  // placeholder state (more than a few words AND not the "One moment…"
  // copy). This is robust to in-place UPDATE vs separate-message bot
  // replies, and it actually verifies "the bot answered" rather than
  // "another DOM node showed up."
  await expect(async () => {
    const lastText =
      (await page.locator('.assistant-message .message-text').last().textContent()) || '';
    const trimmed = lastText.trim();
    // The arrival signal is "the placeholder was replaced by a real answer",
    // NOT an absolute length. A correct terse reply (e.g. "4" to "2 + 2") is
    // legitimately 1 char, so a length floor would reject exactly the concise
    // answers some tests deliberately solicit. Placeholder/welcome detection is
    // handled by the three checks below; a length gate added nothing but that
    // false negative.
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.toLowerCase()).not.toContain('one moment');
    // Must be a genuinely NEW bot reply, not the pre-send welcome re-read
    // (exact match) nor the welcome in any other rendered/envelope form.
    expect(trimmed).not.toBe(priorLastText);
    expect(looksLikeWelcomeOrEnvelope(trimmed)).toBe(false);
    // Settle: the same value must persist on a re-read a beat later, so a
    // still-streaming partial can't satisfy the gate prematurely (the guard the
    // length floor loosely stood in for).
    await page.waitForTimeout(400);
    const reread =
      ((await page.locator('.assistant-message .message-text').last().textContent()) || '').trim();
    expect(reread).toBe(trimmed);
  }).toPass({ timeout: timeoutMs });

  // Capture the final last-message text for the caller's assertions.
  const lastMessage = page.locator('.assistant-message .message-text').last();
  const text = (await lastMessage.textContent()) || '';
  const latencyMs = Date.now() - start;
  console.log(`Response (${latencyMs}ms DOM): "${text.substring(0, 80)}..."`);

  return {
    text,
    sawPlaceholder: false,
    latencyMs,
    allNewMessages: [],
  };
}

// ---- Validation ----

/**
 * Validate base quality of a bot response -- no tone issues.
 */
export function validateBaseQuality(response: string): string[] {
  const issues: string[] = [];

  if (!response || response.trim().length === 0) {
    issues.push('Empty response');
    return issues;
  }

  // Check for banned opening phrases
  const bannedOpenings = [
    /^great[,!]/i,
    /^wonderful/i,
    /^awesome/i,
    /^fantastic/i,
    /^absolutely[,!]/i,
  ];
  for (const pattern of bannedOpenings) {
    if (pattern.test(response.trim())) {
      issues.push(`Banned opening phrase: ${response.trim().split(/[,!.\s]/)[0]}`);
    }
  }

  // Check for internal markers that should have been stripped
  if (response.includes('<!--ACTIVE_TASK:')) {
    issues.push('Contains unstripped ACTIVE_TASK marker');
  }
  if (response.includes('<!--corr:')) {
    issues.push('Contains unstripped correlation ID marker');
  }

  return issues;
}

/**
 * Validate response content against expectations.
 */
export function validateResponse(
  response: string,
  options?: ValidationOptions
): string[] {
  const issues: string[] = [];
  if (!options) return issues;

  const lower = response.toLowerCase();

  if (options.mustContainAny && options.mustContainAny.length > 0) {
    const found = options.mustContainAny.some((kw) => lower.includes(kw.toLowerCase()));
    if (!found) {
      issues.push(
        `Missing expected keywords: ${options.mustContainAny.join(', ')}`
      );
    }
  }

  if (options.mustNotContain) {
    for (const banned of options.mustNotContain) {
      if (lower.includes(banned.toLowerCase())) {
        issues.push(`Contains banned phrase: "${banned}"`);
      }
    }
  }

  if (options.maxSentences) {
    const sentenceCount = response.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
    if (sentenceCount > options.maxSentences) {
      issues.push(
        `Too many sentences: ${sentenceCount} > ${options.maxSentences}`
      );
    }
  }

  if (options.minLength && response.length < options.minLength) {
    issues.push(`Response too short: ${response.length} < ${options.minLength}`);
  }

  return issues;
}

/**
 * Assert that the agent actually responded.
 */
export function assertBotResponse(response: BotResponse, context: string = 'Agent response') {
  expect(
    response.text.length,
    `${context}: No agent response received (${response.latencyMs}ms)`
  ).toBeGreaterThan(0);
}

// ---- Task and State Checks ----

/**
 * Check for task status indicator in the conversation.
 */
export async function checkForTaskIndicator(
  page: Page
): Promise<{ found: boolean; label?: string }> {
  const indicator = page.locator('.task-status-indicator').last();
  const found = await indicator.isVisible({ timeout: 3000 }).catch(() => false);

  if (found) {
    const label = await indicator.locator('.task-status-label').textContent();
    return { found: true, label: label || undefined };
  }

  return { found: false };
}

/**
 * Check if connection status shows connected.
 */
export async function isConnected(page: Page): Promise<boolean> {
  // ConnectionStatus only renders when disconnected
  const disconnected = page.locator('.connection-status--disconnected');
  const isDisconnected = await disconnected.isVisible({ timeout: 2000 }).catch(() => false);
  return !isDisconnected;
}

/**
 * Log test result for reporting.
 */
export function logResult(
  testId: string,
  response: BotResponse,
  qualityIssues: string[],
  contentIssues: string[] = []
): void {
  console.log(`\n--- ${testId} ---`);
  const wsLabel = response.wsTimings?.ttfrMs ? ` [TTFR: ${response.wsTimings.ttfrMs}ms]` : '';
  console.log(`Response (${response.latencyMs}ms${wsLabel}): ${response.text.substring(0, 200)}...`);
  if (response.sawPlaceholder) console.log('Saw placeholder response');
  if (qualityIssues.length > 0) console.log(`Quality issues: ${qualityIssues.join('; ')}`);
  if (contentIssues.length > 0) console.log(`Content issues: ${contentIssues.join('; ')}`);
}
