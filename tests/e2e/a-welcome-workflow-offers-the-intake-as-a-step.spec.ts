/**
 * A WELCOME WORKFLOW OFFERS THE ONBOARDING INTAKE AS ONE OF ITS STEPS, AND THE WELCOME STILL RENDERS (ADR-061 decision 2,
 * "The intake is a step too", and decision 5's welcome table), against the deployed stacks.
 *
 * The unit suite proves the step with the router's own functions (`the-intake-is-a-step`). What only a deployment proves
 * is the path end to end:
 *  - the primary's version declares a welcome that greets and then continues (W1), so the join runs the version's
 *    `assistant-joined` workflow and starts no intake of its own;
 *  - the workflow's opening step is the room's opening, composed from its own text and posted by the router as a step,
 *    and its send to `subject` greets the person the conversation was opened for, so the welcome renders in full;
 *  - its `start_intake` step, after the greeting, reads the version's intake and the person's stored profile, records the
 *    intake on the conversation's context row as that person's, and asks its question as a message targeted at them
 *    alone, carrying the step;
 *  - the intake is asked once: one targeted intake message, and the run ends.
 *
 * THE PERSON IS NOT ONBOARDED FOR THE RUN. The router asks nothing of a person whose profile records `onboardedAt`, so
 * the run takes the creator's stored profile row as it is, removes `onboardedAt`, and puts the row back exactly
 * afterwards. A router caches "onboarded" for five minutes, so where the row recorded it the run waits that out before
 * the conversation is opened; where it did not, nothing can be cached and the run does not wait.
 *
 * THE RUN OWNS WHAT IT CHANGES. The premium primary gets a message template of its own (the greeting) and a version
 * whose welcome runs its own workflow and whose intake is a one-question offer. Afterwards the version that
 * was active is activated again, the templates' pointers and the profile row are put back, and the conversation is
 * deleted with its context row.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/a-welcome-workflow-offers-the-intake-as-a-step.spec.ts`
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf, personIdOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { pollFor, readTask, unmarshalItem } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, withWorkflowFor } from './helpers/version-under-test';
import { assistantTemplatePointer, readPointer, restorePointer } from './helpers/template-pointer';
import { profileKeyFor, profileTable, readProfileItem } from './helpers/profile-store';
import { roomMessagesSeenBy, runKeyOf, stepOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARK = `INTAKE-${Date.now().toString(36)}`;
const WORKFLOW = 'e2e-intake-welcome';
const GREETING_TEMPLATE = 'e2e-intake-greeting';
/** How long a router holds "onboarded" for a person it read as onboarded (`ONBOARDED_CACHE_TTL_MS`), and a margin. */
const ONBOARDED_CACHE_MS = 5 * 60_000 + 15_000;

/** The intake the version carries: one yes/no offer, in words of the run's own so its question is told apart. */
const INTAKE = {
  greeting: `${MARK} Before we start:`,
  fields: [],
  offer: {
    ask: `${MARK} Would you like a short tour of what I can do here?`,
    affirmative: ['yes'],
    negative: ['no'],
    onAccept: `${MARK} Here is the tour.`,
    onDecline: `${MARK} No problem.`,
  },
};

/** A message template of the assistant's own with one chat line and no fields. */
function templateSource(name: string, line: string): string {
  return [
    '---',
    JSON.stringify({ kind: 'message', name, description: 'E2E: what a workflow welcome says before it offers the intake', language: 'en', fields: {} }),
    '---',
    '# chat',
    line,
  ].join('\n');
}

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

test.describe.serial('a welcome workflow offers the intake as a step, and the welcome still renders (welcome-workflows)', () => {
  guardBackendErrors('a-welcome-workflow-offers-the-intake-as-a-step');

  let admin: VendedCredentials | undefined;
  let clientId = '';
  let primary = '';
  let previousVersion: number | undefined;
  let person: TestUser | null = null;
  let personArn = '';
  /** The person's profile row as it was, or null when there was none; undefined until it was read. */
  let rowBefore: Record<string, any> | null | undefined;
  let rowChanged = false;
  let agentTable = '';
  let contextTable = '';
  const pointers: Array<{ param: string; before: string | null; saved: boolean }> = [];
  let channelArn = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set WELCOME_WORKFLOWS_E2E=1 to run it (validate.mjs --only=welcome-workflows)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    person = creds.premiumUser;
    clientId = creds.cognitoClientId;

    personArn = await personArnOf(person);
    expect(personArn, 'the person has no AppInstanceUser').toContain('/user/');
    primary = liveAssistantFor('premium');
    for (const name of [GREETING_TEMPLATE]) {
      const param = assistantTemplatePointer('premium', primary, name);
      pointers.push({ param, before: readPointer(param), saved: false });
    }
    agentTable = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    contextTable = ssmValue(`${SSM_ROOT}/shared/tables/channel-context-name`);
    expect(agentTable, `${SSM_ROOT}/shared/tables/agent-tasks-name names no table`).toBeTruthy();
    expect(contextTable, `${SSM_ROOT}/shared/tables/channel-context-name names no table`).toBeTruthy();
    // The profile table is read here so a deployment that publishes none fails before anything is changed.
    expect(profileTable(), 'the user-profile table').toBeTruthy();

    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, clientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (admin && previousVersion !== undefined) await returnToVersion(admin, primary, previousVersion);
    for (const p of pointers.filter((x) => x.saved)) tryTo(`restore ${p.param}`, () => restorePointer(p.param, p.before));
    if (person && rowChanged && rowBefore !== undefined) {
      const key = JSON.stringify(await profileKeyFor(person.email));
      tryTo('put the person\'s profile row back', () => (rowBefore
        ? awsv(['dynamodb', 'put-item', '--table-name', profileTable(), '--item', JSON.stringify(rowBefore)])
        : awsv(['dynamodb', 'delete-item', '--table-name', profileTable(), '--key', key])));
    }
    if (channelArn) {
      const serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
      if (serviceAdmin) tryTo(`delete the conversation ${channelArn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', channelArn, '--chime-bearer', serviceAdmin]));
      if (contextTable) tryTo(`delete the row of ${channelArn}`, () => awsv(['dynamodb', 'delete-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: channelArn } })]));
    }
  });

  test('the person is not onboarded, and the primary activates a version whose workflow welcome offers its intake', async () => {
    test.setTimeout(ONBOARDED_CACHE_MS + 240_000);
    const startedAt = Date.now();

    // THE PERSON, NOT ONBOARDED: the row is kept whole and only `onboardedAt` is removed, so every other fact and
    // preference the person holds is read as it was.
    rowBefore = await readProfileItem(person!.email);
    const wasOnboarded = Boolean(rowBefore?.onboardedAt?.S);
    if (wasOnboarded) {
      rowChanged = true;
      awsv(['dynamodb', 'update-item', '--table-name', profileTable(), '--key', JSON.stringify(await profileKeyFor(person!.email)),
        '--update-expression', 'REMOVE onboardedAt']);
    }
    expect((await readProfileItem(person!.email))?.onboardedAt, 'the person\'s profile still records onboardedAt').toBeUndefined();

    for (const [i, [name, line, words]] of ([
      [GREETING_TEMPLATE, `${MARK} greeting: welcome, I am glad you are here.`, 'workflow-subject-welcome'],
    ] as const).entries()) {
      const saved = await signedCall(adminUrl('assistant-admin', '/admin/templates/save'), admin!, 'POST',
        { profileName: primary, source: templateSource(name, line), message: words });
      pointers[i].saved = saved.status === 200;
      expect(saved.status, JSON.stringify(saved.body).slice(0, 400)).toBe(200);
    }

    previousVersion = await activateVersionWith(admin!, primary, (body) => {
      return {
        onboarding: INTAKE,
        // THE WELCOME UNDER TEST answers in an ordinary conversation as in any other: a welcome the version keeps for
        // `general` would otherwise answer first (W1, one welcome per kind of room).
        eventWorkflows: withWorkflowFor(body, WORKFLOW, {
            on: 'assistant-joined',
            initial: 'opening',
            states: {
              // THE WELCOME'S TEMPLATE STEP, with its own text: posted by the router, as a step of the run, before the greeting.
              opening: { opening: { text: `${MARK} opening: this conversation is open.` }, onSuccess: 'greet', onFailure: 'greet' },
              greet: { send: { to: 'subject', template: GREETING_TEMPLATE }, onSuccess: 'intake', onFailure: 'intake' },
              intake: { action: { tool: 'start_intake', to: 'subject' }, onSuccess: 'done', onFailure: 'done' },
              done: { disposition: 'success' },
            },
        }, ['general']),
      };
    });

    // A ROUTER THAT READ THE PERSON AS ONBOARDED HOLDS THAT FOR FIVE MINUTES, so the run waits it out from the moment
    // the row changed. The served version's own cache is shorter and is covered either way.
    const wait = (wasOnboarded ? ONBOARDED_CACHE_MS : SERVED_VERSION_TTL_MS) - (Date.now() - startedAt);
    if (wait > 0) {
      // A cache expiring raises no event: the run is silent by design until it has.
      declareWait(wasOnboarded ? 'the onboarded cache expiring' : 'the served version reaching every container', Date.now() + wait);
      await sleep(wait);
    }
  });

  test('the join runs the workflow: the opening, the greeting, then the intake\'s question to the person alone, once', async () => {
    test.setTimeout(300_000);
    test.skip(previousVersion === undefined, 'the version was not activated');

    const res = await fetch(personUrl('/create-conversation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idTokenFor(person!.email, person!.password, clientId)}` },
      body: JSON.stringify({ title: `Intake ${MARK}`, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: personArn }),
    });
    const created = await res.json().catch(() => ({}));
    expect(res.status, JSON.stringify(created).slice(0, 300)).toBe(200);
    channelArn = String(created?.conversation?.conversationArn || '');
    expect(channelArn, 'the creation names its conversation').toContain('/channel/');

    // SETTLED: the intake step, the workflow's last before its end, has posted, and the run has ended.
    const intakeOf = (ms: RoomMessage[]) => ms.filter((m) => stepOf(m) === 'intake');
    const seen = await roomMessagesUntil(channelArn, personArn, (ms) => intakeOf(ms).length > 0, { timeoutMs: 180_000 });
    const brief = JSON.stringify(seen.filter((m) => m.senderArn.includes('/bot/')).map((m) => ({ step: stepOf(m), to: m.target.length, text: m.text.slice(0, 80) })));
    expect(intakeOf(seen).length, `the workflow never offered the intake; seen ${brief}`).toBeGreaterThan(0);
    const runKey = runKeyOf(intakeOf(seen)[0]);
    expect(runKey, 'the intake carries its run: assistant-joined, for this assistant').toMatch(new RegExp(`^assistant-joined#.*#${primary}$`));
    const ended = await pollFor(() => readTask(agentTable, `event-run#${runKey}#step#end`, channelArn), (r) => Boolean(r), { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(ended?.outcome, `the run ${runKey} never ended`).toBe('success');
    const settled = roomMessagesSeenBy(channelArn, personArn);

    // THE WELCOME RENDERS: the opening to the room, and the greeting to the person the conversation was opened for.
    const opening = settled.filter((m) => stepOf(m) === 'opening');
    expect(opening.length, `one opening; seen ${brief}`).toBe(1);
    expect(opening[0].text, 'the opening is the workflow\'s own').toContain(`${MARK} opening`);
    expect(opening[0].target, 'the opening is posted to the room').toEqual([]);
    const greeting = settled.filter((m) => stepOf(m) === 'greet');
    expect(greeting.length, `one greeting; seen ${brief}`).toBe(1);
    expect(greeting[0].text, 'the greeting is the workflow\'s own').toContain(`${MARK} greeting`);
    expect(greeting[0].target, 'the greeting is addressed to the person the conversation was opened for').toEqual([personArn]);

    // THE INTAKE IS A STEP: its question, after the greeting, addressed to the person alone, asked once.
    const intake = intakeOf(settled);
    expect(intake.length, `the intake was asked once; seen ${brief}`).toBe(1);
    expect(intake[0].text, 'the intake asks the version\'s question').toContain(INTAKE.offer.ask);
    expect(intake[0].target, 'the intake is addressed to the person alone').toEqual([personArn]);
    expect(intake[0].meta?.eventStep?.event, 'the intake ran on assistant-joined').toBe('assistant-joined');
    expect(Date.parse(intake[0].createdAt), 'the intake follows the greeting').toBeGreaterThanOrEqual(Date.parse(greeting[0].createdAt));
    expect(settled.filter((m) => m.senderArn.includes('/bot/') && m.text.includes(INTAKE.offer.ask)).length,
      'no second intake question, from the join or anything else').toBe(1);

    // THE INTAKE IS RECORDED AS THIS PERSON'S on the conversation's context row, where only their answers are read.
    const row = awsv(['dynamodb', 'get-item', '--table-name', contextTable, '--key', JSON.stringify({ channelArn: { S: channelArn } }), '--consistent-read'])?.Item;
    const recorded = row ? unmarshalItem(row).onboardingIntake : undefined;
    expect(recorded?.subject, 'the context row records the intake as the person\'s').toBe(personIdOf(personArn));
    expect(recorded?.phase, 'the offer awaits the person\'s answer').toBe('confirming');
  });
});
