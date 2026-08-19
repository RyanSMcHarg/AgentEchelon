/**
 * Retried Lex fulfillment E2E (ADR-022, SPEC-ABUSE-CONTROLS dedup).
 *
 * WHY THIS SPEC EXISTS. The duplicate-reply fix rests entirely on one property: two fulfillments of
 * the SAME turn derive the same correlation id, so the second loses the `fulfil-<corr>` claim and
 * returns a response the client renders as nothing. That was asserted at unit level only, against a
 * mocked table. Nothing exercised it on the deployed router, and the failure mode is invisible from
 * the inside: if the derivation drifts, each fulfillment mints its own id, BOTH win their claim, and
 * the only symptom is a duplicate reply in production. A green unit suite says nothing about it.
 *
 * HOW A RETRY IS DRIVEN. Amazon Chime SDK retries a fulfillment that does not answer in time, which
 * is not something a test can schedule. What IS reproducible is the thing that retry delivers: the
 * same Lex event, twice, inside the correlation window. Invoking the deployed handler with a
 * byte-identical payload is that event. It exercises the real derivation, the real claim against the
 * real table, and the real silent-response shape, on deployed code.
 *
 * THE NEGATIVE CONTROL IS NOT OPTIONAL. "The second call returned no messages" equally describes a
 * handler that suppresses EVERYTHING: a broken gate and a working one are indistinguishable from the
 * positive case alone. A third call carrying a different transcript must still answer, or this spec
 * proves nothing about discrimination between turns.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { signIn, createConversation } from './helpers/agent-helpers';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { ChannelWireRecorder } from './helpers/channel-wire';
import { getBasicUser, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

// Watch the two blind spots an e2e assertion leaves: the server, and the browser console.
guardConsoleErrors();

const REGION = process.env.AWS_REGION || 'us-east-1';
const E2E_RUNNABLE = hasTestCredentials();

/** Must match TURN_CORRELATION_WINDOW_SECONDS in `lambda/src/lib/correlation.ts`. */
const CORRELATION_WINDOW_SECONDS = 90;

function aws(args: string): any {
  const raw = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return raw.trim() ? JSON.parse(raw) : null;
}

/**
 * The BASIC classification's Lex fulfillment handler. Pinned to basic rather than "whichever comes
 * back first" because the conversation below is created on basic: the router resolves the channel's
 * classification from its tag, so invoking a different classification's handler would exercise a
 * mismatch this spec is not about.
 */
function resolveBasicAgentHandler(): string | null {
  try {
    const fns: string[] = aws(
      `lambda list-functions --query "Functions[?contains(FunctionName,'AgentEchelonClassification-Ba') `
      + `&& contains(FunctionName,'AgentHandler')].FunctionName"`,
    );
    return fns?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Invoke a Lambda with a JSON event and return its parsed return value.
 *
 * The payload goes via a temp FILE. Inlining JSON on the command line does not survive Windows shell
 * quoting, which is the same reason `ddbWrite` in the abuse-controls spec writes a file.
 */
function invokeLambda(fn: string, event: unknown): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexinvoke-'));
  const inFile = path.join(dir, 'event.json');
  const outFile = path.join(dir, 'out.json');
  fs.writeFileSync(inFile, JSON.stringify(event));
  execSync(
    `aws lambda invoke --function-name ${fn} --cli-binary-format raw-in-base64-out `
    + `--payload file://${inFile} ${outFile} --region ${REGION} --output json`,
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const raw = fs.readFileSync(outFile, 'utf8');
  return raw.trim() ? JSON.parse(raw) : null;
}

/** The Lex fulfillment event Amazon Chime SDK delivers, carrying only the three request attributes
 *  it actually sends (measured live; `CHIME.message.id` is NOT among them - see correlation.ts). */
function lexEvent(args: {
  channelArn: string;
  senderArn: string;
  transcript: string;
  sessionId: string;
}) {
  return {
    inputTranscript: args.transcript,
    sessionId: args.sessionId,
    sessionState: {
      intent: { name: 'FallbackIntent' },
      sessionAttributes: {},
    },
    requestAttributes: {
      'CHIME.channel.arn': args.channelArn,
      'CHIME.sender.arn': args.senderArn,
      'x-amz-lex:channels:platform': 'Chime',
    },
  };
}

/**
 * Wait until a fresh correlation bucket has enough time left to hold two fulfillments.
 *
 * The id quantises time into 90s buckets, and the router claims against the CURRENT bucket only. Two
 * calls that straddle a boundary derive different ids and are legitimately not duplicates, so a test
 * that happened to run at a boundary would fail for a reason that is not a defect. This removes that
 * race instead of retrying around it.
 */
async function alignToCorrelationBucket(): Promise<void> {
  const secondsIntoBucket = Math.floor(Date.now() / 1000) % CORRELATION_WINDOW_SECONDS;
  const remaining = CORRELATION_WINDOW_SECONDS - secondsIntoBucket;
  if (remaining < 30) {
    await new Promise((r) => setTimeout(r, (remaining + 1) * 1000));
  }
}

test.describe('Retried Lex fulfillment is suppressed on the deployed router', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users + AWS credentials for the Lambda invoke.');
  guardBackendErrors('fulfillment-retry');

  test('a byte-identical second fulfillment replays the SAME placeholder, a different one still answers', async ({ page }) => {
    // Awaited: getBasicUser resolves the credential from Secrets Manager. Using it unawaited leaves
    // `password` undefined, which trips the skip below and turns this spec into a silent no-op.
    const user = await getBasicUser();
    test.skip(!user.password, missingUserReason('basicUser'));

    const handler = resolveBasicAgentHandler();
    expect(handler, 'a basic AgentEchelonClassification AgentHandler function').toBeTruthy();

    const wsMonitor = new WebSocketMonitor();
    const wire = new ChannelWireRecorder();
    wire.attach(page);
    await signIn(page, user.email, user.password!, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await createConversation(page, 'E2E Fulfillment Retry', 'Claude Haiku');
    const body = await (await createResp).json();
    const channelArn: string = body.conversation.conversationArn;
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    // The sender ARN Chime would send. The app instance is the channel ARN's own prefix, so it never
    // has to be configured separately or guessed.
    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    expect(idToken, 'idToken in localStorage').toBeTruthy();
    const sub = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64').toString('utf8')).sub;
    const appInstanceArn = channelArn.split('/channel/')[0];
    const senderArn = `${appInstanceArn}/user/${sub}`;

    await alignToCorrelationBucket();

    // Unique per run: two runs inside one 90s window would otherwise derive the same id, and the
    // second run's FIRST fulfillment would be suppressed by the first run's claim.
    const transcript = `Retry probe ${Date.now()}: summarise the billing migration status.`;
    const event = lexEvent({ channelArn, senderArn, transcript, sessionId: `e2e-retry-${Date.now()}` });

    const botsBefore = wire.botMessagesFor(channelArn).length;

    // Byte-identical, exactly as a Chime retry replays it. Sequential rather than concurrent: the
    // claim is what serialises them, and a concurrent pair would additionally be testing DynamoDB
    // conditional-write ordering, which is not what this asserts.
    const first = invokeLambda(handler!, event);
    const second = invokeLambda(handler!, event);

    console.log('\n--- first fulfillment ---\n' + JSON.stringify(first?.messages));
    console.log('--- second (retried) fulfillment ---\n' + JSON.stringify(second?.messages));

    // The first owns the turn and answers. Without this, "the second was empty" could simply mean the
    // handler errored on both.
    expect(Array.isArray(first?.messages), 'first fulfillment returned a messages array').toBe(true);
    expect(first.messages.length, 'the first fulfillment answers the turn').toBeGreaterThan(0);

    // THE CONTROL. The retry REPLAYS the same placeholder - same `<!--corr:{id}-->` marker as the
    // first fulfillment - rather than going silent.
    //
    // THIS ASSERTION USED TO DEMAND AN EMPTY ARRAY, and that contract was wrong. Amazon Chime SDK
    // materialises ONE message per turn, from the LAST fulfillment response, so a silent retry
    // silences the response the user actually receives. Traced live 2026-08-06: attempt A claimed the
    // correlation and dispatched the processor, its response was discarded, attempt B returned the
    // empty envelope, that envelope became the channel's only bot message, and the processor polled
    // 22s for a placeholder that never existed. The turn went unanswered.
    //
    // Replaying the same marker makes the two attempts interchangeable: whichever response
    // materialises, the single dispatched processor can find and update it.
    expect('messages' in second, 'the retried fulfillment includes a messages field').toBe(true);
    expect(second.messages.length, 'the retried fulfillment replays a placeholder rather than going silent')
      .toBeGreaterThan(0);

    const markerOf = (r: { messages: Array<{ content?: string }> }): string | null => {
      const m = /<!--corr:([A-Za-z0-9._-]{1,64})-->/.exec(r.messages.map((x) => x.content || '').join(''));
      return m ? m[1] : null;
    };
    const firstMarker = markerOf(first);
    expect(firstMarker, 'the first fulfillment returned a correlation-marked placeholder').toBeTruthy();
    expect(
      markerOf(second),
      'the retry carries the SAME correlation marker, so either response resolves to one placeholder',
    ).toBe(firstMarker);

    expect(second.sessionState.dialogAction.type, 'the retry closes the intent').toBe('Close');
    expect(second.sessionState.intent.state, 'the retry fulfils rather than re-prompting').toBe('Fulfilled');

    // NEGATIVE CONTROL. A different transcript in the same channel, from the same sender, inside the
    // same window is a DIFFERENT turn and must still be answered. Without this the assertions above
    // are also satisfied by a handler that suppresses everything.
    const otherEvent = lexEvent({
      channelArn,
      senderArn,
      transcript: `${transcript} And list the open risks.`,
      sessionId: `e2e-retry-${Date.now()}-b`,
    });
    const distinct = invokeLambda(handler!, otherEvent);
    console.log('--- distinct turn ---\n' + JSON.stringify(distinct?.messages));
    expect(distinct.messages.length, 'a DIFFERENT turn is not suppressed').toBeGreaterThan(0);

    // NOTE ON WHAT THIS TEST DELIBERATELY DOES NOT ASSERT. Invoking the handler directly bypasses
    // Amazon Chime SDK, so no placeholder is ever materialised from these Lex returns and the channel
    // gains nothing to count. An assertion here would pass on zero no matter what the code did. The
    // user-visible half is asserted in the next test, which drives a REAL turn first.
    void botsBefore;
  });

  test('a duplicate fulfillment of a REAL in-flight turn adds no second message to the channel', async ({ page }) => {
    const user = await getBasicUser();
    test.skip(!user.password, missingUserReason('basicUser'));

    const handler = resolveBasicAgentHandler();
    expect(handler, 'a basic AgentEchelonClassification AgentHandler function').toBeTruthy();

    const wsMonitor = new WebSocketMonitor();
    const wire = new ChannelWireRecorder();
    wire.attach(page);
    await signIn(page, user.email, user.password!, wsMonitor);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30_000 });

    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await createConversation(page, 'E2E Fulfillment Retry Live', 'Claude Haiku');
    const body = await (await createResp).json();
    const channelArn: string = body.conversation.conversationArn;
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15_000 });

    const idToken = await page.evaluate(() => localStorage.getItem('idToken'));
    const sub = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64').toString('utf8')).sub;
    const appInstanceArn = channelArn.split('/channel/')[0];
    const senderArn = `${appInstanceArn}/user/${sub}`;

    // Let the add-triggered welcome land before baselining, so it is not counted as this turn's reply.
    await page.waitForTimeout(5_000);
    const idsBefore = new Set(wire.botMessagesFor(channelArn).map((m) => m.messageId));

    await alignToCorrelationBucket();

    // THE PRODUCTION SEQUENCE. The real turn goes through Chime -> Lex and claims the correlation
    // first; the retry arrives afterwards, once a placeholder already exists. Injecting the duplicate
    // BEFORE the real fulfillment would invert that and suppress the user's own turn, which is a
    // different scenario and not the one this fix addresses.
    const transcript = `Live retry probe ${Date.now()}: what is the billing migration status?`;
    await page.locator('.message-textarea').fill(transcript);
    await page.keyboard.press('Enter');

    // Wait for the REAL placeholder, so the claim is provably taken before the duplicate is injected.
    const placeholder = await (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const hit = wire.botMessagesFor(channelArn)
          .find((m) => !idsBefore.has(m.messageId) && m.content.includes('<!--corr:'));
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    expect(placeholder, 'the real turn produced a placeholder carrying a correlation marker').toBeTruthy();
    console.log(`--- real placeholder ---\n${placeholder!.messageId}: ${placeholder!.content}`);

    // The retry Chime would deliver: same channel, same sender, same transcript, same window.
    const retried = invokeLambda(handler!, lexEvent({
      channelArn, senderArn, transcript, sessionId: `e2e-live-retry-${Date.now()}`,
    }));
    console.log('--- injected duplicate fulfillment ---\n' + JSON.stringify(retried?.messages));

    // The duplicate REPLAYS the live turn's placeholder rather than going silent, carrying the same
    // `<!--corr:{id}-->` marker the real placeholder above carries. Whichever response Chime
    // materialises therefore resolves to one placeholder, which the single dispatched processor
    // updates in place - and the channel-message count below is what proves only one survived.
    const retriedMarker = /<!--corr:([A-Za-z0-9._-]{1,64})-->/
      .exec(retried.messages.map((m: { content?: string }) => m.content || '').join(''));
    const liveMarker = /<!--corr:([A-Za-z0-9._-]{1,64})-->/.exec(placeholder!.content);
    expect(retried.messages.length, 'the duplicate replays a placeholder rather than going silent')
      .toBeGreaterThan(0);
    expect(retriedMarker?.[1], 'the duplicate carries the SAME correlation marker as the live turn')
      .toBe(liveMarker?.[1]);

    // Let the real turn finish updating its placeholder in place.
    await page.waitForTimeout(30_000);

    // THE USER-VISIBLE PROPERTY. Exactly one NEW bot message id for this turn. The answer arrives as
    // an UPDATE to the placeholder, which reuses its MessageId, so a second id can only mean a second
    // placeholder or a second answer - the duplicate-reply symptom itself. Counting ids rather than
    // frames is what makes this stable: the update re-arrives on the wire as another frame.
    const addedIds = wire.botMessagesFor(channelArn)
      .map((m) => m.messageId)
      .filter((id) => !idsBefore.has(id));
    const distinctAdded = new Set(addedIds);
    console.log(`--- distinct new bot message ids: ${distinctAdded.size} (${[...distinctAdded].join(', ')}) ---`);
    expect(distinctAdded.size, 'one turn produced exactly one bot message, not a duplicate').toBe(1);
  });
});
