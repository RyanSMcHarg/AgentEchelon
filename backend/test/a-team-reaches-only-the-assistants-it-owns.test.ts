/**
 * A TEAM REACHES ONLY THE ASSISTANTS IT OWNS, WITHIN ITS MEMBERS' CLEARANCE (SPEC-ADMIN-CONSOLE FR47, FR48).
 *
 * The rules the credential exchange scopes a team member's console session by, and the handlers
 * re-check: ownership is the `owner-team` tag on every bot serving an assistant, a person's teams are
 * their `team-<name>` groups, and owning an assistant never reaches past the person's own clearance.
 * The catalog side: a team member's standing grant is the team routes, with the assistant a wildcard
 * the session policy then narrows.
 */
import { teamsOfGroups, ownedBy, teamsOwn, scopeFor, type AssistantIdentity } from '../lambda/src/lib/assistant-ownership';
import { roleExecuteApiResources, ADMIN_CAPABILITIES, roleIsGranted } from '../lib/config/admin-capabilities';
import { teamSessionPolicy, teamSessionPolicyArns } from '../lambda/src/admin-credential-exchange';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';

const bot = (assistant: string, classification: string, ownerTeam: string | null, n = 1): AssistantIdentity => ({
  assistant, classification, ownerTeam, ownerRecorded: ownerTeam !== null, role: 'primary', name: assistant, botArn: `arn:aws:chime:us-east-1:1:app-instance/a/bot/${assistant}-${n}`,
});

describe('which assistants a team owns', () => {
  it('reads teams from team-<name> groups only, and never the team-members role group', () => {
    // `team-members` shares the prefix. Read as a team, every team member would be in a team `members`
    // and reach any assistant tagged `owner-team=members`, and their session would name `/teams/members/`.
    expect(teamsOfGroups(['premium', 'team-members', 'team-ops', 'team-', 'ops'])).toEqual(['ops']);
  });

  it('owns an assistant only when every bot serving it names the team', () => {
    const ids = [bot('ops-premium', 'premium', 'ops'), bot('analyst', 'standard', 'ops'), bot('analyst', 'basic', 'support', 2)];
    expect(teamsOwn(ids, ['ops'], 'ops-premium')).toBe(true);
    // One bot of `analyst` belongs to another team, so neither team reaches it through a scoped route.
    expect(teamsOwn(ids, ['ops'], 'analyst')).toBe(false);
    expect(teamsOwn(ids, ['support'], 'analyst')).toBe(false);
    expect(ownedBy(ids, ['ops'])).toEqual(['ops-premium']);
  });

  it('owns nothing that is unowned or unknown', () => {
    const ids = [bot('advisor', 'premium', null)];
    expect(teamsOwn(ids, ['ops'], 'advisor')).toBe(false);
    expect(teamsOwn(ids, ['ops'], 'no-such-assistant')).toBe(false);
  });
});

describe('ownership never reaches past clearance', () => {
  const reaches = (h: string, t: string) => profiles.reaches(h, t);
  const clearances = (g: string[]) => profiles.clearancesForGroups(g);
  const ids = [bot('ops-premium', 'premium', 'ops'), bot('concierge', 'basic', 'ops')];

  it('scopes a premium-cleared member to every assistant the team owns', () => {
    expect(scopeFor(ids, ['premium', 'team-members', 'team-ops'], reaches, clearances)).toEqual(['concierge', 'ops-premium']);
  });

  it('leaves out an owned assistant above the member\'s clearance', () => {
    expect(scopeFor(ids, ['basic', 'team-members', 'team-ops'], reaches, clearances)).toEqual(['concierge']);
  });

  it('scopes a member of no team to nothing', () => {
    expect(scopeFor(ids, ['premium', 'team-members'], reaches, clearances)).toEqual([]);
  });
});

describe('the team grant', () => {
  it('is the team routes only, with path parameters as wildcards', () => {
    const exp = roleExecuteApiResources('team-members', 'assistant-admin');
    expect(exp.length).toBeGreaterThan(0);
    // Under an assistant the team owns, or under one of the person's own teams (creating for it).
    for (const r of exp) expect(r.path).toMatch(/^\/admin\/(assistants|teams)\/\*\//);
    expect(exp).toContainEqual({ method: 'DELETE', path: '/admin/assistants/*/experiments/*' });
    expect(exp).toContainEqual({ method: 'POST', path: '/admin/assistants/*/ownership' });
    expect(exp).toContainEqual({ method: 'POST', path: '/admin/teams/*/roster' });
    expect(exp).toContainEqual({ method: 'GET', path: '/admin/teams/*/roster' });
    // Never the admin routes: every owner, any team, retiring.
    for (const path of ['/admin/ownership', '/admin/roster', '/admin/roster/*/retire']) {
      expect(exp.some((r) => r.path === path)).toBe(false);
    }
    expect(roleExecuteApiResources('team-members', 'analytics')).toEqual([
      { method: 'POST', path: '/analytics/assistants/*/query' },
      { method: 'POST', path: '/analytics/assistants/*/triage' },
      { method: 'POST', path: '/analytics/assistants/*/ground-truth' },
    ]);
    // Every team route on every API sits under an assistant or a team, which is what the session policy narrows.
    for (const api of ['admin-conversations', 'admin-exchange', 'assistant-admin', 'user-management', 'feedback'] as const) {
      for (const r of roleExecuteApiResources('team-members', api)) expect(r.path).toMatch(/\/(assistants|teams)\/\*\//);
    }
  });

  it('holds nothing on the feedback API, whose summary counts every assistant together', () => {
    // `GET /feedback` rides `view-analytics`, which a team holds, so this is the case a team grant built
    // from `resources` instead of `teamResources` would get wrong: every assistant's thumbs for a team.
    expect(roleIsGranted('team-members', ADMIN_CAPABILITIES['view-analytics'])).toBe(true);
    expect(roleExecuteApiResources('team-members', 'feedback')).toEqual([]);
    expect(roleExecuteApiResources('admins', 'feedback')).toEqual([{ method: 'GET', path: '/feedback' }]);
  });

  it('holds no admin-only capability, and no team capability without a team route', () => {
    for (const cap of Object.values(ADMIN_CAPABILITIES)) {
      if (roleIsGranted('team-members', cap)) expect(cap.teamResources?.length).toBeGreaterThan(0);
    }
    // Ownership and creation are held on the team's own routes only (the assertions above).
    expect(roleIsGranted('team-members', ADMIN_CAPABILITIES['manage-ownership'])).toBe(true);
    expect(roleIsGranted('team-members', ADMIN_CAPABILITIES['manage-assistants'])).toBe(true);
    expect(roleIsGranted('team-members', ADMIN_CAPABILITIES['manage-battle-settings'])).toBe(false);
  });

  it('is narrowed by a session policy naming one wildcard per owned assistant and per team', () => {
    const policy = JSON.parse(teamSessionPolicy(['ops-premium', 'concierge'], ['ops']));
    expect(policy.Statement[0].Resource).toEqual([
      'arn:aws:execute-api:*:*:*/assistants/ops-premium/*',
      'arn:aws:execute-api:*:*:*/assistants/concierge/*',
      'arn:aws:execute-api:*:*:*/teams/ops/*',
    ]);
    // The console's events: connect and subscribe only; the role's own grant names the one Event API.
    // THE INLINE POLICY IS FOR ASSISTANTS AND TEAMS ALONE, its size what bounds how many a team owns: following console
    // events rides a managed session policy beside it, naming the one API.
    expect(policy.Statement).toHaveLength(1);
    expect(teamSessionPolicyArns('arn:aws:iam::1:policy/events')).toEqual([{ arn: 'arn:aws:iam::1:policy/events' }]);
    expect(teamSessionPolicyArns('')).toEqual([]);
  });
});

describe('a team session is bounded by the person\'s clearance, not by what their assistant served', () => {
  const { scopeForRequest, classificationAllowed } = jest.requireActual('../lambda/src/lib/caller-scope') as typeof import('../lambda/src/lib/caller-scope');
  const { callerPersonId } = jest.requireActual('../lambda/src/lib/auth') as typeof import('../lambda/src/lib/auth');
  const SUB = '11111111-2222-3333-4444-555555555555';
  const call = (session: string) => ({
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/agent-echelon-team-console/${session}` } },
  }) as never;

  it('takes its callerScope from the clearance the exchange named the session with', () => {
    const callerScope = scopeForRequest(call(`console-${SUB}@standard`));
    expect(callerScope).toBe('standard');
    expect(classificationAllowed('standard', callerScope)).toBe(true);
    // A conversation above it is filtered out, whichever assistant served in it.
    expect(classificationAllowed('premium', callerScope)).toBe(false);
  });

  it('sees nothing when the session names no clearance, or one the deployment does not declare', () => {
    expect(scopeForRequest(call(`console-${SUB}`))).toBeUndefined();
    expect(scopeForRequest(call(`console-${SUB}@nonesuch`))).toBeUndefined();
  });

  it('still names the person, whatever the suffix', async () => {
    expect(await callerPersonId(call(`console-${SUB}@premium`))).toBe(SUB);
  });
});
