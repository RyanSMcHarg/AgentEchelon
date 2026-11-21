/**
 * AN INCIDENT IS ONE PROCESS FROM TRIAGE TO REVIEW (SPEC-PROCESSES P2, P3, P11; SPEC-WORKFLOWS-AND-TASKS WT129), against the
 * deployed stacks.
 *
 * The unit suites prove the shape (`an-incident-resolve-moves-its-run-to-the-review.test.ts`) and the process id's carriage
 * (`a-process-id-follows-the-open-step.test.ts`). What only a deployment proves is the whole incident as one process, which this
 * spec drives itself, from an alarm it owns:
 *  - with the ops version declaring `incident-response` over `incident-triage` and `ops-room`, an alarm opens the incident
 *    conversation at once, led by the on-call, under the process the alarm started, and the whole team conversation is told
 *    where it is, with the on-call mentioned;
 *  - the on-call resolves the incident, completes the investigation and then the post-incident review, which starts only after
 *    both, and the team conversation is told "resolved" once;
 *  - the process view reads the incident as the console shows it: the row for this process id reads ended 1 and succeeded 1,
 *    no run of the process lacks an end, and both runs, the team's and the incident's, are under that one id, each owned by
 *    the ops team; the incident's run ran its review after the investigation, and the team's run, freed at the resolve, ran none;
 *  - the process view's stages are the steps' labels in run order, Incident owner, Customer impact, Resolve and Post-incident review among
 *    them, each with a time, and no internal move is a stage;
 *  - customer messaging is a track beside the incident (WT130; DESIGN-PROCESSES O26 to O34): in the incident conversation, past
 *    the call offer and the affected accounts, naming the accounts opens the account team's conversation from the incident under the same process id while the incident goes on; Advisor
 *    drafts the initial notice, the account team lead approves it within its 15-minute deadline (the time to first notice is
 *    measured from the press), and the incident is told; at resolve the track is told, the lead asks for the final notice on
 *    the card, approves it, and the process completes only once the track has ended too;
 *  - no step of either run crosses to another team (DESIGN-PROCESSES O22).
 *
 * THE RUN OWNS WHAT IT TOUCHES: one alarm, the rule, the incident conversation, the on-call group's one member, and the ops
 * assistant's version, each returned. The team conversation stands, as it always does. What the spec opened is settled first,
 * through the product's own run cancel, whether or not the tests passed, so a run abandoned mid-way leaves no pending task and
 * no process that never ends.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with PROCESS_E2E=1. The process view reads the
 * Aurora projection, so its assertions need an Aurora deployment.
 *
 * **Coverage:** `e2e/an-incident-is-one-process-from-triage-to-review.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
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
import { acknowledge, cancelOpenRuns, childrenOfType, forgetChild, isLive, liveTaskAt, opsRoomsOf, postedBy, posts, postsUntil, press, type Post, removeTasksHeldBy, runTasksIn, saysTemplate, ssmValue } from './helpers/ops-incident';
import { opsIncidentProcess } from '../../demo/portable-assistants/ops-assistant-manifest';
import { processShapeOf, runStages, stageSummary } from '../../frontend/packages/admin/src/components/admin/processStages';

const RUN = process.env.PROCESS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STAMP = Date.now().toString(36);
const ALARM = `${STACK_PREFIX}-e2e-process-${STAMP}`;
const ON_CALL_GROUP = 'ops-on-call';
const TEAM = 'ops-team';
const AT = 'premium';
const PROCESS = 'incident-response';
const MESSAGING = 'customer-messaging';
const ACCOUNT_LEAD_GROUP = 'account-team-lead';
/** The initial notice's declared deadline (O34), which the time to first notice is held to. */
const FIRST_NOTICE_MS = 15 * 60_000;
type Row = Record<string, unknown>;

test.describe.serial('an incident is one process from triage to review (P11, WT129)', () => {
  guardBackendErrors('an-incident-is-one-process-from-triage-to-review');

  let admin: VendedCredentials | undefined;
  let owner = '';
  let previousVersion: number | undefined;
  let lead: TestUser | null = null;
  let leadArn = '';
  let adminIdToken = '';
  let token = '';
  let userPool = '';
  let bearer = '';
  let alarmArn = '';
  let teamRoom = '';
  let ruleId = '';
  let child = '';
  /** The customer messaging conversation the incident opened (WT130), and when customer impact was confirmed. */
  let messaging = '';
  let impactAt = 0;
  let leaveAccountGroup: () => void = () => undefined;
  let tookAccountLead = false;
  const accountLeadBefore: string[] = [];
  /** The process id the alarm started, read from the incident conversation's `lead-task`. */
  let processId = '';
  const inGroupBefore: string[] = [];
  /** Whether this run changed the on-call group, set the moment it did, so cleanup restores only what was taken. */
  let tookOnCall = false;
  let leaveTeamGroup: () => void = () => undefined;
  const cognito = (args: string[]) => awsv(['cognito-idp', ...args, '--user-pool-id', userPool]);

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set PROCESS_E2E=1 to run it');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is needed to reach the event triggers and the process view');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const opsLead = await getOpsLeadUser();
    test.skip(!opsLead, missingUserReason('opsLeadUser'));
    lead = opsLead;
    test.skip(!ssmValue(`${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`), 'premium has no ops assistant on this deployment (npm run add-assistant-role)');
    leadArn = await personArnOf(opsLead!);
    owner = liveAssistantFor('premium', 'ops');
    bearer = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`) || leadArn;
    const creds = await getTestCredentials();
    userPool = creds.cognitoUserPoolId;
    token = idTokenFor(opsLead!.email, opsLead!.password, creds.cognitoClientId);
    adminIdToken = idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId);
    const session = await exchange(adminIdToken, { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
    // THE MOCK ON-CALL: the group holds exactly the lead for this run, and what it held comes back afterwards.
    inGroupBefore.push(...((cognito(['list-users-in-group', '--group-name', ON_CALL_GROUP])?.Users ?? []) as Array<{ Username: string }>).map((u) => u.Username));
    tookOnCall = true;
    for (const u of inGroupBefore) cognito(['admin-remove-user-from-group', '--group-name', ON_CALL_GROUP, '--username', u]);
    cognito(['admin-add-user-to-group', '--group-name', ON_CALL_GROUP, '--username', opsLead!.email]);
    leaveTeamGroup = joinMembershipGroup(TEAM, opsLead!.email, userPool);
    // THE ACCOUNT TEAM'S LEAD IS THE SAME PERSON FOR THIS RUN: in the messaging type's group, and the one holder of its lead role.
    leaveAccountGroup = joinMembershipGroup(MESSAGING, opsLead!.email, userPool);
    // THE ACCOUNT TEAM LEAD, AS THE ON-CALL: the group holds exactly the lead for this run, and whoever held it (the demo cast's
    // lead, on a deployment the demo runs on) is given it back afterwards.
    accountLeadBefore.push(...((cognito(['list-users-in-group', '--group-name', ACCOUNT_LEAD_GROUP])?.Users ?? []) as Array<{ Username: string }>).map((u) => u.Username));
    tookAccountLead = true;
    for (const u of accountLeadBefore) cognito(['admin-remove-user-from-group', '--group-name', ACCOUNT_LEAD_GROUP, '--username', u]);
    cognito(['admin-add-user-to-group', '--group-name', ACCOUNT_LEAD_GROUP, '--username', opsLead!.email]);
  });

  test.afterAll(async () => {
    // CLEANUP CANCELS EACH CONVERSATION'S OPEN RUNS AND WAITS FOR THEM TO SETTLE, up to a minute each.
    test.setTimeout(360_000);
    const tryTo = async (what: string, fn: () => unknown) => {
      try { await fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    // SETTLE WHAT THE SPEC OPENED, through the product's own run cancel, before anything is deleted: customer messaging's runs,
    // then the incident's, whose end is told to the team conversation and ends the team's run, which holds no task of its own
    // and waits only on the incident conversation (`hold`). A run that failed before it read the incident conversation still
    // finds the one this alarm opened. An alarm whose incident conversation never opened leaves the team's run at its `open`
    // step, which its backstop ends.
    if (!child && leadArn) await tryTo('find the incident conversation', () => { child = opsRoomsOf(leadArn, ALARM)[0] ?? ''; });
    if (!messaging && child) await tryTo('find the customer messaging conversation', () => { messaging = childrenOfType(child, MESSAGING)[0] ?? ''; });
    if (admin && messaging) await tryTo("cancel the customer messaging's open runs", () => cancelOpenRuns(adminIdToken, messaging));
    if (admin && child) await tryTo("cancel the incident's open runs", () => cancelOpenRuns(adminIdToken, child));
    // THE TEAM'S RUN IS NOT LEFT AT `hold`: the incident's end reaches the team conversation, by its events, before anything is deleted.
    if (child && teamRoom && leadArn) await tryTo('see the team run freed by the incident\'s end', () => postsUntil(teamRoom, leadArn, (p) => p.some((m) => m.text.includes(child.split('/').pop()!) && [saysTemplate('incident-resolved-team'), saysTemplate('incident-ended-unresolved'), saysTemplate('incident-timed-out')].some((says) => says(m.text))), { timeoutMs: 60_000 }));
    if (admin && ruleId) await tryTo('detach the trigger', () => signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}/${ruleId}/remove`), admin!, 'POST', {}));
    await tryTo('delete the alarm', () => awsv(['cloudwatch', 'delete-alarms', '--alarm-names', ALARM]));
    if (child) await tryTo('remove the tasks the child holds', () => removeTasksHeldBy(child));
    if (child) await tryTo('delete the child', () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', child, '--chime-bearer', bearer]));
    if (child && teamRoom) await tryTo('take the deleted child off the team room\'s record', () => forgetChild(teamRoom, child.split('/channel/')[1]));
    if (messaging) await tryTo('remove the tasks customer messaging holds', () => removeTasksHeldBy(messaging));
    if (messaging) await tryTo('delete the customer messaging conversation', () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', messaging, '--chime-bearer', bearer]));
    if (tookAccountLead && lead && userPool) await tryTo('return the account team lead group', () => {
      cognito(['admin-remove-user-from-group', '--group-name', ACCOUNT_LEAD_GROUP, '--username', lead!.email]);
      for (const u of accountLeadBefore) cognito(['admin-add-user-to-group', '--group-name', ACCOUNT_LEAD_GROUP, '--username', u]);
    });
    await tryTo('return the account team group', () => leaveAccountGroup());
    if (tookOnCall && lead && userPool) await tryTo('return the on-call group', () => {
      cognito(['admin-remove-user-from-group', '--group-name', ON_CALL_GROUP, '--username', lead!.email]);
      for (const u of inGroupBefore) cognito(['admin-add-user-to-group', '--group-name', ON_CALL_GROUP, '--username', u]);
    });
    await tryTo('return the team group', () => leaveTeamGroup());
    if (admin && previousVersion !== undefined) {
      const back = await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName: owner, version: previousVersion }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: ${owner} was not rolled back to version ${previousVersion}`);
    }
  });

  test('the ops version declares incident response over its workflows, and the alarm is attached to the team conversation', async () => {
    test.setTimeout(240_000);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeVersion ?? undefined;
    expect(previousVersion, `${owner} has no active version to return to`).toBeDefined();
    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: owner });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin!, 'POST', { profileName: owner, draft: true });
    const body = (exported.body?.manifest?.body ?? {}) as { eventWorkflows?: Record<string, any>; workflows?: string[] };
    const patch: Record<string, unknown> = {
      eventWorkflows: withWorkflowFor({ eventWorkflows: {
        ...(body.eventWorkflows ?? {}),
        'incident-triage': JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['incident-triage'])),
        [MESSAGING]: JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS[MESSAGING])),
      } }, 'ops-room', JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['ops-room']))),
      processes: opsIncidentProcess(),
      ...(Array.isArray(body.workflows) && body.workflows.length && !body.workflows.includes('incident_first_look') ? { workflows: [...body.workflows, 'incident_first_look'] } : {}),
    };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', { profileName: owner, patch, configId: draftIdOf(created) });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: owner, configId: draftIdOf(edited) });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);

    awsv(['cloudwatch', 'put-metric-alarm', '--alarm-name', ALARM, '--alarm-description', 'AgentEchelon e2e: the process spec owns and deletes this alarm',
      '--namespace', 'AgentEchelon/E2E', '--metric-name', 'ProcessProbe', '--statistic', 'Sum', '--period', '60', '--evaluation-periods', '1', '--threshold', '1',
      '--comparison-operator', 'GreaterThanOrEqualToThreshold', '--treat-missing-data', 'ignore']);
    alarmArn = String(awsv(['cloudwatch', 'describe-alarms', '--alarm-names', ALARM])?.MetricAlarms?.[0]?.AlarmArn ?? '');
    expect(alarmArn).toContain(':alarm:');
    const attached = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}`), admin!, 'POST', { workflow: 'incident-triage', resourceArn: alarmArn, assistant: owner });
    expect(attached.status, JSON.stringify(attached.body).slice(0, 400)).toBe(200);
    ruleId = attached.body.id;
    teamRoom = attached.body.channelArn;
    expect(teamRoom).toMatch(/\/channel\/team-ops-team-premium$/);
  });

  test('the alarm opens the incident conversation at once, and the whole team is told why, with the on-call mentioned', async () => {
    test.setTimeout(480_000);
    // A RULE SECONDS OLD MAY NOT MATCH YET, so the alarm is raised again, through OK, until the incident conversation opens.
    const raise = (state: 'ALARM' | 'OK') => {
      noteProgress('harness', `the alarm is set to ${state}`);
      awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', state, '--state-reason', 'AgentEchelon e2e: the process spec drives this alarm']);
    };
    let rooms: string[] = [];
    for (let attempt = 1; attempt <= 4 && rooms.length === 0; attempt += 1) {
      if (attempt > 1) raise('OK');
      raise('ALARM');
      rooms = await pollFor(() => Promise.resolve(opsRoomsOf(leadArn, ALARM)), (r) => r.length > 0, { timeoutMs: 60_000, intervalMs: 5_000 });
    }
    // NOBODY IS ASKED FIRST: the alarm opens one incident conversation, led by the on-call.
    expect(rooms, 'the alarm opened one incident conversation').toHaveLength(1);
    child = rooms[0];
    expect(runTasksIn(teamRoom).filter((t) => t.resource === alarmArn && isLive(t)), 'the team conversation holds no card for it').toEqual([]);
    const ownership = await liveTaskAt(child, 'lead-task', { timeoutMs: 120_000 });
    expect(ownership, "the incident conversation holds the on-call's ownership task").toBeTruthy();
    processId = ownership!.processId;
    expect(processId, 'the incident runs under the process the alarm started').not.toBe('');
    // THE WHOLE TEAM IS TOLD WHY, with the on-call mentioned and the incident conversation linked: the message the team run's
    // `tell` step posted, named by its own metadata, never by its words.
    const fromTell = (m: Post) => postedBy(m) === 'incident-triage' && m.text.includes(child.split('/').pop()!);
    const told = (await postsUntil(teamRoom, leadArn, (p) => p.some(fromTell), { timeoutMs: 90_000 })).filter(fromTell);
    console.log(`[what the team reads] ${told[0]?.text ?? '(none)'}`);
    expect(told, 'the team conversation is told where the incident is').toHaveLength(1);
    // THE ON-CALL IS NAMED BY THEIR DISPLAY NAME, as an inert mention in the team's line: the line says who owns it, never an id.
    const onCall = /\*\*On call:\*\* (.+?) owns it/.exec(told[0].text);
    expect(onCall?.[1]?.trim(), 'the on-call is named').toBeTruthy();
    expect(told[0].text, 'by name, not by id').not.toContain(leadArn.split('/').pop()!);
  });

  test('triage in the incident conversation: past the call offer, naming the affected accounts starts customer messaging', async () => {
    test.setTimeout(600_000);
    // TRIAGE IS THE INCIDENT CONVERSATION'S: past the call offer (declined here), once Advisor has named the affected
    // accounts, customer messaging starts with nobody asked (O27).
    const offer = await liveTaskAt(child, 'offer-call', { timeoutMs: 240_000 });
    expect(offer, "the lead is offered the incident's call").toBeTruthy();
    const declined = await press(token, offer!, 'declined', offer!.taskState || 'offered');
    expect(declined.status, JSON.stringify(declined.body).slice(0, 300)).toBe(200);
    impactAt = Date.now();
    expect(runTasksIn(child).some((t) => t.step === 'impact-confirm'), 'nobody is asked whether customers are impacted').toBe(false);
  });

  test('customers impacted: customer messaging opens beside the incident, and its initial notice is approved within its deadline', async () => {
    test.setTimeout(600_000);
    // ONE CONVERSATION, OPENED FROM THE INCIDENT, under the same process id (O28, O32).
    const opened = await pollFor(() => Promise.resolve(childrenOfType(child, MESSAGING)), (c) => c.length > 0, { timeoutMs: 420_000, intervalMs: 5_000 });
    expect(opened, 'naming the accounts opened one customer messaging conversation').toHaveLength(1);
    messaging = opened[0];
    // THE INCIDENT NEVER WAITED ON IT: its owner's task and first look are there whatever the track is doing.
    expect(runTasksIn(child).some((t) => t.step === 'lead-task' && isLive(t)), 'the incident goes on beside it').toBe(true);
    expect(posts(child, leadArn).some((m) => saysTemplate('customer-messaging-opened')(m.text)), 'the incident is told where customer messaging is').toBe(true);
    // ADVISOR DRAFTS THE INITIAL NOTICE, then the account team lead's approval card opens (O29, O30).
    const approval = await liveTaskAt(messaging, 'initial-approval', { timeoutMs: 300_000 });
    expect(approval, 'the initial notice is drafted and offered for approval').toBeTruthy();
    expect(approval!.processId, 'the track is the same process').toBe(processId);
    // THE DRAFT IS WHAT THE ACCOUNT TEAM READS: the asked turn is one turn of the primary's (WT118), which opens no task, so
    // the draft is the message that turn posted, named by its own metadata (`eventStep`, the asked intent), never by its words.
    const drafts = posts(messaging, leadArn).filter((m) => postedBy(m) === 'customer_notice_draft' && !looksLikeTaskPlaceholder(m.text) && m.text.length > 0);
    console.log(`[what the room reads] the initial notice draft:\n${drafts[0]?.text ?? '(none)'}`);
    expect(drafts.length, 'the initial notice was drafted in the customer messaging conversation').toBeGreaterThan(0);
    // THE DRAFT HAS THE INCIDENT'S FACTS TO WORK FROM (O28): the account team's opening states when it started and its Region,
    // carried from the alarm's event through the incident, and the draft names the start it was given rather than a placeholder.
    const region = alarmArn.split(':')[3];
    const opening = posts(messaging, leadArn).find((m) => m.text.includes('What the incident has confirmed:'));
    expect(opening?.text, 'the account team\'s opening states the incident\'s Region').toContain(`AWS Region: ${region}`);
    const since = /Since: (\d{4}-\d{2}-\d{2} (\d{2}:\d{2}) UTC)/.exec(opening?.text ?? '');
    expect(since, 'the account team\'s opening states when the incident started').toBeTruthy();
    const [hh, mm] = since![2].split(':').map(Number);
    const startAt = [since![2], `${hh % 12 || 12}:${String(mm).padStart(2, '0')}`];
    expect(startAt.some((t) => drafts[0].text.includes(t)), `the draft names the start the incident confirmed (${since![1]})`).toBe(true);
    const approved = await press(token, approval!, 'approved', approval!.taskState || 'deciding');
    expect(approved.status, JSON.stringify(approved.body).slice(0, 300)).toBe(200);
    // THE TIME TO FIRST NOTICE: confirmed impact to an approved initial notice, inside its declared deadline.
    const firstNoticeMs = Date.now() - impactAt;
    noteProgress('harness', `time to first notice: ${Math.round(firstNoticeMs / 1000)}s`);
    expect(firstNoticeMs, 'the initial notice is approved within its deadline').toBeLessThan(FIRST_NOTICE_MS);
    expect(runTasksIn(messaging).some((t) => t.step === 'initial-revise'), 'no deadline was missed').toBe(false);
    const told = await postsUntil(child, leadArn, (p) => p.some((m) => saysTemplate('customer-notice-approved')(m.text)), { timeoutMs: 90_000 });
    expect(told.filter((m) => saysTemplate('customer-notice-approved')(m.text)), 'the incident is told the notice was approved').toHaveLength(1);
    const updates = await liveTaskAt(messaging, 'updates', { timeoutMs: 90_000 });
    expect(updates, 'the account team lead holds the card for the next notice').toBeTruthy();
  });

  test('resolve, then the investigation, then the review: the review starts only after both, and the team hears "resolved" once', async () => {
    test.setTimeout(480_000);
    const resolved = saysTemplate('incident-resolved-team');
    const otherEndings = [saysTemplate('incident-timed-out'), saysTemplate('incident-ended-unresolved')];
    const aboutChild = (m: Post) => m.text.includes(child.split('/').pop()!);
    const teamTold = () => posts(teamRoom, leadArn).filter(aboutChild);

    // RESOLVE, confirmed where the runbook still has steps open (WT128).
    const ownership = runTasksIn(child).find((t) => t.step === 'lead-task' && isLive(t));
    expect(ownership, 'the ownership task is open').toBeTruthy();
    const pressed = await pressCard(token, { channelArn: child, taskId: ownership!.taskId, state: 'open', choice: 'resolved' });
    expect(pressed.status, JSON.stringify(pressed.body).slice(0, 300)).toBe(200);
    if (pressed.body?.state === 'confirming_resolve') {
      const confirmed = await pressCard(token, { channelArn: child, taskId: ownership!.taskId, state: 'confirming_resolve', choice: 'resolved' });
      expect(confirmed.status, JSON.stringify(confirmed.body).slice(0, 300)).toBe(200);
    }
    const told = (await postsUntil(teamRoom, leadArn, (p) => p.some((m) => aboutChild(m) && resolved(m.text)), { timeoutMs: 90_000 })).filter(aboutChild);
    expect(told.filter((m) => resolved(m.text)), 'the team is told "resolved" at the resolve').toHaveLength(1);

    // THE INVESTIGATION STAYS OPEN, and no review starts before it is complete.
    const investigation = await liveTaskAt(child, 'investigation', { timeoutMs: 30_000 });
    expect(investigation, 'the investigation stays open after the resolve').toBeTruthy();
    await sleep(20_000);
    expect(runTasksIn(child).filter((t) => t.step === 'review'), 'no review before the investigation is complete').toEqual([]);
    const completedAt = Date.now();
    const done = await acknowledge(token, investigation!);
    expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);

    const review = await liveTaskAt(child, 'review', { timeoutMs: 180_000 });
    expect(review, 'the review starts once the investigation is complete').toBeTruthy();
    expect(Date.parse(review!.createdAt), 'the review opened after the investigation completed').toBeGreaterThanOrEqual(completedAt - 5_000);
    expect(review!.processId, 'the review is the same process').toBe(processId);
    const reviewed = await acknowledge(token, review!);
    expect(reviewed.status, JSON.stringify(reviewed.body).slice(0, 300)).toBe(200);
    const after = await pollFor(() => runTasksIn(child), (rows) => !rows.some(isLive), { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(after.filter(isLive), 'the incident run holds nothing open once the review is done').toEqual([]);

    // CUSTOMER MESSAGING WAS TOLD AT THE RESOLVE, and the lead asks for the final notice on the card (O33).
    const resolvedThere = await postsUntil(messaging, leadArn, (p) => p.some((m) => saysTemplate('customer-messaging-resolved')(m.text)), { timeoutMs: 90_000 });
    expect(resolvedThere.filter((m) => saysTemplate('customer-messaging-resolved')(m.text)), 'customer messaging is told the incident resolved, once').toHaveLength(1);
    const updates = runTasksIn(messaging).find((t) => t.step === 'updates' && isLive(t));
    expect(updates, 'the lead\'s card is open').toBeTruthy();
    const final = await press(token, updates!, 'draft_final', updates!.taskState || 'open');
    expect(final.status, JSON.stringify(final.body).slice(0, 300)).toBe(200);
    const finalApproval = await liveTaskAt(messaging, 'final-approval', { timeoutMs: 300_000 });
    expect(finalApproval, 'the final notice is drafted and offered for approval').toBeTruthy();
    const finalApproved = await press(token, finalApproval!, 'approved', finalApproval!.taskState || 'deciding');
    expect(finalApproved.status, JSON.stringify(finalApproved.body).slice(0, 300)).toBe(200);
    const trackDone = await pollFor(() => runTasksIn(messaging), (rows) => !rows.some(isLive), { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(trackDone.filter(isLive), 'the customer messaging run holds nothing open once the final notice is approved').toEqual([]);

    // THE RUN'S END TELLS THE TEAM NOTHING MORE.
    await sleep(20_000);
    const finally_ = teamTold();
    expect(finally_.filter((m) => resolved(m.text)), 'the team heard "resolved" once').toHaveLength(1);
    expect(finally_.filter((m) => otherEndings.some((says) => says(m.text))), 'and no other ending').toEqual([]);
  });

  test('the process view reads this incident as ended and succeeded: every run under one process id, each with an end, owned by ops', async () => {
    test.setTimeout(420_000);
    const read = () => signedCall(adminUrl('analytics', '/'), admin!, 'POST', { queryType: 'process_runs', process: PROCESS, processId });
    const first = await read();
    expect(first.status, JSON.stringify(first.body ?? {}).slice(0, 300)).toBe(200);
    // A DEPLOYMENT PRECONDITION: the process view reads the Aurora projection.
    test.skip(!!first.body?.unsupported, 'process analytics needs Aurora mode');
    // THE OUTCOME AS THE CONSOLE SHOWS IT: the process row this process id narrows to, and its runs.
    const view = async () => {
      const rows = ((await read()).body?.data ?? []) as Row[];
      return { row: rows.find((r) => r.dimension === 'process' && r.process === PROCESS), runs: rows.filter((r) => r.dimension === 'run' && r.process_id === processId) };
    };
    const settled = await pollFor(view, (v) => Number(v.row?.ended) === 1, { timeoutMs: 360_000, intervalMs: 15_000 });
    expect(settled.row, "the process view has a row for this incident's process id").toBeTruthy();
    expect(Number(settled.row!.runs), 'one process').toBe(1);
    expect(Number(settled.row!.ended), `the process reads ended: ${JSON.stringify(settled.runs.map((r) => [r.workflow, r.ended_at]))}`).toBe(1);
    expect(Number(settled.row!.succeeded), 'and succeeded').toBe(1);
    // NO RUN OF THE PROCESS LACKS AN END: a run its process carries that never ends keeps the process open for ever.
    expect(settled.runs.filter((r) => !r.ended_at).map((r) => r.workflow), 'no run of the process lacks an end').toEqual([]);
    expect(settled.runs.map((r) => r.workflow).sort(), "the process is the team's run, the incident's run and the customer messaging run, and nothing else").toEqual([MESSAGING, 'incident-triage', 'ops-room']);
    for (const r of settled.runs) expect(r.disposition).toBe('success');
    for (const r of settled.runs) expect(r.owner_team).toBe('ops');
    const ended = settled.runs;
    const room = ended.find((r) => r.workflow === 'ops-room')!;
    const team = ended.find((r) => r.workflow === 'incident-triage')!;
    // THE TEAM'S RUN ENDS AT THE RESOLVE, before the incident's run ends after its review.
    expect(Number(team.ended_at)).toBeLessThanOrEqual(Number(room.ended_at));
    const steps = (room.steps as Array<{ step: string; outcome: string }>) ?? [];
    const at = (k: string) => steps.findIndex((s) => s.step === k);
    // THE INCIDENT'S RUN ENDED ON ITS REVIEW (WT129, O20): its end records the moves of the step that ended it, so the review
    // is there, and the order against the investigation is the task rows' (the test before); the team run has none.
    expect(at('review'), JSON.stringify(steps).slice(0, 300)).toBeGreaterThanOrEqual(0);
    expect(((team.steps as Array<{ step: string }>) ?? []).some((s) => s.step === 'review-draft' || s.step === 'review')).toBe(false);
    // THE STAGES AS THE CONSOLE SHOWS THEM (P9, UX section 5): named by the steps' labels on the version this spec activated, in
    // run order, the incident's (the team's run holds none), each with a time, read by the console's own functions.
    const shape = processShapeOf({ eventWorkflows: SHIPPED_EVENT_WORKFLOWS, processes: opsIncidentProcess() }, PROCESS);
    const summary = stageSummary(ended, shape);
    const labels = summary.map((s) => s.label);
    // THE TEAM'S RUN HOLDS NO STAGE OF ITS OWN: the incident's stages come first, customer impact among them.
    expect(summary.some((s) => s.workflow === 'incident-triage'), JSON.stringify(summary).slice(0, 400)).toBe(false);
    const inOrder = ['Incident owner', 'Customer impact', 'Resolve', 'Post-incident review'].map((l) => labels.indexOf(l));
    expect(inOrder.every((i) => i >= 0), `the incident's stages: ${labels.join(', ')}`).toBe(true);
    expect([...inOrder].sort((a, b) => a - b), `the stages run in order: ${labels.join(', ')}`).toEqual(inOrder);
    for (const run of ended) {
      for (const s of runStages(run, shape)) expect(s.ms, `${s.label} has a duration`).not.toBeNull();
    }
    for (const s of summary) expect(s.p50_ms, `${s.label} has a median time`).not.toBeNull();
    // THE MESSAGING TRACK'S STAGES BESIDE THE INCIDENT'S, timed (O31): the Initial notice stages are the time to first notice.
    for (const l of ['Initial notice', 'Initial notice approval', 'Updates', 'Final notice']) expect(labels, `the messaging track's stages: ${labels.join(', ')}`).toContain(l);
    const track = ended.find((r) => r.workflow === MESSAGING)!;
    const firstNotice = runStages(track, shape).filter((st) => st.label.startsWith('Initial notice')).reduce((n, st) => n + (st.ms ?? 0), 0);
    expect(firstNotice, 'the time to first notice is read from the Initial notice stages').toBeGreaterThan(0);
    expect(firstNotice, 'and is inside the declared deadline').toBeLessThan(FIRST_NOTICE_MS);
    // THE PROCESS ENDED ONLY ONCE BOTH TRACKS HAD: its end is no earlier than the messaging run's.
    expect(Math.max(...ended.map((r) => Number(r.ended_at)))).toBeGreaterThanOrEqual(Number(track.ended_at));
    expect([...((track.steps as Array<{ step: string }>) ?? []), ...((track.step_times as Array<{ step: string }>) ?? [])].some((s) => s.step === 'initial-late'), 'the first notice missed no deadline').toBe(false);
    for (const internal of ['open', 'hold', 'opening']) expect(summary.map((s) => s.step)).not.toContain(internal);
    // NO HAND-OFF: no step of either run was sent to another team (O22).
    for (const s of [...steps, ...((team.steps as Array<{ step: string; outcome: string }>) ?? [])]) expect(s.step).not.toBe('handoff');
  });
});
