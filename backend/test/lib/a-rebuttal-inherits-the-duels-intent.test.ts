/**
 * A REBUTTAL INHERITS THE DUEL'S INTENT, AND DECLARES NOTHING WHEN THERE IS NONE.
 *
 * `battle-orchestrator.ts` dispatched round 2 with a literal `intent: 'general'`. Round 2 goes
 * straight to the worker - the orchestrator fires it, not a person - so no classifier ever runs on
 * it, and every rebuttal in the analytics carried an intent nobody derived.
 *
 * It was the odd one out in its own payload: `trigger`, `userType`, `experimentId`, `variantId` and
 * `variantProfile` are each resolved beside it with a comment explaining why. And the repo already
 * records this exact hardcode being REMOVED from the flow (`channel-flow-processor.ts:892`): *"the
 * greeting/acknowledgment fast path, the abuse gate, the correlation id, `intent: 'general'`, ... was
 * a second implementation of decisions the router already makes, and a second implementation diverges
 * SILENTLY: the turn still answers, so nothing errors."* The flow was cleaned up; the orchestrator was
 * not, and ten lines below the hardcode the same file documents the identical round-2 omission for
 * experiment attribution.
 *
 * MEASURED IMPACT: on 2026-08-20, 174 of 1,137 assistant messages were round-2 rebuttals. Every one
 * archived `general`, splitting each duel across two intent buckets and reporting one of them wrongly
 * - which matters most for a duel, whose entire purpose is comparing two answers to the SAME question.
 *
 * THE INHERITANCE IS THE FIX, not a new declaration: both rounds answer the same user question, so
 * they carry the same intent. Round 1 records it on its battle row when it completes; round 2 reads it
 * back. When round 1 recorded none - a duel that predates the stored field - the rebuttal OMITS the
 * field rather than falling back, because a fallback is how the fabricated value would return quietly.
 */

describe('the round-2 dispatch does not invent an intent', () => {
  const orchestrator = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/battle-orchestrator.ts'),
    'utf8',
  ) as string;

  it('no longer hardcodes an intent on the rebuttal payload', () => {
    // The mutation this catches is the literal coming back, in any spacing.
    expect(orchestrator).not.toMatch(/intent:\s*'general'/);
  });

  it('takes the intent from the duel row, and only when the row has one', () => {
    // Spread-guarded, so an absent intent contributes no key at all rather than `intent: undefined`,
    // which would archive as a declared null and read as "classified, as nothing".
    expect(orchestrator).toMatch(/\.\.\.\(selfRow\.intent\s*&&\s*\{\s*intent:\s*selfRow\.intent\s*\}\)/);
  });

  it('has no other fallback that could reintroduce a value nobody derived', () => {
    // A `?? 'general'` or `|| 'general'` anywhere in this file would restore the defect while passing
    // the first assertion, which is exactly the shape a well-meaning cleanup reaches for.
    expect(orchestrator).not.toMatch(/(\?\?|\|\|)\s*'general'/);
  });
});

describe('round 1 records the intent for round 2 to inherit', () => {
  const core = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/lib/async-processor-core.ts'),
    'utf8',
  ) as string;
  const state = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/lib/battle-state.ts'),
    'utf8',
  ) as string;

  it('the terminal transition carries the intent onto the row', () => {
    expect(core).toMatch(/intent:\s*args\.intent/);
    expect(state).toMatch(/if\s*\(args\.intent\s*!==\s*undefined\)\s*\{/);
    expect(state).toMatch(/sets\.push\('intent = :intent'\)/);
  });

  it('EVERY caller of the terminal helper supplies it, not just the happy path', () => {
    // Tracker rule 2: a fix touching one call site enumerates them all. There are two - the opt-out
    // path (response null) and the answered path - and a rebuttal after the opt-out path is exactly
    // the case that would silently keep the old behaviour if only one were updated.
    const calls = core.match(/recordBattleTerminalAndFireOrchestrator\(\{[\s\S]*?\n\s*\}\);/g) || [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/intent:\s*event\.intent/);
  });

  it('writes the attribute only when there is one, so a placeholder is never stored', () => {
    // Same rule as the read side: absent beats invented. The `!== undefined` guard is what keeps a
    // round-1 completion that carried no classification from writing something into the row.
    const block = /if\s*\(args\.intent\s*!==\s*undefined\)\s*\{[\s\S]*?\}/.exec(state);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/'general'|\?\?|\|\|/);
  });
});
