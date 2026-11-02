/**
 * The experiments and battle-settings API, as the admin console calls it.
 *
 * Every route is IAM-authorized and signed with the operator's sign-on credentials, and reading,
 * changing and configuring are separate capabilities (`view-experiments`, `manage-experiments`,
 * `manage-battle-settings`), so a role that holds one is refused the others at the gateway. The types
 * stay in `@ae/shared`; the calls live here because only the admin console holds the credentials that
 * can make them.
 *
 * Experiment administration exists only when `AdminApi` serves the `experiments` capability
 * (`VITE_ADMIN_API_CAPABILITIES`), and every call refuses with that named otherwise.
 */
import i18n from '@ae/shared/i18n';
import type { BattleChallenger, BattleSetting, Experiment } from '@ae/shared';
import { adminRequest } from './sigv4Fetch';
import { teamAssistant } from './teamScope';
import { adminApiServes, adminUrl } from './adminApi';

/** Whether this deployment serves experiment administration. */
export function experimentsAvailable(): boolean {
  return adminApiServes('experiments');
}

/**
 * Refuses when experiment administration is not served, and returns the (encoded) assistant a team
 * member's console is scoped to, or null for an admin. A team member reaches only its assistant's
 * experiments, under the team route.
 */
function requireExperiments(): string | null {
  if (!experimentsAvailable()) throw new Error(i18n.t('admin.experimentsService.vite_experiments_api_urlNotConfigured'));
  const team = teamAssistant();
  return team ? encodeURIComponent(team) : null;
}

/** The experiments collection: the team route for a team member, the admin route otherwise. */
function experimentsUrl(): string {
  const a = requireExperiments();
  return a
    ? adminUrl('assistant-admin', `/admin/assistants/${a}/experiments`)
    : adminUrl('assistant-admin', '/admin/experiments');
}

/** One experiment's status route, scoped the same way. */
function statusUrl(experimentId: string): string {
  const a = requireExperiments();
  const id = encodeURIComponent(experimentId);
  return a
    ? adminUrl('assistant-admin', `/admin/assistants/${a}/experiments/${id}/status`)
    : adminUrl('assistant-admin', `/admin/experiments/${id}/status`);
}

export async function listExperiments(): Promise<Experiment[]> {
  const result = await adminRequest<{ experiments?: Experiment[] }>('GET', experimentsUrl());
  return result.experiments || [];
}

export async function createExperiment(experiment: Omit<Experiment, 'createdAt'>): Promise<Experiment> {
  return adminRequest<Experiment>('POST', experimentsUrl(), { body: experiment });
}

export async function updateExperimentStatus(experimentId: string, status: Experiment['status']): Promise<void> {
  await adminRequest('POST', statusUrl(experimentId), { body: { status } });
}

/** End a test, optionally recording the operator's decision. The decision's `by`/`at` are stamped
 *  server-side from the signed caller; the client sends outcome and note. */
export async function endExperiment(
  experimentId: string,
  decision?: { outcome: 'promoted_treatment' | 'kept_control' | 'no_decision'; note?: string },
): Promise<void> {
  await adminRequest('POST', statusUrl(experimentId), {
    body: { status: 'completed', ...(decision ? { decision } : {}) },
  });
}

/**
 * PROMOTE THE MEASURED TREATMENT (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6): the server copies the candidate
 * into the live assistant as a new version, refuses unless the live version is still the experiment's control
 * and the copy hashes to what was measured, activates it, and completes the experiment as promoted_treatment.
 * The route is the `activate-profiles` capability's, so a role that only manages experiments is refused it.
 */
export async function promoteExperiment(experimentId: string, note?: string): Promise<{
  promotion?: { profileName: string; version: number; configId: string };
}> {
  const a = requireExperiments();
  const id = encodeURIComponent(experimentId);
  const url = a
    ? adminUrl('assistant-admin', `/admin/assistants/${a}/experiments/${id}/promote`)
    : adminUrl('assistant-admin', `/admin/experiments/${id}/promote`);
  return adminRequest('POST', url, { body: note ? { note } : {} });
}

/** Delete a test: hard-delete a never-started draft, else soft-delete a tombstone. The choice is the
 *  server's; this frees the classification and releases the challenger. */
export async function deleteExperiment(experimentId: string): Promise<void> {
  const a = requireExperiments();
  const id = encodeURIComponent(experimentId);
  const url = a
    ? adminUrl('assistant-admin', `/admin/assistants/${a}/experiments/${id}`)
    : adminUrl('assistant-admin', `/admin/experiments/${id}`);
  await adminRequest('DELETE', url);
}

/**
 * The challengers a battle can name: each battle-capable classification's alt, from its assignment record.
 * Battle settings and challengers are deployment-wide, so they have an admin route and no team route.
 */
export async function listChallengers(): Promise<BattleChallenger[]> {
  requireExperiments();
  const result = await adminRequest<{ challengers?: BattleChallenger[] }>('GET', adminUrl('assistant-admin', '/admin/experiments/challengers'));
  return result.challengers || [];
}

export async function listBattleSettings(): Promise<BattleSetting[]> {
  requireExperiments();
  const result = await adminRequest<{ settings?: BattleSetting[] }>('GET', adminUrl('assistant-admin', '/admin/experiments/battle-settings'));
  return result.settings || [];
}

/** Turn battle on or off for one classification. Refused (409) for a classification that is not
 *  capable, so the caller never has to decide whether the switch is safe. */
export async function setBattleEnabled(classification: string, enabled: boolean): Promise<void> {
  requireExperiments();
  await adminRequest('POST', adminUrl('assistant-admin', '/admin/experiments/battle-settings'), { body: { classification, enabled } });
}
