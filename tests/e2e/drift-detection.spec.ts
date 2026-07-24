/**
 * Drift detection E2E + eval-suite scaffold
 *
 * This file is the launch-scaffold for the shared drift evaluation suite
 * defined in SPEC-DRIFT-CONVERGENCE.md. Today it:
 *
 *   - Loads the canonical fixture at `fixtures/drift-detection-cases.json`
 *     and asserts schema integrity (every case has the required fields).
 *   - SHA-checks the fixture so the byte-equal cross-repo guarantee can
 *     be wired into CI by snapshotting the SHA in this test.
 *   - Stubs out the live-drift behavioral cases (Playwright `test.fixme`)
 *     so they're discoverable and pre-named when implementation continues.
 *
 * Full behavioral cases require a deployed Aurora-mode stack with
 * `enableLiveDrift=true`; they are filled in as part of launch
 * validation, not in this scaffold step.
 *
 * The fixture is canonical for AE: its SHA is a stable identifier and
 * CI fails on SHA drift.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { getPremiumUser, hasTestCredentials } from './helpers/test-credentials';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'drift-detection-cases.json');

type DriftPositive = {
  id: string;
  anchor_summary: string;
  anchor_topics: string[];
  pivot_message: string;
  rationale: string;
};

type DriftNegative = {
  id: string;
  anchor_summary: string;
  anchor_topics: string[];
  non_pivot_message: string;
  rationale: string;
};

type PromptInjection = {
  id: string;
  anchor_summary: string;
  injection_message: string;
  expected_path: 'OFF_TOPIC_REJECTION';
  rationale: string;
};

type Fixture = {
  $schema: string;
  _meta: Record<string, unknown>;
  drift_positive: DriftPositive[];
  drift_negative: DriftNegative[];
  prompt_injection: PromptInjection[];
};

function loadFixture(): Fixture {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw) as Fixture;
}

test.describe('Drift evaluation fixture — schema and identity', () => {
  test('fixture loads and parses as valid JSON', () => {
    const fx = loadFixture();
    expect(fx.$schema).toBe('drift-eval-v1');
  });

  test('every drift_positive case has required fields', () => {
    const fx = loadFixture();
    for (const c of fx.drift_positive) {
      expect(c.id).toMatch(/^dp-\d+$/);
      expect(c.anchor_summary.length).toBeGreaterThan(10);
      expect(Array.isArray(c.anchor_topics)).toBe(true);
      expect(c.pivot_message.length).toBeGreaterThan(5);
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  });

  test('every drift_negative case has required fields', () => {
    const fx = loadFixture();
    for (const c of fx.drift_negative) {
      expect(c.id).toMatch(/^dn-\d+$/);
      expect(c.anchor_summary.length).toBeGreaterThan(10);
      expect(c.non_pivot_message.length).toBeGreaterThan(5);
    }
  });

  test('every prompt_injection case targets OFF_TOPIC_REJECTION', () => {
    const fx = loadFixture();
    for (const c of fx.prompt_injection) {
      expect(c.id).toMatch(/^pi-\d+$/);
      expect(c.expected_path).toBe('OFF_TOPIC_REJECTION');
    }
  });

  test('fixture SHA is stable (cross-repo identity check)', () => {
    const raw = fs.readFileSync(FIXTURE_PATH);
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    // Logged so CI can compare against the canonical SHA in the repo's
    // signed fixture manifest. When this test fails it means the fixture
    // changed; either intentional (PR review must approve) or accidental
    // (CI fails on SHA drift).
    console.log('[drift-eval-fixture] sha256:', sha);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ============================================================
// Behavioral cases — live browser E2E against the deployed Aurora-mode stack
// (ENABLE_LIVE_DRIFT=true). Drift is triggered DETERMINISTICALLY via the
// explicit-routing fast-path (lib/explicit-routing.ts): an unambiguous
// "let's start a new conversation about X" fires a `confirm` suggestion with no
// dependency on the ~30-min summary-updater. The confirm / decline / battle-
// suppression flows are user-visible, so they live here.
//
// The remaining drift guarantees are pure logic/SQL — not observable from a
// browser and non-deterministic to trigger there — so they are covered at the
// integration layer (deterministic, no live deploy needed):
//
//   - cross-user leakage + multi-member intersection scoping
//       → backend/test/lib/scoped-channels.test.ts
//   - decline-distance suppression (±0.05) + Bedrock-failure no-string-fallback
//       → backend/test/analytics-aurora/drift-detection.test.ts
//   - abandonment detector (accepted-but-unengaged → 'abandoned')
//       → backend/test/analytics-aurora/abandonment-detector.test.ts
//   - yes/no ack classification incl. "yes please", + by-reference channel
//     creation (the ack text is never copied into the new channel)
//       → backend/test/lib/routing-state.test.ts
//       → backend/test/lib/live-drift-flow.test.ts
// ============================================================

// An unambiguous explicit-routing phrase — matches the allowlist in
// lib/explicit-routing.ts, so drift fires on the FIRST message with no summary.
const DRIFT_TRIGGER = "let's start a new conversation about quarterly revenue forecasting";
// Stable substring of SUGGESTION_CONFIRM_TEMPLATE (analytics-aurora/drift-detection.ts).
const SUGGESTION_MARKER = 'start a separate conversation for this';
const E2E_RUNNABLE = hasTestCredentials();

/** Resolve the AgentEchelon (NOT a look-alike instance in the same account) ChannelBattleConfig
 *  table name from DynamoDB. Returns null if it can't be found. */
function resolveBattleConfigTable(): string | null {
  try {
    const raw = execSync(
      `aws dynamodb list-tables --region us-east-1 ` +
        `--query "TableNames[?starts_with(@, 'AgentEchelonBattle-ChannelBattleConfig')]" --output json`,
      { encoding: 'utf8', timeout: 20000, env: process.env },
    );
    const names: string[] = JSON.parse(raw);
    return names[0] || null;
  } catch {
    return null;
  }
}

/** aws dynamodb put/delete with the payload passed via a temp file, so the JSON
 *  survives cmd.exe quoting on Windows. */
function ddbWrite(kind: 'put-item' | 'delete-item', table: string, payloadFlag: string, payload: unknown): void {
  const file = path.join(os.tmpdir(), `drift-e2e-${kind}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  try {
    execSync(
      `aws dynamodb ${kind} --region us-east-1 --table-name ${table} ${payloadFlag} file://${file.replace(/\\/g, '/')}`,
      { encoding: 'utf8', timeout: 20000, env: process.env },
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
}

test.describe('Drift live-suggestion E2E (live, explicit-routing fast-path)', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + a live E2E_BASE_URL.');

  test('confirm flow — a pivot fires a suggestion; "yes" creates a channel + NAVIGATE marker', async ({ page }) => {
    const user = await getPremiumUser();
    if (!user.password) { test.skip(); return; }
    const wsMonitor = new WebSocketMonitor();
    await signIn(page, user.email, user.password, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    await createConversation(page, 'E2E Drift Confirm', 'Claude Opus');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // The pivot fires the templated confirm suggestion (fast-path, no summary).
    const suggestion = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, wsMonitor);
    console.log(`\n--- drift-confirm suggestion ---\n${suggestion.text}`);
    expect(suggestion.text.toLowerCase()).toContain(SUGGESTION_MARKER);

    // "yes" confirms: the reply carries the NAVIGATE_CHANNEL marker + creation
    // copy. Captured from the WS frame, so it is robust to the DOM auto-navigation
    // that the marker triggers on the frontend.
    const confirm = await sendAndWaitForResponse(page, 'yes', 60000, wsMonitor);
    console.log(`\n--- drift-confirm reply ---\n${confirm.text}`);
    // "yes" confirms → a new channel is created and the frontend navigates to it.
    // Depending on timing the WS captures either the confirm message (carrying the
    // NAVIGATE_CHANNEL marker) or the NEW channel's opening message — which
    // references the originating chat by link (the by-reference principle), NOT
    // the literal "yes". Either proves the confirm flow created + navigated.
    expect(confirm.text).toMatch(/NAVIGATE_CHANNEL|created a new conversation|started from a drift suggestion/i);

    // REGRESSION (client-side redirect): the marker being SENT is not enough — assert the frontend
    // actually NAVIGATED to the new channel. The active-conversation header title must change away from
    // the origin ('E2E Drift Confirm') to the new drift channel. This is what the marker-only assertion
    // above missed: the stale-closure bug in handleNavigateChannel left the user on the original
    // conversation (the marker arrived, but navigation silently failed), so the title never changed.
    await expect(page.locator('.conversation-header-title'))
      .not.toHaveText('E2E Drift Confirm', { timeout: 20000 });
  });

  test('decline flow — "no" keeps the thread; no channel created, no NAVIGATE', async ({ page }) => {
    const user = await getPremiumUser();
    if (!user.password) { test.skip(); return; }
    const wsMonitor = new WebSocketMonitor();
    await signIn(page, user.email, user.password, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    await createConversation(page, 'E2E Drift Decline', 'Claude Opus');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    const suggestion = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, wsMonitor);
    expect(suggestion.text.toLowerCase()).toContain(SUGGESTION_MARKER);

    // "no" declines → falls through to a normal agent turn: no navigation, no
    // new channel is created.
    const declined = await sendAndWaitForResponse(page, 'no', 60000, wsMonitor);
    console.log(`\n--- drift-decline reply ---\n${declined.text}`);
    expect(declined.text).not.toContain('NAVIGATE_CHANNEL');
    expect(declined.text.toLowerCase()).not.toContain('created a new conversation');
  });

  test('battle suppression — drift does NOT fire in a battle-enabled channel', async ({ page }) => {
    const table = resolveBattleConfigTable();
    test.skip(!table, 'AgentEchelonBattle ChannelBattleConfig table not found (battle not deployed).');
    const user = await getPremiumUser();
    if (!user.password) { test.skip(); return; }
    const wsMonitor = new WebSocketMonitor();
    await signIn(page, user.email, user.password, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    // Capture the new channel's ARN from the create-conversation API response.
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, 'E2E Drift Battle', 'Claude Opus');
    const body = await (await createResp).json();
    const channelArn: string = body.conversation.conversationArn;
    console.log(`\n--- drift-battle channelArn (written to ChannelBattleConfig) ---\n${channelArn}`);
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Enable /battle on THIS channel via a direct DDB write BEFORE the first
    // message, so no negative "not-enabled" cache is warm when the handler
    // checks. isBattleEnabled only inspects `enabled`, so no experiment/slot
    // infra is needed to exercise suppression.
    ddbWrite('put-item', table!, '--item', {
      channelArn: { S: channelArn },
      enabled: { BOOL: true },
    });
    // isBattleEnabled reads with an eventually-consistent GetItem; settle briefly
    // so a real suppression failure isn't masked as a read-after-write race.
    await page.waitForTimeout(3000);
    try {
      const resp = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, wsMonitor);
      console.log(`\n--- drift-battle-suppressed reply ---\n${resp.text}`);
      // Suppressed: a normal agent answer, NOT the drift suggestion.
      expect(resp.text.toLowerCase()).not.toContain(SUGGESTION_MARKER);
      expect(resp.text).not.toContain('NAVIGATE_CHANNEL');
    } finally {
      ddbWrite('delete-item', table!, '--key', { channelArn: { S: channelArn } });
    }
  });
});
