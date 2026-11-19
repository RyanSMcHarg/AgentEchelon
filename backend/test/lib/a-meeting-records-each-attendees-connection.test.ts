/**
 * A MEETING RECORDS EACH ATTENDEE'S CONNECTION, MUTE AND DEVICES (SPEC-ASSISTANT-MEETINGS FR44): what the app files about
 * its own attendee through the one meeting-event path (`meeting-client-events.ts`), each attribute bounded or drawn from
 * a fixed set, a device named only by its class, a connectivity reading at most once per attendee per interval, and a
 * meeting's detail answering each attendee record's series (`meeting-figures.ts`, `admin-meetings.ts`).
 */
const mockRequireAdmin = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a), isAdminIamEnforcedCall: () => false }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
const mockSql: string[] = [];
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: async (_c: string, fn: (c: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => unknown) =>
    fn({ query: async (sql: string) => { mockSql.push(sql); return { rows: [] }; } }),
}));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  CLIENT_MEETING_EVENTS, CONNECTIVITY_SAMPLE_INTERVAL_MS, CLIENT_FAILURE_EVENTS, keptAttributes, recordsFromReport, sampleIntervalOf,
} from '../../lambda/src/lib/meeting-client-events';
import { meetingDetail, summarizeMeeting, type MeetingEventRow } from '../../lambda/src/lib/meeting-figures';
import { athenaQueryFor } from '../../lambda/src/lib/meeting-event-reader';
import { readMeetingEvents } from '../../lambda/src/analytics-aurora/meeting-events-read';
import { handler, __setForTests } from '../../lambda/src/admin-meetings';

const NOW = Date.parse('2026-11-11T12:00:07.500Z');
const CTX = { meetingId: 'm-1', channelArn: 'arn:c', classification: 'premium', personId: 'p-1', attendeeId: 'a-1', now: NOW };
const records = (events: unknown[]) => {
  const out = recordsFromReport(events, CTX);
  if (!('records' in out)) throw new Error(out.refused);
  return out;
};

describe('what the app files about its connection, its mute and its devices', () => {
  it('files every new event by name, as the caller\'s confirmed attendee', () => {
    const names = ['connectivitySample', 'connectionBecamePoor', 'connectionBecameGood', 'videoStopSuggested', 'audioMuted', 'audioUnmuted',
      'audioInputChanged', 'videoInputChanged', 'audioOutputChanged', 'devicesChanged', 'devicePermissionDenied'];
    for (const n of names) expect(CLIENT_MEETING_EVENTS).toContain(n);
    const out = records(names.map((name) => ({ name, at: NOW })));
    expect(out.records.map((r) => r.event_type)).toEqual(names);
    expect(out.records.every((r) => r.attendee_id === 'a-1' && r.person_key === 'p-1' && r.source === 'client')).toBe(true);
    // None is a failure: a refused permission is already the SDK's audioInputFailed, and the alarm counts that once.
    for (const n of names) expect(CLIENT_FAILURE_EVENTS.has(n)).toBe(false);
  });

  it('keeps a reading\'s metrics inside their bounds and to their precision, and drops one outside them', () => {
    expect(keptAttributes({
      connectionHealth: 'poor', audioLossSendPct: 2.345, audioLossReceivePct: 101, audioJitterMs: 12.6, rttMs: -5,
      availableSendKbps: 1500.4, availableReceiveKbps: Infinity, videoSendKbps: 600, videoReceiveKbps: '900', readings: 15,
    })).toEqual({ connectionHealth: 'poor', audioLossSendPct: 2.3, audioJitterMs: 13, availableSendKbps: 1500, videoSendKbps: 600, readings: 15 });
  });

  it('keeps a device\'s kind and class only from their fixed sets, and never a label or an id', () => {
    expect(keptAttributes({ deviceKind: 'audioinput', deviceClass: 'bluetooth', deviceCount: 3 }))
      .toEqual({ deviceKind: 'audioinput', deviceClass: 'bluetooth', deviceCount: 3 });
    expect(keptAttributes({
      deviceKind: 'microphone', deviceClass: "Jane's AirPods", deviceCount: 10_000, label: "Jane's AirPods", deviceId: 'abc123', groupId: 'g',
      connectionHealth: 'excellent',
    })).toEqual({});
  });

  it('skips a name it does not file, beside the new ones', () => {
    const out = records([{ name: 'audioMuted', at: NOW }, { name: 'audioInputSelected', at: NOW }, { name: 'deviceLabel', at: NOW }]);
    expect(out.records.map((r) => r.event_type)).toEqual(['audioMuted']);
    expect(out.skipped).toBe(2);
  });
});

describe('one connectivity reading per attendee per interval', () => {
  it('files a reading at the start of its interval', () => {
    const [r] = records([{ name: 'connectivitySample', at: NOW, attributes: { rttMs: 50 } }]).records;
    expect(r.event_at).toBe('2026-11-11T12:00:00.000Z');
    expect(Date.parse(r.event_at) % CONNECTIVITY_SAMPLE_INTERVAL_MS).toBe(0);
  });

  it('skips a second reading for an interval the report already holds, and keeps readings an interval apart', () => {
    const out = records([
      { name: 'connectivitySample', at: NOW - 7_000 },
      { name: 'connectivitySample', at: NOW },
      { name: 'connectivitySample', at: NOW + 7_000 },
      { name: 'connectivitySample', at: NOW + 7_500 },
    ]);
    expect(out.records.map((r) => r.event_at)).toEqual(['2026-11-11T12:00:00.000Z', '2026-11-11T12:00:15.000Z']);
    expect(out.skipped).toBe(2);
  });

  it('files every reading an app with a far clock sends at the server\'s interval, so one report of them adds one', () => {
    const far = NOW - 3_600_000;
    const out = records([{ name: 'connectivitySample', at: far }, { name: 'connectivitySample', at: far + 15_000 }]);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ event_at: sampleIntervalOf(NOW), detail: { clockAdjusted: true } });
  });

  it('is the interval the chat app samples at', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const client = fs.readFileSync(path.join(__dirname, '../../../frontend/packages/chat/src/services/meetingEventNames.ts'), 'utf8');
    expect(client).toContain(`CONNECTIVITY_SAMPLE_INTERVAL_MS = ${CONNECTIVITY_SAMPLE_INTERVAL_MS.toLocaleString('en-US').replace(/,/g, '_')}`);
  });
});

const T0 = Date.parse('2026-11-11T14:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (type: string, s: number, over: Partial<MeetingEventRow> = {}): MeetingEventRow => ({
  meeting_id: 'm-1', channel_arn: 'arn:c1', classification: 'premium', event_type: type, source: 'server',
  attendee_id: null, person_key: null, is_content: false, network_transport: null, event_at: at(s), detail: null, ...over,
});
const app = (type: string, s: number, detail: Record<string, unknown> = {}, attendee = 'a1', person = 'alice') =>
  ev(type, s, { source: 'client', attendee_id: attendee, person_key: person, detail });
const MEETING = [
  ev('MeetingStarted', 0),
  ev('AttendeeJoined', 5, { person_key: 'alice', attendee_id: 'a1', network_transport: 'Voip' }),
  ev('AttendeeJoined', 6, { person_key: 'bob', attendee_id: 'b1', network_transport: 'Voip' }),
  app('connectivitySample', 15, { connectionHealth: 'good', rttMs: 40, audioLossSendPct: 0.5, availableSendKbps: 2000, readings: 15 }),
  app('connectivitySample', 30, { connectionHealth: 'good', rttMs: 300, readings: 15 }),
  app('connectionBecamePoor', 40),
  app('videoStopSuggested', 41),
  app('connectivitySample', 45, { connectionHealth: 'poor', rttMs: 900, audioLossReceivePct: 12, readings: 15 }),
  app('connectionBecameGood', 100),
  app('audioMuted', 110),
  app('audioInputChanged', 120, { deviceClass: 'usb' }),
  app('connectionBecamePoor', 200, {}, 'b1', 'bob'),
  ev('AttendeeLeft', 260, { person_key: 'bob', attendee_id: 'b1' }),
  ev('AttendeeLeft', 600, { person_key: 'alice', attendee_id: 'a1' }),
  ev('MeetingEnded', 3600),
];

describe('a meeting\'s detail answers each attendee record\'s connection', () => {
  it('returns the readings in time order, with a metric the app did not read as null', () => {
    const { connectivity } = meetingDetail(MEETING, T0 + 7_200_000);
    const alice = connectivity.find((c) => c.attendeeId === 'a1')!;
    expect(alice.personKey).toBe('alice');
    expect(alice.samples.map((s) => s.at)).toEqual([at(15), at(30), at(45)]);
    expect(alice.samples[0]).toEqual({
      at: at(15), health: 'good', audioLossSendPct: 0.5, audioLossReceivePct: null, audioJitterMs: null, rttMs: 40,
      availableSendKbps: 2000, availableReceiveKbps: null, videoSendKbps: null, videoReceiveKbps: null,
    });
    expect(alice.samples[2]).toMatchObject({ health: 'poor', rttMs: 900, audioLossReceivePct: 12 });
    expect(alice.healthChanges).toEqual([{ at: at(40), health: 'poor' }, { at: at(100), health: 'good' }]);
    expect(alice.videoStopSuggestions).toBe(1);
  });

  it('counts a poor stretch to the change to good, or to the attendee leaving, never to the meeting\'s end', () => {
    const { meeting, connectivity } = meetingDetail(MEETING, T0 + 7_200_000);
    expect(connectivity.find((c) => c.attendeeId === 'a1')!.poorSeconds).toBe(60);
    expect(connectivity.find((c) => c.attendeeId === 'b1')!.poorSeconds).toBe(60);
    const bob = meeting.roster.find((r) => r.personKey === 'bob')!;
    expect(bob.poorConnectionSeconds).toBe(60);
    expect(bob.quality).toBe('warning');
  });

  it('leaves the summary\'s figures where they were: the readings, the mute and the devices count as nothing else', () => {
    const without = MEETING.filter((r) => r.source !== 'client');
    const a = summarizeMeeting(MEETING, T0 + 7_200_000);
    const b = summarizeMeeting(without, T0 + 7_200_000);
    expect({ ...a, roster: undefined }).toEqual({ ...b, roster: undefined });
    expect(a.roster.map((r) => r.connectedSeconds)).toEqual(b.roster.map((r) => r.connectedSeconds));
  });

  it('is answered at the top of GET /admin/meetings/{id}, beside the meeting and its events, the readings carried there alone', async () => {
    mockRequireAdmin.mockResolvedValue({ claims: { personId: 'admin-1' } });
    __setForTests({ read: jest.fn().mockResolvedValue({ rows: MEETING, truncated: false, unread: [], store: 'athena' }), now: () => T0 + 7_200_000 });
    const res = await handler({
      httpMethod: 'GET', path: '/admin/meetings/m-1', headers: {}, queryStringParameters: {}, pathParameters: { meetingId: '0b5c1a3e-1d2f-4c5b-9a8e-7f6d5c4b3a21' },
    } as unknown as APIGatewayProxyEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.connectivity.map((c: { attendeeId: string }) => c.attendeeId).sort()).toEqual(['a1', 'b1']);
    expect(body.meeting.connectivity).toBeUndefined();
    const types = body.events.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['audioMuted', 'audioInputChanged']));
    // The readings travel once, in `connectivity`, so a long meeting's answer stays inside what a Lambda may return.
    expect(types).not.toContain('connectivitySample');
    expect(body.connectivity.some((c: { samples: unknown[] }) => c.samples.length > 0)).toBe(true);
    // Each person's poor stretches and moments (FR74), with the thresholds they were judged against.
    expect(body.experience.thresholds).toEqual({ packetLossPct: 3, jitterMs: 30, roundTripMs: 300, sustainedSeconds: 30 });
    expect(Array.isArray(body.experience.issues)).toBe(true);
  });
});

describe('a window\'s read leaves the readings out; a meeting\'s read keeps them', () => {
  it('in the archive', () => {
    expect(athenaQueryFor('2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z', null)).toContain("AND event_type <> 'connectivitySample'");
    expect(athenaQueryFor('2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z', '0b5c1a3e-1d2f-4c5b-9a8e-7f6d5c4b3a21')).not.toContain('connectivitySample');
  });

  it('in the Aurora projection', async () => {
    mockSql.length = 0;
    await readMeetingEvents({ fromIso: '2026-11-10T05:00:00.000Z', toIso: '2026-11-11T05:00:00.000Z' });
    expect(mockSql.length).toBeGreaterThan(0);
    expect(mockSql.every((s) => s.includes("event_type <> 'connectivitySample'"))).toBe(true);
    mockSql.length = 0;
    await readMeetingEvents({ fromIso: '2026-11-10T05:00:00.000Z', toIso: '2026-11-11T05:00:00.000Z', meetingId: 'm-1' });
    expect(mockSql.some((s) => s.includes('connectivitySample'))).toBe(false);
    // A meeting's figures (its summary entry and its watch) leave them out, so a long meeting's read fits its cap.
    mockSql.length = 0;
    await readMeetingEvents({ fromIso: '2026-11-10T05:00:00.000Z', toIso: '2026-11-11T05:00:00.000Z', meetingId: 'm-1', samples: false });
    expect(mockSql.every((s) => s.includes("event_type <> 'connectivitySample'") && s.includes('meeting_id = $4'))).toBe(true);
  });

  it("a meeting's figures leave them out in the archive too", () => {
    const q = athenaQueryFor('2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z', '0b5c1a3e-1d2f-4c5b-9a8e-7f6d5c4b3a21', false);
    expect(q).toContain("AND meeting_id = '0b5c1a3e-1d2f-4c5b-9a8e-7f6d5c4b3a21'");
    expect(q).toContain("AND event_type <> 'connectivitySample'");
  });
});
