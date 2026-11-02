/**
 * ONLY A MESSAGE SENT AS TARGETED MAKES A PRIVATE TASK.
 *
 * "It should only be a private task if I sent it as targeted, not just a mention or auto routed."
 *
 * ── THE CONFLATION THIS PINS APART ──────────────────────────────────────────────────────────────
 *
 * Two questions, and they are not the same one:
 *
 *   where the ANSWER goes - to the room, or to the person who asked.
 *   whether the REQUEST was sent privately, which decides the task's visibility, whether the
 *   acknowledgment is addressed, and whether the answer is.
 *
 * They agree for `@all` (public question, public answer) and for `.assistant` (private both ways), so
 * deriving one from the other held until the flow began owning ordinary 1:1 turns. Those pass
 * `broadcast: false` - the answer is for the asker, not the room - and that made EVERY task opened in
 * a 1:1 private.
 *
 * MEASURED in `conv-1790010890868-807ae3b58087`: a plainly public "List all the tasks in this
 * conversation and their status" opened a task the store still shows as `visibility: private`, and
 * every answer to it was targeted - so a two-person conversation collected four public "I have replied
 * to you privately." receipts, and the person asked why.
 *
 * ── WHY DECLARING `false` MATTERS AS MUCH AS DECLARING `true` ───────────────────────────────────
 *
 * Absent visibility READS AS PRIVATE (`task-visibility.ts`). So a path that stays quiet is not
 * neutral: it reaches the same outcome by omission. Every dispatch therefore declares.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');
const flow = src('channel-flow-processor.ts');
const router = src('router-agent-handler.ts');

describe('the request decides the task visibility, not the answer', () => {
  it('declares privacy from the REQUEST, never from where the answer goes', () => {
    expect(flow).toContain('targeted: requestWasPrivate === true');
    // The derivation that caused it. `!broadcast` answers a different question.
    expect(flow).not.toContain('targeted: !broadcast');
  });

  // BOTH HALVES OF "PRIVATE" FOLLOW THE ONE FLAG: even in a 1:1, a message and its answer are private only
  // when explicitly targeted. A 1:1 has no third party to
  // withhold from, so a `Target` there conceals nothing and only records the exchange as private.
  it('addresses what it posts only for a private request, never merely because the answer is for the asker', () => {
    expect(flow).toContain('const targetArns = requestWasPrivate === true ? [senderArn] : undefined;');
    // The flag that meant "where the answer goes" is gone, so nothing can read it as "this is private".
    expect(flow).not.toMatch(/^\s*broadcast: (true|false),$/m);
    expect(flow).not.toContain('broadcast: boolean;');
    expect(flow).not.toContain('broadcast ? undefined : [senderArn]');
  });

  it('only the private-address dispatch claims a private request', () => {
    const claims = flow.split('requestWasPrivate: true').length - 1;
    expect(claims).toBe(1);
    // And it sits in the `.assistant` branch, which is the only one that resolved a private target.
    const at = flow.indexOf('requestWasPrivate: true');
    const before = flow.slice(Math.max(0, at - 1800), at);
    expect(before).toContain('botArn: privateTo.arn');
  });

  // EVERY OTHER DISPATCH IS A PUBLIC REQUEST, including the ordinary 1:1 turn the flow now owns.
  // Listed by their `broadcast` value so a new dispatch that copies `broadcast: false` cannot quietly
  // inherit privacy with it.
  it('an ordinary 1:1 turn is not a private request, so nothing about it is addressed', () => {
    const at = flow.indexOf('the flow owns this untargeted turn');
    expect(at).toBeGreaterThan(-1);
    // Bounded by the dispatch this branch makes, not by a character count: a fixed window ran past the
    // branch into later code that mentions the flag, and reported a pass or a failure about the wrong
    // lines either way.
    const branch = flow.slice(at, flow.indexOf('});', flow.indexOf('handOffTurnToRouter(', at)));
    expect(branch).toContain('handOffTurnToRouter(');
    // Asserted on the PROPERTY, not the word: this branch explains in a comment why it sets none, and a
    // bare substring test read that explanation as the thing it was looking for.
    expect(branch).not.toMatch(/^s*requestWasPrivate:/m);
  });

  // THE OTHER HALF OF THE OWNER'S RULE: "Targeted messages ... always generate a private response that
  // starts with a private placeholder. Any other message has a broadcast placeholder and broadcast
  // message even in a 1:1."
  //
  // The acknowledgment used to be posted untargeted ALWAYS, so a private task could not be answered
  // onto it - and `planResumedChainDelivery` posted the answer as a second targeted message, leaving
  // this one to say "I have replied to you privately." Targeted from the start, the answer updates it
  // in place and no receipt exists.
  it('a private request starts with a private acknowledgment, and nothing else does', () => {
    const post = router.slice(router.indexOf('async function postAsAssistant('));
    expect(post).toContain("event.requestAttributes?.[BYPASS_TARGETED_ATTR] === '1'");
    expect(post).toContain('...(privateRequest && { Target: [{ MemberArn: senderArn }] })');
    // Stamped as well as targeted, so the frontend renders it as a directed reply.
    expect(post).toContain('privateRequest ? { targetedSender: senderArn } : undefined');
    // The claim it replaces, so the old unconditional wording cannot come back.
    expect(post).not.toContain('UNTARGETED, always');
  });

  // ONE READER, which is what makes this change safe to reason about: it moves task visibility and
  // nothing else. If a second consumer appears, this test is where that gets noticed.
  it('the declared flag is read only where task visibility is decided', () => {
    const reads = router.split('declaredTargeted()').length - 1;
    // One definition, one call.
    expect(reads).toBe(1);
    const at = router.indexOf('const declared = declaredTargeted();');
    expect(at).toBeGreaterThan(-1);
    const around = router.slice(Math.max(0, at - 900), at + 400);
    expect(around).toContain('visibility');
  });

  // The Lex path keeps failing CLOSED, and that is correct rather than inconsistent: with the flow
  // owning every untargeted turn, a message only reaches Amazon Lex by being targeted, so an
  // unresolvable lookup there really is more likely to be a private message than a public one.
  it('leaves the unresolved Lex-path lookup failing closed', () => {
    expect(router).toContain("? {}\n          : { visibility: targeted ? ('private' as const) : ('conversation' as const) }");
  });
});

/**
 * THE DECLARATION IS ABOUT THE TEXT. THE STORED MESSAGE IS ABOUT THE `Target`.
 *
 * The flow declares `false` for "not addressed in the text", which is NOT the same fact as "not sent
 * with a `Target`" - and it cannot tell them apart, because the callback carries no `Target` (ADR-029,
 * ADR-034). MEASURED 2026-09-28 against the deployed stack: `turn-queue.spec.ts:1251` sent a genuine
 * `Target` and read `visibility: conversation` off the agent row, so a privately targeted request
 * opened a task the room could see.
 *
 * That is the one direction ADR-033 says cannot be taken back, and it is also not what the 2026-09-21
 * decision asked for - that decision is about an openly-asked turn not becoming private, and a targeted
 * send is not an openly-asked turn. So the two decisions were never actually in conflict; the
 * implementation just could not distinguish the cases, and now it resolves the second half from the
 * stored message rather than guessing.
 */
describe('a declared "untargeted" is checked against the stored message', () => {
  it('verifies a declared false, because the declaring path cannot see `Target`', () => {
    expect(router).toContain('if (declared === false && channelArn && verifyId)');
    expect(router).toContain('inboundWasTargeted(chimeClient, channelArn, verifyId');
  });

  it('only ever upgrades to private, never downgrades to shared', () => {
    // The check may set `targeted = true`; it must never set it false. Downgrading on a read would
    // make an unreadable message publish a private request, which is the failure ADR-033 forbids.
    const at = router.indexOf('if (declared === false && channelArn && verifyId)');
    expect(at).toBeGreaterThan(-1);
    const block = router.slice(at, at + 1400);
    expect(block).toContain('targeted = true;');
    expect(block).not.toContain('targeted = false;');
  });

  it('keeps the declaration when the message cannot be read, rather than making every turn private', () => {
    const at = router.indexOf('if (declared === false && channelArn && verifyId)');
    const block = router.slice(at, at + 1400);
    // A try/catch that keeps the declaration: overriding on a failed read would reinstate the four
    // receipts by another route, since `inboundWasTargeted` already answers false when it cannot read.
    expect(block).toContain('catch');
    expect(block).toContain('keeping the declaration');
  });

  it('pays the read only when a task is opened, so it is off the time-to-first-frame path', () => {
    // Inside `inboundTaskFields`, which runs at task creation - after the placeholder. If this check
    // ever migrates into the flow, every turn pays a GetChannelMessage to serve the few that open work.
    const fieldsAt = router.indexOf('const inboundTaskFields = async ()');
    const checkAt = router.indexOf('if (declared === false && channelArn && verifyId)');
    expect(fieldsAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(fieldsAt);
    expect(flow).not.toContain('inboundWasTargeted');
  });
});
