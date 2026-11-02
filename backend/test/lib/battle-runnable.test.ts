/**
 * battleIsRunnable — a duel must stop when its experiment ends.
 *
 * THE DEFECT THIS EXISTS FOR. `ChannelBattleConfig` is a SNAPSHOT written when a moderator enables
 * Battle Mode: slot arn, experiment id, briefing. Nothing re-read the experiment afterwards, so a
 * channel enabled while an experiment was active kept fanning out duels indefinitely after that
 * experiment completed - and every human pick it collected was recorded against a completed
 * experiment, where it can never reach a recommendation.
 *
 * The two paths disagreed with each other, which is what made it invisible: enabling a NEW channel
 * refused correctly, because enable auto-resolves the single ACTIVE battle experiment. Only an
 * ALREADY-enabled channel kept going. Ending an experiment is how an operator stops a comparison, so
 * it has to stop the duels too.
 *
 * Pure by design: `channel-flow-processor` has no unit harness (it is only reached by source-scanning
 * tests), so the rule lives here where it can be driven directly.
 */
import { battleIsRunnable, battleIsRunnableConfirmed } from '../../lambda/src/lib/battle-state';

const ACTIVE = { experimentId: 'exp-live', status: 'active' };
const DONE = { experimentId: 'exp-done', status: 'completed' };
const PAUSED = { experimentId: 'exp-paused', status: 'paused' };

const cfg = (over: Record<string, unknown> = {}) => ({
  channelArn: 'arn:aws:chime:::channel/c1',
  enabled: true,
  experimentId: 'exp-live',
  ...over,
} as never);

describe('battleIsRunnable', () => {
  it('runs when the bound experiment is active', () => {
    expect(battleIsRunnable(cfg(), [ACTIVE, DONE])).toBe(true);
  });

  it('STOPS when the bound experiment has completed — the case that used to run forever', () => {
    expect(battleIsRunnable(cfg({ experimentId: 'exp-done' }), [ACTIVE, DONE])).toBe(false);
  });

  it('stops when the bound experiment is paused', () => {
    expect(battleIsRunnable(cfg({ experimentId: 'exp-paused' }), [ACTIVE, PAUSED])).toBe(false);
  });

  it('stops when the bound experiment no longer exists at all (deleted)', () => {
    expect(battleIsRunnable(cfg({ experimentId: 'exp-gone' }), [ACTIVE])).toBe(false);
  });

  it('stops when battle is disabled, whatever the experiment says', () => {
    expect(battleIsRunnable(cfg({ enabled: false }), [ACTIVE])).toBe(false);
    expect(battleIsRunnable(null, [ACTIVE])).toBe(false);
  });

  // A config predating the experiment binding has no experiment to have ended, so it stays runnable
  // rather than being switched off by a check that cannot apply to it.
  it('runs for a legacy config with no bound experiment id', () => {
    expect(battleIsRunnable(cfg({ experimentId: undefined }), [])).toBe(true);
  });

  it('does not treat an empty experiment list as permission to run', () => {
    // The list being empty means nothing is active - not that the check is unavailable.
    expect(battleIsRunnable(cfg(), [])).toBe(false);
  });
});

/**
 * A REFUSAL IS CONFIRMED FRESH, AN ALLOW IS NOT. The experiments memo is a minute behind; a stale
 * "ended" for an experiment just re-activated refused the duel and told the room the experiment had
 * ended, which was false (seen live in the battle e2e, 2026-10-08).
 */
describe('battleIsRunnableConfirmed', () => {
  const reads = (cachedList: unknown[], freshList: unknown[]) => {
    const cached = jest.fn(async () => cachedList as never);
    const fresh = jest.fn(async () => freshList as never);
    return { cached, fresh };
  };

  it('allows from the cache and never pays for a fresh read', async () => {
    const { cached, fresh } = reads([ACTIVE], [DONE]);
    expect(await battleIsRunnableConfirmed(cfg(), cached, fresh)).toBe(true);
    expect(fresh).not.toHaveBeenCalled();
  });

  it('a stale "ended" is re-checked fresh, and a re-activated experiment runs', async () => {
    const { cached, fresh } = reads([{ experimentId: 'exp-live', status: 'completed' }], [ACTIVE]);
    expect(await battleIsRunnableConfirmed(cfg(), cached, fresh)).toBe(true);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('an experiment that really ended still refuses, after the fresh read agrees', async () => {
    const { cached, fresh } = reads([{ experimentId: 'exp-live', status: 'completed' }], [{ experimentId: 'exp-live', status: 'completed' }]);
    expect(await battleIsRunnableConfirmed(cfg(), cached, fresh)).toBe(false);
  });

  it('a refusal that does not come from the experiments pays for no second read', async () => {
    const { cached, fresh } = reads([], [ACTIVE]);
    expect(await battleIsRunnableConfirmed(cfg({ enabled: false }), cached, fresh)).toBe(false);
    expect(await battleIsRunnableConfirmed(null, cached, fresh)).toBe(false);
    expect(fresh).not.toHaveBeenCalled();
  });
});
