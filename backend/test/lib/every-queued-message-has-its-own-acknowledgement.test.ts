/**
 * THE NOTICE UPDATE IS THE QUEUED MESSAGE'S FIRST FEEDBACK, AND EVERY QUEUED MESSAGE GETS ITS OWN
 * (ADR-033 AR1, and the half of ADR-038 that was already built).
 *
 * A message that arrives after a turn started is not claimed by that turn. It is claimed by the
 * deferral notice that acknowledges it, and that acknowledgement is what a queued message has instead
 * of a placeholder: it is fast, it is visible, and it is what the person gets in place of an answer.
 * `v_queue_acknowledgement` reports `ack_ms` from the message's own send to it.
 *
 * WHICH IS WHY THE NOTICE IS UPDATED RATHER THAN POSTED ONCE. There is one notice per conversation -
 * three queued messages must not produce three near-identical "still working on it" messages - so the
 * second and third sends UPDATE the message the first one posted. Every one of those writes has to
 * name the message it is acknowledging, or all of them collapse onto one instant and only the first
 * queued message in a burst could ever have a time to first feedback.
 *
 * `a-deferral-is-a-measured-response.test.ts` pins that the id is declared and that it survives every
 * hop to the ledger. This pins the behavior underneath it: the SECOND send names the SECOND message.
 */

const mockSend = jest.fn();
const mockRemember = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockSend(...a); },
  GetChannelMessageCommand: class { __t = 'Get'; constructor(public input: any) {} },
  SendChannelMessageCommand: class { __t = 'Send'; constructor(public input: any) {} },
  UpdateChannelMessageCommand: class { __t = 'Update'; constructor(public input: any) {} },
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  rememberNotice: (...a: unknown[]) => mockRemember(...a),
  advanceQueueStatus: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  readPlaceholderMapping: jest.fn().mockResolvedValue(null),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const notice = require('../../lambda/src/lib/turn-queue-notice');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant-premium';
const RESPONDER = 'assistant-premium';

const metadataOf = (call: number): Record<string, unknown> =>
  JSON.parse(mockSend.mock.calls[call][0].input.Metadata);

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({ MessageId: 'notice-1' });
  mockRemember.mockReset().mockResolvedValue(undefined);
});

describe('each queued send names the message it is acknowledging', () => {
  it('the first one, on the notice it posts', async () => {
    await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: RESPONDER,
      depth: 1, overflowed: false, acknowledges: 'm-second',
    });

    expect(mockSend.mock.calls[0][0].__t).toBe('Send');
    expect(metadataOf(0).acknowledges).toBe('m-second');
  });

  it('the next one, on the UPDATE of that same notice', async () => {
    // THE CASE THE MEASUREMENT DEPENDS ON. One notice, so this is an update; a second queued message,
    // so it is a different acknowledgement with its own instant.
    await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: RESPONDER,
      depth: 2, overflowed: false, existingNoticeId: 'notice-1', acknowledges: 'm-third',
    });

    // The first call reads the notice, to be sure it does not now hold an answer.
    expect(mockSend.mock.calls[0][0].__t).toBe('Get');
    expect(mockSend.mock.calls[1][0].__t).toBe('Update');
    expect(mockSend.mock.calls[1][0].input.MessageId).toBe('notice-1');
    expect(metadataOf(1).acknowledges).toBe('m-third');
  });

  it('and into the running answer\'s placeholder, when the notice lives there', async () => {
    await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: RESPONDER,
      depth: 1, overflowed: false, placeholderId: 'ph-1', acknowledges: 'm-second',
    });

    expect(mockSend.mock.calls[0][0].input.MessageId).toBe('ph-1');
    expect(metadataOf(0).acknowledges).toBe('m-second');
  });

  it('claims nothing when the caller named no message', async () => {
    // An absent id is an absent claim. A key written empty would join the ledger to nothing and
    // report as an acknowledgement of a message that does not exist.
    await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: RESPONDER, depth: 1, overflowed: false,
    });

    expect(metadataOf(0)).not.toHaveProperty('acknowledges');
  });
});
