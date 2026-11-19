/**
 * A MEETING READ FITS ITS LIMITS (`archive-reader.ts`, `meeting-event-reader.ts`, `meeting-events-read.ts`,
 * `meeting-event-shape.ts`): the caller's deadline, and the size of the answer's return trip. A read that would pass
 * either is answered as incomplete (`truncated`), the answer the console and the summary are built to word, rather than
 * failing at the gateway or the invoke.
 */
const mockSent: Array<{ kind: string; input: unknown }> = [];
let mockState = 'RUNNING';
jest.mock('@aws-sdk/client-athena', () => {
  class Cmd { constructor(public input: unknown) {} }
  class StartQueryExecutionCommand extends Cmd {}
  class GetQueryExecutionCommand extends Cmd {}
  class GetQueryResultsCommand extends Cmd {}
  class StopQueryExecutionCommand extends Cmd {}
  return {
    AthenaClient: jest.fn(() => ({
      send: jest.fn(async (cmd: Cmd) => {
        mockSent.push({ kind: cmd.constructor.name, input: cmd.input });
        if (cmd instanceof StartQueryExecutionCommand) return { QueryExecutionId: 'q-1' };
        if (cmd instanceof GetQueryExecutionCommand) return { QueryExecution: { Status: { State: mockState } } };
        if (cmd instanceof StopQueryExecutionCommand) return {};
        return { ResultSet: { Rows: [{ Data: [{ VarCharValue: 'meeting_id' }] }, { Data: [{ VarCharValue: 'm-1' }] }] } };
      }),
    })),
    StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand, StopQueryExecutionCommand,
    QueryExecutionState: { SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED' },
  };
}, { virtual: true });
jest.mock('../../lambda/src/lib/event-archive', () => ({ ensureDataPlaneArn: async () => undefined }));
jest.mock('../../lambda/src/lib/data-plane-client', () => ({ hasDataPlane: () => false }));
let mockAuroraRows: Record<string, unknown>[] = [];
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withReaderRole: async (classification: string, fn: (c: { query: () => Promise<{ rows: unknown[] }> }) => unknown) =>
    fn({ query: async () => ({ rows: mockAuroraRows.filter((r) => r.classification === classification) }) }),
}));

import { ArchiveQueryTimeout, runArchiveQuery } from '../../lambda/src/lib/archive-reader';
import { meetingEventsIn, athenaQueryFor } from '../../lambda/src/lib/meeting-event-reader';
import { readMeetingEvents } from '../../lambda/src/analytics-aurora/meeting-events-read';
import {
  MAX_MEETING_EVENT_BYTES, MEETING_EVENT_COLUMNS, MEETING_EVENT_COLUMN_LIST, capMeetingEvents, meetingEventBytes, type MeetingEventRecord,
} from '../../lambda/src/lib/meeting-event-shape';
import { MEETING_EVENT_COLUMNS as GLUE_COLUMNS } from '../../lib/stacks/meetings-stack';
import { defaultProfileRegistry } from '../../lib/profile-registry';

const rec = (i: number, over: Partial<MeetingEventRecord> = {}): MeetingEventRecord => ({
  meeting_id: `m-${i % 7}`, channel_arn: 'arn:c', classification: 'standard', event_type: 'AttendeeJoined', source: 'server',
  attendee_id: `a-${i}`, person_key: `p-${i}`, is_content: false, network_transport: 'Voip',
  event_at: new Date(Date.parse('2026-11-01T00:00:00.000Z') + i * 1000).toISOString(), detail: { pad: 'x'.repeat(400) }, ...over,
});

beforeEach(() => { mockSent.length = 0; mockState = 'RUNNING'; mockAuroraRows = []; });

describe('an archive query answers by its caller\'s deadline', () => {
  it('stops a query still running at the deadline and says so, rather than polling past the caller\'s limit', async () => {
    const started = Date.now();
    await expect(runArchiveQuery('SELECT 1', { maxRows: 10, deadlineAt: started + 50 })).rejects.toBeInstanceOf(ArchiveQueryTimeout);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mockSent.map((s) => s.kind)).toContain('StopQueryExecutionCommand');
    expect(mockSent.find((s) => s.kind === 'StopQueryExecutionCommand')?.input).toEqual({ QueryExecutionId: 'q-1' });
  });

  it('reads a finished query\'s rows', async () => {
    mockState = 'SUCCEEDED';
    expect(await runArchiveQuery('SELECT 1', { maxRows: 10 })).toEqual({ columns: ['meeting_id'], rows: [['m-1']], truncated: false });
  });

  it('answers a meeting window that cannot be read in time as incomplete, with no rows', async () => {
    const r = await meetingEventsIn('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', null, { deadlineAt: Date.now() + 50 });
    expect(r).toEqual({ rows: [], truncated: true, unread: [], store: 'athena' });
  });
});

describe('an answer fits its return trip', () => {
  it('stops at the byte limit, in time order, and says it is truncated', () => {
    const rows = Array.from({ length: 50 }, (_, i) => rec(49 - i));
    const per = meetingEventBytes(rows[0]);
    const out = capMeetingEvents(rows, false, { rows: 1000, bytes: per * 10 + 5 });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(10);
    expect(out.rows.map((r) => r.attendee_id)).toEqual(Array.from({ length: 10 }, (_, i) => `a-${i}`));
  });

  it('an Aurora read of more than one invoke can carry is cut inside the limit and answered as truncated', async () => {
    const classification = defaultProfileRegistry.classificationValues()[0];
    // Enough rows to pass the byte limit well below the row cap.
    const n = Math.ceil(MAX_MEETING_EVENT_BYTES / meetingEventBytes(rec(0))) + 500;
    mockAuroraRows = Array.from({ length: n }, (_, i) => ({ ...rec(i, { classification }) }));
    const r = await readMeetingEvents({ fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-12-01T00:00:00.000Z' });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThan(6 * 1024 * 1024);
    expect(r.rows.length).toBeLessThan(n);
  });

  it('a window that fits is answered whole', async () => {
    const classification = defaultProfileRegistry.classificationValues()[0];
    mockAuroraRows = [{ ...rec(1, { classification }) }, { ...rec(2, { classification }) }];
    const r = await readMeetingEvents({ fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-12-01T00:00:00.000Z' });
    expect(r).toMatchObject({ truncated: false, unread: [] });
    expect(r.rows).toHaveLength(2);
  });
});

describe('one column list for every store', () => {
  it('names every field of the record, and the Glue table and the archive query read exactly it', () => {
    expect(MEETING_EVENT_COLUMNS.map((c) => c.name).sort()).toEqual(Object.keys(rec(0)).sort());
    expect(GLUE_COLUMNS).toBe(MEETING_EVENT_COLUMNS);
    expect(athenaQueryFor('2026-11-10T05:00:00.000Z', '2026-11-11T05:00:00.000Z', null)).toContain(`SELECT ${MEETING_EVENT_COLUMN_LIST}`);
  });
});
