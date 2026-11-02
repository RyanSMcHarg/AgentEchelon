/**
 * THE DEMO'S PEOPLE RECEIVE WHAT THE DEMO SAYS THEY DO.
 *
 * The demo cast (`provision-test-users.mjs --cast ops-demo`, secret `agent-interface/demo-credentials`) are the
 * people the new-assistant demo signs in as. Having an email sent to one of them is one thing; reading the email
 * they received and checking what it says is another, which is why their addresses are on the test inbox's
 * domain when the deployment has one (`backend/scripts/lib/demo-cast.cjs`): an SES receipt rule writes their
 * mail to S3, and this reads it back (`helpers/test-inbox.ts`).
 *
 * THE STEP DRIVEN is the demo's share: the on-call lead opens a premium conversation in the chat app and shares
 * it with the engineering manager through the Share dialog, exactly as a presenter would. The share's welcome to
 * the new member carries the email (`share-conversation` asks the room's primary to say `memberWelcome` with a
 * notify directive, and the email bridge sends it off the message stream). It is the cheapest reliable email the
 * demo produces: it needs no group membership, so it leaves the cast exactly as the demo's setup expects (nobody
 * in `ops` until the presenter ticks it on camera).
 *
 * WHAT IS ASSERTED, from the delivered message:
 *   - RECIPIENT: it is addressed to the manager, and the lead who shared it receives nothing about it.
 *   - DEEP LINK: the body links into THIS conversation (`?conversation=<channel id>`), on the chat app's origin
 *     when the run names it (E2E_BASE_URL), as text and as the HTML button.
 *   - SENDER IDENTITY: From is the deployment's verified sender address under the name of the conversation's
 *     assistant, never the person who shared it; the signature is that assistant's name.
 *   - IT IS ADDRESSED TO THE PERSON: the greeting carries the manager's name, and the footer names where to stop
 *     this kind of email (a share is a `conversation-shared` notice a person can mute).
 *
 * THE SECOND STEP DRIVEN is Act 3.2's trigger: the declared ops event (`ae.ops` / `Incident opened`, the
 * entry `scripts/send-ops-event.mjs` puts) arrives on the default bus naming the on-call lead by address and the
 * team's standing room as its concern, the premium stack's rule hands it to the typed-conversation creator, and
 * an `ops` room opens with the lead in it. The creator welcomes the lead into the room as its primary, and the
 * welcome is emailed. Asserted from the delivered message: addressed to the lead, the subject is the room's
 * label, the link opens THE NEW ROOM, From and the signature name an assistant of that room, and the manager
 * (who is not in `ops`) receives nothing about it. The lead is put in `ops` for the run and returned to the
 * group state they had, because the type admits only the group's members.
 *
 * Gated by DEMO_CAST_MAIL_E2E=1 (validate.mjs --only=demo-cast-mail). Every gate below is a stated skip, which
 * E2E_REQUIRE_ALL=1 turns into a failure (reporters/skip-visibility.ts): a cast with no inbox has not proven
 * what its people receive.
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getDemoCredentials, getDemoInbox, hasDemoCredentials, missingDemoUserReason, DEMO_SECRET_NAME } from './helpers/demo-credentials';
import { personArnOf } from './helpers/person';
import { inboxSkipReason, waitForEmail, emailsTo } from './helpers/test-inbox';
import { stackName, physicalIdsIn, physicalIdsInClassificationStacks, ANY_FUNCTION, INSTANCE, SSM_ROOT } from './helpers/stack-prefix';
import { awsv, awsvText } from './helpers/aws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The ops event builder `scripts/send-ops-event.mjs` sends with (CommonJS, shared with the operator script). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const opsEvent = require('../../backend/scripts/lib/ops-event.cjs') as {
  opsEventEntry: (a: { instance: string; forPerson: string; concernedChannelArn: string; topicLabel?: string; summary?: string }) => Record<string, string>;
};

guardBackendErrors('demo-cast-mail');
guardConsoleErrors();

const RUN = process.env.DEMO_CAST_MAIL_E2E === '1';
const haveCreds = () => Boolean(process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN);
const PLACEHOLDER_SENDER = 'noreply@example.com'; // lib/notification.ts PLACEHOLDER_SENDER

/** The address inside a From header: `"Name" <a@b>` or a bare `a@b`. */
const addressOf = (header: string) => (/<([^>]+)>/.exec(header)?.[1] ?? header).trim().toLowerCase();
/** The display name of a From header, without its quotes; '' when it has none. */
const displayNameOf = (header: string) => (/^\s*"?([^"<]*?)"?\s*</.exec(header)?.[1] ?? '').trim();

/** The sender addresses this deployment's Notifications stack sends from (its functions' SENDER_EMAIL). */
function deployedSenders(): string[] {
  const fns = physicalIdsIn([stackName('Notifications')], ANY_FUNCTION);
  const senders = new Set<string>();
  for (const fn of fns) {
    const v = awsvText(['lambda', 'get-function-configuration', '--function-name', fn,
      '--query', 'Environment.Variables.SENDER_EMAIL', '--output', 'text']).trim();
    if (v && v !== 'None' && v !== PLACEHOLDER_SENDER) senders.add(v.toLowerCase());
  }
  return [...senders];
}

/** A cast member's display name, as provisioning set it on their Cognito user. */
function nameOf(poolId: string, email: string): string {
  const attrs = (awsv(['cognito-idp', 'admin-get-user', '--user-pool-id', poolId, '--username', email])?.UserAttributes ?? []) as Array<{ Name: string; Value: string }>;
  return attrs.find((a) => a.Name === 'name')?.Value || '';
}

/** The display names of the assistants in a conversation, read as one of its members. */
function assistantNamesIn(channelArn: string, bearerArn: string): string[] {
  const r = awsv(['chime-sdk-messaging', 'list-channel-memberships', '--channel-arn', channelArn, '--chime-bearer', bearerArn]);
  return ((r?.ChannelMemberships ?? []) as Array<{ Member?: { Arn?: string; Name?: string } }>)
    .filter((m) => String(m.Member?.Arn || '').includes('/bot/'))
    .map((m) => String(m.Member?.Name || ''))
    .filter(Boolean);
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
  const inFile = path.join(os.tmpdir(), `demo-cast-mail-in-${stamp}.json`);
  const outFile = path.join(os.tmpdir(), `demo-cast-mail-out-${stamp}.json`);
  fs.writeFileSync(inFile, JSON.stringify(payload));
  awsv(['lambda', 'invoke', '--function-name', fn, '--cli-binary-format', 'raw-in-base64-out', '--payload', `fileb://${inFile}`, outFile]);
  try {
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return { ok: false, error: 'no response from the creator' };
  }
}

/** The groups a cast member holds in the pool. */
function groupsOf(poolId: string, email: string): string[] {
  const r = awsv(['cognito-idp', 'admin-list-groups-for-user', '--user-pool-id', poolId, '--username', email]);
  return ((r?.Groups ?? []) as Array<{ GroupName?: string }>).map((g) => String(g.GroupName || ''));
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

test.describe('The demo cast receives the demo\'s mail, and it says what the demo says (demo-cast-mail)', () => {
  test.skip(!RUN, 'DEMO_CAST_MAIL_E2E=1 runs the demo cast mail e2e (validate.mjs --only=demo-cast-mail)');

  test('a share emails the demo person it names, linking into that conversation, from its assistant', async ({ page }) => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasDemoCredentials(), `the demo cast is not provisioned (no ${DEMO_SECRET_NAME} secret). Run: cd backend && npm run provision-test-users -- --cast ops-demo`);
    test.setTimeout(420_000);

    const cast = await getDemoCredentials();
    const lead = cast.onCallLead;
    const manager = cast.engManager;
    test.skip(!lead?.password, missingDemoUserReason('onCallLead'));
    test.skip(!manager?.password, missingDemoUserReason('engManager'));
    const inbox = await getDemoInbox();
    const unavailable = inboxSkipReason(inbox, lead!.email, manager!.email);
    test.skip(Boolean(unavailable), `${unavailable} (the demo cast: npm run provision-test-users -- --cast ops-demo)`);

    const senders = deployedSenders();
    expect(senders.length, `the ${stackName('Notifications')} stack has no function with a real SENDER_EMAIL, so no share email can be sent`).toBeGreaterThan(0);
    const leadArn = await personArnOf(lead!);
    expect(leadArn, 'the on-call lead has no AppInstanceUser').toContain('/user/');
    const managerName = cast.cognitoUserPoolId ? nameOf(cast.cognitoUserPoolId, manager!.email) : '';

    // ── THE STEP: the lead opens a premium conversation and shares it with the manager, in the chat app ──
    const since = Date.now() - 5_000;
    await signIn(page, lead!.email, lead!.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await createConversation(page, `Demo cast mail e2e ${Date.now()}`, 'Premium');
    const channelArn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
    expect(channelArn, 'channelArn from create-conversation').toBeTruthy();
    const channelId = channelArn.split('/').pop() || '';
    await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });

    await page.locator('button[aria-label="Share conversation"]').click();
    await expect(page.locator('#share-email')).toBeVisible({ timeout: 5000 });
    await page.locator('#share-email').fill(manager!.email);
    await page.locator('form:has(#share-email) button[type="submit"]').click();
    await expect(page.locator('.alert-success'), 'the share was not accepted').toBeVisible({ timeout: 30000 });

    // ── WHAT THE MANAGER RECEIVED ────────────────────────────────────────────────────────────────────
    // Other mail may reach the same person (an earlier run, another test), so this one is told apart by the
    // conversation it links into, not by a subject the assistant's copy may word differently.
    const linksHere = (m: { text: string }) => m.text.includes(`?conversation=${channelId}`);
    await waitForEmail(inbox!, { to: manager!.email, since }, 180_000);
    let mail = emailsTo(inbox!, { to: manager!.email, since }).find(linksHere);
    for (let i = 0; i < 24 && !mail; i += 1) {
      await page.waitForTimeout(5_000);
      mail = emailsTo(inbox!, { to: manager!.email, since }).find(linksHere);
    }
    expect(mail, `no email to ${manager!.email} links into the shared conversation ${channelId}`).toBeTruthy();
    console.log(`--- delivered ${mail!.key}\n  from: ${mail!.from}\n  subject: ${mail!.subject}\n${mail!.text.slice(0, 600)}`);

    // RECIPIENT: the manager, and only the manager.
    expect(mail!.to, 'the share email is addressed to the person shared with').toContain(manager!.email.toLowerCase());
    expect(mail!.to, 'the person who shared is not a recipient of the share email').not.toContain(lead!.email.toLowerCase());
    expect(
      emailsTo(inbox!, { to: lead!.email, since }).filter(linksHere),
      'the lead who shared the conversation was emailed about their own share',
    ).toEqual([]);

    // DEEP LINK: into this conversation, on the chat app's origin, as text and as the button.
    const link = new RegExp(`https?://[^\\s"<>]+\\?conversation=${channelId}`).exec(mail!.text)?.[0] || '';
    expect(link, 'the body carries a link into the shared conversation').toBeTruthy();
    if (process.env.E2E_BASE_URL) {
      expect(new URL(link).origin, 'the link opens the deployment\'s chat app').toBe(new URL(process.env.E2E_BASE_URL).origin);
    }
    expect(mail!.html, 'the HTML part carries the same link as its button').toContain(`?conversation=${channelId}`);

    // SENDER IDENTITY: the deployment's sender address, in the name of the conversation's assistant.
    expect(senders, `From ${mail!.from} is not a sender this deployment sends from`).toContain(addressOf(mail!.from));
    expect(addressOf(mail!.from), 'the email is not sent as the person who shared').not.toBe(lead!.email.toLowerCase());
    const assistant = displayNameOf(mail!.from);
    expect(assistant, 'From names the assistant that speaks for the conversation').toBeTruthy();
    expect(assistantNamesIn(channelArn, leadArn), 'From names an assistant of this conversation').toContain(assistant);
    expect(mail!.text, 'the email is signed by the conversation\'s assistant').toContain(assistant);

    // ADDRESSED TO THE PERSON, and stoppable.
    expect(mail!.subject.trim(), 'the email has a subject').toBeTruthy();
    expect(mail!.subject, 'no hidden marker reaches the subject').not.toContain('<!--');
    expect(mail!.text, 'no hidden marker reaches the body').not.toContain('<!--');
    if (managerName) expect(mail!.text, 'the email greets the person by name').toContain(managerName);
    expect(mail!.text, 'a share email names where to stop this kind of email').toMatch(/\/email\/preferences\?t=/);
  });

  test('the ops event opens an ops room for the on-call lead, who is emailed a link into it by its assistant', async () => {
    test.skip(!haveCreds(), 'needs AWS credentials - set AWS_PROFILE');
    test.skip(!hasDemoCredentials(), `the demo cast is not provisioned (no ${DEMO_SECRET_NAME} secret). Run: cd backend && npm run provision-test-users -- --cast ops-demo`);
    test.setTimeout(420_000);

    const cast = await getDemoCredentials();
    const lead = cast.onCallLead;
    const manager = cast.engManager;
    test.skip(!lead?.email, missingDemoUserReason('onCallLead'));
    test.skip(!cast.cognitoUserPoolId, `the ${DEMO_SECRET_NAME} secret names no cognitoUserPoolId; re-run provision-test-users -- --cast ops-demo`);
    const inbox = await getDemoInbox();
    const unavailable = inboxSkipReason(inbox, lead!.email);
    test.skip(Boolean(unavailable), `${unavailable} (the demo cast: npm run provision-test-users -- --cast ops-demo)`);

    // WHAT THE STEP NEEDS DEPLOYED, each a stated skip: the creator, the rule the ops event reaches it by, and
    // the Ops assistant the `ops` type names (a creation without it is refused, by design).
    const creator = premiumResource('AWS::Lambda::Function', /^TypedConversationFromEvent/);
    test.skip(!creator, 'no premium typed-conversation creator on this deployment (no type names premium)');
    const rule = premiumResource('AWS::Events::Rule', /^OpensTypedConversationops0/);
    test.skip(!rule, 'the premium stack has no rule for the ops event; deploy the classification stack that builds it (openedBy on the ops type)');
    const opsLive = (() => {
      try {
        return awsvText(['ssm', 'get-parameter', '--name', `${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`, '--query', 'Parameter.Value', '--output', 'text']);
      } catch {
        return '';
      }
    })();
    test.skip(!opsLive, 'premium has no ops assistant on this deployment; the ops type needs ops-premium in profiles (npm run add-assistant-role)');

    const senders = deployedSenders();
    expect(senders.length, `the ${stackName('Notifications')} stack has no function with a real SENDER_EMAIL, so no welcome can be emailed`).toBeGreaterThan(0);
    const leadArn = await personArnOf(lead!);
    expect(leadArn, 'the on-call lead has no AppInstanceUser').toContain('/user/');
    const poolId = cast.cognitoUserPoolId!;
    const leadName = nameOf(poolId, lead!.email);

    // THE LEAD IS IN `ops` FOR THE RUN, because the type admits the group's members only, and is returned to the
    // state the demo's setup left them in afterwards.
    const wasInOps = groupsOf(poolId, lead!.email).includes('ops');
    if (!wasInOps) awsv(['cognito-idp', 'admin-add-user-to-group', '--user-pool-id', poolId, '--username', lead!.email, '--group-name', 'ops']);
    try {
      // The room the event concerns: the operations team's standing room, which the platform opens directly.
      const team = invokeCreator(creator, { detail: { conversationType: 'ops-team', forUserArn: leadArn, topicLabel: `Demo cast ops team ${Date.now()}` } });
      expect(team.ok, `the standing room was refused: ${team.error}`).toBe(true);

      // ── THE STEP: the ops event, as send-ops-event.mjs puts it, naming the lead by address ──────────────
      const since = Date.now() - 5_000;
      const topic = `Ops event e2e ${Date.now()}`;
      const entry = opsEvent.opsEventEntry({
        instance: INSTANCE, forPerson: lead!.email, concernedChannelArn: team.channelArn!,
        topicLabel: topic, summary: 'Report generation is running slow.',
      });
      const put = awsv(['events', 'put-events', '--entries', JSON.stringify([entry])]);
      expect(put?.FailedEntryCount ?? 1, `the bus refused the ops event: ${JSON.stringify(put?.Entries)}`).toBe(0);

      // ── THE ROOM OPENS FOR THE LEAD ─────────────────────────────────────────────────────────────────
      let roomArn = '';
      for (let i = 0; i < 36 && !roomArn; i += 1) {
        roomArn = leadConversationNamed(leadArn, topic);
        if (!roomArn) await new Promise((r) => setTimeout(r, 5_000));
      }
      expect(roomArn, `no conversation named "${topic}" opened for the lead within 180s; read the TypedConversationFromEvent log for a refusal, and the rule's dead-letter queue`).toBeTruthy();
      const roomId = roomArn.split('/').pop() || '';
      const tags = (awsv(['chime-sdk-messaging', 'list-tags-for-resource', '--resource-arn', roomArn])?.Tags ?? []) as Array<{ Key: string; Value: string }>;
      expect(tags.find((t) => t.Key === 'classification')?.Value, 'the room is at the classification the stack was deployed with').toBe('premium');
      const assistants = assistantNamesIn(roomArn, leadArn);
      expect(assistants.length, 'the ops type names two assistants, and both are in the room').toBeGreaterThanOrEqual(2);

      // ── WHAT THE LEAD RECEIVED ──────────────────────────────────────────────────────────────────────
      const linksHere = (m: { text: string }) => m.text.includes(`?conversation=${roomId}`);
      await waitForEmail(inbox!, { to: lead!.email, since, subjectIncludes: topic }, 180_000);
      let mail = emailsTo(inbox!, { to: lead!.email, since, subjectIncludes: topic }).find(linksHere);
      for (let i = 0; i < 12 && !mail; i += 1) {
        await new Promise((r) => setTimeout(r, 5_000));
        mail = emailsTo(inbox!, { to: lead!.email, since, subjectIncludes: topic }).find(linksHere);
      }
      expect(mail, `no email to ${lead!.email} titled "${topic}" links into the new room ${roomId}`).toBeTruthy();
      console.log(`--- delivered ${mail!.key}\n  from: ${mail!.from}\n  subject: ${mail!.subject}\n${mail!.text.slice(0, 600)}`);

      // RECIPIENT and SUBJECT: the lead, about this room, by its label.
      expect(mail!.to, 'the welcome is addressed to the on-call lead').toContain(lead!.email.toLowerCase());
      expect(mail!.subject, 'the subject is the room\'s label').toContain(topic);
      expect(mail!.subject, 'no hidden marker reaches the subject').not.toContain('<!--');
      expect(mail!.text, 'no hidden marker reaches the body').not.toContain('<!--');

      // DEEP LINK: into the NEW room, as text and as the button, on the chat app's origin when the run names it.
      const link = new RegExp(`https?://[^\\s"<>]+\\?conversation=${roomId}`).exec(mail!.text)?.[0] || '';
      expect(link, 'the body carries a link into the new room').toBeTruthy();
      if (process.env.E2E_BASE_URL) {
        expect(new URL(link).origin, 'the link opens the deployment\'s chat app').toBe(new URL(process.env.E2E_BASE_URL).origin);
      }
      expect(mail!.html, 'the HTML part carries the same link as its button').toContain(`?conversation=${roomId}`);
      expect(mail!.text, 'the email links into the new room, not the room the event concerned').not.toContain(`?conversation=${team.channelArn!.split('/').pop()}`);

      // SENDER IDENTITY: the deployment's sender address, in the name of an assistant of the new room.
      expect(senders, `From ${mail!.from} is not a sender this deployment sends from`).toContain(addressOf(mail!.from));
      const assistant = displayNameOf(mail!.from);
      expect(assistant, 'From names the assistant that speaks for the room').toBeTruthy();
      expect(assistants, 'From names an assistant of the new room').toContain(assistant);
      expect(mail!.text, 'the email is signed by the room\'s assistant').toContain(assistant);

      // ADDRESSED TO THE PERSON, and stoppable.
      if (leadName) expect(mail!.text, 'the email greets the lead by name').toContain(leadName);
      expect(mail!.text, 'the welcome names where to stop this kind of email').toMatch(/\/email\/preferences\?t=/);

      // NOBODY OUTSIDE THE TYPE'S PEOPLE: the manager is not in `ops`, so is not emailed about the room.
      if (manager?.email && inbox && !inboxSkipReason(inbox, manager.email)) {
        expect(emailsTo(inbox, { to: manager.email, since }).filter(linksHere), 'the manager, who is not in ops, was emailed about the ops room').toEqual([]);
      }
    } finally {
      if (!wasInOps) awsv(['cognito-idp', 'admin-remove-user-from-group', '--user-pool-id', poolId, '--username', lead!.email, '--group-name', 'ops']);
    }
  });
});
