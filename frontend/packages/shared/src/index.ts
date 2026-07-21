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

// Note: AuthProvider.tsx has its own local `UserTier` union (identical values
// to types/index.ts's `UserTier`) — it is NOT re-exported here to avoid an
// ambiguous-export collision with the `export * from './types'` above; both
// apps use the `types/index.ts` UserTier.
export { AuthProvider, useAuth } from './providers/AuthProvider';
export type { User } from './providers/AuthProvider';

export { default as ErrorBoundary } from './components/ErrorBoundary';
export { LoginScreen } from './components/LoginScreen';
export { ForgotPasswordScreen } from './components/ForgotPasswordScreen';

export {
  exchangeCredentials,
  exchangeCredentialsProvider,
} from './services/credentialExchange';
export type { VendedCredentials } from './services/credentialExchange';

export {
  REGION,
  APP_INSTANCE_ARN,
  IDENTITY_POOL_ID,
  USER_POOL_ID,
  USER_POOL_CLIENT_ID,
  CREDENTIAL_EXCHANGE_API_URL,
  ADMIN_IAM_ENFORCEMENT,
  ADMIN_APP_URL,
} from './platform/config';

export { trackEvent, setAuthToken, trackPerformance, startTimer, endTimer, flushEvents } from './services/eventTrackingService';
export { ensureFreshIdToken } from './services/ensureFreshToken';

export { listExperiments, createExperiment, updateExperimentStatus } from './services/experimentService';
export type {
  Experiment,
  ExperimentVariant,
  ExperimentType,
  ExperimentObjective,
  ExperimentObjectiveMetric,
  ImageGenModelKey,
} from './services/experimentService';

export { submitMessageFeedback, getFeedbackSummary } from './services/feedbackService';
export type { FeedbackSummaryRow } from './services/feedbackService';

export {
  parseMessageContent,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
  unwrapLexEnvelope,
  isAllowedBattleImageUrl,
} from './utils/messageParser';
export type { NavigateChannel, BattleMarker, BattleWaiting, BattleImage } from './utils/messageParser';

// Shared model-strategy reference data (used by the chat NewConversationModal +
// BattleScorecard and the admin ModelStrategyTab).
export * from './config/modelStrategy';
