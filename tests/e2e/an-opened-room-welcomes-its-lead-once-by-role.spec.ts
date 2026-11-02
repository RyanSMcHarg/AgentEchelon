/**
 * A ROOM AN EVENT OPENS WELCOMES ITS LEAD ONCE, FROM ITS `conversation-opened` RUN, AND A SEND ADDRESSED TO A PARTICIPANT
 * ROLE REACHES THAT ROLE'S HOLDERS ONLY (ADR-061 decision 3, decision 5's welcome table and decision 9's `workflow`
 * mode; DESIGN-CONVERSATION-TYPES section 6.1), against the deployed stacks.
 *
 * The unit suites prove each half with the code's own functions (`a-person-is-welcomed-once-per-arrival`,
 * `a-participant-role-is-declared-held-and-addressed`, `an-event-starts-a-workflow`). What only a deployment proves is
 * the path end to end:
 *  - the premium creator opens an `ops` room for the lead it is named, records the lead as the holder of `lead` on the
 *    room's context row, and names `conversation-opened` to the router;
 *  - the primary's version welcomes `ops` rooms in `workflow` mode, so the router runs the platform's `ops-room`, and the
 *    primary's own join posts nothing: every message the primary posts in the room is a step of that run;
 *  - the run's `greet-lead` step, a send to `{ participantRole: 'lead' }`, is addressed to the lead alone and is absent
 *    from the view of a member who holds no role but the default `responder`;
 *  - the lead is welcomed once.
 *
 * SETTLED BEFORE IT IS READ. The run's last step is the first look, taken by the room's ops assistant; every assertion
 * reads the room once a message of that step is posted, its output or its fallback, so the run has ended and the
 * primary's join, which fires when the room is created, has long since answered.
 *
 * THE RUN OWNS WHAT IT CHANGES. The primary gets a version whose welcome runs the platform's `ops-room` for `ops`
 * conversations; the version that was active is activated again afterwards. Both rooms it opens, the operations team's
 * standing room and the `ops` room, are deleted with their context rows.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/an-opened-room-welcomes-its-lead-once-by-role.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsEngineerUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { unmarshalItem } from './helpers/task-backend';
import { SSM_ROOT, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, withWorkflowFor } from './helpers/version-under-test';
import { PLATFORM_EVENT_WORKFLOWS } from '../../backend/lambda/src/lib/event-workflow';
import { isJoinGreeting, isWelcomeTo, roomMessagesSeenBy, stepOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const STAMP = Date.now().toString(36);
const TOPIC = `Lead welcome e2e ${STAMP}`;

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

/** The bot an assistant's assignment record names, or ''. */
function botOf(record: string): string {
  try { return String(JSON.parse(record).botArn || ''); } catch { return ''; }
}

/** Invoke the typed-conversation creator directly, through files so no shell sees the JSON. */
function invokeCreator(fn: string, payload: Record<string, unknown>): { ok: boolean; channelArn?: string; error?: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inFile = path.join(os.tmpdir(), `lead-welcome-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `lead-welcome-out-${stamp}.json`);
  fs.writeFileSync(inFile, JSON.stringify(payload));
  awsv(['lambda', 'invoke', '--function-name', fn, '--cli-binary-format', 'raw-in-base64-out', '--payload', `fileb://${inFile}`, outFile]);
  try {
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return { ok: false, error: 'no response from the creator' };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

/** The people in a room, read as a member. */
function peopleIn(channelArn: string, asArn: string): string[] {
  const r = awsv(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn, '--chime-bearer', asArn, '--max-results', '50']);
  return ((r?.ChannelMemberships ?? []) as any[]).map((m) => String(m?.Member?.Arn || '')).filter((a) => a.includes('/user/'));
}

test.describe.serial('a room an event opens welcomes its lead once, by role (welcome-workflows)', () => {
  guardBackendErrors('an-opened-room-welcomes-its-lead-once-by-role');

  let admin: VendedCredentials | undefined;
  let primary = '';
  let primaryBot = '';
  let previousVersion: number | undefined;
  let creator = '';
  let contextTable = '';
  let serviceAdmin = '';
  let leadArn = '';
  let responderArn = '';
  let teamRoom = '';
  let room = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set WELCOME_WORKFLOWS_E2E=1 to run it (validate.mjs --only=welcome-workflows)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is needed to give the room\'s primary its version');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const lead = await getOpsLeadUser();
    test.skip(!lead, missingUserReason('opsLeadUser'));
    const responder = await getOpsEngineerUser();
    test.skip(!responder, missingUserReason('opsEngineerUser'));

    // WHAT THE ROOM NEEDS DEPLOYED, each a stated skip: the creator, and the ops assistant the `ops` type names (a
    // creation without it is refused, by design), whose first look is the run's last step.
    try {
      creator = physicalIdsInClassificationStacks({ type: 'AWS::Lambda::Function', logicalId: /^TypedConversationFromEvent/ })[0] || '';
    } catch {
      creator = '';
    }
    test.skip(!creator, 'no premium typed-conversation creator on this deployment (no type names premium)');
    test.skip(!ssmValue(`${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`),
      'premium has no ops assistant on this deployment; the ops type needs ops-premium in profiles (npm run add-assistant-role)');

    primary = liveAssistantFor('premium');
    primaryBot = botOf(ssmValue(`${SSM_ROOT}/assistant-assignments/premium/primary/assistants/${primary}`));
    expect(primaryBot, `the assignment record of ${primary} names no bot`).toContain('/bot/');
    contextTable = ssmValue(`${SSM_ROOT}/shared/tables/channel-context-name`);
    serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(contextTable, `${SSM_ROOT}/shared/tables/channel-context-name names no table`).toBeTruthy();

    leadArn = await personArnOf(lead!);
    responderArn = await personArnOf(responder!);
    expect(leadArn, 'the ops lead has no AppInstanceUser').toContain('/user/');
    expect(responderArn, 'the ops engineer has no AppInstanceUser').toContain('/user/');

    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    if (admin && previousVersion !== undefined) await returnToVersion(admin, primary, previousVersion);
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    for (const arn of [room, teamRoom].filter(Boolean)) {
      tryTo(`delete the room ${arn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', arn, '--chime-bearer', serviceAdmin || leadArn]));
      if (contextTable) tryTo(`delete the row of ${arn}`, () => awsv(['dynamodb', 'delete-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: arn } })]));
    }
  });

  test('the primary activates a version whose ops conversations open with ops-room', async () => {
    test.setTimeout(180_000);
    previousVersion = await activateVersionWith(admin!, primary, (body) => ({
      // THE ROOM'S TYPE SELECTS ITS conversation-opened WORKFLOW (W1): the platform's ops-room, copied into the version.
      eventWorkflows: withWorkflowFor(body, 'ops-room', JSON.parse(JSON.stringify(PLATFORM_EVENT_WORKFLOWS['ops-room']))),
      // A version that selects its task workflows offers the one the first look opens.
      ...(Array.isArray(body.workflows) && body.workflows.length && !body.workflows.includes('incident_first_look')
        ? { workflows: [...body.workflows, 'incident_first_look'] } : {}),
    }));
  });

  test('the opened room\'s run welcomes the lead once, by role, and the primary\'s join posts nothing', async () => {
    test.setTimeout(420_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    await new Promise((r) => setTimeout(r, SERVED_VERSION_TTL_MS));

    const team = invokeCreator(creator, { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: `Lead welcome e2e team ${STAMP}` });
    expect(team.ok, `the standing room was refused: ${team.error}`).toBe(true);
    teamRoom = team.channelArn!;
    // THE STEP: an `ops` room opened for the lead, concerning the team's room, as the platform's ops event opens one.
    const opened = invokeCreator(creator, {
      detail: { conversationType: 'ops', concernedChannelArn: teamRoom, forUserArn: leadArn, topicLabel: TOPIC, summary: 'Report generation is running slow.' },
    });
    expect(opened.ok, `the ops room was refused: ${opened.error}`).toBe(true);
    room = opened.channelArn!;

    // THE HOLDINGS THE ROUTER READS: the lead holds `lead` on the room's context row, and the responder is a member who
    // holds nothing a source names. A responder outside the room would leave nobody to be denied the role's message.
    const row = awsv(['dynamodb', 'get-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: room } }), '--consistent-read'])?.Item;
    const holdings = JSON.stringify(row ? unmarshalItem(row).participantRoles ?? {} : {});
    expect(holdings, 'the room\'s row records the lead as the holder of lead').toContain(leadArn.split('/user/')[1]);
    const people = peopleIn(room, leadArn);
    test.skip(!people.includes(responderArn), 'the ops engineer is not in the ops group, so the room holds no member without the lead role (provision-test-users --only opsEngineerUser)');
    expect(holdings, 'the responder holds no role a source names').not.toContain(responderArn.split('/user/')[1]);

    // SETTLED: the run's last step, the first look, has posted its output or its fallback.
    const lastStep = (ms: RoomMessage[]) => ms.find((m) => stepOf(m) === 'first-look');
    const seenByLead = await roomMessagesUntil(room, leadArn, (ms) => Boolean(lastStep(ms)), { timeoutMs: 300_000 });
    const brief = (ms: RoomMessage[]) => JSON.stringify(ms.filter((m) => m.senderArn.includes('/bot/')).map((m) => ({ step: stepOf(m), to: m.target.length, text: m.text.slice(0, 80) })));
    expect(lastStep(seenByLead), `the ops-room run never reached its first look; seen ${brief(seenByLead)}`).toBeTruthy();
    const seenByResponder = roomMessagesSeenBy(room, responderArn);

    // THE OPENING IS THE ROOM'S, and both members read it.
    const opening = seenByLead.filter((m) => stepOf(m) === 'opening');
    expect(opening.length, `one opening; seen ${brief(seenByLead)}`).toBe(1);
    expect(opening[0].target, 'the opening is posted to the room').toEqual([]);
    expect(seenByResponder.some((m) => m.messageId === opening[0].messageId), 'the responder reads the room\'s opening').toBe(true);

    // THE ROLE-ADDRESSED SEND: the lead holds `lead`, so the lead alone receives it; the responder's view does not hold it.
    const greet = seenByLead.filter((m) => stepOf(m) === 'greet-lead');
    expect(greet.length, `one greeting to the lead; seen ${brief(seenByLead)}`).toBe(1);
    expect(greet[0].target, 'a send to participantRole lead is addressed to the role\'s holders').toEqual([leadArn]);
    expect(greet[0].senderArn, 'the greeting is the primary\'s').toBe(primaryBot);
    expect(seenByResponder.some((m) => m.messageId === greet[0].messageId), 'a member who does not hold lead does not receive the role\'s message').toBe(false);
    expect(seenByResponder.some((m) => stepOf(m) === 'greet-lead'), 'no greet-lead message reaches the responder in any form').toBe(false);

    // THE LEAD IS WELCOMED ONCE: the run's greeting, and no join greeting or memberWelcome beside it.
    expect(seenByLead.filter((m) => isWelcomeTo(m, leadArn)).map((m) => ({ step: stepOf(m), kind: m.meta?.turnKind ?? '', text: m.text.slice(0, 80) })),
      'the lead is welcomed by the run alone').toEqual([{ step: 'greet-lead', kind: 'notification', text: greet[0].text.slice(0, 80) }]);

    // THE PRIMARY'S JOIN POSTS NOTHING: no greeting of the primary's join is in the room, and whatever the primary posted
    // that the lead reads is a step of the run, or the room's line that somebody joined.
    expect(seenByLead.filter((m) => m.senderArn === primaryBot && isJoinGreeting(m)).map((m) => m.text.slice(0, 120)),
      'the primary\'s WelcomeIntent posted in a room its conversation-opened run owns').toEqual([]);
    const offRun = seenByLead.filter((m) => m.senderArn === primaryBot && !stepOf(m) && m.meta?.systemAnnouncement !== 'member_joined');
    expect(offRun.map((m) => ({ kind: m.meta?.turnKind ?? '', text: m.text.slice(0, 120) })), 'the primary posted outside its conversation-opened run').toEqual([]);
  });
});
