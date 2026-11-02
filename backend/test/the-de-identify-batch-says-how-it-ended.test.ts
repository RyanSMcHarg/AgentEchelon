/**
 * THE DE-IDENTIFY BATCH SAYS HOW IT ENDED (DESIGN-ADMIN-CONSOLE 5.3).
 *
 * Every run records itself and posts one announcement: complete, incomplete when its time ran out with
 * work left, or failed with the step that failed and how much was written first. A conversation is
 * written whole or not at all, so what a failed run did not finish stays pending for the next.
 */
const mockPending = jest.fn();
const mockSource = jest.fn();
const mockWrite = jest.fn();
const mockRecord = jest.fn();
jest.mock('../lambda/src/lib/data-plane-client.js', () => ({
  cleanCopyPending: (...a: unknown[]) => mockPending(...a),
  cleanCopySource: (...a: unknown[]) => mockSource(...a),
  cleanCopyWrite: (...a: unknown[]) => mockWrite(...a),
  cleanCopyRecordRun: (...a: unknown[]) => mockRecord(...a),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })),
  SendChannelMessageCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn() })),
  ApplyGuardrailCommand: jest.fn(),
}));

import { runBatch, describe as describeRun } from '../lambda/src/clean-copy-batch';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const conv = (id: string) => ({ channelArn: `${APP}/channel/${id}`, sourceRows: 3, sourceLatest: '2026-10-01T10:00:00Z' });
const detector = { name: 'test-detector', anonymize: async (t: string[]) => t };

let notices: string[];
const deps = (remaining: () => number = () => 600_000) => ({
  detector, remainingMs: remaining, notify: async (t: string) => { notices.push(t); },
});

beforeEach(() => {
  jest.clearAllMocks();
  notices = [];
  mockSource.mockResolvedValue({ rows: [], classification: 'standard' });
  mockWrite.mockResolvedValue({ written: 0 });
  mockRecord.mockResolvedValue({ recorded: true });
});

describe('a run of the de-identify batch', () => {
  it('derives every pending conversation, then says it is complete', async () => {
    mockPending
      .mockResolvedValueOnce({ pending: [conv('a'), conv('b')], total: 2 })
      .mockResolvedValueOnce({ pending: [], total: 0 });
    const r = await runBatch(deps());
    expect(r).toMatchObject({ outcome: 'complete', conversations: 2, remaining: 0, failure: null });
    expect(mockWrite).toHaveBeenCalledTimes(2);
    // Recorded with what derived it, so a change of detector or rules makes it pending again.
    expect(mockWrite.mock.calls[0][0]).toMatchObject({ channelArn: `${APP}/channel/a`, detector: 'test-detector;rules=4', sourceRows: 3 });
    expect(mockPending).toHaveBeenCalledWith(25, 'test-detector;rules=4');
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'complete', conversations: 2 }));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/run complete\. 2 conversation/);
  });

  it('stops taking work when its time is nearly spent, and says what it left', async () => {
    let clock = 600_000;
    mockPending.mockResolvedValueOnce({ pending: [conv('a'), conv('b'), conv('c')], total: 3 })
      .mockResolvedValue({ pending: [conv('c')], total: 1 });
    mockWrite.mockImplementation(async () => { clock -= 300_000; return { written: 0 }; });
    const r = await runBatch(deps(() => clock));
    expect(r.outcome).toBe('incomplete');
    expect(r.conversations).toBe(2);
    expect(r.remaining).toBe(1);
    expect(notices[0]).toMatch(/INCOMPLETE.*1 still pending.*archive/);
  });

  // In each, the first conversation succeeds and the failure lands on the second.
  it('names the archive read when it fails, and how much was written first', async () => {
    mockPending.mockResolvedValueOnce({ pending: [conv('a'), conv('b')], total: 2 });
    mockSource.mockResolvedValueOnce({ rows: [], classification: null }).mockRejectedValueOnce(new Error('timeout'));
    const r = await runBatch(deps());
    expect(r).toMatchObject({ outcome: 'failed', conversations: 1 });
    expect(r.failure).toBe('archive read failed on b: timeout');
    expect(notices[0]).toMatch(/FAILED.*1 conversation\(s\) were written first.*next run resumes/);
  });

  it('names the copy write when it fails, leaving that conversation pending', async () => {
    mockPending.mockResolvedValueOnce({ pending: [conv('a'), conv('b')], total: 2 });
    mockWrite.mockResolvedValueOnce({ written: 0 }).mockRejectedValueOnce(new Error('deadlock'));
    const r = await runBatch(deps());
    expect(r).toMatchObject({ outcome: 'failed', conversations: 1 });
    expect(r.failure).toBe('copy write failed on b: deadlock');
  });

  it('names the detector when it fails', async () => {
    mockPending.mockResolvedValueOnce({ pending: [conv('a')], total: 1 });
    mockSource.mockResolvedValue({ rows: [{ kind: 'message', messageId: 'm', at: '2026-10-01T10:00:00Z', actorArn: `${APP}/user/x`, actorName: null, agentType: null, content: 'hi', updatedContent: null, removed: null, action: null, subjectArn: null, subjectName: null }], classification: null });
    const r = await runBatch({ ...deps(), detector: { name: 'd', anonymize: async () => { throw new Error('ThrottlingException'); } } });
    expect(r.failure).toMatch(/detector failed on a: ThrottlingException/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('never throws, even when it cannot record or announce the run', async () => {
    mockPending.mockRejectedValue(new Error('data plane down'));
    mockRecord.mockRejectedValue(new Error('still down'));
    const r = await runBatch({ ...deps(), notify: async () => { throw new Error('channel gone'); } });
    expect(r.outcome).toBe('failed');
    expect(r.failure).toMatch(/data plane down/);
  });
});

describe('the announcement', () => {
  it('points an operator at the archive for anything urgent, whenever the copy is behind', () => {
    const base = { startedAt: '', conversations: 0, remaining: 4, failure: 'x', durationMs: 1000 };
    expect(describeRun({ ...base, outcome: 'incomplete' })).toMatch(/archive/);
    expect(describeRun({ ...base, outcome: 'failed' })).toMatch(/archive/);
  });
});

describe('a sample run', () => {
  it('stops after the conversations it was asked for, and reports the rest pending', async () => {
    mockPending.mockResolvedValueOnce({ pending: [conv('a'), conv('b'), conv('c')], total: 300 })
      .mockResolvedValue({ pending: [conv('c')], total: 298 });
    const r = await runBatch({ ...deps(), maxConversations: 2 });
    expect(r).toMatchObject({ outcome: 'incomplete', conversations: 2, remaining: 298 });
    expect(mockWrite).toHaveBeenCalledTimes(2);
  });
});
