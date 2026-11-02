import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCleanConversation, type CleanConversation, type CleanConversationRow } from '../../services/adminConversationService';
import { ReasonDeclinedError } from '../../services/adminReason';

/**
 * A CONVERSATION WITHOUT WHO SAID IT (SPEC-ADMIN-CONSOLE FR54, FR55).
 *
 * One timeline of messages and membership changes, every person a pseudonym and personal data described
 * rather than shown. The full record is the default: a removed message stays where it was, marked, so an
 * answer is never shown without its question, and an edited message shows its first version. "Current
 * state" narrows it to what is there now.
 *
 * The copy is derived daily, so the view says when, and sends anything urgent to the record.
 */
export default function CleanConversationView({ channelArn }: { channelArn: string }): React.ReactElement {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<CleanConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentOnly, setCurrentOnly] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    getCleanConversation(channelArn)
      .then((c) => { if (live) setCopy(c); })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ReasonDeclinedError ? e.message : (e instanceof Error ? e.message : t('admin.conversations.clean.failed')));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [channelArn, t]);

  if (loading) return <p className="admin-tab-description">{t('admin.conversations.clean.loading')}</p>;
  if (error) return <div className="admin-error"><span>{error}</span></div>;
  if (!copy) return <></>;

  const rows = currentOnly ? copy.rows.filter((r) => r.kind === 'membership' || r.state === 'present') : copy.rows;

  return (
    <div className="admin-section" data-testid="clean-conversation">
      <p className="admin-tab-description">
        {copy.derivedAt
          ? t('admin.conversations.clean.derivedAt', { time: new Date(copy.derivedAt).toLocaleString() })
          : t('admin.conversations.clean.notYetDerived')}{' '}
        {t('admin.conversations.clean.notForIncidents')}
      </p>
      <label className="admin-filter-group">
        <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} />{' '}
        {t('admin.conversations.clean.currentState')}
      </label>
      {currentOnly && <p className="admin-field-hint">{t('admin.conversations.clean.currentStateHint')}</p>}
      {rows.length === 0 ? (
        <p className="admin-tab-description">{t('admin.conversations.clean.empty')}</p>
      ) : (
        <ol className="admin-clean-timeline">
          {rows.map((r) => <CleanRow key={r.seq} row={r} currentOnly={currentOnly} />)}
        </ol>
      )}
    </div>
  );
}

function CleanRow({ row, currentOnly }: { row: CleanConversationRow; currentOnly: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const time = new Date(row.occurredAt).toLocaleString();
  if (row.kind === 'membership') {
    return (
      <li className="admin-clean-membership">
        <span className="admin-field-hint">{time}</span>{' '}
        {t(`admin.conversations.clean.membership.${row.action ?? 'changed'}`, {
          subject: row.subject ?? t('admin.conversations.clean.someone'),
          actor: row.actor,
          defaultValue: t('admin.conversations.clean.membership.changed', { subject: row.subject ?? '', actor: row.actor }),
        })}
      </li>
    );
  }
  return (
    <li className={['admin-clean-message', row.state === 'present' ? '' : 'admin-clean-removed'].filter(Boolean).join(' ')}>
      <span className="admin-field-hint">{time}</span>{' '}
      <strong>{t('admin.conversations.clean.speaker', { actor: row.actor })}</strong>{' '}
      {row.state === 'present'
        ? <span>{row.text}</span>
        : <em>{t(`admin.conversations.clean.removed.${row.state}`)}</em>}
      {!currentOnly && row.originalText !== null && row.state === 'present' && (
        <div className="admin-field-hint">{t('admin.conversations.clean.edited', { original: row.originalText })}</div>
      )}
    </li>
  );
}
