/**
 * Classification-based dispatch routing E2E.
 *
 * WHY THIS SPEC EXISTS. `asyncProcessorArnForClassification` decides WHICH async processor answers a
 * flow-dispatched turn, and that choice is a classification boundary: each classification's processor carries
 * its own model, its own guardrail, and its own `context/` S3 scope, all IAM-enforced. Two battle
 * dispatch paths used to hardcode the PREMIUM processor, so a non-premium channel would have been
 * answered with the premium model under the premium guardrail. That was unreachable only because a
 * separate hardcoded gate refused non-premium first, and fixing the gate alone would have opened it.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS THE RIGHT PROXY. The failure this guards against is "a non-premium
 * turn is answered by the premium processor". `@all` dispatch resolves its processor through the SAME
 * `asyncProcessorArnForClassification` the battle paths now use, on the same deployed code, so driving
 * it on a NON-PREMIUM channel exercises the resolver's non-premium behaviour end to end. The reply's own
 * `Metadata.modelId` is the backend's account of which model produced it, so this reads what actually
 * happened rather than inferring it from the text.
 *
 * WHY THIS DRIVES A MULTI-MEMBER CHANNEL (changed 2026-08-12). `@all` used to take the flow bypass at
 * EVERY channel size, so a 1:1 was the cheapest way to reach the dispatcher. It no longer is: in a 1:1
 * the flow now stands aside and the Lex entry answers, because Amazon Chime SDK's AUTO trigger invokes
 * Lex for every message at that size and BOTH entries were handling the turn - which produced two
 * placeholders, one of them stranded (tracker rows 1 and 85). Flow dispatch is therefore reachable
 * only above 1:1, which is what this spec now sets up.
 *
 * The old version documented the duplicate as though it were expected: "an @all yields TWO bot
 * messages ... because a flow cannot reliably stop Lex being invoked on a message it releases". It then
 * worked AROUND it by picking the flow-dispatched one out of the pair. Worth recording, because a test
 * that encodes a defect as an invariant is how the defect survives: this suite ran green for weeks
 * over a bug users were reporting.
 *
 * WHAT IT DOES NOT COVER. `/battle` on a battle-eligible NON-premium channel. Reaching that state
 * needs a classification that is both non-premium and battle-eligible, which the shipped config does
 * not provide, and manufacturing one is not cheap: classifications are hand-written stacks, and the
 * classification tag IS the IAM boundary (`classificationChannelScopedAllow` grants a channel only
 * when its tag is in that classification's set), so a test-only classification would be denied to the
 * standard processor unless it were added to that role's tag set. A test fixture does not belong in a
 * security boundary. Battle's two call sites are pinned to this same resolver by
 * `backend/test/lib/battle-classification-routing.test.ts`, which is where a reintroduced hardcode
 * would be caught.
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { ChannelWireRecorder } from './helpers/channel-wire';
import { getBasicUser, getStandardUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();

/** From `lib/config/model-strategy.ts`. The basic profile is `haiku`, premium is `opus`. */
const NON_PREMIUM_MODEL_FRAGMENT = 'haiku';
const PREMIUM_MODEL_FRAGMENT = 'opus';

test.describe('Flow dispatch routes on the channel classification', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users.');
  guardBackendErrors('dispatch-routing');

  test('an @all turn on a NON-PREMIUM channel is answered by its own processor, not premium', async ({ page }) => {
    // A BASIC channel with a STANDARD member, which is the only two-user shape this deployment can
    // make. SHARING IS GATED ON THE INVITEE'S OWN CLEARANCE, so the invitee must clear the channel's
    // classification: a basic user cannot join a standard conversation (tried; the boundary correctly
    // refused and no success banner appeared), and `secondPremiumUser` is not provisioned here.
    // Basic-creates-standard-joins is the same pattern `mentions.spec.ts` uses, and it is proven.
    //
    // The security property is unchanged by the flip. What this guards is "a non-premium turn must not
    // be answered by the PREMIUM processor", and basic is non-premium exactly as standard is.
    const user = await getBasicUser();
    const shareTarget = await getStandardUser();
    test.skip(
      !user.password || !shareTarget.password,
      !user.password ? missingUserReason('basicUser') : missingUserReason('standardUser'),
    );

    const wsMonitor = new WebSocketMonitor();
    const wire = new ChannelWireRecorder();
    wire.attach(page);
    await signIn(page, user.email, user.password!, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await createConversation(page, 'E2E Dispatch Routing', 'Claude Haiku');
    const body = await (await createResp).json();
    const channelArn: string = body.conversation.conversationArn;
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    // ABOVE 1:1, OR THE FLOW WILL NOT DISPATCH. Sharing adds a second human, which puts the assistant
    // in MENTIONS mode: Lex is no longer invoked for an `@all` (it is not a Chime mention value), so the
    // flow's bypass becomes the only thing that can answer - which is the dispatcher this spec exists
    // to exercise. Same share flow as the multi-user block in `mentions.spec.ts`.
    await page.locator('button[aria-label="Share conversation"]').click();
    await expect(page.locator('#share-email')).toBeVisible({ timeout: 5_000 });
    await page.locator('#share-email').fill(shareTarget.email);
    await page.locator('.modal-content button[type="submit"]').click();
    await expect(page.locator('.alert-success')).toBeVisible({ timeout: 30_000 });

    // The member-joined announcement is a bot message and would otherwise be mistaken for this turn's
    // reply. Let it land before the baseline is taken.
    await page.waitForTimeout(5_000);

    // Let the add-triggered welcome settle so it is not mistaken for this turn's reply. The welcome is
    // produced by a different path and would not carry this turn's attribution anyway.
    await page.waitForTimeout(5_000);
    const idsBefore = new Set(wire.botMessagesFor(channelArn).map((m) => m.messageId));

    // @all is the flow-dispatched path. A plain 1:1 turn goes through Lex instead and would not
    // exercise `asyncProcessorArnForClassification` at all.
    await page.locator('.message-textarea').fill('@all give one short fact about tides');
    await page.keyboard.press('Enter');

    // FIND THE FLOW-DISPATCHED REPLY. Above 1:1 the flow's bypass is the ONLY responder - Lex is not
    // invoked for an `@all` in MENTIONS mode - so there is exactly one bot reply and it is the one that
    // went through `asyncProcessorArnForClassification`.
    //
    // This used to say an @all yields TWO bot messages, "because a flow cannot reliably stop Lex being
    // invoked on a message it releases", and picked the flow's one out of the pair. That was describing
    // the duplicate as a fact of life rather than a bug. It is fixed; the pair no longer occurs.
    //
    // Tracked by MessageId: the answer arrives as an UPDATE that replaces the content, so the marker
    // that identifies it is gone by the time attribution appears.
    const mentionPlaceholderId = await (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const hit = wire.botMessagesFor(channelArn)
          .find((m) => !idsBefore.has(m.messageId) && m.content.includes('<!--corr:mention-'));
        if (hit) return hit.messageId;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    expect(mentionPlaceholderId, 'the @all was dispatched by the channel flow').toBeTruthy();

    // `bedrockModel` is the backend's own account of which model produced the reply. Only the UPDATE
    // carries it; the placeholder has just `botResponse`.
    const answer = await (async () => {
      const deadline = Date.now() + 90_000;
      for (;;) {
        const hit = wire.botMessagesFor(channelArn)
          .find((m) => m.messageId === mentionPlaceholderId && m.metadata?.bedrockModel);
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    if (!answer) {
      // Name what DID arrive, so a failure distinguishes "no reply" from "a reply without attribution".
      for (const m of wire.botMessagesFor(channelArn).filter((x) => !idsBefore.has(x.messageId))) {
        console.log(`  new bot msg ${m.messageId.slice(0, 12)} type=${m.eventType} `
          + `metaKeys=[${m.metadata ? Object.keys(m.metadata).join(',') : 'none'}] `
          + `content=${JSON.stringify(m.content.slice(0, 120))}`);
      }
    }
    expect(answer, 'the flow-dispatched @all reply carries model attribution').toBeTruthy();
    const modelId = String(answer!.metadata!.bedrockModel);
    console.log(`\n--- @all on a BASIC channel was answered by: ${modelId} ---`);

    // THE BOUNDARY. Premium here would mean a non-premium channel was answered by the premium
    // processor: premium model, premium guardrail, premium context scope.
    expect(modelId, 'a non-premium channel must not be answered by the premium model')
      .not.toContain(PREMIUM_MODEL_FRAGMENT);
    expect(modelId, 'a basic channel is answered by the basic profile model')
      .toContain(NON_PREMIUM_MODEL_FRAGMENT);
  });
});
