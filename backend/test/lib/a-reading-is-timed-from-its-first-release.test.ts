/**
 * A READING IS TIMED FROM THE FIRST RELEASE OF ITS WORK, WHATEVER PASS POSTS.
 *
 * The drain declares the instant it hands the queued work to a reading as the reading's trigger, and the
 * Latency tab times the reading from there (`queue_release`). A reading that takes another pass is
 * redispatched, and each dispatch declared its own instant, so a reading that posted on its second pass
 * was timed from that pass and the first pass's wait went unmeasured. The first instant now travels.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => mockSend(...a); },
  InvokeCommand: class { constructor(public input: any) {} },
  InvocationType: { Event: 'Event' },
}));
jest.mock('../../lambda/src/lib/router-arn.js', () => ({
  resolveRouterArn: async () => 'arn:aws:lambda:us-east-1:1:function:router',
}));

import { dispatchTriageTurn } from '../../lambda/src/lib/turn-triage';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const base = {
  channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
  botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1',
  classification: 'premium',
  correlationId: 'th1-abc',
  senderArn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1',
  messages: [{ messageId: 'q-1', content: 'and the headcount?', targeted: false }],
  visibility: 'conversation' as never,
};

/** The trigger instant the dispatched turn declared. */
function dispatchedTrigger(): number {
  const [cmd] = mockSend.mock.calls[mockSend.mock.calls.length - 1];
  return JSON.parse(Buffer.from((cmd as { input: { Payload: Buffer } }).input.Payload).toString()).aeTurn.triggerAtMs;
}

beforeEach(() => {
  mockSend.mockReset().mockResolvedValue({});
});

describe('the release instant a reading is timed from', () => {
  it('is the dispatch instant on the first pass', async () => {
    const before = Date.now();
    expect(await dispatchTriageTurn(base)).toBe(true);
    expect(dispatchedTrigger()).toBeGreaterThanOrEqual(before);
  });

  it('is carried, not re-stamped, on a later pass', async () => {
    const firstRelease = 1_792_000_000_000;
    expect(await dispatchTriageTurn({ ...base, pass: 2, queueReleasedAtMs: firstRelease })).toBe(true);
    expect(dispatchedTrigger()).toBe(firstRelease);
  });

  it('is handed on by both redispatches in the processor', () => {
    const core = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    const carried = core.match(/\.\.\.\(event\.triggerAtMs !== undefined \? \{ queueReleasedAtMs: event\.triggerAtMs \} : \{\}\),/g) ?? [];
    expect(carried).toHaveLength(2);
    // One per redispatch: the processor dispatches a further pass from exactly two places.
    expect(core.match(/await dispatchTriageTurn\(\{/g) ?? []).toHaveLength(2);
  });
});
