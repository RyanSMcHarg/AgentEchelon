/**
 * AN AGENT STEP ADDRESSED TO A PARTICIPANT ROLE REACHES THAT ROLE'S HOLDERS ONLY (ADR-061 decision 8, rule 9, "Its output
 * follows the audience rules", with decision 3's `{ participantRole: '<name>' }` audience; DESIGN-CONVERSATION-TYPES
 * section 6.1), against the deployed stacks.
 *
 * The unit suites prove the audience with the code's own functions (`a-participant-role-is-declared-held-and-addressed`).
 * `an-opened-room-welcomes-its-lead-once-by-role.spec.ts` proves it for a platform `send`, which the router posts. What
 * this proves is the other poster: an `agent` step, one turn of the assistant the processor runs and posts, addressed by
 * role, end to end:
 *  - the premium creator opens an `ops` room for the lead it is named and records the lead as the holder of `lead` on the
 *    room's context row;
 *  - the primary's version welcomes `ops` rooms with its own workflow, whose agent step is addressed to
 *    `{ participantRole: 'lead' }`; the router reads the holdings from the row and hands them to the processor;
 *  - the processor keeps them to who is a member now and posts the step's message, its output or its fallback, addressed
 *    to the lead alone, as an `event_step` turn carrying its step;
 *  - a member who holds no role but the default `responder` does not receive it in any form.
 *
 * EITHER OUTCOME PROVES THE AUDIENCE. The turn's output and its fallback are both addressed by the step's audience, so the
 * spec asserts who received the step's one response, never its words, and records which outcome it was. A long response may
 * be split across continuation messages, so the spec counts responses, and every part of the step's one response is the
 * lead's alone.
 *
 * SETTLED BEFORE IT IS READ. Every assertion reads the room once the run has claimed its end, which is after the agent
 * step's one response is posted and the run was handed back to the router.
 *
 * THE RUN OWNS WHAT IT CHANGES. The primary gets a version whose welcome runs its own `conversation-opened` workflow for
 * `ops` conversations; the version that was active is activated again afterwards. Both rooms it opens, the operations
 * team's standing room and the `ops` room, are deleted with their context rows.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/an-agent-step-addressed-to-a-role-reaches-only-its-holders.spec.ts`
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getOpsEngineerUser, getOpsLeadUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { pollFor, readTask, unmarshalItem } from './helpers/task-backend';
import { SSM_ROOT, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, withWorkflowFor } from './helpers/version-under-test';
import { partsOf, roomMessagesSeenBy, runKeyOf, stepOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const STAMP = Date.now().toString(36);
const TOPIC = `Role agent step e2e ${STAMP}`;
const WORKFLOW = 'e2e-ops-brief-lead';
const STEP = 'brief-lead';

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
  const inFile = path.join(os.tmpdir(), `role-agent-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `role-agent-out-${stamp}.json`);
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

test.describe.serial('an agent step addressed to a participant role reaches only that role\'s holders (welcome-workflows)', () => {
  guardBackendErrors('an-agent-step-addressed-to-a-role-reaches-only-its-holders');

  let admin: VendedCredentials | undefined;
  let primary = '';
  let primaryBot = '';
  let previousVersion: number | undefined;
  let creator = '';
  let contextTable = '';
  let agentTable = '';
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
    // creation without it is refused, by design).
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
    agentTable = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
    expect(contextTable, `${SSM_ROOT}/shared/tables/channel-context-name names no table`).toBeTruthy();
    expect(agentTable, `${SSM_ROOT}/shared/tables/agent-tasks-name names no table`).toBeTruthy();

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

  test('the primary activates a version whose ops opening runs an agent step addressed to the lead role', async () => {
    test.setTimeout(180_000);
    previousVersion = await activateVersionWith(admin!, primary, (body) => ({
      // THE ROOM'S TYPE SELECTS ITS conversation-opened WORKFLOW (W1): this one, for ops.
      eventWorkflows: withWorkflowFor(body, WORKFLOW, {
          on: 'conversation-opened',
          types: ['ops'],
          initial: 'opening',
          states: {
            // The opening is a platform send, so no model call stands before the first message the room reads.
            opening: { send: { to: 'room', template: 'ops-room-opening', mention: { lead: 'participantRole:lead' } }, onSuccess: STEP, onFailure: STEP },
            // THE STEP UNDER TEST: one turn of the primary, addressed to whoever holds `lead`, with a fallback that is too.
            [STEP]: {
              agent: {
                prompt: 'welcome-greeting',
                to: { participantRole: 'lead' },
                deadlineMs: 20_000,
                fallback: { send: { to: { participantRole: 'lead' }, template: 'ops-lead-welcome' } },
              },
              onSuccess: 'done',
              onFailure: 'done',
            },
            done: { disposition: 'success' },
          },
      }),
    }));
  });

  test('the agent step\'s message is addressed to the lead alone, and the responder receives it in no form', async () => {
    test.setTimeout(420_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    // A cache expiring raises no event: the run is silent by design until it has.
    declareWait('the served version reaching every container', Date.now() + SERVED_VERSION_TTL_MS);
    await new Promise((r) => setTimeout(r, SERVED_VERSION_TTL_MS));

    const team = invokeCreator(creator, { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: `Role agent step e2e team ${STAMP}` });
    expect(team.ok, `the standing room was refused: ${team.error}`).toBe(true);
    teamRoom = team.channelArn!;
    // THE STEP: an `ops` room opened for the lead, concerning the team's room, as the platform's ops event opens one.
    const opened = invokeCreator(creator, {
      detail: { conversationType: 'ops', concernedChannelArn: teamRoom, forUserArn: leadArn, topicLabel: TOPIC, summary: 'Report generation is running slow.' },
    });
    expect(opened.ok, `the ops room was refused: ${opened.error}`).toBe(true);
    room = opened.channelArn!;

    // THE HOLDINGS THE ROUTER READS: the lead holds `lead` on the room's row, and the responder is a member who holds
    // nothing a source names. A responder outside the room would leave nobody to be denied the role's message.
    const row = awsv(['dynamodb', 'get-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: room } }), '--consistent-read'])?.Item;
    const holdings = JSON.stringify(row ? unmarshalItem(row).participantRoles ?? {} : {});
    expect(holdings, 'the room\'s row records the lead as the holder of lead').toContain(leadArn.split('/user/')[1]);
    const people = peopleIn(room, leadArn);
    test.skip(!people.includes(responderArn), 'the ops engineer is not in the ops group, so the room holds no member without the lead role (provision-test-users --only opsEngineerUser)');
    expect(holdings, 'the responder holds no role a source names').not.toContain(responderArn.split('/user/')[1]);

    // SETTLED: the agent step's message is posted and the run, handed back to the router, has claimed its end.
    const stepped = (ms: RoomMessage[]) => ms.filter((m) => stepOf(m) === STEP);
    const brief = (ms: RoomMessage[]) => JSON.stringify(ms.filter((m) => m.senderArn.includes('/bot/')).map((m) => ({ step: stepOf(m), to: m.target.length, outcome: m.meta?.eventStep?.outcome ?? '', text: m.text.slice(0, 80) })));
    const first = await roomMessagesUntil(room, leadArn, (ms) => stepped(ms).length > 0, { timeoutMs: 240_000 });
    expect(stepped(first).length, `the agent step never posted; seen ${brief(first)}`).toBeGreaterThan(0);
    const runKey = runKeyOf(stepped(first)[0]);
    expect(runKey, 'the step carries its run: conversation-opened, for this assistant').toMatch(new RegExp(`^conversation-opened#.*#${primary}$`));
    // The run's end is a table row, which raises no event the run can listen for.
    declareWait('the event run recording its end', Date.now() + 120_000);
    const ended = await pollFor(() => readTask(agentTable, `event-run#${runKey}#step#end`, room), (r) => Boolean(r), { timeoutMs: 120_000, intervalMs: 5_000 });
    expect(ended?.outcome, `the run ${runKey} never ended`).toBe('success');
    const seenByLead = roomMessagesSeenBy(room, leadArn);
    const seenByResponder = roomMessagesSeenBy(room, responderArn);

    // ONE RESPONSE FOR THE STEP, the primary's, an `event_step` turn, addressed to the role's one holder. A long response is
    // split across continuation messages, which carry the grouping rather than the step, so the step's messages here are
    // its responses, and each part of the one response is read through its head.
    const msgs = stepped(seenByLead);
    expect(msgs.length, `the agent step posted one response; seen ${brief(seenByLead)}`).toBe(1);
    const m = msgs[0];
    const parts = partsOf(m, seenByLead);
    console.log(`[role-agent-step] the step's response took ${parts.length} message(s)`);
    console.log(`[role-agent-step] the step's outcome: ${m.meta?.eventStep?.outcome}`);
    expect(String(m.meta?.eventStep?.outcome), 'the step posted its output or its fallback').toMatch(/^(posted|fallback:[a-z_]+)$/);
    expect(m.meta?.turnKind, 'the step is an event_step turn').toBe('event_step');
    expect(m.senderArn, 'the step is the primary\'s turn').toBe(primaryBot);
    for (const p of parts) {
      expect(p.senderArn, 'every part is the primary\'s').toBe(primaryBot);
      expect(p.target, 'every part of an agent step addressed to participantRole lead is addressed to the role\'s holders').toEqual([leadArn]);
    }

    // THE RESPONDER, A MEMBER WHO DOES NOT HOLD lead, RECEIVES NOTHING OF IT.
    const partIds = new Set(parts.map((p) => p.messageId));
    expect(seenByResponder.filter((x) => partIds.has(x.messageId) || x.meta?.parentMessageId === m.messageId).map((x) => x.text.slice(0, 120)),
      'a member who does not hold lead receives no part of the role\'s response').toEqual([]);
    expect(stepped(seenByResponder).map((x) => x.text.slice(0, 120)), 'no message of the step reaches the responder in any form').toEqual([]);
    // The room's opening is the room's, so the responder reads it: the room was readable to them all along.
    const opening = seenByLead.filter((x) => stepOf(x) === 'opening');
    expect(opening.length, `one opening; seen ${brief(seenByLead)}`).toBe(1);
    expect(seenByResponder.some((x) => x.messageId === opening[0].messageId), 'the responder reads the room\'s opening').toBe(true);
  });
});
