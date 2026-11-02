import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics, writeAnalytics } from '../../services/analyticsService';
import { retireGoldenUpload } from '../../services/profileService';
import { useCan } from '../../capabilities';

type Row = Record<string, unknown>;

const excerpt = (v: unknown, n = 140): string => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * LABEL FROM THE ANSWER, AND KEEP THE ONES WORTH KEEPING (SPEC-EVALUATION FR14, FR16, Appendix C1).
 *
 * Two lists. The queue is judged answers nobody has labeled, the ones a label is worth most on first
 * (`label_queue`); Label opens the form already holding the answer, so nobody carries an identifier
 * across tabs. The golden set is the de-identified entries a draft version is run against, per
 * classification and purpose (`golden_set`); an entry is nominated from a labeled answer, and can be retired,
 * or promoted from capability to regression once the version passes it reliably. An entry says where it came from: nominated
 * from a labeled answer, or uploaded by the deployment, whose whole upload can be retired at once (ADR-065 decision 7).
 */
const GoldenSetPanel: React.FC<{
  /** Open the label form for this answer, with its request and reply in view. */
  onLabel?: (row: Row) => void;
  /** A labeled answer offered for nomination, from the ground truth list. */
  canWrite: boolean;
  /** Bumped by the parent after a label is saved, so the queue drops the answer just labeled. */
  refreshKey?: number;
}> = ({ onLabel, canWrite, refreshKey = 0 }) => {
  const { t } = useTranslation();
  const can = useCan();
  const [queue, setQueue] = useState<Row[] | null>(null);
  const [entries, setEntries] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    Promise.resolve()
      .then(() => Promise.all([queryAnalytics('label_queue', undefined), queryAnalytics('golden_set', undefined)]))
      .then(([q, g]) => {
        if (cancelled) return;
        setQueue((q?.data ?? []) as Row[]);
        setEntries((g?.data ?? []) as Row[]);
      })
      .catch(() => { if (!cancelled) setError(t('admin.goldenSet.error')); });
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => load(), [load, refreshKey]);

  const act = async (extra: Record<string, unknown>, done: string) => {
    setNotice(null);
    try {
      await writeAnalytics('golden_set', extra);
      setNotice(done);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const why = (v: unknown) => t(`admin.goldenSet.why.${String(v)}`);

  const retireUpload = async (row: Row) => {
    setNotice(null);
    try {
      const out = await retireGoldenUpload(String(row.assistant), String(row.upload_id), row.source === 'generated' ? 'generated' : 'uploaded');
      setNotice(t('admin.goldenSet.uploadRetired', { count: out.retired }));
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="admin-section" role="region" aria-label={t('admin.goldenSet.title')}>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-help-text" role="status">{notice}</p>}

      <h4>
        {t('admin.goldenSet.queueTitle')}{' '}
        <InfoTooltip label={t('admin.goldenSet.queueTitle')} content={t('admin.goldenSet.queueTip')} />
      </h4>
      {queue !== null && queue.length === 0 && <p className="admin-tab-empty">{t('admin.goldenSet.queueEmpty')}</p>}
      {queue !== null && queue.length > 0 && (
        <DataTable
          data={queue}
          columns={[
            { key: 'why', label: t('admin.goldenSet.column.why'), render: (v: unknown) => why(v) },
            { key: 'assistant', label: t('admin.goldenSet.column.assistant') },
            { key: 'intent', label: t('admin.goldenSet.column.intent') },
            { key: 'user_message', label: t('admin.goldenSet.column.request'), render: (v: unknown) => excerpt(v) },
            { key: 'agent_response', label: t('admin.goldenSet.column.answer'), render: (v: unknown) => excerpt(v) },
            {
              key: 'exchange_id',
              label: '',
              render: (_v: unknown, row: Row) => (canWrite && onLabel
                ? <button className="btn-secondary" onClick={() => onLabel(row)}>{t('admin.goldenSet.label')}</button>
                : null),
            },
          ]}
        />
      )}

      <h4>
        {t('admin.goldenSet.title')}{' '}
        <InfoTooltip label={t('admin.goldenSet.title')} content={t('admin.goldenSet.tip')} />
      </h4>
      {entries !== null && entries.length === 0 && <p className="admin-tab-empty">{t('admin.goldenSet.empty')}</p>}
      {entries !== null && entries.length > 0 && (
        <DataTable
          data={entries}
          columns={[
            { key: 'conversation_classification', label: t('admin.goldenSet.column.classification') },
            { key: 'purpose', label: t('admin.goldenSet.column.purpose'), render: (v: unknown) => t(`admin.goldenSet.purpose.${String(v)}`) },
            { key: 'assistant', label: t('admin.goldenSet.column.assistant') },
            { key: 'source', label: t('admin.goldenSet.column.source'), render: (v: unknown) => t(`admin.goldenSet.source.${String(v ?? 'nominated')}`) },
            { key: 'request_text', label: t('admin.goldenSet.column.request'), render: (v: unknown) => excerpt(v) },
            { key: 'reference_text', label: t('admin.goldenSet.column.reference'), render: (v: unknown) => (v ? excerpt(v) : '—') },
            // THE LAST RUN THAT USED THE ENTRY (ADR-065), so a person collecting entries sees them used; tools named where a
            // run could not exercise the entry.
            {
              key: 'last_run',
              label: t('admin.goldenSet.column.lastRun'),
              render: (v: unknown, row: Row) => {
                const run = v as { outcome?: string; startedAt?: string } | null;
                const tools = Array.isArray(row.used_tools) && row.used_tools.length ? t('admin.goldenSet.usesTools', { tools: (row.used_tools as string[]).join(', ') }) : '';
                const outcome = run?.outcome ? t(`admin.goldenSet.lastRun.${run.outcome}`, { at: run.startedAt ? new Date(run.startedAt).toLocaleDateString() : '' }) : t('admin.goldenSet.lastRun.never');
                return tools ? `${outcome} ${tools}` : outcome;
              },
            },
            {
              key: 'id',
              label: '',
              render: (_v: unknown, row: Row) => (canWrite ? (
                <span>
                  {row.purpose === 'capability' && (
                    <button className="btn-secondary" onClick={() => act({ action: 'promote', entryId: row.id }, t('admin.goldenSet.promoted'))}>
                      {t('admin.goldenSet.promote')}
                    </button>
                  )}{' '}
                  <button className="btn-secondary" onClick={() => act({ action: 'retire', entryId: row.id }, t('admin.goldenSet.retired'))}>
                    {t('admin.goldenSet.retire')}
                  </button>
                  {row.upload_id && row.purpose === 'capability' && can(row.source === 'generated' ? 'edit-profiles' : 'import-golden-set') ? (
                    <>{' '}
                      <button className="btn-secondary" onClick={() => { void retireUpload(row); }}>{t('admin.goldenSet.retireUpload')}</button>
                    </>
                  ) : null}
                </span>
              ) : null),
            },
          ]}
        />
      )}
    </div>
  );
};

/** Nominate a labeled answer into its classification's golden set, at the purpose the person chooses. */
export async function nominateToGoldenSet(exchangeId: string, purpose: 'regression' | 'capability'): Promise<void> {
  await writeAnalytics('golden_set', { action: 'nominate', exchangeId, purpose });
}

export default GoldenSetPanel;
