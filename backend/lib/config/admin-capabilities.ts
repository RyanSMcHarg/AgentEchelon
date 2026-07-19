/**
 * A14 - admin-action capability catalog (SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md).
 *
 * The single source of truth mapping each archive/analytics capability to the
 * API Gateway resource(s) it authorizes, so the CDK builds the IAM role policies
 * + per-resource authorizers from the same list the exchange vends against. This
 * is the `execute-api` analogue of credential-exchange.ts `CAPABILITY_ACTIONS`
 * (the Chime plane).
 *
 * Enforcement split (spec section 6.5):
 *   - `signOnRole`  capabilities ride the persona's sign-on Identity-Pool role
 *     (execute-api:Invoke granted at sign-on; the console SigV4-signs with its
 *     sign-on creds). No PII, no mutation.
 *   - `exchangeVend` capabilities (customer message content, A2) are vended
 *     per-use by the credential exchange, short-lived + audited.
 *
 * `resources` are `{ method, path }` on the named API; the CDK resolves them to
 * `execute-api:Invoke` ARNs. Today only the admin-conversations API carries
 * cleanly-separable per-capability resources; `view-events` and the analytics
 * quality/analytics capabilities await the analytics-API resource split
 * (spec section 8, larger) and are catalogued here but not yet wired.
 */

export type AdminCapabilityEnforcement = 'signOnRole' | 'exchangeVend';

export interface AdminApiResource {
  /** Which AE admin API the resource lives on. */
  api: 'admin-conversations' | 'analytics';
  method: string;
  /** Path under the API root, e.g. `admin/conversations/messages`. */
  path: string;
}

export interface AdminCapability {
  key: string;
  /** Matrix rows (SPEC section 3b) this capability covers, for traceability. */
  rows: string[];
  enforcement: AdminCapabilityEnforcement;
  resources: AdminApiResource[];
  /** Whether the CDK wiring is live yet (false = catalogued, pending the API split). */
  wired: boolean;
}

export const ADMIN_CAPABILITIES: Record<string, AdminCapability> = {
  'view-conversations': {
    key: 'view-conversations',
    rows: ['A1', 'A4'],
    enforcement: 'signOnRole',
    resources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations' },
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations/membership-history' },
    ],
    wired: true,
  },
  'view-messages': {
    key: 'view-messages',
    rows: ['A2'],
    enforcement: 'exchangeVend',
    resources: [
      { api: 'admin-conversations', method: 'GET', path: 'admin/conversations/messages' },
    ],
    wired: true,
  },
  'view-events': {
    key: 'view-events',
    rows: ['A3'],
    enforcement: 'signOnRole',
    // On the shared analytics POST / (queryType=channel_events); needs the
    // per-capability analytics-API split (spec section 8) before it can be
    // IAM-authorized without also gating every other analytics query.
    resources: [{ api: 'analytics', method: 'POST', path: '' }],
    wired: false,
  },
};

/** Capabilities enforced on the sign-on role, and actually wired today. */
export function signOnRoleCapabilities(): AdminCapability[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => c.enforcement === 'signOnRole' && c.wired);
}

/** Capabilities vended by the credential exchange, and actually wired today. */
export function exchangeVendCapabilities(): AdminCapability[] {
  return Object.values(ADMIN_CAPABILITIES).filter((c) => c.enforcement === 'exchangeVend' && c.wired);
}
