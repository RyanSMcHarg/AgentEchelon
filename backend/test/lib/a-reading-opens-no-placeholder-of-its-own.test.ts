/**
 * ONE THING SHOWS PROGRESS WHILE A QUEUE IS READ, AND THE PROPOSAL LANDS AT THE END.
 *
 * Owner's rule (2026-09-09): one placeholder, updated as each new message arrives, until the lock is
 * released - then a final response that falls at the end of the conversation.
 *
 * A reading turn was breaking the first half. A queue already draws a NOTICE, which is the message a
 * person watches fill up as they type, and the reading then opened a second "One moment..." beside
 * it. Two working indicators for one piece of work, reported as "why so many placeholders".
 *
 * ── AND THE OBVIOUS FIX IS THE ONE THING THAT MUST NOT BE DONE ──────────────────────────────────
 *
 * Handing the reading the notice to answer onto removes the second bubble and introduces a worse
 * defect. The notice is created when the queue FORMS, so it sits ABOVE every message that arrived
 * afterwards - which is exactly what the proposal is about. Amazon Chime SDK orders by creation time
 * and an update does not move a message, so the proposal would appear above the questions it answers.
 * ADR-029 exists for that: "the finished answer appears in the bubble from before they were asked
 * anything, above everything sent since", and `router-agent-handler.ts` says it plainly at
 * `placeholderMessageId` - "Do not add a caller".
 *
 * So the two halves are separated. The router opens NOTHING for a reading, and the processor posts a
 * FRESH message when it has the proposal, which puts it after the messages it read.
 */

const mockMessagingSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __t: 'Send', input })),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __t: 'Update', input })),
  GetChannelMessageCommand: jest.fn().mockImplementation((input) => ({ __t: 'Get', input })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((input) => ({ __t: 'List', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

describe('the router opens nothing for a reading', () => {
  const router = read('lambda/src/router-agent-handler.ts');

  it('returns silence instead of posting a placeholder', () => {
    // A SOURCE GUARD, because the branch is one line inside a handler whose other thirty dependencies
    // are not what this is about, and the defect was entirely in whether the branch existed.
    expect(router).toContain('if (isSelfDispatchedTriage(event) && spoke.dispatched) {');
  });

  it('only when a worker actually ran', () => {
    // Silence is safe because something else finishes the job. Unconditional silence is how a
    // non-dispatching exit - the catch-all error, the missing-ARN fall-through - reached nobody at
    // all, which is recorded on the branch immediately above this one.
    const at = router.indexOf('if (isSelfDispatchedTriage(event) && spoke.dispatched) {');
    expect(at).toBeGreaterThan(-1);
    expect(router.slice(at, at + 200)).toContain('formatLexSilentResponse');
  });

  it('does NOT hand the reading a message to answer onto', () => {
    // The forbidden fix. `placeholderMessageId` still has no producer, and its own doc says why.
    expect(router).toContain('NO PRODUCER SINCE');
    // The dispatcher must not have started supplying one.
    const triage = read('lambda/src/lib/turn-triage.ts');
    expect(triage).not.toContain('placeholderMessageId:');
  });
});

describe('the proposal is posted fresh, so it falls after the messages it read', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');

  it('posts a new message when a reading has no placeholder', () => {
    expect(core).toContain('const postReadingCarrier = async (): Promise<void> => {');
  });

  it('posts it rather than updating anything that already exists', () => {
    const at = core.indexOf('const postReadingCarrier = async (): Promise<void> => {');
    expect(at).toBeGreaterThan(-1);
    const block = core.slice(at, at + 900);
    // A new message: creation time is what puts it at the end.
    expect(block).toContain('sendChannelMessage(');
    expect(block).not.toContain('UpdateChannelMessageCommand');
  });

  it('records the id so a late failure can still find it', () => {
    const at = core.indexOf('const postReadingCarrier = async (): Promise<void> => {');
    const block = core.slice(at, at + 900);
    expect(block).toContain('event.broadcastMessageId = posted.MessageId');
  });

  it('does not fail the reading when the post fails', () => {
    // The proposal is how the person is TOLD, and losing it must not lose the reading: the tasks are
    // still created and the queue is still cleared, which is the work.
    const at = core.indexOf('const postReadingCarrier = async (): Promise<void> => {');
    const block = core.slice(at, at + 1200);
    expect(block).toContain('catch');
    expect(block).toContain('could not post the message to carry the proposal');
  });
});

/**
 * ── AND THE PROCESSOR MUST NOT REFUSE A READING FOR NOT HAVING ONE ──────────
 *
 * The two halves above were both in place and the drain still died, because a third piece of code
 * settled it first. `assistant-async-processor.ts` resolves the placeholder at answer time and, when
 * there is none, refuses to deliver: posting a replacement duplicates the answer and strands a "One
 * moment..." bubble, so losing the reply is the honest outcome. That was written when every turn had
 * a placeholder. For a reading the absence is now DESIGNED, and the refusal returned before the code
 * that posts the message could run - so the fresh-post branch above was unreachable in production.
 *
 * Observed live 2026-09-09 in two conversations minutes apart: "No placeholder for correlationId
 * after the answer was ready: arrival-2e8530c4...-4 - the reply cannot be delivered. Not posting a
 * replacement." The reading had already done the work. What was lost with the message was the drain:
 * the queue stayed at five, the deferral notice kept promising to read messages nobody read, and the
 * next turn handed over to another reading that died the same way. Four questions, no answers.
 */
describe('the processor delivers a reading rather than refusing it', () => {
  const handler = read('lambda/src/assistant-async-processor.ts');

  it('does not treat a missing placeholder as a failure for a reading', () => {
    expect(handler).toContain('const readingOwnsNoPlaceholder = !!event.triage;');
    expect(handler).toContain('if (!deliverMessageId && !readingOwnsNoPlaceholder) {');
  });

  it('posts every OTHER turn\'s answer as a new message, and records it undeliverable only if that fails', () => {
    // A turn whose placeholder should exist and does not still has an answer the person paid for, and the
    // turn's session is the assistant, so it posts the answer itself. A reading is not
    // this branch: it owns no placeholder by design.
    const at = handler.indexOf('no placeholder; the answer was posted as a new message');
    expect(at).toBeGreaterThan(-1);
    expect(handler.slice(at - 2500, at)).toContain('if (!deliverMessageId && !readingOwnsNoPlaceholder) {');
    const after = handler.slice(at, at + 1500);
    expect(after).toContain("reason: 'reply_undeliverable'");
  });

  it('does not pay for a scan that cannot succeed', () => {
    // No placeholder was created for the reading's correlation id, so scanning the channel for its
    // marker is a billed ListChannelMessages that can only ever come back empty.
    const at = handler.indexOf('deliverMessageId = await scanForPlaceholderMessage(');
    expect(at).toBeGreaterThan(-1);
    expect(handler.slice(at - 200, at)).toContain('!readingOwnsNoPlaceholder');
  });

  it('hands the reading an empty id, which is what the fresh post keys on', () => {
    expect(handler).toContain('messageId: deliverMessageId || \'\',');
  });
});

describe('an update with no message to write to', () => {
  beforeEach(() => {
    mockMessagingSend.mockReset();
    mockMessagingSend.mockResolvedValue({});
  });

  it('writes nothing and does not throw', async () => {
    // If the reading's own post fails, the id stays empty. A throw here would leave the turn without
    // clearing the queue or releasing the lock, which costs the room every later turn - much worse
    // than a lost proposal. So it is loud and inert, and the caller carries on to clear and release.
    const { updateMessage } = require('../../lambda/src/lib/async-processor-core');
    const errors: unknown[][] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      await expect(
        updateMessage('arn:aws:chime:us-east-1:111:app-instance/i/channel/c1', '', 'the proposal', 'arn:bot', 'final'),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(mockMessagingSend).not.toHaveBeenCalled();
    expect(JSON.stringify(errors)).toContain('no id');
  });
});

/**
 * ── AND IT DOES NOT WAIT FOR ONE EITHER ──────────────────────────────────────
 *
 * The mapping a turn resolves its placeholder from is written by the channel flow when a bot message
 * carrying a `<!--corr:{id}-->` marker passes through it. A reading's correlation id never gets one,
 * because no message is ever posted under it. So the dispatch-time resolution was waiting on an event
 * that is not merely late but never emitted: nine DynamoDB reads of a key nobody writes, about 3.3
 * seconds of wall clock added to every drain before inference started, and then a warning logged as
 * though something had failed.
 *
 * Tenet D6 in its plainest form. The absence is designed, so it is neither waited for nor warned about.
 */
describe('a reading does not wait for a mapping nobody writes', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');

  it('skips the mapping read at dispatch', () => {
    expect(core).toContain('readingOwnsNoPlaceholder ? null : await readPlaceholderMapping(correlationId)');
  });

  it('skips the poll entirely - and so does everything else, now', () => {
    // This used to assert the reading-shaped guard around a pre-inference poll. That poll is gone
    // for EVERY path, not just readings: the only turns that ever reached it were ones it could not
    // help (see the call-site comment), and it sat in front of the model call. The reading's
    // property therefore holds more strongly than when it was written, so the assertion is the
    // stronger one - nothing waits for a placeholder before inference at all.
    const prepare = core.indexOf('const readingOwnsNoPlaceholder = !!event.triage;');
    expect(prepare).toBeGreaterThan(-1);
    const beforeInference = core.slice(prepare, prepare + 4000);
    expect(beforeInference).not.toContain('pollForPlaceholderMessage');
  });

  it('leaves no poll anywhere, not even at delivery', () => {
    // The delivery-side poll went too: by then the placeholder has had the whole inference window to
    // land, so a point read finds it, and a miss means the mapping was never written - which another
    // read of the same absent key cannot fix. See a-poll-does-not-wait-after-its-last-look.
    expect(core).toContain('return target.messageId || null;');
    expect(core).not.toContain('export async function pollForPlaceholderMessage');
  });

  it('still honours a handed id, so this narrows what is read and not what is allowed', () => {
    const at = core.indexOf('const readingOwnsNoPlaceholder = !!event.triage;');
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 300)).toContain('event.placeholderMessageId');
  });

  it('does not report the designed absence as a warning', () => {
    const at = core.indexOf('} else if (readingOwnsNoPlaceholder) {');
    expect(at).toBeGreaterThan(-1);
    // The branch itself, not the sibling that SHOULD warn: end the window where the else begins.
    const block = core.slice(at, core.indexOf('} else {', at));
    expect(block).toContain('console.log');
    expect(block).not.toContain('console.warn');
  });

  it('still warns for a turn whose placeholder should have existed', () => {
    // The warning is the signal for the real fault (#19). Losing it would hide the case it names.
    expect(core).toContain('Placeholder unresolved at dispatch; continuing and resolving at answer time');
  });
});
