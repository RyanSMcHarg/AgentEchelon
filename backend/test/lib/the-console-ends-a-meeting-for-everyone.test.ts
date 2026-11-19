/**
 * THE CONSOLE SHOWS WHICH MEETINGS RUN NOW, AND ENDS ONE FOR EVERYONE (`admin-meetings.ts`, `meeting-liveness.ts`,
 * SPEC-ASSISTANT-MEETINGS FR48, FR49).
 *
 * Live comes only from a record the service confirms: a conversation's stale record for a meeting the service already
 * ended reads as ended. An end needs the `end-meetings` resource (the gateway), a classification the caller reaches,
 * a stated reason and an access-log record written first, and it goes through the meetings function's own end.
 */
const mockRequireAdmin = jest.fn();
const mockIamCall = jest.fn(() => false);
const mockScope = jest.fn((): string | null | undefined => null);
jest.mock('../../lambda/src/lib/auth', () => ({
  requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a),
  isAdminIamEnforcedCall: () => mockIamCall(),
}));
jest.mock('../../lambda/src/lib/caller-scope', () => ({
  ...jest.requireActual('../../lambda/src/lib/caller-scope'),
  scopeForRequest: () => mockScope(),
}));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, runEntryFor, __setForTests } from '../../lambda/src/admin-meetings';
import { ADMIN_CAPABILITIES } from '../../lib/config/admin-capabilities';
import type { MeetingEventRow } from '../../lambda/src/lib/meeting-figures';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const CHANNEL = `${APP}/channel/meet-1`;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const row = (type: string, min: number, over: Partial<MeetingEventRow> = {}): MeetingEventRow => ({
  meeting_id: 'm-1', channel_arn: CHANNEL, classification: 'premium', event_type: type, source: 'server', attendee_id: null,
  person_key: null, is_content: false, network_transport: null, event_at: new Date(NOW - 30 * 60_000 + min * 60_000).toISOString(), detail: null, ...over,
});
const RUNNING = [row('MeetingStarted', 0), row('AttendeeJoined', 1, { person_key: 'p1', attendee_id: 'a1' })];
const read = jest.fn();
const record = jest.fn();
const runs = jest.fn();
const end = jest.fn();
const log = jest.fn();

const call = (method: string, path: string, params: Record<string, string> | null = null, body?: unknown) => handler({
  httpMethod: method, path, resource: path.replace(/\/m-1(\/|$)/, '/{meetingId}$1'), headers: {}, queryStringParameters: {}, pathParameters: params,
  body: body === undefined ? null : JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);
const endIt = (body: unknown = { channelArn: CHANNEL, reason: 'Left running after the incident call' }) => call('POST', '/admin/meetings/m-1/end', { meetingId: 'm-1' }, body);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_INSTANCE_ARN = APP;
  mockRequireAdmin.mockResolvedValue({ claims: { personId: 'admin-1' } });
  mockIamCall.mockReturnValue(false);
  mockScope.mockReturnValue(null);
  read.mockResolvedValue({ rows: RUNNING, truncated: false, unread: [], store: 'athena' });
  record.mockResolvedValue({ meetingId: 'm-1', classification: 'premium' });
  runs.mockResolvedValue(true);
  end.mockResolvedValue({ ok: true });
  log.mockResolvedValue(undefined);
  __setForTests({ read, now: () => NOW, record, runs, end, log });
});

describe('whether a meeting runs now', () => {
  it('is live only while its conversation holds it and the service runs it', async () => {
    const body = JSON.parse((await call('GET', '/admin/meetings')).body);
    expect(body.meetings[0].live).toBe(true);
    expect(record).toHaveBeenCalledWith(CHANNEL);
    expect(runs).toHaveBeenCalledWith('m-1');
  });

  it('reads a stale record for a meeting the service already ended as not live', async () => {
    runs.mockResolvedValue(false);
    expect(JSON.parse((await call('GET', '/admin/meetings')).body).meetings[0].live).toBe(false);
  });

  it('reads a record that names another meeting as not live, without asking the service', async () => {
    record.mockResolvedValue({ meetingId: 'm-2', classification: 'premium' });
    expect(JSON.parse((await call('GET', '/admin/meetings')).body).meetings[0].live).toBe(false);
    expect(runs).not.toHaveBeenCalled();
  });

  it('asks nothing about a meeting whose events hold its end', async () => {
    read.mockResolvedValue({ rows: [...RUNNING, row('MeetingEnded', 20)], truncated: false, unread: [], store: 'athena' });
    expect(JSON.parse((await call('GET', '/admin/meetings')).body).meetings[0].live).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('says it does not know when the service cannot answer, rather than guessing', async () => {
    runs.mockRejectedValue(Object.assign(new Error('x'), { name: 'ServiceUnavailableException' }));
    expect(JSON.parse((await call('GET', '/admin/meetings')).body).meetings[0].live).toBeNull();
  });

  it('carries the same answer on one meeting', async () => {
    expect(JSON.parse((await call('GET', '/admin/meetings/m-1', { meetingId: 'm-1' })).body).meeting.live).toBe(true);
  });
});

describe('ending a meeting for everyone', () => {
  it('is its own capability on its own resource, held by admins', () => {
    expect(ADMIN_CAPABILITIES['end-meetings']).toMatchObject({
      resources: [{ api: 'admin-conversations', method: 'POST', path: 'admin/meetings/{meetingId}/end' }], roles: ['admins'],
    });
  });

  it('records who ended which meeting, where and why, and only then ends it through the meetings function', async () => {
    const order: string[] = [];
    log.mockImplementation(async () => { order.push('log'); });
    end.mockImplementation(async () => { order.push('end'); return { ok: true }; });
    const res = await endIt();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ended: true });
    expect(order).toEqual(['log', 'end']);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      _auditEvent: 'meeting_ended_for_all', personId: 'admin-1', channelArn: CHANNEL, meetingId: 'm-1', classification: 'premium',
      capabilities: ['end-meetings'], reason: 'Left running after the incident call', scope: 'full',
    }));
    // Through the run entry of the classification the meeting's record kept.
    expect(end).toHaveBeenCalledWith(CHANNEL, 'm-1', 'premium');
  });

  it('writes the CloudWatch audit line beside the access log record', async () => {
    const out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await endIt();
      const lines = out.mock.calls.map((c) => String(c[0])).filter((x) => x.includes('_auditEvent'));
      expect(lines.map((x) => JSON.parse(x))).toEqual([expect.objectContaining({ _auditEvent: 'meeting_ended_for_all', meetingId: 'm-1', channelArn: CHANNEL })]);
    } finally {
      out.mockRestore();
    }
  });

  it('refuses an end with no reason, and records and ends nothing', async () => {
    const res = await endIt({ channelArn: CHANNEL, reason: '   ' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('REASON_REQUIRED');
    expect(log).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('refuses a meeting outside the classifications the caller reaches', async () => {
    mockIamCall.mockReturnValue(true);
    mockScope.mockReturnValue('basic');
    const res = await endIt();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('OUTSIDE_SCOPE');
    expect(end).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a caller whose scope could not be read', async () => {
    mockIamCall.mockReturnValue(true);
    mockScope.mockReturnValue(undefined);
    expect((await endIt()).statusCode).toBe(403);
    expect(end).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not an admin before reading anything', async () => {
    mockRequireAdmin.mockResolvedValue({ statusCode: 403, body: '{}' });
    expect((await endIt()).statusCode).toBe(403);
    expect(record).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('takes the classification from the meeting\'s own record, never from the request', async () => {
    mockIamCall.mockReturnValue(true);
    mockScope.mockReturnValue('basic');
    record.mockResolvedValue({ meetingId: 'm-1', classification: 'premium' });
    expect((await endIt({ channelArn: CHANNEL, reason: 'x', classification: 'basic' })).statusCode).toBe(403);
  });

  it('ends nothing the conversation does not hold now, or the service already ended', async () => {
    record.mockResolvedValue({ meetingId: 'm-2', classification: 'premium' });
    expect((await endIt()).statusCode).toBe(409);
    record.mockResolvedValue({ meetingId: 'm-1', classification: 'premium' });
    runs.mockResolvedValue(false);
    expect((await endIt()).statusCode).toBe(409);
    expect(end).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a conversation of another app instance', async () => {
    const res = await endIt({ channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/other/channel/meet-1', reason: 'x' });
    expect(res.statusCode).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an end it cannot record, and leaves the meeting running', async () => {
    log.mockRejectedValue(Object.assign(new Error('down'), { name: 'AccessLogUnavailable' }));
    const res = await endIt();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('ACCESS_LOG_UNAVAILABLE');
    expect(end).not.toHaveBeenCalled();
  });

  it('says when the meetings function could not end it', async () => {
    end.mockResolvedValue({ ok: false, code: 'END_FAILED' });
    expect((await endIt()).statusCode).toBe(502);
  });
});

describe('the run entry an end goes through', () => {
  afterEach(() => { delete process.env.MEETING_RUN_FUNCTION_PATTERN; });

  it("is the run entry of the classification the meeting's record kept", () => {
    process.env.MEETING_RUN_FUNCTION_PATTERN = 'AgentEchelonMeetings-MeetingRun-{classification}';
    expect(runEntryFor('premium')).toBe('AgentEchelonMeetings-MeetingRun-premium');
  });

  it('is none for a value that is not a classification name, or where the pattern is not wired', () => {
    process.env.MEETING_RUN_FUNCTION_PATTERN = 'AgentEchelonMeetings-MeetingRun-{classification}';
    expect(runEntryFor('premium:other')).toBe('');
    expect(runEntryFor('')).toBe('');
    delete process.env.MEETING_RUN_FUNCTION_PATTERN;
    expect(runEntryFor('premium')).toBe('');
  });
});
