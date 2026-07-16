/**
 * BattleTallyBar — the live, conversation-wide /battle tally
 * (SPEC-BATTLE.md "Battle Objectives", objective 2).
 *
 * Sits above the message stream while a conversation has battle rounds and
 * updates in real time as each round is answered and the user picks a winner.
 * It is the fast counterpart to the admin Experiments tab's per-variant
 * battle_wins column: the same picks, surfaced live to the person making them.
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

const BattleTallyBar: React.FC<{ tally: BattleTally }> = ({ tally }) => {
  const { t } = useTranslation();
  const { sides, totalRounds, pickedRounds, ties, target } = tally;
  if (totalRounds === 0) return null;

  const progressPct = Math.min(100, Math.round((pickedRounds / target) * 100));
  const confident = pickedRounds >= target;

  const leaderChip = (labelKey: string, defLabel: string, who: string | null) => (
    <span className={`battle-tally-chip${who ? ' battle-tally-chip--set' : ''}`}>
      <span className="battle-tally-chip-key">{t(labelKey, { defaultValue: defLabel })}</span>
      <span className="battle-tally-chip-val">{who ?? '—'}</span>
    </span>
  );

  return (
    <div
      className="battle-tally"
      role="status"
      aria-live="polite"
      aria-label={t('battle.tally.title', { defaultValue: 'Battle tally' })}
    >
      <div className="battle-tally-head">
        <span className="battle-tally-title">
          <span aria-hidden="true">⚔ </span>
          {t('battle.tally.title', { defaultValue: 'Battle tally' })}
        </span>
        <span className="battle-tally-rounds">
          {t('battle.tally.roundsPicked', {
            defaultValue: `${pickedRounds} of ${totalRounds} rounds picked`,
            picked: pickedRounds,
            total: totalRounds,
          })}
        </span>
      </div>

      <div className="battle-tally-sides">
        {sides.map((s) => {
          const leading = tally.qualityLeaderLabel === s.label;
          return (
            <div key={s.label} className={`battle-tally-side${leading ? ' battle-tally-side--leading' : ''}`}>
              <span className="battle-tally-side-label">{s.label}</span>
              <span className="battle-tally-side-wins">
                {t('battle.tally.wins', { defaultValue: `${s.wins} wins`, count: s.wins })}
              </span>
              <span className="battle-tally-side-meta">
                {formatMs(s.avgResponseMs)} · {formatCost(s.avgCostUsd)}
              </span>
            </div>
          );
        })}
        {ties > 0 && (
          <div className="battle-tally-ties">
            {t('battle.tally.ties', { defaultValue: `${ties} ties`, count: ties })}
          </div>
        )}
      </div>

      <div className="battle-tally-leaders">
        {leaderChip('battle.tally.faster', 'Faster', tally.speedLeaderLabel)}
        {leaderChip('battle.tally.cheaper', 'Cheaper', tally.costLeaderLabel)}
        {leaderChip('battle.tally.preferred', 'Preferred', tally.qualityLeaderLabel)}
      </div>

      <div className="battle-tally-progress">
        <div className="battle-tally-progress-track">
          <div className="battle-tally-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="battle-tally-progress-caption">
          {confident
            ? t('battle.tally.confident', {
                defaultValue: `${pickedRounds} picks — a confident call`,
                picked: pickedRounds,
              })
            : t('battle.tally.progress', {
                defaultValue: `${pickedRounds} / ${target} picks toward a confident call`,
                picked: pickedRounds,
                target,
              })}
        </span>
      </div>
    </div>
  );
};

export default BattleTallyBar;
