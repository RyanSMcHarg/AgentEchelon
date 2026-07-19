import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../providers/AuthProvider';
import ConnectionStatus from './ConnectionStatus';
import './Header.css';

interface HeaderProps {
  /** Return to the app home (brand click). */
  onHome?: () => void;
}

const Header: React.FC<HeaderProps> = ({ onHome }) => {
  const { t } = useTranslation();
  const { user, logout } = useAuth();

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-left">
          <button type="button" className="header-brand" onClick={onHome} aria-label={t('header.home')}>
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="header-mark">
              <rect x="2.5" y="2.5" width="27" height="27" rx="7.5" stroke="currentColor" strokeWidth="2" />
              <path
                d="M10 23 C 10 18, 22 19, 21 14 C 20.4 11, 16 11.4, 16 8.6"
                stroke="#b4532a"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeDasharray="0 4.3"
              />
              <circle cx="16" cy="7.9" r="2.4" fill="#b4532a" />
            </svg>
            <span className="header-title">{t('app.brandName')}</span>
          </button>
          <ConnectionStatus />
        </div>
        <div className="header-actions">
          {user && (
            <button
              className="header-logout-btn"
              onClick={logout}
              title={t('header.signOut')}
            >
              {t('header.signOut')}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
