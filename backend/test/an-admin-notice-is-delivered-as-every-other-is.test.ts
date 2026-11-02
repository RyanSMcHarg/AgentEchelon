/**
 * AN ADMIN NOTICE IS DELIVERED THE WAY EVERY OTHER IS.
 *
 * Raised as an `ae.alert` event (`lib/admin-notice.ts`), and posted into the admin channel by the one
 * poster (`lib/admin-channel-post.ts`): content URI-encoded and within the Amazon Chime SDK caps, the
 * email directive and its subject under the keys the notification bridge reads, and the notice kept out of
 * usage metrics. Then the generic alarm notifier built on it: one notice per state change, and nothing for
 * INSUFFICIENT_DATA.
 */
const mockSend = jest.fn();
const mockEventsSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockSend })),
  SendChannelMessageCommand: jest.fn((input: unknown) => ({ input })),
}));
jest.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: jest.fn(() => ({ send: mockEventsSend })),
  PutEventsCommand: jest.fn((input: unknown) => ({ input })),
}));

import { CHIME_METADATA_SAFE, deliverAdminNotice } from '../lambda/src/lib/admin-channel-post';
import { postAdminNotice } from '../lambda/src/lib/admin-notice';
import { handler, renderAlarm } from '../lambda/src/alarm-to-admin-channel';
import { parseNotifyDirective } from '../lambda/src/lib/channel-notify';

const CHANNEL = { channelArn: 'arn:chan', bearerArn: 'arn:bot' };
const sent = () => mockSend.mock.calls.map((c) => c[0].input);
const raised = () => mockEventsSend.mock.calls.flatMap((c) => c[0].input.Entries).map((e: { Detail: string }) => JSON.parse(e.Detail));

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({});
  mockEventsSend.mockResolvedValue({ FailedEntryCount: 0 });
  process.env.ALERT_INSTANCE = 'agent-echelon';
});

describe('posting an admin notice into the channel', () => {
  it('encodes the content, emails it under its subject, and keeps it out of usage metrics', async () => {
    expect(await deliverAdminNotice({ content: 'Run FAILED: 100% of nothing\nline two', subject: 'Run FAILED', messageType: 'clean_copy_run', extra: { outcome: 'failed' } }, CHANNEL)).toBe(true);
    const [m] = sent();
    expect(m.Content).toBe(encodeURIComponent('Run FAILED: 100% of nothing\nline two'));
    expect(m.ChimeBearer).toBe('arn:bot');
    const meta = JSON.parse(m.Metadata);
    expect(meta).toMatchObject({ messageType: 'clean_copy_run', outcome: 'failed', analytics: { classification: 'admin' } });
    expect(parseNotifyDirective(m.Metadata)).toMatchObject({ notify: { email: true }, subject: 'Run FAILED' });
  });

  it('trims an overlong subject so the metadata fits the cap', async () => {
    await deliverAdminNotice({ content: 'x', subject: 'y '.repeat(800), messageType: 't' }, CHANNEL);
    expect(encodeURIComponent(sent()[0].Metadata).length).toBeLessThanOrEqual(CHIME_METADATA_SAFE);
  });

  it('posts a long notice as one response in ordered parts: the first emailed, every part out of usage metrics', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'm-1' });
    const content = Array.from({ length: 80 }, (_, i) => `- Finding ${i + 1}: the run stopped before the copy step, see the runbook.`).join('\n');
    expect(await deliverAdminNotice({ content, subject: 'Run FAILED', messageType: 'clean_copy_run' }, CHANNEL)).toBe(true);
    const parts = sent();
    expect(parts.length).toBeGreaterThan(1);
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    expect(parts.flatMap((p) => words(decodeURIComponent(p.Content)))).toEqual(words(content));
    for (const p of parts) expect(p.Content.length).toBeLessThanOrEqual(3600);
    expect(parseNotifyDirective(parts[0].Metadata)).toMatchObject({ subject: 'Run FAILED' });
    parts.slice(1).forEach((p, i) => {
      const meta = JSON.parse(p.Metadata);
      expect(meta).toMatchObject({ parentMessageId: 'm-1', continuation: true, part: i + 2, totalParts: parts.length, analytics: { classification: 'admin' } });
      expect(parseNotifyDirective(p.Metadata)).toBeNull();
      expect(p.Metadata.length).toBeLessThanOrEqual(1024);
    });
  });

  it('posts nothing, and says so, when the stack has no channel or agent configured', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deliverAdminNotice({ content: 'x', subject: 'y', messageType: 't' }, { channelArn: '', bearerArn: '' })).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('never throws when the send fails', async () => {
    mockSend.mockRejectedValue(new Error('ForbiddenException'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deliverAdminNotice({ content: 'x', subject: 'y', messageType: 't' }, CHANNEL)).toBe(false);
    err.mockRestore();
  });
});

describe('raising an admin notice', () => {
  it('is an ae.alert event on the bus, and no message', async () => {
    expect(await postAdminNotice({ content: 'x', subject: 'y', messageType: 'clean_copy_run' })).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    const entries = mockEventsSend.mock.calls[0][0].input.Entries;
    expect(entries).toEqual([expect.objectContaining({ Source: 'ae.alert', DetailType: 'clean_copy_run' })]);
    expect(raised()[0]).toEqual({ instance: 'agent-echelon', notice: { content: 'x', subject: 'y', messageType: 'clean_copy_run' } });
  });

  it('reports a refused entry as not raised', async () => {
    mockEventsSend.mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'AccessDenied' }] });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await postAdminNotice({ content: 'x', subject: 'y', messageType: 't' })).toBe(false);
    err.mockRestore();
  });
});

describe('a CloudWatch alarm reaching the admins', () => {
  const sns = (msg: object) => ({ Records: [{ Sns: { Message: JSON.stringify(msg) } }] }) as never;

  it('says what broke and what to do, from the alarm\'s own description', () => {
    const { content, subject } = renderAlarm({ AlarmName: 'CleanCopyNeverStarted', AlarmDescription: 'The batch did not start.', NewStateValue: 'ALARM', NewStateReason: 'Threshold Crossed' });
    expect(subject).toBe('Alarm: CleanCopyNeverStarted');
    expect(content).toContain('**What:** The batch did not start.');
    expect(renderAlarm({ AlarmName: 'A', NewStateValue: 'OK' }).subject).toBe('Recovered: A');
  });

  it('raises one notice per breaking or recovering change, and none for missing data', async () => {
    await handler(sns({ AlarmName: 'A', NewStateValue: 'ALARM' }));
    await handler(sns({ AlarmName: 'A', NewStateValue: 'INSUFFICIENT_DATA' }));
    await handler(sns({ AlarmName: 'A', NewStateValue: 'OK' }));
    expect(raised().map((d) => d.notice.extra.alarmState)).toEqual(['ALARM', 'OK']);
  });
});
