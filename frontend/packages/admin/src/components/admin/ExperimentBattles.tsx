/**
 * BATTLES: AN EXPERIMENT'S SUB-RESULTS, ON THE EXPERIMENT'S PAGE.
 *
 * An experiment has a goal and results. When Battle Mode is on, a person in a conversation can also run a
 * battle: both of the experiment's versions answer over a few turns and the person picks the better one.
 * Each battle is a small result of its own under the experiment, so this section reads them where the
 * experiment is, and nowhere else.
 *
 * It holds three things, in the order a reader asks for them: who is winning (one sentence), how each
 * version did across the battles (wins, share of picks, quality and cost per reply), and each battle as a
 * row. A battle happened in a conversation, and the conversation is where its answers and its pick are,
 * so a row opens that conversation at the /battle message that started the battle, rather than restating
 * it here.
 *
 * The A/B numbers from real traffic are the experiment's Results, above this section, so none are repeated
 * here: a battle is chosen by a person rather than assigned, and the two populations are kept apart.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { classificationName, modelDisplayName } from '@ae/shared';
import type {
  AnalyticsDateRange,
  BattleEffectivenessRow,
  BattleResultRow,
  Experiment,
} from '@ae/shared';
import { InfoTooltip } from './AdminHelp';
import { duelSideName, versionLabelOf, versionRoleOf } from './experimentControl';
import { queryAnalytics } from '../../services/analyticsService';
import type { MessageLink } from './messageLink';

/** The most battles one read lists. The section says so when it reaches it, so a long window is never read as complete. */
export const BATTLE_LIST_LIMIT = 100;

/**
 * One row per (experiment, version), summed back from the rollup's per-dimension rows.
 *
 * The backend groups battle turns by `(experiment, variant, room, assistant, role, version)`, and splits a
 * version's wins across those rows so the column never exceeds the battles fought. This sums them: turns,
 * battles and wins add; quality and cost are weighted by turns, and a row with no score contributes nothing
 * rather than a zero, so a wholly unscored version stays null. A dimension that differs across the summed rows
 * is blanked rather than shown as one slice's.
 */
export function collapseByVariant(rows: BattleEffectivenessRow[]): BattleEffectivenessRow[] {
  const byVariant = new Map<string, BattleEffectivenessRow & { _scoredTurns: number; _costTurns: number }>();
  for (const r of rows) {
    const key = `${r.experiment_id}::${r.variant_id}`;
    const acc = byVariant.get(key);
    if (!acc) {
      byVariant.set(key, {
        ...r,
        avg_score: r.avg_score == null ? null : r.avg_score * r.turn_count,
        avg_cost_usd: r.avg_cost_usd == null ? null : r.avg_cost_usd * r.turn_count,
        _scoredTurns: r.avg_score == null ? 0 : r.turn_count,
        _costTurns: r.avg_cost_usd == null ? 0 : r.turn_count,
      });
      continue;
    }
    acc.turn_count += r.turn_count;
    acc.battle_count += r.battle_count;
    if (r.battle_wins != null) acc.battle_wins = (acc.battle_wins ?? 0) + r.battle_wins;
    if (r.avg_score != null) {
      acc.avg_score = (acc.avg_score ?? 0) + r.avg_score * r.turn_count;
      acc._scoredTurns += r.turn_count;
    }
    if (r.avg_cost_usd != null) {
      acc.avg_cost_usd = (acc.avg_cost_usd ?? 0) + r.avg_cost_usd * r.turn_count;
      acc._costTurns += r.turn_count;
    }
    if (acc.conversation_classification !== r.conversation_classification) acc.conversation_classification = null;
    if (acc.assistant !== r.assistant) acc.assistant = null;
    if (acc.assistant_role !== r.assistant_role) acc.assistant_role = null;
    if (acc.profile_version !== r.profile_version) acc.profile_version = null;
  }
  return [...byVariant.values()].map(({ _scoredTurns, _costTurns, ...r }) => ({
    ...r,
    avg_score: _scoredTurns > 0 && r.avg_score != null ? Math.round((r.avg_score / _scoredTurns) * 10) / 10 : null,
    avg_cost_usd: _costTurns > 0 && r.avg_cost_usd != null ? r.avg_cost_usd / _costTurns : null,
  }));
}

/**
 * An experiment's battle count from its rollup rows. Both versions answer in every battle, so the larger
 * version count is the battle count. Null when the experiment ran none.
 */
export function battleSummaryOf(
  rows: BattleEffectivenessRow[],
  experimentId: string,
): { battles: number; wins: Array<{ variantId: string; wins: number }> } | null {
  const sides = collapseByVariant(rows.filter((r) => r.experiment_id === experimentId));
  if (sides.length === 0) return null;
  return {
    battles: Math.max(...sides.map((s) => s.battle_count)),
    wins: sides.map((s) => ({ variantId: s.variant_id, wins: s.battle_wins ?? 0 })),
  };
}

/** How a list of battles came out: each version's wins, the ties, and the battles nobody has picked yet. */
export function tallyBattles(battles: BattleResultRow[]): { total: number; wins: Map<string, number>; ties: number; notPicked: number } {
  const wins = new Map<string, number>();
  let ties = 0;
  let notPicked = 0;
  for (const b of battles) {
    if (b.winner_variant_id === null) notPicked += 1;
    else if (b.winner_variant_id === 'tie') ties += 1;
    else wins.set(b.winner_variant_id, (wins.get(b.winner_variant_id) ?? 0) + 1);
  }
  return { total: battles.length, wins, ties, notPicked };
}

interface ExperimentBattlesProps {
  dateRange: AnalyticsDateRange;
  experiment: Experiment;
  /** The experiment's battle rollup (`experiment_results.battleEffectiveness`), for the per-version numbers. */
  rollup: BattleEffectivenessRow[];
  /** Opens the conversation, at the message given when there is one. */
  onOpenConversation?: (channelArn: string, message?: MessageLink) => void;
}

const dash = '—';
const fmtCost = (v: number | null | undefined): string => (v == null ? dash : `$${v.toFixed(4)}`);
const fmtWhen = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : dash);

/** A column heading with a one-line tooltip saying what the column counts. */
const Heading: React.FC<{ label: string; help: string }> = ({ label, help }) => (
  <>
    {label}
    <InfoTooltip label={label} content={help} />
  </>
);

const ExperimentBattles: React.FC<ExperimentBattlesProps> = ({ dateRange, experiment, rollup, onOpenConversation }) => {
  const { t } = useTranslation();
  const experimentId = experiment.experimentId;
  const [battles, setBattles] = useState<BattleResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    queryAnalytics('battle_results', dateRange, { experimentId, limit: String(BATTLE_LIST_LIMIT) })
      .then((res) => {
        if (cancelled) return;
        const rows = (res?.data as unknown as BattleResultRow[]) || [];
        setBattles(rows.filter((r) => r.experiment_id === experimentId));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t('admin.battles.couldNotLoad'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange, experimentId]);

  const versions = useMemo(
    () => collapseByVariant(rollup.filter((r) => r.experiment_id === experimentId))
      // Control first, then the challenger, whatever order the rollup arrived in.
      .sort((a, b) => (versionRoleOf(experiment, a.variant_id) === 'control' ? -1 : versionRoleOf(experiment, b.variant_id) === 'control' ? 1 : 0)),
    [rollup, experimentId, experiment],
  );
  const picksTotal = versions.reduce((a, s) => a + (s.battle_wins ?? 0), 0);

  /** "Challenger" or "Control", the experiment's own words for a version. */
  const roleWord = (variantId: string): string => {
    const role = versionRoleOf(experiment, variantId);
    return role ? t(`admin.battles.role.${role}`) : variantId;
  };
  /** The version's name and number as the room showed them: `Atlas (alt) · v13`. */
  const versionDetail = (variantId: string): string => {
    const name = duelSideName(experiment, variantId);
    const label = versionLabelOf(experiment, variantId, modelDisplayName);
    return [name, label !== variantId ? label : null].filter(Boolean).join(' · ');
  };

  const tally = tallyBattles(battles);
  const summary = (() => {
    if (tally.total === 0) return null;
    const ranked = [...tally.wins.entries()].sort((a, b) => b[1] - a[1]);
    const parts: string[] = [];
    if (ranked.length === 0) {
      parts.push(t('admin.battles.summary.nonePicked', { count: tally.total }));
    } else if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
      parts.push(t('admin.battles.summary.even', { wins: ranked[0][1], count: tally.total }));
    } else {
      parts.push(t('admin.battles.summary.leads', { name: roleWord(ranked[0][0]), wins: ranked[0][1], count: tally.total }));
    }
    if (tally.ties > 0) parts.push(t('admin.battles.summary.ties', { count: tally.ties }));
    if (tally.notPicked > 0 && ranked.length > 0) parts.push(t('admin.battles.summary.notPicked', { count: tally.notPicked }));
    return parts.join('; ');
  })();

  const outcomeText = (b: BattleResultRow): string => {
    if (b.winner_variant_id === null) return t('admin.battles.outcome.notPicked');
    if (b.winner_variant_id === 'tie') return t('admin.battles.outcome.tie');
    return t('admin.battles.outcome.won', { name: roleWord(b.winner_variant_id) });
  };
  const outcomeTone = (b: BattleResultRow): string =>
    (b.winner_variant_id === null ? '' : b.winner_variant_id === 'tie' ? ' status-badge--info' : ' status-badge--success');

  /**
   * A battle opens the conversation it ran in, through the console's own conversation view, at the /battle
   * message that started it. The time rides along, so the viewer can open near it when the message is gone.
   */
  const open = (b: BattleResultRow) => {
    if (!b.channel_arn || !onOpenConversation) return;
    onOpenConversation(String(b.channel_arn), {
      messageId: b.start_message_id ?? null,
      at: b.started_at ?? b.fought_at ?? null,
      kind: 'battle',
    });
  };

  return (
    <section className="admin-section" data-testid="experiment-battles" aria-labelledby="experiment-battles-title">
      <h4 id="experiment-battles-title">{t('admin.battles.title')}</h4>
      <p className="admin-tab-description">{t('admin.battles.help')}</p>

      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      {loading && <p className="admin-tab-description" role="status">{t('admin.battles.loading')}</p>}

      {!loading && !error && tally.total === 0 && versions.length === 0 && (
        <p className="admin-tab-description" data-testid="battles-empty">
          {t('admin.battles.empty', { classification: classificationName(experiment.tiers?.[0] ?? '') })}
        </p>
      )}

      {!loading && !error && (tally.total > 0 || versions.length > 0) && (
        <>
          {summary && <p className="battle-summary" data-testid="battles-summary"><strong>{summary}</strong></p>}

          <h5>{t('admin.battles.byVersion')}</h5>
          <p className="admin-tab-description">{t('admin.battles.byVersionHelp')}</p>
          <div className="data-table-wrapper">
            <table className="data-table" data-testid="battles-by-version">
              <thead>
                <tr>
                  <th><Heading label={t('admin.battles.col.version')} help={t('admin.battles.col.versionHelp')} /></th>
                  <th><Heading label={t('admin.battles.col.won')} help={t('admin.battles.col.wonHelp')} /></th>
                  <th><Heading label={t('admin.battles.col.quality')} help={t('admin.battles.col.qualityHelp')} /></th>
                  <th><Heading label={t('admin.battles.col.cost')} help={t('admin.battles.col.costHelp')} /></th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.variant_id}>
                    <td data-col="version" data-label={t('admin.battles.col.version')}>
                      <strong>{roleWord(v.variant_id)}</strong>
                      {versionDetail(v.variant_id) && <div className="admin-field-hint">{versionDetail(v.variant_id)}</div>}
                    </td>
                    <td data-col="won" data-label={t('admin.battles.col.won')}>
                      {picksTotal > 0
                        ? t('admin.battles.wonOf', { wins: v.battle_wins ?? 0, pct: Math.round(((v.battle_wins ?? 0) / picksTotal) * 100) })
                        : t('admin.battles.noPicks')}
                    </td>
                    <td data-col="quality" data-label={t('admin.battles.col.quality')}>{v.avg_score == null ? dash : String(v.avg_score)}</td>
                    <td data-col="cost" data-label={t('admin.battles.col.cost')}>{fmtCost(v.avg_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h5>{t('admin.battles.eachBattle')}</h5>
          <p className="admin-tab-description">{t('admin.battles.eachBattleHelp')}</p>
          {battles.length === 0 ? (
            <p className="admin-tab-description">{t('admin.battles.noneListed')}</p>
          ) : (
            <div className="data-table-wrapper">
              <table className={['data-table', 'data-table--rows-clickable'].join(' ')} data-testid="battles-list">
                <thead>
                  <tr>
                    <th><Heading label={t('admin.battles.col.when')} help={t('admin.battles.col.whenHelp')} /></th>
                    <th>{t('admin.battles.col.room')}</th>
                    <th>{t('admin.battles.col.outcome')}</th>
                    <th>{t('admin.battles.col.pickedBy')}</th>
                    <th>{t('admin.battles.col.conversation')}</th>
                  </tr>
                </thead>
                <tbody>
                  {battles.map((b) => {
                    const canOpen = Boolean(b.channel_arn && onOpenConversation);
                    return (
                      <tr
                        key={b.battle_id}
                        className={canOpen ? 'data-table-row--clickable' : ''}
                        data-testid="battle-row"
                        tabIndex={canOpen ? 0 : undefined}
                        onClick={canOpen ? (e) => {
                          if ((e.target as HTMLElement).closest('button,a')) return;
                          open(b);
                        } : undefined}
                        onKeyDown={canOpen ? (e) => {
                          if (e.currentTarget !== e.target) return;
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(b); }
                        } : undefined}
                      >
                        <td data-col="when" data-label={t('admin.battles.col.when')}>{fmtWhen(b.started_at ?? b.fought_at)}</td>
                        <td data-col="room" data-label={t('admin.battles.col.room')}>
                          {b.conversation_classification ? classificationName(b.conversation_classification) : dash}
                        </td>
                        <td data-col="outcome" data-label={t('admin.battles.col.outcome')}>
                          <span className={`status-badge${outcomeTone(b)}`}>{outcomeText(b)}</span>
                        </td>
                        <td data-col="pickedBy" data-label={t('admin.battles.col.pickedBy')}>
                          {b.vote_count > 0 ? t('admin.battles.outcome.people', { count: b.vote_count }) : dash}
                        </td>
                        <td data-col="conversation" data-label={t('admin.battles.col.conversation')}>
                          {canOpen ? (
                            <button type="button" className="btn-link" onClick={() => open(b)}>
                              {t('admin.battles.openConversation')}
                            </button>
                          ) : dash}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {battles.length >= BATTLE_LIST_LIMIT && (
            <p className="admin-field-hint">{t('admin.battles.listLimited', { n: BATTLE_LIST_LIMIT })}</p>
          )}
        </>
      )}
    </section>
  );
};

export default ExperimentBattles;
