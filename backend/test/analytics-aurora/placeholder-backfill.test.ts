/**
 * placeholder-backfill — one-time historical reconciliation unit tests.
 *
 * Pins the contract that the backfill:
 *   - patches CREATE message rows from their `-UPD` rows (COALESCE-guarded);
 *   - patches exchanges' intent from the `-UPD` row's metadata;
 *   - only clears exchange evaluations when explicitly asked (destructive/opt-in);
 *   - reports the affected-row counts from each statement.
 */

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { backfillPlaceholders } from '../../lambda/src/analytics-aurora/placeholder-backfill';

const mockedQuery = query as jest.MockedFunction<typeof query>;

describe('placeholder-backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('patches messages + exchanges and reports counts; no eval delete by default', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 42 } as any) // messages
      .mockResolvedValueOnce({ rows: [], rowCount: 37 } as any); // exchanges

    const result = await backfillPlaceholders();

    expect(result).toEqual({
      messagesPatched: 42,
      exchangesPatched: 37,
      evaluationsCleared: 0,
    });
    expect(mockedQuery).toHaveBeenCalledTimes(2);

    const [msgSql] = mockedQuery.mock.calls[0] as [string];
    expect(msgSql).toMatch(/UPDATE messages c/);
    expect(msgSql).toMatch(/u\.message_id = c\.message_id \|\| '-UPD'/);
    expect(msgSql).toMatch(/updated_content\s*=\s*COALESCE\(c\.updated_content, u\.content\)/);

    const [exSql] = mockedQuery.mock.calls[1] as [string];
    expect(exSql).toMatch(/UPDATE exchanges ex/);
    expect(exSql).toMatch(/intent\s*=\s*COALESCE\(ex\.intent, u\.metadata->>'intent'\)/);
    expect(exSql).toMatch(/ex\.agent_message_id = c\.id/);
  });

  it('clears exchange evaluations only when resetExchangeEvaluations is set', async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 5 } as any) // messages
      .mockResolvedValueOnce({ rows: [], rowCount: 5 } as any) // exchanges
      .mockResolvedValueOnce({ rows: [], rowCount: 7 } as any); // delete evals

    const result = await backfillPlaceholders({ resetExchangeEvaluations: true });

    expect(result.evaluationsCleared).toBe(7);
    expect(mockedQuery).toHaveBeenCalledTimes(3);
    const [delSql] = mockedQuery.mock.calls[2] as [string];
    expect(delSql).toMatch(/DELETE FROM evaluation_results WHERE evaluation_type = 'exchange'/);
  });
});
