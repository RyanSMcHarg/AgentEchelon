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
  ensureSchema: jest.fn(),
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
    mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string }>([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    const result = await handler();
    expect(result).toEqual({ checked: 0, abandoned: 0 });
    // TWO statements even with nothing to do: the candidate SELECT, and the unanswered-offer sweep.
    // The sweep is not conditional on the first having found something - the rows it closes are
    // precisely the ones the first query's `new_channel_arn IS NOT NULL` gate can never return.
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });

  /**
   * THE OFFERS NOBODY ANSWERED AT ALL, which could never reach a terminal state.
   *
   * The candidate query gates on `new_channel_arn IS NOT NULL`, because it asks whether a person who
   * ACCEPTED then engaged. An offer nobody answered creates no channel, so it never matched, kept
   * `outcome IS NULL` forever, and was counted in no outcome - present in the table and missing from
   * every rate computed over it, which flatters all of them.
   */
  describe('the unanswered-offer sweep', () => {
    const sweepCall = () => mockedQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE drift_events')
      && String(sql).includes('new_channel_arn IS NULL'));

    it('closes offers with no channel and no answer, and counts them', async () => {
      mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string; parent_channel_arn: string; new_channel_arn: string }>([]));
      mockedQuery.mockResolvedValueOnce(mockRows([{ event_id: 'e1' }, { event_id: 'e2' }]));

      const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
      expect(await handler()).toEqual({ checked: 0, abandoned: 2 });
    });

    it('is bounded and guards on the state it expects, so a late answer wins', async () => {
      mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string; parent_channel_arn: string; new_channel_arn: string }>([]));
      mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string }>([]));

      const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
      await handler();

      const [sql, params] = sweepCall()!;
      // The `outcome IS NULL` guard on the UPDATE itself, not only in the subquery: a person who
      // answers between the SELECT and the write keeps their own answer.
      expect(String(sql)).toMatch(/AND outcome IS NULL\s*$|AND outcome IS NULL\s*\n\s*RETURNING/);
      expect(String(sql)).toContain('LIMIT $2');
      // Hours, not the five MINUTES the first sweep uses - the two windows measure different things.
      expect(String(sql)).toContain("' hours')::interval");
      expect(params as unknown[]).toEqual(['24', 100]);
    });

    it('does not fail the run when the sweep itself errors', async () => {
      mockedQuery.mockResolvedValueOnce(mockRows<{ event_id: string; parent_channel_arn: string; new_channel_arn: string }>([]));
      mockedQuery.mockRejectedValueOnce(new Error('deadlock detected (simulated)'));

      const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
      // Best-effort, like the rest of this job: the next five-minute run reprocesses the same rows.
      expect(await handler()).toEqual({ checked: 0, abandoned: 0 });
    });
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

    // MESSAGES ONLY. A room the service admin created carries channel and membership rows sent by that
    // admin, with is_bot false; counted, they made every such room look used before anybody spoke.
    expect(String(mockedQuery.mock.calls[1][0])).toMatch(/event_type = 'CREATE_CHANNEL_MESSAGE'/);

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
    // No move time on this row, so the count is unbounded; a real row carries it (see below).
    expect(countParams).toEqual([CHANNEL_NEW_A, null]);
  });

  it('counts only messages since the move, so a redirect into an existing conversation is judged on what happened after it', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([{ event_id: 'e-r', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_A, moved_at: '2026-10-15T10:00:00Z' }]))
      .mockResolvedValueOnce(mockRows([{ count: '0' }]))
      .mockResolvedValueOnce(mockRows([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    await handler();
    const [countSql, countParams] = mockedQuery.mock.calls[1];
    expect(countSql).toContain('created_at >= $2::timestamptz');
    expect(countParams).toEqual([CHANNEL_NEW_A, '2026-10-15T10:00:00Z']);
  });

  it('closes only live offers nobody answered; an archival score has no answer to wait for', async () => {
    mockedQuery.mockResolvedValueOnce(mockRows([])).mockResolvedValueOnce(mockRows([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    await handler();
    const sweep = mockedQuery.mock.calls.map((c) => String(c[0])).find((q) => q.includes('new_channel_arn IS NULL'));
    expect(sweep).toContain("COALESCE(source, 'live') = 'live'");
  });
});

// A MOVE IS CHECKED ONCE, AND EVERY OUTCOME SAYS WHEN (migration 077). Accepting writes `accepted` at once, so
// reading only empty outcomes never saw a move and an unused new conversation was never recorded.
describe('accepted moves are checked for engagement, once', () => {
  it('reads unsettled moves, accepted ones included, and settles them with the time decided', async () => {
    mockedQuery
      .mockResolvedValueOnce(mockRows([{ event_id: 'e-m', parent_channel_arn: CHANNEL_PARENT, new_channel_arn: CHANNEL_NEW_A }]))
      .mockResolvedValueOnce(mockRows([{ count: '0' }]))
      .mockResolvedValueOnce(mockRows([]))
      .mockResolvedValueOnce(mockRows([]));
    const { handler } = await import('../../lambda/src/analytics-aurora/abandonment-detector');
    await handler();
    const [select] = mockedQuery.mock.calls[0] as [string];
    expect(select).toMatch(/engagement_settled = FALSE/);
    expect(select).toMatch(/outcome IS NULL OR outcome = 'accepted'/);
    const [update] = mockedQuery.mock.calls[2] as [string];
    expect(update).toMatch(/SET outcome = 'abandoned', outcome_at = NOW\(\), engagement_settled = TRUE/);
  });
});
