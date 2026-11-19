/**
 * A MEETING START WAITS PAST A COLD START. The workflow step that rings the room asks the Meetings stack's run entry for
 * the meeting and waits for the answer, on a client of its own bounded just past the run function's own timeout and inside
 * the router's 30 seconds, so the router is left time to say what happened. An entry that failed outright answers so.
 */
const lambdaSend = jest.fn();
const lambdaCtor = jest.fn((_config?: unknown) => ({ send: lambdaSend }));
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn((config: unknown) => lambdaCtor(config)) };
});

import { InvocationType } from '@aws-sdk/client-lambda';
import { MEETING_RUN_TIMEOUT_SECONDS, startConversationMeeting, summarizeConversationMeeting } from '../../lambda/src/lib/meeting-run';

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/ai/channel/c1';

describe('a meeting start waits past a cold start', () => {
  beforeEach(() => lambdaSend.mockReset());

  it('asks the run entry synchronously and answers what it says', async () => {
    lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true, created: true })) });
    await expect(startConversationMeeting('ae-meeting-run', CHANNEL, 'bot-1')).resolves.toEqual({ ok: true, created: true });
    const input = lambdaSend.mock.calls[0][0].input;
    expect(input.FunctionName).toBe('ae-meeting-run');
    expect(input.InvocationType).toBe(InvocationType.RequestResponse);
    expect(JSON.parse(Buffer.from(input.Payload).toString('utf8'))).toEqual({ channelArn: CHANNEL, startedBy: 'bot-1' });
  });

  it("bounds the call past the run function timeout, and inside the router's own", () => {
    const config = lambdaCtor.mock.calls[0][0] as { requestHandler: { requestTimeout: number; throwOnRequestTimeout: boolean } };
    expect(config.requestHandler.requestTimeout).toBeGreaterThan(MEETING_RUN_TIMEOUT_SECONDS * 1000);
    expect(config.requestHandler.requestTimeout).toBeLessThanOrEqual(22_000);
    expect(config.requestHandler.throwOnRequestTimeout).toBe(true);
  });

  it('carries the ring its step asked for', async () => {
    lambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: true, created: true })) });
    await startConversationMeeting('ae-meeting-run', CHANNEL, 'bot-1', 30);
    expect(JSON.parse(Buffer.from(lambdaSend.mock.calls[0][0].input.Payload).toString('utf8'))).toEqual({ channelArn: CHANNEL, startedBy: 'bot-1', ringSeconds: 30 });
  });

  it('answers an entry that failed outright as a failure of its own, never by parsing its error as an answer', async () => {
    const timedOut = { FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'Task timed out after 18.00 seconds' })) };
    lambdaSend.mockResolvedValue(timedOut);
    await expect(startConversationMeeting('ae-meeting-run', CHANNEL, 'bot-1')).resolves.toEqual({ ok: false, code: 'ENTRY_FAILED' });
    await expect(summarizeConversationMeeting('ae-meeting-summary', CHANNEL, 'm-1')).resolves.toEqual({ ok: false, code: 'ENTRY_FAILED' });
  });

  it('answers an empty result when the run entry returns no payload', async () => {
    lambdaSend.mockResolvedValue({});
    await expect(startConversationMeeting('ae-meeting-run', CHANNEL, 'bot-1')).resolves.toEqual({});
  });

  it('throws when the run entry cannot be reached, so the step fails', async () => {
    lambdaSend.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(startConversationMeeting('ae-meeting-run', CHANNEL, 'bot-1')).rejects.toThrow('timed out');
  });
});
