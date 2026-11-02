/**
 * A MOVED ANSWER KEEPS ITS FIRST FEEDBACK (migration 080, owner 2026-10-21).
 *
 * A placeholder whose answer moved to a message of its own declares `receipt` or `queue_ack` and pairs
 * with nothing, so `v_turn_latency` lost its anchor and the turn lost its time to first feedback, which
 * is the placeholder's post. 080 anchors such a placeholder on the moved answer's exchange for the
 * person's message it declared, and getLatencyMetrics counts that anchor as measured.
 *
 * The SQL is checked as text, as every sibling here checks it: there is no Postgres in the unit suite.
 * The view must be 071's body with exactly the 080 changes, so the comparison regenerates it.
 */
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA = path.resolve(__dirname, '../../lambda/src/analytics-aurora/schema');
const read = (f: string) => fs.readFileSync(path.join(SCHEMA, f), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const sqlOnly = (s: string) => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

const FILE = '080-a-moved-answer-keeps-its-first-feedback.sql';
const START = 'CREATE OR REPLACE VIEW v_turn_latency AS';
const END = ') trg ON TRUE;';
const viewOf = (m: string) => m.slice(m.indexOf(START), m.indexOf(END, m.indexOf(START)) + END.length);

describe('080 anchors a moved answer\'s placeholder on its declared target', () => {
  const m080 = fs.existsSync(path.join(SCHEMA, FILE)) ? read(FILE) : '';
  const view = flat(sqlOnly(viewOf(m080)));

  it('exists under a number no other migration holds', () => {
    expect(m080).toContain(START);
    const numbers = fs.readdirSync(SCHEMA).filter((f) => f.endsWith('.sql')).map((f) => parseInt(f.slice(0, 3), 10));
    expect(numbers.filter((n) => n === 80)).toHaveLength(1);
  });

  it('anchors only a receipt or a queue notice, only with no exchange of its own, never through a swept pairing', () => {
    expect(view).toContain("LEFT JOIN messages mu ON mu.channel_arn = m.channel_arn AND mu.event_type = 'UPDATE_CHANNEL_MESSAGE' AND mu.message_id = m.message_id || '-UPD'");
    expect(view).toContain('WHERE e.user_message_at IS NULL');
    expect(view).toContain("COALESCE(mu.turn_kind, m.turn_kind, mu.metadata->>'turnKind', m.metadata->>'turnKind') IN ('receipt', 'queue_ack')");
    expect(view).toContain("um.message_id = COALESCE(mu.answers_message_id, m.answers_message_id, mu.metadata->>'answersMessageId', m.metadata->>'answersMessageId')");
    expect(view).toContain('AND ex.queued_as IS NULL AND COALESCE(ex.battle_round, 1) <= 1');
    expect(view).toContain("AND ex.paired_by IS DISTINCT FROM 'swept'");
    expect(view).toContain(") tx ON TRUE");
    expect(view).toContain("WHEN tx.user_message_at IS NOT NULL THEN 'declared_target'");
  });

  it('is 071 with exactly those changes, so every other row computes what 071 computes', () => {
    const v071 = viewOf(read('071-round-two-is-measured-from-its-own-trigger.sql'));
    const own = 'COALESCE(a.t0_user_at, e.user_message_at)';
    expect(v071.split(own).length - 1).toBe(16);
    // Every person anchor gains the target as its last resort, and nothing else about it changes.
    const expected = flat(sqlOnly(v071.split(own).join('COALESCE(a.t0_user_at, e.user_message_at, tx.user_message_at)')));
    const withoutAdditions = flat(sqlOnly(viewOf(m080)
      .replace(/\n  -- THE RESPONSE'S UPDATE ROW[\s\S]*?\) tx ON TRUE/, '')
      .replace("\n         WHEN tx.user_message_at IS NOT NULL THEN 'declared_target'", '')));
    expect(withoutAdditions).toBe(expected);
  });

  it('is idempotent and transaction-safe', () => {
    expect(sqlOnly(m080)).not.toContain('CONCURRENTLY');
    expect(m080.trimEnd().endsWith(';')).toBe(true);
  });

  it('is counted as a measured anchor by the Latency tab', () => {
    const query = fs.readFileSync(path.resolve(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
    expect(flat(query)).toContain("OR COALESCE(vl.anchor_source = 'declared_target', FALSE)");
  });
});
