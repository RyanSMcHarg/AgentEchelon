/**
 * turn-events-backfill — the ledger's historical seed, and the rollout's go/no-go query.
 *
 * Pins the properties that make the backfill safe to run against a live cluster:
 *   - every insert is idempotent, so re-running converges instead of duplicating;
 *   - a placeholder is identified by the correlation marker, which is what DEFINES one;
 *   - the turn id is recorded as `declared` where it genuinely is, and `paired` where it is derived;
 *   - an assistant-initiated response is marked `system`, so it cannot contribute a meaningless TTFF;
 *   - the window is bounded and clamped;
 *   - the comparison reports disagreements rather than summarising them away.
 */

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import {
  backfillTurnEvents,
  compareLatencyDerivations,
} from '../../lambda/src/analytics-aurora/turn-events-backfill';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const sqlOf = (call: number) => String(mockedQuery.mock.calls[call][0]);
const allSql = () => mockedQuery.mock.calls.map((c) => String(c[0])).join('\n---\n');

describe('backfillTurnEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 4 } as any)  // placeholders
      .mockResolvedValueOnce({ rows: [], rowCount: 3 } as any)  // user messages
      .mockResolvedValueOnce({ rows: [], rowCount: 2 } as any)  // finals
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // moderation
  });

  it('reports the per-kind counts it actually inserted', async () => {
    const result = await backfillTurnEvents();
    expect(result).toEqual({
      placeholders: 4, userMessages: 3, finalResponses: 2, moderations: 1,
    });
  });

  it('is idempotent on every insert — a re-run must converge, not duplicate', async () => {
    await backfillTurnEvents();
    for (let i = 0; i < 4; i++) {
      // Idempotence, not necessarily DO NOTHING: the user_message pass upserts the turn_id binding
      // onto the anchor the LIVE writer already claimed (which honestly records turn_id NULL before
      // pairing exists), guarded by `WHERE turn_events.turn_id IS NULL` so a bound anchor is never
      // moved - converging, like the others. DO NOTHING there made the live row win and t0 stay
      // NULL for every live-archived turn.
      expect(sqlOf(i)).toMatch(/ON CONFLICT (DO NOTHING|\([^)]+\)\s+DO UPDATE SET turn_id = EXCLUDED\.turn_id\s+WHERE turn_events\.turn_id IS NULL)/);
    }
    // And exactly ONE pass is the binding upsert - the anchor pass. More would mean a second writer
    // started moving keys under the same license.
    const upserts = [0, 1, 2, 3].filter((i) => /DO UPDATE SET turn_id/.test(sqlOf(i)));
    expect(upserts).toHaveLength(1);
  });

  it('identifies a placeholder by the correlation marker, not by content shape', async () => {
    // A correlation id definitionally labels a placeholder, so this is a declared fact about the
    // row rather than a guess from its text.
    await backfillTurnEvents();
    expect(sqlOf(0)).toContain("'placeholder_posted'");
    expect(sqlOf(0)).toContain('<!--corr:([A-Za-z0-9._-]{1,64})-->');
    expect(sqlOf(0)).toContain("'declared'");
  });

  it('records the user-message binding as PAIRED, never as declared', async () => {
    // The processor is never handed the user's Chime MessageId, so this binding is derived. A join
    // key that is usually right is worse than one that admits it is derived.
    await backfillTurnEvents();
    expect(sqlOf(1)).toContain("'user_message'");
    expect(sqlOf(1)).toContain("'paired'");
    expect(sqlOf(1)).not.toContain("'declared'");
  });

  it('marks an assistant-initiated response as system-triggered', async () => {
    // A welcome, briefing or drift notice has no user message; TTFF must be NULL for it, and the
    // trigger is what carries that. Without this they would silently enter the TTFF average.
    await backfillTurnEvents();
    expect(sqlOf(0)).toMatch(/WHEN ex\.id IS NULL THEN 'system' ELSE 'user' END/);
  });

  it('takes the final answer instant from agent_final_at, attributed to the UPDATE event', async () => {
    await backfillTurnEvents();
    expect(sqlOf(2)).toContain("'final_response'");
    expect(sqlOf(2)).toContain('c.agent_final_at');
    expect(sqlOf(2)).toContain("'UPDATE_CHANNEL_MESSAGE'");
  });

  it('never writes message content into the ledger', async () => {
    // The privacy constraint has to hold at the WRITE site too, not only in the DDL: content is read
    // to extract an id, and only the id may be stored.
    await backfillTurnEvents();
    const sql = allSql();
    expect(sql).not.toMatch(/INSERT INTO turn_events[\s\S]*?\bcontent\b\s*\)/);
    expect(sql).not.toContain('updated_content');
    expect(sql).not.toContain('sender_name');
  });

  it('bounds and clamps the window', async () => {
    await backfillTurnEvents({ days: 5 });
    expect(mockedQuery.mock.calls[0][1]).toEqual([5, '<!--corr:']);

    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    await backfillTurnEvents({ days: 100000 });
    expect((mockedQuery.mock.calls[0][1] as unknown[])[0]).toBe(365);

    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    await backfillTurnEvents({ days: 0 });
    expect((mockedQuery.mock.calls[0][1] as unknown[])[0]).toBe(1);
  });
});

describe('compareLatencyDerivations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports the disagreements, not just a pass rate', async () => {
    // This is the rollout's go/no-go. A bare percentage would hide WHICH turns differ, which is the
    // only thing that makes a disagreement diagnosable.
    mockedQuery.mockResolvedValueOnce({
      rows: [
        { response_id: 'a', ledger_e2e_ms: 100, legacy_e2e_ms: 100 },
        { response_id: 'b', ledger_e2e_ms: 250, legacy_e2e_ms: 900 },
        { response_id: 'c', ledger_e2e_ms: null, legacy_e2e_ms: 300 },
      ],
      rowCount: 3,
    } as any);

    const res = await compareLatencyDerivations(14);

    expect(res.compared).toBe(3);
    expect(res.agreed).toBe(1);
    expect(res.disagreed.map((d) => d.response_id)).toEqual(['b', 'c']);
    expect(mockedQuery.mock.calls[0][1]).toEqual([14]);
  });

  it('treats a missing ledger value as a disagreement, not a match', async () => {
    // NULL == NULL is not agreement in SQL and must not be here either: a turn the ledger cannot
    // measure is exactly what the comparison exists to surface.
    mockedQuery.mockResolvedValueOnce({
      rows: [{ response_id: 'x', ledger_e2e_ms: null, legacy_e2e_ms: 500 }],
      rowCount: 1,
    } as any);

    const res = await compareLatencyDerivations();
    expect(res.agreed).toBe(0);
    expect(res.disagreed).toHaveLength(1);
  });
});
