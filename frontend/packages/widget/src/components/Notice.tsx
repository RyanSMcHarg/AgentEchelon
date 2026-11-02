/**
 * The deployment's privacy notice, shown before the first message (A7). Guest start records which
 * version was shown; the version comes from the deployment (`GuestNoticeVersion`), the text from the
 * widget's locale.
 */
import { useTranslation } from 'react-i18next';

export function Notice({ version, onAccept, busy }: { version: string; onAccept: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="aeaw__notice">
      <h3 className="aeaw__notice-title">{t('widget.notice.heading')}</h3>
      <p className="aeaw__notice-body">{t('widget.notice.body')}</p>
      <p className="aeaw__notice-version">{t('widget.notice.version', { version })}</p>
      <button type="button" className="aeaw__action" onClick={onAccept} disabled={busy} aria-busy={busy}>
        {busy ? t('widget.starting') : t('widget.notice.accept')}
      </button>
    </div>
  );
}
