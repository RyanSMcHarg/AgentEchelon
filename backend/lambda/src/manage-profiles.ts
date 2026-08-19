/**
 * Manage Profiles API — SPEC-PORTABLE-PROFILES P1/§4 (versioning lifecycle) + P3/§5
 * (export/import). The WRITE surface for assistant profile versions, gated by the `manage-profiles`
 * capability (§7 / plan item A14). Routes on the existing admin API — NO new gateway (§3).
 *
 *   GET  /profiles                 — list every profile: versions, active pointer, draft state
 *   POST /profiles/version         — {profileName} clone the active version into a fresh draft
 *   POST /profiles/draft           — {profileName, patch} edit the draft's runtime-editable fields
 *   POST /profiles/validate        — {profileName} validate the draft (schema + §7 model-ARN boundary)
 *   POST /profiles/activate        — {profileName} promote the draft to a new active version
 *   POST /profiles/rollback        — {profileName, version} move `active` onto an existing version
 *   POST /profiles/export          — {profileName, version?} serialize an instance-agnostic manifest
 *   POST /profiles/import          — {manifest, targetProfileName?} validate + land as a draft (never active)
 *
 * The mutations are the write path; the async-processor role is read-only on /assistant/* (§7). Every
 * mutation is audited with the server-verified caller sub. The management API is the ONLY sanctioned
 * write path to the profile SSM namespace.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { resolveProfileInfra } from './lib/profile-infra.js';
import { parseJsonBody, callerCanManageProfiles, respond as authRespond } from './lib/auth.js';
import { getModelCatalog } from '../../lib/config/model-strategy.js';
import type { ProfileDefinitionBody } from './lib/active-profile.js';
import {
  listProfile,
  createDraft,
  editDraft,
  validateDraft,
  activateDraft,
  activateExistingVersion,
  allProfileNames,
  isKnownProfile,
  ProfileValidationError,
} from './lib/profile-lifecycle.js';
import { exportManifest, importManifest, ProfileManifestError } from './lib/profile-manifest.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
const ssm = new SSMClient({ region: AWS_REGION });
const lambdaClient = new LambdaClient({ region: AWS_REGION });

function catalog() {
  return getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
}

/**
 * The selectable guardrails a profile may reference, as published by the assistant-profile stack at
 * `${SSM_ROOT}/assistant/{profileName}/guardrails` (SPEC-CONFIGURABLE-ASSISTANTS 4.6b). Used by import
 * to reject-or-remap a guardrail selection that came from another deployment.
 *
 * Throws on an unreadable/absent/malformed catalog rather than returning [] — importManifest fails
 * CLOSED on a throw, and an empty array would read as "this instance provisions no guardrails", which
 * would reject every selection with a misleading reason.
 */
async function guardrailCatalogFor(profileName: string): Promise<Array<{ key: string; guardrailId: string }>> {
  const name = `${SSM_ROOT}/assistant/${profileName}/guardrails`;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const raw = res.Parameter?.Value;
  if (!raw) throw new Error(`${name} is empty`);
  const parsed = JSON.parse(raw) as Array<{ key?: string; guardrailId?: string }>;
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array`);
  return parsed
    .filter((g) => typeof g.key === 'string' && typeof g.guardrailId === 'string')
    .map((g) => ({ key: g.key as string, guardrailId: g.guardrailId as string }));
}
/**
 * The target's published context source catalog, for import validation
 * (SPEC-CONTEXT-SOURCES-AND-STORES §6).
 *
 * THROWS on an absent/unreadable/malformed parameter, deliberately and exactly like
 * `guardrailCatalogFor`: import treats a throw as "cannot verify this selection" and fails closed.
 * Returning an empty array instead would read as "this instance publishes nothing", which silently
 * rejects every key for the wrong reason - or, worse, would let a future caller treat it as no
 * constraint at all.
 */
async function contextSourceCatalogFor(
  profileName: string,
): Promise<Array<{ key: string; fields?: Record<string, { type: string; optional?: boolean }>; contractVersion?: string }>> {
  const name = `${SSM_ROOT}/assistant/${profileName}/context-sources`;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const raw = res.Parameter?.Value;
  if (!raw) throw new Error(`${name} is empty`);
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array`);
  return parsed
    .filter((s) => typeof s.key === 'string')
    .map((s) => ({
      key: s.key as string,
      fields: s.fields as Record<string, { type: string; optional?: boolean }> | undefined,
      contractVersion: typeof s.contractVersion === 'string' ? s.contractVersion : undefined,
    }));
}

function callerSub(event: APIGatewayProxyEvent): string | null {
  const claims = (event.requestContext?.authorizer?.claims || {}) as Record<string, string>;
  if (claims.sub) return claims.sub;
  // A14: under AWS_IAM enforcement there is no Cognito authorizer, so `claims` is empty — but the
  // gateway already vetted the signed principal's `manage-profiles` teeth (callerCanManageProfiles →
  // isTrustedIamAdminCall). Derive the actor from the IAM principal so the audit has a real subject and
  // the handler doesn't 401 a legitimately-signed admin call. (Mirrors the admin-conversations trust.)
  const identity = event.requestContext?.identity;
  return identity?.userArn || identity?.caller || null;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const origin = event.headers?.origin || event.headers?.Origin;
  const method = event.httpMethod;
  const path = event.path || '';
  const respond = (code: number, body: unknown) => authRespond(code, body, origin);

  if (method === 'OPTIONS') return respond(200, { ok: true });

  const sub = callerSub(event);
  if (!sub) return respond(401, { error: 'Unauthorized' });
  // `manage-profiles` is a DISTINCT capability from view-* — versioning/import an assistant is
  // separately denyable (§7 / A14). Default = admins; narrow via MANAGE_PROFILES_GROUP_NAMES.
  if (!callerCanManageProfiles(event)) {
    console.warn('[manage-profiles] caller lacks manage-profiles capability', { sub });
    return respond(403, { error: 'manage-profiles capability required' });
  }

  try {
    if (method === 'GET') {
      // Each listing is augmented with `resolved` — the live infra identifiers (processor Lambda, its role,
      // its guardrail) for the console's AWS deep links. Best-effort; a resolve failure just omits the links.
      const profiles = await Promise.all(
        allProfileNames().map(async (n) => ({
          ...(await listProfile(ssm, SSM_ROOT, n)),
          resolved: await resolveProfileInfra(ssm, lambdaClient, SSM_ROOT, n, AWS_REGION),
        })),
      );
      return respond(200, { profiles });
    }

    if (method === 'POST') {
      const parsed = parseJsonBody<Record<string, unknown>>(event, origin);
      if ('statusCode' in parsed) return parsed;
      const body = parsed.body;
      const profileName = typeof body.profileName === 'string' ? body.profileName : '';

      // Import doesn't require an existing target-name in the body (the manifest carries the name).
      if (path.endsWith('/import')) {
        const draft = await importManifest(ssm, SSM_ROOT, body.manifest, {
          catalog: catalog(),
          targetProfileName: typeof body.targetProfileName === 'string' ? body.targetProfileName : undefined,
          knownProfile: isKnownProfile,
          guardrailCatalog: guardrailCatalogFor,
          contextSourceCatalog: contextSourceCatalogFor,
          actor: sub,
        });
        return respond(200, { imported: draft.profileName, configId: draft.configId, landedAs: 'draft' });
      }

      if (!profileName || !isKnownProfile(profileName)) {
        return respond(400, { error: `unknown or missing profileName '${profileName}'` });
      }

      if (path.endsWith('/version')) {
        const draft = await createDraft(ssm, SSM_ROOT, profileName, sub);
        return respond(200, { profileName, draftConfigId: draft.configId });
      }
      if (path.endsWith('/draft')) {
        const patch = (body.patch ?? {}) as Partial<ProfileDefinitionBody>;
        const draft = await editDraft(ssm, SSM_ROOT, profileName, patch, sub);
        return respond(200, { profileName, draftConfigId: draft.configId });
      }
      if (path.endsWith('/validate')) {
        // The same catalog reader import uses, so a key that would be rejected on the way IN to
        // another instance is also rejected on the way in here.
        const { errors, configId } = await validateDraft(ssm, SSM_ROOT, profileName, catalog(), contextSourceCatalogFor, guardrailCatalogFor);
        return respond(200, { profileName, valid: errors.length === 0, errors, configId });
      }
      if (path.endsWith('/activate')) {
        const r = await activateDraft(ssm, SSM_ROOT, profileName, catalog(), sub, contextSourceCatalogFor, guardrailCatalogFor);
        return respond(200, { profileName, ...r });
      }
      if (path.endsWith('/rollback')) {
        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1) return respond(400, { error: 'version (>=1) required' });
        const r = await activateExistingVersion(ssm, SSM_ROOT, profileName, version, sub);
        return respond(200, { profileName, ...r });
      }
      if (path.endsWith('/export')) {
        const version = body.version !== undefined ? Number(body.version) : undefined;
        // Pass the catalog so a guardrail SELECTION is emitted as its portable key rather than the id
        // resolved on this instance (the manifest's instance-agnostic promise).
        const manifest = await exportManifest(ssm, SSM_ROOT, profileName, version, guardrailCatalogFor, contextSourceCatalogFor);
        return respond(200, { manifest });
      }
    }

    return respond(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ProfileValidationError || err instanceof ProfileManifestError) {
      return respond(422, { error: err.message, errors: (err as ProfileValidationError).errors });
    }
    console.error('[manage-profiles] error:', err);
    return respond(500, { error: 'Internal error' });
  }
};
