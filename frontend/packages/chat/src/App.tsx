import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth, LoginScreen, ForgotPasswordScreen, ErrorBoundary } from '@ae/shared';
import { AwsClientProvider, useAwsClient } from './providers/AwsClientProvider';
import { MessagingProvider } from './providers/MessagingProvider';
import { ConversationProvider, useConversations } from './providers/ConversationProvider.chime';
import RegistrationScreen from './components/RegistrationScreen';
import EmailVerificationScreen from './components/EmailVerificationScreen';
import Header from './components/Header';
import ConversationList from './components/ConversationList';
import ConversationInterface from './components/ConversationInterface';
import MessageInput from './components/MessageInput';
import NewConversationModal from './components/NewConversationModal';
import DeploymentStatusBanner from './components/DeploymentStatusBanner';
import '@ae/shared/styles/App.css';

type AuthView = 'login' | 'register' | 'verify' | 'success' | 'forgot';

function AppContent() {
  const {
    isAuthenticated, isLoading, login, register, passwordChallenge, completeNewPassword,
    mfaChallenge, completeMfa, forgotPassword, confirmForgotPassword, resendCode,
  } = useAuth();
  const { isInitialized } = useAwsClient();
  const { t } = useTranslation();
  const { activeConversation, selectConversation, clearActiveConversation } = useConversations();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [authView, setAuthView] = useState<AuthView>('login');
  const [registeredEmail, setRegisteredEmail] = useState('');

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

  // The admin console is a SEPARATE app (AgentEchelonAdminFrontend, admin.html /
  // admin-main.tsx) served from its own origin — it is NOT a route in this chat
  // SPA. The chat bundle therefore carries no operator code or admin endpoints;
  // assert-no-admin-in-chat.mjs pins that invariant. See SPEC-SEPARATE-ADMIN-APP.md.
  return (
    <div className="app">
      <Header />
      {/* `has-active` drives the mobile master-detail swap: below the breakpoint the
          list is shown until a conversation is active, then the detail pane takes over
          (the two panes stay side by side on desktop). */}
      <div className={`app-content${activeConversation ? ' has-active' : ''}`}>
        <div className="app-sidebar">
          <div className="app-sidebar-header">
            <button className="app-new-conversation-btn" onClick={() => setIsModalOpen(true)}>
              <span>+</span> New conversation
            </button>
          </div>
          <ConversationList onNewConversation={() => setIsModalOpen(true)} />
        </div>

        <div className="app-main">
          <button
            type="button"
            className="app-mobile-back"
            onClick={clearActiveConversation}
            aria-label={t('header.conversations')}
          >
            <span aria-hidden="true">&#8592;</span> {t('header.conversations')}
          </button>
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
