/**
 * A14 - admin-action capability catalog (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md).
 *
 * The single source of truth mapping each archive/analytics capability to the
 * API Gateway resource(s) it authorizes, its enforcement plane, and the personas
 * that hold it. The CDK builds the IAM role policies + per-resource authorizers
 * from this list; the credential exchange vends against the same keys. This is
 * the `execute-api` analogue of credential-exchange.ts `CAPABILITY_ACTIONS` (the
 * Chime plane).
 *
 * Enforcement split (spec section 6.5):
 *   - `signOnRole`  capabilities ride the persona's sign-on Identity-Pool role
 *     (execute-api:Invoke granted at sign-on; the console SigV4-signs with its
 *     sign-on creds). No customer message content.
 *   - `exchangeVend` capabilities (customer message content, A2) are vended
 *     per-use by the credential exchange, short-lived + audited.
 *
 * The analytics queryType->capability partition lives in
 * `lambda/src/lib/admin-capability-map.ts` (shared with the handlers). Here we
 * name the capabilities, their resources, and the persona sets.
 */

export type AdminCapabilityEnforcement = 'signOnRole' | 'exchangeVend';

/** The admin personas (SPEC section 2). Deployment choices, not a prescription. */
export type AdminPersona = 'platform-admin' | 'platform-dev' | 'ai-dev' | 'manager';
export const ADMIN_PERSONAS: AdminPersona[] = ['platform-admin', 'platform-dev', 'ai-dev', 'manager'];

/** The Cognito group each persona maps to (opt-in; created only with `enableAdminPersonas`). */
export const ADMIN_PERSONA_GROUP: Record<AdminPersona, string> = {
  'platform-admin': 'platform-admins',
  'platform-dev': 'platform-devs',
  'ai-dev': 'ai-devs',
  manager: 'managers',
};

export interface AdminApiResource {
  /** Which AE admin API the resource lives on. */
  api: 'admin-conversations' | 'analytics' | 'experiments';
  method: string;
  /** Path under the API root, e.g. `admin/conversations/messages` (no leading slash). */
  path: string;
}

export interface AdminCapability {
  key: string;
  /** Matrix rows (SPEC section 3b) this capability covers, for traceability. */
  rows: string[];
  enforcement: AdminCapabilityEnforcement;
  resources: AdminApiResource[];
  /** Personas that hold this capability (SPEC section 4 columns; Full or Scoped, not None). */
  personas: AdminPersona[];
  /** Whether the CDK wiring (per-resource authorizer + teeth) is live yet. */
  wired: boolean;
}

// Persona shorthand for the section-4 columns.
const ALL: AdminPersona[] = ['platform-admin', 'platform-dev', 'ai-dev', 'manager'];
const ADMIN_DEV_AI: AdminPersona[] = ['platform-admin', 'platform-dev', 'ai-dev'];
const ADMIN_DEV: AdminPersona[] = ['platform-admin', 'platform-dev'];
const ADMIN_DEV_MGR: AdminPersona[] = ['platform-admin', 'platform-dev', 'manager'];
const ADMIN_ONLY: AdminPersona[] = ['platform-admin'];

export const ADMIN_CAPABILITIES: Record<string, AdminCapability> = {
  // ── admin-conversations API (CognitoAuth stack) ──────────────────────────
  'view-conversations': {
    key: 'view-conversations',
    rows: ['A1', 'A4'],
    enforcement: 'signOnRole',
    resources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations' },
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations/membership-history' },
    ],
    personas: ALL, // Full / Full / Scoped / Scoped
    wired: true,
  },
  'view-messages': {
    key: 'view-messages',
    rows: ['A2'],
    enforcement: 'exchangeVend',
    resources: [{ api: 'admin-conversations', method: 'GET', path: 'admin/conversations/messages' }],
    personas: ALL, // Full / Scoped / Scoped / Scoped
    wired: true,
  },
  // ── analytics API (Analytics{,Aurora} stack) — the per-capability split ───
  'view-events': {
    key: 'view-events',
    rows: ['A3'],
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'events-log' }],
    personas: ADMIN_DEV_AI, // Full / Full / Scoped / None
    wired: true,
  },
  'view-user-activity': {
    key: 'view-user-activity',
    rows: ['A13'],
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'user-activity' }],
    personas: ADMIN_DEV, // Full / Scoped / None / None  (PII)
    wired: true,
  },
  'view-moderation-audit': {
    key: 'view-moderation-audit',
    rows: ['A5'],
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: 'moderation-audit' }],
    personas: ADMIN_DEV_MGR, // Full / Scoped / None / Scoped
    wired: true,
  },
  // The lossless bundle: view-quality (A6-A8,A10,A14,A15) + view-analytics
  // (A9,A11,A12) share the SAME persona column, so one capability + resource
  // (the analytics root POST + the native GET reads) covers both.
  'view-analytics': {
    key: 'view-analytics',
    rows: ['A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A14', 'A15'],
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'POST', path: '' }],
    personas: ADMIN_DEV_AI, // Full / Scoped / Full / None
    wired: true,
  },
  'view-security': {
    key: 'view-security',
    rows: ['A17', 'A18'],
    enforcement: 'signOnRole',
    resources: [{ api: 'analytics', method: 'GET', path: 'membership-audit/findings' }],
    personas: ADMIN_DEV, // Full / Scoped / None / None
    // The membership-audit + deployment routes keep their Cognito authorizer for
    // now; IAM-authorizing them (view-security) is the tracked next slice.
    wired: false,
  },
  // ── experiments API (Experiments stack) — the profile write surface ──────
  'manage-profiles': {
    key: 'manage-profiles',
    rows: ['P'],
    enforcement: 'signOnRole',
    resources: [{ api: 'experiments', method: 'POST', path: 'admin/profiles' }],
    personas: ADMIN_DEV_AI, // versioning/import is a platform + AI-dev action
    wired: true,
  },
};

/** Capabilities whose CDK wiring is live and enforced on the sign-on role. */
export function signOnRoleCapabilities(): AdminCapability[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => c.enforcement === 'signOnRole' && c.wired);
}

/** Capabilities vended by the credential exchange, and actually wired today. */
export function exchangeVendCapabilities(): AdminCapability[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => c.enforcement === 'exchangeVend' && c.wired);
}

/** The wired capabilities a persona holds (drives its role's execute-api teeth). */
export function capabilitiesForPersona(persona: AdminPersona): AdminCapability[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => c.wired && c.personas.includes(persona));
}
