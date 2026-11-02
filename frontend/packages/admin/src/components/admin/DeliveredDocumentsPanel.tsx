import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const SKIP_REASONS = ['private', 'not-archived', 'hash-mismatch', 'too-long', 'empty', 'unreadable'] as const;
const SKIP_COLUMN: Record<(typeof SKIP_REASONS)[number], string> = {
  private: 'skipped_private',
  'not-archived': 'skipped_not_archived',
  'hash-mismatch': 'skipped_hash_mismatch',
  'too-long': 'skipped_too_long',
  empty: 'skipped_empty',
  unreadable: 'skipped_unreadable',
};

/** A count or rate cell value, or null when the server sent none (Athena mode omits what it does not judge). */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * THE DELIVERED DOCUMENTS' OWN SCORES (SPEC-EVALUATION FR22, SPEC-ADMIN-CONSOLE-EFFECTIVENESS).
 *
 * A turn that delivers a file is graded twice, and the console showed only the reply. This reads the
 * file's grade (`document_evaluation`) by intent and by task type, with the reply's relevance on the same
 * turns in a column of its own: the two are different artifacts, and a good reply beside a weak document
 * is exactly the case a pooled number would hide.
 *
 * EVERY DOCUMENT IS IN ONE GRADING STATE, and the states are shown as counts beside the delivered total,
 * so a high average over two scored documents out of forty reads as what it is. A rate shows "-" when
 * nothing carried the verdict, never 0, and its assessed count travels with it.
 *
 * Both modes serve the query. Athena mode judges relevance only, so the groundedness and compliance
 * columns arrive empty there and render "-".
 */
const DeliveredDocumentsPanel: React.FC<{ dateRange: AnalyticsDateRange | undefined }> = ({ dateRange }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    // Through a resolved promise, so a synchronous throw lands in the same catch as a rejection.
    Promise.resolve()
      .then(() => queryAnalytics('document_evaluation', dateRange))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.deliveredDocuments.error')); });
    return () => { cancelled = true; };
  }, [dateRange, t]);

  const muted = <span style={{ color: 'var(--text-muted)' }}>—</span>;

  const rate = (value: unknown, assessed: unknown, suffix = '%') => {
    const v = num(value);
    const n = num(assessed);
    if (v === null) return muted;
    return (
      <span>
        {v.toFixed(1)}{suffix}
        {n !== null && (
          <span style={{ color: 'var(--status-neutral)', fontSize: 'var(--text-sm)' }}> · {t('admin.deliveredDocuments.assessedOf', { count: n })}</span>
        )}
      </span>
    );
  };

  const grading = (row: Row) => {
    const parts: string[] = [t('admin.deliveredDocuments.scoredOf', { scored: num(row.documents_scored) ?? 0 })];
    for (const state of ['skipped', 'retrying', 'failed', 'awaiting'] as const) {
      const n = num(row[`documents_${state}`]);
      if (n) parts.push(t(`admin.deliveredDocuments.state.${state}`, { count: n }));
    }
    const reasons = SKIP_REASONS
      .map((r) => ({ r, n: num(row[SKIP_COLUMN[r]]) ?? 0 }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} ${t(`admin.deliveredDocuments.skipReason.${x.r}`)}`);
    return (
      <span>
        {parts.join(' · ')}{' '}
        <InfoTooltip
          label={t('admin.deliveredDocuments.column.grading')}
          content={t('admin.deliveredDocuments.stateTip', { reasons: reasons.length ? reasons.join(', ') : t('admin.deliveredDocuments.noReasons') })}
        />
      </span>
    );
  };

  const columns = (keyLabel: string) => [
    { key: 'group_key', label: keyLabel, render: (v: unknown) => <strong>{String(v)}</strong> },
    { key: 'documents_delivered', label: t('admin.deliveredDocuments.column.delivered'), sortable: true },
    { key: 'documents_scored', label: t('admin.deliveredDocuments.column.grading'), render: (_v: unknown, row: Row) => grading(row) },
    {
      key: 'doc_avg_relevance',
      label: t('admin.deliveredDocuments.column.docRelevance'),
      sortable: true,
      render: (v: unknown, row: Row) => rate(v, row.documents_scored, ''),
    },
    {
      key: 'reply_avg_relevance',
      label: t('admin.deliveredDocuments.column.replyRelevance'),
      sortable: true,
      render: (v: unknown, row: Row) => rate(v, row.reply_scored_count, ''),
    },
    {
      key: 'doc_groundedness_rate',
      label: t('admin.deliveredDocuments.column.docGrounded'),
      render: (v: unknown, row: Row) => rate(v, row.doc_groundedness_assessed_count),
    },
    {
      key: 'doc_compliance_rate',
      label: t('admin.deliveredDocuments.column.docCompliance'),
      render: (v: unknown, row: Row) => rate(v, row.doc_compliance_assessed_count),
    },
  ];

  const byIntent = (rows ?? []).filter((r) => r.dimension === 'intent');
  const byTaskType = (rows ?? []).filter((r) => r.dimension === 'task_type');

  return (
    <div className="admin-section" role="region" aria-label={t('admin.deliveredDocuments.aria')}>
      <h4>
        {t('admin.deliveredDocuments.title')}{' '}
        <InfoTooltip label={t('admin.deliveredDocuments.title')} content={t('admin.deliveredDocuments.tip')} />
      </h4>
      <p className="admin-tab-description">{t('admin.deliveredDocuments.description')}</p>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.deliveredDocuments.loading')}</p>}
      {!error && rows !== null && rows.length === 0 && <p className="admin-tab-empty">{t('admin.deliveredDocuments.empty')}</p>}
      {byIntent.length > 0 && (
        <>
          <h5>{t('admin.deliveredDocuments.byIntent')}</h5>
          <DataTable data={byIntent} columns={columns(t('admin.deliveredDocuments.column.intent'))} />
        </>
      )}
      {byTaskType.length > 0 && (
        <>
          <h5>{t('admin.deliveredDocuments.byTaskType')}</h5>
          <DataTable data={byTaskType} columns={columns(t('admin.deliveredDocuments.column.taskType'))} />
        </>
      )}
    </div>
  );
};

export default DeliveredDocumentsPanel;
