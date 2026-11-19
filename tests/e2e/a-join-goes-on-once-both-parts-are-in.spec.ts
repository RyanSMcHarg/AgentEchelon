/**
 * A JOIN GOES ON ONCE BOTH PARTS ARE IN (SPEC-PROCESSES P14), against the deployed stacks.
 *
 * The unit suite proves the join's decision, its claims and its outcome on workflows held in memory
 * (`a-join-waits-on-several-parts.test.ts`), the e2e's own workflow among them. What only a deployment proves is a join held
 * across real hand-backs:
 *  - with the ops version declaring a workflow whose two checks run beside each other (`continue: 'alongside'`) and a join on
 *    both (`helpers/join-workflow.ts`), linked by its own process, an alarm in the team conversation opens both checks for the
 *    on-call at once, under one run and one process id;
 *  - the on-call acknowledges the first check, and the run holds: the join's continuation is not claimed;
 *  - the on-call acknowledges the second, and the run goes on once: the join's continuation records both parts as succeeded,
 *    the second as the one it waited on last, and the run ends;
 *  - the process view reads that process id as one process, ended and succeeded, whose run's steps carry the join's outcome.
 *
 * THE RUN OWNS WHAT IT TOUCHES: one alarm, the rule, the on-call group's one member, and the ops assistant's version, each
 * returned. What the spec opened is settled first, through the product's own run cancel, whether or not the tests passed.
 *
 * GATED: it changes a deployed assistant's active version, so it runs only with PROCESS_E2E=1 (the `processes` phase of
 * `backend/scripts/validate.mjs`). The process view reads the Aurora projection, so its last assertion needs an Aurora deployment.
 *
 * **Coverage:** `e2e/a-join-goes-on-once-both-parts-are-in.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { pollFor, resolveTaskTable } from './helpers/task-backend';
import { noteProgress } from './helpers/watchdog/current';
import { SSM_ROOT, STACK_PREFIX } from './helpers/stack-prefix';
import { awsv } from './helpers/aws';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';
import { joinMembershipGroup } from './helpers/team-group';
import { acknowledge, cancelOpenRuns, isLive, liveTaskAt, runTasksIn, ssmValue, type RunTask } from './helpers/ops-incident';
import { JOIN_E2E_PARTS, JOIN_E2E_PROCESS, JOIN_E2E_STEP, JOIN_E2E_WORKFLOW, joinE2eProcess, joinE2eWorkflow } from './helpers/join-workflow';
import { joinOutcomeOf } from '../../backend/lambda/src/lib/event-workflow';

const RUN = process.env.PROCESS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STAMP = Date.now().toString(36);
const ALARM = `${STACK_PREFIX}-e2e-join-${STAMP}`;
const ON_CALL_GROUP = 'ops-on-call';
const TEAM = 'ops-team';
const AT = 'premium';
const [FIRST, SECOND] = JOIN_E2E_PARTS;
type Row = Record<string, unknown>;

/** One claim of a run, as the task service recorded it (`event-run#<run key>#step#<name>`): its outcome, or undefined. */
function runClaim(channelArn: string, runKey: string, name: string): string | undefined {
  const table = resolveTaskTable('agent-tasks');
  if (!table) return undefined;
  const got = awsv(['dynamodb', 'get-item', '--table-name', table, '--consistent-read',
    '--key', JSON.stringify({ taskId: { S: `event-run#${runKey}#step#${name}` }, channelArn: { S: channelArn } })]);
  return got?.Item?.outcome?.S;
}

test.describe.serial('a join goes on once both parts are in (P14)', () => {
  guardBackendErrors('a-join-goes-on-once-both-parts-are-in');

  let admin: VendedCredentials | undefined;
  let owner = '';
  let previousVersion: number | undefined;
  let lead: TestUser | null = null;
  let leadArn = '';
  let adminIdToken = '';
  let token = '';
  let userPool = '';
  let alarmArn = '';
  let teamRoom = '';
  let ruleId = '';
  let runKey = '';
  let processId = '';
  let parts: RunTask[] = [];
  const inGroupBefore: string[] = [];
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
    const creds = await getTestCredentials();
    userPool = creds.cognitoUserPoolId;
    token = idTokenFor(opsLead!.email, opsLead!.password, creds.cognitoClientId);
    adminIdToken = idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId);
    const session = await exchange(adminIdToken, { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
    // THE MOCK ON-CALL: the group holds exactly the lead for this run, and what it held comes back afterwards.
    for (const u of (cognito(['list-users-in-group', '--group-name', ON_CALL_GROUP])?.Users ?? []) as Array<{ Username: string }>) {
      inGroupBefore.push(u.Username);
      cognito(['admin-remove-user-from-group', '--group-name', ON_CALL_GROUP, '--username', u.Username]);
    }
    cognito(['admin-add-user-to-group', '--group-name', ON_CALL_GROUP, '--username', opsLead!.email]);
    leaveTeamGroup = joinMembershipGroup(TEAM, opsLead!.email, userPool);
  });

  test.afterAll(async () => {
    test.setTimeout(240_000);
    const tryTo = async (what: string, fn: () => unknown) => {
      try { await fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    // SETTLE WHAT THE SPEC OPENED, through the product's own run cancel, before the rule and the alarm go.
    if (admin && teamRoom && alarmArn) await tryTo("cancel this alarm's open runs in the team conversation", () => cancelOpenRuns(adminIdToken, teamRoom, { keep: (t) => t.resource === alarmArn }));
    if (admin && ruleId) await tryTo('detach the trigger', () => signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}/${ruleId}/remove`), admin!, 'POST', {}));
    await tryTo('delete the alarm', () => awsv(['cloudwatch', 'delete-alarms', '--alarm-names', ALARM]));
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

  test('the ops version declares the two-check workflow in its own process, and the alarm is attached to the team conversation', async () => {
    test.setTimeout(240_000);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeVersion ?? undefined;
    expect(previousVersion, `${owner} has no active version to return to`).toBeDefined();
    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: owner });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin!, 'POST', { profileName: owner, draft: true });
    const body = (exported.body?.manifest?.body ?? {}) as { eventWorkflows?: Record<string, unknown>; processes?: Record<string, unknown> };
    const patch = {
      eventWorkflows: { ...(body.eventWorkflows ?? {}), [JOIN_E2E_WORKFLOW]: joinE2eWorkflow() },
      processes: { ...(body.processes ?? {}), ...joinE2eProcess() },
    };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', { profileName: owner, patch, configId: draftIdOf(created) });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 600)).toBe(200);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: owner, configId: draftIdOf(edited) });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 600)).toBe(200);

    awsv(['cloudwatch', 'put-metric-alarm', '--alarm-name', ALARM, '--alarm-description', 'AgentEchelon e2e: the join spec owns and deletes this alarm',
      '--namespace', 'AgentEchelon/E2E', '--metric-name', 'JoinProbe', '--statistic', 'Sum', '--period', '60', '--evaluation-periods', '1', '--threshold', '1',
      '--comparison-operator', 'GreaterThanOrEqualToThreshold', '--treat-missing-data', 'ignore']);
    alarmArn = String(awsv(['cloudwatch', 'describe-alarms', '--alarm-names', ALARM])?.MetricAlarms?.[0]?.AlarmArn ?? '');
    expect(alarmArn).toContain(':alarm:');
    const attached = await signedCall(adminUrl('admin-conversations', `/admin/event-triggers/${TEAM}/${AT}`), admin!, 'POST', { workflow: JOIN_E2E_WORKFLOW, resourceArn: alarmArn, assistant: owner });
    expect(attached.status, JSON.stringify(attached.body).slice(0, 400)).toBe(200);
    ruleId = attached.body.id;
    teamRoom = attached.body.channelArn;
    expect(teamRoom).toMatch(/\/channel\/team-ops-team-premium$/);
  });

  test('the alarm opens both checks at once, under one run and one process id', async () => {
    test.setTimeout(420_000);
    // A RULE SECONDS OLD MAY NOT MATCH YET, so the alarm is raised again, through OK, until the first check opens.
    const raise = (state: 'ALARM' | 'OK') => {
      noteProgress('harness', `the alarm is set to ${state}`);
      awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', ALARM, '--state-value', state, '--state-reason', 'AgentEchelon e2e: the join spec drives this alarm']);
    };
    let first: RunTask | undefined;
    for (let attempt = 1; attempt <= 4 && !first; attempt += 1) {
      if (attempt > 1) raise('OK');
      raise('ALARM');
      first = await liveTaskAt(teamRoom, FIRST, { resource: alarmArn, timeoutMs: 45_000 });
    }
    expect(first, 'the alarm opened the first check').toBeTruthy();
    // THE SECOND OPENS WITHOUT WAITING ON THE FIRST: the run went on alongside it.
    const second = await liveTaskAt(teamRoom, SECOND, { resource: alarmArn, timeoutMs: 60_000 });
    expect(second, 'the second check opened while the first is still open').toBeTruthy();
    expect(isLive(runTasksIn(teamRoom).find((t) => t.taskId === first!.taskId)!), 'the first check is still open beside it').toBe(true);
    expect(second!.runKey, 'both checks are one run\'s').toBe(first!.runKey);
    runKey = first!.runKey;
    processId = first!.processId;
    expect(processId, 'the run started its process').toMatch(/^[a-f0-9]{12}$/);
    expect(second!.processId).toBe(processId);
    parts = [first!, second!];
  });

  test('the join holds after the first check, and goes on once both are in, naming both parts', async () => {
    test.setTimeout(300_000);
    expect(parts, 'both checks opened').toHaveLength(2);
    const after = `after#${JOIN_E2E_STEP}`;
    const [first, second] = parts;

    const one = await acknowledge(token, first);
    expect(one.status, JSON.stringify(one.body).slice(0, 300)).toBe(200);
    // THE FIRST PART'S ENDING IS CLAIMED FOR THE JOIN, and the join holds: its continuation is not claimed.
    await pollFor(() => Promise.resolve(runClaim(teamRoom, runKey, `${after}#${FIRST}`)), (o) => !!o, { timeoutMs: 120_000, intervalMs: 5_000 })
      .catch(() => undefined);
    await sleep(15_000);
    expect(runClaim(teamRoom, runKey, after), 'the join holds while the second check is open').toBeUndefined();
    expect(runClaim(teamRoom, runKey, 'end'), 'and the run has not ended').toBeUndefined();

    const two = await acknowledge(token, second);
    expect(two.status, JSON.stringify(two.body).slice(0, 300)).toBe(200);
    const went = await pollFor(() => Promise.resolve(runClaim(teamRoom, runKey, after)), (o) => !!o, { timeoutMs: 120_000, intervalMs: 5_000 });
    const outcome = joinOutcomeOf(went ?? '');
    expect(outcome, `the join's outcome reads back (${went})`).toBeTruthy();
    expect(outcome!.edge, 'every part succeeded').toBe('success');
    expect(outcome!.last, 'the join waited on the second check last').toBe(SECOND);
    expect(outcome!.parts).toEqual({ [FIRST]: 'success', [SECOND]: 'success' });
    const ended = await pollFor(() => Promise.resolve(runClaim(teamRoom, runKey, 'end')), (o) => !!o, { timeoutMs: 60_000, intervalMs: 5_000 }).catch(() => undefined);
    expect(ended, 'the run ended once the join went on').toBeTruthy();
  });

  test('the process view reads the run as one process, ended and succeeded, whose steps carry the join\'s outcome', async () => {
    test.setTimeout(420_000);
    expect(processId, 'the alarm started a process').not.toBe('');
    const read = () => signedCall(adminUrl('analytics', '/'), admin!, 'POST', { queryType: 'process_runs', process: JOIN_E2E_PROCESS, processId });
    const first = await read();
    expect(first.status, JSON.stringify(first.body ?? {}).slice(0, 300)).toBe(200);
    test.skip(!!first.body?.unsupported, 'process analytics needs Aurora mode');
    const view = async () => {
      const rows = ((await read()).body?.data ?? []) as Row[];
      return { row: rows.find((r) => r.dimension === 'process' && r.process === JOIN_E2E_PROCESS), runs: rows.filter((r) => r.dimension === 'run' && r.process_id === processId) };
    };
    const settled = await pollFor(view, (v) => Number(v.row?.ended) === 1, { timeoutMs: 360_000, intervalMs: 15_000 });
    expect(settled.row, 'the process view has a row for the run\'s process id').toBeTruthy();
    expect(Number(settled.row!.ended), 'the process reads ended').toBe(1);
    expect(Number(settled.row!.succeeded), 'and succeeded').toBe(1);
    expect(settled.runs.map((r) => r.workflow)).toEqual([JOIN_E2E_WORKFLOW]);
    const steps = JSON.stringify(settled.runs[0].steps ?? []);
    expect(steps, 'the run\'s steps carry the join\'s outcome, naming both parts').toContain(`joined:success:${SECOND}:${FIRST}=success,${SECOND}=success`);
  });
});
