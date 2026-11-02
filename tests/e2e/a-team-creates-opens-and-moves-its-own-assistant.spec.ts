/**
 * A TEAM MEMBER CREATES AN ASSISTANT FOR THEIR TEAM, OPENS IT AT ONCE, ACTIVATES ITS SEEDED DRAFT, RENAMES IT,
 * AND MOVES IT TO THEIR OTHER TEAM (ADR-048, SPEC-ADMIN-CONSOLE FR47, FR48), against the deployed API.
 *
 * What only a deployment proves:
 *   - the create on the team's own route builds an assistant owned by that team (the `owner-team` tag);
 *   - a console session issued AFTER the build names the new assistant, which is what the console's
 *     automatic re-issue relies on to open it without a sign-out;
 *   - the build seeded a first draft from the classification's defaults, and it activates as it is;
 *   - a rename reaches the identity through the runtime applier, and a name another assistant in the
 *     classification shows is refused;
 *   - moving it to the member's other team takes it off the first team's roster and puts it on the second's.
 *
 * Gated on TEAM_CREATE_E2E (the `boundaries` phase sets it). The move needs a team member in two teams; with
 * one team that test skips and says so. Creates one assistant with a fresh name per run and retires it.
 */
import { test, expect } from './helpers/fixtures';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, signedCall } from './helpers/admin-api';
import { idTokenFor } from './helpers/person';
import { aws } from './helpers/aws';
import { INSTANCE } from './helpers/stack-prefix';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { guardBackendErrors } from './helpers/turn-guards';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe.serial('a team creates, opens and moves its own assistant', () => {
  guardBackendErrors('a-team-creates-opens-and-moves-its-own-assistant');
  const assistantId = `e2e-team-${Date.now().toString(36)}`;
  const displayName = `Team ${assistantId.slice(-6)}`;
  let adminSession: any;
  let teamToken = '';
  let teamSession: any;
  let teams: string[] = [];
  let classification = '';
  let created = false;

  const consoleFor = async (idToken: string) => {
    const s = await exchange(idToken, { identity: 'console' });
    expect(s.status, `console session: ${JSON.stringify(s.body).slice(0, 300)}`).toBe(200);
    return s.body;
  };

  test.beforeAll(async () => {
    test.skip(process.env.TEAM_CREATE_E2E !== '1', 'TEAM_CREATE_E2E is not set (the boundaries phase sets it)');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is not set');
    const creds = await getTestCredentials();
    test.skip(!creds.teamOpsUser?.password, missingUserReason('teamOpsUser'));
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    adminSession = (await consoleFor(idTokenFor(admin.email, admin.password, creds.cognitoClientId))).credentials;
    teamToken = idTokenFor(creds.teamOpsUser!.email, creds.teamOpsUser!.password, creds.cognitoClientId);
    const s = await consoleFor(teamToken);
    teamSession = s.credentials;
    teams = s.teams ?? [];
    expect(teams.length, 'the team member is in at least one team').toBeGreaterThan(0);
  });

  test.afterAll(async () => {
    if (created && adminSession) {
      await signedCall(adminUrl('assistant-admin', `/admin/roster/${assistantId}/retire`), adminSession, 'POST', { reason: 'e2e cleanup' }).catch(() => undefined);
    }
  });

  const roster = async (team: string, session = teamSession) =>
    signedCall(adminUrl('assistant-admin', `/admin/teams/${encodeURIComponent(team)}/roster`), session);

  test('creates for its own team, and a session issued after the build names the assistant', async () => {
    test.setTimeout(600_000);
    const listing = await roster(teams[0]);
    expect(listing.status, JSON.stringify(listing.body).slice(0, 300)).toBe(200);
    const target = (listing.body.rosterTargets ?? [])[0];
    test.skip(!target, `team ${teams[0]} is offered no create target on this deployment`);
    classification = target.classification;
    const res = await signedCall(adminUrl('assistant-admin', `/admin/teams/${encodeURIComponent(teams[0])}/roster`), teamSession, 'POST', {
      assistantId, classification, role: target.roles[0], displayName,
      descriptor: { modelKey: 'haiku', classifierMode: 'llm' },
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(202);
    created = true;

    let entry: any;
    for (const deadline = Date.now() + 480_000; Date.now() < deadline; await sleep(15_000)) {
      entry = ((await roster(teams[0])).body.runtimeAssistants ?? []).find((a: any) => a.assistant === assistantId);
      if (entry && entry.status !== 'provisioning') break;
    }
    expect(entry, 'the build is on the team roster').toBeTruthy();
    expect(entry.status, `the build ended ${JSON.stringify(entry)}`).toBe('active');
    expect(entry.ownerSeedError, 'the owner tag was written').toBeUndefined();
    expect(entry.firstDraftError, 'the first draft was seeded').toBeUndefined();

    // THE RE-ISSUE: the session the console held before the build does not name the new assistant; one
    // issued now does, which is what the console asks for after a create.
    const reissued = await consoleFor(teamToken);
    expect(reissued.assistants ?? []).toContain(assistantId);
    teamSession = reissued.credentials;
  });

  test('its seeded draft opens on its own route and activates as it is', async () => {
    test.skip(!created, 'the assistant was not created');
    const listed = await signedCall(adminUrl('assistant-admin', `/admin/assistants/${assistantId}/profiles`), teamSession);
    expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
    const profile = (listed.body.profiles ?? [])[0];
    expect(profile).toMatchObject({ profileName: assistantId, hasDraft: true, activeVersion: null });
    const activated = await signedCall(adminUrl('assistant-admin', `/admin/assistants/${assistantId}/profiles/activate`), teamSession, 'POST', { profileName: assistantId });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
    expect(activated.body.version).toBeGreaterThanOrEqual(1);
  });

  test('a rename reaches its identity, and a name another assistant in the classification shows is refused', async () => {
    test.skip(!created, 'the assistant was not created');
    // Each path is written as a literal, so the route-table guard can check what this spec calls.
    const route = (action: 'version' | 'draft' | 'activate') => ({
      version: adminUrl('assistant-admin', `/admin/assistants/${assistantId}/profiles/version`),
      draft: adminUrl('assistant-admin', `/admin/assistants/${assistantId}/profiles/draft`),
      activate: adminUrl('assistant-admin', `/admin/assistants/${assistantId}/profiles/activate`),
    })[action];
    await signedCall(route('version'), teamSession, 'POST', { profileName: assistantId });

    // A name already shown in the classification, read from the admin listing rather than written here.
    const all = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), adminSession);
    const taken = (all.body.profiles ?? []).find((p: any) => p.classification === classification && p.profileName !== assistantId && p.displayName)?.displayName;
    if (taken) {
      const dup = await signedCall(route('draft'), teamSession, 'POST', { profileName: assistantId, patch: { displayName: taken } });
      expect(dup.status, JSON.stringify(dup.body).slice(0, 300)).toBe(409);
      expect(dup.body.code).toBe('ASSISTANT_DISPLAY_NAME_TAKEN');
    }

    const renamed = `${displayName} R`;
    expect((await signedCall(route('draft'), teamSession, 'POST', { profileName: assistantId, patch: { displayName: renamed } })).status).toBe(200);
    const activated = await signedCall(route('activate'), teamSession, 'POST', { profileName: assistantId });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
    expect(activated.body.identityRename, JSON.stringify(activated.body)).toBe('applied');
    const record = JSON.parse(aws(`ssm get-parameter --name /${INSTANCE}/assistant-directory/${assistantId}`).Parameter.Value);
    expect(aws(`chime-sdk-identity describe-app-instance-bot --app-instance-bot-arn ${record.botArn}`).AppInstanceBot.Name).toBe(renamed);
  });

  test('moved to the member\'s other team, it leaves the first roster and joins the second', async () => {
    test.skip(!created, 'the assistant was not created');
    test.skip(teams.length < 2, `the team member is in one team (${teams.join(', ')}); the move needs two`);
    const [from, to] = teams;
    const moved = await signedCall(adminUrl('assistant-admin', `/admin/assistants/${assistantId}/ownership`), teamSession, 'POST', {
      assistant: assistantId, team: to, reason: 'e2e: moving to the member\'s other team',
    });
    expect(moved.status, JSON.stringify(moved.body).slice(0, 300)).toBe(200);
    const fresh = (await consoleFor(teamToken)).credentials;
    const onFrom = ((await roster(from, fresh)).body.runtimeAssistants ?? []).map((a: any) => a.assistant);
    const onTo = ((await roster(to, fresh)).body.runtimeAssistants ?? []).map((a: any) => a.assistant);
    expect(onFrom).not.toContain(assistantId);
    expect(onTo).toContain(assistantId);
  });
});
