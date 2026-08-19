/**
 * `clearBattleWaitingMarker` — ADR-029.
 *
 * A resumed duel side does NOT answer onto the message holding its clarifying question. That message
 * stays in the transcript as a real part of the duel; the turn only ends the waiting affordance on it,
 * and posts its answer on a placeholder of its own.
 *
 * So this helper has exactly one job and one hazard. The job: drop `<!--battlewaiting-->` and leave
 * everything else, including the question, untouched. The hazard: it runs on the critical path of a
 * turn the user is waiting for, so it must never throw - a stale "Replying to:" chip is cosmetic, a
 * lost answer is not.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  class GetChannelMessageCommand {
    input: unknown;
    __type = 'Get';
    constructor(input: unknown) { this.input = input; }
  }
  class UpdateChannelMessageCommand {
    input: unknown;
    __type = 'Update';
    constructor(input: unknown) { this.input = input; }
  }
  return {
    ChimeSDKMessagingClient: jest.fn(() => ({ send: mockSend })),
    GetChannelMessageCommand,
    UpdateChannelMessageCommand,
    SendChannelMessageCommand: class { constructor(public input: unknown) {} },
    ListChannelMessagesCommand: class { constructor(public input: unknown) {} },
    ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
    ChannelMessageType: { STANDARD: 'STANDARD' },
  };
});

import { clearBattleWaitingMarker } from '../../lambda/src/lib/async-processor-core';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';
const MSG = 'question-msg-1';
const QUESTION = 'Which fiscal quarter should the report cover, Q3 or Q4?';
const MARKER = '<!--battlewaiting:battleId=a1b2c3d4e5f60718,botArn=' + BOT + '-->';

const updates = () =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === 'Update');

/** The content the update would write, decoded back to what a reader sees. */
const writtenContent = () => decodeURIComponent(updates()[0].input.Content as string);

beforeEach(() => {
  mockSend.mockReset();
});

describe('clearBattleWaitingMarker', () => {
  it('removes the marker and KEEPS the question text', async () => {
    mockSend.mockImplementation((cmd: { __type: string }) =>
      cmd.__type === 'Get'
        ? Promise.resolve({ ChannelMessage: { Content: encodeURIComponent(QUESTION + MARKER) } })
        : Promise.resolve({}),
    );

    const cleared = await clearBattleWaitingMarker(CHANNEL, MSG, BOT);

    expect(cleared).toBe(true);
    // The question is the whole point: it is the duel's record of what was asked, and a rebuttal can
    // judge whether asking it was worthwhile. Overwriting it would put us back where ADR-029 started.
    expect(writtenContent()).toBe(QUESTION);
    expect(writtenContent()).not.toContain('battlewaiting');
  });

  it('handles unencoded content (a message written without encodeURIComponent)', async () => {
    mockSend.mockImplementation((cmd: { __type: string }) =>
      cmd.__type === 'Get'
        ? Promise.resolve({ ChannelMessage: { Content: QUESTION + MARKER } })
        : Promise.resolve({}),
    );

    expect(await clearBattleWaitingMarker(CHANNEL, MSG, BOT)).toBe(true);
    expect(writtenContent()).toBe(QUESTION);
  });

  it('writes NOTHING when the marker is already gone', async () => {
    mockSend.mockImplementation((cmd: { __type: string }) =>
      cmd.__type === 'Get'
        ? Promise.resolve({ ChannelMessage: { Content: encodeURIComponent(QUESTION) } })
        : Promise.resolve({}),
    );

    // A redelivered resume must not rewrite a message it already cleared: an update re-enters the
    // channel flow, and a needless one is a needless flow invocation on every retry.
    expect(await clearBattleWaitingMarker(CHANNEL, MSG, BOT)).toBe(false);
    expect(updates()).toHaveLength(0);
  });

  it('is idempotent across two calls (the regex must not carry lastIndex)', async () => {
    let content = encodeURIComponent(QUESTION + MARKER);
    mockSend.mockImplementation((cmd: { __type: string; input: { Content?: string } }) => {
      if (cmd.__type === 'Get') return Promise.resolve({ ChannelMessage: { Content: content } });
      content = cmd.input.Content as string;
      return Promise.resolve({});
    });

    expect(await clearBattleWaitingMarker(CHANNEL, MSG, BOT)).toBe(true);
    // A `/g` regex object keeps `lastIndex` between `.test()` calls, so a shared one reports "no
    // marker" on every second call - the exact trap `lib/flow-bypass.ts` exports functions to avoid.
    expect(await clearBattleWaitingMarker(CHANNEL, MSG, BOT)).toBe(false);
    expect(decodeURIComponent(content)).toBe(QUESTION);
  });

  it('never throws when Chime fails: a stale chip beats a lost answer', async () => {
    mockSend.mockRejectedValue(new Error('ThrottlingException'));

    await expect(clearBattleWaitingMarker(CHANNEL, MSG, BOT)).resolves.toBe(false);
  });
});
