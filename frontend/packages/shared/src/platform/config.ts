/**
 * Same-instance platform configuration, read from Vite env vars.
 *
 * The chat and admin apps are separate BUILD/DEPLOY targets but run against the
 * SAME Amazon Chime app instance, SAME Cognito user pool + users, and SAME
 * person API (one pool; authority = `admins` group
 * membership). Both apps import these constants from `@ae/shared` so the two
 * builds can never drift onto different instances — there is exactly one
 * source of these values, re-read per app from that app's own `.env`
 * (identical values are expected in both).
 */

export const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1';
export const APP_INSTANCE_ARN = import.meta.env.VITE_APP_INSTANCE_ARN;
export const USER_POOL_ID = import.meta.env.VITE_USER_POOL_ID;
/**
 * The Cognito app-client this build authenticates against — on the ONE shared
 * user pool. The admin app may run against a DEDICATED admin app-client (P3,
 * `VITE_ADMIN_CLIENT_ID`) for session isolation; when that is unset (reuse mode,
 * or the chat app) it falls back to the shared client (`VITE_CLIENT_ID`). Single
 * fallback path, so "reuse the shared client" stays a config option with no
 * extra code — see DESIGN-SEPARATE-ADMIN-APP.md P3.
 */
export const USER_POOL_CLIENT_ID =
  import.meta.env.VITE_ADMIN_CLIENT_ID || import.meta.env.VITE_CLIENT_ID;
/**
 * The pool's app client a `cognito-federated` provider signs in and refreshes through, in both apps
 * (`FederatedWebClient`, the `UserPoolFederatedClientId` output). It is the only client the pool's
 * federated providers are offered on, so a federated sign-in never reaches the password client. '' when
 * the deployment federates no provider into its pool.
 */
export const FEDERATED_CLIENT_ID: string = import.meta.env.VITE_FEDERATED_CLIENT_ID || '';

// ── The person API ─────────────────────────────────────────────────────────────
/**
 * `PersonApi`, the one HTTP API every route a person calls is served on: the
 * credential exchange (SPEC-CREDENTIAL-EXCHANGE, the only source of Amazon Chime
 * SDK credentials, reused by every plane: chat, admin, rename), conversation
 * creation and management, tasks, turn state, attachments, feedback, client
 * events, and the optional battle and sharing routes. Routes sit at the API root
 * (no stage prefix). Read per app from its own `.env`; '' when unset.
 */
function personApiBase(): string {
  return String(import.meta.env.VITE_PERSON_API_URL || '').replace(/\/$/, '');
}
export const PERSON_API_URL: string = personApiBase();

/** A comma-separated capability list as a set, ignoring blanks and case. */
function capabilitySet(raw: unknown): Set<string> {
  return new Set(
    String(raw || '')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The capabilities whose person routes this deployment serves
 * (`VITE_PERSON_API_CAPABILITIES`, e.g. `battle,core,notifications`). THE LIST IS
 * THE SIGNAL THAT A FEATURE EXISTS: the battle UI exists only when it names
 * `battle`, sharing only when it names `notifications`.
 */
export const PERSON_API_CAPABILITIES: ReadonlySet<string> = capabilitySet(import.meta.env.VITE_PERSON_API_CAPABILITIES);

/**
 * Whether `PersonApi` serves a capability's routes. `core` is served whenever the
 * API is configured; every other capability must also be named in
 * `VITE_PERSON_API_CAPABILITIES`. Read at call time, so a test that stubs the env
 * sees its stub.
 */
export function personApiServes(capability: string): boolean {
  if (!personApiBase()) return false;
  const c = capability.trim().toLowerCase();
  return c === 'core' || capabilitySet(import.meta.env.VITE_PERSON_API_CAPABILITIES).has(c);
}

/**
 * Every person route a client calls, by name. Each path is a route of `PersonApi`
 * (`docs/reference/api-contract.md`), and the backend's route-table test holds
 * every `personUrl(...)` call to that table.
 */
export const PERSON_ROUTES = {
  exchangeCredentials: '/exchange-credentials',
  createConversation: '/create-conversation',
  archiveConversation: '/conversations/archive',
  removeMember: '/conversations/remove-member',
  leaveConversation: '/conversations/leave',
  tasks: '/tasks',
  myTasks: '/tasks/mine',
  turnState: '/turn-state',
  presignedUrl: '/presigned-url',
  feedback: '/feedback',
  events: '/events',
  deploymentState: '/deployment/state',
  shareConversation: '/share-conversation',
  channelBattle: '/channels/battle',
  enableBattle: '/channels/battle/enable',
  disableBattle: '/channels/battle/disable',
  battleOutcome: '/channels/battle/outcome',
} as const;

/**
 * The URL of a person route, `${VITE_PERSON_API_URL}${path}`, with `path` starting
 * at '/'. CALL IT WITH THE PATH WRITTEN OUT (`personUrl('/create-conversation')`),
 * so the route a client calls is readable, and checkable, at the call. Throws when
 * `VITE_PERSON_API_URL` is unset, because no person route exists without it.
 */
export function personUrl(path: string): string {
  const base = personApiBase();
  if (!base) throw new Error('VITE_PERSON_API_URL not configured');
  if (!path.startsWith('/')) throw new Error(`A person route path starts with '/': ${path}`);
  return `${base}${path}`;
}

/**
 * The admin console's URL (the SEPARATE admin app, `AgentEchelonAdminApp`).
 * The admin console is not a route in the chat SPA (DESIGN-SEPARATE-ADMIN-APP.md);
 * when this is set, the chat app shows an admin a LINK OUT to it (a plain URL, no
 * operator code — `assert-no-admin-in-chat.mjs` stays satisfied). A deployer can
 * point it at ANY admin surface they run (AE's own console, or one they build on
 * the same admin APIs), so the operator interface stays pluggable. Unset = no link.
 */
export const ADMIN_APP_URL = import.meta.env.VITE_ADMIN_APP_URL || '';

/**
 * The embeddable widget's origin (`VITE_WIDGET_ORIGIN`, the Widget stack's `WidgetDistributionUrl` output,
 * written by `gen-frontend-env.mjs` with the `widget` capability), or '' without one. The chat app takes a
 * path A hand-off (a visitor signing in to keep their visit) only from a window on this origin, so a page
 * elsewhere that opened the sign-in cannot hand its own visit to the person signing in. Read at call time,
 * so a test that stubs the env sees its stub.
 */
export function declaredWidgetOrigin(): string {
  const raw = String(import.meta.env.VITE_WIDGET_ORIGIN || '').trim().replace(/\/$/, '');
  try {
    return raw && new URL(raw).origin === raw ? raw : '';
  } catch {
    return '';
  }
}

// ── Sign-in issuers ────────────────────────────────────────────────────────────
/**
 * The redirect sign-in issuers this deployment declares, as `gen-frontend-env.mjs`
 * projects them from the trusted-issuer registry: public fields only, as JSON.
 * Parsed and checked by `services/redirectSignIn.ts`. Unset: password sign-in only.
 */
export const SIGN_IN_ISSUERS_JSON: string = import.meta.env.VITE_ISSUERS || '';

