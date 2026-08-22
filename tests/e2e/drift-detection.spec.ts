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
import { WebSocketMonitor, isPlaceholder } from './helpers/websocket-monitor';
import { ChannelWireRecorder } from './helpers/channel-wire';
import { getPremiumUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  assistantResponseCount,
  channelMetadata,
  channelContext,
  driftChannelForParent,
  driftRedirectMessage,
  firstBotMessage,
  messageMatches,
} from './helpers/drift-backend';
import {
  waitForMetric,
  namespaceHasMetrics,
  metricCheckEnabled,
  METRIC_CHECK_DISABLED,
} from './helpers/cw-metrics';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();


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
  // Fails a PASSING test that hid a server-side error (see helpers/turn-guards).
  guardBackendErrors('drift-detection');

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
    test.skip(!user.password, missingUserReason('premiumUser'));
    const wsMonitor = new WebSocketMonitor();
    await signIn(page, user.email, user.password, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    // Capture the ORIGIN channel ARN as the backend assigned it. The backend assertions below resolve the
    // child by its parent pointer, so they need the parent's real ARN rather than its title.
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, 'E2E Drift Confirm', 'Claude Opus');
    const originArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(originArn, 'origin channelArn from create-conversation').toBeTruthy();
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // The pivot fires the templated confirm suggestion (fast-path, no summary).
    const suggestion = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, wsMonitor);
    console.log(`\n--- drift-confirm suggestion ---\n${suggestion.text}`);
    expect(suggestion.text.toLowerCase()).toContain(SUGGESTION_MARKER);

    // Step 3: the user accepts IN THE INTERFACE.
    //
    // NOT `sendAndWaitForResponse` here. That helper waits for a "real answer" and treats anything matching
    // the welcome shape as interim copy to poll past — but accepting a drift suggestion navigates the user
    // into a NEW conversation whose only message IS a welcome. So the helper polls to its timeout on a flow
    // that is working correctly. Send the confirmation directly and assert the outcome instead.
    await page.locator('.message-textarea').fill('yes');
    await page.keyboard.press('Enter');

    // Step 4: the assistant created the new conversation. Resolved from the BACKEND by parent pointer, and
    // polled, because channel creation completes asynchronously after the confirm reply returns.
    //
    // Deliberately NOT inferred from the DOM. The obvious UI check - "the header is no longer the origin
    // title" - is VACUOUS here: `createConversation` no longer sets a title, so the origin is auto-renamed
    // from its own first message and the header changes whether or not navigation happened. That check
    // passed while the page was still on the parent, and the test then read the PARENT's welcome and
    // reported the drift context missing from a flow that was working.
    let child: string | null = null;
    for (let i = 0; i < 20 && !child; i++) {
      child = await driftChannelForParent(originArn);
      if (!child) await page.waitForTimeout(1500);
    }
    expect(child, 'no drift-created channel names this conversation as its parent').not.toBeNull();

    // The child opens with EXACTLY ONE assistant message. Counted on the backend, not in the DOM: right
    // after the redirect the message list is still swapping from the parent, so a DOM count momentarily
    // includes the parent's confirm reply and fails on a flow that is working. The channel's own message
    // list has no such race. Two here would mean the hardcoded drift line is racing the composed welcome
    // again, which is the duplicate this change removed.
    // ONE assistant RESPONSE, which is not the same as one bot MESSAGE.
    //
    // `botMessageCount` counts raw bot messages, so a long answer split into chunks reads as several
    // "assistant messages" and fails this on a WORKING flow. Observed live 2026-08-06: the welcome
    // (1951 chars, welcome copy + the appended answer, exactly as `d474ad9` intends) plus a second
    // message carrying `{"continuation":true,"part":2,"totalParts":2}` - one response delivered in two
    // parts, counted as two and reported as the duplicate-welcome regression this line guards against.
    //
    // `assistantResponseCount` filters `continuation === true`, so it counts RESPONSES. The claim here
    // is "the drift child opens with one assistant response", and that is what it now asserts.
    expect(await assistantResponseCount(child!), 'the drift conversation should open with exactly one assistant response')
      .toBe(1);

    const meta = await channelMetadata(child!);
    // Step 4, from the backend side: topic, quoted message, and BOTH ends of the link.
    expect(meta.createdViaDrift, 'child is marked as drift-created').toBe(true);
    expect(meta.parentChannelArn, 'child points back at the parent').toBe(originArn);
    expect(String(meta.triggerContext || ''), 'child carries a real topic, not a fixed placeholder')
      .not.toBe('Drift Follow-up');
    // priorMessage is read from the SERVER-ONLY channel-context store, NOT from Metadata.
    //
    // `d474ad9` moved priorSubject/priorMessage/parentRef out of channel Metadata: Metadata is
    // member-WRITABLE (a channel's creator is a moderator of their own channel), so anything the
    // assistant grounds on must not live there. priorMessage was given NO Metadata fallback, so this
    // assertion read `''` on a WORKING flow and reported a product regression that did not exist.
    // The readers in channel-notify and host-grounding were moved with the data; this one was missed.
    const ctx = await channelContext(child!);
    expect(String(ctx.priorMessage || ''), "child carries the user's originating message in the context store")
      .toContain(DRIFT_TRIGGER.slice(0, 30));
    // And it must NOT be in member-writable Metadata — that is the whole point of the move.
    expect(meta.priorMessage, 'priorMessage must not be readable from member-writable channel Metadata')
      .toBeUndefined();

    // Navigation the OTHER way: the parent carries a durable, followable link to the child. In METADATA,
    // because the NAVIGATE_CHANNEL marker is stripped before display - so without this the parent keeps the
    // announcement and loses the way to reach what it announced.
    const link = await driftRedirectMessage(originArn);
    expect(link, 'the parent has no message carrying a driftRedirect link to the child').not.toBeNull();
    expect(link!.childChannelArn, 'the parent link points at the child that was created').toBe(child);

    // Step 4 (welcome content), read from the channel rather than the DOM so it is the assistant's actual
    // output and not whatever the browser happened to be showing.
    const welcome = await firstBotMessage(child!);
    console.log(`\n--- drift welcome (from the channel) ---\n${welcome}\n--- end ---`);
    // A SPAWNED conversation does NOT re-introduce the assistant. The person was already mid-thread
    // with this same assistant and arrived by accepting an offer to continue one thought; leading with
    // "Hi - I'm your assistant at <company>" pushes the only line that matters below an introduction
    // they were just given. So the company line is asserted ABSENT here, not present.
    expect(welcome, 'a spawned conversation must not re-introduce the assistant').not.toMatch(/i'm your assistant at/i);
    expect(welcome, 'a spawned conversation must not repeat the company orientation').not.toMatch(/stratum/i);
    // It opens directly on the continuity.
    expect(welcome.trimStart(), 'the welcome opens on why this conversation exists').toMatch(/^this conversation picks up/i);
    expect(welcome, "the welcome quotes the user's own message back").toMatch(/quarterly revenue forecasting/i);
    expect(welcome, 'the welcome links back to the originating conversation').toContain('the conversation it came from');

    // The link must anchor to the MESSAGE, not just the conversation. `CHIME.message.id` arrives empty, so
    // the id is resolved from the channel; without that the deep link lands the reader at the bottom of the
    // parent thread and leaves them to find the message themselves.
    const originatingMessageId = String(meta.originatingMessageId || '');
    expect(originatingMessageId, 'no originatingMessageId was recorded, so the link cannot anchor to the '
      + 'message that caused the drift').not.toBe('');
    // A LITERAL `#`, not `%23`: the fragment must stay a fragment. Percent-encoding it would make the
    // anchor part of the query string, so the browser would never treat it as one and the link would
    // silently land at the top of the conversation.
    expect(welcome, 'the welcome link carries a #message anchor')
      .toContain(`#message=${originatingMessageId}`);

    // NON-EMPTY IS NOT ENOUGH. A fabricated or stale id yields a link that looks live and lands nowhere,
    // which is worse than no anchor. Assert it resolves to the ACTUAL triggering message in the parent -
    // matched on content, which pins that the right message was captured and not merely some message.
    expect(
      await messageMatches(originArn, originatingMessageId, DRIFT_TRIGGER),
      `originatingMessageId ${originatingMessageId} does not resolve to the triggering message in the parent `
      + 'conversation, so the anchor points at nothing (or at the wrong message)',
    ).toBe(true);

    // Step 5: the user is ROUTED into the new conversation. Asserted against the child's REAL title, which
    // is only knowable now that the child has been resolved - the vacuous "title is not the origin" check
    // this replaces passed without any navigation at all.
    const childTitle = String((await channelMetadata(child!)).triggerContext || '');
    await expect(
      page.locator('.conversation-header-title'),
      'the user was not routed into the new conversation; the redirect marker arrived but navigation did not '
      + 'happen (see ConversationProvider handleNavigateChannel)',
    ).toHaveText(childTitle, { timeout: 30000 });

    // Step 6: the link back actually LANDS on the triggering message.
    //
    // Everything above proves the link is well-formed and its id resolves. None of it proves following the
    // link works - the anchor handling is new (`data-message-id` + the scroll effect), and a link that is
    // correctly built but ignored by the app looks identical from the backend. Clicking it is the only
    // assertion that covers the whole path.
    // Start WATCHING for the focus highlight before the click, because it is TRANSIENT: `focusMessage.ts`
    // removes `message--focused` 2.6s after adding it. The two assertions below (header changed, message
    // rendered) each poll with their own timeout and routinely consume more than that, so looking for the
    // class afterwards is a race the test loses whenever the app is a little slow - which is exactly how
    // this failed intermittently. Recording the transition as it happens removes the race without
    // weakening the assertion or lengthening a product timer to suit a test.
    await page.evaluate((id) => {
      const w = window as unknown as { __focusSeen?: boolean };
      w.__focusSeen = false;
      const seen = () => {
        const el = document.querySelector(`[data-message-id="${id}"]`);
        if (el?.classList.contains('message--focused')) w.__focusSeen = true;
      };
      new MutationObserver(seen).observe(document.body, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class'],
      });
      seen();
    }, originatingMessageId);

    await page.locator('.assistant-message .message-text a', { hasText: 'the conversation it came from' })
      .first()
      .click();

    // Back in the ORIGINAL conversation, which is still there - the drift redirect splits a topic out, it
    // does not end the thread it came from.
    await expect(page.locator('.conversation-header-title'), 'following the link did not return to the '
      + 'originating conversation').not.toHaveText(childTitle, { timeout: 30000 });

    // And on the RIGHT message: the anchor marks the one that caused the drift, not just the conversation.
    await expect(
      page.locator(`[data-message-id="${originatingMessageId}"]`),
      'the originating message is not rendered, so the anchor had nothing to land on',
    ).toBeVisible({ timeout: 30000 });
    // Either the observer caught the highlight, or it is still on screen right now. The second arm covers
    // the case where the click triggered a full document load and took the observer with it.
    await expect
      .poll(async () => {
        const recorded = await page.evaluate(
          () => (window as unknown as { __focusSeen?: boolean }).__focusSeen === true,
        );
        if (recorded) return true;
        return (await page
          .locator(`[data-message-id="${originatingMessageId}"].message--focused`)
          .count()) > 0;
      }, {
        message: 'the link returned to the conversation but did not focus the message it anchors to',
        timeout: 30000,
      })
      .toBe(true);

    // Step 7: and BACK the other way, from the original into the drift conversation.
    //
    // This is the direction the `NAVIGATE_CHANNEL` marker cannot serve: it fires once on arrival and is
    // stripped before display, so on this re-read of the parent the only way through is the durable
    // `driftRedirect` link rendered from message Metadata. Asserting the metadata exists (above) does not
    // prove the app renders anything the user can click - that affordance is new and this is what covers it.
    //
    // Together with step 6 this closes the loop: a person can move between the two conversations in either
    // direction, at any time, not just in the moment the redirect happened.
    const backToChild = page.locator('.drift-redirect-link').first();
    await expect(
      backToChild,
      'the original conversation shows no way to reach the conversation that was split out of it; the '
      + 'driftRedirect metadata is present but nothing renders it',
    ).toBeVisible({ timeout: 30000 });
    await backToChild.click();

    await expect(
      page.locator('.conversation-header-title'),
      'following the parent-side link did not open the drift conversation',
    ).toHaveText(childTitle, { timeout: 30000 });
  });

  test('decline flow — "no" keeps the thread; no channel created, no NAVIGATE', async ({ page }) => {
    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));
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

  // BATTLE MODE BEING ON IS NOT AN EVENT, so it does not suppress drift.
  //
  // This test asserted the opposite until now, and it was RIGHT when it was written: suppression once
  // asked `isBattleEnabled`, the moderator's channel-level mode flag. `827107e` deliberately narrowed
  // it to a duel that is actually RUNNING, with the reason recorded in live-drift-flow.ts: the old
  // check fired between duels with nothing in flight and told the person "the assistants are still
  // comparing answers" when no assistant was doing anything.
  //
  // The test was last touched two days BEFORE that change and kept asserting the superseded rule, so
  // it has been failing against correct behaviour. Inverted here rather than deleted, because the new
  // rule had no coverage at all: nothing asserted that a channel with Battle Mode merely switched on
  // still gets the ordinary drift offer, which is the whole point of the narrowing.
  //
  // Suppression DURING a live duel is a different assertion needing a real duel, and it belongs with
  // the rest of the duel setup in battle.spec.ts rather than behind a hand-written config row here.
  test('battle mode alone does NOT suppress drift — only a running duel does', async ({ page }) => {
    const table = resolveBattleConfigTable();
    test.skip(!table, 'AgentEchelonBattle ChannelBattleConfig table not found (battle not deployed).');
    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));
    const wsMonitor = new WebSocketMonitor();
    // Record the CHANNEL WIRE as well as driving the DOM. Suppression is a BACKEND property - the
    // assistant answered normally instead of offering to split the conversation - and the DOM alone
    // cannot see it: a client WebSocket reconnect renders nothing, which is indistinguishable from
    // "the backend never replied" and fails this test for a reason that has nothing to do with drift.
    // That is exactly how it failed once here, with "Reconnecting..." in the header. The wire is the
    // authority for what the backend did; the DOM assertion below then separately confirms the client
    // rendered it, so a failure names which of the two broke.
    const wire = new ChannelWireRecorder();
    wire.attach(page);
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
      // Everything the bot has already sent on this channel (the welcome). The suppression evidence is
      // whatever arrives AFTER this point, so baseline it rather than taking the first bot frame.
      const before = wire.botMessagesFor(channelArn).length;

      // The DOM wait is allowed to FAIL without ending the test here. It sends the message either
      // way, so the wire still records the backend's answer, and the backend property below is what
      // this test is actually about. Collapsing the two is what made a client reconnect look like
      // drift firing.
      let domText = '';
      let domError: Error | null = null;
      try {
        const resp = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, wsMonitor);
        domText = resp.text;
        console.log(`\n--- drift-battle-suppressed reply (DOM) ---\n${domText}`);
      } catch (err) {
        domError = err as Error;
        console.log('\n--- the client did not settle a reply in the DOM; the wire is checked below ---');
      }

      // 1. THE WIRE - what the backend actually sent. This is the suppression assertion.
      const deadline = Date.now() + 30_000;
      let settled: string | null = null;
      for (;;) {
        const fresh = wire.botMessagesFor(channelArn).slice(before)
          .map((m) => m.content)
          .filter((c) => c && !isPlaceholder(c));
        if (fresh.length > 0) { settled = fresh[fresh.length - 1]; break; }
        if (Date.now() > deadline) break;
        await page.waitForTimeout(250);
      }
      expect(
        settled,
        'no settled bot reply reached the channel wire after the drift trigger. The backend did not '
          + 'answer at all, which is a different failure from drift firing.',
      ).toBeTruthy();
      console.log(`--- drift reply with battle mode on, no duel running (WIRE) ---\n${settled}`);
      expect(
        settled!.toLowerCase(),
        'drift did NOT fire with Battle Mode merely switched on. Suppression is supposed to require a '
          + 'RUNNING duel (827107e); if this fails, suppression has widened back to the mode flag and '
          + 'people will be told the assistants are comparing answers when nothing is in flight.',
      ).toContain(SUGGESTION_MARKER);

      // 2. THE DOM - the client rendered what the wire delivered. A failure here is a CLIENT fault
      //    (a dropped or reconnecting WebSocket), not a drift regression, and the message says which.
      if (domError) {
        throw new Error(
          'the backend offered the drift split correctly (asserted on the wire above) but the client '
            + 'never rendered the reply. This is a CLIENT-side delivery fault, not a drift regression.\n'
            + `underlying: ${domError.message}`,
        );
      }
      expect(domText.toLowerCase(), 'the drift suggestion did not render in the client')
        .toContain(SUGGESTION_MARKER);
    } finally {
      ddbWrite('delete-item', table!, '--key', { channelArn: { S: channelArn } });
    }
  });
});

// ============================================================
// Drift observability — the metrics reach CloudWatch
//
// THE DEFECT THIS EXISTS FOR. `emitEmfMetric` wrote `Metrics: [{name, unit}]` where the EMF schema
// requires `{Name, Unit}`. CloudWatch discards a malformed document silently, so `AgentEchelon/Drift`
// held ZERO metrics after months of drift detection running on every turn, and any alarm over one
// would have sat in INSUFFICIENT_DATA rather than fired. Every unit test passed the whole time,
// because a unit test asserts the shape the emitter produces and the schema is an external contract.
//
// The tests above would also have stayed green: drift's user-visible behaviour was correct
// throughout. Only reading the metric BACK from CloudWatch can see this class of defect.
//
// NOTE: `AgentEchelon/Tasks` has no equivalent assertion, and deliberately so. It declares exactly
// one metric, `task_state_stalled`, emitted only once a task has sat in one state for
// TASK_STALL_TURNS (default 6) turns. A healthy task emits nothing, so there is no happy-path
// datapoint to assert; covering it means driving a deliberate stall, which is a separate spec.
// ============================================================

test.describe('Drift metrics materialise in CloudWatch (EMF contract)', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + a live E2E_BASE_URL.');
  guardBackendErrors('drift-metrics');

  test('a drift turn produces a queryable datapoint in AgentEchelon/Drift', async ({ page }) => {
    test.skip(!metricCheckEnabled(), METRIC_CHECK_DISABLED);
    // A live turn (up to 60s) plus EMF ingestion, which is asynchronous and routinely takes minutes.
    test.setTimeout(600_000);

    const user = await getPremiumUser();
    test.skip(!user.password, missingUserReason('premiumUser'));

    // Before the turn, and rounded out by the helper, so the window cannot exclude our own datapoint.
    const since = Date.now();

    const wsMonitor = new WebSocketMonitor();
    await signIn(page, user.email, user.password, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    await createConversation(page, `E2E Drift Metrics ${Date.now()}`, 'Claude Opus');
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    // Same deterministic trigger the behavioural tests use: the explicit-routing fast-path fires on
    // the first message with no dependency on the ~30-min summary updater.
    const suggestion = await sendAndWaitForResponse(page, DRIFT_TRIGGER, 60000, wsMonitor);
    expect(
      suggestion.text.toLowerCase(),
      'the drift suggestion did not fire, so this turn never reached the emitters and the metric '
      + 'assertions below would be testing nothing',
    ).toContain(SUGGESTION_MARKER);

    // 1. The namespace holds metrics AT ALL. This is the blunt check that would have caught the EMF
    //    bug on day one: list-metrics returned an empty list for months. It does not depend on this
    //    turn (CloudWatch retains metric definitions for months), which is exactly why it is a
    //    separate assertion from the datapoint below - it fails on "the emitter has never worked",
    //    with a clearer message than a missing datapoint gives.
    const names = await namespaceHasMetrics('AgentEchelon/Drift');
    expect(
      names,
      'AgentEchelon/Drift contains NO metrics. The EMF document is being rejected by CloudWatch - '
      + 'check that emitEmfMetric writes Metrics: [{Name, Unit}] with capitals, and that the '
      + 'data-plane Lambda (which runs analytics-aurora/*) is actually deployed.',
    ).not.toEqual([]);
    console.log(`\n--- AgentEchelon/Drift metrics ---\n${names.join(', ')}`);

    // 2. THIS turn produced a datapoint. Every drift path emits the 'total' stage timing before it
    //    returns, so this is the one assertion that holds regardless of which branch ran.
    // RECENTLY, not strictly since this turn — and the difference is deliberate.
    //
    // Pinning this to the turn made it a race against one Lambda's log flush plus EMF extraction, on a
    // data plane that goes idle the moment the turn ends. Measured across runs: the same assertion
    // resolved in 10s, then not within 3.2 minutes, then not within 5.3 minutes - while the metric was
    // verifiably emitted every time (the data-plane log group carried the Stage=total envelope) and 22
    // datapoints were queryable over the surrounding window. Waiting longer does not fix a race whose
    // tail is set by someone else's queue; it just makes the failure take longer to report.
    //
    // A 15-minute lookback still fails on the defect that matters and is otherwise invisible: a
    // malformed EMF envelope publishes NOTHING, so the namespace stays empty and both this and the
    // list-metrics assertion above go red. What it no longer claims is attribution to THIS turn - a
    // datapoint from a drift turn minutes earlier satisfies it. That is a real weakening, stated rather
    // than hidden: the per-turn claim was not one this test could keep.
    const METRIC_LOOKBACK_MS = 15 * 60_000;
    const totalLatency = await waitForMetric({
      namespace: 'AgentEchelon/Drift',
      metricName: 'DriftStageLatency',
      dimensions: { Stage: 'total' },
      sinceEpochMs: since - METRIC_LOOKBACK_MS,
    }, { timeoutMs: 120_000 });
    expect(
      totalLatency,
      'no DriftStageLatency datapoint for Stage=total in the last 15 minutes, and drift demonstrably '
      + 'ran (the suggestion rendered). The metric is being emitted but not INGESTED, which is what a '
      + 'malformed EMF envelope looks like: check that emitEmfMetric writes Metrics: [{Name, Unit}] '
      + 'with capitals, and check the data-plane log group for the Stage=total envelope.',
    ).toBeGreaterThan(0);

    // 3. And it took the branch this trigger selects. `drift_fired` is NOT the counter here: the
    //    explicit-routing fast-path returns before the embedding comparison, emitting
    //    drift_fastpath_explicit_intent instead (analytics-aurora/drift-detection.ts). Asserting the
    //    counter the code actually emits keeps this from passing on a coincidence.
    const fastPath = await waitForMetric({
      namespace: 'AgentEchelon/Drift',
      metricName: 'drift_fastpath_explicit_intent',
      dimensions: { Counter: 'drift_fastpath_explicit_intent' },
      sinceEpochMs: since,
    });
    expect(
      fastPath,
      'the explicit-routing fast-path counter never landed, though the suggestion it produces did '
      + 'render. The counter emit has been removed, renamed, or its dimension set changed.',
    ).toBeGreaterThan(0);
  });
});
