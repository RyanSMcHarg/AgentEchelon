/**
 * THE DATA PLANE IS RESOLVED FROM AN ANSWER (`ensureDataPlaneArn`, `event-archive.ts`), and every meeting writer gets it
 * resolved without asking (`fileMeetingEvents`, `meeting-event-archive.ts`).
 *
 * A parameter that does not exist is Athena mode. A read that failed is not an answer: it throws and is read again next
 * time, so one throttled cold start never leaves a container writing to, or reading from, the wrong store.
 */
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: (...a: unknown[]) => mockSsmSend(...a) })),
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));
const mockIngest = jest.fn();
jest.mock('../../lambda/src/lib/data-plane-client', () => ({
  hasDataPlane: () => Boolean(process.env.AURORA_DATA_PLANE_ARN),
  ingestMeetingEvents: (...a: unknown[]) => mockIngest(...a),
  ingestClientEvents: jest.fn(),
  erasePersonProjection: jest.fn(),
}));

import { FirehoseClient } from '@aws-sdk/client-firehose';
import { ensureDataPlaneArn, __resetEventArchiveForTests } from '../../lambda/src/lib/event-archive';
import { fileMeetingEvents } from '../../lambda/src/lib/meeting-event-archive';

const named = (name: string): Error => Object.assign(new Error(name), { name });
const RECORD = {
  meeting_id: 'm-1', channel_arn: 'arn:c', classification: 'standard', event_type: 'AttendeeLeft', source: 'server' as const,
  attendee_id: 'a-1', person_key: 'p-1', is_content: false, network_transport: null, event_at: '2026-11-11T00:00:00.000Z', detail: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetEventArchiveForTests();
  delete process.env.AURORA_DATA_PLANE_ARN;
  process.env.AURORA_DATA_PLANE_ARN_PARAM = '/ae/aurora/data-plane-arn';
  mockIngest.mockResolvedValue({ inserted: 1, duplicates: 0 });
});

describe('the data plane is resolved from an answer', () => {
  it('a parameter that does not exist is Athena mode, and is remembered', async () => {
    mockSsmSend.mockRejectedValue(named('ParameterNotFound'));
    await ensureDataPlaneArn();
    await ensureDataPlaneArn();
    expect(process.env.AURORA_DATA_PLANE_ARN).toBeUndefined();
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('a read that failed throws and is read again, so the next call finds the data plane', async () => {
    mockSsmSend.mockRejectedValueOnce(named('ThrottlingException')).mockResolvedValue({ Parameter: { Value: 'arn:aws:lambda:us-east-1:1:function:dp' } });
    await expect(ensureDataPlaneArn()).rejects.toThrow('ThrottlingException');
    await ensureDataPlaneArn();
    expect(process.env.AURORA_DATA_PLANE_ARN).toBe('arn:aws:lambda:us-east-1:1:function:dp');
  });
});

describe('a meeting writer never has to resolve it first', () => {
  it('files into the projection where the deployment keeps one, with no prior call', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: 'arn:aws:lambda:us-east-1:1:function:dp' } });
    process.env.MEETING_EVENTS_DELIVERY_STREAM = 'meeting-events';
    const put = jest.spyOn(FirehoseClient.prototype, 'send').mockImplementation(async () => ({ FailedPutCount: 0 }) as never);
    try {
      const out = await fileMeetingEvents([RECORD]);
      expect(out.projected).toBe(1);
      expect(mockIngest).toHaveBeenCalledWith([RECORD]);
    } finally {
      put.mockRestore();
    }
  });

  it('a caller that cannot retry has its events filed once the archive holds them, a failed projection logged', async () => {
    const archive = jest.fn().mockResolvedValue({ delivered: 1, dropped: 0 });
    const projection = jest.fn().mockRejectedValue(named('ServiceException'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(fileMeetingEvents([RECORD], { archive, projection }, { projection: 'best-effort' }))
        .resolves.toEqual({ archived: 1, projected: null, duplicates: 0, projectionFailed: true });
      expect(err).toHaveBeenCalled();
      // A caller that retries still learns the projection failed.
      await expect(fileMeetingEvents([RECORD], { archive, projection })).rejects.toThrow('ServiceException');
    } finally {
      err.mockRestore();
    }
  });

  it('a failed projection is handed on to be retried, never left out of the projection silently', async () => {
    const archive = jest.fn().mockResolvedValue({ delivered: 1, dropped: 0 });
    const projection = jest.fn().mockRejectedValue(named('ServiceException'));
    const handOn = jest.fn().mockResolvedValue(true);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(fileMeetingEvents([RECORD], { archive, projection, handOn }, { projection: 'best-effort' }))
        .resolves.toEqual({ archived: 1, projected: null, duplicates: 0, projectionHandedOn: true });
      expect(handOn).toHaveBeenCalledWith([RECORD]);
    } finally {
      warn.mockRestore();
    }
  });

  it('throws before filing anything when the resolution failed, so the caller retries', async () => {
    mockSsmSend.mockRejectedValue(named('ThrottlingException'));
    await expect(fileMeetingEvents([RECORD])).rejects.toThrow('ThrottlingException');
    expect(mockIngest).not.toHaveBeenCalled();
  });
});
