import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './LoginScreen.css';

interface ForgotPasswordScreenProps {
  /** Start the reset: Cognito emails a confirmation code. */
  onRequestReset: (email: string) => Promise<void>;
  /** Complete the reset with the emailed code + new password. */
  onConfirmReset: (email: string, code: string, newPassword: string) => Promise<void>;
  onBackToLogin: () => void;
}

/**
 * Self-service password reset on the raw Cognito SDK (no Amplify). Two steps:
 *   1. request  — enter email; Cognito sends a ForgotPassword code.
 *   2. confirm  — enter the code + a new password (ConfirmForgotPassword).
 * Mirrors the LoginScreen structure/styles.
 */
export function ForgotPasswordScreen({ onRequestReset, onConfirmReset, onBackToLogin }: ForgotPasswordScreenProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email) {
      setError(t('auth.forgot.emailRequired'));
      return;
    }
    setBusy(true);
    try {
      await onRequestReset(email);
      // Always advance (onRequestReset swallows UserNotFound to avoid account enumeration).
      setStep('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.forgot.requestError'));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError(t('auth.forgot.passwordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('auth.forgot.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      await onConfirmReset(email, code.trim(), newPassword);
      onBackToLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.forgot.confirmError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-container">
        <div className="auth-mark" aria-hidden="true">
          <span className="auth-mark-glyph">⟁</span>
          <span className="auth-mark-version">v0.2</span>
        </div>
        <div className="login-header">
          <h1 className="login-title">{t('auth.forgot.title')}</h1>
          <p className="login-subtitle">
            {step === 'request' ? t('auth.forgot.subtitleRequest') : t('auth.forgot.subtitleConfirm')}
          </p>
        </div>

        {step === 'request' ? (
          <form onSubmit={handleRequest} className="login-form">
            <div className="form-group">
              <label htmlFor="forgot-email" className="label">{t('auth.login.emailLabel')}</label>
              <input
                id="forgot-email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>
            {error && <div className="error-message">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={busy}>
              {busy ? t('auth.forgot.sending') : t('auth.forgot.sendCode')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleConfirm} className="login-form">
            <p className="login-footer-note" style={{ marginTop: 0 }}>
              {t('auth.forgot.codeSentTo')} <strong>{email}</strong>
            </p>
            <div className="form-group">
              <label htmlFor="forgot-code" className="label">{t('auth.forgot.codeLabel')}</label>
              <input
                id="forgot-code"
                type="text"
                inputMode="numeric"
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="forgot-new-password" className="label">{t('auth.forgot.newPasswordLabel')}</label>
              <input
                id="forgot-new-password"
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="form-group">
              <label htmlFor="forgot-confirm-password" className="label">{t('auth.forgot.confirmPasswordLabel')}</label>
              <input
                id="forgot-confirm-password"
                type="password"
                className="input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <div className="error-message">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={busy}>
              {busy ? t('auth.forgot.resetting') : t('auth.forgot.resetPassword')}
            </button>
          </form>
        )}

        <p className="login-footer-note">
          <button type="button" className="link-button" onClick={onBackToLogin}>
            {t('auth.forgot.backToLogin')}
          </button>
        </p>
      </div>
    </div>
  );
}
