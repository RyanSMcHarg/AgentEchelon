/**
 * Same-instance platform configuration, read from Vite env vars.
 *
 * The chat and admin apps are separate BUILD/DEPLOY targets but run against the
 * SAME Amazon Chime app instance, SAME Cognito user pool + users, and SAME
 * credential-exchange endpoint (one pool; authority = `admins` group
 * membership). Both apps import these constants from `@ae/shared` so the two
 * builds can never drift onto different instances — there is exactly one
 * source of these values, re-read per app from that app's own `.env`
 * (identical values are expected in both).
 */

export const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1';
export const APP_INSTANCE_ARN = import.meta.env.VITE_APP_INSTANCE_ARN;
export const IDENTITY_POOL_ID = import.meta.env.VITE_IDENTITY_POOL_ID;
export const USER_POOL_ID = import.meta.env.VITE_USER_POOL_ID;
/**
 * The Cognito app-client this build authenticates against — on the ONE shared
 * user pool. The admin app may run against a DEDICATED admin app-client (P3,
 * `VITE_ADMIN_CLIENT_ID`) for session isolation; when that is unset (reuse mode,
 * or the chat app) it falls back to the shared client (`VITE_CLIENT_ID`). Single
 * fallback path, so "reuse the shared client" stays a config option with no
 * extra code — see SPEC-SEPARATE-ADMIN-APP.md P3.
 */
export const USER_POOL_CLIENT_ID =
  import.meta.env.VITE_ADMIN_CLIENT_ID || import.meta.env.VITE_CLIENT_ID;
/**
 * Credential Exchange Service (SPEC-CREDENTIAL-EXCHANGE). Credentials are
 * vended by the backend exchange (bearer-pinned to the caller's own
 * AppInstanceUser) rather than the Identity Pool directly. Reused by every
 * plane (chat, admin, rename) — see `services/credentialExchange.ts`.
 */
export const CREDENTIAL_EXCHANGE_API_URL = import.meta.env.VITE_CREDENTIAL_EXCHANGE_API_URL;
