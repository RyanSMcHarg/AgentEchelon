/**
 * SUBJECTS NO INTENT SERVES.
 *
 * The window's `general` and `off_topic` turns, counted against the subjects of the conversation each happened
 * in. A subject that keeps drawing turns no intent serves is a candidate for a new intent: people keep asking
 * about it, and today it is answered as a general question or declined. Read from what each turn already
 * records, so nothing new is written on a turn.
 *
 * A turn counts toward every subject of its conversation, so the counts rank subjects; they do not add up to a
 * number of turns. Aurora mode only, like the other turn breakdowns.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import { teamAssistant, teamCanQuery } from '../../services/teamScope';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

interface Props {
  dateRange: AnalyticsDateRange;
}

interface UnservedSubjectRow {
  subject: string;
  intent: string;
  turns: number | string;
  conversations: number | string;
  [key: string]: unknown;
}

export function UnservedSubjects({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<UnservedSubjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The backend's own reason when this mode does not serve the query (Athena), shown instead of an empty table. */
  const [unsupported, setUnsupported] = useState<string | null>(null);
  // NOT A TEAM'S READ: the subjects span every assistant, so a team-scoped viewer is refused at the gateway.
  // The panel is not offered to them rather than shown as an error.
  const teamScoped = !!teamAssistant() && !teamCanQuery('unserved_subjects');

  const load = useCallback(async (range: AnalyticsDateRange) => {
    setLoading(true);
    setError(null);
    try {
      const res: AnalyticsResult = await queryAnalytics('unserved_subjects', range);
      setUnsupported(res.unsupported ? (res.reason || t('admin.unservedSubjects.unsupported')) : null);
      setRows((res.data ?? []) as unknown as UnservedSubjectRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.unservedSubjects.failed'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { if (!teamScoped) void load(dateRange); }, [dateRange, load, teamScoped]);

  if (teamScoped) return null;

  return (
    <section className="admin-section" aria-label={t('admin.unservedSubjects.title')}>
      <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
        <span className="admin-tab-banner-label-text">{t('admin.unservedSubjects.title')}</span>
        <InfoTooltip label={t('admin.unservedSubjects.aboutLabel')} content={t('admin.unservedSubjects.about')} />
      </div>
      {error && <p className="admin-error" role="alert">{error}</p>}
      {!error && unsupported && <p className="admin-help-text">{unsupported}</p>}
      {!error && !unsupported && !loading && rows.length === 0 && (
        <p className="admin-help-text">{t('admin.unservedSubjects.empty')}</p>
      )}
      {rows.length > 0 && (
        <DataTable<UnservedSubjectRow>
          columns={[
            { key: 'subject', label: t('admin.unservedSubjects.columns.subject') },
            {
              key: 'intent',
              label: t('admin.unservedSubjects.columns.intent'),
              render: (v) => t(`admin.unservedSubjects.intent.${String(v)}`, { defaultValue: String(v) }),
            },
            { key: 'turns', label: t('admin.unservedSubjects.columns.turns') },
            { key: 'conversations', label: t('admin.unservedSubjects.columns.conversations') },
          ]}
          data={rows}
        />
      )}
    </section>
  );
}

export default UnservedSubjects;
