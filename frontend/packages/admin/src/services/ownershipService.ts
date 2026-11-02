/**
 * WHICH TEAM OWNS WHICH ASSISTANT (SPEC-ADMIN-CONSOLE FR47, `manage-ownership`).
 *
 * Reads and changes the `owner-team` tag through the ownership function, the only writer of it. A
 * change is asked for a reason, like any other change an operator makes on someone else's behalf, and
 * takes effect on each team member's next console session.
 *
 * TWO ROUTES FOR A CHANGE. An admin assigns any team, or clears the owner, on `/admin/ownership`. A team
 * member moves an assistant their team owns to another of their own teams on
 * `/admin/assistants/{assistant}/ownership`; the handler refuses another team and a cleared owner.
 */
import i18n from '@ae/shared/i18n';
import { adminRequest } from './sigv4Fetch';
import { adminApiConfigured, adminUrl } from './adminApi';
import { reasonFor } from './adminReason';

export interface AssistantOwnership {
  assistant: string;
  displayName: string;
  classifications: string[];
  ownerTeam: string | null;
  /** The assistant's bots disagree about their owner, so no team reaches it until it is set again. */
  mixed: boolean;
}

function requireApi(): void {
  // On the assistant administration surface, beside the profiles, so it is there with or without experiments.
  if (!adminApiConfigured()) throw new Error(i18n.t('admin.profileService.vite_manage_profiles_api_urlNotConfigured'));
}

/** Every assistant's owner and every team in the deployment. An admin's read. */
export async function listOwnership(): Promise<{ assistants: AssistantOwnership[]; teams: string[] }> {
  requireApi();
  const out = await adminRequest<{ assistants?: AssistantOwnership[]; teams?: string[] }>('GET', adminUrl('assistant-admin', '/admin/ownership'));
  return { assistants: out.assistants ?? [], teams: out.teams ?? [] };
}

/**
 * Assign an assistant to a team, or (an admin only) clear its owner with null. Asks for the reason first.
 * `asTeamMember` sends it on the assistant's team route.
 */
export async function setOwnership(assistant: string, team: string | null, asTeamMember = false): Promise<void> {
  const reason = await reasonFor({ capability: 'manage-ownership', kind: 'change' });
  requireApi();
  if (asTeamMember) {
    await adminRequest('POST', adminUrl('assistant-admin', `/admin/assistants/${encodeURIComponent(assistant)}/ownership`), { body: { team, reason } });
    return;
  }
  await adminRequest('POST', adminUrl('assistant-admin', '/admin/ownership'), { body: { assistant, team, reason } });
}
