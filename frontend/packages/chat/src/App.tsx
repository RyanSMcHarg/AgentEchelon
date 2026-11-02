import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AuthProvider, useAuth, LoginScreen, ForgotPasswordScreen, ErrorBoundary, takeInvitationOutcome, restorePendingInvitation,
  peekPendingUpgrade, settlePendingUpgrade, takeUpgradeOutcome, type InvitationOutcome, type UpgradeOutcome,
  useDeploymentClassificationsReady,
} from '@ae/shared';
import { ArrivalNotice } from './components/ArrivalNotice';
import { AwsClientProvider, useAwsClient } from './providers/AwsClientProvider';
import { MessagingProvider } from './providers/MessagingProvider';
import { ConversationProvider, useConversations } from './providers/ConversationProvider.chime';
import RegistrationScreen from './components/RegistrationScreen';
import EmailVerificationScreen from './components/EmailVerificationScreen';
import Header from './components/Header';
import ConversationList from './components/ConversationList';
import { OpenWorkItems } from './components/OpenWorkItems';
import ConversationInterface from './components/ConversationInterface';
import MessageInput from './components/MessageInput';
import NewConversationModal from './components/NewConversationModal';
import DeploymentStatusBanner from './components/DeploymentStatusBanner';
import AccountSettingsModal from './components/AccountSettingsModal';
import { isEmailPreferencesConfigured } from './services/noticePreferencesService';
import '@ae/shared/styles/App.css';
import { requestMessageFocus } from './utils/focusMessage';

type AuthView = 'login' | 'register' | 'verify' | 'success' | 'forgot';

function AppContent() {
  const {
    isAuthenticated, isLoading, login, register, passwordChallenge, completeNewPassword,
    mfaChallenge, completeMfa, forgotPassword, confirmForgotPassword, resendCode,
    signInIssuers, signInWithIssuer, redirectError, clearRedirectError, idToken, logout,
  } = useAuth();
  const { isInitialized } = useAwsClient();
  // THE DEPLOYMENT'S CLASSIFICATIONS, loaded once signed in (`GET /classifications`); the build's fallback serves
  // the registration screen before sign-in.
  const classificationsReady = useDeploymentClassificationsReady(isAuthenticated ? idToken : null);
  const { t } = useTranslation();
  const { activeConversation, selectConversation, clearActiveConversation } = useConversations();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [authView, setAuthView] = useState<AuthView>('login');
  const [registeredEmail, setRegisteredEmail] = useState('');
  // WHAT A SIGN-IN INVITATION CAME TO (M-10): the conversation it opened, or the settled refusal to show.
  const [invitationOutcome, setInvitationOutcome] = useState<InvitationOutcome | null>(null);
  // WHAT KEEPING A WIDGET VISIT CAME TO (paths A and B): the conversation it continues in, or why not.
  const [upgradeOutcome, setUpgradeOutcome] = useState<UpgradeOutcome | null>(null);
  const [upgradeRetrying, setUpgradeRetrying] = useState(false);
  // One redemption at a time: a claim is single-use, so a second call in flight would read as used.
  const claiming = useRef(false);
  // ACCOUNT SETTINGS: opened from the account menu, or by `?settings=email-preferences`, the link an email's
  // preference page carries, which lands on the email section. Email is offered only when the deployment sends it.
  const emailPreferencesOffered = isEmailPreferencesConfigured();
  const [settingsOpen, setSettingsOpen] = useState<null | 'account' | 'email'>(null);

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
    // `#message=<id>` deep-links to a SPECIFIC message, not just the conversation. A drift-created
    // conversation links back to the message that caused it, so landing at the bottom of a long thread
    // would leave the reader to hunt for it. Read before the URL is cleaned below.
    const messageId = decodeURIComponent((window.location.hash.match(/message=([^&]+)/) || [])[1] || '');
    // Recorded BEFORE selecting, because the target's history has not loaded yet. ConversationInterface
    // scrolls to it in an effect once the message renders, so nothing here waits or polls. The request is
    // scoped to this conversation and gives up after a bounded wait, so a target that never renders (deleted,
    // redacted, past the loaded page) cannot keep suppressing auto-scroll.
    if (messageId) requestMessageFocus(messageId, conversationId);
    void selectConversation(conversationId).finally(() => {
      // Clean up URL once selection has been attempted.
      window.history.replaceState({}, '', window.location.pathname);
    });
  }, [isAuthenticated, isInitialized, selectConversation]);

  // `?settings=email-preferences` opens the screen once the person is signed in, and the URL is cleaned.
  useEffect(() => {
    if (!isAuthenticated) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('settings') !== 'email-preferences') return;
    if (emailPreferencesOffered) setSettingsOpen('email');
    window.history.replaceState({}, '', window.location.pathname);
  }, [isAuthenticated, emailPreferencesOffered]);

  // A SIGN-IN INVITATION, once the first exchange has presented it: open its conversation, or say why not.
  useEffect(() => {
    if (!isAuthenticated || !isInitialized) return;
    const outcome = takeInvitationOutcome();
    if (!outcome) return;
    setInvitationOutcome(outcome);
    if ('joined' in outcome) void selectConversation(outcome.joined.split('/').pop() || '');
  }, [isAuthenticated, isInitialized, selectConversation]);

  // A VISIT KEPT FROM THE WIDGET, once the person is signed in: a bind's continuation is opened; a claim is
  // redeemed now, and its conversation opened; anything else is said, with what to do next.
  useEffect(() => {
    if (!isAuthenticated || !isInitialized) return;
    const open = (outcome: UpgradeOutcome) => {
      setUpgradeOutcome(outcome);
      if ('opened' in outcome) void selectConversation(outcome.opened.split('/').pop() || '');
    };
    const recorded = takeUpgradeOutcome();
    if (recorded) open(recorded);
    if (peekPendingUpgrade()?.kind !== 'claim' || !idToken || claiming.current) return;
    claiming.current = true;
    void settlePendingUpgrade(idToken)
      .then((o) => { if (o) { takeUpgradeOutcome(); open(o); } })
      .finally(() => { claiming.current = false; });
  }, [isAuthenticated, isInitialized, selectConversation, idToken]);

  const retryUpgrade = async () => {
    if (!idToken || upgradeRetrying || claiming.current) return;
    claiming.current = true;
    setUpgradeRetrying(true);
    try {
      const outcome = await settlePendingUpgrade(idToken);
      takeUpgradeOutcome();
      if (outcome) {
        setUpgradeOutcome(outcome);
        if ('opened' in outcome) void selectConversation(outcome.opened.split('/').pop() || '');
      }
    } finally {
      claiming.current = false;
      setUpgradeRetrying(false);
    }
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
        signInIssuers={signInIssuers}
        onSignInWithIssuer={signInWithIssuer}
        redirectError={redirectError}
        onDismissRedirectError={clearRedirectError}
      />
    );
  }

  // The admin console is a SEPARATE app (AgentEchelonAdminApp, admin.html /
  // admin-main.tsx) served from its own origin — it is NOT a route in this chat
  // SPA. The chat bundle therefore carries no operator code or admin endpoints;
  // assert-no-admin-in-chat.mjs pins that invariant. See DESIGN-SEPARATE-ADMIN-APP.md.
  // Signed in: conversations, badges and pickers render with the deployment's set once it has answered.
  if (!classificationsReady) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner"></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Header onOpenSettings={() => setSettingsOpen('account')} />
      <ArrivalNotice
        invitation={invitationOutcome}
        upgrade={upgradeOutcome}
        retrying={upgradeRetrying}
        onRetry={() => void retryUpgrade()}
        onSignOutAndContinue={(token) => {
          // The invitation is pending again for the next sign-in, which a new account makes; this account is not bound.
          restorePendingInvitation(token);
          setInvitationOutcome(null);
          void logout();
        }}
        onDismiss={() => { setInvitationOutcome(null); setUpgradeOutcome(null); }}
      />
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
          {/* Above the conversation list on purpose: an item you owe outranks the list of places you
              might go, and it is the one thing a returning user should see before choosing. */}
          <OpenWorkItems />
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
      <AccountSettingsModal
        isOpen={settingsOpen !== null}
        onClose={() => setSettingsOpen(null)}
        emailOffered={emailPreferencesOffered}
        focusEmail={settingsOpen === 'email'}
      />
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
