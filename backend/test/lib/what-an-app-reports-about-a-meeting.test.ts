/**
 * WHAT AN APP REPORTS ABOUT A MEETING (`meeting-client-events.ts`): named from a fixed list, a handful of bounded
 * attributes, a time near the server's own, and nothing that names a person, a meeting or a boundary.
 */
import { MEETING_METRICS, recordClientFailures } from '../../lambda/src/lib/meeting-client-events';
import {
  CLIENT_MEETING_EVENTS, CLOCK_TOLERANCE_MS, MAX_EVENTS_PER_REPORT, RING_OUTCOME_EVENTS, eventTime, keptAttributes, recordsFromReport,
} from '../../lambda/src/lib/meeting-client-events';

const CTX = { meetingId: 'm-1', channelArn: 'arn:c', classification: 'premium', personId: 'p-1', attendeeId: 'a-1', now: 1_700_000_000_000 };

describe('what an app reports about a meeting', () => {
  it('files every Amazon Chime SDK client event and ring outcome it names', () => {
    const names = [...CLIENT_MEETING_EVENTS, ...RING_OUTCOME_EVENTS];
    // Reported a batch at a time, as the app sends them.
    const filed: string[] = [];
    for (let i = 0; i < names.length; i += MAX_EVENTS_PER_REPORT) {
      const out = recordsFromReport(names.slice(i, i + MAX_EVENTS_PER_REPORT).map((name) => ({ name, at: CTX.now })), CTX);
      if ('records' in out) filed.push(...out.records.map((r) => r.event_type));
    }
    expect(filed).toEqual(names);
  });

  it('skips a name it does not file, and keeps the rest of the report', () => {
    const out = recordsFromReport([{ name: 'somethingNew' }, { name: 'meetingReconnected', at: CTX.now }], CTX);
    expect(out).toEqual({ records: [expect.objectContaining({ event_type: 'meetingReconnected' })], skipped: 1 });
  });

  it('refuses an empty report and one larger than a batch', () => {
    expect(recordsFromReport([], CTX)).toEqual({ refused: 'NO_EVENTS' });
    expect(recordsFromReport(Array.from({ length: MAX_EVENTS_PER_REPORT + 1 }, () => ({ name: 'meetingEnded' })), CTX)).toEqual({ refused: 'TOO_MANY_EVENTS' });
  });

  it('keeps only the listed attributes, bounded, and drops anything else', () => {
    expect(keptAttributes({
      browserName: 'x'.repeat(500), meetingStartDurationMs: 1234.6, retryCount: -1, sdkVersion: 3, email: 'a@b.c', personId: 'p-2',
    })).toEqual({ browserName: 'x'.repeat(200), meetingStartDurationMs: 1235 });
  });

  it('keeps the app\'s time only near the server\'s clock, and says when it did not', () => {
    expect(eventTime(CTX.now - 1000, CTX.now)).toEqual({ eventAt: new Date(CTX.now - 1000).toISOString(), clockAdjusted: false });
    expect(eventTime(CTX.now - CLOCK_TOLERANCE_MS - 1, CTX.now)).toEqual({ eventAt: new Date(CTX.now).toISOString(), clockAdjusted: true });
    expect(eventTime('soon', CTX.now).clockAdjusted).toBe(true);
  });
});

describe('the chat app reports by the same names', () => {
  it('lists every event the server files, and no other', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const client = fs.readFileSync(path.join(__dirname, '../../../frontend/packages/chat/src/services/meetingEventNames.ts'), 'utf8');
    const listed = (name: string) => [...(client.split(`export const ${name} = [`)[1]?.split(']')[0] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(listed('CLIENT_MEETING_EVENTS')).toEqual([...CLIENT_MEETING_EVENTS]);
    expect(listed('RING_OUTCOME_EVENTS')).toEqual([...RING_OUTCOME_EVENTS]);
    expect(client).toContain(`MAX_EVENTS_PER_REPORT = ${MAX_EVENTS_PER_REPORT}`);
  });
});

describe('the one metric a report emits: failures, for the alarm', () => {
  const recs = (events: Array<Record<string, unknown>>) => (recordsFromReport(events, CTX) as unknown as { records: never[] }).records;
  const emitted = (records: never[]): Array<Record<string, unknown> & { _aws: { CloudWatchMetrics: unknown } }> => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      recordClientFailures(records, 'ns/Meetings');
      return spy.mock.calls.map((c) => JSON.parse(String(c[0])));
    } finally {
      spy.mockRestore();
    }
  };

  it("counts a report's failures once, with no dimension, which is the series the alarm reads", () => {
    const docs = emitted(recs([
      { name: 'meetingStartSucceeded', at: CTX.now, attributes: { meetingStartDurationMs: 1500 } },
      { name: 'audioInputFailed', at: CTX.now },
      { name: 'signalingDropped', at: CTX.now },
      { name: 'ringAnswered', at: CTX.now },
    ]));
    expect(docs).toHaveLength(1);
    expect(docs[0]._aws.CloudWatchMetrics).toEqual([{ Namespace: 'ns/Meetings', Dimensions: [[]], Metrics: [{ Name: MEETING_METRICS.clientFailure, Unit: 'Count' }] }]);
    expect(docs[0][MEETING_METRICS.clientFailure]).toBe(2);
  });

  it("emits nothing for a report with no failure: every other figure is the console's, from the recorded events", () => {
    expect(emitted(recs([{ name: 'meetingStartSucceeded', at: CTX.now }, { name: 'ringAnswered', at: CTX.now }]))).toEqual([]);
  });
});

describe("two events one report files at the server's time", () => {
  it('stay two events on the natural key, in the order the app sent them', () => {
    const skewed = CTX.now - CLOCK_TOLERANCE_MS - 60_000;
    const out = recordsFromReport([{ name: 'meetingReconnected', at: skewed }, { name: 'meetingReconnected', at: skewed }], CTX);
    const at = 'records' in out ? out.records.map((r) => r.event_at) : [];
    expect(at).toHaveLength(2);
    expect(new Set(at).size).toBe(2);
    expect(Date.parse(at[0])).toBeLessThan(Date.parse(at[1]));
  });
});

describe('two events of one type the app stamps in the same millisecond', () => {
  it('stay two events on the natural key, in the order sent, and an event of another type keeps its own time', () => {
    const same = CTX.now - 1_000;
    const out = recordsFromReport([
      { name: 'devicesChanged', at: same, attributes: { deviceKind: 'audioinput' } },
      { name: 'devicesChanged', at: same, attributes: { deviceKind: 'audiooutput' } },
      { name: 'meetingReconnected', at: same },
    ], CTX);
    const records = 'records' in out ? out.records : [];
    expect(records).toHaveLength(3);
    const keys = records.map((r) => `${r.meeting_id}|${r.attendee_id}|${r.event_type}|${r.event_at}`);
    expect(new Set(keys).size).toBe(3);
    expect(records[0].event_at).toBe(new Date(same).toISOString());
    expect(Date.parse(records[0].event_at)).toBeLessThan(Date.parse(records[1].event_at));
    expect(records[2].event_at).toBe(new Date(same).toISOString());
  });
});

describe('a ring outcome is timed by the server', () => {
  it("whatever the app's clock says, so time-to-answer never carries a device's offset", () => {
    const behind = CTX.now - 20_000;
    const out = recordsFromReport([{ name: 'ringAnswered', at: behind }], CTX);
    expect('records' in out && out.records[0].event_at).toBe(new Date(CTX.now).toISOString());
  });
});
