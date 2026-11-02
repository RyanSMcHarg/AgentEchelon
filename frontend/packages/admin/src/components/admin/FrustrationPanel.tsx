import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange } from '@ae/shared';

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v) || 0);

const SIGNALS = ['asked_again', 'declined_drift', 'unanswered_handover', 'stopped'] as const;

/**
 * HAD TO WORK TO BE UNDERSTOOD (SPEC-EVALUATION Appendix C6).
 *
 * From `frustration`: per assistant, how many of the people it answered in a conversation hit a recorded
 * signal (asked again, declined a drift offer, a handover nobody answered, stopped work), then the
 * conversations behind the number, each openable. The unit is one person in one conversation, so a
 * conversation row counts people, never adds their signals.
 */
const FrustrationPanel: React.FC<{
  dateRange: AnalyticsDateRange | undefined;
  assistant?: string | null;
  classification?: string | null;
  onOpenConversation?: (channelArn: string) => void;
}> = ({ dateRange, assistant, classification, onOpenConversation }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    const extra: Record<string, string> = {};
    if (assistant) extra.agentType = assistant;
    if (classification) extra.conversationClassification = classification;
    Promise.resolve()
      .then(() => queryAnalytics('frustration', dateRange, extra))
      .then((res) => { if (!cancelled) setRows((res?.data ?? []) as Row[]); })
      .catch(() => { if (!cancelled) setError(t('admin.frustration.error')); });
    return () => { cancelled = true; };
  }, [dateRange, assistant, classification, t]);

  const signalsOf = (row: Row) => {
    const parts = SIGNALS.filter((s) => num(row[s]) > 0)
      .map((s) => t(`admin.frustration.signal.${s}`, { count: num(row[s]) }));
    return parts.length ? parts.join(' · ') : '—';
  };

  const summary = (rows ?? []).filter((r) => r.dimension === 'summary');
  const conversations = (rows ?? []).filter((r) => r.dimension === 'conversation');

  return (
    <div className="admin-section" role="region" aria-label={t('admin.frustration.title')}>
      <h4>
        {t('admin.frustration.title')}{' '}
        <InfoTooltip label={t('admin.frustration.title')} content={t('admin.frustration.tip')} />
      </h4>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="admin-help-text">{t('admin.frustration.loading')}</p>}
      {!error && rows !== null && summary.length === 0 && <p className="admin-tab-empty">{t('admin.frustration.empty')}</p>}
      {summary.length > 0 && (
        <DataTable
          data={summary}
          columns={[
            { key: 'assistant', label: t('admin.frustration.column.assistant'), render: (v: unknown) => <strong>{String(v ?? '—')}</strong> },
            { key: 'conversation_classification', label: t('admin.frustration.column.classification') },
            {
              key: 'with_signal',
              label: t('admin.frustration.column.people'),
              sortable: true,
              render: (_v: unknown, row: Row) => t('admin.frustration.ofPeople', { count: num(row.with_signal), population: num(row.population) }),
            },
            { key: 'asked_again', label: t('admin.frustration.column.signals'), render: (_v: unknown, row: Row) => signalsOf(row) },
          ]}
        />
      )}
      {conversations.length > 0 && (
        <>
          <h5>{t('admin.frustration.conversations')}</h5>
          <DataTable
            data={conversations}
            columns={[
              {
                key: 'channel_arn',
                label: t('admin.frustration.column.conversation'),
                render: (v: unknown) => (onOpenConversation && v
                  ? <button className="btn-link" onClick={() => onOpenConversation(String(v))}>{t('admin.frustration.open')}</button>
                  : '—'),
              },
              { key: 'assistant', label: t('admin.frustration.column.assistant') },
              {
                key: 'with_signal',
                label: t('admin.frustration.column.people'),
                render: (_v: unknown, row: Row) => t('admin.frustration.ofPeople', { count: num(row.with_signal), population: num(row.population) }),
              },
              { key: 'most_signals', label: t('admin.frustration.column.mostSignals'), sortable: true },
              { key: 'asked_again', label: t('admin.frustration.column.signals'), render: (_v: unknown, row: Row) => signalsOf(row) },
            ]}
          />
        </>
      )}
    </div>
  );
};

export default FrustrationPanel;
