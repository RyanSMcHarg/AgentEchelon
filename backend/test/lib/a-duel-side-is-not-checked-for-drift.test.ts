/**
 * A DUEL SIDE'S TURN IS NOT CHECKED FOR DRIFT.
 *
 * A side's message is the `/battle` prompt, whose subject is the duel. Drift firing there made the side
 * post an offer instead of its round-1 answer, so round 2 never fired (2026-10-15, B-E4's fourth duel).
 * The person's own messages between duels are still checked.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('a duel side is not checked for drift', () => {
  const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('skips the live drift flow when the turn carries a duel context', () => {
    const gate = router.slice(router.indexOf('const driftResponse ='), router.indexOf('await runLiveDriftFlow({'));
    // A duel side never reaches drift: `battleCtx` is one of the conditions that skip it.
    expect(gate).toMatch(/\|\| battleCtx (\|\| [A-Za-z]+ )*\? null/);
  });

  it('decides with the duel context resolved before drift runs, including a resumed side', () => {
    // The context is resolved (declared, or synthesized for a resumed side) well before the drift call.
    expect(router.indexOf('let battleCtx = bypassBattleContext(event);')).toBeGreaterThan(-1);
    expect(router.indexOf('let battleCtx = bypassBattleContext(event);')).toBeLessThan(router.indexOf('const driftResponse ='));
  });
});
