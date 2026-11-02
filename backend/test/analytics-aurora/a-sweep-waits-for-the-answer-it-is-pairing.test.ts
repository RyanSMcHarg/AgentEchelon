/**
 * THE SWEEP DOES NOT MINT A PAIRING WHILE THE TURN IS STILL OPEN.
 *
 * ── THE DEFECT, WHICH IS A SCHEDULE AND NOT A CARRIER ───────────────────────────────────────────
 *
 * `createExchangesFromDatabase` minted an exchange the moment a bot placeholder landed. The message a
 * turn answers is NOT known when the placeholder is posted and IS known by the time the answer update
 * is written, so on any turn whose answer had not arrived yet there was no declaration to read and
 * the row was stamped `paired_by = 'swept'` permanently.
 *
 * That label is excluded from the headline time to first feedback by name, and the rows wrongly
 * carrying it were disproportionately the SLOW ones: archival batches on a five second window
 * (`archive-stack-aurora.ts`), so a turn whose first feedback takes longer than five seconds cannot
 * have its user message and its placeholder in one batch and is exactly the turn this pass reaches
 * first. The service level objective was computed with its own worst cases censored.
 *
 * ── SO THE SWEEP WAITS, AND THE WAIT EXPIRES ───────────────────────────────────────────────────
 *
 * It defers a bot message that has no answer update yet, until either the update exists or the
 * placeholder is older than any live turn can be. The expiry is not optional: a deferral that never
 * expired would drop an abandoned or failed turn out of analytics altogether, and a missing row is
 * indistinguishable from a turn that never happened, while a mislabeled one is at least counted.
 *
 * ── HOW THESE TESTS WORK, AND WHY THEY CAN FAIL ────────────────────────────────────────────────
 *
 * The gate is SQL, so there is no Postgres here to run it against. Instead each disjunct is paired
 * with the condition it encodes, and `mints()` below evaluates the gate AS THE SOURCE ACTUALLY
 * WRITES IT: a disjunct that is not in the file does not vote, and a gate that is missing entirely
 * means the sweep mints unconditionally, which is precisely the behavior this change removed. The
 * last test in the first block feeds it the pre-change SQL and shows the in-flight turn being minted,
 * so none of the assertions below passes vacuously.
 */
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

import { defaultProfileRegistry } from '../../lib/profile-registry';

const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');

/** Compare SQL by its tokens rather than by its indentation. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** The sweep's own body, so a clause found in a neighbouring pass cannot satisfy these. */
const sweep = flat(
  archival.slice(
    archival.indexOf('async function pairUnmatchedMessages'),
    archival.indexOf('async function createQueuedExchanges'),
  ),
);

/**
 * The staleness bound the deployment's own configuration produces, computed here the way the module
 * computes it. Pinned to a number as well as to a derivation: a derivation that silently evaluates to
 * five seconds would satisfy every structural assertion in this file.
 */
const MAX_PROFILE_TIMEOUT_SECONDS = Math.max(
  ...defaultProfileRegistry.classificationValues().map((c) => defaultProfileRegistry.requireProfileFor(c).timeoutSeconds),
);
const DEFER_SECONDS = MAX_PROFILE_TIMEOUT_SECONDS * 6 + 120;

/** What the sweep can know about one candidate bot message when it runs. */
interface Candidate {
  /** A declaration naming a user message is readable on the CREATE or the UPDATE row. */
  hasDeclaration: boolean;
  /**
   * The message is a corr-marked placeholder, so its update may still declare it a receipt or a queue
   * notice rather than the answer.
   */
  isPlaceholder: boolean;
  /** The answer update (`<id>-UPD`) has been archived. */
  hasUpdateRow: boolean;
  /** The latest update is the turn narrating its work (respPhase `progress`), not saying what the placeholder became. */
  updateIsNarration?: boolean;
  /** The CREATE declared itself final, so no update is coming (a DIRECT answer). */
  finalOnCreate: boolean;
  /** How old the placeholder is when the sweep runs. */
  ageSeconds: number;
}

/**
 * Every disjunct of the gate, with the condition it encodes. Adding a fifth without adding it here
 * makes `everyDisjunctIsAccountedFor` fail, so the model cannot quietly fall behind the SQL.
 */
const DISJUNCTS: Array<{ name: string; sql: string; holds: (c: Candidate) => boolean }> = [
  {
    name: 'the declaration is already readable, on a message that is not a placeholder',
    sql: "(COALESCE( am_upd.answers_message_id, am.answers_message_id, am_upd.metadata->>'answersMessageId',"
      + " am.metadata->>'answersMessageId' ) IS NOT NULL AND am.content NOT LIKE '%<!--corr:%')",
    holds: (c) => c.hasDeclaration && !c.isPlaceholder,
  },
  {
    name: 'the answer update has landed, and it is not a narration',
    sql: "OR (am_upd.id IS NOT NULL AND COALESCE(am_upd.metadata->>'respPhase', '') <> '${NARRATION_PHASE}')",
    holds: (c) => c.hasUpdateRow && !c.updateIsNarration,
  },
  {
    name: 'the turn already finished on its CREATE',
    sql: 'OR am.agent_final_at IS NOT NULL',
    holds: (c) => c.finalOnCreate,
  },
  {
    name: 'the placeholder is stale, so no update is coming',
    sql: "OR am.created_at <= NOW() - INTERVAL '${updateDeferSeconds()} seconds'",
    holds: (c) => c.ageSeconds >= DEFER_SECONDS,
  },
];

/**
 * Would the sweep mint for this candidate, given the SQL as written?
 *
 * A gate with no disjuncts present is the pre-change statement, which minted for everything.
 */
function mints(sql: string, c: Candidate): boolean {
  const present = DISJUNCTS.filter((d) => sql.includes(flat(d.sql)));
  if (present.length === 0) return true;
  return present.some((d) => d.holds(c));
}

/** A turn in flight: the placeholder is up, the answer has not been written, nothing declared yet. */
const inFlight: Candidate = { hasDeclaration: false, isPlaceholder: true, hasUpdateRow: false, finalOnCreate: false, ageSeconds: 6 };

describe('the sweep defers a pairing whose answer has not been written yet', () => {
  it('does NOT mint while a bot message has no update and is inside the staleness bound', () => {
    expect(mints(sweep, inFlight)).toBe(false);
    // And it is the turn just past the archival batching window - the one the sweep reaches first and
    // used to stamp 'swept' for good.
    expect(inFlight.ageSeconds).toBeGreaterThan(5);
  });

  it('DOES mint once the answer update exists, because the evidence is now complete', () => {
    expect(mints(sweep, { ...inFlight, hasUpdateRow: true })).toBe(true);
  });

  it('DOES mint for a stale placeholder whose update never came, so nothing is lost', () => {
    // The requirement the expiry exists for: an abandoned or failed turn still reaches the exchange
    // population. A deferral with no expiry would remove it from analytics entirely.
    expect(mints(sweep, { ...inFlight, ageSeconds: DEFER_SECONDS })).toBe(true);
    expect(mints(sweep, { ...inFlight, ageSeconds: DEFER_SECONDS - 1 })).toBe(false);
  });

  it('DOES mint immediately where the turn already declared what it answers', () => {
    // A declared message that is not a placeholder, and a DIRECT answer that posted once and finished.
    // Both have everything the pairing will ever have, so waiting would only delay a correct row.
    expect(mints(sweep, { ...inFlight, isPlaceholder: false, hasDeclaration: true })).toBe(true);
    expect(mints(sweep, { ...inFlight, finalOnCreate: true })).toBe(true);
  });

  it('does NOT mint a placeholder that named its target until its update says what it became', () => {
    // A flow turn's placeholder declares its target in its CREATE content, before the turn knows
    // whether the answer stays in it. When the answer moves to a message of its own the update
    // declares the placeholder a receipt or a queue notice, and the answer pairs instead; minting from
    // the CREATE alone gave the exchange to the placeholder.
    expect(mints(sweep, { ...inFlight, hasDeclaration: true })).toBe(false);
    expect(mints(sweep, { ...inFlight, hasDeclaration: true, hasUpdateRow: true })).toBe(true);
  });

  it('does NOT mint a placeholder whose only update narrates the work, which may yet become a receipt', () => {
    // A resumed duel side wrote "Tidying the document before delivering it..." into its private
    // placeholder, then moved the answer to a public message and closed the placeholder out as a
    // receipt. Paired on the narration, the receipt took an exchange beside the answer's and the turn
    // was counted twice, the receipt's row with no path (2026-10-30).
    expect(mints(sweep, { ...inFlight, hasUpdateRow: true, updateIsNarration: true })).toBe(false);
    expect(mints(sweep, { ...inFlight, hasUpdateRow: true, updateIsNarration: true, ageSeconds: DEFER_SECONDS })).toBe(true);
  });

  it('every disjunct in the SQL is accounted for by the model, and every modeled one is in the SQL', () => {
    for (const d of DISJUNCTS) expect(sweep).toContain(flat(d.sql));
    // The gate block itself, so a fifth disjunct cannot be added outside the model's view.
    const gate = sweep.slice(
      sweep.indexOf('AND THE SWEEP WAITS FOR THE ANSWER RATHER THAN RACING IT'),
      sweep.indexOf('DECLARED: the answer named this message'),
    );
    // Matched on the column reference, not on the bare keyword: the prose above each disjunct opens
    // with "OR", and counting those would make this pass however many real ones were there.
    expect(gate.match(/ OR \(?am/g) ?? []).toHaveLength(3);
  });

  it('PROVES IT CAN FAIL: without the gate, the in-flight turn is minted', () => {
    // The statement as it was before this change - no deferral at all. The model reports the exact
    // defect: a turn still in flight gets its pairing, and therefore its permanent 'swept' label.
    const before = DISJUNCTS.reduce((sql, d) => sql.replace(flat(d.sql), ''), sweep);
    expect(mints(before, inFlight)).toBe(true);
    // And dropping only the expiry strands the abandoned turn, which is the opposite failure.
    const noExpiry = sweep.replace(flat(DISJUNCTS[3].sql), '');
    expect(mints(noExpiry, { ...inFlight, ageSeconds: DEFER_SECONDS * 10 })).toBe(false);
  });
});

describe('the staleness bound is derived from what a turn may cost, not picked', () => {
  it('reads the longest profile timeout LIVE from the deployment topology', () => {
    // A snapshot would silently re-censor the slowest turns on a deployment that raised a timeout.
    expect(archival).toContain(
      'profiles.classificationValues().map((c) => profiles.requireProfileFor(c).timeoutSeconds)',
    );
  });

  it('multiplies it by the invocations one turn may consume, and names both numbers', () => {
    // Lambda async invoke retries twice by default (three invocations) and
    // turn-lock-release-on-failure.ts re-dispatches up to TURN_MAX_ATTEMPTS (2) times.
    expect(archival).toContain('const MAX_TURN_INVOCATIONS = 3 * 2;');
    expect(archival).toContain('const ARCHIVAL_SETTLE_SECONDS = 120;');
    expect(archival).toContain(
      'const updateDeferSeconds = (): number => maxProfileTimeoutSeconds() * MAX_TURN_INVOCATIONS + ARCHIVAL_SETTLE_SECONDS;',
    );
  });

  it('lands on a bound that is longer than any live turn and far shorter than the lookback', () => {
    // Pinned as a NUMBER too. A derivation is only a justification if the value it produces is one:
    // this has to sit above the slowest turn the platform permits and well inside the 24-hour window
    // the sweep searches, or a deferred turn would age out before it could pair.
    expect(DEFER_SECONDS).toBe(660);
    expect(DEFER_SECONDS).toBeGreaterThan(MAX_PROFILE_TIMEOUT_SECONDS);
    expect(DEFER_SECONDS).toBeLessThan(24 * 60 * 60);
    // The window is a PARAMETER now, so the backfill can widen it without a second copy of the
        // statement. The hot path still passes 24 hours, which is the bound this test is about.
        expect(archival).toContain("return pairUnmatchedMessages(channelArns, '24 hours');");
        expect(sweep).toContain('um.created_at > NOW() - $2::interval');
  });

  it('interpolates the constant instead of writing the interval out, so there is one definition', () => {
    // The same rule REPLY_BOUND_MINUTES already follows: a bound that exists as a literal in the SQL
    // and a number in the TypeScript is two bounds waiting to disagree.
    expect(archival).toContain("INTERVAL '${updateDeferSeconds()} seconds'");
  });
});

describe('a deferred turn gets another pass, or the deferral would be permanent', () => {
  it('runs the sweep over every channel the batch touched, not only ones with a CREATE', () => {
    // The answer arrives as an UPDATE, and the batch carrying it routinely holds no CREATE of its
    // own. Restricted to CREATE-bearing channels, a deferred turn in a conversation that then went
    // quiet would never be swept at all - which is the silent drop the expiry exists to prevent.
    expect(archival).toContain('await createExchangesFromDatabase(touchedChannels);');
    expect(archival).not.toContain('await createExchangesFromDatabase(channelArns);');
  });

  it('runs it BEFORE the update fold, because the fold derives inbound_ms onto the pairing', () => {
    // The deferral can already see the update here: step 1 inserted the whole batch into `messages`,
    // so the -UPD row exists before either pass. What only the fold can do is derive `e2e_ms` and
    // `inbound_ms` onto the exchange, and it does that once per update row - so a pairing minted
    // AFTER it would carry no inbound_ms at all, and that update's fold is never coming back.
    const foldAt = archival.indexOf('await backfillFromUpdateEvents(updateMessages);');
    const sweepAt = archival.indexOf('await createExchangesFromDatabase(touchedChannels);');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(foldAt).toBeGreaterThan(sweepAt);
    // And the queued pass still runs last, where its own guard already pins it.
    expect(archival.indexOf('await createQueuedExchanges(touchedChannels);')).toBeGreaterThan(foldAt);
  });
});

describe('the promotion stays, as the backstop the expiry hands work to', () => {
  it('still promotes a swept label to declared on the exact user message id', () => {
    // Reassessed rather than removed. The deferral is REQUIRED to expire, so a turn that genuinely
    // ran longer than the bound still pairs as swept and still has its declaration arrive afterwards.
    // Without this, the bound would become a hard censoring boundary: every turn slower than it
    // labeled swept for good, which is the same defect one size smaller.
    expect(flat(archival)).toContain("WHEN ex.paired_by = 'swept' AND $18::text IS NOT NULL");
    expect(flat(archival)).toContain("THEN 'declared' ELSE ex.paired_by END");
  });

  it('promotes ONLY, and only from swept, so nothing is ever downgraded or invented', () => {
    // A declaration naming a DIFFERENT message is evidence the pairing is wrong, not a confirmation.
    expect(flat(archival)).toContain(
      "AND $18::text = ( SELECT um.message_id FROM messages um WHERE um.id = ex.user_message_id )",
    );
  });
});

describe('migration 053 records the two column contracts that moved', () => {
  const SCHEMA_DIR = path.resolve(__dirname, '../..', 'lambda/src/analytics-aurora/schema');
  const m053 = read('lambda/src/analytics-aurora/schema/053-a-sweep-waits-for-the-answer-it-is-pairing.sql');
  /** Strip `--` comments so prose ABOUT a statement is not mistaken for one. */
  const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

  it('takes the next free migration number, and owns it alone', () => {
    const numbers = fs.readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => parseInt(f.slice(0, 3), 10));
    // OWNS ITS NUMBER, which is the property that matters: two files sharing one number apply in an
    // order the filename sort does not define, and the runner records only one of them.
    expect(numbers.filter((n) => n === 53)).toHaveLength(1);
    // EVERY number is unique, not just this one - the same defect in any other pair is the same bug.
    expect(`duplicates: ${numbers.filter((n, i) => numbers.indexOf(n) !== i).join(',') || 'none'}`)
      .toBe('duplicates: none');
    // This used to assert 53 was the HIGHEST number, which made the next legitimate migration fail a
    // test about numbering hygiene. "Newest" is true only until something newer exists; what 053
    // needs is that nothing else claims 53 and that it sorts after its predecessors.
    expect(Math.max(...numbers.filter((n) => n < 53))).toBeLessThan(53);
  });

  it('is idempotent and transaction-safe: COMMENT ON only, no lock and no row rewrite', () => {
    // Pending migrations apply inside ONE transaction on a cold start, so a CONCURRENTLY index or a
    // whole-table rewrite that outruns the invocation would commit nothing and repeat forever.
    expect(code(m053)).not.toMatch(/CONCURRENTLY|VACUUM|REINDEX/i);
    // Every statement is a COMMENT ON, checked by shape rather than by banned keywords: the comment
    // TEXT itself says the words "update" and "table", so a keyword scan would fail on prose.
    //
    // Split on the statement terminator, the same way the repo's own bounded-data-step guard reads a
    // migration. That heuristic only holds while the comment PROSE carries no semicolon of its own,
    // which is why this file's does not.
    const statements = code(m053).split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const statement of statements) expect(statement.startsWith('COMMENT ON COLUMN ')).toBe(true);
    expect(m053).toContain('COMMENT ON COLUMN exchanges.paired_by IS');
    expect(m053).toContain('COMMENT ON COLUMN turn_events.turn_id_source IS');
  });

  it('says what swept now means, so the old contract is not read as current', () => {
    expect(m053).toContain('defers a bot message whose answer ');
    expect(m053).toContain('update has not landed yet');
  });

  it('says a paired binding is not an independently measured anchor', () => {
    expect(m053).toContain('turn_id_source = paired is NOT an independently measured anchor');
  });
});

describe('the SQL still survives being a template literal', () => {
  it('carries no backtick inside the sweep statement', () => {
    // A backtick in a `--` comment ends the string mid-query. This has broken the build three times.
    const body = archival.slice(archival.indexOf('async function pairUnmatchedMessages'));
    const literal = body.slice(body.indexOf('`'), body.indexOf('[channelArns, window]'));
    expect(literal.split('`').length - 1).toBe(2);
  });
});
