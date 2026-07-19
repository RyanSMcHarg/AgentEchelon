/**
 * Manage Profiles API — SPEC-PORTABLE-VERSIONED-PROFILES P1/§4 (versioning lifecycle) + P3/§5
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
import { SSMClient } from '@aws-sdk/client-ssm';
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

function catalog() {
  return getModelCatalog(AWS_REGION, process.env.AWS_ACCOUNT_ID || '');
}
function callerSub(event: APIGatewayProxyEvent): string | null {
  const claims = (event.requestContext?.authorizer?.claims || {}) as Record<string, string>;
  return claims.sub || null;
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
      const profiles = await Promise.all(allProfileNames().map((n) => listProfile(ssm, SSM_ROOT, n)));
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
        const { errors, configId } = await validateDraft(ssm, SSM_ROOT, profileName, catalog());
        return respond(200, { profileName, valid: errors.length === 0, errors, configId });
      }
      if (path.endsWith('/activate')) {
        const r = await activateDraft(ssm, SSM_ROOT, profileName, catalog(), sub);
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
        const manifest = await exportManifest(ssm, SSM_ROOT, profileName, version);
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
