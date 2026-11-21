/**
 * THE ADMIN NOTICES (DESIGN-EVENT-TARGETS section 12): each notice the platform raises and whether it posts into the admin
 * notifications conversation. A security notice is always on and says so; an operational one is switched here, and the switch
 * holds across deploys.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listAdminNotices, switchAdminNotice, type AdminNotice } from '../../services/eventTriggerService';

export const AdminNoticesPanel: React.FC = () => {
  const { t } = useTranslation();
  const [notices, setNotices] = useState<AdminNotice[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    listAdminNotices().then(setNotices).catch((e: Error) => setError(e.message));
  }, []);

  const flip = async (n: AdminNotice) => {
    setBusy(n.key);
    setError('');
    try {
      const next = await switchAdminNotice(n.key, n.enabled !== true);
      setNotices((all) => (all ?? []).map((x) => (x.key === n.key ? { ...x, enabled: next.enabled } : x)));
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  const state = (n: AdminNotice) => (n.security ? t('admin.adminNotices.alwaysOn')
    : n.enabled === true ? t('admin.adminNotices.on') : n.enabled === false ? t('admin.adminNotices.off') : t('admin.adminNotices.unknown'));

  return (
    <fieldset className="admin-filter-group" data-testid="admin-notices-panel">
      <legend className="admin-field-label">{t('admin.adminNotices.title')}</legend>
      <span className="admin-field-hint">{t('admin.adminNotices.help')}</span>
      {notices && (
        <ul className="admin-event-trigger-list" data-testid="admin-notices-list">
          {notices.map((n) => (
            <li key={n.key} data-testid={`admin-notice-${n.key}`}>
              <code>{n.messageType}</code> <span className="admin-field-hint">{state(n)}</span>
              {n.security
                ? <span className="admin-field-hint" data-testid={`admin-notice-${n.key}-why`}>{t('admin.adminNotices.securityWhy')}</span>
                : (
                  <button type="button" className="btn-secondary" data-testid={`admin-notice-${n.key}-switch`} disabled={busy !== ''} onClick={() => { void flip(n); }}>
                    {n.enabled === true ? t('admin.adminNotices.turnOff') : t('admin.adminNotices.turnOn')}
                  </button>
                )}
            </li>
          ))}
        </ul>
      )}
      {error && <span className="error-message" role="alert" data-testid="admin-notices-error">{error}</span>}
    </fieldset>
  );
};

export default AdminNoticesPanel;
