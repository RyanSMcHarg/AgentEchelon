/**
 * client-events-ingest — Aurora ingest for client-side events (#A).
 * Pins the multi-row INSERT shape and the NormalizedEvent → client_events mapping
 * (user_id→user_sub, timestamp→created_at, analytics fields → event_data JSONB).
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn() }));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { ingestClientEvents, type ClientEventRecord } from '../../lambda/src/analytics-aurora/client-events-ingest';

const mockedQuery = query as jest.MockedFunction<typeof query>;

const rec = (over: Partial<ClientEventRecord> = {}): ClientEventRecord => ({
  record_type: 'event', event_type: 'session_start', user_id: 'u1', user_email: 'a@b.c',
  user_tier: 'premium', session_id: 's1', timestamp: '2026-07-15T00:00:00Z',
  properties: { page: 'home' }, perf_value: null, ...over,
});

describe('ingestClientEvents', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no-ops on empty input', async () => {
    expect(await ingestClientEvents([])).toEqual({ inserted: 0 });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('bulk-inserts with the right columns and event_data mapping', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 } as any);
    const out = await ingestClientEvents([rec(), rec({ record_type: 'performance', event_type: 'LCP', perf_value: 1234, properties: null, session_id: 's2', user_id: 'u2' })]);
    expect(out).toEqual({ inserted: 2 });

    const [sql, params] = mockedQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO client_events \(event_type, session_id, user_sub, event_data, created_at\)/);
    expect(sql).toMatch(/\$4::jsonb/); // two rows → $4 and $9
    expect(sql).toMatch(/\$9::jsonb/);
    // row 1: event_type, session_id, user_sub(user_id), event_data, created_at(timestamp)
    expect(params.slice(0, 5)).toEqual(['session_start', 's1', 'u1', expect.any(String), '2026-07-15T00:00:00Z']);
    expect(JSON.parse(params[3] as string)).toEqual({ record_type: 'event', user_email: 'a@b.c', user_tier: 'premium', perf_value: null, properties: { page: 'home' } });
    // row 2: performance, user_sub u2, perf_value in event_data, null properties → {}
    expect(params[7]).toBe('u2');
    expect(JSON.parse(params[8] as string)).toMatchObject({ record_type: 'performance', perf_value: 1234, properties: {} });
  });
});
