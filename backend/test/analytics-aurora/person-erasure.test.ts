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

import { erasePersonProjection, PERSON_OWN_TABLES, PERSON_KEPT_TABLES } from '../../lambda/src/analytics-aurora/person-erasure';

beforeEach(() => mockClientQuery.mockReset());

describe('erasePerson', () => {
  it('deletes the person\'s own rows from each of their tables, by person_id, and counts them', async () => {
    mockClientQuery.mockResolvedValueOnce({ rowCount: 2 }).mockResolvedValueOnce({ rowCount: 3 }).mockResolvedValueOnce({ rowCount: 0 });
    const res = await erasePersonProjection({ personId: 'person-1' });
    expect(res).toEqual({ removed: 5, byTable: { cross_conversation_context: 2, channel_membership: 3, conversation_creation_tasks: 0 } });
    expect(mockClientQuery.mock.calls.map(([sql, params]) => [sql, params])).toEqual(
      PERSON_OWN_TABLES.map((t) => [`DELETE FROM ${t} WHERE person_id = $1`, ['person-1']]),
    );
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
