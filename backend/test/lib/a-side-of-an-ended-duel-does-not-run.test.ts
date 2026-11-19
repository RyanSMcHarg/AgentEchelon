/**
 * A SIDE OF A DUEL SOMEBODY ALREADY ENDED DOES NOT RUN.
 *
 * A duel can be ended (`/battle end`) a moment after it fans out, before its sides reach the router (`battle.spec.ts`
 * "multi-turn"). A side that ran anyway would answer for some 25 seconds after "Battle ended" and hold its assistant's
 * turn, so the next `/battle` would find both assistants busy, its sides would be queued and drained as ordinary
 * messages, and its rounds and scorecard would never fill. Both duels ask the same question, so late answers would read
 * as the new duel's.
 *
 * The router reads the duel's rows where a declared side enters, and stands down when the duel was ended
 * (`duelWasAbandoned`, the `__abandoned__` marker or an `ABANDONED` side), before anything claims the turn or
 * dispatches the processor. That `duelWasAbandoned` reads both shapes is held by
 * `a-duel-ends-by-a-recorded-state.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('a side of an ended duel does not run', () => {
  const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const standDown = router.indexOf('if (duelEntry && duelWasAbandoned(await readBattleRows(duelEntry.battleId)))');

  it('stands down a declared side whose duel was ended, saying nothing', () => {
    expect(standDown).toBeGreaterThan(-1);
    const branch = router.slice(standDown, router.indexOf('}', router.indexOf('return ', standDown)) + 1);
    expect(branch).toContain('return formatLexSilentResponse(event as LexEvent);');
  });

  it('decides before the turn is claimed and before the processor is dispatched', () => {
    expect(standDown).toBeLessThan(router.indexOf('await claimTurn({'));
    expect(standDown).toBeLessThan(router.indexOf("markRouterStep('classified')"));
  });

  it('decides on the declared duel, the one the flow fanned this side out for', () => {
    expect(standDown).toBeGreaterThan(router.indexOf('const duelEntry = bypassBattleContext(event);'));
  });
});

/**
 * ITS REBUTTAL ROUND STANDS DOWN TOO, AND QUIETLY (battle B-E3). A side's round 2 can reach `dispatchRebuttalRound`
 * after the duel's experiment ended. An ended duel is its ordinary end of life, so the round stands down at info, not as
 * an ERROR `[SecurityEvent]`, which is what a forged round is and which the e2e watchdog fails a run on. A round the duel's own record does not support (another
 * conversation, an unclaimed round 2, a foreign side) is still refused as a SecurityEvent.
 */
describe('a rebuttal round of an ended duel stands down without a SecurityEvent', () => {
  const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const fn = router.slice(router.indexOf('export async function dispatchRebuttalRound('), router.indexOf("let placeholderMessageId: string | undefined;"));

  it('an ended duel and an ended experiment both stand down, at info', () => {
    expect(fn).toContain("if (duelWasAbandoned(rows)) return standDown('the duel was ended');");
    expect(fn).toContain("return standDown('the experiment of the duel is no longer active; the duel is ended');");
    const standDown = fn.slice(fn.indexOf('const standDown'), fn.indexOf('};', fn.indexOf('const standDown')));
    expect(standDown).toContain('console.log(');
    expect(standDown).not.toContain('SecurityEvent');
  });

  it('the duel record is still checked for its conversation before an ended duel is let go quietly', () => {
    expect(fn.indexOf("return refuse('the duel ran in another conversation')")).toBeLessThan(fn.indexOf('if (duelWasAbandoned(rows))'));
    expect(fn).toContain("console.error('[Router][SecurityEvent] refused a rebuttal round'");
  });
});
