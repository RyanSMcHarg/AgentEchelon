/**
 * BattleTallyBar — the per-battle result card (SPEC-BATTLE.md "Battle
 * Objectives", objective 2).
 *
 * Rendered INLINE at the end of each battle, once both rounds (the initial
 * answers and the round-2 rebuttal) are in. Each /battle prompt is scored on
 * its own: this card shows only THAT battle's A-vs-B result (speed, cost, and
 * which side you picked). The next prompt renders its own fresh card below, so
 * the stream reads as a sequence of independent battle results rather than one
 * floating running total. It is the fast counterpart to the admin Experiments
 * tab's per-variant battle_wins column: the same picks, surfaced live.
 *
 * All numbers are honest: a leader chip only shows once a side is actually
 * ahead on that axis (and both sides have data); otherwise it reads "—".
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BattleTally } from '../utils/battleTally';
import './BattleTallyBar.css';

function formatMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatCost(c: number | null): string {
  if (c == null) return '—';
  return `$${c.toFixed(c < 0.01 ? 4 : 3)}`;
}

const BattleTallyBar: React.FC<{ tally: BattleTally; inline?: boolean }> = ({ tally, inline = false }) => {
  const { t } = useTranslation();
  const { sides, totalRounds, pickedRounds, ties } = tally;
  if (totalRounds === 0) return null;

  // Single-battle result: the winner is the picked side (qualityLeaderLabel); a tie or an
  // unscored battle highlights neither. The right-hand status reflects the pick state.
  const winner = tally.qualityLeaderLabel;
  const pickStatus =
    ties > 0
      ? t('battle.tally.calledTie', { defaultValue: 'You called it a tie' })
      : winner
        ? t('battle.tally.youPicked', { defaultValue: `You picked ${winner}`, label: winner })
        : pickedRounds > 0
          ? t('battle.tally.scored', { defaultValue: 'Scored' })
          : t('battle.tally.awaitingPick', { defaultValue: 'Pick a winner above' });

  const leaderChip = (labelKey: string, defLabel: string, who: string | null) => (
    <span className={`battle-tally-chip${who ? ' battle-tally-chip--set' : ''}`}>
      <span className="battle-tally-chip-key">{t(labelKey, { defaultValue: defLabel })}</span>
      <span className="battle-tally-chip-val">{who ?? '—'}</span>
    </span>
  );

  return (
    <div
      className={`battle-tally${inline ? ' battle-tally--inline' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={t('battle.tally.title', { defaultValue: 'Battle result' })}
    >
      <div className="battle-tally-head">
        <span className="battle-tally-title">
          <span aria-hidden="true">⚔ </span>
          {t('battle.tally.thisBattle', { defaultValue: 'This battle' })}
        </span>
        <span className={`battle-tally-rounds${winner ? ' battle-tally-rounds--decided' : ''}`}>
          {pickStatus}
        </span>
      </div>

      <div className="battle-tally-sides">
        {sides.map((s) => {
          const leading = winner === s.label;
          return (
            <div key={s.label} className={`battle-tally-side${leading ? ' battle-tally-side--leading' : ''}`}>
              <span className="battle-tally-side-label">
                {s.label}
                {leading && (
                  <span className="battle-tally-side-pick">
                    {' '}◄ {t('battle.tally.pick', { defaultValue: 'your pick' })}
                  </span>
                )}
              </span>
              <span className="battle-tally-side-meta">
                {formatMs(s.avgResponseMs)} · {formatCost(s.avgCostUsd)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="battle-tally-leaders">
        {leaderChip('battle.tally.faster', 'Faster', tally.speedLeaderLabel)}
        {leaderChip('battle.tally.cheaper', 'Cheaper', tally.costLeaderLabel)}
      </div>
    </div>
  );
};

export default BattleTallyBar;
