import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { AwsClientProvider, useAwsClient } from './providers/AwsClientProvider';
import { MessagingProvider } from './providers/MessagingProvider';
import { ConversationProvider, useConversations } from './providers/ConversationProvider.chime';
import { LoginScreen } from './components/LoginScreen';
import RegistrationScreen from './components/RegistrationScreen';
import EmailVerificationScreen from './components/EmailVerificationScreen';
import { ForgotPasswordScreen } from './components/ForgotPasswordScreen';
import Header from './components/Header';
import ConversationList from './components/ConversationList';
import ConversationInterface from './components/ConversationInterface';
import MessageInput from './components/MessageInput';
import NewConversationModal from './components/NewConversationModal';
import AdminDashboard from './components/admin/AdminDashboard';
import { detectAnalyticsMode } from './services/analyticsService';
import ErrorBoundary from './components/ErrorBoundary';
import DeploymentStatusBanner from './components/DeploymentStatusBanner';
import './App.css';

type AuthView = 'login' | 'register' | 'verify' | 'success' | 'forgot';

function AppContent() {
  const {
    user, isAuthenticated, isLoading, login, register, passwordChallenge, completeNewPassword,
    mfaChallenge, completeMfa, forgotPassword, confirmForgotPassword, resendCode,
  } = useAuth();
  const { isInitialized } = useAwsClient();
  const { activeConversation, selectConversation } = useConversations();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [authView, setAuthView] = useState<AuthView>('login');
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [isAdminView, setIsAdminView] = useState(false);
  // Which analytics backend this deployment runs (env-first, then a backend
  // probe). Drives the admin dashboard's mode-specific banners; without it the
  // dashboard defaults to 'athena' and an Aurora deployment mis-tells the
  // operator to "redeploy with analyticsMode=aurora".
  const [analyticsMode, setAnalyticsMode] = useState<'athena' | 'aurora'>('athena');

  // Deep link: auto-select conversation from the `?conversation=<id>` query
  // param (share + proactive-briefing emails). selectConversation resolves the
  // id against the loaded list and falls back to describing the channel
  // directly, so the link works even when the channel isn't in the recipient's
  // sidebar yet (past the first page, or freshly shared).
  useEffect(() => {
    // Wait until the Chime client is initialized — selectConversation's
    // describe-channel fallback needs it, and attempting (then cleaning the
    // URL) before it's ready would lose the deep link.
    if (!isAuthenticated || !isInitialized) return;
    const params = new URLSearchParams(window.location.search);
    const conversationId = params.get('conversation');
    if (!conversationId) return;
    void selectConversation(conversationId).finally(() => {
      // Clean up URL once selection has been attempted.
      window.history.replaceState({}, '', window.location.pathname);
    });
  }, [isAuthenticated, isInitialized, selectConversation]);

  // Resolve the analytics mode once authenticated (the backend probe needs a
  // token). Env var short-circuits the probe when set.
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

  // The admin console is URL-addressable via `?admin` so it can be deep-linked
  // (a foundation for automated reporting) and so the browser Back button
  // returns to the app instead of leaving the site (#44). Opening admin pushes a
  // history entry; Back/popstate syncs the view from the URL. Sub-tab-level deep
  // links (`?admin=<tab>`) are handled in AdminDashboard, which owns the tab VALUE
  // in the query param; this effect owns the `?admin` PRESENCE (console open/closed).
  useEffect(() => {
    const sync = () => setIsAdminView(new URLSearchParams(window.location.search).has('admin'));
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const openAdmin = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('admin', '1');
    window.history.pushState({}, '', url);
    setIsAdminView(true);
  };

  const goHome = () => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('admin')) {
      url.searchParams.delete('admin');
      window.history.replaceState({}, '', url);
    }
    setIsAdminView(false);
  };

  if (isLoading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    if (authView === 'verify' && registeredEmail) {
      return (
        <EmailVerificationScreen
          email={registeredEmail}
          onVerified={() => setAuthView('success')}
          onResend={resendCode}
          onBackToLogin={() => {
            setAuthView('login');
            setRegisteredEmail('');
          }}
        />
      );
    }

    if (authView === 'success') {
      return (
        <div className="registration-success-screen">
          <div className="success-container">
            <div className="success-icon">✓</div>
            <h1>Email Verified!</h1>
            <p>Your email has been successfully verified.</p>
            <p>An administrator will review and approve your account shortly.</p>
            <button
              className="success-button"
              onClick={() => {
                setAuthView('login');
                setRegisteredEmail('');
              }}
            >
              Go to Sign In
            </button>
          </div>
        </div>
      );
    }

    if (authView === 'register') {
      return (
        <RegistrationScreen
          onRegister={async (email, password, tier) => {
            await register(email, password, tier);
            setRegisteredEmail(email);
            setAuthView('verify');
          }}
          onSwitchToLogin={() => setAuthView('login')}
        />
      );
    }

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
        onLogin={login}
        onSwitchToRegister={() => setAuthView('register')}
        passwordChallenge={passwordChallenge}
        onSetNewPassword={completeNewPassword}
        mfaChallenge={mfaChallenge}
        onCompleteMfa={completeMfa}
        onForgotPassword={() => setAuthView('forgot')}
      />
    );
  }

  // The admin console renders ONLY for a member of the `admins` group. `isAdminView`
  // tracks the `?admin` URL param (deep-link/Back support), but the URL alone must never
  // reveal the console: any authenticated user could set `?admin=1`, so the render is gated
  // on `user?.isAdmin` here. The backend independently enforces `requireAdmin` on every admin
  // API, so this is the UI-affordance gate, not the authorization boundary.
  if (isAdminView && user?.isAdmin) {
    return (
      <div className="app">
        <Header onAdminToggle={goHome} isAdminView={true} onHome={goHome} />
        <AdminDashboard onBack={goHome} analyticsMode={analyticsMode} />
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        onAdminToggle={openAdmin}
        isAdminView={false}
        onHome={goHome}
      />
      <div className="app-content">
        <div className="app-sidebar">
          <div className="app-sidebar-header">
            <button className="app-new-conversation-btn" onClick={() => setIsModalOpen(true)}>
              <span>+</span> New conversation
            </button>
          </div>
          <ConversationList onNewConversation={() => setIsModalOpen(true)} />
        </div>

        <div className="app-main">
          <ConversationInterface />
          {activeConversation && <MessageInput />}
        </div>
      </div>

      <NewConversationModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <DeploymentStatusBanner />
      <AuthProvider>
        <AwsClientProvider>
          <MessagingProvider>
            <ConversationProvider>
              <AppContent />
            </ConversationProvider>
          </MessagingProvider>
        </AwsClientProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
