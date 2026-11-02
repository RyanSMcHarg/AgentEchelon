/**
 * AN INVITATION RUNS THE VERSION'S `invitation-sent` WORKFLOW FOR THE INVITER, AND A REVOKED INVITATION'S DEADLINE RUNS
 * NOTHING (ADR-061 decision 1, "As built, for an invitation" and "As built, for `invitation-unredeemed`"), against the
 * deployed stacks.
 *
 * The unit suites prove each half with the code's own functions (`an-invitation-starts-a-workflow`,
 * `a-deadline-is-scheduled-once-and-checked-when-it-fires`). What only a deployment proves is the path end to end:
 *  - `POST /invitations` writes the record and names `invitation-sent` to the router of the conversation's
 *    classification; the router reads the record by its key, verifies it is pending, and runs the served version's
 *    workflow, whose send reaches the inviter alone, with the run keyed by the invitation;
 *  - the router schedules the version's `invitation-unredeemed` deadline in its classification's schedule group, and
 *    `POST /invitations/revoke` asks the router to delete the revoked invitation's schedule;
 *  - when the kept invitation's deadline fires, the router reads the record again and runs the workflow for the inviter;
 *    the revoked invitation's deadline runs nothing.
 *
 * WHY THE REVOKED CASE IS PROVEN AT THE DEADLINE. `invitation-sent` is named the moment the record is written, before
 * any revoke can land, so a revoke cannot reach that run. The deadline is read again when it fires, which is where a
 * revoked invitation is refused; the run here waits out the shortest deadline a workflow may declare (five minutes).
 *
 * THE RUN OWNS WHAT IT CHANGES. The premium primary gets two message templates of its own and a version whose
 * `invitation-sent` and `invitation-unredeemed` workflows send them to the inviter. Invitations carry no address, so no
 * email is sent. Afterwards the kept invitation is revoked (which removes its invitee and its schedule), the version
 * that was active is activated again, the templates' pointers are put back, and the conversation is deleted.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/an-invitation-runs-its-workflow-until-it-is-revoked.spec.ts`
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { MIN_DEADLINE_MINUTES } from '../../backend/lambda/src/lib/event-workflow';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { pollFor } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT, physicalIdsIn, stackName } from './helpers/stack-prefix';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, workflowsOffEvents } from './helpers/version-under-test';
import { assistantTemplatePointer, readPointer, restorePointer } from './helpers/template-pointer';
import { eventOf, roomMessagesSeenBy, runKeyOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';
import { deadlineScheduleName } from '../../backend/lambda/src/lib/event-deadlines';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARK = `INV-${Date.now().toString(36)}`;
const SENT_TEMPLATE = 'e2e-invitation-sent';
const UNREDEEMED_TEMPLATE = 'e2e-invitation-unredeemed';
/** The shortest deadline a workflow may declare, read from the platform so the spec follows it. */
const DEADLINE_MINUTES = MIN_DEADLINE_MINUTES;

/** A message template of the assistant's own with one chat line and no fields. */
function templateSource(name: string, line: string): string {
  return [
    '---',
    JSON.stringify({ kind: 'message', name, description: 'E2E: what an invitation workflow tells the inviter', language: 'en', fields: {} }),
    '---',
    '# chat',
    line,
  ].join('\n');
}

/** A person route called as a signed-in person. */
async function asPerson(user: TestUser, clientId: string, route: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(route, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idTokenFor(user.email, user.password, clientId)}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; } catch { return { status: res.status, body: { raw: text.slice(0, 300) } }; }
}

/** Whether a schedule of that name is in the group. */
function scheduleExists(group: string, name: string): boolean {
  try {
    awsv(['scheduler', 'get-schedule', '--group-name', group, '--name', name], { quiet: true });
    return true;
  } catch (err) {
    if (/ResourceNotFound/.test(String((err as Error)?.message))) return false;
    throw err;
  }
}

test.describe.serial('an invitation runs its workflow until it is revoked (welcome-workflows)', () => {
  guardBackendErrors('an-invitation-runs-its-workflow-until-it-is-revoked');

  let admin: VendedCredentials | undefined;
  let clientId = '';
  let primary = '';
  let previousVersion: number | undefined;
  let inviter: TestUser | null = null;
  let inviterArn = '';
  let deadlineGroup = '';
  const pointers: Array<{ param: string; before: string | null; saved: boolean }> = [];
  let channelArn = '';
  let kept = '';
  let revoked = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set WELCOME_WORKFLOWS_E2E=1 to run it (validate.mjs --only=welcome-workflows)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    inviter = creds.premiumUser;
    clientId = creds.cognitoClientId;

    // EVERY INVITATION LANDS IN THE CHAT APP (`invitationLandingFor`), so every deployment's invitations function has a
    // landing origin, a declared widget or none. A function without one is a stale Conversations stack, not a skip.
    const invitationsFn = physicalIdsIn([stackName('Conversations')], { type: 'AWS::Lambda::Function', logicalId: /^InvitationsFunction/ })[0] || '';
    expect(invitationsFn, `${stackName('Conversations')} has no InvitationsFunction`).toBeTruthy();
    const landing = awsvText(['lambda', 'get-function-configuration', '--function-name', invitationsFn,
      '--query', 'Environment.Variables.INVITATION_LANDING_ORIGIN', '--output', 'text']).trim();
    expect(landing && landing !== 'None', `${invitationsFn} has no INVITATION_LANDING_ORIGIN, so it issues no invitation; deploy this branch's Conversations stack, whose invitations land in the chat app`).toBeTruthy();

    // THE DEADLINE'S SCHEDULE GROUP: the premium router creates and deletes the invitation's schedule there.
    deadlineGroup = physicalIdsIn([stackName('Assistants-premium')], { type: 'AWS::Scheduler::ScheduleGroup', logicalId: /^EventDeadlineGroup/ })[0] || '';
    expect(deadlineGroup, `${stackName('Assistants-premium')} has no EventDeadlineGroup; deploy this branch's classification stack`).toBeTruthy();

    inviterArn = await personArnOf(inviter);
    expect(inviterArn, 'the inviter has no AppInstanceUser').toContain('/user/');
    primary = liveAssistantFor('premium');
    for (const name of [SENT_TEMPLATE, UNREDEEMED_TEMPLATE]) {
      const param = assistantTemplatePointer('premium', primary, name);
      pointers.push({ param, before: readPointer(param), saved: false });
    }

    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, clientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (inviter && channelArn && kept) {
      const back = await asPerson(inviter, clientId, personUrl('/invitations/revoke'), 'POST', { channelArn, invitationId: kept }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: the kept invitation was not revoked: ${JSON.stringify(back?.body ?? {}).slice(0, 200)}`);
    }
    if (admin && previousVersion !== undefined) await returnToVersion(admin, primary, previousVersion);
    for (const p of pointers.filter((x) => x.saved)) tryTo(`restore ${p.param}`, () => restorePointer(p.param, p.before));
    if (channelArn) {
      const serviceAdmin = (() => {
        try { return awsvText(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/app-instance-admin-arn`, '--query', 'Parameter.Value', '--output', 'text']).trim(); } catch { return ''; }
      })();
      if (serviceAdmin) tryTo(`delete the conversation ${channelArn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', channelArn, '--chime-bearer', serviceAdmin]));
    }
  });

  test('the primary activates a version whose invitation workflows tell the inviter', async () => {
    test.setTimeout(180_000);
    const lines: Record<string, { line: string; words: string }> = {
      [SENT_TEMPLATE]: { line: `${MARK} sent: your invitation is on its way.`, words: 'workflow-subject-welcome' },
      [UNREDEEMED_TEMPLATE]: { line: `${MARK} unredeemed: your invitation has not been accepted yet.`, words: 'invitation-unredeemed-reminder' },
    };
    for (const [i, name] of [SENT_TEMPLATE, UNREDEEMED_TEMPLATE].entries()) {
      // A TEMPLATE OF THE ASSISTANT'S OWN, under a name of its own: `message` names the shipped template whose call site
      // it fits, and it is said only where the version's workflow names it.
      const saved = await signedCall(adminUrl('assistant-admin', '/admin/templates/save'), admin!, 'POST',
        { profileName: primary, source: templateSource(name, lines[name].line), message: lines[name].words });
      pointers[i].saved = saved.status === 200;
      expect(saved.status, JSON.stringify(saved.body).slice(0, 400)).toBe(200);
    }
    const toInviter = (template: string) => ({ send: { to: { people: 'invitation:inviter' }, template }, onSuccess: 'done', onFailure: 'done' });
    previousVersion = await activateVersionWith(admin!, primary, (body) => ({
      eventWorkflows: {
        ...workflowsOffEvents(body, ['invitation-sent', 'invitation-unredeemed']),
        'e2e-invitation-sent': { on: 'invitation-sent', initial: 'tell', states: { tell: toInviter(SENT_TEMPLATE), done: { disposition: 'success' } } },
        'e2e-invitation-unredeemed': {
          on: 'invitation-unredeemed', deadline: { afterMinutes: DEADLINE_MINUTES }, initial: 'remind',
          states: { remind: toInviter(UNREDEEMED_TEMPLATE), done: { disposition: 'success' } },
        },
      },
    }));
  });

  test('invitation-sent tells the inviter alone; the kept invitation\'s deadline runs, and the revoked one\'s runs nothing', async () => {
    test.setTimeout(DEADLINE_MINUTES * 60_000 + 540_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    await sleep(SERVED_VERSION_TTL_MS);

    const conv = await asPerson(inviter!, clientId, personUrl('/create-conversation'), 'POST', {
      title: `Invitations ${MARK}`, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: inviterArn,
    });
    expect(conv.status, JSON.stringify(conv.body).slice(0, 300)).toBe(200);
    channelArn = String(conv.body?.conversation?.conversationArn || '');
    expect(channelArn, 'the creation names its conversation').toContain('/channel/');

    // THE STEP: two invitations with no address, so nothing is emailed; the second is revoked at once.
    const invite = async (name: string) => {
      const r = await asPerson(inviter!, clientId, personUrl('/invitations'), 'POST', { channelArn, name });
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
      return String(r.body?.invitation?.invitationId || '');
    };
    kept = await invite(`Kept ${MARK}`);
    revoked = await invite(`Revoked ${MARK}`);
    declareWait("the kept invitation's invitation-unredeemed deadline", Date.now() + DEADLINE_MINUTES * 60_000);
    expect(kept && revoked, 'each invitation answers its id').toBeTruthy();
    const withdrawn = await asPerson(inviter!, clientId, personUrl('/invitations/revoke'), 'POST', { channelArn, invitationId: revoked });
    expect(withdrawn.status, JSON.stringify(withdrawn.body).slice(0, 300)).toBe(200);
    expect(withdrawn.body?.invitation?.status, 'the revoked invitation reads as revoked').toBe('revoked');

    const runOf = (event: string, id: string) => (m: RoomMessage) => eventOf(m) === event && runKeyOf(m).includes(`invitation-${id}`);

    // INVITATION-SENT, SETTLED: the kept invitation's run told the inviter, addressed to them alone.
    const sentSeen = await roomMessagesUntil(channelArn, inviterArn, (ms) => ms.some(runOf('invitation-sent', kept)), { timeoutMs: 120_000 });
    const sent = sentSeen.filter(runOf('invitation-sent', kept));
    expect(sent.length, `the kept invitation's invitation-sent run told the inviter once; seen ${JSON.stringify(sentSeen.map((m) => [eventOf(m), runKeyOf(m), m.text.slice(0, 60)]))}`).toBe(1);
    expect(sent[0].text, 'the inviter reads the workflow\'s message').toContain(`${MARK} sent`);
    expect(sent[0].target, 'the message is addressed to the inviter alone').toEqual([inviterArn]);
    expect(runKeyOf(sent[0]), 'the run is keyed by the invitation and the assistant').toBe(`invitation-sent#invitation-${kept}#${primary}`);

    // THE SCHEDULES: the kept invitation's deadline is in the router's group, and the revoked one's is deleted.
    const keptSchedule = deadlineScheduleName('invitation-unredeemed', channelArn, kept);
    const revokedSchedule = deadlineScheduleName('invitation-unredeemed', channelArn, revoked);
    expect(scheduleExists(deadlineGroup, keptSchedule), `the kept invitation's deadline ${keptSchedule} is not in ${deadlineGroup}`).toBe(true);
    const goneAt = await pollFor(() => scheduleExists(deadlineGroup, revokedSchedule), (exists) => !exists, { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(goneAt, `the revoked invitation's deadline ${revokedSchedule} is still in ${deadlineGroup}`).toBe(false);

    // THE DEADLINE, SETTLED: the kept invitation's fires and its run tells the inviter; a minute after that, nothing has
    // run for the revoked one, whose deadline would have fired within seconds of the kept one's.
    const firedSeen = await roomMessagesUntil(channelArn, inviterArn, (ms) => ms.some(runOf('invitation-unredeemed', kept)),
      { timeoutMs: DEADLINE_MINUTES * 60_000 + 180_000 });
    const fired = firedSeen.filter(runOf('invitation-unredeemed', kept));
    expect(fired.length, 'the kept invitation\'s deadline ran its workflow once').toBe(1);
    expect(fired[0].text, 'the inviter reads the deadline workflow\'s message').toContain(`${MARK} unredeemed`);
    expect(fired[0].target, 'the deadline\'s message is addressed to the inviter alone').toEqual([inviterArn]);
    await sleep(60_000);
    const settled = roomMessagesSeenBy(channelArn, inviterArn);
    expect(settled.filter(runOf('invitation-unredeemed', revoked)).map((m) => m.text.slice(0, 120)), 'a revoked invitation\'s deadline ran its workflow').toEqual([]);
    expect(settled.filter(runOf('invitation-unredeemed', kept)).length, 'the kept invitation\'s deadline ran once').toBe(1);
  });
});
