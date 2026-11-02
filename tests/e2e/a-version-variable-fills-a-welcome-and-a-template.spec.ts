/**
 * ONE VERSION VARIABLE FILLS A WELCOME AND A TARGETED MESSAGE TEMPLATE FROM THE SAME DECLARATION (ADR-060, What proves
 * it, the e2e item), against the deployed router.
 *
 * Unit suites prove each half with the router's own functions (`each-mechanism-reads-the-one-declaration`,
 * `a-variable-gates-what-runs`). What only a deployment proves is the wiring end to end: the served version carries
 * its `variables`, the router reads each workflow send's template through the same `versionLookup`, the value it
 * holds at the welcome (`conversation:type`) reaches both sends, and one send is the room's while the other is
 * targeted to the conversation's one subject.
 *
 * A WORKFLOW WELCOME'S OWN SENDS ARE THE ROOM'S OPENING (ADR-061 decision 5, the `workflow` on `assistant-joined`
 * row: "The room's opening: that run"; decision 9, the `workflow` mode: "The event workflow `welcome.workflow` names
 * ..., whose opening step is a `platform` send"). The version's `welcome.template` is the `structured` opening and
 * is not posted in this mode, so the opening the room reads is the workflow's room send.
 *
 * The run names one variable on the premium primary (`advisor`):
 *   kind = conversation:type, fallback "general"
 * saves two templates of its own whose field binds `kind`: `e2e-variable-opening`, wording `workflow-opening`, and
 * `e2e-variable-greeting`, wording `workflow-subject-welcome`. It activates a version whose workflow welcome sends
 * the first to the room and then the second to the subject. A conversation created the way the chat client creates
 * one is `general`, so both lines say `general`. The version and the templates are rolled back afterward.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `E2E_VERSION_VARIABLES=1`, beside the test credentials and the admin API it needs.
 *
 * **Coverage:** `e2e/a-version-variable-fills-a-welcome-and-a-template.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, signedCall } from './helpers/admin-api';
import { channelArnFor } from './helpers/battle-state-backend';
import { idTokenFor, personArnOf } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
import { aws } from './helpers/aws';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';

const PROFILE = 'advisor';
const OPENING_TEMPLATE = 'e2e-variable-opening';
const TEMPLATE = 'e2e-variable-greeting';
const WORKFLOW = 'e2e-variable-welcome';
const MARK = `VAR-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A template a send says: its one field reads the version's variable `kind`. */
const sourceOf = (name: string, line: string) => [
  '---',
  JSON.stringify({ kind: 'message', name, description: 'E2E: a template field read through a version variable', language: 'en', fields: { kind: 'kind' } }),
  '---',
  '# chat',
  `${MARK} ${line}: this is a {{kind}} conversation.`,
].join('\n');

/** Each template, and the shipped message it words. */
const TEMPLATES = [
  { name: OPENING_TEMPLATE, message: 'workflow-opening', source: sourceOf(OPENING_TEMPLATE, 'opening') },
  { name: TEMPLATE, message: 'workflow-subject-welcome', source: sourceOf(TEMPLATE, 'template') },
];

/** Messages the person can see, with whom each is targeted to. */
function messagesSeenBy(channelId: string, userArn: string): Array<{ sender: string; content: string; target: string[] }> {
  const res = aws(`chime-sdk-messaging list-channel-messages --channel-arn ${channelArnFor(channelId)} --chime-bearer ${userArn} --max-results 50`);
  return (res?.ChannelMessages || []).map((m: any) => ({
    sender: m?.Sender?.Arn || '',
    content: decodeURIComponent(m?.Content || ''),
    target: (m?.Target || []).map((t: any) => t?.MemberArn || ''),
  }));
}

test.describe.serial('one version variable fills a welcome and a targeted template', () => {
  guardBackendErrors('a-version-variable-fills-a-welcome-and-a-template');
  let admin: any;
  let previousVersion: number | undefined;
  const templatesSaved: string[] = [];

  test.beforeAll(async () => {
    test.skip(process.env.E2E_VERSION_VARIABLES !== '1', 'changes a deployed assistant\'s active version; set E2E_VERSION_VARIABLES=1 to run it');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    if (!admin) return;
    if (previousVersion !== undefined) {
      await signedCall(adminUrl('assistant-admin', '/admin/profiles/rollback'), admin, 'POST', { profileName: PROFILE, version: previousVersion }).catch(() => undefined);
    }
    for (const name of templatesSaved) {
      await signedCall(adminUrl('assistant-admin', '/admin/templates/rollback'), admin, 'POST', { profileName: PROFILE, name }).catch(() => undefined);
    }
  });

  test('a version naming the variable activates, with its template and its workflow welcome', async () => {
    test.setTimeout(180_000);
    const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), admin);
    previousVersion = (listing.body?.profiles ?? []).find((p: any) => p.profileName === PROFILE)?.activeVersion ?? undefined;
    expect(previousVersion, `${PROFILE} has no active version to return to`).toBeDefined();

    for (const { name, message, source } of TEMPLATES) {
      const saved = await signedCall(adminUrl('assistant-admin', '/admin/templates/save'), admin, 'POST', { profileName: PROFILE, source, message });
      expect(saved.status, JSON.stringify(saved.body).slice(0, 400)).toBe(200);
      templatesSaved.push(name);
    }

    const created = await signedCall(adminUrl('assistant-admin', '/admin/profiles/version'), admin, 'POST', { profileName: PROFILE });
    expect(created.status, JSON.stringify(created.body).slice(0, 400)).toBe(200);
    const patch = {
      variables: { kind: { source: 'conversation:type', fallback: 'general' } },
      eventWorkflows: {
        [WORKFLOW]: {
          on: 'assistant-joined', initial: 'opening',
          states: {
            // The room's opening: a welcome that runs posts its own sends as the opening (W1, ADR-061 decision 5).
            opening: { send: { to: 'room', template: OPENING_TEMPLATE }, onSuccess: 'greet', onFailure: 'greet' },
            greet: { send: { to: 'subject', template: TEMPLATE }, onSuccess: 'done', onFailure: 'done' },
            done: { disposition: 'success' },
          },
        },
      },
    };
    const edited = await signedCall(adminUrl('assistant-admin', '/admin/profiles/draft'), admin, 'POST', { profileName: PROFILE, patch });
    expect(edited.status, JSON.stringify(edited.body).slice(0, 400)).toBe(200);
    const valid = await signedCall(adminUrl('assistant-admin', '/admin/profiles/validate'), admin, 'POST', { profileName: PROFILE });
    expect(valid.body?.errors ?? [], JSON.stringify(valid.body).slice(0, 600)).toEqual([]);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), admin, 'POST', { profileName: PROFILE });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);
  });

  test('a new conversation: the room\'s opening and the subject\'s targeted line both say the value', async () => {
    test.setTimeout(240_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    // The served version is cached for 30 seconds.
    await sleep(35_000);
    const creds = await getTestCredentials();
    const premium = creds.premiumUser;
    test.skip(!premium?.password, missingUserReason('premiumUser'));
    const premiumArn = await personArnOf(premium);
    const conv = await fetch(personUrl('/create-conversation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idTokenFor(premium.email, premium.password, creds.cognitoClientId)}` },
      body: JSON.stringify({ title: `Variables ${MARK}`, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: premiumArn }),
    });
    expect(conv.status).toBe(200);
    const channelId = ((await conv.json()).conversation.conversationArn as string).split('/channel/')[1];

    let seen: ReturnType<typeof messagesSeenBy> = [];
    const opening = () => seen.find((m) => m.content.includes(`${MARK} opening`));
    const line = () => seen.find((m) => m.content.includes(`${MARK} template`));
    for (const deadline = Date.now() + 150_000; Date.now() < deadline && !(opening() && line()); await sleep(5_000)) {
      seen = messagesSeenBy(channelId, premiumArn);
    }
    expect(opening()?.content, `no opening; seen ${JSON.stringify(seen.slice(0, 5))}`).toContain('this is a general conversation');
    expect(opening()?.target ?? [], 'the opening is the room\'s').toEqual([]);
    expect(line()?.content, `no template line; seen ${JSON.stringify(seen.slice(0, 5))}`).toContain('this is a general conversation');
    expect(line()?.target, 'the template line is addressed to the conversation\'s one subject').toEqual([premiumArn]);
  });
});
