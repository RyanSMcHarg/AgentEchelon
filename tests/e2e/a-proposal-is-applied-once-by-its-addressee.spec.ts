/**
 * AN AGENT STEP'S PROPOSAL IS OFFERED TO ITS ONE ADDRESSEE ON A CONFIRMATION CARD, AND IS APPLIED ONCE, BY THEM ALONE
 * (ADR-061 decision 8, rules 6 to 8, "As built"; the platform's `chase-unredeemed`), against the deployed stacks.
 *
 * The unit suite proves each rule with the code's own functions (`a-proposal-is-applied-once-by-its-addressee`). What
 * only a deployment proves is the path end to end:
 *  - an invitation's `invitation-unredeemed` deadline fires and the router hands the version's agent step, which proposes
 *    `send_nudge`, to the processor; the turn drafts the reminder and the processor writes a single-use `proposal`
 *    record on the assistant's session and posts the card, a message targeted at the inviter alone whose Metadata
 *    carries the proposal's handle;
 *  - `POST /proposals/apply`, called by another member of the conversation with that handle, is refused as not the
 *    addressee and changes nothing;
 *  - called by the inviter, it is applied: the invitations function sets `nudgedAt` on the invitation's record and emails
 *    the address the inviter typed, and the proposal records `applied`;
 *  - a second apply by the inviter is refused as decided, and the reminder is sent once: one email reaches the address.
 *
 * THE DRAFT IS A MODEL'S. A turn that misses its deadline, or whose draft carries a link, a handle or an address, posts
 * the step's fallback instead of a card (decision 8, rule 6); the spec says which it read, and fails, since the card is
 * what it is here to prove.
 *
 * THE RUN OWNS WHAT IT CHANGES. The premium primary gets a version whose `invitation-unredeemed` workflow is
 * `chase-unredeemed` at the shortest deadline a workflow may declare (five minutes), and declares no `invitation-sent`
 * workflow. The reminder goes to an address on the test inbox's domain made for this run. Afterwards the invitation is
 * revoked (which ends the reminder's second link with it), the version that was active is activated again, and the
 * conversation is deleted.
 *
 * GATED: it changes a deployed assistant's active version for its duration, so it runs only with
 * `WELCOME_WORKFLOWS_E2E=1` (validate.mjs --only=welcome-workflows). The test inbox is required, because the act this
 * proves happens once is an email. Every other gate names the dependency that is absent.
 *
 * **Coverage:** `e2e/a-proposal-is-applied-once-by-its-addressee.spec.ts`
 */
import { test, expect, declareWait } from './helpers/fixtures';
import { MIN_DEADLINE_MINUTES } from '../../backend/lambda/src/lib/event-workflow';
import { createHash } from 'crypto';
import { guardBackendErrors } from './helpers/turn-guards';
import { getAdminUser, getSecondPremiumUser, getTestCredentials, hasTestCredentials, missingUserReason, type TestUser } from './helpers/test-credentials';
import { exchange, type VendedCredentials } from './helpers/admin-api';
import { ADMIN_API_URL, PERSON_API_URL, personApiServes, personUrl } from './helpers/api-urls';
import { idTokenFor, personArnOf } from './helpers/person';
import { liveAssistantFor } from './helpers/battle-setup';
import { unmarshalItem } from './helpers/task-backend';
import { awsv, awsvText } from './helpers/aws';
import { SSM_ROOT, physicalIdsIn, stackName } from './helpers/stack-prefix';
import { SERVED_VERSION_TTL_MS, activateVersionWith, returnToVersion, workflowsOffEvents } from './helpers/version-under-test';
import { eventOf, roomMessagesSeenBy, runKeyOf, type RoomMessage, roomMessagesUntil } from './helpers/event-run-messages';
import { emailsTo, getTestInbox, inboxSkipReason, waitForEmail, type TestInbox } from './helpers/test-inbox';
import { INVITATIONS_BY_CHANNEL, INVITATION_CHANNEL_ATTRIBUTE } from '../../backend/lambda/src/lib/invitations';

const RUN = process.env.WELCOME_WORKFLOWS_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MARK = `NUDGE-${Date.now().toString(36)}`;
const WORKFLOW = 'e2e-chase-unredeemed';
const STEP = 'draft-nudge';
/** The shortest deadline a workflow may declare, read from the platform so the spec follows it. */
const DEADLINE_MINUTES = MIN_DEADLINE_MINUTES;

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

/** A proposal's record by the handle its card carries: the token store keys it by the handle's hash (`tokenKey`). */
function proposalRecord(table: string, handle: string): Record<string, any> | undefined {
  const pk = `proposal#${createHash('sha256').update(handle, 'utf8').digest('hex')}`;
  const item = awsv(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ pk: { S: pk } }), '--consistent-read'])?.Item;
  return item ? unmarshalItem(item) : undefined;
}

/** An invitation's record, read through the conversation's index as the invitations function reads it. */
function invitationRecord(table: string, channelArn: string, invitationId: string): Record<string, any> | undefined {
  const r = awsv(['dynamodb', 'query', '--table-name', table, '--index-name', INVITATIONS_BY_CHANNEL,
    '--key-condition-expression', '#c = :c', '--expression-attribute-names', JSON.stringify({ '#c': INVITATION_CHANNEL_ATTRIBUTE }),
    '--expression-attribute-values', JSON.stringify({ ':c': { S: channelArn } })]);
  const found = ((r?.Items ?? []) as any[]).map(unmarshalItem).find((i) => i.invitationId === invitationId && !i.aliasOf);
  return found;
}

test.describe.serial('a proposal is applied once, by its addressee alone (welcome-workflows)', () => {
  guardBackendErrors('a-proposal-is-applied-once-by-its-addressee');

  let admin: VendedCredentials | undefined;
  let clientId = '';
  let primary = '';
  let previousVersion: number | undefined;
  let inviter: TestUser | null = null;
  let other: TestUser | null = null;
  let inviterArn = '';
  let otherArn = '';
  let tokensTable = '';
  let inbox: TestInbox | null = null;
  let address = '';
  let channelArn = '';
  let invitationId = '';

  test.beforeAll(async () => {
    test.skip(!RUN, 'changes a deployed assistant\'s active version; set WELCOME_WORKFLOWS_E2E=1 to run it (validate.mjs --only=welcome-workflows)');
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL || !PERSON_API_URL, 'VITE_ADMIN_API_URL and VITE_PERSON_API_URL are needed');
    test.skip(!personApiServes('notifications'), 'PersonApi does not serve the notifications capability, whose route a share is (/share-conversation)');
    const adminUser = await getAdminUser();
    test.skip(!adminUser.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    test.skip(!creds.premiumUser?.password, missingUserReason('premiumUser'));
    const second = await getSecondPremiumUser();
    test.skip(!second?.password, missingUserReason('secondPremiumUser'));
    inviter = creds.premiumUser;
    other = second;
    clientId = creds.cognitoClientId;

    // THE ACT IS AN EMAIL, so the address the inviter types is one the test inbox receives.
    inbox = await getTestInbox();
    const noInbox = inboxSkipReason(inbox);
    test.skip(Boolean(noInbox), noInbox);
    address = `nudge-${MARK.toLowerCase()}@${inbox!.domain}`;

    // EVERY INVITATION LANDS IN THE CHAT APP, and a reminder carries a link, so the invitations function has a landing.
    const invitationsFn = physicalIdsIn([stackName('Conversations')], { type: 'AWS::Lambda::Function', logicalId: /^InvitationsFunction/ })[0] || '';
    expect(invitationsFn, `${stackName('Conversations')} has no InvitationsFunction`).toBeTruthy();
    const landing = awsvText(['lambda', 'get-function-configuration', '--function-name', invitationsFn,
      '--query', 'Environment.Variables.INVITATION_LANDING_ORIGIN', '--output', 'text']).trim();
    expect(landing && landing !== 'None', `${invitationsFn} has no INVITATION_LANDING_ORIGIN; deploy this branch's Conversations stack`).toBeTruthy();
    tokensTable = ssmValue(`${SSM_ROOT}/shared/tables/tokens-name`);
    expect(tokensTable, `${SSM_ROOT}/shared/tables/tokens-name names no table`).toBeTruthy();

    inviterArn = await personArnOf(inviter);
    otherArn = await personArnOf(other!);
    expect(inviterArn, 'the inviter has no AppInstanceUser').toContain('/user/');
    expect(otherArn, 'the other member has no AppInstanceUser').toContain('/user/');
    primary = liveAssistantFor('premium');

    const session = await exchange(idTokenFor(adminUser.email, adminUser.password, clientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    admin = session.body.credentials;
  });

  test.afterAll(async () => {
    const tryTo = (what: string, fn: () => void) => {
      try { fn(); } catch (err) { console.warn(`cleanup: could not ${what}: ${(err as Error).message.slice(0, 200)}`); }
    };
    if (inviter && channelArn && invitationId) {
      const back = await asPerson(inviter, clientId, personUrl('/invitations/revoke'), 'POST', { channelArn, invitationId }).catch(() => undefined);
      if (back?.status !== 200) console.warn(`cleanup: the invitation was not revoked: ${JSON.stringify(back?.body ?? {}).slice(0, 200)}`);
    }
    if (admin && previousVersion !== undefined) await returnToVersion(admin, primary, previousVersion);
    if (channelArn) {
      const serviceAdmin = ssmValue(`${SSM_ROOT}/app-instance-admin-arn`);
      if (serviceAdmin) tryTo(`delete the conversation ${channelArn}`, () => awsv(['chime-sdk-messaging', 'delete-channel', '--channel-arn', channelArn, '--chime-bearer', serviceAdmin]));
    }
  });

  test('the primary activates a version whose invitation-unredeemed workflow proposes a reminder to the inviter', async () => {
    test.setTimeout(180_000);
    previousVersion = await activateVersionWith(admin!, primary, (body) => ({
      eventWorkflows: {
        ...workflowsOffEvents(body, ['invitation-sent', 'invitation-unredeemed']),
        // THE PLATFORM'S `chase-unredeemed`, as a version copies it, at the shortest deadline a workflow may declare.
        [WORKFLOW]: {
          on: 'invitation-unredeemed',
          deadline: { afterMinutes: DEADLINE_MINUTES },
          initial: STEP,
          states: {
            [STEP]: {
              agent: {
                prompt: 'invitation-nudge-draft',
                propose: ['send_nudge'],
                to: { people: 'invitation:inviter' },
                deadlineMs: 20_000,
                fallback: { send: { to: { people: 'invitation:inviter' }, template: 'invitation-unredeemed-reminder' } },
              },
              onSuccess: 'done',
              onFailure: 'done',
            },
            done: { disposition: 'success' },
          },
        },
      },
    }));
  });

  test('the card reaches the inviter alone; another member is refused, the inviter applies it once, and the reminder is sent once', async () => {
    test.setTimeout(DEADLINE_MINUTES * 60_000 + 600_000);
    test.skip(previousVersion === undefined, 'the version was not activated');
    await sleep(SERVED_VERSION_TTL_MS);

    const conv = await asPerson(inviter!, clientId, personUrl('/create-conversation'), 'POST', {
      title: `Proposals ${MARK}`, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: inviterArn,
    });
    expect(conv.status, JSON.stringify(conv.body).slice(0, 300)).toBe(200);
    channelArn = String(conv.body?.conversation?.conversationArn || '');
    expect(channelArn, 'the creation names its conversation').toContain('/channel/');

    // ANOTHER MEMBER, added the way the chat app's Share dialog adds one, so the refusal is not for want of membership.
    const shared = await asPerson(inviter!, clientId, personUrl('/share-conversation'), 'POST', {
      conversationArn: channelArn, conversationTitle: `Proposals ${MARK}`, recipientEmail: other!.email,
    });
    expect(shared.status, JSON.stringify(shared.body).slice(0, 300)).toBe(200);

    // THE INVITATION, with no address, so nothing is emailed when it is sent.
    const invited = await asPerson(inviter!, clientId, personUrl('/invitations'), 'POST', { channelArn, name: `Invitee ${MARK}` });
    expect(invited.status, JSON.stringify(invited.body).slice(0, 300)).toBe(201);
    invitationId = String(invited.body?.invitation?.invitationId || '');
    expect(invitationId, 'the invitation answers its id').toBeTruthy();
    declareWait('the invitation-unredeemed deadline', Date.now() + DEADLINE_MINUTES * 60_000);

    // THE DEADLINE FIRES and the step posts one message to the inviter: the card, or its fallback.
    const ofStep = (m: RoomMessage) => eventOf(m) === 'invitation-unredeemed' && runKeyOf(m) === `invitation-unredeemed#invitation-${invitationId}#${primary}`;
    const seen = await roomMessagesUntil(channelArn, inviterArn, (ms) => ms.some(ofStep),
      { timeoutMs: DEADLINE_MINUTES * 60_000 + 240_000 });
    const posted = seen.filter(ofStep);
    const brief = JSON.stringify(posted.map((m) => ({ step: m.meta?.eventStep?.step, outcome: m.meta?.eventStep?.outcome, card: Boolean(m.meta?.proposal), text: m.text.slice(0, 100) })));
    expect(posted.length, `the deadline's step posted once; seen ${brief}`).toBe(1);
    const card = posted[0];
    expect(card.meta?.eventStep?.outcome, `the step posted its draft as a card rather than its fallback; seen ${brief}`).toBe('posted');
    const handle = String(card.meta?.proposal?.id || '');
    expect(handle, `the card carries the proposal's handle on its Metadata; seen ${brief}`).toBeTruthy();
    expect(card.meta?.proposal?.op, 'the card proposes the reminder').toBe('send_nudge');
    expect(card.target, 'the card is addressed to the inviter alone').toEqual([inviterArn]);
    expect(roomMessagesSeenBy(channelArn, otherArn).some((m) => m.messageId === card.messageId), 'another member does not receive the card').toBe(false);

    // THE RECORD, before anyone decided it: addressed to the inviter, as the invitation's inviter, and undecided.
    const before = proposalRecord(tokensTable, handle);
    expect(before?.personArn, 'the proposal names its addressee').toBe(inviterArn);
    expect(before?.addressedAs, 'the proposal records how its addressee was addressed').toBe('invitation:inviter');
    expect(before?.invitationId, 'the proposal names its invitation').toBe(invitationId);
    expect(before?.decision, 'nobody has decided the proposal yet').toBeUndefined();
    expect(invitationRecord(tokensTable, channelArn, invitationId)?.nudgedAt, 'the invitation was not reminded before the apply').toBeUndefined();

    const apply = (who: TestUser) => asPerson(who, clientId, personUrl('/proposals/apply'), 'POST', { proposal: handle, decision: 'apply', address });

    // DENY: another member of the conversation is refused, and nothing is decided or done.
    const byOther = await apply(other!);
    expect(byOther.status, JSON.stringify(byOther.body).slice(0, 300)).toBe(403);
    expect(JSON.stringify(byOther.body), 'another member is refused as not the addressee').toContain('NOT_ADDRESSEE');
    expect(proposalRecord(tokensTable, handle)?.decision, 'a refused apply decides nothing').toBeUndefined();
    expect(invitationRecord(tokensTable, channelArn, invitationId)?.nudgedAt, 'a refused apply reminds nobody').toBeUndefined();

    // THE ADDRESSEE APPLIES IT: the reminder is sent, the invitation records it, and the proposal records applied.
    const sinceApply = Date.now() - 5_000;
    const byInviter = await apply(inviter!);
    expect(byInviter.status, JSON.stringify(byInviter.body).slice(0, 300)).toBe(200);
    expect(byInviter.body, 'the apply answers what it did').toMatchObject({ applied: true, op: 'send_nudge', sent: true });
    expect(proposalRecord(tokensTable, handle)?.decision, 'the proposal records applied').toBe('applied');
    const nudgedAt = invitationRecord(tokensTable, channelArn, invitationId)?.nudgedAt;
    expect(nudgedAt, 'the invitation records the reminder').toBeTruthy();

    // ONCE: a second apply by the addressee is refused, and so is another member's after it.
    const again = await apply(inviter!);
    expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(409);
    expect(JSON.stringify(again.body), 'a second apply is refused as decided').toContain('PROPOSAL_DECIDED');
    const otherAgain = await apply(other!);
    expect(otherAgain.status, JSON.stringify(otherAgain.body).slice(0, 300)).toBe(403);

    // THE ACT HAPPENED ONCE: one reminder reached the address, and the invitation's record was reminded once.
    await waitForEmail(inbox!, { to: address, since: sinceApply }, 180_000);
    await sleep(30_000);
    expect(emailsTo(inbox!, { to: address, since: sinceApply }).length, 'one reminder reached the address the inviter typed').toBe(1);
    expect(invitationRecord(tokensTable, channelArn, invitationId)?.nudgedAt, 'the reminder was recorded once').toBe(nudgedAt);
    expect(proposalRecord(tokensTable, handle)?.decision, 'the proposal stays applied').toBe('applied');
  });
});
