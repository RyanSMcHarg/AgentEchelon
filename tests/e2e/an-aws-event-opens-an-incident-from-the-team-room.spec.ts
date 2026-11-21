/**
 * AN AWS EVENT OPENS AN INCIDENT FROM THE TEAM'S ROOM (SPEC-WORKFLOWS-AND-TASKS WT120, WT121, WT129), against the deployed stacks.
 *
 * The unit suites prove each part (`an-aws-event-starts-a-workflow-in-a-team-room.test.ts`,
 * `a-workflow-step-opens-a-child-conversation.test.ts`, `an-incident-resolve-moves-its-run-to-the-review.test.ts`). What only a
 * deployment proves is the path end to end, as AWS resources:
 *  - attaching an alarm in the console's API makes one rule, named by convention, whose one target is the relay, and tags the
 *    team room, whose ARN is the convention's;
 *  - the alarm entering ALARM starts `incident-triage` in that room, which asks the on-call to triage it on the incident card;
 *    confirming opens an `ops` child at its classification, led by the on-call, its own first look runs, and the team's room is
 *    told where it is, and nothing else;
 *  - a second state change inside the window opens no second child, and detaching removes the rule and the tag;
 *  - resolving moves the incident's run on: its runbook tasks are cancelled, the root-cause investigation stays open, and the
 *    team's room is told "resolved" once; the post-incident review starts only once the investigation is complete, and the
 *    team's room hears nothing more when the run ends after it.
 *
 * THE RUN OWNS WHAT IT TOUCHES: one alarm, the rule, the child, the on-call group's one member, and the ops assistant's version, each
 * returned. The team room stands, as it always does.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with INCIDENT_TRIAGE_E2E=1 (validate.mjs --only=incident-triage).
 *
 * **Coverage:** `e2e/an-aws-event-opens-an-incident-from-the-team-room.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl, personApiServes, personUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { looksLikeTaskPlaceholder } from './helpers/agent-helpers';
import { pollFor } from './helpers/task-backend';
import { noteProgress } from './helpers/watchdog/current';
import { SSM_ROOT, STACK_PREFIX } from './helpers/stack-prefix';
import { awsv } from './helpers/aws';
import { SHIPPED_EVENT_WORKFLOWS } from '../../backend/lambda/src/lib/event-workflow';
import { withWorkflowFor } from './helpers/version-under-test';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';
import { pressCard } from './helpers/workflow-task';
import { joinMembershipGroup } from './helpers/team-group';
import { acknowledge, press, forgetChild, isLive, liveTaskAt, opsRoomsOf as opsRoomsFor, posts, postsUntil, removeTasksHeldBy, runTasksIn, saysTemplate, ssmValue } from './helpers/ops-incident';

const RUN = process.env.INCIDENT_TRIAGE_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STAMP = Date.now().toString(36);
const ALARM = `${STACK_PREFIX}-e2e-incident-${STAMP}`;
const ON_CALL_GROUP = 'ops-on-call';
/** The team room's type and classification, which the trigger routes name. */
const TEAM = 'ops-team';
const AT = 'premium';
/** The child conversations this run's alarm opened for the on-call. */
const opsRoomsOf = (leadArn: string) => opsRoomsFor(leadArn, ALARM);

test.describe.serial('an AWS event opens an incident from the team\'s room (incident-triage)', () => {
  guardBackendErrors('an-aws-event-opens-an-incident-from-the-team-room');

  let admin: VendedCredentials | undefined;
  let owner = '';
  let previousVersion: number | undefined;
  let lead: TestUser | null = null;
  let leadArn = '';
  let userPool = '';
  let bearer = '';
  let alarmArn = '';
  let teamRoom = '';
  let ruleId = '';
  let ruleName = '';
  let child = '';
  const inGroupBefore: string[] = [];
  /** What returns the team's membership group to how this run found it. */
  let leaveTeamGroup: () => void = () => undefined;
  const cognito = (args: string[]) => awsv(['cognito-idp', ...args, '--user-pool-id', userPool]);
  /** What the team's room is told about one child, and how it reads each ending. */
  const aboutRoom = (room: string) => (m: { text: string }) => m.text.includes(room.split('/').pop()!);
  const teamToldOf = (room: string) => posts(teamRoom, leadArn).filter(aboutRoom(room));
  const resolved = saysTemplate('incident-resolved-team');
  const otherEndings = [saysTemplate('incident-timed-out'), saysTemplate('incident-ended-unresolved')];

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set INCIDENT_TRIAGE_E2E=1 to run it (validate.mjs --only=incident-triage)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is needed to reach the event triggers');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const opsLead = await getOpsLeadUser();
    test.skip(!opsLead, missingUserReason('opsLeadUser'));
    lead = opsLead;
    test.skip(!ssmValue(`${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`), 'premium has no ops assistant on this deployment (npm run add-assistant-role)');
    leadArn = await personArnOf(opsLead!);
    // THE ASSISTANT THAT OWNS THE OPS ROOMS' WORKFLOWS (`workflowOwner` on `ops` and `ops-team`), whose version the incident runs on.
    owner = liveAssistantFor('premium', 'ops');
    bearer = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`) || leadArn;
    const creds = await getTestCredentials();
    userPool = creds.cognitoUserPoolId;
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
    // THE MOCK ON-CALL: the group holds exactly the lead for this run, and what it held comes back afterwards.
    for (const u of (cognito(['list-users-in-group', '--group-name', ON_CALL_GROUP])?.Users ?? []) as Array<{ Username: string }>) {
      inGroupBefore.push(u.Username);
      cognito(['admin-remove-user-from-group', '--group-name', ON_CALL_GROUP, '--username', u.Username]);
    }
    cognito(['admin-add-user-to-group', '--group-name', ON_CALL_GROUP, '--username', opsLead!.email]);
    // THE TEAM ROOM ADMITS ITS MEMBERSHIP GROUP'S PEOPLE ONLY, so the lead is in that group for the run, and is left as found.
    leaveTeamGroup = joinMembershipGroup(TEAM, opsLead!.email, userPool);
  });

  test.afterAll(async () => {
    const tryTo = async (what: string, fn: () => unknown) => {
      try { await fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (admin && ruleId) await tryTo('detach the trigger', () => signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}/${ruleId}/remove`), admin!, 'POST', {}));
    await tryTo('delete the alarm', () => awsv(['cloudwatch', 'delete-alarms', '--alarm-names', ALARM]));
    // THE CHILD'S TASKS GO WITH IT. A run that failed before its resolve test leaves the child's incident open, and once the
    // child is deleted no card can settle it, so its rows are removed here and no later run reads them.
    if (child) await tryTo('remove the tasks the child holds', () => removeTasksHeldBy(child));
    if (child) await tryTo('delete the child', () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', child, '--chime-bearer', bearer]));
    // A DELETED CHILD LEAVES THE TEAM ROOM'S RECORD TOO. A product room is archived, never deleted, so only this cleanup can leave
    // a room's `children` naming a channel that no longer exists, and the next turn there would read that channel's people and
    // be refused by IAM, as a relative of another classification is.
    if (child && teamRoom) await tryTo('take the deleted child off the team room\'s record', () => forgetChild(teamRoom, child.split('/channel/')[1]));
    if (lead && userPool) await tryTo('return the on-call group', () => {
      cognito(['admin-remove-user-from-group', '--group-name', ON_CALL_GROUP, '--username', lead!.email]);
      for (const u of inGroupBefore) cognito(['admin-add-user-to-group', '--group-name', ON_CALL_GROUP, '--username', u]);
    });
    await tryTo('return the team group', () => leaveTeamGroup());
    if (admin && previousVersion !== undefined) {
      const back = await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName: owner, version: previousVersion }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: ${owner} was not rolled back to version ${previousVersion}`);
    }
  });

  test('the ops assistant activates a version with the incident and the ops room', async () => {
    test.setTimeout(180_000);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeVersion ?? undefined;
    expect(previousVersion, `${owner} has no active version to return to`).toBeDefined();
    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: owner });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin!, 'POST', { profileName: owner, draft: true });
    const body = (exported.body?.manifest?.body ?? {}) as { eventWorkflows?: Record<string, any>; workflows?: string[] };
    const patch: Record<string, unknown> = {
      eventWorkflows: withWorkflowFor({ eventWorkflows: { ...(body.eventWorkflows ?? {}), 'incident-triage': JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['incident-triage'])) } },
        'ops-room', JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['ops-room']))),
      ...(Array.isArray(body.workflows) && body.workflows.length && !body.workflows.includes('incident_first_look') ? { workflows: [...body.workflows, 'incident_first_look'] } : {}),
    };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', { profileName: owner, patch, configId: draftIdOf(created) });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: owner, configId: draftIdOf(edited) });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
  });

  test('attaching the alarm makes one rule and names it on the team room, all readable from AWS', async () => {
    test.setTimeout(120_000);
    awsv(['cloudwatch', 'put-metric-alarm', '--alarm-name', ALARM, '--alarm-description', 'AgentEchelon e2e: the incident spec owns and deletes this alarm',
      '--namespace', 'AgentEchelon/E2E', '--metric-name', 'IncidentProbe', '--statistic', 'Sum', '--period', '60', '--evaluation-periods', '1', '--threshold', '1',
      '--comparison-operator', 'GreaterThanOrEqualToThreshold', '--treat-missing-data', 'ignore']);
    alarmArn = String(awsv(['cloudwatch', 'describe-alarms', '--alarm-names', ALARM])?.MetricAlarms?.[0]?.AlarmArn ?? '');
    expect(alarmArn).toContain(':alarm:');

    const listed = await signedCall(adminUrl('admin-conversations', '/admin/event-types'), admin!);
    expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
    expect((listed.body?.eventTypes ?? []).length, 'the list of event types holds AWS\'s own').toBeGreaterThan(0);

    const attached = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}`), admin!, 'POST', { workflow: 'incident-triage', resourceArn: alarmArn, assistant: owner });
    expect(attached.status, JSON.stringify(attached.body).slice(0, 400)).toBe(200);
    ruleId = attached.body.id;
    teamRoom = attached.body.channelArn;
    expect(teamRoom).toMatch(/\/channel\/team-ops-team-premium$/);
    ruleName = String(attached.body.ruleArn).split('rule/')[1];
    expect(ruleName).toContain(`premium-trigger-${ruleId}`);

    const rule = awsv(['events', 'describe-rule', '--name', ruleName]);
    expect(JSON.parse(rule.EventPattern)).toMatchObject({ source: ['aws.cloudwatch'], resources: [alarmArn], detail: { state: { value: ['ALARM'] } } });
    const targets = awsv(['events', 'list-targets-by-rule', '--rule', ruleName]).Targets as Array<{ Arn: string }>;
    expect(targets).toHaveLength(1);
    expect(targets[0].Arn).toContain('EventTriggerRelay');
    const tags = awsv(['chime-sdk-messaging', 'list-tags-for-resource', '--resource-arn', teamRoom]);
    const tagOf = (k: string) => ((tags?.Tags ?? []) as Array<{ Key: string; Value: string }>).find((t) => t.Key === k)?.Value;
    expect(tagOf('team-room')).toBe('ops-team');
    expect(tagOf(`event-rule:${ruleId}`)).toBe('incident-triage');
  });

  test('the alarm entering ALARM asks the on-call to triage it, confirming opens a child the on-call leads, and the team\'s room gets the link', async () => {
    test.setTimeout(540_000);
    // A RULE SECONDS OLD MAY NOT MATCH YET: EventBridge applies a new rule shortly after `PutRule` answers (an alarm raised
    // 8 seconds after the attach can match nothing). So the alarm is raised again, through OK, until the incident card
    // asks for triage. Each raise is a new event; the rule's window still holds one run, so "one event, one child" is unchanged.
    const raise = (state: 'ALARM' | 'OK') => {
      noteProgress('harness', `the alarm is set to ${state}`);
      awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', state, '--state-reason', 'AgentEchelon e2e: the incident spec drives this alarm']);
    };
    // TRIAGE (WT129): the team's run asks the on-call to confirm the incident on its card, and nothing opens until they do.
    let triage: Awaited<ReturnType<typeof liveTaskAt>>;
    for (let attempt = 1; attempt <= 4 && !triage; attempt += 1) {
      if (attempt > 1) raise('OK');
      raise('ALARM');
      triage = await liveTaskAt(teamRoom, 'triage', { resource: alarmArn, timeoutMs: 45_000 });
      if (!triage) console.log(`[incident-triage] no triage card ${attempt * 45}s after raising the alarm; raising it again`);
    }
    expect(triage, 'the alarm entering ALARM asked the on-call to triage it').toBeTruthy();
    expect(opsRoomsOf(leadArn), 'nothing opens before triage').toEqual([]);
    const creds = await getTestCredentials();
    const token = idTokenFor(lead!.email, lead!.password, creds.cognitoClientId);
    noteProgress('harness', `the on-call confirms triage on ${triage!.taskId}`);
    // Not impacted: this spec proves the incident itself; the customer messaging track is the incident spec's.
    const triaged = await press(token, triage!, 'not_impacted', triage!.taskState || 'asking');
    expect(triaged.status, JSON.stringify(triaged.body).slice(0, 300)).toBe(200);
    let rooms = await pollFor(() => Promise.resolve(opsRoomsOf(leadArn)), (r) => r.length > 0, { timeoutMs: 90_000, intervalMs: 5_000 });
    expect(rooms.length, 'confirming triage opened a child').toBeGreaterThan(0);
    await sleep(15_000);
    rooms = opsRoomsOf(leadArn);
    child = rooms[0];
    expect(rooms, 'one event, one child').toHaveLength(1);

    const childPosts = await postsUntil(child, leadArn, (p) => p.some((m) => m.content.includes('incident_first_look') && m.text && !looksLikeTaskPlaceholder(m.text)), { timeoutMs: 240_000 });
    const parentPosts = posts(teamRoom, leadArn).filter((m) => m.text.includes(child.split('/').pop()!));
    console.log(`[what the room reads] the team's room:\n${parentPosts.map((m) => m.text).join('\n')}`);
    console.log(`[what the room reads] the child:\n${childPosts.map((m) => `--- ${m.text}`).join('\n')}`);
    expect(parentPosts, 'the team\'s room is told where the child is, once').toHaveLength(1);
    expect(childPosts.find((m) => m.content.includes('incident_first_look'))?.text).toMatch(/\d/);

    const membership = awsv(['chime-sdk-messaging', 'list-channel-moderators', '--channel-arn', child, '--chime-bearer', bearer]);
    expect(JSON.stringify(membership)).toContain(leadArn.split('/').pop());
  });

  test('another change in the window opens no second child, and detaching removes the rule and the tag', async () => {
    test.setTimeout(420_000);
    awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', 'OK', '--state-reason', 'AgentEchelon e2e']);
    await sleep(5_000);
    awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', 'ALARM', '--state-reason', 'AgentEchelon e2e']);
    await sleep(60_000);
    expect(opsRoomsOf(leadArn), 'a storm of events is one run').toHaveLength(1);

    // THE OPEN INCIDENT TAKES A REPEAT THE WINDOW DOES NOT (WT122). A second rule on the same alarm has its own id, so the
    // window keys it apart and only the open incident stands between it and a second room: it is copied from a rule this spec
    // owns, whose pattern names the alarm once more, attached, and the alarm raised again. The open incident is read from each whole
    // task, so a repeat that falls in another window opens no second room.
    const copyOf = `${STACK_PREFIX}-e2e-incident-copy-${STAMP}`;
    awsv(['events', 'put-rule', '--name', copyOf, '--state', 'DISABLED', '--event-pattern', JSON.stringify({
      source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: [alarmArn], detail: { alarmName: [ALARM], state: { value: ['ALARM'] } },
    })]);
    try {
      const second = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}`), admin!, 'POST', { workflow: 'incident-triage', rule: copyOf, assistant: owner });
      expect(second.status, JSON.stringify(second.body).slice(0, 300)).toBe(200);
      const secondId = String(second.body.id);
      expect(secondId, 'a second rule, keyed apart from the first').not.toBe(ruleId);
      // A rule seconds old may not match yet (test 3), so the alarm is raised again until the second rule's event arrives.
      let told: ReturnType<typeof posts> = [];
      for (let attempt = 1; attempt <= 3 && !told.length; attempt += 1) {
        noteProgress('harness', `the alarm is raised again for the second rule (${attempt})`);
        awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', 'OK', '--state-reason', 'AgentEchelon e2e']);
        await sleep(5_000);
        awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', 'ALARM', '--state-reason', 'AgentEchelon e2e']);
        told = (await postsUntil(child, leadArn, (p) => p.some((m) => /happened again/.test(m.text)), { timeoutMs: 40_000 })).filter((m) => /happened again/.test(m.text));
      }
      expect(told.length, 'the incident\'s room is told its event happened again').toBeGreaterThan(0);
      expect(opsRoomsOf(leadArn), 'an open incident takes a repeat from another rule, and opens no second room').toHaveLength(1);
      const removedSecond = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}/${secondId}/remove`), admin!, 'POST', {});
      expect(removedSecond.status, JSON.stringify(removedSecond.body).slice(0, 300)).toBe(200);
    } finally {
      awsv(['events', 'delete-rule', '--name', copyOf]);
    }

    const removed = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}/${ruleId}/remove`), admin!, 'POST', {});
    expect(removed.status, JSON.stringify(removed.body).slice(0, 300)).toBe(200);
    expect(() => awsv(['events', 'describe-rule', '--name', ruleName])).toThrow();
    const tags = awsv(['chime-sdk-messaging', 'list-tags-for-resource', '--resource-arn', teamRoom]);
    expect(((tags?.Tags ?? []) as Array<{ Key: string }>).some((t) => t.Key === `event-rule:${ruleId}`)).toBe(false);
    ruleId = '';
  });

  // THE INCIDENT'S CALL (the `meetings` capability): the on-call starts the room's meeting, and the room is told the incident by
  // name, from its own record of the alarm that opened it, and the reason CloudWatch reports for it now.
  test('the on-call calls the room\'s meeting, and the room is told which incident it is about', async () => {
    test.skip(!personApiServes('meetings'), 'the deployment does not declare the meetings capability');
    test.skip(!child, 'no child room');
    test.setTimeout(150_000);
    const creds = await getTestCredentials();
    const token = idTokenFor(lead!.email, lead!.password, creds.cognitoClientId);
    // Each route is written out, so the route table can check it is served.
    const call = (url: string) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ channelArn: child }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }));
    const started = await call(personUrl('/meetings'));
    expect([200, 201], JSON.stringify(started.body).slice(0, 300)).toContain(started.status);
    try {
      noteProgress('harness', 'waiting for the incident call card');
      const callCard = (m: { text: string }) => m.text.includes('Incident call in progress');
      const card = (await postsUntil(child, leadArn, (p) => p.some(callCard), { timeoutMs: 90_000 })).filter(callCard);
      console.log(`[what the room reads] the call card:\n--- ${card[0]?.text}`);
      expect(card, 'the room is told the call started, once').toHaveLength(1);
      expect(card[0].text).toContain(ALARM);
      expect(card[0].text).toContain('The alarm reports: AgentEchelon e2e');
    } finally {
      await call(personUrl('/meetings/end')).catch(() => undefined);
    }
  });

  // THE INCIDENT IS THE ON-CALL'S TO RESOLVE (WT122), and resolving it frees the team's room, so it holds one fewer open: without
  // this a room fills to its policy's cap of open incidents one e2e run at a time. Only this run's incident is resolved,
  // the one held by the child it opened: an earlier run's child is deleted with its tasks (`removeTasksHeldBy`), so none of
  // its tasks is left for this run to press, and no real incident in the room is touched.
  // RESOLVING WHILE THE RUNBOOK HAS STEPS OPEN IS CONFIRMED FIRST (WT128): the press moves the task
  // to the confirmation, the on-call alone is asked, naming the steps still open, and their confirmation resolves it, moves the
  // run on (WT129) and cancels its open runbook tasks with the run's end as their reason, keeping the investigation open.
  test('the on-call resolves the incident on its card, confirms it, and the room holds it open no longer', async () => {
    test.setTimeout(180_000);
    const table = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    expect(table, 'the task table is named in SSM').not.toBe('');
    type Row = { taskId?: { S?: string }; channelArn?: { S?: string }; taskState?: { S?: string }; workflowRun?: { M?: { values?: { M?: { resource?: { S?: string } } } } } };
    // THE TASK IS HELD BY THE CONVERSATION THE INCIDENT OPENED, whose own run records the team conversation that opened it.
    const openOfThisSpec = (): Array<{ taskId: string; channelArn: string; taskState: string }> => ((awsv(['dynamodb', 'scan', '--table-name', table, '--filter-expression', 'openedFrom = :c AND taskType = :t AND taskState IN (:s, :k)',
      '--expression-attribute-values', JSON.stringify({ ':c': { S: teamRoom }, ':t': { S: 'incident_ownership' }, ':s': { S: 'open' }, ':k': { S: 'confirming_resolve' } })])?.Items ?? []) as Row[])
      .filter((r) => (r.workflowRun?.M?.values?.M?.resource?.S ?? '').includes(':alarm:') && (r.workflowRun?.M?.values?.M?.resource?.S ?? '').includes('-e2e-incident-'))
      .map((r) => ({ taskId: r.taskId?.S ?? '', channelArn: r.channelArn?.S ?? '', taskState: r.taskState?.S ?? '' })).filter((r) => r.taskId && r.channelArn);
    test.skip(!child, 'no child conversation opened');
    const ofThisRun = () => openOfThisSpec().filter((o) => o.channelArn === child);
    const open = ofThisRun();
    expect(open.length, 'the incident of this run is open, held in the room it opened').toBe(1);
    const { taskId } = open[0];
    const creds = await getTestCredentials();
    const token = idTokenFor(lead!.email, lead!.password, creds.cognitoClientId);

    noteProgress('harness', `the on-call presses Resolved on ${taskId}`);
    const pressed = await pressCard(token, { channelArn: child, taskId, state: 'open', choice: 'resolved' });
    expect(pressed.status, JSON.stringify(pressed.body).slice(0, 300)).toBe(200);
    expect(pressed.body?.state, 'the runbook still has steps open, so the press asks first and settles nothing').toBe('confirming_resolve');
    expect(ofThisRun().map((o) => o.taskState), 'the incident is still open, awaiting the confirmation').toEqual(['confirming_resolve']);

    // THE CONFIRMATION, TO THE ON-CALL ALONE, naming the steps still open by their declared labels, with its card.
    const confirming = saysTemplate('incident-resolve-confirm');
    const labels = Object.values(SHIPPED_EVENT_WORKFLOWS['ops-room'].states).map((st) => st.label).filter((l): l is string => !!l);
    noteProgress('harness', 'waiting for the confirmation');
    const asked = (await postsUntil(child, leadArn, (p) => p.some((m) => confirming(m.text)), { timeoutMs: 60_000 })).filter((m) => confirming(m.text));
    console.log(`[what the on-call reads] the confirmation:\n--- ${asked[0]?.text}`);
    expect(asked, 'the on-call is asked once').toHaveLength(1);
    expect(labels.some((l) => asked[0].text.includes(l)), 'it names at least one open runbook step by its label').toBe(true);
    expect(asked[0].metadata, 'it carries the card that resolves it or keeps it open').toContain('confirming_resolve');
    const raw = (awsv(['chime-sdk-messaging', 'list-channel-messages', '--channel-arn', child, '--chime-bearer', leadArn, '--max-results', '50'])?.ChannelMessages ?? []) as Array<{ MessageId?: string; Target?: Array<{ MemberArn?: string }> }>;
    const targets = (raw.find((m) => m.MessageId === asked[0].messageId)?.Target ?? []).map((t) => t.MemberArn);
    expect(targets, 'it is addressed to the on-call alone').toEqual([leadArn]);

    noteProgress('harness', `the on-call confirms ${taskId}`);
    const confirmed = await pressCard(token, { channelArn: child, taskId, state: 'confirming_resolve', choice: 'resolved' });
    expect(confirmed.status, JSON.stringify(confirmed.body).slice(0, 300)).toBe(200);
    expect(confirmed.body?.state).toBe('resolved');
    expect(await pollFor(() => Promise.resolve(ofThisRun()), (o) => o.length === 0, { timeoutMs: 60_000, intervalMs: 5_000 }), 'the incident of this run is left open no longer').toEqual([]);

    // THE RUN MOVES ON (WT129, DESIGN-PROCESSES O15): its open runbook tasks are cancelled, each with the run's end as its reason,
    // and none is left pending but the root-cause investigation, which the run went on alongside and keeps open.
    const investigationStays = (t: { step: string }) => t.step === 'investigation';
    const settled = await pollFor(() => runTasksIn(child), (rows) => !rows.some((t) => isLive(t) && !investigationStays(t)), { timeoutMs: 60_000, intervalMs: 5_000 });
    console.log(`[the child's tasks] ${settled.map((t) => `${t.step}:${t.status}:${t.error}`).join(', ')}`);
    expect(settled.filter((t) => isLive(t) && !investigationStays(t)), 'no runbook task is left pending').toEqual([]);
    expect(settled.filter((t) => t.status === 'cancelled' && t.error === 'run-ended').length, 'the runbook tasks open at the confirmation are cancelled as the run\'s end').toBeGreaterThan(0);
    expect(settled.filter((t) => investigationStays(t) && isLive(t)), 'the investigation stays open after the resolve').toHaveLength(1);

    // THE TEAM'S ROOM IS TOLD IT RESOLVED, once, by the incident conversation's run at the resolve (DESIGN-PROCESSES O24), the
    // path this spec drives, and neither of the other endings.
    expect(SHIPPED_EVENT_WORKFLOWS['ops-room'].states['tell-team']?.send).toMatchObject({ template: 'incident-resolved-team', in: 'opener' });
    const told = (await postsUntil(teamRoom, leadArn, (p) => p.some((m) => aboutRoom(child)(m) && resolved(m.text)), { timeoutMs: 90_000 })).filter(aboutRoom(child));
    console.log(`[what the room reads] the team's room, after the resolve:\n${told.map((m) => m.text).join('\n')}`);
    expect(told.filter((m) => resolved(m.text)), "the team's room is told the incident is resolved, once").toHaveLength(1);
    expect(told.filter((m) => otherEndings.some((says) => says(m.text))), 'and is told of no other ending').toEqual([]);
    // RESOLVED IS NO LONGER OPEN FOR THE TEAM'S ROOM, though the incident's run goes on to its review.
    expect(runTasksIn(teamRoom).filter((t) => t.resource === alarmArn && isLive(t)), 'the team\'s run for this alarm holds nothing open').toEqual([]);
  });

  // THE POST-INCIDENT REVIEW (WT129, DESIGN-PROCESSES O20): it starts only once resolve is reached and the investigation is
  // complete, runs in the incident conversation, and the incident's run ends after it. The team's room hears nothing more.
  test('the review starts only once the investigation is complete, and the team hears "resolved" once when the run ends', async () => {
    test.setTimeout(300_000);
    test.skip(!child, 'no child conversation opened');
    const creds = await getTestCredentials();
    const token = idTokenFor(lead!.email, lead!.password, creds.cognitoClientId);
    const investigation = runTasksIn(child).find((t) => t.step === 'investigation' && isLive(t));
    expect(investigation, 'the investigation is open after the resolve').toBeTruthy();
    // RESOLVE ALONE STARTS NO REVIEW: the run waits on the investigation.
    await sleep(20_000);
    expect(runTasksIn(child).filter((t) => t.step === 'review'), 'no review before the investigation is complete').toEqual([]);

    noteProgress('harness', `the on-call completes the investigation ${investigation!.taskId}`);
    const completedAt = Date.now();
    const done = await acknowledge(token, investigation!);
    expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
    // THE REVIEW, DRAFTED BY THE OPS ASSISTANT (its draft may take its full turn), then its card to the on-call.
    const review = await liveTaskAt(child, 'review', { timeoutMs: 180_000 });
    expect(review, 'the review starts once the investigation is complete').toBeTruthy();
    // A FEW SECONDS OF CLOCK SKEW between this machine and the task table's writer are allowed.
    expect(Date.parse(review!.createdAt), 'the review opened after the investigation completed').toBeGreaterThanOrEqual(completedAt - 5_000);

    noteProgress('harness', `the on-call completes the review ${review!.taskId}`);
    const reviewed = await acknowledge(token, review!);
    expect(reviewed.status, JSON.stringify(reviewed.body).slice(0, 300)).toBe(200);
    const after = await pollFor(() => runTasksIn(child), (rows) => !rows.some(isLive), { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(after.filter(isLive), 'the incident\'s run holds nothing open once the review is done').toEqual([]);

    // THE RUN'S END TELLS THE TEAM'S ROOM NOTHING MORE: "resolved" was said once, at the resolve.
    await sleep(20_000);
    const told = teamToldOf(child);
    console.log(`[what the room reads] the team's room, after the run ended:\n${told.map((m) => m.text).join('\n')}`);
    expect(told.filter((m) => resolved(m.text)), "the team's room was told resolved once, and not again at the run's end").toHaveLength(1);
    expect(told.filter((m) => otherEndings.some((says) => says(m.text))), 'and of no other ending').toEqual([]);
  });
});

