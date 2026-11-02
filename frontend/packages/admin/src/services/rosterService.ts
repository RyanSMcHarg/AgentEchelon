/**
 * CREATING AND RETIRING AN ASSISTANT IN THE CONSOLE (ADR-048, `manage-assistants`).
 *
 * A create answers at once with `provisioning`: the assistant's Amazon Lex bot builds in the background,
 * and the Assistants list shows `active`, or `failed` with what was left behind, when it next loads.
 * A retire asks for the reason first, like any other change an operator makes.
 *
 * TWO ROUTES FOR A CREATE, ONE PER ROLE. An admin creates on `/admin/roster` and may name any team or
 * none. A team member creates on `/admin/teams/{team}/roster`, for one of their own teams: their console
 * session names only those team paths, and the handler refuses another team, a classification their
 * clearance does not reach, and an assistant with no owner. Retiring is an admin's alone.
 */
import i18n from '@ae/shared/i18n';
import { adminRequest } from './sigv4Fetch';
import { adminApiConfigured, adminUrl } from './adminApi';
import { reasonFor } from './adminReason';
import type { ProfileManifest, RosterTarget, RuntimeAssistant } from './profileService';

/** What a new assistant's first draft starts from. Absent from a request: the classification's defaults. */
export type StartingPoint =
  | { kind: 'defaults' }
  | { kind: 'manifest'; manifest: ProfileManifest }
  | { kind: 'copy'; from: string };

export interface CreateAssistantRequest {
  assistantId: string;
  classification: string;
  role: string;
  displayName: string;
  /** `classifierModelKey`: the first draft's classifier model, or `'default'` for the platform classifier. */
  descriptor: { modelKey: string; classifierMode: 'keyword' | 'llm'; rateLimitPerHour?: number; classifierModelKey?: string };
  ownerTeam?: string;
  startingPoint?: StartingPoint;
}

/** The roster routes are on the assistant administration surface, beside the profiles, so they are there with or without experiments. */
function requireApi(): void {
  if (!adminApiConfigured()) throw new Error(i18n.t('admin.profileService.vite_manage_profiles_api_urlNotConfigured'));
}

/**
 * Create an assistant. `asTeam` is set for a team member and names the team it is created for, which is
 * then also its owner; an admin leaves it unset and names `ownerTeam` (or none) in the request.
 */
export async function createAssistant(request: CreateAssistantRequest, asTeam?: string): Promise<{ assistantId: string; status: string }> {
  requireApi();
  if (asTeam) {
    return adminRequest('POST', adminUrl('assistant-admin', `/admin/teams/${encodeURIComponent(asTeam)}/roster`), { body: { ...request, ownerTeam: asTeam } });
  }
  return adminRequest('POST', adminUrl('assistant-admin', '/admin/roster'), { body: request });
}

/**
 * A team's own roster: the assistants created for it in the console, and where the team member may create
 * one (the classifications their clearance reaches, with the roles each declares). Filtered by the server.
 */
export async function listTeamRoster(team: string): Promise<{ runtimeAssistants: RuntimeAssistant[]; rosterTargets: RosterTarget[] }> {
  requireApi();
  const out = await adminRequest<{ runtimeAssistants?: RuntimeAssistant[]; rosterTargets?: RosterTarget[] }>(
    'GET', adminUrl('assistant-admin', `/admin/teams/${encodeURIComponent(team)}/roster`),
  );
  return { runtimeAssistants: out.runtimeAssistants ?? [], rosterTargets: out.rosterTargets ?? [] };
}

/**
 * Retire an assistant created in the console. Asks for the reason first. The name stays taken as a
 * tombstone, except for a failed create, which never answered: removing it answers `released` and frees the name.
 */
export async function retireAssistant(assistantId: string): Promise<{ assistantId: string; status: string }> {
  const reason = await reasonFor({ capability: 'manage-assistants', kind: 'change' });
  requireApi();
  return adminRequest('POST', adminUrl('assistant-admin', `/admin/roster/${encodeURIComponent(assistantId)}/retire`), { body: { reason } });
}

/**
 * Set a console-created assistant's turns per hour (`null` removes the limit). A team member sets it on
 * their team's route for an assistant the team owns; an admin on the admin route. A declared assistant's
 * limit is deploy configuration and is refused by the route.
 */
export async function setTurnLimit(assistantId: string, rateLimitPerHour: number | null, asTeam?: string): Promise<{ assistantId: string; rateLimitPerHour: number | null }> {
  requireApi();
  const id = encodeURIComponent(assistantId);
  if (asTeam) {
    return adminRequest('POST', adminUrl('assistant-admin', `/admin/teams/${encodeURIComponent(asTeam)}/roster/${id}/limits`), { body: { rateLimitPerHour } });
  }
  return adminRequest('POST', adminUrl('assistant-admin', `/admin/roster/${id}/limits`), { body: { rateLimitPerHour } });
}
