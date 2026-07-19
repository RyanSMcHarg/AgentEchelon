import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserTier } from '@ae/shared';
import { trackEvent } from '@ae/shared';
import './RegistrationScreen.css';

interface RegistrationScreenProps {
  onRegister: (email: string, password: string, tier: UserTier) => Promise<void>;
  onSwitchToLogin: () => void;
}

const RegistrationScreen: React.FC<RegistrationScreenProps> = ({ onRegister, onSwitchToLogin }) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [selectedTier, setSelectedTier] = useState<UserTier>('basic');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPasswordHelp, setShowPasswordHelp] = useState(false);

  useEffect(() => {
    trackEvent('signup_form_viewed');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password || !confirmPassword) {
      trackEvent('signup_field_validation_error', { field: 'missing_required' });
      setError(t('auth.register.errorFillAll'));
      return;
    }

    if (password !== confirmPassword) {
      trackEvent('signup_field_validation_error', { field: 'password_mismatch' });
      setError(t('auth.register.errorMismatch'));
      return;
    }

    if (password.length < 8) {
      trackEvent('signup_field_validation_error', { field: 'password_too_short' });
      setError(t('auth.register.errorTooShort'));
      return;
    }

    setIsLoading(true);
    trackEvent('signup_submitted', { tier: selectedTier });
    try {
      await onRegister(email, password, selectedTier);
      // AuthProvider's confirmation flow surfaces the email-verification
      // screen next; the `confirmation_required` event is emitted there.
    } catch (err) {
      const reason = err instanceof Error ? err.name || err.message.slice(0, 80) : 'unknown';
      trackEvent('signup_failed', { reason, tier: selectedTier });
      setError(err instanceof Error ? err.message : t('auth.register.failureFallback'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="registration-container">
      <div className="registration-content">
        <div className="registration-form-section">
          <div className="registration-header">
            <h1>{t('auth.register.title')}</h1>
          </div>

          <form onSubmit={handleSubmit} className="registration-form">
            <div className="form-group">
              <label htmlFor="email">{t('auth.register.emailLabel')}</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('auth.register.emailPlaceholder')}
                disabled={isLoading}
                autoComplete="email"
              />
            </div>

            <div className="form-group">
              <div className="label-with-help">
                <label htmlFor="password">{t('auth.register.passwordLabel')}</label>
                <div className="help-icon-container">
                  <button
                    type="button"
                    className="help-icon"
                    tabIndex={10}
                    onMouseEnter={() => setShowPasswordHelp(true)}
                    onMouseLeave={() => setShowPasswordHelp(false)}
                    onClick={() => setShowPasswordHelp(!showPasswordHelp)}
                    aria-label={t('auth.register.passwordRequirementsTitle')}
                  >
                    ⓘ
                  </button>
                  {showPasswordHelp && (
                    <div className="password-help-tooltip">
                      <strong>{t('auth.register.passwordRequirementsTitle')}</strong>
                      <ul>
                        <li>{t('auth.register.reqMinLength')}</li>
                        <li>{t('auth.register.reqUppercase')}</li>
                        <li>{t('auth.register.reqLowercase')}</li>
                        <li>{t('auth.register.reqNumber')}</li>
                        <li>{t('auth.register.reqSpecial')}</li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('auth.register.passwordPlaceholder')}
                disabled={isLoading}
                autoComplete="new-password"
              />
            </div>

            <div className="form-group">
              <label htmlFor="confirmPassword">{t('auth.register.confirmLabel')}</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t('auth.register.confirmPlaceholder')}
                disabled={isLoading}
                autoComplete="new-password"
              />
            </div>

            <div className="form-group">
              <label>{t('auth.register.tierLabel')}</label>
              <div className="tier-selection">
                <label className={`tier-option ${selectedTier === 'basic' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="tier"
                    value="basic"
                    checked={selectedTier === 'basic'}
                    onChange={() => setSelectedTier('basic')}
                    disabled={isLoading}
                  />
                  <div className="tier-info">
                    <span className="tier-name">{t('auth.register.tierBasic')}</span>
                    <span className="tier-models">{t('auth.register.tierBasicModels')}</span>
                  </div>
                </label>

                <label className={`tier-option ${selectedTier === 'standard' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="tier"
                    value="standard"
                    checked={selectedTier === 'standard'}
                    onChange={() => setSelectedTier('standard')}
                    disabled={isLoading}
                  />
                  <div className="tier-info">
                    <span className="tier-name">{t('auth.register.tierStandard')}</span>
                    <span className="tier-models">{t('auth.register.tierStandardModels')}</span>
                  </div>
                </label>

                <label className={`tier-option ${selectedTier === 'premium' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="tier"
                    value="premium"
                    checked={selectedTier === 'premium'}
                    onChange={() => setSelectedTier('premium')}
                    disabled={isLoading}
                  />
                  <div className="tier-info">
                    <span className="tier-name">{t('auth.register.tierPremium')}</span>
                    <span className="tier-models">{t('auth.register.tierPremiumModels')}</span>
                  </div>
                </label>
              </div>
            </div>

            {error && <div className="error-message">{error}</div>}

            <button type="submit" className="register-button" disabled={isLoading}>
              {isLoading ? t('auth.register.creating') : t('auth.register.createButton')}
            </button>
          </form>

          <div className="login-link">
            {t('auth.register.haveAccountPrompt')}{' '}
            <button onClick={onSwitchToLogin} className="link-button">
              {t('auth.register.signInLink')}
            </button>
          </div>
        </div>

        <div className="registration-info-section">
          <div className="info-panel">
            <h2>{t('auth.register.processTitle')}</h2>

            <div className="info-step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>{t('auth.register.step1Title')}</h3>
                <p>{t('auth.register.step1Body')}</p>
              </div>
            </div>

            <div className="info-step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>{t('auth.register.step2Title')}</h3>
                <p>{t('auth.register.step2Body')}</p>
              </div>
            </div>

            <div className="info-step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>{t('auth.register.step3Title')}</h3>
                <p>{t('auth.register.step3Body')}</p>
              </div>
            </div>

            <div className="info-note">
              <div className="info-note-header">
                <span className="info-icon">ⓘ</span>
                <strong>{t('auth.register.noteTitle')}</strong>
              </div>
              <p>{t('auth.register.noteBody')}</p>
              <a href="#blog" className="info-link">
                {t('auth.register.learnMoreLink')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RegistrationScreen;
