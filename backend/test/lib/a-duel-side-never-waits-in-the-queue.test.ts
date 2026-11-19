/**
 * A SIDE OF A DUEL RUNS WHEN THE FLOW SAYS IT RUNS (ADR-033, DESIGN-BATTLE).
 *
 * A duel occupies the whole conversation, through the channel's battle pointer. The per-assistant turn
 * lock belongs to a person's ordinary message. A side that took it would wait behind whatever its own
 * assistant is still finishing, such as the last round of the duel before, and the words of the
 * `/battle` would then be read later as an ordinary message.
 *
 * Asserted against the router SOURCE, like the neighboring claim guards: observing it needs a whole
 * flow-dispatched turn, and the property is a one-word edit away from being untrue.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

describe('a side of a duel and the turn lock', () => {
  it('is recognized from the battle context the flow declares', () => {
    expect(router).toContain('const isDuelSideTurn = !!bypassBattleContext(event);');
  });

  it('does not claim the lock, so it can never be queued behind one', () => {
    const claim = router.slice(router.indexOf('const turnClaim = '), router.indexOf('await claimTurn({'));
    expect(claim).toContain('isDuelSideTurn');
    expect(claim).toContain('{ claimed: true }');
  });

  it('owes no holder record and has no lock to release', () => {
    expect(router).toMatch(/owesHolderRecord = [\s\S]{0,200}!isDuelSideTurn/);
    expect(router).toMatch(/if \(![^)]*!isDuelSideTurn && turnClaim\.claimed\) \{\s+lockToRelease =/);
  });
});
