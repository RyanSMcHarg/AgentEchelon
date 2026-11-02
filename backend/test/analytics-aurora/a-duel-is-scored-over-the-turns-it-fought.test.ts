/**
 * A DUEL IS SCORED OVER THE TURNS IT ACTUALLY FOUGHT.
 *
 * ── WHAT WAS WRONG (measured 2026-09-23, owner: "Don't we want analytics across the full battle") ─
 *
 * The pairing key was (turn, sender). That is right for a normal duel - two sides answering one
 * message, two exchanges - and it caps a MULTI-ROUND duel at two: a side's round-2 rebuttal answers
 * the same user message as its round-1 reply and comes from the same bot, so it collided with the
 * round-1 row and was dropped before anything downstream saw it.
 *
 * Measured over 30 days through the signed path: of 14 two-round duels only 3 recorded all four
 * turns, and one reported two rounds with a single turn and a single contender. Every battle figure
 * reads FROM exchanges - the scorecard, the per-side average, model attribution, the round count - so
 * a duel was being judged on a fraction of itself. Not a wrong number: a number over an unstated
 * population, which is the failure the rest of this surface spent the same day removing.
 *
 * ── THE TWO HALVES, AND WHY NEITHER SHIPS ALONE ─────────────────────────────────────────────────
 *
 * RECORD THE TURN. The round joins the key, and the cross-batch anti-join learns about it too -
 * without that second change the guard still asks "has this sender already answered this turn",
 * which a round-1 reply satisfies, and the rebuttal never becomes a candidate.
 *
 * AND WITHHOLD THE REPLY CLOCK. A round-2 row reports no reply time, and its end to end runs from the
 * instant round two was triggered rather than from the person's message (migration 071, pinned in
 * round-two-is-measured-from-its-own-trigger.test.ts).
 *
 * `exchanges.user_message_at` is NOT NULL, so a round-2 row carries the
 * ORIGINAL user message's instant - truthfully, that IS where the duel began. `v_turn_latency` falls
 * back to that instant when the ledger has no anchor, which every rebuttal lacks. So recording the
 * turn without migration 064 would start reporting rebuttals at a time to first feedback spanning
 * both rounds: minutes, on averages that measure seconds. That is a worse defect than the one being
 * fixed, which is why the guard is pinned here beside the key rather than left to a reviewer.
 */
import * as fs from 'fs';
import * as path from 'path';

const ARCHIVAL = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts');
const MIGRATION = path.join(
  __dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'schema',
  '064-a-rebuttal-is-not-an-answer-to-the-person.sql',
);

const archival = fs.readFileSync(ARCHIVAL, 'utf8');
const migration = fs.readFileSync(MIGRATION, 'utf8');

/** The sweep's pairing statement, so a clause from a neighbouring pass cannot satisfy these. */
function sweep(): string {
  const start = archival.indexOf('async function pairUnmatchedMessages');
  const end = archival.indexOf('ONE EXCHANGE PER QUEUED MESSAGE', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return archival.slice(start, end);
}

describe('the round is part of what makes a turn distinct', () => {
  it('keys the pairing on the round as well as the turn and the sender', () => {
    expect(sweep()).toContain(
      'SELECT DISTINCT ON (um.id, am.sender_arn, COALESCE(am_upd.battle_round, am.battle_round, 0))'
    );
  });

  it('orders on the same prefix, which Postgres requires of DISTINCT ON', () => {
    // Not cosmetic: a DISTINCT ON whose ORDER BY does not lead with its own key is a syntax error,
    // so this is the half that decides whether the statement runs at all.
    expect(sweep()).toContain(
      'ORDER BY um.id, am.sender_arn, COALESCE(am_upd.battle_round, am.battle_round, 0), am.created_at'
    );
  });

  it('teaches the cross-batch anti-join about the round too', () => {
    // Without this the key change does nothing: the anti-join eliminates the rebuttal as a candidate
    // before DISTINCT ON is reached, because a round-1 reply already answered this turn.
    expect(sweep()).toContain('AND COALESCE(am_prev.battle_round, 0) = COALESCE(am.battle_round, 0)');
  });

  it('leaves every non-battle turn on exactly the behaviour it had', () => {
    // COALESCE to 0 rather than leaving NULL in the key. NULLs are distinct from each other in a
    // DISTINCT ON, so a null round would make every ordinary turn its own group and mint duplicate
    // exchanges across the whole table - the widest possible blast radius from a battle-only change.
    const s = sweep();
    expect(s).toContain('COALESCE(am_upd.battle_round, am.battle_round, 0)');
    expect(s).not.toContain('DISTINCT ON (um.id, am.sender_arn, am_upd.battle_round)');
    expect(s).not.toContain('DISTINCT ON (um.id, am.sender_arn, am.battle_round)');
  });
});

describe('a rebuttal reports no reply time', () => {
  it('withholds response_latency_ms on a round past the first', () => {
    expect(sweep()).toContain(
      'CASE WHEN COALESCE(am_upd.battle_round, am.battle_round, 1) > 1 THEN NULL'
    );
    expect(sweep()).toContain('ELSE EXTRACT(EPOCH FROM (am.created_at - um.created_at)) * 1000 END,');
  });

  it('measures e2e_ms on a later round from its declared trigger, through the one shared rule', () => {
    // Round two's end to end runs from the instant it was triggered to its final answer (migration
    // 071). The sweep states the rule through exchangeE2eSql, the expression the in-batch pairer and
    // the update fold use too, with the round read the same way the key reads it.
    const s = sweep();
    expect(s).toContain('${exchangeE2eSql({');
    expect(s).toContain("round: 'COALESCE(am_upd.battle_round, am.battle_round)'");
    expect(s).toContain("triggerAt: 'COALESCE(am.trigger_at, am_upd.trigger_at)'");
    expect(s).toContain("userAt: 'um.created_at'");
    // And no hand-written span from the person's message survives beside it.
    expect(s).not.toContain('am.agent_final_at - um.created_at');
  });
});

describe('the turn ledger refuses a rebuttal as an anchor', () => {
  it('guards the anchor LATERAL beside the queued-exchange guard', () => {
    expect(migration).toContain('AND ex.queued_as IS NULL');
    expect(migration).toContain('AND COALESCE(ex.battle_round, 1) <= 1');
  });

  it('puts the round guard inside the ANCHOR lateral, not somewhere else in the view', () => {
    // The view has more than one reader of `exchanges`. Landing this guard in the wrong one would
    // leave the anchor unprotected while looking correct in a diff - the exact way a groundedness
    // column landed on the wrong subquery earlier the same day.
    const queuedAt = migration.indexOf('AND ex.queued_as IS NULL');
    const roundAt = migration.indexOf('AND COALESCE(ex.battle_round, 1) <= 1');
    const lateralEnd = migration.indexOf(') e ON TRUE', queuedAt);
    expect(roundAt).toBeGreaterThan(queuedAt);
    expect(roundAt).toBeLessThan(lateralEnd);
  });

  it('replaces the view rather than creating a second one', () => {
    expect(migration).toContain('CREATE OR REPLACE VIEW v_turn_latency AS');
    expect(migration.trimEnd().endsWith(';')).toBe(true);
    // SQL ONLY. The header says the words "no CONCURRENTLY" to explain the transaction-safety rule,
    // and a search over the whole file found its own documentation and called it a violation.
    const sql = migration.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(sql).not.toContain('CONCURRENTLY');
  });

  it('carries the whole view body, not a fragment', () => {
    // It is generated from 052 rather than retyped. A truncated copy would still be valid SQL and
    // would silently drop columns every latency surface reads.
    for (const marker of ['ttff_ms', 'e2e_ms', 'anchor_source', 'turn_id_source', 'unattributed_ms']) {
      expect(migration).toContain(marker);
    }
  });
});
