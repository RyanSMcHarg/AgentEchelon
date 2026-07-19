/**
 * BattleScorecard — the inline 3-axis scorecard rendered under a battle
 * pair (SPEC-BATTLE.md §"Battle Scoring & Per-Step Telemetry").
 *
 *   Response time | Est. cost | Quality (you pick the winner)
 *
 * No composite score — the reader weighs the trade-off themselves.
 * Response time / est. cost come from the compact per-variant summary
 * on each round-1 message (populated by the emission-wiring work);
 * until that lands they render "—" honestly rather than a fabricated
 * number. The Quality axis (pick-the-winner) is fully live now: it
 * reads/writes the BattleOutcome API.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getBattleOutcome,
  recordBattleOutcome,
  type BattleWinner,
} from '../services/battleOutcomeService';
import { INTENT_STRATEGY_CARDS, getModelStrategyLookup } from '@ae/shared';
import './BattleScorecard.css';

export interface ScorecardVariant {
  /** Header label — the bot's stable Chime name (e.g. "AltSlotO" /
   *  "Assistant"). The persistent assistant principal identity. */
  label: string;
  /** Admin-set persona (e.g. "Atlas" / "Echo"). Shown as a small
   *  subtitle under the Chime name; not the primary identifier. */
  persona?: string;
  /** Classified intent for the current turn — surfaced in the config
   *  inspector and per-step rows so the user can see which intent
   *  triggered which model. */
  intent?: string;
  modelId?: string;
  responseMs?: number;
  estCostUsd?: number | null;
  steps?: Array<{
    stepLabel: string;
    modelId: string;
    durationMs?: number;
    /** Human-readable model label per step ('Claude Sonnet 4.6', 'Amazon
     *  Nova Canvas'). Models can vary per step within a variant, so this
     *  is the authoritative "what's actually running" for the step. */
    modelLabel?: string;
    /** Per-step model provider ('anthropic', 'amazon', 'openai') — tooltip. */
    provider?: string;
  }>;
  /** Cost-breakdown inputs from the battlestats marker. The cost
   *  axis cell shows total + a small derivation line ('1,234 in /
   *  987 out tokens' for text, '2 images' for generation-out). */
  tokensIn?: number;
  tokensOut?: number;
  imageCount?: number;
}

interface BattleScorecardProps {
  battleId: string;
  /** Active conversation's channel ARN — required by the outcome API's
   *  membership check when recording a pick. */
  channelArn: string;
  variantA: ScorecardVariant; // control
  variantB: ScorecardVariant; // treatment
  /** Reports this round's pick (or null when none yet) up to the parent so it
   *  can keep a live conversation-wide tally (SPEC-BATTLE Battle Objectives,
   *  objective 2). Fired on initial load, on a pick, and on rollback. */
  onOutcomeChange?: (battleId: string, winner: BattleWinner | null) => void;
}

function formatMs(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatCost(c?: number | null): string {
  if (c == null) return '—';
  return `$${c.toFixed(c < 0.01 ? 4 : 3)}`;
}

/** Honest cost-breakdown subtext: the INPUTS the total was derived from
 *  (tokens for text battles, image count for generation-out). Absent
 *  when no input data was carried — never fabricated. */
function breakdownOf(v: ScorecardVariant): string | null {
  if (v.imageCount != null && v.imageCount > 0) {
    return v.imageCount === 1 ? '1 image' : `${v.imageCount} images`;
  }
  if (v.tokensIn != null || v.tokensOut != null) {
    const fmt = (n?: number) => (n == null ? '0' : n.toLocaleString());
    return `${fmt(v.tokensIn)} in / ${fmt(v.tokensOut)} out tokens`;
  }
  return null;
}

const BattleScorecard: React.FC<BattleScorecardProps> = ({ battleId, channelArn, variantA, variantB, onOutcomeChange }) => {
  const { t } = useTranslation();
  const [winner, setWinner] = useState<BattleWinner | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBattleOutcome(battleId)
      .then((o) => {
        if (!cancelled && o) {
          setWinner(o.winner);
          onOutcomeChange?.(battleId, o.winner);
        }
      })
      .catch(() => {
        /* no recorded pick / unavailable — leave unset, not an error state */
      });
    return () => {
      cancelled = true;
    };
    // onOutcomeChange is a stable useCallback in the parent; intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battleId]);

  const pick = useCallback(
    async (choice: BattleWinner) => {
      const previous = winner;
      setWinner(choice); // optimistic
      onOutcomeChange?.(battleId, choice); // optimistic tally update
      setBusy(true);
      setError(null);
      try {
        await recordBattleOutcome(battleId, choice, channelArn);
      } catch (err) {
        setWinner(previous); // roll back
        onOutcomeChange?.(battleId, previous); // roll back the tally too
        setError(err instanceof Error ? err.message : 'Could not record your pick');
      } finally {
        setBusy(false);
      }
    },
    [battleId, winner, channelArn, onOutcomeChange],
  );

  const hasSteps = (variantA.steps?.length ?? 0) > 0 || (variantB.steps?.length ?? 0) > 0;

  const pickBtn = (choice: BattleWinner, label: string) => (
    <button
      type="button"
      className={`battle-scorecard-pick-btn${winner === choice ? ' is-chosen' : ''}`}
      data-pick={choice}
      aria-pressed={winner === choice}
      disabled={busy}
      onClick={() => pick(choice)}
    >
      {label}
    </button>
  );

  return (
    <div className="battle-scorecard" role="group" aria-label={t('battle.scorecard.title', { defaultValue: 'Battle scorecard' })}>
      <div className="battle-scorecard-grid">
        <div className="battle-scorecard-corner" />
        <div className="battle-scorecard-head">
          <span className="battle-scorecard-head-name">{variantA.label}</span>
          {variantA.persona ? (
            <span className="battle-scorecard-head-persona">{variantA.persona}</span>
          ) : null}
        </div>
        <div className="battle-scorecard-head">
          <span className="battle-scorecard-head-name">{variantB.label}</span>
          {variantB.persona ? (
            <span className="battle-scorecard-head-persona">{variantB.persona}</span>
          ) : null}
        </div>

        <div className="battle-scorecard-axis">
          {t('battle.scorecard.responseTime', { defaultValue: 'Response time' })}
        </div>
        <div className="battle-scorecard-cell">{formatMs(variantA.responseMs)}</div>
        <div className="battle-scorecard-cell">{formatMs(variantB.responseMs)}</div>

        <div className="battle-scorecard-axis">
          {t('battle.scorecard.estCost', { defaultValue: 'Est. cost' })}
          <span
            className="battle-scorecard-info"
            title={t('battle.scorecard.costTooltip', {
              defaultValue: 'Estimate from published model rates — not a bill.',
            })}
            aria-hidden="true"
          >
            ⓘ
          </span>
        </div>
        <div className="battle-scorecard-cell">
          {formatCost(variantA.estCostUsd)}
          {breakdownOf(variantA) && (
            <div className="battle-scorecard-cell-sub">{breakdownOf(variantA)}</div>
          )}
        </div>
        <div className="battle-scorecard-cell">
          {formatCost(variantB.estCostUsd)}
          {breakdownOf(variantB) && (
            <div className="battle-scorecard-cell-sub">{breakdownOf(variantB)}</div>
          )}
        </div>

        <div className="battle-scorecard-axis">
          {t('battle.scorecard.quality', { defaultValue: 'Quality — you decide' })}
        </div>
        <div className="battle-scorecard-pick" role="group">
          {pickBtn(
            'A',
            t('battle.scorecard.variantBetter', {
              defaultValue: `${variantA.label} better`,
              name: variantA.label,
            }),
          )}
          {pickBtn('tie', t('battle.scorecard.tie', { defaultValue: 'Tie' }))}
          {pickBtn(
            'B',
            t('battle.scorecard.variantBetter', {
              defaultValue: `${variantB.label} better`,
              name: variantB.label,
            }),
          )}
        </div>
      </div>

      {error && (
        <div className="battle-scorecard-error" role="alert">
          {error}
        </div>
      )}

      {hasSteps && (
        <div className="battle-scorecard-steps-wrap">
          <button
            type="button"
            className="battle-scorecard-steps-toggle"
            aria-expanded={showSteps}
            onClick={() => setShowSteps((v) => !v)}
          >
            {showSteps
              ? t('battle.scorecard.hideSteps', { defaultValue: 'Hide steps' })
              : t('battle.scorecard.showSteps', { defaultValue: 'Show steps' })}
          </button>
          {showSteps && (
            <div className="battle-scorecard-steps">
              {[
                { label: variantA.label, steps: variantA.steps ?? [] },
                { label: variantB.label, steps: variantB.steps ?? [] },
              ].map((v) => (
                <div key={v.label} className="battle-scorecard-steps-col">
                  <div className="battle-scorecard-steps-col-head">{v.label}</div>
                  {v.steps.length === 0 ? (
                    <div className="battle-scorecard-step battle-scorecard-step--empty">—</div>
                  ) : (
                    v.steps.map((s, i) => (
                      <div key={`${s.stepLabel}-${i}`} className="battle-scorecard-step">
                        <span className="battle-scorecard-step-label">{s.stepLabel}</span>
                        <span
                          className="battle-scorecard-step-model"
                          title={`${s.modelLabel || s.modelId}${s.provider ? ` · ${s.provider}` : ''}\n${s.modelId}`}
                        >
                          {s.modelLabel || s.modelId}
                        </span>
                        <span className="battle-scorecard-step-dur">{formatMs(s.durationMs)}</span>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Config inspector: people configure assistants to use different
          models per intent. This expander shows what each assistant is
          CONFIGURED for; the steps expander above shows what actually
          ran for this turn. */}
      <div className="battle-scorecard-config-wrap">
        <button
          type="button"
          className="battle-scorecard-steps-toggle"
          aria-expanded={showConfig}
          onClick={() => setShowConfig((v) => !v)}
        >
          {showConfig ? 'Hide config' : 'Show config'}
        </button>
        {showConfig && (
          <div className="battle-scorecard-config">
            <div className="battle-scorecard-config-note">
              Per-intent model routing (premium tier). Battle Mode binds an
              experiment variant which can override one intent's model for
              the duel; the steps expander above shows the model that
              actually ran for this turn{variantA.intent ? ` (classified: ${variantA.intent})` : ''}.
            </div>
            <div className="battle-scorecard-config-table">
              <div className="battle-scorecard-config-row battle-scorecard-config-row--head">
                <span>Intent</span>
                <span>Primary</span>
                <span>Fallback</span>
              </div>
              {INTENT_STRATEGY_CARDS.map((card) => {
                const lookup = getModelStrategyLookup();
                const primaryLabel = lookup[card.primaryModel]?.displayName ?? card.primaryModel;
                const fallbackLabel = lookup[card.fallbackModel]?.displayName ?? card.fallbackModel;
                const isCurrent = card.intent === variantA.intent;
                return (
                  <div
                    key={card.intent}
                    className={`battle-scorecard-config-row${isCurrent ? ' battle-scorecard-config-row--current' : ''}`}
                    title={card.rationale}
                  >
                    <span>{card.label}</span>
                    <span>{primaryLabel}</span>
                    <span>{fallbackLabel}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BattleScorecard;
