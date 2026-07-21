import { apiCall, ADMIN_IAM_ENFORCEMENT } from '@ae/shared';
import { identityPoolCredentials, sigv4GetJson, sigv4PostJson } from './sigv4Fetch';

/**
 * Assistant-profile lifecycle service (SPEC-PORTABLE-VERSIONED-PROFILES P1/P3) — the admin console's
 * client for the manage-profiles API. Under A14 `adminIamEnforcement` the routes are AWS_IAM (SigV4),
 * so requests are signed with the operator's sign-on Identity-Pool creds (the gateway denies a role
 * without `execute-api:Invoke` on the profile resource); with enforcement off they fall back to the
 * Cognito Bearer path. Same shape as adminConversationService. Every mutation is additionally gated
 * server-side on the `manage-profiles` capability and audited.
 */

/** The sentinel `models.*` value meaning "follow the classification-set default" (tracks the platform
 *  default over time; never a pinned concrete key). Mirrors the backend `DEFAULT_MODEL`. */
export const DEFAULT_MODEL = 'default';

export interface ProfileModels {
  /** Base model; blank or `'default'` ⇒ inherit the classification default. */
  default?: string;
  /** Classifier model; blank or `'default'` (the seeded value) ⇒ inherit the deployment default (Haiku). */
  classifier?: string;
  complex?: string;
  /** Per-intent route overrides, keyed by route key. Matches the backend shape (primary + optional
   *  graceful-degrade fallback), NOT a flat string map. */
  byIntent?: Record<string, { primary: string; fallback?: string }>;
}

export interface ProfileDefinitionBody {
  modelKey: string;
  models?: ProfileModels;
  tools?: string[];
  guardrailId?: string;
  classifierMode: 'keyword' | 'llm';
  timeoutSeconds: number;
  taskSupport: 'lightweight' | 'full';
  rateLimitPerHour?: number;
  battleEligible?: boolean;
}

/** The export/import manifest shape (the fields the console reads). The body is instance-agnostic — model
 *  keys are catalog keys, never ARNs (SPEC-PORTABLE §5), so AWS deep links are built client-side. */
export interface ProfileManifestTyped {
  schemaVersion: number;
  kind: string;
  profileName: string;
  body: ProfileDefinitionBody;
  provenance?: { instanceId?: string; sourceProfileName?: string; sourceVersion?: number | string; exportedConfigId?: string };
  contentHash?: string;
  signature?: string;
}

export interface ProfileVersionSummary {
  version: number;
  configId: string;
  active: boolean;
  lastModified?: string;
}

/** Live, instance-bound infra identifiers for a profile's assistant (server-resolved) — for AWS deep links.
 *  Absent/partial when the profile has no live processor yet or the resolve was denied. */
export interface ResolvedInfra {
  region: string;
  processorArn?: string;
  processorFunctionName?: string;
  /** Classification-level router / Lex-fulfillment (AgentHandler) Lambda — shared by every profile at this
   *  classification (intent classification + routing). */
  routerArn?: string;
  routerFunctionName?: string;
  roleArn?: string;
  roleName?: string;
  guardrailId?: string;
  /** The Amazon Chime SDK channel flow (single shared flow today; per-classification is roadmap). */
  channelFlowArn?: string;
}

export interface ProfileListing {
  profileName: string;
  activeVersion: number | null;
  versions: ProfileVersionSummary[];
  hasDraft: boolean;
  draftConfigId?: string;
  resolved?: ResolvedInfra;
}

export type ProfileManifest = Record<string, unknown>;

function getApiUrl(): string {
  const url = import.meta.env.VITE_MANAGE_PROFILES_API_URL;
  if (!url) throw new Error('VITE_MANAGE_PROFILES_API_URL not configured');
  return url.replace(/\/$/, ''); // .../admin/profiles
}

/** Signed GET (IAM) or Bearer GET, per enforcement. */
async function get<T>(): Promise<T> {
  if (ADMIN_IAM_ENFORCEMENT) {
    const creds = await identityPoolCredentials();
    return sigv4GetJson<T>(getApiUrl(), {}, creds);
  }
  return apiCall<T>(getApiUrl());
}

/** Signed POST (IAM) or Bearer POST, per enforcement. `action` is a sub-path like '/version'. */
async function post<T>(action: string, body: Record<string, unknown>): Promise<T> {
  if (ADMIN_IAM_ENFORCEMENT) {
    const creds = await identityPoolCredentials();
    return sigv4PostJson<T>(`${getApiUrl()}${action}`, body, creds);
  }
  return apiCall<T>(getApiUrl(), action, { method: 'POST', body });
}

export async function listProfiles(): Promise<ProfileListing[]> {
  const r = await get<{ profiles?: ProfileListing[] }>();
  return r.profiles || [];
}

export async function createProfileVersion(profileName: string): Promise<{ profileName: string; draftConfigId: string }> {
  return post('/version', { profileName });
}

export async function editProfileDraft(profileName: string, patch: Partial<ProfileDefinitionBody>): Promise<{ profileName: string; draftConfigId: string }> {
  return post('/draft', { profileName, patch });
}

export async function validateProfileDraft(profileName: string): Promise<{ profileName: string; valid: boolean; errors: string[]; configId: string }> {
  return post('/validate', { profileName });
}

export async function activateProfileDraft(profileName: string): Promise<{ profileName: string; version?: number }> {
  return post('/activate', { profileName });
}

export async function rollbackProfile(profileName: string, version: number): Promise<{ profileName: string; version?: number }> {
  return post('/rollback', { profileName, version });
}

export async function exportProfile(profileName: string, version?: number): Promise<ProfileManifest> {
  const r = await post<{ manifest: ProfileManifest }>('/export', { profileName, version });
  return r.manifest;
}

export async function importProfile(manifest: ProfileManifest, targetProfileName?: string): Promise<{ imported: string; configId: string; landedAs: string }> {
  return post('/import', { manifest, targetProfileName });
}
