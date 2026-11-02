/**
 * WHAT THE OWNER'S FIRST LIVE BURST AFTER THE PARK/RESUME DEPLOY STILL SHOWED (2026-09-14).
 *
 * The follow-ups were folded into the answer, and four things were still wrong:
 *  1. each reading pass that handed off to another left a "..." nothing ever resolved, and the fold's
 *     history read them back as assistant turns;
 *  2. the proposal promised to fold the follow-ups "when I respond" and to "get the full answer to you
 *     first", while the runtime was already folding them without waiting;
 *  3. the fold had no message id, so its history was bounded by the queue alone and read the notice,
 *     the strays and the proposal;
 *  4. the fold was applied as the person's answer to the reading's newly opened task, and read the
 *     split offer as though the person had answered it.
 * Plus the live turn-queue e2e: a stop evaluation's room-visible reply named a private request.
 *
 * Pinned at source for the reason the other queue tests here give: each crosses a whole reading or
 * router turn.
 */

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const core = read('lambda/src/lib/async-processor-core.ts');
const processor = read('lambda/src/assistant-async-processor.ts');
const router = read('lambda/src/router-agent-handler.ts');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTriagePrompt, parseTriageTurnContext } = require('../../lambda/src/lib/turn-triage-proposal');

describe('a reading pass that hands off posts nothing', () => {
  it('the message is posted on demand, not at the top of every pass', () => {
    expect(core).toContain('const postReadingCarrier = async (): Promise<void> => {');
    expect(core).not.toMatch(/if \(!deliveryMessageId && event\.triage\) \{\s*try \{/);
  });

  it('only the two exits that write into it post it, and the hand-offs return before either', () => {
    const posts = core.split('await postReadingCarrier();').length - 1;
    expect(posts).toBe(2);
    const moved = core.indexOf("'[AsyncProcessor][triage] the queue moved under the reading; reading it again'");
    const another = core.indexOf("'[AsyncProcessor][triage] the reading is not ready; taking another pass'");
    const firstPost = core.indexOf('await postReadingCarrier();');
    expect(moved).toBeGreaterThan(-1);
    expect(another).toBeGreaterThan(-1);
    expect(firstPost).toBeGreaterThan(Math.max(moved, another));
  });

  it('a reading records its analytics on the message it posts, and nowhere before it exists', () => {
    expect(core).toContain('if (!event.triage) await writeTurnAnalytics();');
    expect(core.split('await postReadingCarrier();\n').length - 1).toBe(2);
    for (const at of [...core.matchAll(/await postReadingCarrier\(\);/g)].map((m) => m.index!)) {
      expect(core.slice(at, at + 120)).toContain('await writeTurnAnalytics();');
    }
  });

  it('the passes that handed off are still counted, on the pass that posts', () => {
    expect(core.split('priorPasses: { inputTokens, outputTokens, bedrockMs: bedrockTime },').length - 1).toBe(2);
    expect(core).toContain('const inputTokens = params.inputTokens + (carriedPasses?.inputTokens ?? 0);');
    const ctx = parseTriageTurnContext(JSON.stringify({
      ids: ['m1'], visibility: 'conversation', inFlight: false, pass: 2,
      priorPasses: { inputTokens: 100, outputTokens: 20, bedrockMs: 900 },
    }));
    expect(ctx.priorPasses).toEqual({ inputTokens: 100, outputTokens: 20, bedrockMs: 900 });
    const bad = parseTriageTurnContext(JSON.stringify({
      ids: ['m1'], visibility: 'conversation', inFlight: false, pass: 2, priorPasses: { inputTokens: 'x' },
    }));
    expect(bad.priorPasses).toBeUndefined();
  });
});

describe('the proposal says what is actually happening to the follow-ups', () => {
  it('with work in flight, it says changes are being included now and asks only about the rest', () => {
    const prompt = buildTriagePrompt({
      queued: [{ messageId: 'm2', content: 'who created it' }],
      inFlightLabel: 'What is AgentEchelon?',
      viaTool: true,
    });
    expect(prompt).toMatch(/being included in that answer now/);
    expect(prompt).toMatch(/do not ask them to confirm it\s+or to wait for it/);
    expect(prompt).toMatch(/Ask only about the new or unclear messages/);
  });

  it('with nothing in flight, it says nothing about folding', () => {
    const prompt = buildTriagePrompt({ queued: [{ messageId: 'm2', content: 'hi' }], viaTool: true });
    expect(prompt).not.toMatch(/being included in that answer now/);
  });
});

describe('a turn keeps the id of the message it answers', () => {
  it('writes the id it found back onto the event, before finalize can park or fold it', () => {
    expect(processor).toContain('if (!event.userMessageId) event.userMessageId = messageId;');
    const awaitAt = processor.indexOf('await holderRecorded;\n    redispatchedPass = (await finalizePlaceholderResponse({');
    expect(awaitAt).toBeGreaterThan(-1);
  });
});

describe('a fold is not the person speaking', () => {
  it('is recognized by its fold count', () => {
    expect(router).toContain('function isAmendmentFold(event');
    expect(router).toContain('return Number(event.requestAttributes?.[BYPASS_AMENDED_FOLD_ATTR]) > 0;');
  });

  it('is not applied as an answer, read for drift, read against a stop question, or sent through onboarding', () => {
    expect(router).toContain('if (answered && !isMachineWrittenTurn(event) && !isAmendmentFold(event)) {');
    expect(router).toContain('const driftResponse = isMachineWrittenTurn(event) || isAmendmentFold(event) || battleCtx || willRefuse ? null');
    expect(router).toContain('if (!isMachineWrittenTurn(event) && !isAmendmentFold(event) && channelArn && personId) {');
    expect(router).toContain('channelArn && !isMachineWrittenTurn(event) && !isAmendmentFold(event)) {');
  });

  it('keeps its task lookup, so a fold of a task step still continues that task', () => {
    const fn = router.slice(router.indexOf('function isMachineWrittenTurn('), router.indexOf('function isAmendmentFold('));
    expect(fn).not.toContain('BYPASS_AMENDED_FOLD_ATTR');
    expect(router).toContain('if ((battleCtx || channelArn || !shortAcknowledgment) && !isMachineWrittenTurn(event)) {');
  });

  it('does not read a pending split offer', () => {
    expect(processor).toContain('if (!event.triage?.ids.length && !event.amendedFold && event.senderArn) {');
  });
});

describe('"caught up" waits for the answer the follow-ups went into', () => {
  const lock = read('lambda/src/lib/turn-lock.ts');
  const handover = read('lambda/src/lib/turn-handover.ts');

  it('the reading keeps the notice when it handed follow-ups to an answer still being written', () => {
    expect(core).toContain('const answerStillComing = workStillInFlight && amending.length > 0;');
    expect(core).toContain('...(answerStillComing ? { keepNotice: true } : {}),');
    expect(core).toContain('if (noticeBeforeClear && !stillWaiting && !answerStillComing) {');
  });

  it('clearing the queue can leave the notice pointer for the answer to settle', () => {
    expect(lock).toContain("? 'REMOVE queued, triagedBy, triageAt, queueStatus, drainTaskId'");
    expect(lock).toContain("ConditionExpression: 'noticeId = :n AND (attribute_not_exists(queued) OR size(queued) = :zero)'");
  });

  it('the answering turn settles it at its exit, before the outstanding-question release can return', () => {
    const settle = handover.indexOf('if (!triage && state.noticeId && !state.triagedBy && !state.queued.length) {');
    const question = handover.indexOf('if (awaiting.length && !state.queued.length) {');
    const empty = handover.indexOf("'[turn-handover] nothing queued behind this turn; releasing normally'");
    expect(settle).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(question);
    expect(settle).toBeLessThan(empty);
  });
});
