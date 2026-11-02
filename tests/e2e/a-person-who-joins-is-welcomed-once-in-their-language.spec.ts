/**
 * A SHARE INTO A ROOM RUNS THE VERSION'S `person-joined` WORKFLOW: THE JOINER IS WELCOMED ONCE, IN THE LANGUAGE THEY
 * CHOSE, AND CAUGHT UP AFTER IT (ADR-061 decisions 1 and 5, "One welcome per person"; ADR-062 decision 4), against the
 * deployed stacks.
 *
 * The unit suites prove each half with the code's own functions (`a-person-who-joins-starts-a-workflow`,
 * `a-person-is-welcomed-once-per-arrival`, `a-joiner-is-caught-up-whatever-the-workflow`,
 * `a-message-reaches-a-person-in-their-language`, `a-person-sets-their-own-language`). What only a deployment proves is
 * the path end to end:
 *  - the joiner sets their own language through `POST /me/language`, and the router reads it from their profile row;
 *  - the share names `person-joined` to the router once the membership exists, the router runs the served version's
 *    own workflow for the person it verified on the roster, and the share sends no `memberWelcome` of its own;
 *  - the workflow's send reaches the joiner alone, as the written variant in their language, with its run recorded on
 *    the message; and the join recap follows it, addressed to the joiner, as the step `withJoinRecap` appends;
 *  - a recap recounts what people said, so in a room where no person has spoken it calls no model, posts nothing and
 *    records `skipped` (ADR-061 decision 5, "As built"), and in a room where one has, it is posted;
 *  - nobody is welcomed twice: the joiner holds one welcome, and the member who shared it is sent none.
 *
 * THE RUN OWNS WHAT IT CHANGES. The premium primary gets one message template of its own (`e2e-joined-welcome`, with a
 * written variant in a declared language other than the deployment's) and a version whose `person-joined` workflow
 * sends it to `joined`; the joiner's language is set to that variant's. Afterwards the version that was active is
 * activated again, the template's pointer and the joiner's language are put back as they were, and both conversations
 * are deleted.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/a-person-who-joins-is-welcomed-once-in-their-language.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personApiServes, personUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { pollFor, readTask } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, workflowsOffEvents } from './helpers/version-under-test';
import { assistantTemplatePointer, readPointer, restorePointer } from './helpers/template-pointer';
import { isWelcomeTo, roomMessagesSeenBy, runKeyOf, stepOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARK = `JOIN-${Date.now().toString(36)}`;
const TEMPLATE = 'e2e-joined-welcome';
const WORKFLOW = 'e2e-joined-welcome';
const STEP = 'welcome';
/** The recap `withJoinRecap` inserts before the workflow's terminal step `done`. */
const RECAP_STEP = 'join-recap--done';

/** One line per language the variant may be written in; the marker and the tag say which variant was said. */
const WELCOME_LINE: Record<string, string> = {
  en: 'Welcome to this conversation.',
  zh: '欢迎加入这个对话。',
  es: 'Te damos la bienvenida a esta conversación.',
  fr: 'Bienvenue dans cette conversation.',
};
const lineIn = (tag: string) => `${MARK} welcome [${tag}] ${WELCOME_LINE[tag] ?? WELCOME_LINE.en}`;

/** The template the workflow sends: the deployment's own language, and one written variant in `variant`. */
function templateSource(own: string, variant: string): string {
  return [
    '---',
    JSON.stringify({ kind: 'message', name: TEMPLATE, description: 'E2E: the welcome a person-joined workflow sends the person who joined', language: own, fields: {} }),
    '---',
    '# chat',
    lineIn(own),
    '',
    `# chat@${variant}`,
    lineIn(variant),
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

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

test.describe.serial('a person who joins is welcomed once, in their language, and caught up (welcome-workflows)', () => {
  guardBackendErrors('a-person-who-joins-is-welcomed-once-in-their-language');

  let admin: VendedCredentials | undefined;
  let clientId = '';
  let primary = '';
  let previousVersion: number | undefined;
  let sharer: TestUser | null = null;
  let joiner: TestUser | null = null;
  let sharerArn = '';
  let joinerArn = '';
  let ownLanguage = '';
  let variantLanguage = '';
  /** The joiner's language before the run: a declared tag, or null when none was set. */
  let languageBefore: string | null | undefined;
  let pointerParam = '';
  let pointerBefore: string | null = null;
  let templateSaved = false;
  let agentTable = '';
  /** Every conversation the run opens, deleted afterwards. */
  const rooms: string[] = [];

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set WELCOME_WORKFLOWS_E2E=1 to run it (validate.mjs --only=welcome-workflows)');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    test.skip(!personApiServes('notifications'), 'PersonApi does not serve the notifications capability, whose route a share is (/share-conversation)');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    const second = await getSecondPremiumUser();
    test.skip(!second?.password, missingUserReason('secondPremiumUser'));
    sharer = creds.premiumUser;
    joiner = second;
    clientId = creds.cognitoClientId;

    // THE READER'S LANGUAGE: a declared language other than the deployment's own, which the joiner may choose.
    const view = await asPerson(joiner!, clientId, personUrl('/me/language'), 'GET');
    expect(view.status, JSON.stringify(view.body).slice(0, 300)).toBe(200);
    ownLanguage = String(view.body?.deployment || '');
    variantLanguage = ((view.body?.languages ?? []) as Array<{ tag: string }>).map((l) => l.tag).find((t) => t && t !== ownLanguage) ?? '';
    test.skip(!variantLanguage, `the deployment declares only ${ownLanguage || 'one language'}, so no reader can choose another (languages in deploy.config.json)`);
    languageBefore = view.body?.language ?? null;

    sharerArn = await personArnOf(sharer);
    joinerArn = await personArnOf(joiner!);
    expect(sharerArn, 'the sharer has no AppInstanceUser').toContain('/user/');
    expect(joinerArn, 'the joiner has no AppInstanceUser').toContain('/user/');
    primary = liveAssistantFor('premium');
    pointerParam = assistantTemplatePointer('premium', primary, TEMPLATE);
    pointerBefore = readPointer(pointerParam);

    agentTable = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    expect(agentTable, `${SSM_ROOT}/shared/tables/agent-tasks-name names no table`).toBeTruthy();

    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, clientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    if (admin && previousVersion !== undefined) await returnToVersion(admin, primary, previousVersion);
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (templateSaved) tryTo(`restore the pointer of ${TEMPLATE}`, () => restorePointer(pointerParam, pointerBefore));
    if (joiner && languageBefore !== undefined) {
      const back = await asPerson(joiner, clientId, personUrl('/me/language'), 'POST', { language: languageBefore }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: the joiner's language was not set back to ${languageBefore}: ${JSON.stringify(back?.body ?? {}).slice(0, 200)}`);
    }
    const serviceAdmin = rooms.length ? ssmValue(`${SSM_ROOT}/app-instance-admin-arn`) : '';
    for (const arn of rooms) {
      if (serviceAdmin) tryTo(`delete the conversation ${arn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', arn, '--chime-bearer', serviceAdmin]));
    }
  });

  test('the joiner chooses a language, and the primary activates a version whose person-joined workflow welcomes the joiner', async () => {
    test.setTimeout(180_000);
    const set = await asPerson(joiner!, clientId, personUrl('/me/language'), 'POST', { language: variantLanguage });
    expect(set.status, JSON.stringify(set.body).slice(0, 300)).toBe(200);
    expect(set.body?.language, 'the setting answers the language it stored').toBe(variantLanguage);

    // A TEMPLATE OF THE ASSISTANT'S OWN, under a name of its own: `message` names the shipped template whose call site it
    // fits, and it is said only where the version's workflow names it.
    const saved = await signedCall(adminUrl('assistant-admin', '/admin/templates/save'), admin!, 'POST',
      { profileName: primary, source: templateSource(ownLanguage, variantLanguage), message: 'workflow-subject-welcome' });
    templateSaved = saved.status === 200;
    expect(saved.status, JSON.stringify(saved.body).slice(0, 400)).toBe(200);

    previousVersion = await activateVersionWith(admin!, primary, (body) => ({
      eventWorkflows: {
        ...workflowsOffEvents(body, ['person-joined']),
        [WORKFLOW]: {
          on: 'person-joined',
          initial: STEP,
          states: {
            [STEP]: { send: { to: 'joined', template: TEMPLATE }, onSuccess: 'done', onFailure: 'done' },
            done: { disposition: 'success' },
          },
        },
      },
    }));
  });

  /** A conversation the sharer opens, settled on the assistant's opening, so what the share starts is told apart. */
  async function openRoom(title: string): Promise<string> {
    const conv = await asPerson(sharer!, clientId, personUrl('/create-conversation'), 'POST', {
      title, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: sharerArn,
    });
    expect(conv.status, JSON.stringify(conv.body).slice(0, 300)).toBe(200);
    const arn = String(conv.body?.conversation?.conversationArn || '');
    expect(arn, 'the creation names its conversation').toContain('/channel/');
    rooms.push(arn);
    const opened = await roomMessagesUntil(arn, sharerArn, (ms) => ms.some((m) => m.senderArn.includes('/bot/')), { timeoutMs: 90_000 });
    expect(opened.some((m) => m.senderArn.includes('/bot/')), 'the conversation never opened with a message from its assistant').toBe(true);
    return arn;
  }

  /** The sharer adds the joiner through the share route, as the chat app's Share dialog does. Returns when it was asked. */
  async function shareWithJoiner(arn: string, title: string): Promise<number> {
    const sharedAt = Date.now() - 2_000;
    const shared = await asPerson(sharer!, clientId, personUrl('/share-conversation'), 'POST', {
      conversationArn: arn, conversationTitle: title, recipientEmail: joiner!.email,
    });
    expect(shared.status, JSON.stringify(shared.body).slice(0, 300)).toBe(200);
    return sharedAt;
  }

  /** A step's record under its run (`event-run-store.ts`), carrying the outcome its one claim recorded; undefined before it is claimed. */
  const stepRecord = (arn: string, runKey: string, step: string) => readTask(agentTable, `event-run#${runKey}#step#${step}`, arn);

  const welcomeAfter = (sharedAt: number) => (ms: RoomMessage[]) =>
    ms.find((m) => Date.parse(m.createdAt) >= sharedAt && stepOf(m) === STEP && m.target.includes(joinerArn));
  const recapAfter = (sharedAt: number) => (ms: RoomMessage[]) =>
    ms.find((m) => Date.parse(m.createdAt) >= sharedAt && stepOf(m).startsWith('join-recap--') && m.target.includes(joinerArn));

  test('a share into a room no person has spoken in welcomes the joiner and sends no recap: the recap ends skipped', async () => {
    test.setTimeout(300_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    // The served version and a person's preferences are each cached for 30 seconds.
    await sleep(SERVED_VERSION_TTL_MS);

    const title = `Joined empty ${MARK}`;
    const room = await openRoom(title);
    const sharedAt = await shareWithJoiner(room, title);
    const welcome = welcomeAfter(sharedAt);
    const seen = await roomMessagesUntil(room, joinerArn, (ms) => Boolean(welcome(ms)), { timeoutMs: 120_000 });
    const w = welcome(seen);
    expect(w, `the joiner received no welcome from the workflow; seen ${JSON.stringify(seen.map((m) => ({ step: stepOf(m), text: m.text.slice(0, 80) })))}`).toBeTruthy();

    // SETTLED: the run has taken its terminal step, so the recap before it has been decided.
    const runKey = runKeyOf(w!);
    const ended = await pollFor(() => stepRecord(room, runKey, 'end'), (r) => Boolean(r), { timeoutMs: 180_000, intervalMs: 5_000 });
    expect(ended?.outcome, `the run ${runKey} never ended`).toBe('success');
    expect(stepRecord(room, runKey, RECAP_STEP)?.outcome, 'a recap with nothing a person wrote records skipped').toBe('skipped');
    const recap = recapAfter(sharedAt);
    expect(roomMessagesSeenBy(room, joinerArn).filter((m) => Boolean(recap([m]))).map((m) => m.text.slice(0, 120)),
      'a room no person has spoken in sends the joiner no recap').toEqual([]);
  });

  test('a share runs the workflow: one welcome to the joiner in their language, the recap after it, and nobody welcomed twice', async () => {
    test.setTimeout(420_000);
    test.skip(previousVersion === undefined, 'the version was not activated');

    const title = `Joined ${MARK}`;
    const channelArn = await openRoom(title);
    // A PERSON SPEAKS BEFORE THE JOINER ARRIVES, so the recap has something to recount. The assistant's answer is
    // awaited, so the share's run does not queue behind that turn.
    const said = `${MARK} Before anyone else joins: the report generation job has been running slow since this morning.`;
    awsv(['chime-sdk-messaging', 'send-channel-message', '--channel-arn', channelArn, '--content', said,
      '--type', 'STANDARD', '--persistence', 'PERSISTENT', '--chime-bearer', sharerArn]);
    const spoke = (ms: RoomMessage[]) => ms.find((m) => m.senderArn === sharerArn && m.text.includes(MARK));
    // THE ANSWER IS THE MESSAGE THE TURN DECLARED FINAL (`respPhase`, stamped by the processor on the update that carries
    // it), never one judged by its words: a model's answer may open with words a placeholder also uses.
    const answered = (ms: RoomMessage[]) => {
      const p = spoke(ms);
      return Boolean(p) && ms.some((m) => m.senderArn.includes('/bot/') && Date.parse(m.createdAt) > Date.parse(p!.createdAt)
        && !m.target.length && Boolean(m.text) && m.meta?.respPhase === 'final');
    };
    const before = await roomMessagesUntil(channelArn, sharerArn, answered, { timeoutMs: 180_000 });
    expect(spoke(before), 'the person\'s message is in the room').toBeTruthy();
    expect(answered(before), 'the assistant never answered the person who spoke').toBe(true);

    const sharedAt = await shareWithJoiner(channelArn, title);

    // SETTLED: the run's send and the recap after it, both read from the joiner's own view.
    const after = (m: RoomMessage) => Date.parse(m.createdAt) >= sharedAt;
    const welcome = welcomeAfter(sharedAt);
    const recap = recapAfter(sharedAt);
    const seen = await roomMessagesUntil(channelArn, joinerArn, (ms) => Boolean(welcome(ms) && recap(ms)), { timeoutMs: 240_000 });
    const brief = JSON.stringify(seen.filter(after).map((m) => ({ step: stepOf(m), to: m.target.length, text: m.text.slice(0, 100) })));
    expect(welcome(seen), `the joiner received no welcome from the workflow; seen ${brief}`).toBeTruthy();
    expect(recap(seen), `the joiner received no join recap after the workflow; seen ${brief}`).toBeTruthy();

    // THE WELCOME: addressed to the joiner alone, said as the variant in the language they chose, and recorded as the run.
    const w = welcome(seen)!;
    expect(w.target, 'the welcome is addressed to the person who joined, and only to them').toEqual([joinerArn]);
    expect(w.text, 'the welcome is the written variant in the joiner\'s language').toContain(`${MARK} welcome [${variantLanguage}]`);
    expect(w.text, 'the deployment\'s own language is not said to a reader who chose another').not.toContain(`[${ownLanguage}]`);
    expect(runKeyOf(w), 'the message carries its run: person-joined, for this assistant').toMatch(new RegExp(`^person-joined#.*#${primary}$`));
    expect(w.meta?.eventStep?.event, 'the step ran on person-joined').toBe('person-joined');

    // THE RECAP COMES AFTER THE WORKFLOW'S OWN STEP, and is the joiner's alone.
    const r = recap(seen)!;
    expect(Date.parse(r.createdAt), 'the recap follows the welcome').toBeGreaterThanOrEqual(Date.parse(w.createdAt));
    expect(r.target, 'the recap is addressed to the person who joined').toEqual([joinerArn]);

    // ONE WELCOME EACH: the joiner holds this one and no `memberWelcome`; the member who shared it is sent none.
    const joinerWelcomes = seen.filter((m) => after(m) && isWelcomeTo(m, joinerArn));
    expect(joinerWelcomes.map((m) => ({ step: stepOf(m), announcement: m.meta?.systemAnnouncement ?? '', kind: m.meta?.turnKind ?? '' })),
      'the joiner is welcomed once, by the run').toEqual([{ step: STEP, announcement: '', kind: 'notification' }]);
    const sharerView = roomMessagesSeenBy(channelArn, sharerArn);
    const byTheJoin = (m: RoomMessage) => m.meta?.eventStep?.event === 'person-joined' || m.meta?.systemAnnouncement === 'join_summary';
    expect(sharerView.filter((m) => after(m) && isWelcomeTo(m, sharerArn) && byTheJoin(m)).map((m) => m.text.slice(0, 120)),
      'the member who shared it is welcomed by nothing the join started').toEqual([]);
    expect(sharerView.some((m) => m.messageId === w.messageId), 'a welcome addressed to the joiner is not in anyone else\'s view').toBe(false);
    // The room is still told who joined: the share's join line is said to everyone.
    expect(sharerView.some((m) => after(m) && m.meta?.systemAnnouncement === 'member_joined'), 'the room was told the person joined').toBe(true);
  });
});
