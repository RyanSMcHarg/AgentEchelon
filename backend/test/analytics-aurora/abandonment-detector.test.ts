/**
 * abandonment-detector — scheduled Lambda that retroactively writes
 * `outcome='abandoned'` to drift_events where the user accepted a
 * suggestion but never engaged in the new channel.
 *
 * Tests pin:
 *
 *   1. Empty candidate set → returns { checked: 0, abandoned: 0 }.
 *   2. Candidate with no user messages in the new channel → marked
 *      `abandoned`.
 *   3. Candidate with user messages in the new channel → marked
 *      `accepted` (idempotent fix-up of a missed synchronous write).
 *   4. Per-row failures don't poison the whole batch.
 *   5. The candidate query uses the configured ABANDONMENT_WINDOW_MIN
 *      and BATCH_LIMIT.
 */

import type { QueryResult, QueryResultRow } from 'pg';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';

const mockedQuery = query as jest.MockedFunction<typeof query>;

function mockRows<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] as never } as QueryResult<T>;
}

const CHANNEL_PARENT = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/parent';
const CHANNEL_NEW_A = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/new-a';
const CHANNEL_NEW_B = 'arn:aws:chime:us-east-1:1:app-instance/test/channel/new-b';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DB_HOST = 'localhost';
  process.env.DB_NAME = 'analytics';
  process.env.DB_USER = 'testuser';
  process.env.DB_REGION = 'us-east-1';
  delete process.env.ABANDONMENT_WINDOW_MIN;
  delete process.env.ABANDONMENT_BATCH_LIMIT;
});

describe('abandonment-detector handler', () => {
  it('no candidates → returns { checked: 0, abandoned: 0 }', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string; parent_channel_arn: string; new_channel_arn: string }>([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    const result = await handler();
    expect(result).toEqual({ checked: 0, abandoned: 0 });
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('marks a candidate abandoned when its new channel has zero user messages', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          { event_id: 'e-1', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_A },
        ]),
      )
      .mockResolvedValueOnce(mockRows([{ count: '0' }])) // countNonBotMessages
      .mockResolvedValueOnce(mockRows([])); // UPDATE drift_events

    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    const result = await handler();

    expect(result).toEqual({ checked: 1, abandoned: 1 });

    // 3rd query is the UPDATE → outcome='abandoned'
    const [updateSql, updateParams] = mockedQuery.mock.calls[2];
    expect(updateSql).toMatch(/UPDATE drift_events/);
    expect(updateSql).toMatch(/SET outcome = 'abandoned'/);
    expect(updateParams).toEqual(['e-1']);
  });

  it('marks a candidate accepted (NOT abandoned) when the new channel has user activity', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          { event_id: 'e-2', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_A },
        ]),
      )
      .mockResolvedValueOnce(mockRows([{ count: '3' }])) // 3 user messages → real engagement
      .mockResolvedValueOnce(mockRows([])); // UPDATE drift_events

    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    const result = await handler();

    expect(result).toEqual({ checked: 1, abandoned: 0 });

    const [updateSql, updateParams] = mockedQuery.mock.calls[2];
    expect(updateSql).toMatch(/SET outcome = 'accepted'/);
    expect(updateParams).toEqual(['e-2']);
  });

  it('processes a mixed batch: some abandoned, some accepted, some failures', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          { event_id: 'e-1', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_A },
          { event_id: 'e-2', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_B },
          { event_id: 'e-3', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: 'arn:invalid' },
        ]),
      )
      // e-1: abandoned
      .mockResolvedValueOnce(mockRows([{ count: '0' }]))
      .mockResolvedValueOnce(mockRows([]))
      // e-2: accepted (5 user messages)
      .mockResolvedValueOnce(mockRows([{ count: '5' }]))
      .mockResolvedValueOnce(mockRows([]))
      // e-3: count query throws — single-row failure must not poison the batch
      .mockRejectedValueOnce(new Error('connection blip'));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    const result = await handler();
    warnSpy.mockRestore();

    expect(result).toEqual({ checked: 3, abandoned: 1 });
  });

  it('passes the default window (5 min) + batch limit (100) to the candidate query', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string; parent_channel_arn: string; new_channel_arn: string }>([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    await handler();

    const [, params] = mockedQuery.mock.calls[0];
    expect(params).toEqual(['5', 100]);
  });

  it('candidate query filters on outcome IS NULL AND new_channel_arn IS NOT NULL', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string; parent_channel_arn: string; new_channel_arn: string }>([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    await handler();

    const [sql] = mockedQuery.mock.calls[0];
    expect(sql).toMatch(/outcome IS NULL/);
    expect(sql).toMatch(/new_channel_arn IS NOT NULL/);
    // And the time threshold.
    expect(sql).toMatch(/occurred_at < NOW\(\) - /);
  });

  it('countNonBotMessages query filters on is_bot = FALSE', async () => {
    mockedQuery
      .mockResolvedValueOnce(
        mockRows([
          { event_id: 'e-1', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_A },
        ]),
      )
      .mockResolvedValueOnce(mockRows([{ count: '0' }]))
      .mockResolvedValueOnce(mockRows([]));

    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    await handler();

    const [countSql, countParams] = mockedQuery.mock.calls[1];
    expect(countSql).toMatch(/FROM messages/);
    expect(countSql).toMatch(/is_bot = FALSE/);
    expect(countParams).toEqual([CHANNEL_NEW_A]);
  });
});
