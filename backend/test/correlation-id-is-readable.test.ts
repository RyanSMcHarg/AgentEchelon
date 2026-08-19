/**
 * Every correlation id this codebase can MINT must be readable by the code that READS it.
 *
 * WHY THIS EXISTS (tracker rows 100 and 103). A bot message carrying `<!--corr:{id}-->` is a
 * placeholder, and `turn-events-backfill.ts` - the ONLY writer of `agent_final_at` - finds it with a
 * bounded pattern, `[A-Za-z0-9._-]{1,64}`. An id longer than 64 characters is not rejected at mint
 * time. It is posted, shown to the user as "One moment...", and then cannot be read back by anything.
 * The turn can never close, and no error is raised anywhere: the reader simply returns null, which is
 * indistinguishable from "this was never a placeholder".
 *
 * That is exactly the population row 103 was opened for. The unclosed-turn split classifies 26 rows as
 * `no_placeholder` - "never carried a marker" - on the strength of that same predicate, and those 26
 * DO contain the literal `<!--corr:` substring. "No marker at all" is benign, because nobody was
 * promised an answer. "A marker the reader cannot see" means someone WAS told to wait and the platform
 * structurally could not deliver. The two are opposite findings and the predicate cannot tell them
 * apart, which is why the row states 144 certain, 26 assumed, 2 confirmed rather than a flat 170.
 *
 * WHAT THE FIRST RUN FOUND, before the fix in `correlation.ts`. The battle mint template was
 * `battle-{round}-{botArn.split('/').pop()}-{Date.now()}-{random6}`, written inline at three call
 * sites. Its fixed part is 31 characters, so any bot-ARN segment of 34 or more overflowed. Amazon
 * Chime SDK assigns that segment (`CreateAppInstanceBot` returns the ARN; the `Name` we pass is
 * metadata, not the id), so its length is not ours to choose.
 *
 * AND WHY NO TEST CAUGHT IT. Every fixture in this suite uses a short bot name - `.../bot/premium`,
 * `.../bot/default`, `.../bot/AltSlot0` - which fits comfortably at 38 characters. The bound was
 * satisfied by the test data and violated by the real data, so the suite was green and the ledger was
 * blind. A guard has to be driven with the worst input the PRODUCER can emit, not the tidiest input
 * the AUTHOR can imagine.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CORRELATION_ID_MAX_LENGTH,
  battleCorrelationId,
  correlationMarkerOf,
  isReadableCorrelationId,
  mentionCorrelationId,
  turnCorrelationId,
} from '../lambda/src/lib/correlation';

const SRC = path.resolve(__dirname, '../lambda/src');

/**
 * A service-assigned Amazon Chime SDK bot id. 36 characters, which is what makes the pre-fix battle
 * template overflow; the short names used elsewhere in this suite do not.
 */
const REAL_BOT_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/'
  + '11111111-2222-3333-4444-555555555555/bot/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('the reader can see what the writers mint', () => {
  it('fails on an over-length id, so the checks below are not vacuous', () => {
    // Non-vacuity, and the mechanism itself: prove the reader goes BLIND rather than loud. If this
    // ever starts passing, the bound moved and every assertion below is checking nothing.
    const tooLong = 'x'.repeat(CORRELATION_ID_MAX_LENGTH + 1);
    expect(isReadableCorrelationId(tooLong)).toBe(false);
    expect(correlationMarkerOf(`One moment... <!--corr:${tooLong}-->`)).toBeNull();

    // And the boundary is where it claims to be.
    expect(isReadableCorrelationId('x'.repeat(CORRELATION_ID_MAX_LENGTH))).toBe(true);
  });

  it('a battle id is readable even when the bot ARN segment is service-assigned', () => {
    // THE REGRESSION THIS FILE WAS WRITTEN FOR. Pre-fix this produced 67 characters and the assertion
    // below failed, which is what turned row 103's "26 assumed" into a mechanism.
    for (const round of ['r1', 'r1c', 'r2']) {
      const id = battleCorrelationId({ botArn: REAL_BOT_ARN, round, nowMs: 1755000000000, suffix: 'abc123' });
      expect(isReadableCorrelationId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    }
  });

  it('the template this replaced really was unreadable, so the defect is not hypothetical', () => {
    // The exact pre-fix expression from battle-orchestrator.ts and channel-flow-processor.ts,
    // preserved here because "it would have overflowed" is an arithmetic claim and this is the
    // arithmetic. If someone re-inlines the template, the ratchet below fails; if someone widens the
    // bound so this becomes readable, THIS fails and says why the bound mattered.
    const preFix = `battle-r2-${REAL_BOT_ARN.split('/').pop()}-${1755000000000}-abc123`;
    expect(preFix.length).toBe(67);
    expect(preFix.length).toBeGreaterThan(CORRELATION_ID_MAX_LENGTH);
    expect(correlationMarkerOf(`One moment... <!--corr:${preFix}-->`)).toBeNull();
  });

  it('two bots in one channel still get different battle ids', () => {
    // Truncation must not create collisions: two placeholders sharing an id would let one answer
    // close the other's turn, which is worse than the bug being fixed. The tail is kept for exactly
    // this reason - service-assigned ids differ at the end, not the start.
    const other = REAL_BOT_ARN.replace('eeeeeeeeeeee', 'ffffffffffff');
    const a = battleCorrelationId({ botArn: REAL_BOT_ARN, round: 'r2', nowMs: 1755000000000, suffix: 'abc123' });
    const b = battleCorrelationId({ botArn: other, round: 'r2', nowMs: 1755000000000, suffix: 'abc123' });
    expect(a).not.toEqual(b);
  });

  it('a mention id is readable at the service maximum message id', () => {
    // The Amazon Chime SDK permits a 128-character MessageId. Every fixture in this suite uses ~15.
    const id = mentionCorrelationId('m'.repeat(128));
    expect(isReadableCorrelationId(id)).toBe(true);
  });

  it('a mention id stays stable for the same message, so a redelivery still dedups', () => {
    // The whole point of deriving it: fitting must not make it random.
    const long = 'm'.repeat(128);
    expect(mentionCorrelationId(long)).toEqual(mentionCorrelationId(long));
  });

  it('a derived turn id is readable', () => {
    const id = turnCorrelationId({
      channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c',
      senderArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/i/user/u',
      userMessage: 'hello',
      nowMs: 1755000000000,
    });
    expect(isReadableCorrelationId(id)).toBe(true);
  });
});

describe('the bound has one definition', () => {
  /**
   * The pattern is written four times: twice as SQL literals (the query plan needs them inline), and
   * twice as TypeScript regexes. Four copies of a number is three chances to widen one and leave the
   * others, which would resurrect exactly this defect in a form where the WRITER is fine and one
   * READER is blind.
   */
  // The SQL readers, which must carry the literal because a SQL string cannot import. The TypeScript
  // reader (turn-events-live.ts) is deliberately NOT here any more: it imports correlationMarkerOf,
  // which is the stronger form of what this guard enforces - no copy at all beats a synced copy.
  const READERS = [
    'analytics-aurora/analytics-query.ts',
    'analytics-aurora/turn-events-backfill.ts',
  ];

  it('the TypeScript ledger reader imports the one definition instead of copying it', () => {
    const text = fs.readFileSync(path.join(SRC, 'analytics-aurora/turn-events-live.ts'), 'utf8');
    expect(text).toMatch(/correlationMarkerOf/);
    // A re-inlined copy is the regression this pins against: the last copy re-hardcoded the bound
    // and dropped the URL-decoded fallback, so encoded archival content filed real placeholders as
    // ordinary bot messages while the lib reader recognized them.
    expect(text).not.toMatch(/<!--corr:\(\[A-Za-z0-9._-\]/);
  });

  it('every copy of the corr pattern carries the same bound', () => {
    const expected = `[A-Za-z0-9._-]{1,${CORRELATION_ID_MAX_LENGTH}}`;
    const seen: string[] = [];

    for (const rel of READERS) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const matches = [...text.matchAll(/<!--corr:\(\[A-Za-z0-9._-\]\{1,(\d+)\}\)-->/g)];
      // Each reader must actually contain the pattern; a file that stopped matching would pass this
      // loop silently while having changed its definition to something unrecognised.
      expect(matches.length).toBeGreaterThan(0);
      for (const m of matches) seen.push(`${rel}:{1,${m[1]}}`);
      for (const m of matches) {
        expect(`[A-Za-z0-9._-]{1,${m[1]}}`).toEqual(expected);
      }
    }

    expect(seen.length).toBeGreaterThan(3);
  });
});

describe('a correlation id is minted through the shared helper', () => {
  /**
   * A ratchet, in the shape `single-entry-point.test.ts` established. The defect was not that a bound
   * was wrong; it was that three call sites each built the id themselves and none consulted the
   * reader. Re-inlining the template is how it comes back, so a new inline mint fails here.
   */
  it('no source file builds a battle correlation id inline', () => {
    const offenders: string[] = [];
    (function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
        if (p.endsWith(path.join('lib', 'correlation.ts'))) continue; // the helper itself
        const text = fs.readFileSync(p, 'utf8');
        if (/`battle-\$\{?[a-zA-Z]|`battle-r\d/.test(text)) {
          offenders.push(path.relative(SRC, p).split(path.sep).join('/'));
        }
      }
    })(SRC);

    expect(offenders).toEqual([]);
  });
});
