/**
 * BattleScorecard — a recorded pick survives the component being remounted.
 *
 * THE DEFECT THIS EXISTS FOR. The scorecard renders against ONE message in the stream, so when a
 * round-2 reply arrives it can end up attached to a different message. React discards the old
 * instance and mounts a fresh one, which resets `winner` to null and refetches. That fetch races the
 * pick POST, and when the fetch wins it resolves to "no pick recorded yet": a pick the server HAS
 * accepted renders as unpicked, with no way for the user to tell it registered. Re-clicking is the
 * only recourse, and it writes the same vote again.
 *
 * The pick is optimistic (`setWinner` fires before the POST), so the button flips instantly on click.
 * Everything here is therefore about what happens to that state when the instance is replaced - which
 * is why the tests mount a SECOND instance rather than clicking twice.
 *
 * It surfaced as e2e B-E4 and B-E6 both failing on `aria-pressed` staying "false" 10s after a pick
 * whose POST had already returned 200, and as B-E4 passing when run alone - the signature of a race
 * rather than a broken flow. The parent (ConversationInterface) already tracked the pick per battleId
 * for its running tally, so the durable copy existed; the scorecard just was not reading it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const getBattleOutcome = vi.fn();
const recordBattleOutcome = vi.fn();

vi.mock('../services/battleOutcomeService', () => ({
  getBattleOutcome: (...a: unknown[]) => getBattleOutcome(...a),
  recordBattleOutcome: (...a: unknown[]) => recordBattleOutcome(...a),
}));
// Full replacement, NOT importOriginal: the real @ae/shared barrel reaches AWS SDK modules that
// never settle under jsdom and hang the run at import time.
vi.mock('@ae/shared', () => ({
  INTENT_STRATEGY_CARDS: [],
  getModelStrategyLookup: () => ({}),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? '' }),
}));

import BattleScorecard from './BattleScorecard';

const BATTLE_ID = 'battle-abc123';
const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const VARIANT_A = { label: 'Assistant', persona: 'Atlas', modelId: 'anthropic.claude-sonnet' };
const VARIANT_B = { label: 'AltSlotO', persona: 'Echo', modelId: 'anthropic.claude-opus' };

const pickButton = (choice: 'A' | 'B') =>
  document.querySelector(`[data-pick="${choice}"]`) as HTMLButtonElement;

beforeEach(() => {
  // The race being modelled: the mount fetch resolves with NO recorded pick, because the POST that
  // recorded it has not landed (or its read is not yet consistent).
  getBattleOutcome.mockReset().mockResolvedValue(null);
  recordBattleOutcome.mockReset().mockResolvedValue(undefined);
});

describe('BattleScorecard — pick survives a remount', () => {
  it('shows the pick pressed when remounted with the parent-held winner', async () => {
    // A fresh instance, exactly as React builds after the scorecard moves to another message.
    render(
      <BattleScorecard
        battleId={BATTLE_ID}
        channelArn={ARN}
        variantA={VARIANT_A}
        variantB={VARIANT_B}
        knownWinner="B"
      />,
    );

    // Pressed IMMEDIATELY — not after a refetch, which is the thing that could not be relied on.
    expect(pickButton('B').getAttribute('aria-pressed')).toBe('true');

    // And it stays pressed once the mount fetch resolves with nothing, which is the actual failure
    // mode: the fetch returning "no pick" must not un-press a pick the parent knows about.
    await waitFor(() => expect(getBattleOutcome).toHaveBeenCalled());
    expect(pickButton('B').getAttribute('aria-pressed')).toBe('true');
  });

  it('renders unpicked when the parent knows of no pick', async () => {
    // The guard against over-correcting: seeding must not press a button nobody chose.
    render(
      <BattleScorecard battleId={BATTLE_ID} channelArn={ARN} variantA={VARIANT_A} variantB={VARIANT_B} />,
    );

    await waitFor(() => expect(getBattleOutcome).toHaveBeenCalled());
    expect(pickButton('A').getAttribute('aria-pressed')).toBe('false');
    expect(pickButton('B').getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the pick to the parent so the durable copy exists to seed from', async () => {
    const onOutcomeChange = vi.fn();
    render(
      <BattleScorecard
        battleId={BATTLE_ID}
        channelArn={ARN}
        variantA={VARIANT_A}
        variantB={VARIANT_B}
        onOutcomeChange={onOutcomeChange}
      />,
    );

    fireEvent.click(pickButton('A'));

    // Optimistic: pressed before the POST resolves.
    expect(pickButton('A').getAttribute('aria-pressed')).toBe('true');
    // The parent is told immediately — if this only fired after the POST, a remount in between would
    // still lose the pick, and the seeding above would have nothing to read.
    expect(onOutcomeChange).toHaveBeenCalledWith(BATTLE_ID, 'A');
    await waitFor(() => expect(recordBattleOutcome).toHaveBeenCalledWith(BATTLE_ID, 'A', ARN));
  });
});
