// @ae/shared public barrel — types, auth, the credential-exchange primitive,
// the apiCall helper, and the small set of components/services genuinely
// shared by both the chat and admin apps.
//
// Side-effect modules (i18n, CSS) are deliberately NOT re-exported here —
// apps import those directly via the package `exports` subpaths
// (`@ae/shared/i18n`, `@ae/shared/styles/*`) so importing a single value from
// this barrel never pulls in i18n init or global CSS as a side effect.

export * from './types';
export * from './types/analytics';

export { apiCall, ApiError, setApiTokenProvider } from './api/apiCall';
export type { TokenProvider, ApiCallOptions } from './api/apiCall';

// Note: AuthProvider.tsx has its own local `UserTier` alias (the same type
// as types/index.ts's `UserTier`) — it is NOT re-exported here to avoid an
// ambiguous-export collision with the `export * from './types'` above; both
// apps use the `types/index.ts` UserTier.
export { AuthProvider, useAuth } from './providers/AuthProvider';
export type { User } from './providers/AuthProvider';

export { issuerDisplayName, REDIRECT_FAILURES } from './services/redirectSignIn';
export type { SignInIssuer, RedirectFailure } from './services/redirectSignIn';

export { default as ErrorBoundary } from './components/ErrorBoundary';
export { LoginScreen } from './components/LoginScreen';
export { ForgotPasswordScreen } from './components/ForgotPasswordScreen';

export {
  exchangeCredentials,
  exchangeCredentialsProvider,
  ExchangeRefusedError,
} from './services/credentialExchange';
export type { VendedCredentials, ExchangeAnswer, ConsoleRole } from './services/credentialExchange';
export { resolvePersonIdentity, IdentitySupersededError } from './services/personIdentity';
export { capturePendingInvitation, takeInvitationOutcome, restorePendingInvitation, type InvitationOutcome } from './services/pendingInvitation';
export { capturePendingUpgrade, peekPendingUpgrade, discardPendingUpgrade, requestPendingBindSecret, takeUpgradeOutcome, settlePendingUpgrade, type PendingUpgrade, type UpgradeOutcome, type UpgradePath } from './services/pendingUpgrade';
export type { PersonIdentity } from './services/personIdentity';

export {
  REGION,
  APP_INSTANCE_ARN,
  USER_POOL_ID,
  USER_POOL_CLIENT_ID,
  PERSON_API_URL,
  PERSON_API_CAPABILITIES,
  PERSON_ROUTES,
  personApiServes,
  personUrl,
  ADMIN_APP_URL,
  declaredWidgetOrigin,
} from './platform/config';

export { trackEvent, setAuthToken, trackPerformance, startTimer, endTimer, flushEvents } from './services/eventTrackingService';
export { ensureFreshIdToken } from './services/ensureFreshToken';

export { DEFAULT_ACCURACY_MARGIN_PCT } from './services/experimentService';
export type {
  Experiment,
  ExperimentVariant,
  ExperimentType,
  ExperimentObjective,
  ExperimentObjectiveMetric,
  ImageGenModelKey,
  BattleSetting,
  BattleChallenger,
} from './services/experimentService';

export { submitMessageFeedback, FEEDBACK_REASONS } from './services/feedbackService';
export type { FeedbackSummaryRow, FeedbackReason } from './services/feedbackService';

export {
  parseMessageContent,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
  unwrapLexEnvelope,
  isEmptyLexEnvelope,
  declaresFinalAnswer,
  decodeMessageText,
} from './utils/messageParser';
export type { NavigateChannel, BattleMarker, BattleWaiting } from './utils/messageParser';
export { personIdFromArn, botIdFromArn, userArnFor, botArnFor, isAssistantArn, isPersonArn } from './utils/principalArn';

// Shared model-strategy reference data (used by the chat NewConversationModal +
// BattleScorecard and the admin ModelStrategyTab).
export * from './config/modelStrategy';

export {
  deploymentClassifications,
  parseClassifications,
  setClassificationsForTest,
  subscribeClassifications,
  loadDeploymentClassifications,
  classificationOf,
  isDeclaredClassification,
  classificationName,
  classificationAudience,
  classificationBadgeStyle,
  creatableClassifications,
  memberConversationalClassifications,
} from './config/classifications';
export type { ClientClassification, BadgeToken, Audience } from './config/classifications';
export { useDeploymentClassificationsReady } from './config/useDeploymentClassifications';
