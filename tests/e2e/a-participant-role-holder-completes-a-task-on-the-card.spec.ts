/**
 * A TASK STEP ADDRESSED TO A PARTICIPANT ROLE IS COMPLETED ON ITS CARD BY THAT ROLE'S HOLDER (ADR-063 slice T6, decision 1's
 * `for` and `by` as `{ participantRole: <name> }`, decision B1's one holder), against the deployed profile API, the
 * typed-conversation creator, the router, the task service and the person API.
 *
 * `a-workflow-step-opens-a-task-for-a-person.spec.ts` proves the card for the conversation's subject (T1 to T3). What this
 * proves is the same task reached through a role instead of the subject:
 *  - the primary's version opens `ops` rooms with its own `conversation-opened` workflow, whose task step opens an
 *    `approval` for and worked by `{ participantRole: 'lead' }`; the workflow names `ops`, the one type that gives `lead`
 *    one holder, so it validates and activates;
 *  - the creator opens an `ops` room for the lead and records the lead as the holder of `lead`; the responder is a member
 *    who holds no role a source names;
 *  - the lead alone is told, privately, with the card on the message's Metadata, and the task is in the lead's open work
 *    and not in the responder's;
 *  - the responder's press is refused as not theirs, and the task stays open;
 *  - the lead approves on the card, the run takes the `approved` edge and posts its next send, and a second press is
 *    refused as settled.
 *
 * WHY AN `ops` ROOM. A task names a participant role only where every type the workflow declares gives it one holder, and
 * `ops` is the one registered type that does (`lead`, `holders: 'one'`). Creating an `ops` room is refused where the
 * deployment declares no ops assistant, so this spec needs `ops-premium` in `profiles`, as the welcome-workflows role
 * specs do, and skips with that reason where it is absent.
 *
 * THE RUN OWNS WHAT IT CHANGES. The primary gets a version whose `conversation-opened` workflow answers for `ops` rooms;
 * the version that was active is activated again afterwards. Both rooms it opens, the operations team's standing room and
 * the `ops` room, are deleted with their context rows.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with `E2E_WORKFLOW_TASKS=1`
 * (validate.mjs --only=workflow-tasks). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/a-participant-role-holder-completes-a-task-on-the-card.spec.ts`
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsEngineerUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { unmarshalItem } from './helpers/task-backend';
import { SSM_ROOT, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, withWorkflowFor } from './helpers/version-under-test';
import { messagesSeenBy, openWorkOf, pressCard, waitFor } from './helpers/workflow-task';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.E2E_WORKFLOW_TASKS === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const STAMP = Date.now().toString(36);
const TOPIC = `Role task e2e ${STAMP}`;
const WORKFLOW = 'e2e-ops-lead-approval';
const LEAD = { participantRole: 'lead' };

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
  const inFile = path.join(os.tmpdir(), `role-task-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `role-task-out-${stamp}.json`);
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

test.describe.serial('a task step addressed to a participant role is completed on its card by the role\'s holder (workflow-tasks)', () => {
  guardBackendErrors('a-participant-role-holder-completes-a-task-on-the-card');

  let admin: VendedCredentials | undefined;
  let primary = '';
  let primaryBot = '';
  let previousVersion: number | undefined;
  let creator = '';
  let contextTable = '';
  let serviceAdmin = '';
  let leadArn = '';
  let responderArn = '';
  let leadToken = '';
  let responderToken = '';
  let teamRoom = '';
  let room = '';
  let card: { id: string; state: string; choices: string[] } | undefined;

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set E2E_WORKFLOW_TASKS=1 to run it (validate.mjs --only=workflow-tasks)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const lead = await getOpsLeadUser();
    test.skip(!lead?.password, missingUserReason('opsLeadUser'));
    const responder = await getOpsEngineerUser();
    test.skip(!responder?.password, missingUserReason('opsEngineerUser'));

    // WHAT THE ROOM NEEDS DEPLOYED, each a stated skip: the creator, and the ops assistant the `ops` type names (a
    // creation without it is refused, by design).
    try {
      creator = physicalIdsInClassificationStacks({ type: 'AWS::Lambda::Function', logicalId: /^TypedConversationFromEvent/ })[0] || '';
    } catch {
      creator = '';
    }
    test.skip(!creator, 'no premium typed-conversation creator on this deployment (no type names premium)');
    test.skip(!ssmValue(`${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`),
      'premium has no ops assistant on this deployment; the ops type, the one type giving lead one holder, needs ops-premium in profiles (npm run add-assistant-role)');

    primary = liveAssistantFor('premium');
    primaryBot = botOf(ssmValue(`${SSM_ROOT}/assistant-assignments/premium/primary/assistants/${primary}`));
    expect(primaryBot, `the assignment record of ${primary} names no bot`).toContain('/bot/');
    contextTable = ssmValue(`${SSM_ROOT}/shared/tables/channel-context-name`);
    serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(contextTable, `${SSM_ROOT}/shared/tables/channel-context-name names no table`).toBeTruthy();

    const creds = await getTestCredentials();
    leadArn = await personArnOf(lead!);
    responderArn = await personArnOf(responder!);
    expect(leadArn, 'the ops lead has no AppInstanceUser').toContain('/user/');
    expect(responderArn, 'the ops engineer has no AppInstanceUser').toContain('/user/');
    leadToken = idTokenFor(lead!.email, lead!.password, creds.cognitoClientId);
    responderToken = idTokenFor(responder!.email, responder!.password, creds.cognitoClientId);

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

  test('the primary activates a version whose ops opening runs an approval for and by the lead role', async () => {
    test.setTimeout(180_000);
    previousVersion = await activateVersionWith(admin!, primary, (body) => ({
      // THE ROOM'S TYPE SELECTS ITS conversation-opened WORKFLOW (W1): this one, for ops, where lead has one holder.
      eventWorkflows: withWorkflowFor(body, WORKFLOW, {
        on: 'conversation-opened',
        types: ['ops'],
        initial: 'opening',
        states: {
          opening: { send: { to: 'room', template: 'ops-room-opening', mention: { lead: 'participantRole:lead' } }, onSuccess: 'review', onFailure: 'review' },
          // THE STEP UNDER TEST: an approval the lead role asks for and decides.
          review: {
            task: { machine: 'approval', for: LEAD, by: LEAD, visibility: 'private', deadline: { afterMinutes: 60 } },
            onSuccess: [{ to: 'thanks', when: { 'task:state': 'approved' } }, { to: 'done' }],
            onFailure: 'done',
          },
          thanks: { send: { to: LEAD, template: 'ops-lead-welcome' }, onSuccess: 'done', onFailure: 'done' },
          done: { disposition: 'success' },
        },
      }),
      // A version that selects its task workflows offers the machine the step opens.
      ...(Array.isArray(body.workflows) && body.workflows.length && !body.workflows.includes('approval')
        ? { workflows: [...body.workflows, 'approval'] } : {}),
    }));
  });

  test('the lead alone is told privately with the card and owns the task; the responder is told nothing', async () => {
    test.setTimeout(420_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    // A cache expiring raises no event: the run is silent by design until it has.
    declareWait('the served version reaching every container', Date.now() + SERVED_VERSION_TTL_MS);
    await new Promise((r) => setTimeout(r, SERVED_VERSION_TTL_MS));

    const team = invokeCreator(creator, { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: `Role task e2e team ${STAMP}` });
    expect(team.ok, `the standing room was refused: ${team.error}`).toBe(true);
    teamRoom = team.channelArn!;
    const opened = invokeCreator(creator, {
      detail: { conversationType: 'ops', concernedChannelArn: teamRoom, forUserArn: leadArn, topicLabel: TOPIC, summary: 'A change needs the lead\'s approval.' },
    });
    expect(opened.ok, `the ops room was refused: ${opened.error}`).toBe(true);
    room = opened.channelArn!;
    const channelId = room.split('/channel/')[1];

    // THE HOLDINGS THE ROUTER READS: the lead holds `lead` on the room's row, and the responder is a member who holds
    // nothing a source names. A responder outside the room would leave nobody to refuse.
    const row = awsv(['dynamodb', 'get-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: room } }), '--consistent-read'])?.Item;
    const holdings = JSON.stringify(row ? unmarshalItem(row).participantRoles ?? {} : {});
    expect(holdings, 'the room\'s row records the lead as the holder of lead').toContain(leadArn.split('/user/')[1]);
    test.skip(!peopleIn(room, leadArn).includes(responderArn), 'the ops engineer is not in the ops group, so the room holds no member without the lead role (provision-test-users --only opsEngineerUser)');
    expect(holdings, 'the responder holds no role a source names').not.toContain(responderArn.split('/user/')[1]);

    // THE CARD: targeted to the role's one holder, from the primary, with the approval's choices.
    const { hit, seen } = await waitFor(channelId, leadArn, (m) => !!m.metadata?.task?.id, 240_000);
    expect(hit, `no task card; seen ${JSON.stringify(seen.slice(0, 5).map((m) => m.metadata))}`).toBeDefined();
    expect(hit!.target, 'the card is addressed to the lead alone').toEqual([leadArn]);
    expect(hit!.sender, 'the card is the primary\'s').toBe(primaryBot);
    expect(hit!.metadata.task).toMatchObject({ state: 'deciding', choices: ['approved', 'declined'] });
    expect(hit!.metadata.notifyKind).toBe('task');
    card = hit!.metadata.task;

    // THE RESPONDER RECEIVES NO CARD AND OWES NOTHING.
    const seenByResponder = messagesSeenBy(channelId, responderArn);
    expect(seenByResponder.some((m) => m.messageId === hit!.messageId), 'a member who does not hold lead does not receive the card').toBe(false);
    expect(seenByResponder.filter((m) => m.metadata?.task?.id === card!.id).length, 'no card of the task reaches the responder in any form').toBe(0);

    const leadWork = await openWorkOf(leadToken);
    expect(leadWork.some((i) => i.taskId === card!.id), `the lead owns the task; ${JSON.stringify(leadWork).slice(0, 400)}`).toBe(true);
    const responderWork = await openWorkOf(responderToken);
    expect(responderWork.some((i) => i.taskId === card!.id), 'the task is not in the responder\'s open work').toBe(false);
  });

  test('the responder\'s press is refused, the lead approves on the card, the run takes the approved edge, and a second press is refused', async () => {
    test.setTimeout(300_000);
    test.skip(!room || !card, 'no card was posted');
    const channelId = room.split('/channel/')[1];
    const press = (token: string) => pressCard(token, { channelArn: room, taskId: card!.id, state: card!.state, choice: 'approved' });

    // A MEMBER WHO IS NOT THE ASSIGNEE: refused by the task service, and the task stays the lead's and open.
    const refused = await press(responderToken);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('NOT_ASSIGNEE');
    expect((await openWorkOf(leadToken)).some((i) => i.taskId === card!.id), 'the refused press left the task open').toBe(true);

    // THE ROLE'S HOLDER: approved, and the run continues on the approved edge to the lead.
    const pressed = await press(leadToken);
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    expect(pressed.body.state).toBe('approved');
    const { hit, seen } = await waitFor(channelId, leadArn, (m) => m.metadata?.eventStep?.step === 'thanks');
    expect(hit, `the run did not take the approved edge; seen ${JSON.stringify(seen.slice(0, 8).map((m) => m.metadata?.eventStep))}`).toBeDefined();
    expect(hit!.target, 'the approved edge\'s send is addressed to the lead').toEqual([leadArn]);

    // SETTLED ONCE: a second press is refused, and the task has left the lead's open work.
    const again = await press(leadToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SETTLED');
    expect((await openWorkOf(leadToken)).some((i) => i.taskId === card!.id)).toBe(false);
  });
});
