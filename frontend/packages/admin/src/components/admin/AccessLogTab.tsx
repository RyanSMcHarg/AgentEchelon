import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { fetchAccessLog, type AccessLogRecord } from '../../services/accessLogService';
import { accessKind, accessExpiry, accessAssistant } from './accessLogRow';
import { useConsoleAccess } from '../../capabilities';
import { useTeamName } from './TeamSelector';

/** The id after the last `/`, so a long ARN reads as the conversation it names; the full ARN is the title. */
function shortId(arn: string | null): string {
  if (!arn) return '';
  const i = arn.lastIndexOf('/');
  return i === -1 ? arn : arn.slice(i + 1);
}

const DAY_CHOICES = [1, 7, 30, 90, 400] as const;

/**
 * WHAT THIS SIGN-IN REACHES (SPEC-ADMIN-CONSOLE FR0e), in the two forms the exchange enforces: what the
 * console session holds now, and what it vends only on request, one conversation at a time with a stated
 * reason that this log records, for a limited time. The split is the exchange's (`onRequest`, read from
 * the catalog's `enforcement`), never decided here. Rendered only when the exchange reported it.
 */
const YourAccess: React.FC = () => {
  const { t } = useTranslation();
  const access = useConsoleAccess();
  const teamName = useTeamName();
  if (access.status !== 'ready' || !access.onRequest) return null;
  const { onRequest } = access;
  const held = [...access.capabilities].filter((c) => !onRequest.capabilities.has(c)).sort();
  const vended = [...onRequest.capabilities].filter((c) => access.capabilities.has(c)).sort();
  const list = (keys: string[], testId: string) => (
    <ul className="admin-reach-list" data-testid={testId}>
      {keys.map((c) => <li key={c}><code>{c}</code></li>)}
    </ul>
  );
  // A TROUBLESHOOTING STEP, NOT THE PAGE'S SUBJECT: the log is what this tab is for, so
  // what the sign-in holds sits below it, collapsed until someone needs to check why a control is missing.
  return (
    <details className="admin-reach" data-testid="access-log-your-access">
      <summary>{t('admin.accessLog.yourAccess.summary')}</summary>
      <p className="admin-tab-description">
        {access.role === 'team-members' && access.teams.length > 0
          // WHO THEY ARE BY THEIR TEAM, not the bare role label (SPEC-ADMIN-CONSOLE "Admin and team-member groups").
          ? t(access.assistants.length ? 'admin.accessLog.yourAccess.teamOwns' : 'admin.accessLog.yourAccess.team', {
            teams: access.teams.map(teamName).join(', '), assistants: access.assistants.join(', '),
          })
          : t('admin.accessLog.yourAccess.role', { role: t(`admin.access.role.${access.role}`) })}
      </p>
      <div>
        <h5>{t('admin.accessLog.yourAccess.held', { count: held.length })}</h5>
        {list(held, 'access-log-held')}
      </div>
      {vended.length > 0 && (
        <div>
          <h5>{t('admin.accessLog.yourAccess.onRequest', { count: vended.length, minutes: Math.round(onRequest.ttlSeconds / 60) })}</h5>
          {list(vended, 'access-log-on-request')}
        </div>
      )}
    </details>
  );
};

/**
 * THE ACCESS LOG (ADR-052, SPEC-ADMIN-CONSOLE 3.3, FR30): who was given access to which conversation,
 * when, and the reason they stated. The exchange writes a record for every credential it vends, before
 * the credential is returned, and opening this tab is recorded the same way.
 */
const AccessLogTab: React.FC = () => {
  const { t } = useTranslation();
  const [records, setRecords] = useState<AccessLogRecord[]>([]);
  const [days, setDays] = useState<number>(30);
  const [channelId, setChannelId] = useState('');
  const [actor, setActor] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (filter: { days: number; channelId: string; actor: string }) => {
    setIsLoading(true);
    setError(null);
    try {
      setRecords(await fetchAccessLog(filter));
    } catch (err) {
      setRecords([]);
      setError((err as Error).message || t('admin.accessLog.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { void load({ days: 30, channelId: '', actor: '' }); }, [load]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void load({ days, channelId, actor });
  };

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>{t('admin.accessLog.title')}</h3>
      </div>
      <p className="admin-tab-description" style={{ maxWidth: 640 }}>{t('admin.accessLog.description')}</p>

      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <label>
          {t('admin.accessLog.window')}
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('admin.accessLog.window')}>
            {DAY_CHOICES.map((d) => (
              <option key={d} value={d}>{t('admin.accessLog.lastDays', { count: d })}</option>
            ))}
          </select>
        </label>
        <label>
          {t('admin.accessLog.conversation')}
          <input className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder={t('admin.accessLog.conversationPlaceholder')} />
        </label>
        <label>
          {t('admin.accessLog.person')}
          <input className="input" value={actor} onChange={(e) => setActor(e.target.value)} placeholder={t('admin.accessLog.personPlaceholder')} />
        </label>
        <button className="btn-primary" type="submit" disabled={isLoading}>{t('admin.accessLog.apply')}</button>
      </form>

      {error && (
        <div className="admin-error" role="alert">
          <span>{error}</span>
          <button className="btn-secondary" onClick={() => setError(null)}>{t('admin.accessLog.dismiss')}</button>
        </div>
      )}

      {isLoading ? (
        <div className="admin-tab-loading">{t('admin.accessLog.loading')}</div>
      ) : !error && (
        <DataTable
          data={records as unknown as Record<string, unknown>[]}
          emptyMessage={t('admin.accessLog.empty')}
          columns={[
            { key: 'at', label: t('admin.accessLog.when'), render: (v) => new Date(String(v)).toLocaleString() },
            { key: 'actor', label: t('admin.accessLog.person'), render: (v) => <span className="font-mono">{String(v)}</span> },
            {
              // WHAT KIND OF ACCESS, in words: a temporary moderation credential, a temporary read, a team
              // member's read through their assistant, a de-identified read (`accessLogRow.ts`).
              key: 'event', label: t('admin.accessLog.event'),
              render: (_v, row) => {
                const r = row as unknown as AccessLogRecord;
                const kind = accessKind(r);
                const assistant = accessAssistant(r);
                return kind === 'other'
                  ? t(`admin.accessLog.events.${r.event}`, { defaultValue: r.event })
                  : t(`admin.accessLog.kind.${kind}`, { assistant: assistant ?? '' });
              },
            },
            {
              key: 'conversation', label: t('admin.accessLog.conversation'), sortable: false,
              render: (v) => <span className="font-mono" title={String(v ?? '')}>{shortId((v as string | null) ?? null)}</span>,
            },
            {
              key: 'capabilities', label: t('admin.accessLog.capabilities'), sortable: false,
              render: (v) => (Array.isArray(v) ? v.map((c) => t(`admin.accessLog.allows.${String(c)}`, { defaultValue: String(c) })).join(', ') : ''),
            },
            {
              key: 'expires', label: t('admin.accessLog.expires'), sortable: false,
              render: (_v, row) => {
                const until = accessExpiry(row as unknown as AccessLogRecord);
                return until ? until.toLocaleString() : t('admin.accessLog.notTimed');
              },
            },
            { key: 'reason', label: t('admin.accessLog.reason'), sortable: false, render: (v) => (v ? String(v) : t('admin.accessLog.noReason')) },
          ]}
        />
      )}

      <YourAccess />
    </div>
  );
};

export default AccessLogTab;
