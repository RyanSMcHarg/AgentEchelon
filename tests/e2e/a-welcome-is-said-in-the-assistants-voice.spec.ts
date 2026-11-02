/**
 * A TARGETED WORKFLOW WELCOME WRITTEN `fill: voice` IS SAID IN THE ASSISTANT'S VOICE, IN A LANGUAGE NOBODY WROTE A VARIANT
 * FOR, AND A RENDER THAT DOES NOT HOLD POSTS THE WRITTEN TEXT (ADR-062 decision 4, "A template declares how it is
 * rendered" and "A `voice` render is bounded"; ADR-061 decision 5, "Metering reuses the join recap's rule"), against the
 * deployed stacks.
 *
 * The unit suite proves each bound with the code's own functions (`a-message-reaches-a-person-in-their-language`, "the
 * voice fill is bounded, and each bound falls back to the written text"). What only a deployment proves is the path end
 * to end:
 *  - the person sets their own language through `POST /me/language`, a declared language the template has no written
 *    variant for, and the router reads it from their profile row;
 *  - the router hands each `voice` send to the classification's processor, which says it by one model call on the
 *    assistant's own session, metered `machineWritten`, and posts one message carrying the outcome (`voiceFill`);
 *  - a render that holds is in the person's language, not the written text, and adds no link and no handle;
 *  - a render that misses its bound (here a deadline of one millisecond, which no model call meets) posts the written
 *    text, in the template's own language, and says so on the message;
 *  - each message is addressed to the person alone.
 *
 * WHAT IS OBSERVED, AND WHAT IS NOT. The model's words are not deterministic, so the spec asserts what is: which step
 * posted, the outcome and the language the message carries, that the voiced text is not the written one, and the tokens
 * the render may not add. The metering itself (`evaluateAbuseGate` with `machineWritten`) leaves no mark on the message; a
 * refused meter would post the written text with `fallback:meter`, so `outcome: voice` is the observable proof the meter
 * allowed the call.
 *
 * THE RUN OWNS WHAT IT CHANGES. The premium primary gets three message templates of its own (an opening, a voiced
 * greeting and a greeting whose deadline cannot be met) and a version whose workflow welcome sends them; the person's
 * language is set to the variant language. Afterwards the version that was active is activated again, the templates'
 * pointers and the person's language are put back, and the conversation is deleted.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/a-welcome-is-said-in-the-assistants-voice.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, signedCall, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { pollFor, readTask } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT } from './helpers/stack-prefix';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, withWorkflowFor } from './helpers/version-under-test';
import { assistantTemplatePointer, readPointer, restorePointer } from './helpers/template-pointer';
import { roomMessagesSeenBy, runKeyOf, stepOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARK = `VOICE-${Date.now().toString(36)}`;
const WORKFLOW = 'e2e-voice-welcome';
const OPENING_TEMPLATE = 'e2e-voice-opening';
const VOICED_TEMPLATE = 'e2e-voice-greeting';
const LATE_TEMPLATE = 'e2e-voice-greeting-late';
/** The written lines. Neither carries a link, a handle or a figure, so anything of the kind in a render was added. */
const VOICED_LINE = 'Welcome to this conversation. Ask me anything you need, whenever you are ready.';
const LATE_LINE = `${MARK} Welcome. This line is said as written, because its render cannot meet its deadline.`;
/** What `voice-fill.ts` refuses a render to add: a link or an `@` handle the written text does not carry. */
const LINK = /\bhttps?:\/\/|\bwww\./i;
const HANDLE = /(^|[^\w])@[\w.-]+/;

/** A message template with one chat line, written only in the deployment's own language. */
function templateSource(name: string, language: string, line: string, voice?: { maxChars?: number; deadlineMs?: number }): string {
  return [
    '---',
    JSON.stringify({
      kind: 'message', name, description: 'E2E: a workflow welcome said in the assistant\'s voice', language, fields: {},
      ...(voice ? { fill: 'voice', voice } : {}),
    }),
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

/** One SSM parameter's value, or '' when it is not there. */
function ssmValue(name: string): string {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v === 'None' ? '' : v;
  } catch {
    return '';
  }
}

test.describe.serial('a targeted workflow welcome is said in the assistant\'s voice, and a render that misses its bound posts the written text (welcome-workflows)', () => {
  guardBackendErrors('a-welcome-is-said-in-the-assistants-voice');

  let admin: VendedCredentials | undefined;
  let clientId = '';
  let primary = '';
  let previousVersion: number | undefined;
  let person: TestUser | null = null;
  let personArn = '';
  let ownLanguage = '';
  let readerLanguage = '';
  /** The person's language before the run: a declared tag, or null when none was set. */
  let languageBefore: string | null | undefined;
  let agentTable = '';
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

    // THE READER'S LANGUAGE: a declared language other than the deployment's own, for which no variant is written.
    const view = await asPerson(person!, clientId, personUrl('/me/language'), 'GET');
    expect(view.status, JSON.stringify(view.body).slice(0, 300)).toBe(200);
    ownLanguage = String(view.body?.deployment || '');
    readerLanguage = ((view.body?.languages ?? []) as Array<{ tag: string }>).map((l) => l.tag).find((t) => t && t !== ownLanguage) ?? '';
    test.skip(!readerLanguage, `the deployment declares only ${ownLanguage || 'one language'}, so no reader can choose one with no written variant (languages in deploy.config.json)`);
    languageBefore = view.body?.language ?? null;

    personArn = await personArnOf(person);
    expect(personArn, 'the person has no AppInstanceUser').toContain('/user/');
    primary = liveAssistantFor('premium');
    for (const name of [OPENING_TEMPLATE, VOICED_TEMPLATE, LATE_TEMPLATE]) {
      const param = assistantTemplatePointer('premium', primary, name);
      pointers.push({ param, before: readPointer(param), saved: false });
    }
    agentTable = ssmValue(`${SSM_ROOT}/shared/tables/agent-tasks-name`);
    expect(agentTable, `${SSM_ROOT}/shared/tables/agent-tasks-name names no table`).toBeTruthy();

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
    if (person && languageBefore !== undefined) {
      const back = await asPerson(person, clientId, personUrl('/me/language'), 'POST', { language: languageBefore }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: the person's language was not set back to ${languageBefore}: ${JSON.stringify(back?.body ?? {}).slice(0, 200)}`);
    }
    if (channelArn) {
      const serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
      if (serviceAdmin) tryTo(`delete the conversation ${channelArn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', channelArn, '--chime-bearer', serviceAdmin]));
    }
  });

  test('the person chooses a language, and the primary activates a version whose workflow welcome is said in its voice', async () => {
    test.setTimeout(180_000);
    const set = await asPerson(person!, clientId, personUrl('/me/language'), 'POST', { language: readerLanguage });
    expect(set.status, JSON.stringify(set.body).slice(0, 300)).toBe(200);
    expect(set.body?.language, 'the setting answers the language it stored').toBe(readerLanguage);

    // THREE TEMPLATES OF THE ASSISTANT'S OWN, each written in the deployment's language only. The two greetings word the
    // shipped `workflow-subject-welcome`, which a model call may be awaited for (`voiceable`); the opening is platform.
    const templates: Array<[string, string, string]> = [
      [OPENING_TEMPLATE, templateSource(OPENING_TEMPLATE, ownLanguage, `${MARK} opening: this conversation is open.`), 'workflow-opening'],
      [VOICED_TEMPLATE, templateSource(VOICED_TEMPLATE, ownLanguage, VOICED_LINE, { maxChars: 600, deadlineMs: 15_000 }), 'workflow-subject-welcome'],
      [LATE_TEMPLATE, templateSource(LATE_TEMPLATE, ownLanguage, LATE_LINE, { deadlineMs: 1 }), 'workflow-subject-welcome'],
    ];
    for (const [i, [, source, words]] of templates.entries()) {
      const saved = await signedCall(adminUrl('assistant-admin', '/admin/templates/save'), admin!, 'POST', { profileName: primary, source, message: words });
      pointers[i].saved = saved.status === 200;
      expect(saved.status, JSON.stringify(saved.body).slice(0, 400)).toBe(200);
    }

    previousVersion = await activateVersionWith(admin!, primary, (body) => {
      return {
        eventWorkflows: withWorkflowFor(body, WORKFLOW, {
            on: 'assistant-joined',
            initial: 'opening',
            states: {
              opening: { send: { to: 'room', template: OPENING_TEMPLATE }, onSuccess: 'voiced', onFailure: 'voiced' },
              voiced: { send: { to: 'subject', template: VOICED_TEMPLATE }, onSuccess: 'late', onFailure: 'late' },
              late: { send: { to: 'subject', template: LATE_TEMPLATE }, onSuccess: 'done', onFailure: 'done' },
              done: { disposition: 'success' },
            },
        }, ['general']),
      };
    });
  });

  test('the voiced greeting is in the person\'s language and adds nothing; the late one is the written text; each is the person\'s alone', async () => {
    test.setTimeout(300_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    // The served version and a person's preferences are each cached for 30 seconds.
    await sleep(SERVED_VERSION_TTL_MS);

    const res = await fetch(personUrl('/create-conversation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idTokenFor(person!.email, person!.password, clientId)}` },
      body: JSON.stringify({ title: `Voice ${MARK}`, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: personArn }),
    });
    const created = await res.json().catch(() => ({}));
    expect(res.status, JSON.stringify(created).slice(0, 300)).toBe(200);
    channelArn = String(created?.conversation?.conversationArn || '');
    expect(channelArn, 'the creation names its conversation').toContain('/channel/');

    // SETTLED: both greetings are posted, each by the processor the router handed it to, and the run has ended.
    const of = (step: string) => (ms: RoomMessage[]) => ms.filter((m) => stepOf(m) === step);
    const seen = await roomMessagesUntil(channelArn, personArn, (ms) => of('voiced')(ms).length > 0 && of('late')(ms).length > 0,
      { timeoutMs: 180_000 });
    const brief = JSON.stringify(seen.filter((m) => m.senderArn.includes('/bot/')).map((m) => ({ step: stepOf(m), voice: m.meta?.voiceFill ?? null, text: m.text.slice(0, 80) })));
    expect(of('voiced')(seen).length, `the voiced greeting was never posted; seen ${brief}`).toBeGreaterThan(0);
    expect(of('late')(seen).length, `the late greeting was never posted; seen ${brief}`).toBeGreaterThan(0);
    const runKey = runKeyOf(of('opening')(seen)[0] ?? of('voiced')(seen)[0]);
    const ended = await pollFor(() => readTask(agentTable, `event-run#${runKey}#step#end`, channelArn), (r) => Boolean(r), { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(ended?.outcome, `the run ${runKey} never ended`).toBe('success');
    const settled = roomMessagesSeenBy(channelArn, personArn);

    // THE VOICED GREETING: one message, rendered by the model in the reader's language, with no link or handle added.
    const voiced = of('voiced')(settled);
    expect(voiced.length, `the voiced greeting was posted once; seen ${brief}`).toBe(1);
    const v = voiced[0];
    expect(v.meta?.voiceFill, `the render's outcome rides the message; seen ${brief}`).toEqual({ target: readerLanguage, language: readerLanguage, outcome: 'voice' });
    expect(v.meta?.trigger, 'the render is a turn no person asked for, timed from its event').toBe('event_step');
    expect(v.text.length, 'the render says something').toBeGreaterThan(0);
    expect(v.text, 'the render is not the written text').not.toBe(VOICED_LINE);
    expect(v.text, 'the render adds no link').not.toMatch(LINK);
    expect(v.text, 'the render adds no handle').not.toMatch(HANDLE);
    expect(v.text.length, 'the render is within its bound').toBeLessThanOrEqual(600);
    expect(v.target, 'the voiced greeting is addressed to the person alone').toEqual([personArn]);
    expect(runKeyOf(v), 'the voiced greeting carries its run').toBe(runKey);

    // THE LATE GREETING: its render cannot meet a one-millisecond deadline, so the written text is posted, in the
    // template's own language, and the message says why.
    const late = of('late')(settled);
    expect(late.length, `the late greeting was posted once; seen ${brief}`).toBe(1);
    const l = late[0];
    expect(l.meta?.voiceFill, `the fallback's outcome rides the message; seen ${brief}`).toEqual({ target: readerLanguage, language: ownLanguage, outcome: 'fallback:deadline' });
    expect(l.text, 'a render that misses its deadline posts the written text').toBe(LATE_LINE);
    expect(l.target, 'the late greeting is addressed to the person alone').toEqual([personArn]);

    // THE OPENING is the room's, said as written: it never waits on a model.
    const opening = of('opening')(settled);
    expect(opening.length, `one opening; seen ${brief}`).toBe(1);
    expect(opening[0].target, 'the opening is posted to the room').toEqual([]);
    expect(opening[0].meta?.voiceFill, 'the opening is a platform send').toBeUndefined();
  });
});
