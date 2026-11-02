/**
 * turn-events-backfill — the ledger's historical seed, and the rollout's go/no-go query.
 *
 * Pins the properties that make the backfill safe to run against a live cluster:
 *   - every insert is idempotent, so re-running converges instead of duplicating;
 *   - a placeholder is identified by the correlation marker, which is what DEFINES one;
 *   - the turn id is recorded as `declared` where it genuinely is, and `paired` where it is derived;
 *   - an assistant-initiated response is marked `system`, so it cannot contribute a meaningless TTFF;
 *   - the window is bounded and clamped;
 *   - the comparison reports disagreements rather than summarizing them away.
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
      // The target may contain an expression - migration 041's arbiter is an expression index - so
      // one level of nesting is allowed here. The previous pattern forbade it and would have failed
      // any correct naming of that index.
      expect(sqlOf(i)).toMatch(/ON CONFLICT (DO NOTHING|\((?:[^()]|\([^()]*\))+\)\s+DO UPDATE SET turn_id = EXCLUDED\.turn_id\s+WHERE turn_events\.turn_id IS NULL)/);
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

  it('writes the duel round the same way the live writer does', async () => {
    // `turn_events.battle_round` was declared end to end and written by nothing, so a round-1 duel
    // side was pooled with production traffic in every latency population. The two writers have to
    // agree or a backfilled window and a live window disagree about the same turn: both take the
    // round off the placeholder's own `<!--battle:-->` marker, both bound it to what the SMALLINT
    // column holds, and both put it on the placeholder row plus the close beside it.
    await backfillTurnEvents();
    for (const pass of [0, 2]) {
      expect(sqlOf(pass)).toContain('battle_round');
      expect(sqlOf(pass)).toContain("substring(c.content from '<!--battle:[^>]*?round=([0-9]{1,4})(?![0-9])')::smallint");
    }
    // And NOT on the anchor or the moderation rows: neither is a response, so neither has a round.
    // The anchor pass READS the exchange's round only to refuse binding a rebuttal to the person's
    // message (the rule migration 064 applies to the view's anchor lateral and 071 keeps), and writes
    // no round column.
    const anchorColumns = sqlOf(1).slice(0, sqlOf(1).indexOf('SELECT'));
    expect(anchorColumns).not.toContain('battle_round');
    expect(sqlOf(1)).toContain('AND COALESCE(e.battle_round, 1) <= 1');
    expect(sqlOf(3)).not.toContain('battle_round');
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
