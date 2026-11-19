/**
 * meeting-events-ingest - the roster's source rows.
 *
 * The contract that matters here is not the INSERT shape, it is IDEMPOTENCE. EventBridge delivery is
 * at-least-once and the roster SUMS INTERVALS, so a duplicated `AttendeeJoined` adds a second
 * interval for one arrival: connected time and the participant count both drift upward, silently, in
 * the direction that reads as success. These pin the conflict target and the duplicate accounting.
 */
const mockedQuery = jest.fn();
const mockWithWriterRole = jest.fn((fn: (client: unknown) => Promise<unknown>) => fn({ query: mockedQuery }));
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withWriterRole: (fn: (client: unknown) => Promise<unknown>) => mockWithWriterRole(fn),
}));

import {
  ingestMeetingEvents,
  type MeetingEventRecord,
} from '../../lambda/src/analytics-aurora/meeting-events-ingest';
import { MEETING_EVENT_COLUMNS } from '../../lambda/src/lib/meeting-event-shape';

const rec = (over: Partial<MeetingEventRecord> = {}): MeetingEventRecord => ({
  meeting_id: 'm-1',
  channel_arn: 'arn:aws:chime:us-east-1:111122223333:app-instance/abc/channel/c1',
  classification: 'premium',
  event_type: 'AttendeeJoined',
  source: 'server',
  attendee_id: 'att-1',
  person_key: 'alice',
  is_content: false,
  network_transport: 'Wifi',
  event_at: '2026-10-01T14:02:00.000Z',
  detail: { mediaRegion: 'us-east-1' },
  ...over,
});

const sql = () => String(mockedQuery.mock.calls[0][0]);
const params = () => mockedQuery.mock.calls[0][1] as unknown[];
/** The value bound for one column of one row, by the column's place in the one column list. */
const param = (column: keyof MeetingEventRecord, row = 0) =>
  params()[row * MEETING_EVENT_COLUMNS.length + MEETING_EVENT_COLUMNS.findIndex((c) => c.name === column)];

describe('ingestMeetingEvents', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no-ops on empty input without touching the database', async () => {
    expect(await ingestMeetingEvents([])).toEqual({ inserted: 0, duplicates: 0 });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('inserts AS THE WRITE ROLE, because the table is under forced row-level security that refuses any other writer', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec()]);
    expect(mockWithWriterRole).toHaveBeenCalledTimes(1);
    expect(sql()).toContain('INSERT INTO meeting_events');
  });

  it('ignores a redelivery rather than adding a second interval for one arrival', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec()]);
    expect(sql()).toContain('ON CONFLICT');
    expect(sql()).toContain('DO NOTHING');
  });

  it('conflicts on what the service already makes unique, COALESCING the nullable attendee', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec()]);
    // A unique index treats NULLs as distinct, so without the COALESCE the meeting-level events -
    // the ones with no attendee - would duplicate freely. That is the case the obvious index misses.
    expect(sql()).toContain("COALESCE(attendee_id, '')");
    expect(sql()).toMatch(/ON CONFLICT \(meeting_id, COALESCE\(attendee_id, ''\), event_type, event_at\)/);
  });

  it('reports how many of the batch were redeliveries, rather than claiming them all', async () => {
    // Three sent, one new: the other two had been seen before.
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const out = await ingestMeetingEvents([rec(), rec({ event_at: '2026-10-01T14:03:00.000Z' }), rec({ event_at: '2026-10-01T14:04:00.000Z' })]);
    expect(out).toEqual({ inserted: 1, duplicates: 2 });
  });

  it('reports a wholly duplicate batch as zero inserted, which is correct and not a failure', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await ingestMeetingEvents([rec()])).toEqual({ inserted: 0, duplicates: 1 });
  });

  it('binds every column by the one column list, with the detail as jsonb', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec()]);
    expect(sql()).toContain(`INSERT INTO meeting_events (${MEETING_EVENT_COLUMNS.map((c) => c.name).join(', ')})`);
    expect(sql()).toContain(`$${MEETING_EVENT_COLUMNS.findIndex((c) => c.name === 'detail') + 1}::jsonb`);
    const r = rec();
    expect(params()).toEqual(MEETING_EVENT_COLUMNS.map((c) => (c.name === 'detail' ? JSON.stringify(r.detail) : r[c.name])));
  });

  it('offsets the placeholders per row, so a batch does not bind every row to the first', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 } as never);
    await ingestMeetingEvents([rec(), rec({ meeting_id: 'm-2' })]);
    const n = MEETING_EVENT_COLUMNS.length;
    expect(sql()).toContain(`), ($${n + 1}, $${n + 2}`);
    expect(params()).toHaveLength(2 * n);
    expect(param('meeting_id', 1)).toBe('m-2');
  });

  it('files who recorded the event, so the service, an app and the platform share one log', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec({ source: 'client', event_type: 'meetingStartSucceeded' })]);
    expect(param('source')).toBe('client');
  });

  it('writes a null detail as a null rather than the string "null"', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec({ detail: null })]);
    expect(param('detail')).toBeNull();
  });

  it('carries the content-share marker, which is what lets a roster count people not connections', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await ingestMeetingEvents([rec({ attendee_id: 'att-1#content', is_content: true })]);
    expect(param('attendee_id')).toBe('att-1#content');
    expect(param('is_content')).toBe(true);
    // The person key is the OWNER's, so the share folds onto their row instead of being a participant.
    expect(param('person_key')).toBe('alice');
  });
});

describe('the table expires as it is written (migration 105)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes a bounded batch of expired rows, oldest first, in the same write, as the write role', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await ingestMeetingEvents([rec()])).toEqual({ inserted: 1, duplicates: 0 });
    expect(mockWithWriterRole).toHaveBeenCalledTimes(1);
    const reap = String(mockedQuery.mock.calls[1][0]);
    expect(reap).toMatch(/DELETE FROM meeting_events WHERE id IN \(\s*SELECT id FROM meeting_events WHERE expires_at < NOW\(\) ORDER BY expires_at LIMIT 500\)/);
  });

  it('gives every row an expiry: the longest a conversation lives', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MAX_CONVERSATION_TTL_DAYS } = require('../../lib/config/conversation-types') as typeof import('../../lib/config/conversation-types');
    const sqlText = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'schema', '105-a-meetings-events-expire-with-its-conversation.sql'), 'utf8');
    expect(sqlText).toContain(`ALTER TABLE meeting_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '${MAX_CONVERSATION_TTL_DAYS} days')`);
  });
});
