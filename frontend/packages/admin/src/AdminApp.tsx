import { useState, useEffect } from 'react';
import { AuthProvider, useAuth, LoginScreen, ForgotPasswordScreen, ErrorBoundary } from '@ae/shared';
import AdminDashboard from './components/admin/AdminDashboard';
import { detectAnalyticsMode } from './services/analyticsService';
import '@ae/shared/styles/App.css';

type AdminAuthView = 'login' | 'forgot';

/**
 * The standalone admin console shell. Gates on the `admins` group and mounts
 * AdminDashboard. This is the ENTRY of the separate admin app (admin-main.tsx),
 * not a route inside the chat SPA — see SPEC-SEPARATE-ADMIN-APP.md.
 *
 * Auth: reuses the chat app's raw-SDK Cognito AuthProvider (no Amplify). Admins
 * are provisioned, not self-registered, so there is no registration path here —
 * LoginScreen hides its "create account" link when onSwitchToRegister is omitted.
 * The console renders ONLY for `user.isAdmin`; the backend independently enforces
 * `requireAdmin` on every admin API, so this is the UI-affordance gate.
 */
function AdminAppContent() {
  const {
    user, isAuthenticated, isLoading, login, logout,
    passwordChallenge, completeNewPassword, mfaChallenge, completeMfa,
    forgotPassword, confirmForgotPassword,
  } = useAuth();
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
        <p>Loading...</p>
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
      />
    );
  }

  // Authenticated but not an admin: never reveal the console.
  if (!user?.isAdmin) {
    return (
      <div className="registration-success-screen">
        <div className="success-container">
          <h1>Access denied</h1>
          <p>This console is restricted to administrators.</p>
          <p>You are signed in as {user?.email || 'a non-admin user'}.</p>
          <button className="success-button" onClick={logout}>Sign out</button>
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
        <AdminAppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default AdminApp;
