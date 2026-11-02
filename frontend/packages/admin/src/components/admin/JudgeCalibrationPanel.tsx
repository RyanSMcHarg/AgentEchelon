import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const n = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (v: unknown): string => (n(v) == null ? '—' : `${Math.round(n(v)! * 100)}%`);
const kappaText = (v: unknown): string => (n(v) == null ? '—' : n(v)!.toFixed(2));

/** The key a judge row and the people row it is compared with share. */
const keyOf = (r: Row) => `${r.rubric}|${r.assistant}|${r.conversation_classification}`;

/**
 * HOW FAR EACH JUDGE AGREES WITH PEOPLE (SPEC-EVALUATION Appendix C4).
 *
 * From `judge_calibration`: per rubric and assistant instance, the agreement between the judge and
 * people's labels as Cohen's kappa, the share of failures the judge caught and the share of good answers
 * it passed, with how many labels it rests on; beside it, how far two people agree on the same items.
 * A row per judge model and rubric version, so a change of either reads as a new line. A judge that
 * judged answers it wrote itself is called out. Battle picks are a fourth source, read from
 * `pairwise_agreement`.
 */
const JudgeCalibrationPanel: React.FC<{ dateRange?: AnalyticsDateRange }> = ({ dateRange }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picks, setPicks] = useState<{ rate: number | null; compared: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    Promise.resolve()
      .then(() => Promise.all([
        queryAnalytics('judge_calibration', dateRange),
        queryAnalytics('pairwise_agreement', dateRange).catch(() => null),
      ]))
      .then(([cal, pw]) => {
        if (cancelled) return;
        setRows((cal?.data ?? []) as Row[]);
        const p = pw as unknown as { agreementRate?: number | null; comparedCount?: number } | null;
        setPicks(p ? { rate: p.agreementRate ?? null, compared: Number(p.comparedCount ?? 0) } : null);
      })
      .catch(() => { if (!cancelled) setError(t('admin.judgeCalibration.error')); });
    return () => { cancelled = true; };
  }, [dateRange, t]);

  const judge = (rows ?? []).filter((r) => r.dimension === 'judge');
  const people = new Map((rows ?? []).filter((r) => r.dimension === 'people').map((r) => [keyOf(r), r]));
  const self = (rows ?? []).filter((r) => r.dimension === 'self' && (n(r.self_judged) ?? 0) > 0);

  return (
    <div className="admin-section" role="region" aria-label={t('admin.judgeCalibration.title')}>
      <h4>
        {t('admin.judgeCalibration.title')}{' '}
        <InfoTooltip label={t('admin.judgeCalibration.title')} content={t('admin.judgeCalibration.tip')} />
      </h4>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.judgeCalibration.loading')}</p>}
      {!error && rows !== null && judge.length === 0 && <p className="admin-tab-empty">{t('admin.judgeCalibration.empty')}</p>}
      {self.map((r) => (
        <p key={`${r.assistant}|${r.evaluator_model}`} className="admin-info-banner" role="note">
          {t('admin.judgeCalibration.selfJudged', { count: n(r.self_judged) ?? 0, judged: n(r.judged) ?? 0, assistant: String(r.assistant ?? '—'), model: String(r.evaluator_model ?? '—') })}
        </p>
      ))}
      {judge.length > 0 && (
        <DataTable
          data={judge}
          columns={[
            { key: 'rubric', label: t('admin.judgeCalibration.column.rubric'), render: (v: unknown) => <strong>{t(`admin.judgeCalibration.rubric.${String(v)}`)}</strong> },
            { key: 'assistant', label: t('admin.judgeCalibration.column.assistant') },
            { key: 'conversation_classification', label: t('admin.judgeCalibration.column.classification') },
            {
              key: 'evaluator_model',
              label: t('admin.judgeCalibration.column.judge'),
              render: (v: unknown, row: Row) => <span title={String(row.version ?? '')}>{String(v ?? '—')}</span>,
            },
            { key: 'n', label: t('admin.judgeCalibration.column.labels'), sortable: true },
            { key: 'kappa', label: t('admin.judgeCalibration.column.kappa'), sortable: true, render: (v: unknown) => kappaText(v) },
            { key: 'tpr', label: t('admin.judgeCalibration.column.caught'), render: (v: unknown) => pct(v) },
            { key: 'tnr', label: t('admin.judgeCalibration.column.passed'), render: (v: unknown) => pct(v) },
            {
              key: 'people',
              label: t('admin.judgeCalibration.column.people'),
              render: (_v: unknown, row: Row) => {
                const p = people.get(keyOf(row));
                return p && (n(p.n) ?? 0) > 0
                  ? t('admin.judgeCalibration.peopleKappa', { kappa: kappaText(p.kappa), count: n(p.n) ?? 0 })
                  : '—';
              },
            },
          ]}
        />
      )}
      {picks && picks.compared > 0 && (
        <p className="admin-help-text">
          {t('admin.judgeCalibration.battlePicks', { rate: picks.rate ?? 0, count: picks.compared })}
        </p>
      )}
    </div>
  );
};

export default JudgeCalibrationPanel;
