/**
 * THE DATA PLANE'S `erasePerson` (analytics-aurora/person-erasure.ts): offboarding's reach into the Aurora
 * projection, through the existing seam. The person's own rows go, in one transaction, by `person_id`; the
 * conversation's record (messages, exchanges, client events, drift events) is kept as the archive is.
 */
const mockClientQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  transaction: jest.fn(async (fn: (c: { query: typeof mockClientQuery }) => Promise<unknown>) => fn({ query: mockClientQuery })),
  ensureSchema: jest.fn(async () => undefined),
}));

import { erasePersonProjection, PERSON_OWN, PERSON_OWN_TABLES, PERSON_KEPT_TABLES } from '../../lambda/src/analytics-aurora/person-erasure';

beforeEach(() => mockClientQuery.mockReset());

describe('erasePerson', () => {
  it('deletes the person\'s own rows from each of their tables, by the column that names them, and counts them', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => ({
      rowCount: sql.includes('channel_membership') ? 3 : sql.includes('cross_conversation_context') ? 2 : sql.includes('meeting_events') ? 4 : 0,
    }));
    const res = await erasePersonProjection({ personId: 'person-1' });
    expect(res).toEqual({ removed: 9, byTable: { channel_membership: 3, conversation_creation_tasks: 0, cross_conversation_context: 2, meeting_events: 4 } });
    expect(PERSON_OWN_TABLES).toEqual(['channel_membership', 'conversation_creation_tasks', 'cross_conversation_context', 'meeting_events']);
    expect(mockClientQuery.mock.calls.map(([sql, params]) => [sql, params])).toEqual([
      ['DELETE FROM channel_membership WHERE person_id = $1', ['person-1']],
      ['DELETE FROM conversation_creation_tasks WHERE person_id = $1', ['person-1']],
      // THE BOUNDED TABLES ARE DELETED AS THE WRITER ROLE, the only identity their row-level security lets delete a row.
      ['SET LOCAL ROLE ae_writer', undefined],
      ['DELETE FROM cross_conversation_context WHERE person_id = $1', ['person-1']],
      ['DELETE FROM meeting_events WHERE person_key = $1', ['person-1']],
    ]);
  });

  it('erases every bounded table that names a person, so none is left to the database to refuse silently', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BOUNDED_TABLES } = require('../../lambda/src/analytics-aurora/classification-boundary-sql') as typeof import('../../lambda/src/analytics-aurora/classification-boundary-sql');
    expect(PERSON_OWN.filter((t) => t.bounded).map((t) => t.table).every((t) => (BOUNDED_TABLES as readonly string[]).includes(t))).toBe(true);
    expect(PERSON_OWN.filter((t) => !t.bounded).map((t) => t.table).some((t) => (BOUNDED_TABLES as readonly string[]).includes(t))).toBe(false);
  });

  it('never touches the conversation\'s record', async () => {
    mockClientQuery.mockResolvedValue({ rowCount: 0 });
    await erasePersonProjection({ personId: 'person-1' });
    const sql = mockClientQuery.mock.calls.map(([s]) => s).join('\n');
    for (const kept of PERSON_KEPT_TABLES) expect(sql).not.toMatch(new RegExp(`\\b${kept}\\b`));
  });

  it('refuses a missing or malformed person id, before any statement', async () => {
    for (const personId of [undefined, '', '   ', '%', 'a b', 'x'.repeat(129)]) {
      await expect(erasePersonProjection({ personId })).rejects.toThrow(/person id/);
    }
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('is dispatched by the data plane', async () => {
    jest.resetModules();
    jest.doMock('../../lambda/src/analytics-aurora/turn-data-plane-binding', () => ({ bindTurnRequest: async (r: unknown) => r }));
    const erase = jest.fn(async () => ({ removed: 1, byTable: {} }));
    jest.doMock('../../lambda/src/analytics-aurora/person-erasure', () => ({ erasePersonProjection: erase }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { handler } = require('../../lambda/src/analytics-aurora/data-plane-handler');
    expect(await handler({ op: 'erasePerson', input: { personId: 'person-1' } })).toEqual({ removed: 1, byTable: {} });
    expect(erase).toHaveBeenCalledWith({ personId: 'person-1' });
  });
});
