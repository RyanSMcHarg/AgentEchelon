/**
 * The analytics split between a TARGETED turn and a STANDARD one, and the configuration it rests on.
 *
 * WHAT THE COLUMN RECORDS. Migration 054 stores `messages.turn_entry` as `'lex'` or `'flow'`: Amazon
 * Chime SDK invoked the assistant's Amazon Lex bot, or the channel flow invoked the router directly.
 * It deliberately does NOT store a third value for "targeted", and says why: the router cannot know
 * whether an Amazon Lex invocation was targeted without a channel read, and that read would sit in
 * front of the person's first frame - buying a dimension by making the metric change the thing it
 * measures.
 *
 * WHAT MAKES THE SPLIT READABLE ANYWAY. The migration's own words: "under a deployment-wide
 * `StandardMessages: NONE` an Amazon Lex invocation IS targeted by construction, so the split is
 * implied by the configuration rather than stored per row". So `turn_entry = 'lex'` means TARGETED and
 * `'flow'` means STANDARD - but only while every bot in the deployment is provisioned `NONE`.
 *
 * WHY THAT NEEDS A TEST RATHER THAN A COMMENT. The implication is invisible at both ends. A bot
 * provisioned `AUTO` is a one-word change in a stack file; nothing downstream errors; the Latency tab
 * keeps rendering a `(lex)` series that has quietly become a mixture of targeted and untargeted turns.
 * That is precisely the failure 054 was written to end - it replaced a correlation-id SHAPE heuristic
 * that "silently mixed a DIRECT quick answer into the flow bucket". A guard here is the cheapest way
 * to keep the stored dimension and the stated reading from drifting apart.
 *
 * It also guards a second, blunter failure: `AUTO` on a bot whose Lex fulfillment says nothing makes
 * Amazon Chime SDK post `{"Code":500}` into the room. See
 * `a-silent-fulfillment-carries-no-welcome-intent.test.ts`, which owns that half.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('a targeted turn is separable from a standard one', () => {
  it('every assistant is provisioned StandardMessages: NONE, by the one build path, with no way to ask otherwise', () => {
    // Every identity is the provisioner's (ADR-048, amended 2026-10-23), built by `buildIdentity`, which passes
    // no `standardMessages`, so the builder's default applies; and the default is NONE, so an absence cannot
    // mean AUTO (two responders on one message, arrived at by an absence).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { assistantBotConfiguration } = require('../lambda/src/lib/assistant-identity');
    const alias = 'arn:aws:lex:us-east-1:1:bot-alias/B/TSTALIASID';
    expect(assistantBotConfiguration({ lexBotAliasArn: alias }).Lex.InvokedBy).toEqual({ StandardMessages: 'NONE', TargetedMessages: 'ALL' });
    const build = read('lambda/src/lib/assistant-provisioner.ts');
    expect(build).toContain('assistantBotConfiguration({');
    expect(build).not.toMatch(/standardMessages/);
    // No stack provisions an identity of its own, so none can set an entry of its own.
    for (const stack of ['lib/stacks/assistant-profile-stack.ts', 'lib/stacks/admin-services-stack.ts']) {
      expect(read(stack)).not.toMatch(/INVOKED_BY_STANDARD_MESSAGES|invokedByStandardMessages/);
    }
  });

  it('the stored dimension is the one the readers group by, and it is folded onto the canonical row', () => {
    const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
    // Written at insert AND folded onto the CREATE row by the update. Without the fold the column is
    // NULL on every row the readers actually join to, and the dimension has one value: unknown.
    expect(archival).toContain('turn_entry             = COALESCE($26, turn_entry)');

    const query = read('lambda/src/analytics-aurora/analytics-query.ts');
    // Both latency readers group by it, which is what makes the two populations separable at all.
    expect(query).toContain("GROUP BY rs.step_name, COALESCE(m.turn_entry, 'unknown')");
    expect(query).toContain("COALESCE(m.turn_entry, 'unknown')");
  });

  it('an unrecorded entry reads as unknown for display and is never defaulted to a value', () => {
    // NULL means "written before the column existed". Guessing an entry would put the difference being
    // measured into the measurement, which is the one thing the column exists to stop.
    const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
    expect(archival).not.toMatch(/turn_entry[^\n]*\|\|\s*'(lex|flow)'/);
    expect(archival).not.toMatch(/turn_entry[^\n]*\?\?\s*'(lex|flow)'/);
  });
});
