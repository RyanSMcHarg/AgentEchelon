/**
 * THE CONSOLE READS MEETING FIGURES (`admin-meetings.ts`, `meeting-event-reader.ts`): admins only, a bounded window,
 * either store, and an answer that says what it is missing rather than showing smaller numbers as if complete.
 */
const mockRequireAdmin = jest.fn();
const mockIamCall = jest.fn(() => false);
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a), isAdminIamEnforcedCall: () => mockIamCall() }));
// A signed role whose scope resolves to none (`scopeForRequest` undefined), which sees nothing.
const mockScope = jest.fn((): string | null | undefined => undefined);
jest.mock('../../lambda/src/lib/caller-scope', () => ({ ...jest.requireActual('../../lambda/src/lib/caller-scope'), scopeForRequest: () => mockScope() }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, windowOf, __setForTests, READ_BUDGET_MS } from '../../lambda/src/admin-meetings';
import { athenaQueryFor, partitionsFor, rowFromAthena } from '../../lambda/src/lib/meeting-event-reader';
import type { MeetingEventRow } from '../../lambda/src/lib/meeting-figures';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const row = (type: string, min: number, over: Partial<MeetingEventRow> = {}): MeetingEventRow => ({
  meeting_id: 'm-1', channel_arn: 'arn:c1', classification: 'premium', event_type: type, source: 'server', attendee_id: null,
  person_key: null, is_content: false, network_transport: null, event_at: new Date(NOW - 3_600_000 + min * 60_000).toISOString(), detail: null, ...over,
});
const ROWS = [
  row('MeetingStarted', 0),
  row('AttendeeJoined', 1, { person_key: 'p1', attendee_id: 'a1', network_transport: 'Voip' }),
  row('AttendeeLeft', 21, { person_key: 'p1', attendee_id: 'a1' }),
  row('MeetingEnded', 30),
];
const read = jest.fn();
const get = (path: string, query: Record<string, string> = {}, params: Record<string, string> | null = null) =>
  handler({ httpMethod: 'GET', path, headers: {}, queryStringParameters: query, pathParameters: params } as unknown as APIGatewayProxyEvent);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ claims: { personId: 'admin-1' } });
  read.mockResolvedValue({ rows: ROWS, truncated: false, unread: [], store: 'athena' });
  __setForTests({ read, now: () => NOW });
});

describe('the console’s meetings', () => {
  // THE CALLER'S CLASSIFICATIONS, AS EVERY ADMIN READ APPLIES THEM.
  it('DENY: a signed role whose scope reaches no classification lists no meeting, and is refused one meeting', async () => {
    mockIamCall.mockReturnValue(true);
    const list = JSON.parse((await get('/admin/meetings', { days: '7' })).body);
    expect(list.meetings).toEqual([]);
    expect(list.figures.meetings).toBe(0);
    const one = await get('/admin/meetings/m-1', {}, { meetingId: 'm-1' });
    expect(one.statusCode).toBe(403);
    expect(JSON.parse(one.body).code).toBe('OUTSIDE_SCOPE');
    expect(one.body).not.toContain('p1');
    mockIamCall.mockReturnValue(false);
  });

  // A MEETING NOT FOUND IN A READ THAT WAS NOT WHOLE IS NOT KNOWN TO BE ABSENT.
  it('answers a meeting missing from a read cut short, or one missing a classification, as incomplete, not as no such meeting', async () => {
    read.mockResolvedValue({ rows: [], truncated: true, unread: [], store: 'athena' });
    const cut = await get('/admin/meetings/m-1', {}, { meetingId: 'm-1' });
    expect(cut.statusCode).toBe(503);
    expect(JSON.parse(cut.body).code).toBe('INCOMPLETE');
    read.mockResolvedValue({ rows: [], truncated: false, unread: ['premium'], store: 'aurora' });
    expect(JSON.parse((await get('/admin/meetings/m-1', {}, { meetingId: 'm-1' })).body).code).toBe('INCOMPLETE');
    read.mockResolvedValue({ rows: [], truncated: false, unread: [], store: 'aurora' });
    expect(JSON.parse((await get('/admin/meetings/m-1', {}, { meetingId: 'm-1' })).body).code).toBe('NO_MEETING');
  });


  it('answers a caller who is not an admin with the refusal, and reads nothing', async () => {
    mockRequireAdmin.mockResolvedValue({ statusCode: 403, body: '{}' });
    expect((await get('/admin/meetings')).statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it('answers the figures and each meeting without its roster, with the window and the store', async () => {
    const res = await get('/admin/meetings', { days: '7' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ days: 7, store: 'athena', truncated: false, unreadClassifications: [] });
    expect(body.figures.meetings).toBe(1);
    expect(body.meetings[0]).toMatchObject({ meetingId: 'm-1', status: 'ended', people: 1, durationSeconds: 1800 });
    expect(body.meetings[0].roster).toBeUndefined();
    expect(body.meetings[0].incidents).toBeUndefined();
  });

  it('answers one meeting with its roster and events', async () => {
    const res = await get('/admin/meetings/m-1', {}, { meetingId: 'm-1' });
    const body = JSON.parse(res.body);
    expect(read).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'm-1', { deadlineAt: expect.any(Number) });
    expect(body.meeting.roster).toEqual([expect.objectContaining({ personKey: 'p1', connectedSeconds: 1200 })]);
    expect(body.events).toHaveLength(4);
  });

  it('counts the running meetings by what runs now, the same fact each row is shown by', async () => {
    // m-2 started ten minutes ago and has no end in the events: the events alone would call it running.
    const unended = [row('MeetingStarted', 50, { meeting_id: 'm-2', channel_arn: 'arn:c2' })];
    read.mockResolvedValue({ rows: [...ROWS, ...unended], truncated: false, unread: [], store: 'athena' });
    __setForTests({ read, now: () => NOW, record: async () => ({ meetingId: 'm-2' }), runs: async () => false });
    let body = JSON.parse((await get('/admin/meetings')).body);
    expect(body.figures.byStatus).toEqual({ active: 0, ended: 1, abandoned: 1 });
    expect(body.meetings.find((m: { meetingId: string }) => m.meetingId === 'm-2').live).toBe(false);
    __setForTests({ runs: async () => true });
    body = JSON.parse((await get('/admin/meetings')).body);
    expect(body.figures.byStatus).toEqual({ active: 1, ended: 1, abandoned: 0 });
    __setForTests({ record: async () => { throw new Error('unreadable'); } });
    body = JSON.parse((await get('/admin/meetings')).body);
    expect(body.figures.byStatus).toEqual({ active: 1, ended: 1, abandoned: 0 });
    __setForTests({ record: async () => null, runs: async () => false });
  });

  it('says when the answer is missing rows or a classification', async () => {
    read.mockResolvedValue({ rows: ROWS, truncated: true, unread: ['premium'], store: 'aurora' });
    const body = JSON.parse((await get('/admin/meetings')).body);
    expect(body).toMatchObject({ truncated: true, unreadClassifications: ['premium'] });
  });

  it('refuses a window outside 1 to 31 days, and a meeting id that is not one', async () => {
    expect((await get('/admin/meetings', { days: '90' })).statusCode).toBe(400);
    expect((await get('/admin/meetings/x', {}, { meetingId: "x' OR 1=1" })).statusCode).toBe(400);
    expect(windowOf(undefined, NOW)?.days).toBe(7);
    expect(windowOf('0', NOW)).toBeNull();
  });

  it("gives the read a deadline inside the HTTP API's 30 s limit, so a slow window is answered rather than cut off", async () => {
    const before = Date.now();
    await get('/admin/meetings', { days: '31' });
    const { deadlineAt } = read.mock.calls[0][3] as { deadlineAt: number };
    expect(deadlineAt).toBeGreaterThanOrEqual(before + READ_BUDGET_MS);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + READ_BUDGET_MS);
    expect(READ_BUDGET_MS).toBeLessThan(30_000);
  });

  it('counts only the meetings that started in the window, and finds no other by its id', async () => {
    // m-2 started before the window: only its last minutes are in it.
    const earlier = [
      row('AttendeeLeft', 2, { meeting_id: 'm-2', person_key: 'p2', attendee_id: 'a2' }),
      row('MeetingEnded', 3, { meeting_id: 'm-2' }),
    ];
    read.mockResolvedValue({ rows: [...ROWS, ...earlier], truncated: false, unread: [], store: 'athena' });
    const body = JSON.parse((await get('/admin/meetings')).body);
    expect(body.figures.meetings).toBe(1);
    expect(body.meetings.map((m: { meetingId: string }) => m.meetingId)).toEqual(['m-1']);
    expect(body.figures.durationSeconds).toEqual({ value: 1800, over: 1 });

    read.mockResolvedValue({ rows: earlier, truncated: false, unread: [], store: 'athena' });
    expect((await get('/admin/meetings/m-2', {}, { meetingId: 'm-2' })).statusCode).toBe(404);
  });

  it('answers an unreadable store as retryable', async () => {
    read.mockRejectedValue(new Error('athena down'));
    expect((await get('/admin/meetings')).statusCode).toBe(503);
  });
});

describe('the archive read', () => {
  it('names only the window’s partitions, a day wider each side for the arrival date', () => {
    const p = partitionsFor(Date.parse('2026-11-10T05:00:00Z'), Date.parse('2026-11-11T05:00:00Z'));
    expect(p.map((x) => `${x.year}-${x.month}-${x.day}`)).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
    const sql = athenaQueryFor('2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z', 'm-1');
    expect(sql).toContain("(year = '2026' AND month = '11' AND day = '09')");
    expect(sql).toContain("AND meeting_id = 'm-1'");
  });

  it('refuses anything that is not an instant or a meeting id, rather than writing it into a query', () => {
    expect(() => athenaQueryFor("2026-11-10' OR '1'='1", '2026-11-11T05:00:00.000Z', null)).toThrow();
    expect(() => athenaQueryFor('2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z', "m'1")).toThrow();
  });

  it('reads a row back with its detail parsed and its source kept', () => {
    const cols = ['meeting_id', 'channel_arn', 'classification', 'event_type', 'source', 'attendee_id', 'person_key', 'is_content', 'network_transport', 'event_at', 'detail'];
    expect(rowFromAthena(cols, ['m-1', 'arn:c', 'premium', 'meetingStartSucceeded', 'client', 'a1', 'p1', 'false', '', '2026-11-11T00:00:00.000Z', '{"meetingStartDurationMs":900}']))
      .toEqual(expect.objectContaining({ source: 'client', network_transport: null, is_content: false, detail: { meetingStartDurationMs: 900 } }));
  });
});
