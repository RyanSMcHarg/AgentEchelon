/**
 * THE COMPONENT THAT CREATED THE PLACEHOLDER RECORDS WHERE IT IS.
 *
 * ── THE MEASUREMENT THAT PROMPTED THIS ──────────────────────────────────────────────────────────
 *
 * CloudWatch, dev, three days to 2026-09-21, the three live async processors: 270 turns, of which
 * **127 (47%) entered `pollForPlaceholderMessage`, and NONE gave up**. 116 of the 127 found the
 * mapping on the SECOND read, roughly 150ms after the first miss.
 *
 * Never absent, only late. The lateness was one fixed thing: on the bypass path the router posts the
 * placeholder itself (ADR-025) and DISCARDED the `MessageId` the send handed back, so the id reached
 * the worker the long way around - Chime send, message event, channel flow invocation, DynamoDB
 * write - while the worker sat in a backoff loop waiting for the far end of that trip.
 *
 * `postAsAssistant` now claims the mapping from the send's own response.
 *
 * ── WHY THE FLOW'S CLAIM IS NOT REMOVED ─────────────────────────────────────────────────────────
 *
 * Because it is not redundant, and `channel-flow-processor.ts:508-520` is an explicit warning against
 * reading it as such: it is ADR-022's one-placeholder-per-turn duplicate guard, and it also covers
 * placeholders Amazon Chime SDK materializes from a Lex fulfillment, which `postAsAssistant` never
 * posts (it is bypass-only, `router-agent-handler.ts:748`).
 *
 * That makes the pre-claim's real risk a false duplicate: if the router's claim made the flow see the
 * correlation as already owned, the flow would DENY the very message the router just sent, and the
 * turn would lose its placeholder. The first describe below is that case, behaviorally.
 */
const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => ddbSend(...a) }) },
  PutCommand: jest.fn().mockImplementation((input) => ({ __type: 'Put', input })),
  UpdateCommand: jest.fn().mockImplementation((input) => ({ __type: 'Update', input })),
  GetCommand: jest.fn().mockImplementation((input) => ({ __type: 'Get', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutParameterCommand: jest.fn(),
}), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';

const src = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');

/** One table, standing in for DynamoDB's conditional write. */
function table() {
  const rows = new Map<string, string>();
  ddbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__type === 'Put') {
      const pk = cmd.input.Item.pk;
      if (rows.has(pk)) {
        const err: any = new Error('exists');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }
      rows.set(pk, cmd.input.Item.messageId);
      return {};
    }
    if (cmd.__type === 'Get') return { Item: rows.has(cmd.input.Key.pk) ? { messageId: rows.get(cmd.input.Key.pk) } : undefined };
    return {};
  });
  return rows;
}

describe('the router claiming first does not make the flow deny its own message', () => {
  let claimPlaceholderMapping: any;

  beforeAll(() => {
    process.env.ABUSE_CONTROLS_TABLE = 'ae-abuse';
    claimPlaceholderMapping = require('../../lambda/src/lib/abuse-controls').claimPlaceholderMapping;
  });
  beforeEach(() => { jest.clearAllMocks(); table(); });

  it('hands the same message back to the flow, so the flow allows it', async () => {
    // THE RISK THIS CHANGE INTRODUCES, PINNED. The flow denies when `owner !== MessageId`
    // (`channel-flow-processor.ts:539`). The router's pre-claim names the SAME message, so the flow's
    // claim returns that id, matches, and the placeholder survives.
    const first = await claimPlaceholderMapping('corr-1', 'msg-A');   // the router, at the send
    const second = await claimPlaceholderMapping('corr-1', 'msg-A');  // the flow, seeing it arrive
    expect(first).toBe('msg-A');
    expect(second).toBe('msg-A');
  });

  it('still names the original owner when a DIFFERENT message claims, which is the duplicate guard', async () => {
    // Non-vacuity for the case above: the guard must still fire, or the pre-claim would have bought
    // determinism by disabling ADR-022.
    await claimPlaceholderMapping('corr-2', 'msg-A');
    expect(await claimPlaceholderMapping('corr-2', 'msg-B')).toBe('msg-A');
  });

  it('is write-once, so the first sender owns the correlation', async () => {
    const rows = table();
    await claimPlaceholderMapping('corr-3', 'msg-A');
    await claimPlaceholderMapping('corr-3', 'msg-B');
    expect(rows.get('corr#corr-3')).toBe('msg-A');
  });
});

/**
 * `postAsAssistant` is module-local and sits inside the router handler, so it is guarded at the
 * source, the way `a-message-says-which-assistant-sent-it.test.ts` and
 * `only-a-private-request-makes-a-private-task.test.ts` already guard the same function.
 */
describe('the send records what it sent', () => {
  const router = src('router-agent-handler.ts');
  const post = router.slice(router.indexOf('async function postAsAssistant('));

  it('keeps the MessageId the send returns instead of discarding it', () => {
    // The defect in one line: the result was unassigned, so the id was thrown away at the one point
    // it was known for free.
    // The first part's MessageId, which is the message the correlation names (`sendInParts`).
    expect(post).toMatch(/const sent = await sendInParts\(chimeClient, /);
  });

  it('claims the mapping for the correlation the message actually carries', () => {
    // READ OFF THE CONTENT, through the same reader the flow uses (`lib/correlation.ts`), rather than
    // from a variable passed alongside it. The flow will claim on whatever marker is IN the message,
    // so reading anything else could map a correlation the flow never sees.
    expect(post).toContain('correlationMarkerOf(content)');
    expect(post).toMatch(/claimPlaceholderMapping\(corr, sent\.MessageId\)/);
  });

  it('does not let a failed mapping write fail the turn', () => {
    // It degrades to exactly today's behavior - the poll - which is why it must not throw. The turn
    // has already been posted at this point; losing the reply over a bookkeeping write would trade a
    // 150ms saving for a dropped answer.
    const claimIdx = post.indexOf('claimPlaceholderMapping(corr, sent.MessageId)');
    const guardIdx = post.lastIndexOf('try {', claimIdx);
    const catchIdx = post.indexOf('the worker will poll for it', claimIdx);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(claimIdx);
  });

  it('claims only after a successful send, never for a message that was not posted', () => {
    // A mapping naming a message that does not exist is worse than none: the worker would resolve to
    // it and update nothing, silently.
    const sendIdx = post.indexOf('const sent = await chimeClient.send(');
    const claimIdx = post.indexOf('claimPlaceholderMapping(corr, sent.MessageId)');
    expect(sendIdx).toBeLessThan(claimIdx);
  });
});

/**
 * THE CLAIM MUST NOT NAME A MESSAGE THE FLOW IS ABOUT TO DROP.
 *
 * `channel-flow-processor.ts:390-394` states the rule the flow orders itself by: the loop guard, the
 * empty envelope and the status artifact are checked "before the correlation claim ... a message on
 * its way to being dropped must not consume a claim."
 *
 * Claiming at the send moves the claim IN FRONT of all three. If one of them ever fired on a message
 * `postAsAssistant` posted, the mapping would name a message the flow denied - never persisted - and
 * the worker would resolve to it instantly and update nothing, trading a recoverable 3.3s poll for a
 * silently lost answer.
 *
 * It cannot fire today, for three separate reasons, and those reasons are the point of this block:
 * they are properties of `postAsAssistant` rather than of the guards, so they are exactly the kind of
 * thing a later edit changes without looking at the flow. Each is pinned so that change fails here.
 */
describe('the three drops the claim now precedes cannot reach it', () => {
  const router = src('router-agent-handler.ts');
  const post = router.slice(router.indexOf('async function postAsAssistant('));

  it('never posts an empty message, so the empty-envelope drop has nothing to catch', () => {
    // `if (!content) return response;` - the early return is the guarantee, and it sits above the send.
    const guard = post.indexOf('if (!content) return response;');
    const send = post.indexOf('const sent = await sendInParts(chimeClient, ');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(send);
  });

  it('targets a person or nobody, never a bot, so the loop guard allows it', () => {
    // BEHAVIORAL, against the guard itself. Every deny in `evaluateBotToBot` is downstream of the
    // message targeting a BOT (`lib/bot-coordination.ts:151` returns allow on `not-bot-targeted`), and
    // postAsAssistant's only Target is the human sender of a private request.
    const { evaluateBotToBot } = require('../../lambda/src/lib/bot-coordination');
    const { extractTargetedBotArns } = require('../../lambda/src/lib/battle-state');
    const INSTANCE = 'arn:aws:chime:us-east-1:1:app-instance/i';
    const human = `${INSTANCE}/user/alice`;
    const bot = `${INSTANCE}/bot/atlas`;

    // What postAsAssistant actually sets on a private request.
    expect(extractTargetedBotArns([{ MemberArn: human }])).toEqual([]);
    expect(evaluateBotToBot({
      senderArn: bot, targetBotArns: [], content: 'One moment... <!--corr:mention-abc-->',
    }).action).toBe('allow');

    // Non-vacuity: the guard is not simply allowing everything. A bot-targeted message with no
    // coordination marker is the case it exists to deny.
    expect(evaluateBotToBot({
      senderArn: bot, targetBotArns: [bot], content: 'no marker here',
    }).action).toBe('deny');

    // And the source really does target the sender rather than a bot.
    expect(post).toContain('Target: [{ MemberArn: senderArn }]');
  });

  it('composes its own text, so it cannot post an Amazon Chime SDK status artifact', () => {
    // The artifact drop catches `{"Code":500}` arriving where an answer belongs, which is a shape a
    // FULFILLMENT returns. This function posts the content the turn built.
    expect(post).toContain('const content = response.messages?.[0]?.content;');
  });
});

describe('and there is no longer a wait to label', () => {
  /**
   * This asserted that the two poll call sites were labeled, so the 47% could be split into "delayed
   * the turn starting" and "delayed a finished answer landing". That label did its job: the split it
   * produced is what showed the pre-inference wait served no population, and then that the delivery
   * wait served none either. Both are gone, so there is nothing left to label.
   *
   * What survives is the property the label was measuring towards - that the sender recording where
   * it sent is what makes the wait unnecessary.
   */
  it('resolves from the mapping, with no retry loop behind it', () => {
    const core = src('lib/async-processor-core.ts');
    expect(core).not.toContain('export async function pollForPlaceholderMessage');
    expect(core).not.toMatch(/site: 'before-inference' \| 'at-delivery'/);
    const at = core.indexOf('export async function resolveDeliveryMessageId');
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 900)).toContain('return target.messageId || null;');
  });
});
