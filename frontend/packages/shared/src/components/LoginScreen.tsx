import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trackEvent } from '../services/eventTrackingService';
import { issuerDisplayName, type RedirectFailure, type SignInIssuer } from '../services/redirectSignIn';
import './LoginScreen.css';

interface LoginScreenProps {
  onLogin: (email: string, password: string) => Promise<void>;
  /** Switch to the self-service registration screen. Omitted on surfaces that do
   *  not allow self-registration (e.g. the admin console), which hides the link. */
  onSwitchToRegister?: () => void;
  /** Non-null when sign-in hit a NEW_PASSWORD_REQUIRED challenge (admin first
   *  login with a temporary password). Switches the form to "set a new password". */
  passwordChallenge?: { email: string } | null;
  onSetNewPassword?: (newPassword: string) => Promise<void>;
  /** Non-null when sign-in hit a TOTP/SMS MFA challenge. Switches the form to a
   *  one-time-code input resolved by onCompleteMfa. */
  mfaChallenge?: { email: string; type: 'SOFTWARE_TOKEN_MFA' | 'SMS_MFA' } | null;
  onCompleteMfa?: (code: string) => Promise<void>;
  /** Switch to the self-service password-reset screen. */
  onForgotPassword?: () => void;
  /** Visual surface. 'admin' applies the operator (amber) treatment plus an
   *  "Admin Console" badge so admin sign-in is unmistakable from the chat login. */
  variant?: 'chat' | 'admin';
  /** The redirect issuers to offer above the password form, each by its localized display name. */
  signInIssuers?: readonly SignInIssuer[];
  /** Start a redirect sign-in (authorization code with PKCE) at one of them. */
  onSignInWithIssuer?: (issuerId: string) => Promise<void> | void;
  /** Why the last redirect sign-in did not finish. Replaces the form with its message and a way back. */
  redirectError?: RedirectFailure | null;
  onDismissRedirectError?: () => void;
}

export function LoginScreen({
  onLogin,
  onSwitchToRegister,
  passwordChallenge,
  onSetNewPassword,
  mfaChallenge,
  onCompleteMfa,
  onForgotPassword,
  variant = 'chat',
  signInIssuers = [],
  onSignInWithIssuer,
  redirectError,
  onDismissRedirectError,
}: LoginScreenProps) {
  const { t, i18n } = useTranslation();
  // The issuer whose sign-in is being opened, so its button says so and the others wait.
  const [redirectingTo, setRedirectingTo] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState('');
  // New-password (first-login reset) form state.
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // MFA one-time-code form state.
  const [mfaCode, setMfaCode] = useState('');

  const handleMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!mfaCode.trim()) {
      setError(t('auth.mfa.codeRequired'));
      return;
    }
    setIsLoggingIn(true);
    try {
      await onCompleteMfa?.(mfaCode.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.mfa.error'));
    } finally {
      setIsLoggingIn(false);
    }
  };

  // The sign-in funnel's entry step. Its success step, `signin_succeeded`, is recorded by AuthProvider
  // where Cognito returns the tokens, because a password step that answers with an MFA or new-password
  // challenge has not signed anyone in yet.
  useEffect(() => {
    trackEvent('signin_form_viewed');
  }, []);

  const handleSetNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setIsLoggingIn(true);
    try {
      await onSetNewPassword?.(newPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the new password.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError(t('auth.login.validationError'));
      return;
    }

    setIsLoggingIn(true);
    trackEvent('signin_submitted');
    try {
      await onLogin(email, password);
    } catch (err) {
      const reason = err instanceof Error ? err.name || err.message.slice(0, 80) : 'unknown';
      trackEvent('signin_failed', { reason });
      setError(err instanceof Error ? err.message : t('auth.login.failureFallback'));
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleIssuer = async (issuerId: string) => {
    setError('');
    setRedirectingTo(issuerId);
    try {
      await onSignInWithIssuer?.(issuerId);
    } finally {
      // Reached only when the tab did not leave: the provider shows why through redirectError.
      setRedirectingTo(null);
    }
  };

  const providers = signInIssuers.length > 0 && onSignInWithIssuer ? (
    <div className="login-providers" role="group" aria-label={t('auth.redirect.providersLabel')}>
      {signInIssuers.map((issuer) => {
        const name = issuerDisplayName(issuer, i18n.language);
        return (
          <button
            key={issuer.id}
            type="button"
            className="btn btn-secondary btn-lg login-provider"
            onClick={() => void handleIssuer(issuer.id)}
            disabled={isLoggingIn || redirectingTo !== null}
            data-issuer={issuer.id}
          >
            {redirectingTo === issuer.id ? t('auth.redirect.redirecting', { name }) : t('auth.redirect.continueWith', { name })}
          </button>
        );
      })}
      <div className="login-divider"><span>{t('auth.redirect.orPassword')}</span></div>
    </div>
  ) : null;

  return (
    <div className={`login-screen${variant === 'admin' ? ' login-screen--admin' : ''}`}>
      <div className="login-container">
        <div className="auth-mark" aria-hidden="true">
          <span className="auth-mark-glyph">⟁</span>
          <span className="auth-mark-version">v0.2</span>
        </div>
        <div className="login-header">
          {variant === 'admin' && (
            <span className="admin-console-badge">{t('auth.login.adminBadge')}</span>
          )}
          <h1 className="login-title">{t('app.brandName')}</h1>
          <p className="login-subtitle">
            {passwordChallenge
              ? 'Set a new password to finish signing in'
              : mfaChallenge
                ? t('auth.mfa.subtitle')
                : variant === 'admin'
                  ? t('auth.login.adminSubtitle')
                  : t('auth.login.subtitle')}
          </p>
        </div>

        {redirectError ? (
          <div className="login-form" role="alert" data-testid="redirect-error">
            <p className="login-redirect-title">{t('auth.redirect.failedTitle')}</p>
            <div className="error-message">{t(`auth.redirect.errors.${redirectError}`)}</div>
            <button type="button" className="btn btn-primary btn-lg login-submit" onClick={onDismissRedirectError}>
              {t('auth.redirect.backToSignIn')}
            </button>
          </div>
        ) : passwordChallenge ? (
          <form onSubmit={handleSetNewPassword} className="login-form">
            <p className="login-footer-note" style={{ marginTop: 0 }}>
              Your account (<strong>{passwordChallenge.email}</strong>) was created with a
              temporary password. Choose a permanent one to continue.
            </p>
            <div className="form-group">
              <label htmlFor="new-password" className="label">New password</label>
              <input
                id="new-password"
                type="password"
                className="input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                disabled={isLoggingIn}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label htmlFor="confirm-password" className="label">Confirm password</label>
              <input
                id="confirm-password"
                type="password"
                className="input"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter the password"
                disabled={isLoggingIn}
                autoComplete="new-password"
              />
            </div>
            {error && <div className="error-message">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={isLoggingIn}>
              {isLoggingIn ? 'Setting password…' : 'Set password & sign in'}
            </button>
          </form>
        ) : mfaChallenge ? (
        <form onSubmit={handleMfa} className="login-form">
          <p className="login-footer-note" style={{ marginTop: 0 }}>
            {mfaChallenge.type === 'SMS_MFA' ? t('auth.mfa.smsPrompt') : t('auth.mfa.totpPrompt')}
          </p>
          <div className="form-group">
            <label htmlFor="mfa-code" className="label">{t('auth.mfa.codeLabel')}</label>
            <input
              id="mfa-code"
              type="text"
              inputMode="numeric"
              className="input"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
              disabled={isLoggingIn}
            />
          </div>
          {error && <div className="error-message">{error}</div>}
          <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={isLoggingIn}>
            {isLoggingIn ? t('auth.mfa.verifying') : t('auth.mfa.verify')}
          </button>
        </form>
        ) : (
        <>
        {providers}
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email" className="label">{t('auth.login.emailLabel')}</label>
            <input
              id="email"
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('auth.login.emailPlaceholder')}
              disabled={isLoggingIn}
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password" className="label">{t('auth.login.passwordLabel')}</label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('auth.login.passwordPlaceholder')}
              disabled={isLoggingIn}
              autoComplete="current-password"
            />
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={isLoggingIn}>
            {isLoggingIn ? t('auth.login.signingIn') : t('auth.login.signInButton')}
          </button>

          {onForgotPassword && (
            <div className="login-forgot-link">
              <button type="button" onClick={onForgotPassword} className="link-button" disabled={isLoggingIn}>
                {t('auth.forgot.linkPrompt')}
              </button>
            </div>
          )}
        </form>
        </>
        )}

        {!redirectError && !passwordChallenge && !mfaChallenge && onSwitchToRegister && (
        <div className="login-register-link">
          {t('auth.login.noAccountPrompt')}{' '}
          <button onClick={onSwitchToRegister} className="link-button">
            {t('auth.login.createAccountLink')}
          </button>
        </div>
        )}

        {signInIssuers.length === 0 && (
        <div className="login-footer">
          <p className="login-footer-note">{t('auth.login.footerNote')}</p>
        </div>
        )}
      </div>
    </div>
  );
}
