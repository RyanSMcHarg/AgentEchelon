/**
 * ROUND TWO IS MEASURED FROM THE INSTANT IT WAS TRIGGERED.
 *
 * A battle's round-2 rebuttal has an end to end of its own: from the instant round two was triggered
 * to the rebuttal's final answer. The battle orchestrator declares that instant as the turn's
 * `trigger_at` (the carrier migration 034 established), and every reader computes the figure from it:
 *
 *   - the turn ledger, `v_turn_latency.e2e_ms`, which the Latency tab reads (migration 071);
 *   - the exchange's second opinion, `exchanges.e2e_ms`, written by three archival statements through
 *     one expression, `exchangeE2eSql`.
 *
 * Neither ever measures a later round from the person's message: that is the message the duel began
 * from, so a span from it covers both rounds. A round-2 row with no declared instant has no end to end
 * rather than that span, which is the protection migration 064 introduced and 071 keeps.
 *
 * The headline E2E describes a person's wait, so it leaves round two out; the rebuttal row of the
 * per-interaction breakdown is where round two's figure is read.
 *
 * The orchestrator half (which instant is declared) is pinned in battle-orchestrator.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  batchInsert: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { backfillFromUpdateEvents, exchangeE2eSql } from '../../lambda/src/analytics-aurora/kinesis-archival';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const SCHEMA = path.join(SRC, 'schema');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** SQL with its comment lines removed, so a word in an explanation cannot satisfy or fail a check. */
const sqlOnly = (s: string): string => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

const M064 = read(path.join(SCHEMA, '064-a-rebuttal-is-not-an-answer-to-the-person.sql'));
const M071 = read(path.join(SCHEMA, '071-round-two-is-measured-from-its-own-trigger.sql'));
const ARCHIVAL = read(path.join(SRC, 'kinesis-archival.ts'));
const QUERY = read(path.join(SRC, 'analytics-query.ts'));
const BACKFILL = read(path.join(SRC, 'turn-events-backfill.ts'));

const VIEW_START = 'CREATE OR REPLACE VIEW v_turn_latency AS';
const viewOf = (m: string): string => m.slice(m.indexOf(VIEW_START), m.indexOf(') trg ON TRUE;', m.indexOf(VIEW_START)) + ') trg ON TRUE;'.length);
/** One column's expression in a view body: from the line that opens it to its `AS <name>`. */
function columnExpr(view: string, name: string, opener: string): string {
  const end = view.indexOf(`AS ${name},`);
  expect(end).toBeGreaterThan(-1);
  const start = view.lastIndexOf(opener, end);
  expect(start).toBeGreaterThan(-1);
  return view.slice(start, end);
}

describe('the exchange end to end is one rule, written once', () => {
  const rendered = flat(exchangeE2eSql({ round: 'ROUND_COL', finalAt: 'FINAL_AT', triggerAt: 'TRIGGER_AT', userAt: 'USER_AT' }));

  it('measures a later round from its declared trigger to the final answer, and nothing else', () => {
    expect(rendered).toBe(flat(`
      CASE WHEN COALESCE(ROUND_COL, 1) > 1
           THEN CASE WHEN TRIGGER_AT IS NOT NULL AND FINAL_AT > TRIGGER_AT
                     THEN (EXTRACT(EPOCH FROM (FINAL_AT - TRIGGER_AT)) * 1000)::integer
                END
           WHEN FINAL_AT IS NOT NULL AND FINAL_AT > USER_AT
           THEN (EXTRACT(EPOCH FROM (FINAL_AT - USER_AT)) * 1000)::integer
      END`));
  });

  it('gives a later round with no declared trigger NULL, never a span from the person\'s message', () => {
    // The round branch is taken first and has no ELSE, so a missing trigger cannot fall through to the
    // person branch. A first round (or an ordinary turn, whose round is NULL) never reaches it.
    const roundBranch = rendered.slice(rendered.indexOf('THEN CASE'), rendered.indexOf('END', rendered.indexOf('THEN CASE')));
    expect(roundBranch).not.toContain('USER_AT');
    expect(roundBranch).not.toContain('ELSE');
    expect(rendered.indexOf('COALESCE(ROUND_COL, 1) > 1')).toBeLessThan(rendered.indexOf('FINAL_AT > USER_AT'));
  });

  it('is the expression all three exchange writers use, so none of them can drift', () => {
    expect(ARCHIVAL.match(/\$\{exchangeE2eSql\(\{/g)).toHaveLength(3);
    // In-batch pairer, sweep and fold, each with the user instant it holds.
    expect(ARCHIVAL).toContain("userAt: 'um.created_at' })}");
    expect(ARCHIVAL).toContain("userAt: 'ex.user_message_at',");
  });

  it('withholds the reply time on a later round in the in-batch pairer too, as the sweep does', () => {
    expect(ARCHIVAL).toContain(
      'CASE WHEN COALESCE(am.battle_round, 1) > 1 THEN NULL\n'
      + '                    ELSE EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000 END,',
    );
  });
});

describe('the update fold measures round two from its trigger', () => {
  const mockedQuery = query as jest.MockedFunction<typeof query>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  async function foldSql(): Promise<string> {
    await backfillFromUpdateEvents([{
      event_type: 'UPDATE_CHANNEL_MESSAGE',
      message_id: 'r2-UPD',
      channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
      content: 'My rebuttal.',
      is_bot: true,
      resp_phase: 'final',
      battle_round: 2,
      trigger_at: '2026-10-01T10:00:09.500Z',
      created_at: '2026-10-01T10:00:10.000Z',
      last_updated_at: '2026-10-01T10:00:19.500Z',
    } as any]);
    const call = mockedQuery.mock.calls.find(([sql]) => /UPDATE exchanges/.test(sql as string));
    expect(call).toBeDefined();
    return call![0] as string;
  }

  it('derives e2e_ms through the shared rule, with the trigger the UPDATE before it folded', async () => {
    const sql = flat(await foldSql());
    expect(sql).toContain(flat(`e2e_ms = COALESCE(CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL
                                                       ELSE ex.e2e_ms END, ${exchangeE2eSql({
      round: 'COALESCE(ex.battle_round, am.battle_round)',
      finalAt: 'am.agent_final_at',
      triggerAt: 'am.trigger_at',
      userAt: 'ex.user_message_at',
    })})`));
  });

  it('recomputes a later round rather than freezing what an earlier writer stored', async () => {
    // During a deploy an older build can fold a round-2 exchange by the old rule. The stored value is
    // ignored on a later round, so the next fold overwrites it with the trigger-anchored rule; a first
    // round keeps its first completion.
    const sql = flat(sqlOnly(await foldSql()));
    expect(sql).not.toContain('e2e_ms = COALESCE(ex.e2e_ms,');
    expect(sql).toContain('e2e_ms = COALESCE(CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL ELSE ex.e2e_ms END,');
  });

  it('clears the reply time on a later round, the third column migration 071 repairs', async () => {
    const sql = flat(sqlOnly(await foldSql()));
    expect(sql).toContain(
      'response_latency_ms = CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL ELSE ex.response_latency_ms END',
    );
  });

  it('folds the declared trigger onto the answer before the exchange reads it', async () => {
    await foldSql();
    const msgIdx = mockedQuery.mock.calls.findIndex(([sql]) => /UPDATE messages\s+SET updated_content/.test(sql as string));
    const exIdx = mockedQuery.mock.calls.findIndex(([sql]) => /UPDATE exchanges/.test(sql as string));
    expect(msgIdx).toBeGreaterThan(-1);
    expect(msgIdx).toBeLessThan(exIdx);
    expect(mockedQuery.mock.calls[msgIdx][0]).toMatch(/trigger_at\s*=\s*COALESCE\(\$23::timestamptz, trigger_at\)/);
    expect(mockedQuery.mock.calls[msgIdx][1]![22]).toBe('2026-10-01T10:00:09.500Z');
  });

  it('writes inbound_ms NULL on a later round, since that span covers round one, clearing any stored value', async () => {
    const sql = flat(sqlOnly(await foldSql()));
    expect(sql).toContain(
      'inbound_ms = CASE WHEN COALESCE(ex.battle_round, am.battle_round, 1) > 1 THEN NULL ELSE COALESCE(ex.inbound_ms, CASE WHEN $16::bigint IS NOT NULL',
    );
    expect(sql).not.toContain('inbound_ms = COALESCE(ex.inbound_ms,');
  });
});

describe('migration 071: the ledger measures round two from its declared trigger', () => {
  const view = viewOf(M071);

  it('measures a later round\'s e2e_ms from trigger_at to the final answer, before any person anchor', () => {
    const e2e = flat(columnExpr(view, 'e2e_ms', '    CASE WHEN COALESCE(r.battle_round, 1) > 1'));
    expect(e2e).toBe(flat(`
      CASE WHEN COALESCE(r.battle_round, 1) > 1
           THEN CASE WHEN m.trigger_at IS NOT NULL
                          AND r.t3_final_at >= m.trigger_at
                     THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END
           WHEN COALESCE(a.t0_user_at, e.user_message_at) IS NOT NULL
                AND r.t3_final_at >= COALESCE(a.t0_user_at, e.user_message_at)
           THEN (EXTRACT(EPOCH FROM (r.t3_final_at - COALESCE(a.t0_user_at, e.user_message_at))) * 1000)::integer END`));
  });

  it('gives a round-2 row with no declared trigger no end to end, rather than a span from the person', () => {
    // The inner CASE has no ELSE and names no person instant, so it cannot fall through.
    const e2e = sqlOnly(columnExpr(view, 'e2e_ms', '    CASE WHEN COALESCE(r.battle_round, 1) > 1'));
    const inner = e2e.slice(e2e.indexOf('THEN CASE'), e2e.indexOf('END', e2e.indexOf('THEN CASE')));
    expect(inner).not.toContain('user_message_at');
    expect(inner).not.toContain('t0_user_at');
    expect(inner).not.toContain('ELSE');
  });

  it('keeps the 064 guard in the anchor lateral, so the person anchor is never a round-2 row\'s', () => {
    const queuedAt = view.indexOf('AND ex.queued_as IS NULL');
    const roundAt = view.indexOf('AND COALESCE(ex.battle_round, 1) <= 1');
    expect(queuedAt).toBeGreaterThan(-1);
    expect(roundAt).toBeGreaterThan(queuedAt);
    expect(roundAt).toBeLessThan(view.indexOf(') e ON TRUE', queuedAt));
  });

  it('never reports a later round as a person\'s wait', () => {
    const ttff = sqlOnly(columnExpr(view, 'ttff_ms', "    CASE WHEN COALESCE(r.trigger_kind, 'user')"));
    expect(ttff).toContain('AND COALESCE(r.battle_round, 1) <= 1');
  });

  it('carries the same end to end into unattributed_ms', () => {
    const residual = flat(sqlOnly(view.slice(view.indexOf('(CASE WHEN COALESCE(r.battle_round, 1) > 1'), view.indexOf('AS unattributed_ms'))));
    expect(residual).toContain('THEN CASE WHEN m.trigger_at IS NOT NULL AND r.t3_final_at IS NOT NULL THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END');
  });

  it('is the 064 view with exactly those changes: generated, not retyped', () => {
    // Undo the three declared changes and the result must be 064's body to the byte. Any other edit,
    // including a dropped column or a transcription slip, fails here.
    const P = 'COALESCE(a.t0_user_at, e.user_message_at)';
    let undone = viewOf(M071);
    const undo = (from: string, to: string) => {
      expect(undone.split(from).length - 1).toBe(1);
      undone = undone.replace(from, to);
    };
    undo(
      "              -- A LATER DUEL ROUND IS NEVER A PERSON'S WAIT (071), whatever kind it declared or failed\n"
      + '              -- to declare.\n'
      + '              AND COALESCE(r.battle_round, 1) <= 1\n',
      '',
    );
    undo(
      '    -- ROUND TWO IS MEASURED FROM THE INSTANT IT WAS TRIGGERED (071). The orchestrator declares that\n'
      + "    -- instant as trigger_at; the person's message is never this row's start, and with no declared\n"
      + '    -- instant the figure is NULL rather than a span covering both rounds.\n'
      + '    CASE WHEN COALESCE(r.battle_round, 1) > 1\n'
      + '         THEN CASE WHEN m.trigger_at IS NOT NULL\n'
      + '                        AND r.t3_final_at >= m.trigger_at\n'
      + '                   THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END\n'
      + `         WHEN ${P} IS NOT NULL\n`,
      `    CASE WHEN ${P} IS NOT NULL\n`,
    );
    undo(
      '    -- The same end to end as above, round two included, less what the brackets claim.\n'
      + '    (CASE WHEN COALESCE(r.battle_round, 1) > 1\n'
      + '          THEN CASE WHEN m.trigger_at IS NOT NULL AND r.t3_final_at IS NOT NULL\n'
      + '                    THEN (EXTRACT(EPOCH FROM (r.t3_final_at - m.trigger_at)) * 1000)::integer END\n'
      + `          WHEN ${P} IS NOT NULL AND r.t3_final_at IS NOT NULL\n`,
      `    (CASE WHEN ${P} IS NOT NULL AND r.t3_final_at IS NOT NULL\n`,
    );
    undo("PAIRING EITHER (064, kept by 071),", "PAIRING EITHER (064),");
    expect(undone).toBe(viewOf(M064));
  });

  describe('the exchange repair', () => {
    const repair = flat(sqlOnly(M071.slice(M071.indexOf('DO $repair$'))));
    const rule = flat(exchangeE2eSql({ round: '2', finalAt: 'am.agent_final_at', triggerAt: 'am.trigger_at', userAt: 'unused' }));
    // The round branch of the archival rule, as the repair writes it.
    const roundBranch = rule.slice(rule.indexOf('CASE WHEN am.trigger_at'), rule.indexOf('END', rule.indexOf('CASE WHEN am.trigger_at')) + 3);
    // The candidate predicate, written once for the batch and once for the count of what is left.
    const candidates = 'FROM exchanges ex JOIN messages am ON am.id = ex.agent_message_id'
      + ' WHERE ex.battle_id IS NOT NULL'
      + ' AND COALESCE(ex.battle_round, am.battle_round, 1) > 1'
      + ` AND (ex.e2e_ms IS DISTINCT FROM ${roundBranch} OR ex.inbound_ms IS NOT NULL OR ex.response_latency_ms IS NOT NULL)`;

    it('recomputes round-2 exchange rows by the archival rule', () => {
      expect(repair).toContain(`SET e2e_ms = ${roundBranch}, inbound_ms = NULL, response_latency_ms = NULL`);
    });

    it('is the only exchange write in the file, and it is the bounded one', () => {
      expect(sqlOnly(M071).match(/UPDATE exchanges/g)).toHaveLength(1);
      expect(repair).toContain('UPDATE exchanges tgt');
    });

    it('reads duel rows only, through the partial index 057 built, never a join of every exchange', () => {
      // `ex.battle_id IS NOT NULL` is the predicate of idx_exchanges_battle_id_created.
      const m057 = flat(read(path.join(SCHEMA, '057-a-duel-is-a-thing-you-can-join-on.sql')));
      expect(m057).toContain('CREATE INDEX IF NOT EXISTS idx_exchanges_battle_id_created ON exchanges(battle_id, created_at DESC) WHERE battle_id IS NOT NULL;');
      expect(repair).toContain(`SELECT ex.ctid ${candidates} LIMIT batch_size`);
    });

    it('converts one bounded batch per application', () => {
      expect(repair).toContain('batch_size CONSTANT integer := 5000;');
      expect(repair).toContain('AND tgt.ctid IN ( SELECT ex.ctid');
    });

    it('reports what is left by the same predicate, so the runner keeps the file pending until it converges', () => {
      // Writes only rows that differ, so a converged repair counts zero and a second application changes
      // nothing.
      expect(repair).toContain(`SELECT COUNT(*) INTO left_to_do ${candidates};`);
      expect(repair).toContain(
        "INSERT INTO _migration_progress (filename, remaining, updated_at) VALUES ('071-round-two-is-measured-from-its-own-trigger.sql', left_to_do, NOW())"
        + ' ON CONFLICT (filename) DO UPDATE SET remaining = EXCLUDED.remaining, updated_at = NOW();',
      );
      expect(repair.indexOf('UPDATE exchanges tgt')).toBeLessThan(repair.indexOf('SELECT COUNT(*) INTO left_to_do'));
    });
  });

  it('is idempotent and transaction-safe', () => {
    expect(M071).toContain(VIEW_START);
    expect(sqlOnly(M071)).not.toContain('CONCURRENTLY');
    expect(M071.trimEnd().endsWith(';')).toBe(true);
  });

  it('is the view in force: no later migration redefines v_turn_latency without the round-two rule', () => {
    const files = fs.readdirSync(SCHEMA).filter((f) => f.endsWith('.sql')).sort();
    const latest = files.filter((f) => read(path.join(SCHEMA, f)).includes(VIEW_START)).pop()!;
    const body = flat(sqlOnly(viewOf(read(path.join(SCHEMA, latest)))));
    expect(body).toContain('CASE WHEN COALESCE(r.battle_round, 1) > 1 THEN CASE WHEN m.trigger_at IS NOT NULL AND r.t3_final_at >= m.trigger_at');
  });
});

describe('who reads round two', () => {
  it('keeps round two out of the headline E2E, which describes a person\'s wait', () => {
    const f = flat(QUERY);
    expect(f).toContain('ROUND(AVG(vl.e2e_ms) FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)) AS avg_e2e_ms');
    expect(f).toContain(
      'ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vl.e2e_ms) FILTER (WHERE COALESCE(vl.battle_round, 1) <= 1)) AS p95_e2e_ms',
    );
  });

  describe('the per-interaction breakdown', () => {
    const start = QUERY.indexOf('async function getLatencyByInteraction');
    const fn = QUERY.slice(start, QUERY.indexOf('\n}\n', start));
    const bucket = "CASE WHEN COALESCE(battle_round, 1) > 1 THEN 'rebuttal' ELSE COALESCE(trigger_kind, 'user') END";

    it('reads round two\'s end to end from the ledger', () => {
      expect(fn).toContain('ROUND(AVG(e2e_ms)) AS avg_e2e_ms');
      expect(fn).toContain('FROM v_turn_latency');
    });

    it('makes the rebuttal row exactly battle round 2, whatever kind a round-2 row declared', () => {
      // A round-2 turn that declared no kind (or another kind) would otherwise land in the user row and
      // pool a rebuttal into a person's wait.
      const sql = flat(sqlOnly(fn));
      expect(sql).toContain(`${bucket} AS interaction`);
      // Grouped by the same expression, so the label and the group cannot disagree.
      expect(sql).toContain(`GROUP BY ${bucket}`);
      expect(sql).not.toContain("GROUP BY COALESCE(trigger_kind, 'user')");
      // The round is a column of the view this reads, so the bucket is computable there.
      expect(flat(viewOf(M071))).toContain('r.battle_round,');
    });
  });

  it('never binds the person\'s message to a round-2 turn in the ledger backfill', () => {
    const start = BACKFILL.indexOf("'user_message',");
    const stmt = BACKFILL.slice(start, BACKFILL.indexOf('ON CONFLICT', start));
    expect(stmt).toContain('AND COALESCE(e.battle_round, 1) <= 1');
  });
});
