#!/usr/bin/env node
/**
 * Live deny-test for the BEARER PIN: the `person` session tag (SPEC-CREDENTIAL-EXCHANGE section 5,
 * SPEC-CONVERSATION-SECURITY section 4d).
 *
 * Every person credential the exchanges vend carries the session tag `person=<AppInstanceUser id>`,
 * and every person role pins the Amazon Chime SDK bearer to `${appInstanceArn}/user/${aws:PrincipalTag/person}`.
 * The admin-plane role pins `${aws:PrincipalTag/person}-admin`. So a session vended for person A can
 * act as A and nobody else. This script proves that on the deployed roles, two ways:
 *
 *   1. SIMULATION. `aws iam simulate-principal-policy` against each deployed person role, with the
 *      context key `aws:PrincipalTag/person=A`: `chime:Connect`, `chime:SendChannelMessage` and
 *      `chime:ListChannelMessages` on A's AppInstanceUser are allowed (the control) and on B's are
 *      denied. On the admin-plane role, `A-admin` is allowed and `B-admin` denied. On every non-admin
 *      role, `A-admin` is denied: a chat session does not reach its owner's admin twin.
 *   2. LIVE. Real credentials from the deployed exchange for test user A, used against a real
 *      channel that has A and B as members:
 *        - SendChannelMessage and ListChannelMessages bearing A succeed (the control: a refusal of any kind,
 *          IAM's or the membership check's, fails it, because a control that is refused proves nothing);
 *        - the same calls bearing B are AccessDenied;
 *        - the same calls bearing `A-admin` are AccessDenied (a non-admin session);
 *        - a signed `chime:Connect` WebSocket upgrade as B is refused, and as A it is not.
 *      The same live checks run for a host app's pool the trusted-issuer registry declares with the
 *      one-conversation session, through the same exchange, when the test secret names its user.
 *
 * B is a member of the channel, so a refusal of B's bearer is IAM's and not the membership check: a
 * non-member is refused by the Amazon Chime SDK with a different error, which this script does not count
 * as a pass.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-bearer-pin.mjs
 *
 * Test secret (`TEST_SECRET_NAME`, default `agent-interface/test-credentials`): `cognitoClientId`,
 * `basicUser` (A) and `premiumUser` (B), each `{ email, password }`. For a host app's pool also
 * `federatedClientId` and `federatedUser` `{ email, password }`. A secret without that user skips the
 * host-pool live half with the reason printed; set
 * `REQUIRE_FEDERATED=1` to fail instead.
 *
 * Exit 0 = every asserted deny and control held; 1 = a gap; 2 = a setup error.
 */
// IAM through the CLI, as the other deny-tests do: `@aws-sdk/client-iam` is not a dependency here.
import { execFileSync } from 'child_process';
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  DeleteChannelCommand,
  GetMessagingSessionEndpointCommand,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { appInstanceArnOf, userArnFor } = require('./lib/person-arn.cjs');
const { exitWhenDrained } = require('./lib/exit-when-drained.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK = process.env.COGNITO_STACK || `${resolveStackPrefix(process.env)}Identity`;
const ADMIN_STACK = `${resolveStackPrefix(process.env)}AdminServices`;
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const REQUIRE_FEDERATED = process.env.REQUIRE_FEDERATED === '1';
const ACTIONS = ['chime:Connect', 'chime:SendChannelMessage', 'chime:ListChannelMessages'];

const cfn = new CloudFormationClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const skip = (m) => {
  if (REQUIRE_FEDERATED) fail(`required but skipped: ${m}`);
  else console.log(`  SKIP  ${m}`);
};

function awsIam(args) {
  const out = execFileSync('aws', ['iam', ...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, AWS_REGION: REGION },
  });
  return out.trim() ? JSON.parse(out) : {};
}

/**
 * The exchange roles, by logical id, from the stacks that hold them: a conversational classification's vend
 * role is its `Assistants-<classification>` stack's, the admin plane's and the one-conversation role are
 * Identity's, and the admin backend's admin-plane role is AdminServices' (absent on a deployment without the
 * `admin` capability).
 */
async function exchangeRoleResources() {
  const out = [];
  const { listStackNames, classificationStacksAmong, listStackResources } = require('./lib/stack-resources.cjs');
  const prefix = resolveStackPrefix(process.env);
  for (const StackName of classificationStacksAmong(await listStackNames(cfn), prefix)) {
    out.push(...(await listStackResources(cfn, StackName)));
  }
  for (const StackName of [STACK, ADMIN_STACK]) {
    try {
      const r = await cfn.send(new DescribeStackResourcesCommand({ StackName }));
      out.push(...(r.StackResources || []));
    } catch (e) {
      if (StackName === ADMIN_STACK && /does not exist/.test(String(e?.message || e))) continue;
      throw e;
    }
  }
  return out.filter((x) => x.ResourceType === 'AWS::IAM::Role' && /^ExchangeRole/.test(x.LogicalResourceId || ''));
}

/** The deployed person roles and the admin-plane role, by logical id. */
async function deployedExchangeRoles() {
  return (await exchangeRoleResources())
    .map((x) => ({
      logicalId: x.LogicalResourceId,
      roleName: x.PhysicalResourceId,
      adminPlane: /AdminPlane/.test(x.LogicalResourceId),
    }));
}

async function stackOutputs() {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const out = {};
  for (const o of r.Stacks?.[0]?.Outputs || []) out[o.OutputKey] = o.OutputValue;
  return out;
}

/** One simulated decision per action, for a role, a resource and the `person` tag. */
function simulate(roleArn, resourceArn, personId) {
  const got = awsIam([
    'simulate-principal-policy',
    '--policy-source-arn', roleArn,
    '--action-names', ...ACTIONS,
    '--resource-arns', resourceArn,
    '--context-entries', `ContextKeyName=aws:PrincipalTag/person,ContextKeyValues=${personId},ContextKeyType=string`,
  ]);
  const out = {};
  for (const r of got.EvaluationResults || []) out[r.EvalActionName] = r.EvalDecision;
  return out;
}

function expectDecisions(label, decisions, want) {
  for (const action of ACTIONS) {
    const got = decisions[action];
    const ok = want === 'allowed' ? got === 'allowed' : got !== 'allowed' && got !== undefined;
    if (ok) pass(`${label}: ${action} is ${got}`);
    else fail(`${label}: ${action} is ${got ?? 'not evaluated'}, expected ${want}`);
  }
}

async function simulationHalf(roles, appInstanceArn) {
  console.log('\n1. SIMULATION: the deployed roles pin the bearer on the person tag\n');
  const a = `deny-test-a-${randomUUID()}`;
  const b = `deny-test-b-${randomUUID()}`;
  const userArn = (id) => userArnFor(appInstanceArn, id);
  for (const r of roles) {
    const roleArn = awsIam(['get-role', '--role-name', r.roleName])?.Role?.Arn;
    if (!roleArn) { fail(`${r.logicalId}: could not read the role`); continue; }
    if (r.adminPlane) {
      expectDecisions(`${r.logicalId} person=A bearing A-admin (control)`, simulate(roleArn, userArn(`${a}-admin`), a), 'allowed');
      expectDecisions(`${r.logicalId} person=A bearing B-admin`, simulate(roleArn, userArn(`${b}-admin`), a), 'denied');
      expectDecisions(`${r.logicalId} person=A bearing B`, simulate(roleArn, userArn(b), a), 'denied');
    } else {
      expectDecisions(`${r.logicalId} person=A bearing A (control)`, simulate(roleArn, userArn(a), a), 'allowed');
      expectDecisions(`${r.logicalId} person=A bearing B`, simulate(roleArn, userArn(b), a), 'denied');
      expectDecisions(`${r.logicalId} person=A bearing A-admin`, simulate(roleArn, userArn(`${a}-admin`), a), 'denied');
    }
  }
}

async function idToken(idp, clientId, email, password) {
  const r = await idp.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const t = r.AuthenticationResult?.IdToken;
  if (!t) throw new Error(`no ID token for ${email}`);
  return t;
}

async function exchange(url, token, body = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`exchange ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

const isAccessDenied = (e) => e?.name === 'AccessDeniedException' || /not authorized|access ?denied/i.test(String(e?.message));

function chimeFor(creds) {
  return new ChimeSDKMessagingClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });
}

/**
 * 'allowed' when the call succeeds, 'denied' when IAM refuses it (AccessDenied), and otherwise the error's
 * name and message, so a control refused by anything else (a ForbiddenException from the membership check, a
 * throttle) is reported as what it was rather than counted.
 */
async function tryCall(fn) {
  try { await fn(); return 'allowed'; } catch (e) { return isAccessDenied(e) ? 'denied' : `other:${e?.name || e}: ${String(e?.message || '').slice(0, 160)}`; }
}

/**
 * A signed `chime:Connect` upgrade as `bearer`: 'allowed' when the session is established, 'denied' on a 403 or
 * a 4401/4403 close after the upgrade, otherwise what was seen.
 * The signing libraries are the SDK's own, resolved from its dependency tree; when they cannot be
 * resolved the Connect check is reported as a failure to run rather than passed.
 */
async function tryConnect(client, creds, bearer) {
  const { SignatureV4 } = require('@smithy/signature-v4');
  const { Sha256 } = require('@aws-crypto/sha256-js');
  const ep = await client.send(new GetMessagingSessionEndpointCommand({}));
  const host = new URL(ep.Endpoint?.Url?.startsWith('http') ? ep.Endpoint.Url : `https://${ep.Endpoint?.Url}`).host;
  const signer = new SignatureV4({
    service: 'chime',
    region: REGION,
    sha256: Sha256,
    credentials: {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    },
  });
  const signed = await signer.presign({
    method: 'GET',
    protocol: 'wss:',
    hostname: host,
    path: '/connect',
    headers: { host },
    query: { userArn: bearer, sessionId: randomUUID() },
  }, { expiresIn: 60 });
  const qs = new URLSearchParams(signed.query).toString();
  return new Promise((resolve) => {
    const req = https.request({
      host,
      path: `/connect?${qs}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
    });
    // The service upgrades every signed request and authorizes inside the socket: an allowed bearer's first
    // frame is the SESSION_ESTABLISHED event, a refused one's is a close frame with code 4401 or 4403. So the
    // 101 alone decides nothing; the first frame does.
    req.on('upgrade', (_res, socket) => {
      let buf = Buffer.alloc(0);
      const done = (v) => { socket.destroy(); resolve(v); };
      const timer = setTimeout(() => done('error:no frame after upgrade'), 15000);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 2) return;
        clearTimeout(timer);
        const opcode = buf[0] & 0x0f;
        if (opcode === 0x8) {
          const code = buf.length >= 4 ? buf.readUInt16BE(2) : 0;
          done(code === 4401 || code === 4403 ? 'denied' : `close:${code}`);
        } else {
          done(/SESSION_ESTABLISHED/.test(buf.toString('utf8')) ? 'allowed' : `frame:opcode${opcode}`);
        }
      });
      socket.on('error', (e) => { clearTimeout(timer); done(`error:${e?.code || e}`); });
    });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode === 403 ? 'denied' : `status:${res.statusCode}`); });
    req.on('error', (e) => resolve(`error:${e?.code || e}`));
    req.setTimeout(15000, () => { req.destroy(); resolve('error:timeout'); });
    req.end();
  });
}

/** The live checks for one session vended for `selfArn`, on a channel where `otherArn` is a member. */
async function liveChecks(label, creds, selfArn, otherArn, channelArn) {
  const c = chimeFor(creds);
  const send = (bearer) => tryCall(() => c.send(new SendChannelMessageCommand({
    ChannelArn: channelArn, Content: 'deny-test', Type: 'STANDARD', Persistence: 'NON_PERSISTENT', ChimeBearer: bearer,
  })));
  const list = (bearer) => tryCall(() => c.send(new ListChannelMessagesCommand({
    ChannelArn: channelArn, MaxResults: 1, ChimeBearer: bearer,
  })));
  const expect = (what, got, want) => {
    const ok = got === want;
    if (ok) pass(`${label}: ${what} -> ${got}`);
    else fail(`${label}: ${what} -> ${got}, expected ${want}`);
  };
  for (const [name, call] of [['SendChannelMessage', send], ['ListChannelMessages', list]]) {
    expect(`${name} bearing its own person (control)`, await call(selfArn), 'allowed');
    expect(`${name} bearing another person`, await call(otherArn), 'denied');
    expect(`${name} bearing its own -admin twin`, await call(`${selfArn}-admin`), 'denied');
  }
  try {
    const own = await tryConnect(c, creds, selfArn);
    if (own === 'allowed') pass(`${label}: Connect as its own person (control) -> allowed`);
    else fail(`${label}: Connect as its own person -> ${own}, expected allowed`);
    const other = await tryConnect(c, creds, otherArn);
    if (other === 'denied') pass(`${label}: Connect as another person -> denied`);
    else fail(`${label}: Connect as another person -> ${other}, expected denied`);
  } catch (e) {
    fail(`${label}: the Connect check could not run: ${e?.message || e}`);
  }
}

/** A channel created by the runner, with both people as members, removed afterwards. */
async function withChannel(creatorArn, memberArn, classification, fn) {
  const admin = new ChimeSDKMessagingClient({ region: REGION });
  let channelArn;
  try {
    const created = await admin.send(new CreateChannelCommand({
      AppInstanceArn: appInstanceArnOf(creatorArn),
      Name: `deny-test-bearer-pin-${Date.now()}`,
      Mode: 'RESTRICTED',
      Privacy: 'PRIVATE',
      ChimeBearer: creatorArn,
      MemberArns: [memberArn],
      ClientRequestToken: `denytestpin${Date.now()}`,
      ...(classification ? { Tags: [{ Key: 'classification', Value: classification }] } : {}),
    }));
    channelArn = created.ChannelArn;
  } catch (e) {
    console.error('SETUP FAILED: the runner could not create the test channel:', String(e?.message || e));
    process.exit(2);
  }
  try {
    await fn(channelArn);
  } finally {
    try { await admin.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: creatorArn })); }
    catch (e) { console.error(`  (cleanup) could not delete ${channelArn}: ${String(e?.message || e)}`); }
  }
}

async function main() {
  const roles = await deployedExchangeRoles();
  if (!roles.length) { console.error(`no ExchangeRole* roles in ${STACK}; nothing to check`); process.exit(2); }
  const outputs = await stackOutputs();
  // The person credential exchange is a route on PersonApi.
  const personStack = `${resolveStackPrefix(process.env)}PersonApi`;
  const person = (await cfn.send(new DescribeStacksCommand({ StackName: personStack }))).Stacks?.[0]?.Outputs || [];
  const personApiUrl = person.find((o) => o.OutputKey === 'PersonApiUrl')?.OutputValue || '';
  if (!personApiUrl) { console.error(`${personStack} has no PersonApiUrl output`); process.exit(2); }
  const exchangeUrl = `${personApiUrl.replace(/\/$/, '')}/exchange-credentials`;

  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const idp = new CognitoIdentityProviderClient({ region: REGION });
  const aEx = await exchange(exchangeUrl, await idToken(idp, secret.cognitoClientId, secret.basicUser.email, secret.basicUser.password));
  const bEx = await exchange(exchangeUrl, await idToken(idp, secret.cognitoClientId, secret.premiumUser.email, secret.premiumUser.password));
  const appInstanceArn = appInstanceArnOf(aEx.userArn);

  await simulationHalf(roles, appInstanceArn);

  console.log('\n2. LIVE: the deployment pool\n');
  await withChannel(aEx.userArn, bEx.userArn, 'basic', (channelArn) =>
    liveChecks('pool session for A', aEx.credentials, aEx.userArn, bEx.userArn, channelArn));

  // A HOST APP'S POOL, declared in the trusted-issuer registry with the one-conversation session. Its
  // people use the same exchange as everyone else; the registry decides what they are vended.
  console.log('\n3. LIVE: a host app\'s pool\n');
  if (!secret.federatedUser || !secret.federatedClientId) skip('the test secret names no federatedUser and federatedClientId');
  else {
    const fedIdp = new CognitoIdentityProviderClient({ region: secret.federatedRegion || REGION });
    const fedToken = await idToken(fedIdp, secret.federatedClientId, secret.federatedUser.email, secret.federatedUser.password);
    // The one-conversation vend names one conversation, so the channel exists first, with B as its creator.
    // The guest is then made a member of it, as a guest is of its own conversation, so its own-bearer
    // control can SUCCEED. A non-member's own-bearer call is refused by the membership check
    // (ForbiddenException), which says IAM admitted it but proves no path works, so it is not a control.
    await withChannel(bEx.userArn, aEx.userArn, null, async (channelArn) => {
      const fedEx = await exchange(exchangeUrl, fedToken, { channelArn });
      try {
        await new ChimeSDKMessagingClient({ region: REGION }).send(new CreateChannelMembershipCommand({
          ChannelArn: channelArn, MemberArn: fedEx.userArn, Type: 'DEFAULT', ChimeBearer: bEx.userArn,
        }));
      } catch (e) {
        console.error('SETUP FAILED: the runner could not make the guest a member of its conversation:', String(e?.message || e));
        process.exitCode = 2;
        return;
      }
      await liveChecks('one-conversation session', fedEx.credentials, fedEx.userArn, bEx.userArn, channelArn);
    });
    if (process.exitCode === 2) return;
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s). The bearer pin is NOT fully enforced.`);
    exitWhenDrained(1);
    return;
  }
  console.log('\nEvery person session acts only as its own AppInstanceUser, and never as an -admin twin it does not hold.');
}

// The verdict is set on process.exitCode rather than by process.exit(), which aborts on Windows after a
// fetch (lib/exit-when-drained.cjs).
main().catch((err) => {
  console.error('deny-test failed to run:', err);
  exitWhenDrained(2);
});
