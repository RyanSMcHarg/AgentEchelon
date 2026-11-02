/**
 * THE LOCK IS RELEASED BY AN EVENT, IN BOTH DIRECTIONS (ADR-033).
 *
 * The ordinary ending is `releaseLock` in the processor's `finally`. The one ending that code can
 * never reach is the platform killing the invocation, and this handler is what hears about it.
 *
 * These assertions are about the SEAM: that the failure record is read for the three things that
 * identify a lock, that a release is attempted for exactly that lock, and that a record which names
 * no lock is dropped rather than raised - throwing here only re-queues the same record.
 */

const mockReleaseLock = jest.fn();
const mockInvoke = jest.fn();
const mockChimeSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => mockInvoke(...a); },
  InvokeCommand: class { constructor(public input: any) {} },
  InvocationType: { Event: 'Event' },
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockChimeSend(...a); },
  SendChannelMessageCommand: class { constructor(public input: any) {} },
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));

jest.mock('../../lambda/src/lib/turn-lock', () => ({
  releaseLock: (...a: unknown[]) => mockReleaseLock(...a),
}));
jest.mock('../../lambda/src/lib/task-tracking', () => ({
  principalIdFromArn: (arn: string) => String(arn).split('/').pop() || '',
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../lambda/src/turn-lock-release-on-failure');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/assistant-premium';

beforeEach(() => {
  mockReleaseLock.mockReset();
  mockReleaseLock.mockResolvedValue(true);
});

describe('a turn killed by the platform releases the conversation', () => {
  it('releases exactly the lock the dead invocation held', async () => {
    await handler({
      requestContext: { condition: 'RetriesExhausted', approximateInvokeCount: 3 },
      requestPayload: { channelArn: CHANNEL, botArn: BOT, correlationId: 'corr-dead' },
    });

    // The responder, not the bot ARN: the lock is keyed on the principal id.
    expect(mockReleaseLock).toHaveBeenCalledWith({
      channelArn: CHANNEL,
      responderId: 'assistant-premium',
      correlationId: 'corr-dead',
    });
  });

  it('does not raise when the record names no lock', async () => {
    // A malformed record is not a conversation waiting on an answer, and throwing re-queues it.
    await expect(handler({ requestPayload: {} })).resolves.toBeUndefined();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('does not raise when the release itself fails', async () => {
    // The conditional write fails whenever something already moved the lock on, which is ordinary.
    mockReleaseLock.mockRejectedValue(new Error('DynamoDB is having a day'));

    await expect(handler({
      requestPayload: { channelArn: CHANNEL, botArn: BOT, correlationId: 'corr-dead' },
    })).resolves.toBeUndefined();
  });
});

/**
 * A TURN THAT DIED IS RETRIED. SILENCE IS NOT AN ACCEPTABLE OUTCOME.
 *
 * Releasing the lock and stopping there is a tidier silence, not a recovery: the person sent a
 * message, nothing came back, and they would have to send ANOTHER one before anything happened.
 * Freeing the conversation is what the next person needs; answering is what this one needs.
 */
describe('recovering a turn that died', () => {
  const record = (turnAttempt?: number) => ({
    requestContext: {
      condition: 'RetriesExhausted',
      approximateInvokeCount: 3,
      functionArn: 'arn:aws:lambda:us-east-1:1:function:AgentEchelonAssistants-premium-Processor',
    },
    requestPayload: {
      channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
      botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas',
      correlationId: 'turn-1',
      userMessage: 'the original ask',
      ...(turnAttempt ? { turnAttempt } : {}),
    },
  });

  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue({});
    mockChimeSend.mockReset().mockResolvedValue({});
    mockReleaseLock.mockReset().mockResolvedValue(true);
  });

  it('re-dispatches the same turn, to the same function, with the same payload', async () => {
    await handler(record());

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const sent = mockInvoke.mock.calls[0][0].input;
    expect(sent.FunctionName).toContain('Assistants-premium');
    const payload = JSON.parse(Buffer.from(sent.Payload).toString());
    expect(payload.userMessage).toBe('the original ask');
    expect(payload.correlationId).toBe('turn-1');
    expect(payload.turnAttempt).toBe(2);
  });

  it('KEEPS the lock while retrying', async () => {
    await handler(record());

    // The retry runs as the same correlation, so it still holds the conversation. Releasing first
    // would open a window where an arriving message claims the turn and answers alongside it.
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('asks the ASSISTANT to say so once the attempts are spent', async () => {
    await handler(record(2));

    // Messages in a conversation come from assistants. A shared recovery function speaking into any
    // room would need channel-send across every classification, and would carry none of that
    // deployment's configured voice.
    expect(mockChimeSend).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(Buffer.from(mockInvoke.mock.calls[0][0].input.Payload).toString());
    expect(payload.announceFailure).toBe(true);
    // DECLARED. An undeclared trigger reads as `user`, which would count a machine-driven apology in
    // the human-waiting population under a person's own message.
    expect(payload.trigger).toBe('recovery');
  });

  it('leaves the release to the turn it just asked for', async () => {
    await handler(record(2));

    // That turn releases the lock in its own `finally`, the same as any other ending. Releasing here
    // as well would free the conversation before the apology had been spoken into it.
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('releases as a last resort when it cannot even ask', async () => {
    mockInvoke.mockRejectedValue(new Error('throttled'));

    await handler(record(2));

    // Silent by necessity rather than by choice: nothing here can speak. A conversation held forever
    // is worse than one that went quiet, and the person can still send again.
    expect(mockReleaseLock).toHaveBeenCalled();
  });
});

/**
 * THE APOLOGY CARRIES THE SAME FAILURE DESTINATION AS THE TURN IT APOLOGISES FOR.
 *
 * So when the announcement itself dies, its record arrives back here - and `turnAttempt` was never
 * bumped for it, so the retry branch is still spent and the give-up branch fires again. A payload the
 * processor reliably dies on looped: record, give up, announce, die, record, forever. Every pass
 * returns before the release, so the conversation stayed locked for the whole loop - the exact
 * stranding this function exists to end, produced by it.
 */
describe('the recovery loop terminates', () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue({});
    mockChimeSend.mockReset().mockResolvedValue({});
    mockReleaseLock.mockReset().mockResolvedValue(true);
  });

  const announcementRecord = () => ({
    requestContext: {
      condition: 'RetriesExhausted',
      approximateInvokeCount: 3,
      functionArn: 'arn:aws:lambda:us-east-1:1:function:AgentEchelonAssistants-premium-Processor',
    },
    requestPayload: {
      channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
      botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas',
      correlationId: 'turn-1',
      userMessage: 'the original ask',
      turnAttempt: 2,
      // The record IS the announcement failing.
      announceFailure: true,
      trigger: 'recovery',
    },
  });

  it('does NOT ask for another announcement when the announcement is what failed', async () => {
    await handler(announcementRecord());

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('releases the lock instead, because there is nothing cheaper left to try', async () => {
    await handler(announcementRecord());

    // The cheapest path the assistant has is also failing. Holding the conversation for an apology
    // that cannot be delivered costs the person more than the missing apology does.
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not RETRY an announcement whose attempts were never spent', async () => {
    // An apology is also dispatched when the retry itself could not be sent, and then it carries an
    // unspent `turnAttempt`. Its failure must end the loop exactly as a spent one does, not re-send it.
    const early = announcementRecord();
    early.requestPayload.turnAttempt = 1;

    await handler(early);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });
});
