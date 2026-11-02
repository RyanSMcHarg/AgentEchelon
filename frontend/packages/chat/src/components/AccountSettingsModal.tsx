import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@ae/shared';
import EmailPreferences from './EmailPreferences';
import LanguagePreference from './LanguagePreference';
import './AccountSettings.css';

/**
 * ACCOUNT SETTINGS: who the person is signed in as, the language messages addressed to them are said in, and their
 * email preferences.
 *
 * Opened from the account menu in the header, and by the `?settings=email-preferences` link an email's
 * preference page carries, which lands on the email section. The email section is offered only where the
 * deployment sends email.
 */
interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The deployment sends email, so the person has preferences to set. */
  emailOffered: boolean;
  /** Open on the email section (the link from an email). */
  focusEmail?: boolean;
  /** Injected for tests. */
  languageDeps?: React.ComponentProps<typeof LanguagePreference>['deps'];
  /** Injected for tests. */
  emailDeps?: React.ComponentProps<typeof EmailPreferences>['deps'];
}

const AccountSettingsModal: React.FC<Props> = ({ isOpen, onClose, emailOffered, focusEmail, languageDeps, emailDeps }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && focusEmail) bodyRef.current?.querySelector('#settings-email')?.scrollIntoView({ block: 'start' });
  }, [isOpen, focusEmail]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="account-settings-title">{t('accountSettings.title')}</h2>
          <button className="modal-close-btn" onClick={onClose} aria-label={t('common.close')}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="close-icon" aria-hidden="true">
              <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        <div className="settings-body" ref={bodyRef}>
          <section className="settings-section" aria-labelledby="settings-account-title">
            <h3 id="settings-account-title" className="settings-section-title">{t('accountSettings.account')}</h3>
            <dl className="settings-facts">
              <div><dt>{t('accountSettings.name')}</dt><dd>{user?.name || t('accountSettings.notSet')}</dd></div>
              <div><dt>{t('accountSettings.email')}</dt><dd>{user?.email || t('accountSettings.notSet')}</dd></div>
            </dl>
          </section>
          <LanguagePreference deps={languageDeps} />
          {emailOffered && <EmailPreferences deps={emailDeps} />}
        </div>
        <div className="modal-actions settings-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
};

export default AccountSettingsModal;
