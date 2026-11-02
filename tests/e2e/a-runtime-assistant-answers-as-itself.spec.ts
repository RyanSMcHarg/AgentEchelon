/**
 * AN ASSISTANT CREATED IN THE CONSOLE ANSWERS AS ITSELF (ADR-048, `manage-assistants`), against the deployed API.
 *
 * Unit and synthesis tests prove the handler and the policy shape. What only a deployment can prove:
 *   - a team member is refused the admin create, and another team's, by IAM, before any handler runs;
 *   - the build actually completes: Amazon Lex honors the `provisioner=runtime` tag conditions on every
 *     action the runtime build sends, and the identity is created tagged;
 *   - a private message to it reaches ITS Lex bot, the router finds the assistant from that Lex bot's
 *     id, and the reply comes from its own identity speaking its own imported version;
 *   - retire deletes the identity and the Lex bot, and the name is never reused.
 *
 * It creates, uses and retires one assistant with a fresh name per run.
 */
import { test, expect } from './helpers/fixtures';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { exchange, signedCall } from './helpers/admin-api';
import { appInstanceArn, channelArnFor, sendTargetedAs } from './helpers/battle-state-backend';
import { idTokenFor, personArnOf } from './helpers/person';
import { guardBackendErrors } from './helpers/turn-guards';
import { INSTANCE } from './helpers/stack-prefix';
import { aws, awsv } from './helpers/aws';
import { ADMIN_API_URL, PERSON_API_URL, adminUrl, personUrl } from './helpers/api-urls';

const REGION = process.env.AWS_REGION || 'us-east-1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Messages the sender can see, newest first: a targeted reply is visible to its target. */
function messagesSeenBy(channelId: string, userArn: string): Array<{ sender: string; content: string }> {
  const res = aws(`chime-sdk-messaging list-channel-messages --channel-arn ${channelArnFor(channelId)} --chime-bearer ${userArn} --max-results 25`);
  return (res?.ChannelMessages || []).map((m: any) => ({ sender: m?.Sender?.Arn || '', content: decodeURIComponent(m?.Content || '') }));
}

test.describe.serial('a runtime assistant answers as itself', () => {
  guardBackendErrors('a-runtime-assistant-answers-as-itself');
  const assistantId = `e2e-rt-${Date.now().toString(36)}`;
  const marker = `RT-OK-${assistantId}`;
  let adminSession: any;
  let botArn = '';
  let lexBotId = '';
  let created = false;

  test.beforeAll(async () => {
    test.skip(!hasTestCredentials(), 'test credentials are not available');
    test.skip(!ADMIN_API_URL, 'VITE_ADMIN_API_URL is not set');
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();
    const session = await exchange(idTokenFor(admin.email, admin.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, `console session: ${JSON.stringify(session.body).slice(0, 300)}`).toBe(200);
    adminSession = session.body.credentials;
  });

  test.afterAll(async () => {
    // Best effort: never leave a runtime assistant behind a failed run.
    if (created && adminSession) {
      await signedCall(adminUrl('assistant-admin', `/admin/roster/${assistantId}/retire`), adminSession, 'POST', { reason: 'e2e cleanup' }).catch(() => undefined);
    }
  });

  const body = {
    assistantId,
    classification: 'premium',
    role: 'primary',
    displayName: `E2E ${assistantId.slice(-6)}`,
    descriptor: { modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 120 },
  };

  test('a team member is refused the admin create and another team\'s, by IAM', async () => {
    // THE DEPLOYED POLICIES, asked directly: the team console role may not invoke either admin roster
    // route, and the admin console role may. A team creates only on its own team route, which the role
    // boundary holds with the team as a wildcard and each console session narrows to the person's teams.
    const account = aws('sts get-caller-identity').Account;
    const apiId = new URL(ADMIN_API_URL).hostname.split('.')[0];
    // AdminApi is an HTTP API on its `$default` stage. Passed without a shell, so the `$` stays literal.
    const stage = '$default';
    const decide = (role: string, route: string) => awsv([
      'iam', 'simulate-principal-policy',
      '--policy-source-arn', `arn:aws:iam::${account}:role/${INSTANCE}-${role}`,
      '--action-names', 'execute-api:Invoke',
      '--resource-arns', `arn:aws:execute-api:${REGION}:${account}:${apiId}/${stage}/POST/${route}`,
      '--query', 'EvaluationResults[0].EvalDecision',
    ]);
    for (const route of ['admin/roster', `admin/roster/${assistantId}/retire`]) {
      expect(decide('team-console', route), `team console on ${route}`).not.toBe('allowed');
      expect(decide('admin-console', route), `admin console on ${route}`).toBe('allowed');
    }
    expect(decide('team-console', 'admin/teams/ops/roster'), 'team console on a team roster route').toBe('allowed');

    // AND LIVE: the session the exchange vends names the person's own teams only, so the admin route and
    // another team's route are both refused before any handler runs.
    const creds = await getTestCredentials();
    test.skip(!creds.teamOpsUser?.password, missingUserReason('teamOpsUser'));
    const session = await exchange(idTokenFor(creds.teamOpsUser!.email, creds.teamOpsUser!.password, creds.cognitoClientId), { identity: 'console' });
    expect(session.status, JSON.stringify(session.body).slice(0, 300)).toBe(200);
    const res = await signedCall(adminUrl('assistant-admin', '/admin/roster'), session.body.credentials, 'POST', body);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403);
    const otherTeam = 'not-my-team';
    const other = await signedCall(adminUrl('assistant-admin', `/admin/teams/${otherTeam}/roster`), session.body.credentials, 'POST', { ...body, ownerTeam: otherTeam });
    expect(other.status, JSON.stringify(other.body).slice(0, 300)).toBe(403);
  });

  test('an admin creates it, and it is built with a Lex bot and an identity of its own, tagged runtime', async () => {
    test.setTimeout(600_000);
    const res = await signedCall(adminUrl('assistant-admin', '/admin/roster'), adminSession, 'POST', body);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(202);
    created = true;

    // The build is asynchronous; the roster says when it is done.
    let entry: any;
    for (const deadline = Date.now() + 480_000; Date.now() < deadline; await sleep(15_000)) {
      const listing = await signedCall(adminUrl('assistant-admin', '/admin/profiles'), adminSession);
      entry = (listing.body?.runtimeAssistants ?? []).find((a: any) => a.assistant === assistantId);
      if (entry && entry.status !== 'provisioning') break;
    }
    expect(entry?.status, `the build ended ${JSON.stringify(entry)}`).toBe('active');

    const record = JSON.parse(aws(`ssm get-parameter --name /${INSTANCE}/assistant-assignments/premium/primary/assistants/${assistantId}`).Parameter.Value);
    expect(record).toMatchObject({ source: 'runtime', status: 'active', occupancy: 'live', assistant: assistantId });
    botArn = record.botArn;
    lexBotId = record.lexBotId;
    expect(botArn.startsWith(`${appInstanceArn()}/bot/`)).toBe(true);

    const tags = Object.fromEntries((aws(`chime-sdk-identity list-tags-for-resource --resource-arn ${botArn}`).Tags || []).map((t: any) => [t.Key, t.Value]));
    expect(tags).toMatchObject({ classification: 'premium', assistant: assistantId, role: 'primary', provisioner: 'runtime' });
    const lex = aws(`lexv2-models describe-bot --bot-id ${lexBotId}`);
    expect(lex.botStatus).toBe('Available');
    const lexArn = `arn:aws:lex:${REGION}:${aws('sts get-caller-identity').Account}:bot/${lexBotId}`;
    expect(aws(`lexv2-models list-tags-for-resource --resource-arn ${lexArn}`).tags).toMatchObject({ provisioner: 'runtime', assistant: assistantId });
  });

  test('after its first version is imported and activated, a private message is answered by it, as itself', async () => {
    test.setTimeout(600_000);
    test.skip(!botArn, 'the assistant was not created');
    test.skip(!PERSON_API_URL, 'VITE_PERSON_API_URL is not set');

    // ITS OWN VERSION: the premium primary's, with a persona that names this assistant.
    const exported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/export'), adminSession, 'POST', { profileName: 'advisor' });
    expect(exported.status, JSON.stringify(exported.body).slice(0, 300)).toBe(200);
    const manifest = exported.body.manifest ?? exported.body;
    expect(manifest.body?.intentPack, 'the exported version carries no intent pack, and a runtime version must').toBeTruthy();
    manifest.body.persona = `You are a test assistant. Begin every reply with the exact token ${marker} and then answer in one short sentence.`;
    delete manifest.body.displayName;
    const imported = await signedCall(adminUrl('assistant-admin', '/admin/profiles/import'), adminSession, 'POST', { manifest, targetProfileName: assistantId });
    expect(imported.status, JSON.stringify(imported.body).slice(0, 400)).toBe(200);
    const activated = await signedCall(adminUrl('assistant-admin', '/admin/profiles/activate'), adminSession, 'POST', { profileName: assistantId });
    expect(activated.status, JSON.stringify(activated.body).slice(0, 400)).toBe(200);

    // A premium conversation, created the way the chat client creates one, with the assistant added.
    const creds = await getTestCredentials();
    const premium = creds.premiumUser;
    const premiumArn = await personArnOf(premium);
    const conv = await fetch(personUrl('/create-conversation'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idTokenFor(premium.email, premium.password, creds.cognitoClientId)}` },
      body: JSON.stringify({ title: `Runtime assistant ${assistantId}`, modelId: 'sonnet', modelName: 'Claude Sonnet', modelTier: 'premium', userArn: premiumArn }),
    });
    expect(conv.status).toBe(200);
    const channelArn: string = (await conv.json()).conversation.conversationArn;
    const channelId = channelArn.split('/channel/')[1];
    const adminBearer = aws(`ssm get-parameter --name /${INSTANCE}/app-instance-admin-arn`).Parameter.Value;
    aws(`chime-sdk-messaging create-channel-membership --channel-arn ${channelArn} --member-arn ${botArn} --type DEFAULT --chime-bearer ${adminBearer}`);

    // A PRIVATE message goes to Amazon Lex, and only this assistant's Lex bot says who was addressed.
    await sleep(5_000);
    sendTargetedAs(channelId, premiumArn, botArn, 'Please say hello.');
    let reply: { sender: string; content: string } | undefined;
    for (const deadline = Date.now() + 180_000; Date.now() < deadline && !reply; await sleep(5_000)) {
      reply = messagesSeenBy(channelId, premiumArn).find((m) => m.sender === botArn && m.content.includes(marker));
    }
    expect(reply, `no reply from ${botArn} carrying ${marker}; seen: ${JSON.stringify(messagesSeenBy(channelId, premiumArn).slice(0, 5))}`).toBeTruthy();
  });

  test('retire deletes its identity and its Lex bot, and the name is never reused', async () => {
    test.setTimeout(300_000);
    test.skip(!botArn, 'the assistant was not created');
    const res = await signedCall(adminUrl('assistant-admin', `/admin/roster/${assistantId}/retire`), adminSession, 'POST', { reason: 'e2e' });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    created = false;
    // A deleted bot answers Describe with Forbidden, so absence is read from the app instance's list.
    const listed = (aws(`chime-sdk-identity list-app-instance-bots --app-instance-arn ${appInstanceArn()} --max-results 50`).AppInstanceBots || [])
      .map((b: any) => b.AppInstanceBotArn);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toContain(botArn);
    let lexGone = false;
    for (const deadline = Date.now() + 120_000; Date.now() < deadline && !lexGone; await sleep(10_000)) {
      try { lexGone = aws(`lexv2-models describe-bot --bot-id ${lexBotId}`).botStatus === 'Deleting'; } catch { lexGone = true; }
    }
    expect(lexGone, 'the Lex bot is neither gone nor deleting').toBe(true);
    const again = await signedCall(adminUrl('assistant-admin', '/admin/roster'), adminSession, 'POST', body);
    expect(again.status).toBe(409);
    expect(again.body?.code).toBe('ASSISTANT_NAME_TAKEN');
  });
});
