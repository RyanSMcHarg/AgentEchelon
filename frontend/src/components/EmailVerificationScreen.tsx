import React, { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useAuth } from '../providers/AuthProvider';
import './EmailVerificationScreen.css';

interface EmailVerificationScreenProps {
  email: string;
  onVerified: () => void;
  onBackToLogin: () => void;
  /** Resend the sign-up confirmation code (ResendConfirmationCode). */
  onResend: (email: string) => Promise<void>;
}

const EmailVerificationScreen: React.FC<EmailVerificationScreenProps> = ({
  email,
  onVerified,
  onBackToLogin,
  onResend,
}) => {
  const { t } = useTranslation();
  const { confirmRegistration } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendNote, setResendNote] = useState('');

  const handleResend = async () => {
    setError('');
    setResendNote('');
    try {
      await onResend(email);
      setResendNote(t('auth.verify.resent'));
    } catch (err: any) {
      setError(err.message || t('auth.verify.resendError'));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!code.trim()) {
      setError(t('auth.verify.errorRequired'));
      return;
    }

    setIsSubmitting(true);

    try {
      await confirmRegistration(email, code);
      onVerified();
    } catch (err: any) {
      setError(err.message || t('auth.verify.errorFallback'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="verification-container">
      <div className="verification-card">
        <h1 className="verification-title">{t('auth.verify.title')}</h1>
        <p className="verification-subtitle">
          <Trans
            i18nKey="auth.verify.sentTo"
            components={{ strong: <strong /> }}
            values={{}}
          />
          {' '}
          <strong>{email}</strong>
        </p>

        <form onSubmit={handleSubmit} className="verification-form">
          <div className="form-group">
            <label htmlFor="code">{t('auth.verify.codeLabel')}</label>
            <input
              id="code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('auth.verify.codePlaceholder')}
              maxLength={6}
              disabled={isSubmitting}
              autoFocus
            />
          </div>

          {error && <div className="error-message">{error}</div>}
          {resendNote && <div className="help-text"><p>{resendNote}</p></div>}

          <button type="submit" className="submit-btn" disabled={isSubmitting}>
            {isSubmitting ? t('auth.verify.verifying') : t('auth.verify.verifyButton')}
          </button>

          <button
            type="button"
            className="back-btn"
            onClick={handleResend}
            disabled={isSubmitting}
          >
            {t('auth.verify.resendButton')}
          </button>

          <button
            type="button"
            className="back-btn"
            onClick={onBackToLogin}
            disabled={isSubmitting}
          >
            {t('auth.verify.backButton')}
          </button>
        </form>

        <div className="help-text">
          <p>{t('auth.verify.helpText')}</p>
        </div>
      </div>
    </div>
  );
};

export default EmailVerificationScreen;
