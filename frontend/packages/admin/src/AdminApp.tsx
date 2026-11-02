import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth, LoginScreen, ForgotPasswordScreen, ErrorBoundary, useDeploymentClassificationsReady } from '@ae/shared';
import AdminDashboard from './components/admin/AdminDashboard';
import { detectAnalyticsMode } from './services/analyticsService';
import { CapabilityProvider, useConsoleAccess } from './capabilities';
import '@ae/shared/styles/App.css';

type AdminAuthView = 'login' | 'forgot';

/**
 * The standalone admin console shell. Opens on the operator's console session - the capabilities their
 * role holds - and mounts AdminDashboard. This is the ENTRY of the separate admin app (admin-main.tsx),
 * not a route inside the chat SPA — see DESIGN-SEPARATE-ADMIN-APP.md.
 *
 * Auth: reuses the chat app's raw-SDK Cognito AuthProvider (no Amplify). Admins
 * are provisioned, not self-registered, so there is no registration path here —
 * LoginScreen hides its "create account" link when onSwitchToRegister is omitted.
 * The console opens for a sign-in whose console session holds at least one capability (SPEC-ADMIN-CONSOLE
 * FR44), never for a group name, so every role built from the capability matrix can use it. IAM enforces
 * every route independently, so this is the affordance, not the control.
 */
function AdminAppContent() {
  const { t } = useTranslation();
  const {
    user, isAuthenticated, isLoading, login, logout,
    passwordChallenge, completeNewPassword, mfaChallenge, completeMfa,
    forgotPassword, confirmForgotPassword,
    signInIssuers, signInWithIssuer, redirectError, clearRedirectError, idToken,
  } = useAuth();
  const access = useConsoleAccess();
  // THE DEPLOYMENT'S CLASSIFICATIONS, loaded once signed in (`GET /classifications` on the person API). The console
  // renders nothing before sign-in, so its build carries no fallback.
  const classificationsReady = useDeploymentClassificationsReady(isAuthenticated ? idToken : null);
  const [authView, setAuthView] = useState<AdminAuthView>('login');
  // Which analytics backend this deployment runs (env-first, then a backend
  // probe). Drives the dashboard's mode-specific banners + tab set.
  const [analyticsMode, setAnalyticsMode] = useState<'athena' | 'aurora'>('athena');

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void detectAnalyticsMode().then((mode) => {
      if (!cancelled) setAnalyticsMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  if (isLoading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner"></div>
        <p>{t('admin.app.loading')}</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (authView === 'forgot') {
      return (
        <ForgotPasswordScreen
          onRequestReset={forgotPassword}
          onConfirmReset={confirmForgotPassword}
          onBackToLogin={() => setAuthView('login')}
        />
      );
    }
    return (
      <LoginScreen
        variant="admin"
        onLogin={login}
        passwordChallenge={passwordChallenge}
        onSetNewPassword={completeNewPassword}
        mfaChallenge={mfaChallenge}
        onCompleteMfa={completeMfa}
        onForgotPassword={() => setAuthView('forgot')}
        // The console offers only the issuers whose people may hold an admin role.
        signInIssuers={signInIssuers.filter((i) => i.admin)}
        onSignInWithIssuer={signInWithIssuer}
        redirectError={redirectError}
        onDismissRedirectError={clearRedirectError}
      />
    );
  }

  if (access.status === 'loading' || !classificationsReady) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner"></div>
        <p>{t('admin.app.loading')}</p>
      </div>
    );
  }

  // Signed in, but the session holds no admin capability, or could not be issued: never reveal the
  // console, and say which of the two it is (FR53).
  if (access.status === 'denied' || access.status === 'error') {
    return (
      <div className="registration-success-screen">
        <div className="success-container">
          <h1>{t('admin.app.accessDenied')}</h1>
          <p>
            {access.status === 'error'
              ? access.message
              : access.code === 'NO_TEAM'
                ? t('admin.refusal.noTeam')
                : access.code === 'TEAM_SCOPE_TOO_LARGE'
                  ? t('admin.refusal.teamScopeTooLarge')
                  : t('admin.refusal.noAdminCapability')}
          </p>
          <p>{t('admin.app.signedInAs', { email: user?.email || '' })}</p>
          <button className="btn-primary" onClick={logout}>{t('admin.app.signOut')}</button>
        </div>
      </div>
    );
  }

  // Standalone app: leaving the console (onBack) signs the operator out — there
  // is no chat surface to return to.
  return (
    <div className="app">
      <AdminDashboard onBack={logout} analyticsMode={analyticsMode} />
    </div>
  );
}

function AdminApp() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <CapabilityProvider>
          <AdminAppContent />
        </CapabilityProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default AdminApp;
