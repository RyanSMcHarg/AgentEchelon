import { describe, it, expect } from 'vitest';
import {
  MEETING_LANE, buildTimeline, categoryOf, connectivityLanes, countTicks, timeTicks, windowDays,
} from './meetingLanes';
import { ALICE, BOB, EVENTS, MEETING, at } from './meetingFixture';

describe('the window drawn by day', () => {
  it('gives every day of the window, a day the server listed with its counts and any other as no meetings', () => {
    const days = windowDays([{ day: '2026-11-07', meetings: 3, people: 7, dropEvents: 1, clientFailures: 2 }], '2026-11-05T09:30:00.000Z', '2026-11-08T09:30:00.000Z');
    expect(days.map((d) => d.day)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(days[2]).toEqual({ day: '2026-11-07', meetings: 3, people: 7, dropEvents: 1, clientFailures: 2 });
    expect(days[0]).toEqual({ day: '2026-11-05', meetings: 0, people: 0, dropEvents: 0, clientFailures: 0 });
  });

  it('reads an answer from before the server counted people per day as zero people, not as missing days', () => {
    expect(windowDays([{ day: '2026-11-05', meetings: 1 }], '2026-11-05T00:00:00.000Z', '2026-11-05T12:00:00.000Z'))
      .toEqual([{ day: '2026-11-05', meetings: 1, people: 0, dropEvents: 0, clientFailures: 0 }]);
  });

  it('puts the count axis on round numbers at or above the largest value', () => {
    expect(countTicks(0)).toEqual([0, 1]);
    expect(countTicks(3)).toEqual([0, 1, 2, 3]);
    expect(countTicks(17)).toEqual([0, 5, 10, 15, 20]);
  });
});

describe('a meeting as lanes', () => {
  const tl = buildTimeline(MEETING, EVENTS);

  it('draws the meeting lane first, then one lane per person by their id in the order they joined', () => {
    expect(tl.lanes.map((l) => l.key)).toEqual([MEETING_LANE, ALICE, BOB]);
    expect(tl.lanes[1].personKey).toBe(ALICE);
  });

  it('spans the meeting from its start to its end', () => {
    expect(tl.start).toBe(Date.parse(at(0)));
    expect(tl.end).toBe(Date.parse(at(20)));
  });

  it('draws the roster\'s own intervals as the person\'s connected, camera and sharing spans', () => {
    const bob = tl.lanes.find((l) => l.key === BOB)!;
    expect(bob.connected).toEqual([{ from: Date.parse(at(2)), to: Date.parse(at(14)) }, { from: Date.parse(at(15)), to: Date.parse(at(20)) }]);
    const alice = tl.lanes.find((l) => l.key === ALICE)!;
    expect(alice.camera).toHaveLength(1);
    expect(alice.sharing).toEqual([{ from: Date.parse(at(8)), to: Date.parse(at(12)) }]);
  });

  it('puts the meeting\'s own events on its lane, a person\'s on theirs, and a ring on the person it rang', () => {
    const laneOf = (type: string) => tl.markers.filter((m) => m.event.event_type === type).map((m) => m.lane);
    expect(laneOf('MeetingStarted')).toEqual([MEETING_LANE]);
    expect(laneOf('meetingCreated')).toEqual([MEETING_LANE]);
    expect(laneOf('ringAnswered')).toEqual([BOB]);
    expect(laneOf('AttendeeContentJoined')).toEqual([ALICE]);
  });

  it('marks every event but the periodic connectivity reading', () => {
    expect(tl.markers).toHaveLength(EVENTS.length - 2);
    expect(tl.markers.some((m) => m.event.event_type === 'connectivitySample')).toBe(false);
  });

  it('adds a lane for someone the events name who is not on the roster', () => {
    const extra = { ...EVENTS[3], person_key: 'aiu-eve-0003', event_type: 'meetingStartFailed' };
    expect(buildTimeline(MEETING, [...EVENTS, extra]).lanes.map((l) => l.key)).toContain('aiu-eve-0003');
  });

  it('runs a live meeting\'s axis to now', () => {
    const now = Date.parse(at(45));
    expect(buildTimeline({ ...MEETING, status: 'active', endedAt: null }, EVENTS.slice(0, 5), now).end).toBe(now);
  });

  it('ticks the axis on round steps', () => {
    const ticks = timeTicks(Date.parse(at(0)), Date.parse(at(20)), 6);
    expect(ticks[1] - ticks[0]).toBe(5 * 60_000);
  });
});

describe('each event has one category', () => {
  const cat = (event_type: string, more: Record<string, unknown> = {}) => categoryOf({ event_type, source: 'client', is_content: false, ...more } as never);

  it('files drops and app failures as failures, and a shared screen ending as media, never as a drop', () => {
    expect(cat('AttendeeDropped', { source: 'server' })).toBe('failure');
    expect(cat('audioInputFailed')).toBe('failure');
    expect(cat('devicePermissionDenied')).toBe('failure');
    expect(cat('AttendeeDropped', { source: 'server', is_content: true })).toBe('media');
  });

  it('files mute, devices, connection and rings each under its own', () => {
    expect(cat('audioMuted')).toBe('media');
    expect(cat('AttendeeVideoStarted', { source: 'server' })).toBe('media');
    expect(cat('audioInputChanged')).toBe('device');
    expect(cat('connectionBecamePoor')).toBe('connection');
    expect(cat('ringTimedOut')).toBe('ring');
    expect(cat('MeetingStarted', { source: 'server' })).toBe('lifecycle');
    expect(cat('somethingNew')).toBe('other');
  });
});

describe('connectivity', () => {
  it('uses the answer\'s connectivity where it carries it', () => {
    const given = [{ personKey: BOB, attendeeId: 'x', samples: [], healthChanges: [], poorSeconds: 60, videoStopSuggestions: 2 }];
    expect(connectivityLanes(given, EVENTS)).toBe(given);
  });

  it('else reads each attendee record\'s readings and health changes from the events, and sums nothing', () => {
    const lanes = connectivityLanes(undefined, EVENTS);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ personKey: BOB, attendeeId: `${BOB}-a1`, healthChanges: [{ at: at(6), health: 'poor' }] });
    expect(lanes[0].samples.map((s) => [s.rttMs, s.health, s.availableSendKbps])).toEqual([[80, 'good', null], [420, 'poor', null]]);
    expect(lanes[0].poorSeconds).toBeUndefined();
  });

  it('has nothing for a meeting that recorded no connection', () => {
    expect(connectivityLanes(undefined, EVENTS.filter((e) => !/connect/i.test(e.event_type)))).toEqual([]);
  });
});
