import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('VITE_PERSON_API_URL', 'https://api.example.com/');
vi.stubEnv('VITE_PERSON_API_CAPABILITIES', 'meetings,core');
vi.mock('@ae/shared', async (orig) => ({ ...(await orig<typeof import('@ae/shared')>()), ensureFreshIdToken: vi.fn(async () => 'id-token') }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { isMeetingEnabled, meetingService, type MeetingApiError } from './meetingService';

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/conv-1';
const JOIN = { meeting: { MeetingId: 'm-1', MediaPlacement: {} }, attendee: { AttendeeId: 'a', ExternalUserId: 'p', JoinToken: 't' }, classification: 'premium', startedAt: 'x' };

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubEnv('VITE_PERSON_API_CAPABILITIES', 'meetings,core');
});

describe('the meeting routes on the person API', () => {
  it.each([
    ['startMeeting', '/meetings'],
    ['joinMeeting', '/meetings/join'],
    ['endMeeting', '/meetings/end'],
  ] as const)('%s posts the conversation, signed with the person\'s token, to %s', async (op, path) => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => JOIN });
    await meetingService[op](CHANNEL);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://api.example.com${path}`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer id-token');
    expect(JSON.parse(init.body)).toEqual({ channelArn: CHANNEL });
  });

  it('sends the reports a leave flushes as keepalive requests, so closing the meeting window does not cancel them', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await meetingService.reportEvents(CHANNEL, 'a', []);
    await meetingService.reportTranscript(CHANNEL, 'a', []);
    expect(mockFetch.mock.calls.map(([, init]) => init.keepalive)).toEqual([true, true]);
    mockFetch.mockClear();
    await meetingService.joinMeeting(CHANNEL);
    expect(mockFetch.mock.calls[0][1].keepalive).toBeUndefined();
  });

  it("starts from the parent conversation when an earlier meeting's conversation the window kept open has been moved on from (MEETING_MOVED)", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'moved', code: 'MEETING_MOVED' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => JOIN });
    await expect(meetingService.startMeeting(CHANNEL, 'room-1')).resolves.toEqual(JOIN);
    expect(mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([{ channelArn: CHANNEL }, { channelArn: 'room-1' }]);
  });

  it('starts nowhere else for any other refusal, or with no parent conversation to start from', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'no', code: 'NOT_HOST' }) });
    expect(((await meetingService.startMeeting(CHANNEL, 'room-1').catch((e) => e)) as MeetingApiError).code).toBe('NOT_HOST');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'moved', code: 'MEETING_MOVED' }) });
    expect(((await meetingService.startMeeting(CHANNEL).catch((e) => e)) as MeetingApiError).code).toBe('MEETING_MOVED');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the server\'s code, so the room words the refusal', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'No meeting', code: 'NO_ACTIVE_MEETING' }) });
    const err = await meetingService.joinMeeting(CHANNEL).catch((e: MeetingApiError) => e);
    expect((err as MeetingApiError).code).toBe('NO_ACTIVE_MEETING');
    expect((err as MeetingApiError).status).toBe(404);
  });
});

describe('a deployment without the meetings capability', () => {
  it('has no meetings, and calls nothing', async () => {
    vi.stubEnv('VITE_PERSON_API_CAPABILITIES', 'core');
    expect(isMeetingEnabled()).toBe(false);
    const err = await meetingService.startMeeting(CHANNEL).catch((e: MeetingApiError) => e);
    expect((err as MeetingApiError).code).toBe('NOT_CONFIGURED');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
