/**
 * THE ANSWERS THE FIX ALREADY KNEW HOW TO PAIR, THAT NOTHING WENT BACK FOR.
 *
 * The mention-marker clause shipped 2026-09-23 and pairs a flow turn on the correlation id, which IS
 * the user's message id. It only ever reaches turns arriving after it, because the sweep that runs it
 * is scoped twice: to the channels in the current Kinesis batch, and to the last 24 hours. A quiet
 * channel is never revisited. 77 corr-marked answers were measured unpaired over three days before
 * the fix and no pass since has looked at them.
 *
 * An unpaired answer is not visibly missing. `v_turn_latency` LEFT JOINs, so the row survives with
 * `anchor_source` NULL and `ttff_ms` / `e2e_ms` NULL - the turn silently stops voting in every
 * latency figure rather than showing up as a gap somebody would chase.
 *
 * ── WHAT THIS FILE PINS, AND WHY EACH ONE MATTERS ───────────────────────────────────────────────
 *
 * 1. ONE STATEMENT, TWO CALLERS. The backfill must not be a second copy of "what counts as an answer
 *    to this message". This codebase already needs a dedicated test to stop four copies of the
 *    correlation regex drifting; a duplicated pairing predicate would be the same failure with
 *    higher stakes, because the copies would disagree about which turns exist.
 *
 * 2. WIDENING THE WINDOW CANNOT WIDEN THE GUESS. This is the property that makes the backfill safe at
 *    all, and it is not obvious: every pairing clause is bounded relative to the PAIR, never relative
 *    to now. Declared and mention are exact id matches. The inferred branch keeps its
 *    REPLY_BOUND_MINUTES bound and its no-intervening-user-message test. So the 24-hour bound is a
 *    work limit, and removing it admits older rows to the same tests rather than looser ones.
 *
 * 3. STILL BOUNDED. "Every channel" must not also mean "all of history": a mistyped argument should
 *    not turn into an unbounded table scan.
 */
import * as fs from 'fs';
import * as path from 'path';

const ARCHIVAL = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts');
const HANDLER = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'data-plane-handler.ts');

const archival = fs.readFileSync(ARCHIVAL, 'utf8');
const handler = fs.readFileSync(HANDLER, 'utf8');

/** The single pairing statement, from the function that owns it to the end of its parameters. */
function pairingStatement(): string {
  const start = archival.indexOf('async function pairUnmatchedMessages');
  expect(start).toBeGreaterThan(-1);
  const end = archival.indexOf('ONE EXCHANGE PER QUEUED MESSAGE', start);
  expect(end).toBeGreaterThan(start);
  return archival.slice(start, end);
}

describe('the backfill reuses the pairing pass rather than copying it', () => {
  it('keeps the mention clause inside the one statement, with no copy elsewhere', () => {
    // It legitimately appears TWICE within that statement - once in the CASE that records
    // `paired_by = 'mention'` and once in the WHERE that does the pairing - so the property worth
    // pinning is not a count but a location: no occurrence outside the shared function.
    const MENTION = "<!--corr:mention-([A-Za-z0-9._-]{1,56})-->";
    const inFile = archival.split(MENTION).length - 1;
    const inStatement = pairingStatement().split(MENTION).length - 1;
    expect(inFile).toBeGreaterThan(0);
    expect(inStatement).toBe(inFile);
  });

  it('routes both the hot path and the backfill through the same function', () => {
    expect(archival).toContain("return pairUnmatchedMessages(channelArns, '24 hours');");
    expect(archival).toMatch(/pairUnmatchedMessages\(null, `\$\{days\} days`\)/);
  });

  it('parameterises the scope instead of hardcoding it', () => {
    const stmt = pairingStatement();
    // The literal the hot path used to carry must be gone from the statement itself: if it is still
    // there, the backfill's window argument is being ignored and the pass silently does nothing.
    expect(stmt).not.toContain("um.created_at > NOW() - INTERVAL '24 hours'");
    expect(stmt).toContain('um.created_at > NOW() - $2::interval');
    expect(stmt).toContain('($1::text[] IS NULL OR um.channel_arn = ANY($1))');
    expect(stmt).toContain('[channelArns, window]');
  });
});

describe('a wider window admits older rows to the same tests, not looser ones', () => {
  it('keeps every pairing clause bounded relative to the pair rather than to now', () => {
    const stmt = pairingStatement();

    // Declared and mention are exact id matches - no time term, so a wider window cannot loosen them.
    expect(stmt).toContain(') = um.message_id');

    // The inferred branch is the only guess, and both of its guards are relative to the user message.
    expect(stmt).toContain('am.created_at <= um.created_at + INTERVAL');
    expect(stmt).toContain('nxt.created_at > um.created_at');
    expect(stmt).toContain('nxt.created_at < am.created_at');

    // The statement carries exactly two NOW() terms and neither loosens a pairing.
    //
    // One is the scoping predicate this change parameterised. The other is the update-deferral gate
    // (`am.created_at <= NOW() - INTERVAL '<UPDATE_DEFER_SECONDS> seconds'`), which holds a very
    // recent answer back until its UPDATE row has had time to land. That one is relative to now by
    // design, and a backfill over historical rows satisfies it trivially: everything it looks at is
    // older than the deferral. It DELAYS a pairing and can never admit one.
    //
    // A third NOW() would be a real finding, because it would mean a pairing clause whose result
    // depends on when the backfill happened to run - the one thing a backfill must not do.
    expect(stmt.split('NOW()').length - 1).toBe(2);
    expect(stmt).toContain('AND um.created_at > NOW() - $2::interval');
    expect(stmt).toContain('am.created_at <= NOW() - INTERVAL');
  });

  it('keeps the anti-join and the conflict guard, so re-running converges', () => {
    const stmt = pairingStatement();
    expect(stmt).toContain('AND e.id IS NULL');
    expect(stmt).toContain('ON CONFLICT DO NOTHING');
  });
});

describe('the backfill stays bounded and reachable', () => {
  it('clamps the window so a bad argument cannot scan the whole table', () => {
    expect(archival).toContain('Math.min(Math.max(Math.trunc(opts.days ?? 90) || 90, 1), 365)');
  });

  it('is dispatched on the data-plane seam, the only place Aurora is reachable', () => {
    expect(handler).toContain("| 'backfillExchangePairings'");
    expect(handler).toContain("case 'backfillExchangePairings':");
    expect(handler).toContain('backfillExchangePairings((req.input as { days?: number }) || {})');
  });

  it('does NOT also mint turn events, which would present a derived anchor as a measured one', () => {
    // An exchange is enough for v_turn_latency to anchor the turn (anchor_source = 'exchange').
    // Minting turn_events rows would stamp turn_id_source = 'paired' and flip the anchor to
    // 'ledger', which a-backfilled-anchor-is-not-a-measured-one exists to catch.
    const start = archival.indexOf('export async function backfillExchangePairings');
    const end = archival.indexOf('async function pairUnmatchedMessages', start);
    // CODE ONLY. The comment above the function names `backfillTurnEvents` precisely to warn the next
    // reader off it, so a raw substring search finds the warning and calls it a violation - a test
    // that fails on its own documentation teaches people to delete the documentation.
    const code = archival.slice(start, end)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'))
      .join('\n');
    expect(code).not.toContain('backfillTurnEvents');
    expect(code).not.toContain('turn_events');
  });
});
