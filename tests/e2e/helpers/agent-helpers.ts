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

  // Wait for authenticated UI. Post the admin/chat split (DESIGN-SEPARATE-ADMIN-APP.md) this helper
  // signs into EITHER app: the chat SPA lands on `.app-header`, the admin console on
  // `.admin-dashboard`. Accept whichever renders.
  await page.waitForSelector('.app-header, .admin-dashboard', { timeout: 30000 });
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

  // Wait for the NEW conversation to actually become active before doing
  // anything else. The modal (NewConversationModal.handleSubmit) `await`s the
  // provider's createConversation — which creates the channel AND calls
  // setActiveConversation — and only THEN calls onClose(). So the modal
  // detaching is the authoritative "the new conversation is now active" signal.
  //
  // Without this wait the helper races: `.conversation-header` and the welcome
  // it checks next are BOTH still satisfied by the PREVIOUS conversation (its
  // header/messages linger until the new channel finishes creating), so the
  // helper would return and the caller's first `sendAndWaitForResponse` would
  // fill+Enter while the old conversation is still active — sending the message
  // to the WRONG channel (confirmed via trace: the Chime SendChannelMessage
  // POST targeted the prior channel's ARN). Gating on the modal close makes the
  // active-conversation swap a happens-before for the send.
  await page.locator('.ncm-modal').waitFor({ state: 'hidden', timeout: 5000 });

  // Wait for conversation to load
  await page.waitForSelector('.conversation-header', { timeout: 10000 });

  // The assistant greets when it is ADDED to the channel (Chime fires the per-classification
  // assistant's WelcomeIntent on the assistant joining, not on the creator's join). Waiting for it
  // here keeps a test's first real message and its answer from being conflated with that earlier
  // greeting.
  //
  // This ASSERTS rather than warns, and the budget is deliberately tight. The previous 30s
  // best-effort wait was padding around a real defect: the client dropped the welcome outright when
  // it arrived in the window between creating the channel and registering a listener, so the wait
  // could never succeed and the test shrugged and continued. That hid the bug for months AND, by
  // consuming most of the 120s test budget, produced unrelated-looking timeout failures further
  // down the same test.
  //
  // Measured cost of the welcome is 50ms to 1.7s of handler time (CloudWatch, 2026-07-31) plus
  // delivery, so 10s is generous. A welcome slower than that is a regression worth failing on, and
  // a missing one is the defect this assertion exists to catch.
  const welcomeLocator = page.locator('.assistant-message .message-text').first();
  await expect(
    welcomeLocator,
    'the assistant\'s on-add welcome must arrive; a missing welcome means the client dropped it '
      + '(see ConversationProvider: the single app-level channel handler) or the assistant never posted it',
  ).toBeVisible({ timeout: 10000 });

  // The on-add welcome must render as human text — never the raw Lex
  // fulfillment envelope (`{"Messages":[…]}`). Guards the frontend unwrap so
  // users never see raw JSON.
  const welcomeText = ((await welcomeLocator.textContent()) || '').trim();
  expect(welcomeText.startsWith('{') && welcomeText.includes('"Messages"')).toBe(false);
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
/**
 * A backend FAILURE the assistant posted into the channel as its reply.
 *
 * When Lex fulfillment errors or times out, Chime retries and then posts the raw error envelope -
 * `{"Code":429}` on throttle, `{"Code":403}` on an authorization failure - as the assistant's
 * message. It is a real, user-visible failure: the person sees JSON where an answer should be.
 *
 * Nothing used to look for it. The reply did not match the "answer" shape, so the wait loop simply
 * kept polling until the test's timeout, and the failure surfaced as `locator.fill: Target page
 * closed` - naming the teardown instead of the cause, minutes later. Detecting it here turns a
 * mystery timeout into an immediate, named failure.
 */
function backendErrorReply(text: string): string | null {
  const trimmed = text.trim();
  const m = trimmed.match(/^\{"Code"\s*:\s*(\d+)\}$/);
  if (m) return `the assistant posted a raw error envelope (HTTP ${m[1]}) instead of a reply`;
  // NOT an error: `{"Messages":[]}` is the router's DESIGNED silent response to a duplicate
  // fulfillment (ADR-022). Amazon Chime SDK retries a fulfillment that does not answer in time; the
  // retry derives the same correlation id, fails to claim `fulfil-<corr>`, and returns an empty
  // messages array so no second placeholder is produced. The client suppresses that envelope
  // (`isEmptyLexEnvelope`), so the user never sees it.
  //
  // This helper used to call it a backend failure, which was true before the dedup control existed and
  // is now exactly backwards: it fails the turn precisely when the duplicate-suppression is WORKING.
  // Observed live 2026-08-06 - fulfillment at 16:52:56 answered, its retry at 16:52:59 logged
  // `[Router] duplicate fulfillment suppressed` and returned this envelope, and the test reported a
  // backend failure on a turn the user saw answered exactly once.
  //
  // Treating it as "keep waiting" is right: the winning fulfillment's answer arrives on its own
  // placeholder, so the capture loop should ignore this frame and settle on the real reply.
  return null;
}

function looksLikeWelcomeOrEnvelope(text: string): boolean {
  if (!text) return false;
  return (
    /^\{"Messages"\s*:\s*\[\s*\]\s*\}$/.test(text.trim()) || // suppressed-duplicate silent envelope (ADR-022)
    /"Messages"\s*:\s*\[\s*\{\s*"Content"/.test(text) || // raw Lex-fulfillment JSON envelope
    text.includes('your assistant for this conversation') || // router/tier welcome (parsed)
    text.includes("I'm your AI assistant") || // basic welcome (parsed)
    text.includes("I'm your assistant at") // config-driven orientation welcome ("…assistant at <company>…")
  );
}

// Task-progress placeholders the backend posts SYNCHRONOUSLY while an async task
// runs, then REPLACES in place with the real answer (backend getTaskPlaceholder,
// lambda/src/lib/delivery-options.ts). Like the welcome, these are interim copy —
// the capture must keep waiting for the settled final reply, never return one, or
// a task turn reports the "Let me understand the issue..." placeholder as its
// answer. The UI appends animated dots, so normalize trailing dots before compare.
// Keep this set in sync with getTaskPlaceholder; a stale entry only costs one extra
// poll, never a false answer.
const TASK_PLACEHOLDERS = new Set([
  'let me understand the issue', 'analyzing the problem', 'finding solutions', 'looking into that',
  'understanding your data needs', 'extracting data', 'validating results', 'processing your request',
  'understanding your report needs', 'drafting outline', 'generating report', 'working on the report',
  'analyzing', 'working on that', 'one moment',
]);
export function looksLikeTaskPlaceholder(text: string): boolean {
  if (!text) return false;
  const norm = text.trim().toLowerCase().replace(/[.…\s]+$/, '');
  return TASK_PLACEHOLDERS.has(norm);
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

    // The socket sees the assistant's reply first, so this is the earliest possible point to catch a
    // backend failure - before the DOM settle loop spends the caller's whole timeout on it.
    const wsErr = backendErrorReply(text);
    if (wsErr) throw new Error(`[backend failure] ${wsErr}: ${text}`);

    // THE PHASE DECIDES WHEN THE FRAME DECLARES ONE. `looksLikeTaskPlaceholder` is a list of
    // placeholder SENTENCES, and it silently stopped covering the platform the moment a progress line
    // was written that nobody had added to it ("Tidying the document before delivering it..."). This
    // helper then returned mid-turn, the spec sent its next message into a turn still generating, and
    // the report was produced twice. The monitor now refuses any frame that declares a phase other
    // than `final`, so by the time this runs a phased frame is already the settled answer; the text
    // tests below remain for frames that carry no phase at all.
    const settledByPhase = wsTimings.responsePhase === 'final';
    if (text.length > 0 && text !== priorLastText
      && (settledByPhase || (!looksLikeWelcomeOrEnvelope(text) && !looksLikeTaskPlaceholder(text)))) {
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
    // Empty, the pre-send welcome, or a task-progress placeholder that will be
    // replaced in place — fall through to the DOM settle loop, which waits for the
    // real answer to land and stabilize instead of returning interim copy.
    console.warn(
      looksLikeTaskPlaceholder(text)
        ? `[sendAndWaitForResponse] WebSocket saw a task placeholder ("${text.slice(0, 40)}"); waiting for the settled reply via DOM`
        : '[sendAndWaitForResponse] WebSocket returned empty content',
    );
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
    // Fail NOW on a backend error the assistant posted as its reply, rather than polling until the
    // caller's timeout and reporting the teardown instead of the cause.
    const domErr = backendErrorReply(trimmed);
    if (domErr) throw new Error(`[backend failure] ${domErr}: ${trimmed}`);
    // IS THIS THE SETTLED ANSWER? ASKED STRUCTURALLY FIRST. The client renders the phase the backend
    // declared (`data-response-phase`, from `respPhase` in the message metadata), and only `final`
    // closes a turn - the runtime's own rule. A `placeholder` or `interim` message is work in
    // progress however finished its text looks.
    //
    // THE TEXT LIST BELOW COULD NOT KEEP UP. It matches known placeholder COPY, so when a delivering
    // turn began updating its message mid-flight ("Tidying the document before delivering it..."),
    // this loop saw a short, stable, unknown-to-the-list string and called it the answer - after
    // waiting the 400ms settle, which an interim line passes trivially because the model is still
    // generating. The caller returned, its spec sent the next message into a live turn, and the report
    // was produced twice. The list stays as a fallback for messages that carry no phase at all.
    // READ THE PHASE OFF THE SAME ELEMENT THE TEXT CAME FROM. `.assistant-message` alone also matches
    // the typing indicator (`message assistant-message thinking-indicator`), which renders LAST while
    // the bot is working and carries neither `.message-text` nor a phase - so `.last()` returned that
    // node, the attribute read as null, and this guard silently skipped exactly when it was needed.
    const lastPhase = await page.locator('.assistant-message:has(.message-text)').last()
      .getAttribute('data-response-phase');
    if (lastPhase) {
      // Only these two mean "still working". `final` is the answer, `interim` is a message the person
      // may have to act on (a duel's clarifying question), `error` ended their wait - all settle.
      expect(
        ['placeholder', 'progress'].includes(lastPhase),
        `still mid-turn (phase=${lastPhase}): "${trimmed.slice(0, 60)}"`,
      ).toBe(false);
    }
    // A task turn first renders a progress placeholder ("Let me understand the
    // issue...", "Extracting data...") that is later replaced in place. Keep
    // polling past ANY of them so the settled real answer is what we return,
    // not the interim — supersedes the old single "one moment" special-case.
    expect(looksLikeTaskPlaceholder(trimmed), `still on a task placeholder: "${trimmed}"`).toBe(false);
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
  // 200 chars is enough to eyeball a failure, and not enough to audit a PASS. A grounding
  // assertion is `mustContainAny`, so it is satisfied by the name appearing anywhere - including
  // one table row about somebody else, while the headline answer names a different person. That
  // difference is invisible at 200 chars, and a rate measured from truncated logs is a rate
  // measured from something other than the answer. E2E_FULL_REPLY=1 prints the whole reply.
  const body = process.env.E2E_FULL_REPLY === '1'
    ? response.text
    : `${response.text.substring(0, 200)}...`;
  console.log(`Response (${response.latencyMs}ms${wsLabel}): ${body}`);
  if (response.sawPlaceholder) console.log('Saw placeholder response');
  if (qualityIssues.length > 0) console.log(`Quality issues: ${qualityIssues.join('; ')}`);
  if (contentIssues.length > 0) console.log(`Content issues: ${contentIssues.join('; ')}`);
}
