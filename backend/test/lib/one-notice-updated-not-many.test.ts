/**
 * ONE NOTICE, UPDATED - NEVER ONE PER MESSAGE (ADR-033).
 *
 * Tenet 4 says a deferred message gets a reply rather than silence, and the obvious implementation
 * posts that reply every time. It reproduces the exact doubling this design exists to prevent: three
 * messages sent while the assistant is busy would draw three near-identical "still working on it"
 * lines, and the conversation ends up noisier than if nothing had been said.
 *
 * ── THE TWO WAYS THIS GOES WRONG, IN OPPOSITE DIRECTIONS ────────────────────────────────────────
 *
 * TOO MANY: an update path that silently posts instead is invisible in code review and obvious to the
 * person, who watches the assistant repeat itself.
 *
 * NONE AT ALL: a failure that returns silence is worse, because a deferral nobody was told about is
 * indistinguishable from a broken assistant - which is the entire failure tenet 4 exists to prevent.
 * So every failure here degrades into the OLD behavior, never into quiet.
 */
import { ownWords } from '../helpers/own-templates';

const mockSend = jest.fn();
const mockRemember = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockSend(...a); },
  SendChannelMessageCommand: class { __t = 'Send'; constructor(public input: any) {} },
  UpdateChannelMessageCommand: class { __t = 'Update'; constructor(public input: any) {} },
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  rememberNotice: (...a: unknown[]) => mockRemember(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const notice = require('../../lambda/src/lib/turn-queue-notice');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1';
const base = { channelArn: CHANNEL, botArn: BOT, responderId: 'b1' };

const kinds = () => mockSend.mock.calls.map(([c]: any[]) => c.__t);
const lastInput = () => mockSend.mock.calls[mockSend.mock.calls.length - 1][0].input;

beforeEach(() => {
  mockSend.mockReset();
  mockRemember.mockReset();
  mockRemember.mockResolvedValue(undefined);
});

describe('the first queued message', () => {
  it('POSTS a notice and records its id', async () => {
    mockSend.mockResolvedValue({ MessageId: 'm-notice' });
    const id = await notice.showQueueNotice({ ...base, depth: 1, overflowed: false });
    expect(id).toBe('m-notice');
    expect(kinds()).toEqual(['Send']);
    // Recorded, or the NEXT message posts a second notice instead of updating this one.
    expect(mockRemember).toHaveBeenCalledWith({ channelArn: CHANNEL, responderId: 'b1', noticeId: 'm-notice' });
  });

  it('is UNTARGETED, so other members stop reading the silence as a broken assistant', async () => {
    mockSend.mockResolvedValue({ MessageId: 'm-notice' });
    await notice.showQueueNotice({ ...base, depth: 1, overflowed: false });
    expect(lastInput().Target).toBeUndefined();
  });

  it('says nothing about WHICH messages are waiting', async () => {
    // A targeted request must not become visible through the notice. It carries a count, and a count
    // is not a disclosure.
    mockSend.mockResolvedValue({ MessageId: 'm-notice' });
    await notice.showQueueNotice({ ...base, depth: 3, overflowed: false });
    const body = decodeURIComponent(lastInput().Content) + JSON.stringify(lastInput().Metadata);
    expect(body).not.toMatch(/m-\d|messageId/i);
  });
});

describe('every later queued message', () => {
  it('UPDATES the notice already showing, and posts nothing new', async () => {
    // The assertion this file exists for.
    mockSend.mockResolvedValue({});
    const id = await notice.showQueueNotice({
      ...base, depth: 2, overflowed: false, existingNoticeId: 'm-notice',
    });
    expect(id).toBe('m-notice');
    expect(kinds()).toEqual(['Update']);
    expect(mockSend.mock.calls[0][0].input.MessageId).toBe('m-notice');
  });

  it('carries the CURRENT count, which is the only thing that changed', async () => {
    mockSend.mockResolvedValue({});
    await notice.showQueueNotice({ ...base, depth: 4, overflowed: false, existingNoticeId: 'm-notice' });
    expect(decodeURIComponent(lastInput().Content)).toContain('all 4 of these');
  });

  it('does not re-record an id that has not changed', async () => {
    mockSend.mockResolvedValue({});
    await notice.showQueueNotice({ ...base, depth: 2, overflowed: false, existingNoticeId: 'm-notice' });
    expect(mockRemember).not.toHaveBeenCalled();
  });
});

describe('the drop is always stated', () => {
  it('says a message was discarded, rather than letting the count quietly stop rising', async () => {
    // An overflowed queue discarded something the person SENT. A notice that only ever reported a
    // depth would make data loss the one thing it never mentioned.
    mockSend.mockResolvedValue({ MessageId: 'm1' });
    await notice.showQueueNotice({ ...base, depth: 5, overflowed: true });
    const text = decodeURIComponent(lastInput().Content);
    expect(text).toContain('drop');
    expect(text).toContain('send it again');
  });
});

describe('it degrades into the old behaviour, never into silence', () => {
  it('posts a fresh notice when the update fails', async () => {
    // The existing one may have been moderated away. Posting again beats going quiet.
    mockSend.mockRejectedValueOnce(new Error('not found')).mockResolvedValueOnce({ MessageId: 'm2' });
    const id = await notice.showQueueNotice({
      ...base, depth: 2, overflowed: false, existingNoticeId: 'gone',
    });
    expect(id).toBe('m2');
    expect(kinds()).toEqual(['Update', 'Send']);
  });

  it('returns null when the post fails, so the caller can hand it to Lex', async () => {
    // Null is the signal to fall back. Two notices is untidy; none is indistinguishable from a broken
    // assistant.
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await notice.showQueueNotice({ ...base, depth: 1, overflowed: false })).toBeNull();
  });

  it('returns null when the post succeeds but names no message', async () => {
    // Without an id the next send cannot update this one, so claiming success would guarantee a
    // second notice later.
    mockSend.mockResolvedValue({});
    expect(await notice.showQueueNotice({ ...base, depth: 1, overflowed: false })).toBeNull();
  });

  it('returns null rather than throwing when the identity is unresolved', async () => {
    expect(await notice.showQueueNotice({ ...base, botArn: '', depth: 1, overflowed: false })).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('the router uses it, and stays silent when it worked', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('returns a SILENT Lex response after posting the notice itself', () => {
    // Otherwise the person gets the notice twice: once from the assistant and once from the flow
    // materializing the Lex reply.
    // A WINDOW, not a shape. An earlier version matched up to the next blank line and broke the
    // moment an unrelated line was inserted into the branch - a test that fails on formatting is one
    // people learn to edit rather than read.
    // THE LINE, not a window. A window was chosen originally so the test would not break on
    // formatting, and it broke on something worse: a second `showQueueNotice` appeared - the turn
    // that loses the notice slot updates the depth on the winner's notice - so the window anchored
    // on the wrong call, and widening it only moved which unrelated edit would break it next.
    //
    // These two lines ARE the invariant, and neither is a formatting detail. Whichever turn spoke
    // through the notice must not also speak through Lex, or the person is told twice.
    expect(SRC).toContain('if (noticeId) return formatLexSilentResponse(event);');

    // The loser too, which is the half the claim added: it must not fall through to the Lex reply,
    // which exists for a notice that could not be posted at all and would put the second notice in
    // the room by the other route.
    const loser = SRC.indexOf('if (!mayPost) {');
    expect(loser).toBeGreaterThan(-1);
    expect(SRC.slice(loser, loser + 1600)).toContain('return formatLexSilentResponse(event);');
  });
});

/**
 * THE ASSISTANT'S OWN WORDS, WHERE A MODEL CANNOT WRITE THEM.
 *
 * Almost everything a person reads is generated, so it already carries the profile's persona and the
 * conversation's language. These lines are the exception: the notice is posted on the fast path when
 * a message is queued, where a model call would cost a waiting person seconds they are already
 * unhappy about.
 *
 * Left as fixed English they broke two tenets at once - a deployment that configured a terse or warm
 * assistant got neither, and a conversation held in another language got English at its most
 * confusing moment. So they are CONFIGURATION: a model writes what it has time to write, and the
 * builder writes what has to be instant.
 */
describe('the notice speaks in the configured voice', () => {
  it('uses the assistant\'s own wording when a deployment set it', () => {
    expect(notice.noticeText({
      depth: 1, overflowed: false, copy: ownWords({ queuedOne: '稍等，我还在处理上一条消息。' }),
    })).toBe('稍等，我还在处理上一条消息。');
  });

  it('substitutes the count, so a configured line can still be specific', () => {
    expect(notice.noticeText({
      depth: 3, overflowed: false, copy: ownWords({ queuedMany: 'Holding {count} for you.' }),
    })).toBe('Holding 3 for you.');
  });

  it('falls back to the shipped English when nothing was configured', () => {
    // A deployment that has not set these is unchanged, which is what makes adding them safe.
    expect(notice.noticeText({ depth: 1, overflowed: false }))
      .toContain('Still working on your earlier message');
  });

  it('uses the configured line for an overflow too', () => {
    // The one a deployment MUST still get right: whatever they write has to say something was lost.
    // The platform cannot enforce the wording, so the field is documented rather than validated.
    expect(notice.noticeText({
      depth: 5, overflowed: true, copy: ownWords({ queuedOverflow: 'Dropped the oldest - resend it.' }),
    })).toBe('Dropped the oldest - resend it.');
  });

  it('ignores a configured field that is not the one in play', () => {
    // Each line is independent: configuring the overflow wording must not change the ordinary one.
    expect(notice.noticeText({
      depth: 1, overflowed: false, copy: ownWords({ queuedOverflow: 'unrelated' }),
    })).toContain('Still working on your earlier message');
  });
});

/**
 * ── AND THE LAST WRITE IS THE ONE THAT CANNOT BE LOST (live evidence, 2026-09-09) ────────────────
 *
 * Every other write to the notice is superseded by the next one, so losing one costs a moment of
 * stale text. The settle is the LAST write, and it is the event a client watches to stop showing a
 * message as waiting - so losing it is permanent, in the interface, on the person's own message.
 *
 * It was being lost reliably. `showStage('clearing')` updates this same notice a few hundred
 * milliseconds earlier, an update is itself carried through the channel flow, and while one is in
 * flight Amazon Chime SDK refuses the next: `No operations allowed for messages in processing`. On
 * the turn-queue sweep the record drained, the work was created, the answer was delivered, and the
 * notice went on reading "Still working on your earlier message" with the message marked waiting
 * underneath it. It was written up in TROUBLESHOOTING.md #22 as a client-side defect. It never was.
 */
describe('settling the notice', () => {
  it('asks again when the message is still in the flow', async () => {
    const err = Object.assign(new Error('No operations allowed for messages in processing.'), {
      name: 'BadRequestException',
    });
    mockSend.mockRejectedValueOnce(err).mockResolvedValue({});

    await notice.settleQueueNotice({ ...base, noticeId: 'm-notice', triaged: 1 });

    // Twice: the refusal, then the write that lands. A single attempt is how the notice stayed stale.
    expect(kinds()).toEqual(['Update', 'Update']);
    expect(lastInput().MessageId).toBe('m-notice');
    expect(JSON.parse(lastInput().Metadata).queueDepth).toBe(0);
  });

  it('gives up after three, saying so, rather than holding the turn open', async () => {
    const err = new Error('No operations allowed for messages in processing.');
    mockSend.mockRejectedValue(err);
    const warned: unknown[][] = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a); });
    try {
      await notice.settleQueueNotice({ ...base, noticeId: 'm-notice', triaged: 2 });
    } finally {
      spy.mockRestore();
    }
    expect(kinds()).toEqual(['Update', 'Update', 'Update']);
    expect(JSON.stringify(warned)).toContain('will read as stale');
  });

  it('does not retry an answer, only a refusal that clears on its own', async () => {
    // A redacted notice, a moderation refusal, a bearer without permission: repeating the call cannot
    // change any of them, and would only delay the line that says the notice is stale.
    mockSend.mockRejectedValue(new Error('Forbidden'));
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await notice.settleQueueNotice({ ...base, noticeId: 'm-notice', triaged: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(kinds()).toEqual(['Update']);
  });

  it('still says the queue is empty on the first try', async () => {
    mockSend.mockResolvedValue({});

    await notice.settleQueueNotice({ ...base, noticeId: 'm-notice', triaged: 3 });

    expect(kinds()).toEqual(['Update']);
    const meta = JSON.parse(lastInput().Metadata);
    expect(meta.queueDepth).toBe(0);
    expect(meta.queueStatus).toBe('settled');
    expect(meta.respPhase).toBe('notice');
  });
});
