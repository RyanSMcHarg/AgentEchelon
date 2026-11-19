/**
 * AN ALARM A ROOM WATCHES STARTS ITS WORKFLOW, AND THE ROOM'S FIRST LOOK OPENS A TASK (ADR-061, the incident watch and
 * example (a); DESIGN-MEETING-ONBOARDING-AND-INCIDENT-SUBAGENTS sections 2, 4.1 and 4.2), against the deployed stacks.
 *
 * The unit suites prove each half with the code's own functions (`an-alarm-a-room-watches-starts-its-workflow.test.ts`,
 * `an-event-step-opens-a-task-the-room-works-on.test.ts`). What only a deployment proves is the path end to end:
 *  - the platform's ops event, naming an alarm, reaches the premium creator through its rule, and the room it opens
 *    records the alarm on its own context row and in the alarm's watch record;
 *  - `conversation-opened` runs the ops room's first look, a task step held by the room's ops assistant (`by: {
 *    assistantRole: 'ops' }`): it opens an `incident_first_look` task owned by that assistant and visible to the room, the
 *    ops assistant's pickup turn posts the first look as itself, and the state's declared move (`auto`) takes the task to
 *    `findings_shared` once the turn answered;
 *  - a CloudWatch alarm state change of this deployment's alarms reaches the router through the incident-watch rule,
 *    the router reads the alarm back under its prefix-scoped `DescribeAlarms`, and the room's incident watch posts the
 *    state and then the re-read, each as the ops assistant, which owns the room's workflows;
 *  - a state change on an alarm no room watches posts nothing.
 *
 * THE RUN OWNS EVERYTHING IT TOUCHES. Two alarms with this deployment's name prefix (one the room watches, one no room
 * watches), each with no actions and missing data treated as `ignore`, so the state the test sets is the state the
 * alarm keeps; a standing `ops-team` room for the event to concern; and the `ops` room the event opens. The ops
 * assistant, which owns an `ops` room's workflows (`workflowOwner`), gets a version whose welcome runs the platform's `ops-room` for `ops` conversations and whose
 * `eventWorkflows` carries a copy of the platform's `incident-watch`, because an event that selects its workflow runs
 * the version's. Afterwards the alarms, their watch records, both rooms and their rows are deleted and the ops assistant is
 * rolled back to the version it had.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `INCIDENT_WATCH_E2E=1` (validate.mjs --only=incident-watch). Every other gate names the dependency that is absent.
 *  - DESIGN-CONVERSATION-DASHBOARDS: the watch's required refresh publishes the room's dashboard as the ops assistant; a member
 *    reads it with a credential the exchange vends for that one conversation, and is refused another's; a person outside the
 *    room is refused the credential; and the page the ops assistant publishes on request opens on a member's signed link only.
 *
 * **Coverage:** `e2e/an-alarm-a-room-watches-starts-its-workflow.spec.ts`
 */
import { test, expect, expectAlarm } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { joinMembershipGroup } from './helpers/team-group';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, adminUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { messageRowsVisibleTo, type VisibleMessage } from './helpers/third-party-view';
import { looksLikeTaskPlaceholder } from './helpers/agent-helpers';
import { channelTasks, graphEdges, hasEdge, pollFor, unmarshalItem, type TaskRow } from './helpers/task-backend';
import { INSTANCE, SSM_ROOT, STACK_PREFIX, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import { SHIPPED_EVENT_WORKFLOWS, alarmWatchKey } from '../../backend/lambda/src/lib/event-workflow';
import { withWorkflowFor } from './helpers/version-under-test';
import { replacingDraft, draftIdOf } from './helpers/profile-draft';
import * as fs from 'fs';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { personApiServes, personUrl } from './helpers/api-urls';
import { sendTargetedAs } from './helpers/battle-state-backend';
import * as os from 'os';
import * as path from 'path';

/** The ops event builder `scripts/send-ops-event.mjs` sends with (CommonJS, shared with the operator script). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const opsEvent = require('../../backend/scripts/lib/ops-event.cjs') as {
  opsEventEntry: (a: { instance: string; forPerson: string; concernedChannelArn: string; topicLabel?: string; summary?: string; alarmName?: string }) => Record<string, string>;
};

const RUN = process.env.INCIDENT_WATCH_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STAMP = Date.now().toString(36);
/** Named with this deployment's stack prefix: the incident-watch rule and the router's alarm read match it. */
const WATCHED = `${STACK_PREFIX}-e2e-incident-watch-${STAMP}`;
const UNWATCHED = `${STACK_PREFIX}-e2e-unwatched-${STAMP}`;
const TOPIC = `Incident watch e2e ${STAMP}`;
/** The version's own copy of the platform's incident watch. */
const WATCH_WORKFLOW = 'e2e-incident-watch';

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

/** One resource of the premium classification stack, by logical id prefix, or '' when it is not deployed. */
function premiumResource(type: string, logicalId: RegExp): string {
  try {
    return physicalIdsInClassificationStacks({ type, logicalId })[0] || '';
  } catch {
    return '';
  }
}

/** Invoke the typed-conversation creator directly, through files so no shell sees the JSON. */
function invokeCreator(fn: string, payload: Record<string, unknown>): { ok: boolean; channelArn?: string; error?: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = path.join(os.tmpdir(), `incident-watch-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `incident-watch-out-${stamp}.json`);
  fs.writeFileSync(inFile, JSON.stringify(payload));
  awsv(['lambda', 'invoke', '--function-name', fn, '--cli-binary-format', 'raw-in-base64-out', '--payload', `fileb://${inFile}`, outFile]);
  try {
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return { ok: false, error: 'no response from the creator' };
  }
}

/** The conversation the lead is a member of whose name is `name`, or '' while there is none. */
function leadConversationNamed(leadArn: string, name: string): string {
  let next = '';
  for (let page = 0; page < 20; page += 1) {
    const r = awsv(['chime-sdk-messaging', 'list-channel-memberships-for-app-instance-user',
      '--app-instance-user-arn', leadArn, '--chime-bearer', leadArn, '--max-results', '50', ...(next ? ['--next-token', next] : [])]);
    const hit = ((r?.ChannelMemberships ?? []) as Array<{ ChannelSummary?: { Name?: string; ChannelArn?: string } }>)
      .find((m) => m.ChannelSummary?.Name === name);
    if (hit?.ChannelSummary?.ChannelArn) return hit.ChannelSummary.ChannelArn;
    next = String(r?.NextToken || '');
    if (!next) return '';
  }
  return '';
}

/** A metric alarm with no actions on a metric nothing emits; missing data keeps whatever state it was set to. */
function putAlarm(name: string): void {
  awsv(['cloudwatch', 'put-metric-alarm', '--alarm-name', name,
    '--alarm-description', 'AgentEchelon e2e: an alarm the incident-watch spec owns and deletes',
    '--namespace', 'AgentEchelon/E2E', '--metric-name', 'IncidentWatchProbe', '--statistic', 'Sum',
    '--period', '60', '--evaluation-periods', '1', '--threshold', '1',
    '--comparison-operator', 'GreaterThanOrEqualToThreshold', '--treat-missing-data', 'ignore']);
}

function setAlarmState(name: string, state: 'ALARM' | 'OK'): void {
  awsv(['cloudwatch', 'set-alarm-state', '--alarm-name', name, '--state-value', state, '--state-reason', 'AgentEchelon e2e: the incident-watch spec drives this alarm']);
}

function alarmState(name: string): string {
  const r = awsv(['cloudwatch', 'describe-alarms', '--alarm-names', name]);
  return String(r?.MetricAlarms?.[0]?.StateValue ?? '');
}

/** One row of the channel-context table by its key, read consistently, or undefined. */
function contextItem(table: string, key: string): Record<string, any> | undefined {
  const r = awsv(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ channelArn: { S: key } }), '--consistent-read']);
  return r?.Item ? unmarshalItem(r.Item) : undefined;
}

function deleteContextItem(table: string, key: string): void {
  awsv(['dynamodb', 'delete-item', '--table-name', table, '--key', JSON.stringify({ channelArn: { S: key } })]);
}

/** The words a person reads: the hidden turn markers stripped. */
const visible = (content: string) => content.replace(/<!--[\s\S]*?-->/g, '').trim();

/** The assistants' messages in the room, oldest first, each with the text a person reads. */
function assistantPosts(roomArn: string, asArn: string): Array<VisibleMessage & { text: string }> {
  return messageRowsVisibleTo(roomArn, asArn)
    .filter((m) => m.senderArn.includes('/bot/'))
    .map((m) => ({ ...m, text: visible(m.content) }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The room's `incident_first_look` tasks. */
const firstLooks = (agentTable: string, roomArn: string): TaskRow[] => channelTasks(agentTable, roomArn).filter((t) => t.taskType === 'incident_first_look');

test.describe.serial('an alarm a room watches starts its workflow (incident-watch)', () => {
  guardBackendErrors('an-alarm-a-room-watches-starts-its-workflow');

  let admin: VendedCredentials | undefined;
  let owner = '';
  let previousVersion: number | undefined;
  let creator = '';
  let contextTable = '';
  let agentTable = '';
  let appInstanceAdmin = '';
  let lead: TestUser | null = null;
  let leadArn = '';
  let teamRoom = '';
  let room = '';
  /** The ops assistant's bot: the one that reads the deployment's health, the room's primary and the owner of its workflows. */
  let opsBot = '';
  const alarmsMade: string[] = [];

  /** What returns the team's membership group to how this run found it. */
  let leaveTeamGroup: () => void = () => undefined;

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set INCIDENT_WATCH_E2E=1 to run it (validate.mjs --only=incident-watch)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is needed to give the ops assistant its version');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const opsLead = await getOpsLeadUser();
    test.skip(!opsLead, missingUserReason('opsLeadUser'));
    lead = opsLead;

    // WHAT THE ROOM NEEDS DEPLOYED, each a stated skip: the creator, the rule the ops event reaches it by, and the Ops
    // assistant the `ops` type names (a creation without it is refused, by design).
    creator = premiumResource('AWS::Lambda::Function', /^TypedConversationFromEvent/);
    test.skip(!creator, 'no premium typed-conversation creator on this deployment (no type names premium)');
    test.skip(!premiumResource('AWS::Events::Rule', /^OpensTypedConversationops0/), 'the premium stack has no rule for the ops event; deploy the classification stack that builds it (openedBy on the ops type)');
    // SKIPPED BY NAME where the ops role is not deployed: the `ops` type adds the ops assistant to the room it opens, and the
    // two health reads this spec proves are that assistant's (`as: { role: 'ops' }`), so both need `ops-premium`.
    const opsRecord = ssmValue(`${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`);
    test.skip(!opsRecord, 'premium has no ops assistant on this deployment; the ops type and its health reads need ops-premium in profiles (npm run add-assistant-role)');
    opsBot = (() => { try { return String(JSON.parse(opsRecord).botArn || ''); } catch { return ''; } })();
    expect(opsBot, 'the ops-premium assignment record names no bot').toContain('/bot/');

    // The incident watch is what this spec proves, so its rule being absent is a failure, not a skip: the `ops` type
    // declares an opener that names its alarm, which builds the rule on the premium stack.
    expect(premiumResource('AWS::Events::Rule', /^IncidentWatchAlarmChanges/), 'the premium stack has no IncidentWatchAlarmChanges rule; deploy this branch\'s classification stack').toBeTruthy();

    contextTable = ssmValue(`${SSM_ROOT}/shared/tables/channel-context-name`);
    agentTable = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    appInstanceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(contextTable, `${SSM_ROOT}/shared/tables/channel-context-name names no table`).toBeTruthy();
    expect(agentTable, `${SSM_ROOT}/shared/tables/agent-tasks-name names no table`).toBeTruthy();

    leadArn = await personArnOf(opsLead!);
    expect(leadArn, 'the ops lead has no AppInstanceUser').toContain('/user/');
    // THE ASSISTANT THAT OWNS AN OPS ROOM'S WORKFLOWS (`workflowOwner` on `ops`), whose version this run changes.
    owner = liveAssistantFor('premium', 'ops');

    const creds = await getTestCredentials();
    // THE STANDING TEAM CONVERSATION ADMITS ITS GROUP'S PEOPLE ONLY, so the lead is in that group for the run.
    leaveTeamGroup = joinMembershipGroup('ops-team', opsLead!.email, creds.cognitoUserPoolId);
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (alarmsMade.length) tryTo('delete the alarms', () => awsv(['cloudwatch', 'delete-alarms', '--alarm-names', ...alarmsMade]));
    if (contextTable) {
      for (const name of alarmsMade) tryTo(`delete the watch record of ${name}`, () => deleteContextItem(contextTable, alarmWatchKey(name)));
    }
    for (const arn of [room, teamRoom].filter(Boolean)) {
      const bearer = appInstanceAdmin || leadArn;
      tryTo(`delete the room ${arn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', arn, '--chime-bearer', bearer]));
      if (contextTable) tryTo(`delete the row of ${arn}`, () => deleteContextItem(contextTable, arn));
    }
    tryTo('return the team group', () => leaveTeamGroup());
    if (admin && previousVersion !== undefined) {
      const back = await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName: owner, version: previousVersion }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: ${owner} was not rolled back to version ${previousVersion}: ${JSON.stringify(back?.body ?? {}).slice(0, 300)}`);
    }
  });

  test('the ops assistant activates a version that runs the ops room\'s first look and the incident watch', async () => {
    test.setTimeout(180_000);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin!);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === owner)?.activeVersion ?? undefined;
    expect(previousVersion, `${owner} has no active version to return to`).toBeDefined();

    const created = await replacingDraft((b) => signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin!, 'POST', b), { profileName: owner });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    // The draft is a copy of the active version; its event workflows are kept, and only what this run needs is added:
    // `ops` conversations open with the platform's `ops-room`, and the version's one `alarm-state-changed` workflow is
    // the platform's incident watch.
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), admin!, 'POST', { profileName: owner, draft: true });
    expect(exported.status, JSON.stringify(exported.body).slice(0, 400)).toBe(200);
    const body = (exported.body?.manifest?.body ?? {}) as { eventWorkflows?: Record<string, any>; workflows?: string[] };
    const kept = Object.fromEntries(Object.entries(body.eventWorkflows ?? {}).filter(([, wf]) => wf?.on !== 'alarm-state-changed'));
    const patch: Record<string, unknown> = {
      // THE ROOM'S TYPE SELECTS ITS conversation-opened WORKFLOW (W1): the platform's ops-room, copied into the version.
      eventWorkflows: withWorkflowFor({ eventWorkflows: { ...kept, [WATCH_WORKFLOW]: JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['incident-watch'])) } },
        'ops-room', JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['ops-room']))),
      // A version that selects its task workflows offers the one its first look opens.
      ...(Array.isArray(body.workflows) && body.workflows.length && !body.workflows.includes('incident_first_look')
        ? { workflows: [...body.workflows, 'incident_first_look'] } : {}),
    };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin!, 'POST', { profileName: owner, patch, configId: draftIdOf(created) });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
    const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin!, 'POST', { profileName: owner });
    expect(valid.body?.errors ?? [], JSON.stringify(valid.body).slice(0, 600)).toEqual([]);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin!, 'POST', { profileName: owner, configId: draftIdOf(edited) });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);

    // The alarms exist before any room watches them, so the state they are created in starts nothing.
    for (const name of [WATCHED, UNWATCHED]) {
      putAlarm(name);
      alarmsMade.push(name);
    }
    expect(alarmState(WATCHED), 'a new alarm on a metric nothing emits has no data').toBe('INSUFFICIENT_DATA');
  });

  test('an ops event naming the alarm opens an ops room that watches it, and its first look opens an incident_first_look task', async () => {
    test.setTimeout(420_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    // The served version is cached for 30 seconds.
    await sleep(35_000);

    // The room the event concerns: the operations team's standing room, which the platform opens directly.
    const team = invokeCreator(creator, { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: `Incident watch e2e team ${STAMP}` });
    expect(team.ok, `the standing room was refused: ${team.error}`).toBe(true);
    teamRoom = team.channelArn!;

    // THE STEP: the ops event, as send-ops-event.mjs --alarm puts it.
    const entry = opsEvent.opsEventEntry({
      instance: INSTANCE, forPerson: lead!.email, concernedChannelArn: teamRoom,
      topicLabel: TOPIC, summary: 'Report generation is running slow.', alarmName: WATCHED,
    });
    const put = awsv(['events', 'put-events', '--entries', JSON.stringify([entry])]);
    expect(put?.FailedEntryCount ?? 1, `the bus refused the ops event: ${JSON.stringify(put?.Entries)}`).toBe(0);

    room = await pollFor(() => leadConversationNamed(leadArn, TOPIC), (arn) => Boolean(arn), { timeoutMs: 180_000, intervalMs: 5_000 });
    expect(room, `no conversation named "${TOPIC}" opened for the lead within 180s; read the TypedConversationFromEvent log for a refusal`).toBeTruthy();

    // THE ROOM AND ITS WATCH, from the records the router reads: the room's own row and the alarm's watch record.
    const tags = (awsv(['chime-sdk-messaging', 'list-tags-for-resource', '--resource-arn', room])?.Tags ?? []) as Array<{ Key: string; Value: string }>;
    expect(tags.find((t) => t.Key === 'classification')?.Value, 'the room is at the classification the stack was deployed with').toBe('premium');
    const row = contextItem(contextTable, room);
    expect(row?.conversationType, 'the room\'s row records its type').toBe('ops');
    expect(row?.watchedAlarm, 'the room\'s row records the alarm it watches').toBe(WATCHED);
    const watch = contextItem(contextTable, alarmWatchKey(WATCHED));
    expect({ room: watch?.room, classification: watch?.classification }, 'the alarm\'s watch record names the room').toEqual({ room, classification: 'premium' });

    // THE FIRST LOOK: the opening is posted, and the task the step opened rests on its findings once the turn posted.
    const task = await pollFor(() => firstLooks(agentTable, room)[0], (t) => t?.taskState === 'findings_shared', { timeoutMs: 180_000, intervalMs: 5_000 });
    expect(task, 'no incident_first_look task opened in the room').toBeTruthy();
    expect(task!.taskState, `the first look did not reach findings_shared; edges: ${JSON.stringify(graphEdges(task))}`).toBe('findings_shared');
    expect(hasEdge(task, 'reading_health', 'findings_shared'), 'the first step\'s one transition was taken').toBe(true);
    // A TASK AN EVENT OPENS IS THE ASSISTANT'S, VISIBLE TO THE ROOM (ADR-061 decision 8), in the row's own fields
    // (ADR-024 D8): it has no requester, so no person owns it (`ownerPersonId` absent); the ops assistant that ran the
    // step holds the work (`assigneeType`, `assigneeId`) and is the assistant it belongs to (`assistantId`). The Tasks
    // console reads the same `assigneeType` and `assigneeId` through the task service.
    const opsBotId = opsBot.split('/bot/')[1];
    expect(
      { assigneeType: task!.assigneeType, assigneeId: task!.assigneeId, assistantId: task!.assistantId, ownerPersonId: task!.ownerPersonId, visibility: task!.visibility },
      'a task an event opens is the assistant\'s, visible to the room',
    ).toEqual({ assigneeType: 'assistant', assigneeId: opsBotId, assistantId: opsBotId, ownerPersonId: undefined, visibility: 'conversation' });
    expect(firstLooks(agentTable, room).length, 'one first look per run').toBe(1);
    const openingOf = (ps: ReturnType<typeof assistantPosts>) => ps.find((m) => m.text.includes(`This conversation is for ${TOPIC}`));
    // THE FIRST LOOK IS THE OPS ASSISTANT'S ANSWER ON ITS `incident_first_look` TASK, read by that task's marker: the run also
    // posts the opening and greets the lead between, and neither is the first look.
    const lookOf = (ps: ReturnType<typeof assistantPosts>) => {
      const o = openingOf(ps);
      return o ? ps.find((m) => m.messageId !== o.messageId && m.senderArn === opsBot && Date.parse(m.createdAt) >= Date.parse(o.createdAt)
        && m.content.includes('incident_first_look') && m.text && !looksLikeTaskPlaceholder(m.text)) : undefined;
    };
    const posts = await pollFor(() => assistantPosts(room, leadArn), (ps) => Boolean(lookOf(ps)), { timeoutMs: 60_000, intervalMs: 5_000 });
    const opening = openingOf(posts);
    expect(opening, `the ops room's opening was not posted; seen ${JSON.stringify(posts.map((m) => m.text.slice(0, 120)))}`).toBeTruthy();
    // THE ROOM'S WORKFLOWS ARE THE OPS ASSISTANT'S (ADR-061 decision 2): it posts the opening as the room's primary and the
    // owner of its workflows, and the health read on its own session, which alone holds the deployment's telemetry.
    expect(opening!.senderArn, 'the opening is the ops assistant\'s').toBe(opsBot);
    const look = lookOf(posts);
    expect(look, `the ops assistant posted no first look; seen ${JSON.stringify(posts.map((m) => [m.senderArn.split('/bot/')[1], m.text.slice(0, 120)]))}`).toBeTruthy();
    // WHAT THE ROOM ACTUALLY READS, IN FULL, as its lead sees it through the API, so a run's replies are read and not only counted.
    console.log(`[what the room reads] the first look:\n${posts.map((m) => `--- ${m.senderArn === opsBot ? 'Ops' : 'another assistant'}\n${m.text}`).join('\n')}`);
    // THE FIRST LOOK REPORTS THE HEALTH IT READ: figures, not a line about standing by, which is what a turn that took its own
    // automatic move ended on.
    expect(look!.text, 'the first look reports what it read').toMatch(/\d/);
    expect(look!.text, 'the first look reports what it read').not.toMatch(/standing by/i);
    expect(posts.some((m) => m.text.includes('No ops assistant is in this conversation')), 'the room was told no ops assistant is here, with one in it').toBe(false);
  });

  test('a state change on the watched alarm runs the room\'s incident watch, and one on an alarm no room watches posts nothing', async () => {
    test.setTimeout(420_000);
    test.skip(!room, 'no room opened');
    expect(contextItem(contextTable, alarmWatchKey(UNWATCHED)), 'no room watches the second alarm').toBeUndefined();

    // The unwatched change goes first, so by the time the watched one has run, the unwatched one has had longer.
    const unwatchedAt = Date.now();
    expectAlarm(UNWATCHED);
    expectAlarm(WATCHED);
    setAlarmState(UNWATCHED, 'ALARM');
    const since = Date.now() - 2_000;
    setAlarmState(WATCHED, 'ALARM');
    expect(alarmState(WATCHED), 'the alarm keeps the state the test set').toBe('ALARM');

    // THE WATCH POSTS: the state it entered, and then what the re-read found, each as an assistant of the room.
    const announced = (ps: ReturnType<typeof assistantPosts>) => ps.find((m) => Date.parse(m.createdAt) >= since && m.text.includes(WATCHED) && m.text.includes('is now ALARM'));
    const reread = (ps: ReturnType<typeof assistantPosts>) => {
      const a = announced(ps);
      // Both are the ops assistant's: it announces the state, refreshes the dashboard, and reads the health again. The re-read
      // is its next post after the announcement that is not the dashboard refresh's, which its Metadata names (`"dashboard"`);
      // a one-shot ask settles in its own turn, so its answer need not carry the task's marker.
      return a ? ps.find((m) => m.messageId !== a.messageId && m.senderArn === opsBot && Date.parse(m.createdAt) >= Date.parse(a.createdAt)
        && !m.metadata.includes('"dashboard"') && m.text && !looksLikeTaskPlaceholder(m.text)) : undefined;
    };
    const posts = await pollFor(() => assistantPosts(room, leadArn), (ps) => Boolean(announced(ps) && reread(ps)), { timeoutMs: 240_000, intervalMs: 5_000 });
    const seen = JSON.stringify(posts.filter((m) => Date.parse(m.createdAt) >= since).map((m) => m.text.slice(0, 160)));
    expect(announced(posts), `the incident watch did not announce the state; seen since the change ${seen}`).toBeTruthy();
    expect(reread(posts), `the incident watch did not post its re-read; seen since the change ${seen}`).toBeTruthy();
    // WHAT THE ROOM ACTUALLY READS, IN FULL.
    console.log(`[what the room reads] the alarm changed:\nannounce: ${announced(posts)!.text}\nre-read:\n${reread(posts)!.text}`);
    // The run keyed by the alarm's change opens no task of its own: the room still holds its one first look.
    expect(firstLooks(agentTable, room).length, 'the incident watch opens no second first look').toBe(1);

    // THE UNWATCHED ALARM: its change has had a minute, and the room says nothing about it and no record names it.
    const settle = unwatchedAt + 60_000 - Date.now();
    if (settle > 0) await sleep(settle);
    expect(alarmState(UNWATCHED), 'the unwatched alarm kept the state the test set').toBe('ALARM');
    const mentions = assistantPosts(room, leadArn).filter((m) => m.text.includes(UNWATCHED));
    expect(mentions.map((m) => m.text.slice(0, 160)), 'a change on an alarm no room watches posted in the room').toEqual([]);
    expect(contextItem(contextTable, alarmWatchKey(UNWATCHED)), 'no room came to watch the second alarm').toBeUndefined();
  });

  // ── THE ROOM'S DASHBOARD (DESIGN-CONVERSATION-DASHBOARDS) ─────────────────────────────────────────────────────────────────
  /** An S3 GET signed with the given credentials, as the chat app signs it with the member's own session. */
  const s3Get = async (loc: { bucket: string; key: string; region: string }, c: Record<string, string>) => {
    const host = `${loc.bucket}.s3.${loc.region}.amazonaws.com`;
    const signer = new SignatureV4({ credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, region: loc.region, service: 's3', sha256: Sha256 });
    const req = await signer.sign(new HttpRequest({ method: 'GET', protocol: 'https:', hostname: host, path: `/${loc.key}`, headers: { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } }));
    const res = await fetch(`https://${host}/${loc.key}`, { headers: req.headers as Record<string, string> });
    return { status: res.status, text: await res.text() };
  };
  const dashboardMessages = (kind: 'snapshot' | 'page') => messageRowsVisibleTo(room, leadArn)
    .filter((m) => m.senderArn === opsBot && m.metadata.includes('"dashboard"') && m.metadata.includes(`"kind":"${kind}"`));
  const leadToken = async () => { const creds = await getTestCredentials(); return idTokenFor(lead!.email, lead!.password, creds.cognitoClientId); };

  test('the watch refreshes the room\'s dashboard as the ops assistant, and a member reads it as themselves', async () => {
    test.setTimeout(300_000);
    test.skip(!room, 'no room opened');
    // THE REQUIRED REFRESH: the alarm change above ran `refresh`, which asked Ops for `dashboard_refresh`, whose step publishes.
    const msgs = await pollFor(() => dashboardMessages('snapshot'), (ms) => ms.length > 0, { timeoutMs: 180_000, intervalMs: 5_000 });
    expect(msgs.length, 'the ops assistant posted no dashboard message in the room').toBe(1);
    const roomId = room.split('/').pop()!;
    const key = `dashboards/premium/${roomId}/snapshot.json`;

    // A MEMBER'S OWN CREDENTIAL, FOR THIS ONE CONVERSATION, after the exchange's membership check.
    const vend = await exchange(await leadToken(), { channelArn: room, capabilities: ['dashboard'] });
    expect(vend.status, JSON.stringify(vend.body).slice(0, 300)).toBe(200);
    expect(vend.body?.dashboard?.key, 'the vend names the one snapshot it reads').toBe(key);
    const read = await s3Get(vend.body.dashboard, vend.body.credentials);
    expect(read.status, read.text.slice(0, 300)).toBe(200);
    const snap = JSON.parse(read.text) as { html: string; state?: string; conversationId: string };
    expect(snap.conversationId).toBe(roomId);
    expect(snap.html, 'the dashboard shows the alarm it watches').toContain(WATCHED);
    expect(snap.html, 'the dashboard runs no script').not.toMatch(/<script/i);
    console.log(`[what the room reads] the dashboard snapshot: state ${snap.state}, ${snap.html.length} characters of markup`);

    // DENY: the same credential reads no other conversation's dashboard at the same classification.
    if (teamRoom) {
      const other = await s3Get({ ...vend.body.dashboard, key: `dashboards/premium/${teamRoom.split('/').pop()}/snapshot.json` }, vend.body.credentials);
      expect(other.status, 'a member\'s dashboard credential reads another conversation\'s dashboard').toBe(403);
    }
    // DENY: a person at the same classification who is not in the room is refused the credential.
    const creds = await getTestCredentials();
    const outsider = creds.secondPremiumUser ?? creds.premiumUser;
    const refused = await exchange(idTokenFor(outsider.email, outsider.password, creds.cognitoClientId), { channelArn: room, capabilities: ['dashboard'] });
    expect(refused.status, `a non-member was vended a dashboard read: ${JSON.stringify(refused.body).slice(0, 200)}`).toBe(403);
    expect(refused.body?.code).toBe('NOT_A_MEMBER');
  });

  test('the page the ops assistant publishes on request opens on a member\'s signed link, and on nothing else', async () => {
    test.setTimeout(300_000);
    test.skip(!personApiServes('dashboard-pages'), 'PersonApi does not serve the dashboard-pages capability, whose route the link is (/dashboard-link)');
    test.skip(!room, 'no room opened');
    sendTargetedAs(room.split('/').pop()!, leadArn, opsBot, 'Publish this room\'s dashboard as a page I can put on the wall screen.');
    const pages = await pollFor(() => dashboardMessages('page'), (ms) => ms.length > 0, { timeoutMs: 180_000, intervalMs: 5_000 });
    expect(pages.length, 'the ops assistant published no dashboard page').toBe(1);

    const link = await fetch(personUrl('/dashboard-link'), {
      method: 'POST', headers: { Authorization: `Bearer ${await leadToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: room.split('/').pop() }),
    });
    const body = await link.json() as { url?: string };
    expect(link.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    const page = await fetch(body.url!);
    const html = await page.text();
    expect(page.status, html.slice(0, 300)).toBe(200);
    expect(html).toContain(WATCHED);
    expect(html).not.toMatch(/<script/i);
    expect(page.headers.get('content-security-policy') ?? '', 'the edge repeats the page\'s policy').toMatch(/default-src 'none'/);

    // DENY: the page without its signature, and a link asked for by someone outside the room.
    const unsigned = await fetch(body.url!.split('?')[0]);
    expect(unsigned.status, 'the page opened without a signed link').toBe(403);
    const creds = await getTestCredentials();
    const outsider = creds.secondPremiumUser ?? creds.premiumUser;
    const refused = await fetch(personUrl('/dashboard-link'), {
      method: 'POST', headers: { Authorization: `Bearer ${idTokenFor(outsider.email, outsider.password, creds.cognitoClientId)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: room.split('/').pop() }),
    });
    expect(refused.status, 'a non-member was signed a dashboard link').toBe(403);
  });

  // THE RUN, READ BACK THROUGH THE CONSOLE'S OWN ANALYTICS (WT118), as the team owning each assistant reads it: each declared
  // intent is measured under its owner, with what started it as the breakdown. Waits out archival lag, in short polls.
  test('the console\'s analytics show the run, each intent under what started it', async () => {
    test.setTimeout(420_000);
    test.skip(!room, 'no room opened');
    const query = async (path: string, body: Record<string, unknown>) => {
      const res = await signedCall(path, admin!, 'POST', body);
      expect(res.status, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(200);
      return ((res.body as { data?: Array<Record<string, unknown>> })?.data ?? []);
    };
    const triggers = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.dimension === 'trigger').map((r) => ({
      workflow: r.workflow_name, startedBy: r.workflow_trigger, runs: r.runs, ended: r.ended, success: r.success_share, avgMs: r.avg_ms,
    }));
    const asked = (rows: Array<Record<string, unknown>>, intent: string) => triggers(rows).find((r) => r.workflow === intent && r.startedBy === 'assistant');
    const rows = await pollFor(() => query(adminUrl('analytics', '/'), { queryType: 'workflow_editions' }), (r) => Boolean(asked(r, 'incident_first_look') && Number(asked(r, 'deployment_health')?.ended ?? 0) > 0), { timeoutMs: 300_000, intervalMs: 15_000 });
    console.log(`[what the console shows] Workflow editions, started by:\n${JSON.stringify(triggers(rows), null, 1)}`);
    const events = await query(adminUrl('analytics', '/events-log'), { queryType: 'channel_events', channelArn: room }).catch((err) => { console.warn(`events: ${(err as Error).message.slice(0, 200)}`); return []; });
    console.log(`[what the console shows] the room's events, in order:\n${events.map((e) => `--- ${String(e.event_type ?? '')} ${String(e.sender_name ?? e.assistant ?? '')}\n${String(e.content ?? '').slice(0, 1500)}`).join('\n')}`);
    expect(asked(rows, 'incident_first_look'), 'Ops\'s first look is measured under its own intent, started by another assistant').toBeTruthy();
    expect(asked(rows, 'deployment_health'), 'Ops\'s re-read is measured under its own intent, started by another assistant').toBeTruthy();
    // A ONE-TURN ANSWER ENDS ITS RUN: the owning team reads that it ended, how it went and how long it took. (A first look rests
    // open until someone resolves it, so it has not ended.)
    expect(asked(rows, 'deployment_health')?.ended, 'the asked turn recorded its run\'s end').toBeGreaterThan(0);
    expect(asked(rows, 'deployment_health')?.success, 'the asked turn ended in success').toBeGreaterThan(0);
    expect(asked(rows, 'deployment_health')?.avgMs, 'the asked turn recorded how long it took').toBeGreaterThan(0);
  });
});
