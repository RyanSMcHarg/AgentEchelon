/**
 * What the ADR-064 specs share: an admin session and its analytics token, the premium primary's active models as the
 * export reads them, a draft whose `models` are patched and validated, the reply a turn produced with its Metadata, and
 * the turn rows the archive projected for one conversation (`flow_turns`, which carries the model and, from ADR-064, the
 * task's type and step and which rule chose the model).
 */
import { expect } from '@playwright/test';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './test-credentials';
import { exchange, signedCall } from './admin-api';
import { idTokenFor } from './person';
import { adminUrl, ADMIN_API_URL, PERSON_API_URL } from './api-urls';
import { signedAnalyticsPost } from './signed-analytics';
import { PROFILE, sleep } from './workflow-task';
import { noteProgress } from './watchdog/current';

export const ANALYTICS_API = ADMIN_API_URL ? adminUrl('analytics', '/') : '';

/** Whether this run can reach the deployment as the admin test user; the reason when it cannot. */
export async function adminSessionOrSkip(): Promise<{ admin?: any; idToken?: string; skip?: string }> {
  if (!hasTestCredentials()) return { skip: 'test credentials are not available' };
  if (!ADMIN_API_URL || !PERSON_API_URL) return { skip: 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed' };
  const adminUser = await getAdminUser();
  if (!adminUser.password) return { skip: missingUserReason('testAdmin') };
  const creds = await getTestCredentials();
  const idToken = idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId);
  const session = await exchange(idToken, { identity: 'console' });
  expect(session.status).toBe(200);
  return { admin: session.body.credentials, idToken };
}

/** The premium primary's active body as the export reads it. */
export async function activeBody(admin: unknown): Promise<Record<string, any>> {
  const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin as never, 'POST', { profileName: PROFILE });
  expect(exported.status, JSON.stringify(exported.body).slice(0, 400)).toBe(200);
  return (exported.body?.manifest?.body ?? {}) as Record<string, any>;
}

/** Create a draft, patch its `models` (and anything else in `extra`), validate, and return the validation body. */
export async function draftModels(admin: unknown, models: Record<string, unknown>, extra: Record<string, unknown> = {}, profileName = PROFILE): Promise<any> {
  const created = await signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin as never, 'POST', { profileName });
  expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
  const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin as never, 'POST', { profileName, patch: { models, ...extra } });
  if (edited.status !== 200) return { status: edited.status, errors: [JSON.stringify(edited.body)], body: edited.body };
  const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin as never, 'POST', { profileName });
  return valid.body ?? {};
}

/** Discard the profile's draft, so a refused draft is not left for the next spec. */
export async function discardDraft(admin: unknown, profileName = PROFILE): Promise<void> {
  await signedCall(adminUrl('assistant-admin', '/admin/profiles/discard'), admin as never, 'POST', { profileName });
}

/** The catalog key a Bedrock invoke id names (`us.anthropic.claude-haiku-...` is `haiku`), or the id itself. */
export function modelKeyOf(bedrockModel: string | undefined): string {
  const id = String(bedrockModel ?? '').toLowerCase();
  for (const [key, needle] of [['haiku', 'haiku'], ['sonnet', 'sonnet'], ['opus', 'opus'], ['titan', 'titan'], ['gpt_oss_20b', 'gpt-oss-20b'], ['gpt_oss_120b', 'gpt-oss-120b'], ['deepseek_r1', 'deepseek.r1'], ['deepseek_v3', 'deepseek.v3'], ['stability_image_core', 'stable-image-core'], ['stability_image_ultra', 'stable-image-ultra']] as const) {
    if (id.includes(needle)) return key;
  }
  return id;
}

/**
 * The archive's turn rows for one conversation, newest first, once at least `atLeast` have landed.
 *
 * Read on an interval: the archive's projection raises no event the runner can subscribe to. A new row is
 * reported to the stall detector as progress.
 */
export async function turnRowsOf(idToken: string, channelArn: string, atLeast = 1, ms = 5 * 60_000): Promise<any[]> {
  let rows: any[] = [];
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(10_000)) {
    const j = await signedAnalyticsPost(ANALYTICS_API, idToken, { queryType: 'flow_turns', days: 1, limit: 200 });
    const before = rows.length;
    rows = (Array.isArray(j?.data) ? j.data : []).filter((r: any) => r?.channel_arn === channelArn);
    if (rows.length !== before) noteProgress('harness', `${rows.length} archived turn row(s) for ${channelArn.split('/').pop()}`);
    if (rows.length >= atLeast) return rows;
  }
  return rows;
}
