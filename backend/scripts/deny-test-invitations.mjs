#!/usr/bin/env node
/**
 * DENY-TEST: AN INVITATION IS REDEEMED ONCE, IN ITS DECLARED MODE ONLY, AND REVOCATION AND OFFBOARDING END IT
 * (M-10, M-5, B8, V18, PLAN §17).
 *
 * Against a DEPLOYED, non-production instance (the captcha vendor's always-pass test keys) whose conversations
 * stack serves invitations: every invitation lands on the chat app's landing page (`invitationLandingFor`). The
 * `link` rows need an `invitation-link` issuer in the registry; without one they are SKIPPED, and REQUIRE_LINK=1
 * fails instead.
 *
 * WHAT A LINK AND A LANDING PAGE GIVE AWAY (M-5)
 *   P1. The landing page (`invite.html`) is served with `Referrer-Policy: no-referrer` and is never framed.
 *   P2. Fetching the page, and reading the invitation from it, repeated, leaves the token unconsumed: the
 *       read still answers `pending`, and the invitation is then redeemed once.
 *
 * THE INVITEE BEFORE REDEMPTION (M-10)
 *   I1. The invitee is a member of the conversation and has no `Identities` row: no sign-in resolves to it.
 *   I2. The invitee's AppInstanceUser lapses with its invitation: it carries an expiration, counted from
 *       creation.
 *   I3. Nothing is found by an address: the invitation record names no address.
 *
 * A `sign-in` INVITATION (R13: never a second binding)
 *   S1. A sign-in that already has an account is refused (409 `wrong_account`) and the token stays unspent.
 *   S2. A `sign-in` invitation is not redeemed from the landing page (409 `wrong_mode`).
 *   S3. A first sign-in presenting it signs in as the invitee, and the invitee's expiration is gone.
 *   S4. A second first sign-in presenting the same token is refused (409 `redeemed`), and its own sign-in
 *       mints a different person.
 *
 * A `link` INVITATION (V18)
 *   L1. Redeemed from the landing page, it vends a session pinned to the invitee: it reads and posts in the
 *       invited conversation as the invitee, and its credential lasts at most 15 minutes.
 *   L2. That session is refused another conversation, and refused `CreateChannel` and `CreateChannelMembership`.
 *   L3. A forwarded link admits one session, once: a second redemption is refused (409 `redeemed_elsewhere`).
 *   L4. The inviter sees who redeemed it: their list shows it redeemed.
 *   L5. After revocation, the vended credential's `ListChannelMessages` and `SendChannelMessage` on that
 *       conversation are refused, because the invitee's membership is gone.
 *
 * OFFBOARDING THE INVITER (0.9, B8)
 *   O1. A fresh member issues an invitation, is offboarded through the console, and the invitation no longer
 *       redeems: the landing page reads nothing, and a first sign-in presenting it is refused.
 *
 * Not here: that an open messaging session receives no further message after revocation is a property of
 * membership in Amazon Chime SDK, checked by L5's refusal; the e2e suite watches it from the browser
 * (`tests/e2e/invitations.spec.ts`).
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> [REQUIRE_LINK=1] node backend/scripts/deny-test-invitations.mjs
 *
 * Needs the test credentials secret. Exit 0 = every refusal held; 1 = a gap; 2 = a setup error. Each run is
 * recorded, dated, in docs/specs/interaction/identity/SPEC-CREDENTIAL-EXCHANGE.md.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ChimeSDKIdentityClient, DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  ListChannelMembershipsCommand,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { exitWhenDrained, destroyClients } = require('./lib/exit-when-drained.cjs');
// The conversation's model is recorded metadata the create-conversation contract requires; the refusals here do not depend on it.
const { UTILITY_MODEL_ID } = require('../lib/config/model-strategy.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const INSTANCE = resolveInstanceName(process.env);
const SSM_ROOT = `/${INSTANCE}`;
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const DUMMY_CAPTCHA = 'XXXX.DUMMY.TOKEN.XXXX';
const REQUIRE_LINK = process.env.REQUIRE_LINK === '1';

const cfn = new CloudFormationClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });
const chimeIdentity = new ChimeSDKIdentityClient({ region: REGION });
const messaging = new ChimeSDKMessagingClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const skip = (m) => (REQUIRE_LINK ? fail(`required but skipped: ${m}`) : console.log(`  SKIP  ${m}`));
const cleanups = [];

async function outputsOf(stackName) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}
const parameter = async (name) => (await ssm.send(new GetParameterCommand({ Name: name })))?.Parameter?.Value || '';

async function call(base, method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, body: json };
}
const post = (base, path, body, token) => call(base, 'POST', path, body, token);

async function idToken(clientId, username, password) {
  const r = await idp.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  const t = r.AuthenticationResult?.IdToken;
  if (!t) throw new Error('no ID token');
  return t;
}

/** A disposable, approved account in this deployment's pool, deleted at the end. */
async function freshAccount(poolId, clientId, group) {
  const username = `invite-${randomUUID()}@deny-test.invalid`;
  const password = `Aa1!${randomBytes(12).toString('base64url')}`;
  await idp.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' }] }));
  cleanups.push(() => idp.send(new AdminDeleteUserCommand({ UserPoolId: poolId, Username: username })).catch(() => {}));
  await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: true }));
  await idp.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId, Username: username, UserAttributes: [{ Name: 'custom:approved', Value: 'true' }] }))
    .catch(() => { /* a pool with no approval attribute */ });
  if (group) await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: group }));
  return { signIn: () => idToken(clientId, username, password) };
}

const messagingAs = (c) => new ChimeSDKMessagingClient({
  region: REGION,
  credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
});
const refusedBy = async (p) => p.then(() => null, (err) => err?.name || 'Error');

/** A signed call on the admin console's API, with the test admin's console session. */
async function consoleCaller(base, adminToken) {
  const adminEnv = {};
  for (const line of fs.readFileSync(new URL('../../frontend/packages/admin/.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) adminEnv[m[1]] = m[2].trim();
  }
  const adminApi = (adminEnv.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
  if (!adminApi) throw new Error('frontend/packages/admin/.env names no VITE_ADMIN_API_URL');
  await post(base, '/exchange-credentials', {}, adminToken);
  const vend = await post(adminApi, '/exchange-credentials', { identity: 'console' }, adminToken);
  if (vend.status !== 200) throw new Error(`the test admin was refused a console session: ${vend.status}`);
  const signer = new SignatureV4({
    service: 'execute-api', region: REGION, sha256: Sha256,
    credentials: { accessKeyId: vend.body.credentials.AccessKeyId, secretAccessKey: vend.body.credentials.SecretAccessKey, sessionToken: vend.body.credentials.SessionToken },
  });
  return async (method, path, json) => {
    const u = new URL(`${adminApi}${path}`);
    const body = method === 'GET' ? undefined : JSON.stringify(json ?? {});
    const signed = await signer.sign({ method, protocol: u.protocol, hostname: u.hostname, path: u.pathname, headers: { host: u.host, 'content-type': 'application/json' }, ...(body ? { body } : {}) });
    const res = await fetch(u.toString(), { method, headers: signed.headers, ...(body ? { body } : {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

/** A conversation the caller opens, at a member classification. */
async function openConversation(base, token, title) {
  const created = await post(base, '/create-conversation', { title, modelId: UTILITY_MODEL_ID, modelTier: 'basic' }, token);
  const arn = created.body?.conversation?.conversationArn;
  if (created.status !== 200 || !arn) throw new Error(`the conversation could not be opened: ${created.status} ${JSON.stringify(created.body)}`);
  return arn;
}

const tokenOf = (link) => decodeURIComponent(new URL(link).hash.replace(/^#t=/, ''));

async function main() {
  const { PersonApiUrl } = await outputsOf(`${PREFIX}PersonApi`);
  if (!PersonApiUrl) throw new Error(`${PREFIX}PersonApi has no PersonApiUrl output`);
  const base = PersonApiUrl.replace(/\/$/, '');
  const identity = await outputsOf(`${PREFIX}Identity`);
  const linkDeclared = Boolean(identity.InvitationLinkSessionRoleArn);
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const poolId = identity.UserPoolId;
  const clientId = secret.cognitoClientId;
  const tokensTable = await parameter(`${SSM_ROOT}/shared/tables/tokens-name`);
  const identitiesTable = await parameter(`${SSM_ROOT}/shared/tables/identities-name`);
  const serviceAdmin = await parameter(`${SSM_ROOT}/app-instance-admin-arn`);
  const inviter = secret.testUser ?? secret.testAdmin;
  const inviterToken = await idToken(clientId, inviter.email, inviter.password);
  const inviterArn = (await post(base, '/exchange-credentials', {}, inviterToken)).body?.userArn;
  const channelArn = await openConversation(base, inviterToken, `deny-test invitations ${Date.now()}`);
  const issue = async (body, token = inviterToken) => {
    const r = await post(base, '/invitations', { channelArn, ...body }, token);
    if (r.status !== 201 || !r.body?.link) throw new Error(`the invitation could not be issued: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const recordOf = async (token) => (await doc.send(new GetCommand({
    TableName: tokensTable, Key: { pk: `invitation#${createHash('sha256').update(token).digest('hex')}` }, ConsistentRead: true,
  })))?.Item;

  // ── THE LINK AND ITS LANDING PAGE ───────────────────────────────────────────────────────────────
  console.log('the link and its landing page');
  const signInInvite = await issue({ name: 'Deny Test Invitee', mode: 'sign-in' });
  const signInToken = tokenOf(signInInvite.link);
  const page = await fetch(signInInvite.link.split('#')[0]);
  const referrer = page.headers.get('referrer-policy');
  referrer === 'no-referrer' ? pass('P1: the landing page is served with Referrer-Policy: no-referrer') : fail(`P1: Referrer-Policy is ${referrer}`);
  page.headers.get('x-frame-options') === 'DENY' ? pass('P1: the landing page is never framed') : fail(`P1: X-Frame-Options is ${page.headers.get('x-frame-options')}`);
  for (let n = 0; n < 3; n++) {
    await fetch(signInInvite.link.split('#')[0]);
    await post(base, '/invitations/peek', { token: signInToken });
  }
  const peeked = await post(base, '/invitations/peek', { token: signInToken });
  const unspent = await recordOf(signInToken);
  peeked.body?.status === 'pending' && unspent && unspent.consumedAt === undefined
    ? pass('P2: fetching the page and reading the invitation, repeated, consumes nothing') : fail(`P2: ${JSON.stringify(peeked.body)} consumedAt=${unspent?.consumedAt}`);

  // ── THE INVITEE BEFORE REDEMPTION ───────────────────────────────────────────────────────────────
  console.log('the invitee before redemption');
  const inviteeArn = signInInvite.invitation.inviteeArn;
  const members = (await messaging.send(new ListChannelMembershipsCommand({ ChannelArn: channelArn, ChimeBearer: serviceAdmin }))).ChannelMemberships || [];
  const rows = (await doc.send(new QueryCommand({ TableName: identitiesTable, IndexName: 'byPerson', KeyConditionExpression: 'personArn = :p', ExpressionAttributeValues: { ':p': inviteeArn } }))).Items || [];
  members.some((m) => m.Member?.Arn === inviteeArn) && rows.length === 0
    ? pass('I1: the invitee is a member and has no Identities row') : fail(`I1: member=${members.some((m) => m.Member?.Arn === inviteeArn)} rows=${rows.length}`);
  const before = await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: inviteeArn }));
  before.AppInstanceUser?.ExpirationSettings?.ExpirationCriterion === 'CREATED_TIMESTAMP'
    ? pass(`I2: the invitee expires with its invitation (${before.AppInstanceUser.ExpirationSettings.ExpirationDays} days from creation)`) : fail(`I2: ${JSON.stringify(before.AppInstanceUser?.ExpirationSettings)}`);
  !JSON.stringify(unspent).includes('@') ? pass('I3: the invitation names no address') : fail('I3: the invitation record carries an address');

  // ── A SIGN-IN INVITATION ────────────────────────────────────────────────────────────────────────
  console.log('a sign-in invitation');
  const existing = await post(base, '/exchange-credentials', { invitation: signInToken }, inviterToken);
  existing.status === 409 && existing.body?.code === 'wrong_account' && (await recordOf(signInToken)).consumedAt === undefined
    ? pass('S1: a sign-in that already has an account is refused, and the token stays unspent') : fail(`S1: ${existing.status} ${JSON.stringify(existing.body)}`);
  const asLink = await post(base, '/invitations/redeem', { token: signInToken, captchaToken: DUMMY_CAPTCHA });
  (asLink.status === 409 && asLink.body?.code === 'wrong_mode') || asLink.status === 404
    ? pass(`S2: a sign-in invitation is not redeemed from the landing page (${asLink.status} ${asLink.body?.code})`) : fail(`S2: ${asLink.status} ${JSON.stringify(asLink.body)}`);
  const first = await freshAccount(poolId, clientId, process.env.INVITE_TEST_GROUP || 'basic');
  const bound = await post(base, '/exchange-credentials', { invitation: signInToken }, await first.signIn());
  bound.status === 200 && bound.body?.userArn === inviteeArn && bound.body?.invitation?.channelArn === channelArn
    ? pass('S3: a first sign-in signs in as the invitee, in the conversation') : fail(`S3: ${bound.status} ${JSON.stringify(bound.body)}`);
  const after = await chimeIdentity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: inviteeArn }));
  !after.AppInstanceUser?.ExpirationSettings ? pass('S3: the bound invitee no longer expires') : fail(`S3 (O13): the bound invitee still carries ${JSON.stringify(after.AppInstanceUser.ExpirationSettings)}`);
  const second = await freshAccount(poolId, clientId, process.env.INVITE_TEST_GROUP || 'basic');
  const secondToken = await second.signIn();
  const twice = await post(base, '/exchange-credentials', { invitation: signInToken }, secondToken);
  twice.status === 409 && twice.body?.code === 'redeemed' ? pass('S4: a second first sign-in is refused (redeemed)') : fail(`S4: ${twice.status} ${JSON.stringify(twice.body)}`);
  const itself = await post(base, '/exchange-credentials', {}, secondToken);
  itself.status === 200 && itself.body?.userArn !== inviteeArn ? pass('S4: that sign-in is its own person') : fail(`S4: it resolved to ${itself.body?.userArn}`);

  // ── A LINK INVITATION ───────────────────────────────────────────────────────────────────────────
  if (!linkDeclared) {
    skip('the link rows: the registry declares no invitation-link issuer');
  } else {
    console.log('a link invitation');
    const linkInvite = await issue({ name: 'Deny Test Guest', mode: 'link' });
    const linkToken = tokenOf(linkInvite.link);
    const redeemed = await post(base, '/invitations/redeem', { token: linkToken, captchaToken: DUMMY_CAPTCHA });
    if (redeemed.status !== 200) {
      fail(`L1: the link redemption answered ${redeemed.status} ${JSON.stringify(redeemed.body)}`);
    } else {
      const guest = messagingAs(redeemed.body.credentials);
      const linkArn = redeemed.body.userArn;
      const read = await refusedBy(guest.send(new ListChannelMessagesCommand({ ChannelArn: channelArn, ChimeBearer: linkArn })));
      const sent = await refusedBy(guest.send(new SendChannelMessageCommand({ ChannelArn: channelArn, ChimeBearer: linkArn, Content: 'deny-test: hello', Type: 'STANDARD', Persistence: 'PERSISTENT' })));
      !read && !sent ? pass('L1: the link session reads and posts in the invited conversation as the invitee') : fail(`L1: read=${read} sent=${sent}`);
      const lifetime = Date.parse(redeemed.body.credentials.Expiration) - Date.now();
      lifetime <= 15 * 60_000 + 60_000 ? pass(`L1: the credential lasts at most 15 minutes (${Math.round(lifetime / 60_000)} left)`) : fail(`L1: the credential lasts ${Math.round(lifetime / 60_000)} minutes`);

      const elsewhere = await openConversation(base, inviterToken, `deny-test elsewhere ${Date.now()}`);
      const other = await refusedBy(guest.send(new ListChannelMessagesCommand({ ChannelArn: elsewhere, ChimeBearer: linkArn })));
      const create = await refusedBy(guest.send(new CreateChannelCommand({ AppInstanceArn: channelArn.split('/channel/')[0], Name: 'x', ChimeBearer: linkArn, ClientRequestToken: randomUUID() })));
      const addMember = await refusedBy(guest.send(new CreateChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: inviterArn, Type: 'DEFAULT', ChimeBearer: linkArn })));
      other && create && addMember ? pass(`L2: refused another conversation (${other}), CreateChannel (${create}) and CreateChannelMembership (${addMember})`)
        : fail(`L2: other=${other} create=${create} addMember=${addMember}`);

      const forwarded = await post(base, '/invitations/redeem', { token: linkToken, captchaToken: DUMMY_CAPTCHA });
      forwarded.status === 409 && forwarded.body?.code === 'redeemed_elsewhere' ? pass('L3: a forwarded link admits one session, once') : fail(`L3: ${forwarded.status} ${JSON.stringify(forwarded.body)}`);

      const listed = await call(base, 'GET', `/invitations?channelArn=${encodeURIComponent(channelArn)}`, undefined, inviterToken);
      const mine = (listed.body?.invitations || []).find((i) => i.invitationId === linkInvite.invitation.invitationId);
      mine?.status === 'redeemed' ? pass('L4: the inviter sees it redeemed') : fail(`L4: ${JSON.stringify(mine)}`);

      const revoked = await post(base, '/invitations/revoke', { channelArn, invitationId: linkInvite.invitation.invitationId }, inviterToken);
      if (revoked.status !== 200) fail(`L5: the revocation answered ${revoked.status}`);
      else {
        const readAfter = await refusedBy(guest.send(new ListChannelMessagesCommand({ ChannelArn: channelArn, ChimeBearer: linkArn })));
        const sendAfter = await refusedBy(guest.send(new SendChannelMessageCommand({ ChannelArn: channelArn, ChimeBearer: linkArn, Content: 'deny-test: after', Type: 'STANDARD', Persistence: 'PERSISTENT' })));
        readAfter && sendAfter ? pass(`L5: after revocation the session's read (${readAfter}) and post (${sendAfter}) are refused`) : fail(`L5: read=${readAfter} send=${sendAfter}`);
      }
    }
  }

  // ── OFFBOARDING THE INVITER ─────────────────────────────────────────────────────────────────────
  console.log('offboarding the inviter');
  const leaver = await freshAccount(poolId, clientId, process.env.INVITE_TEST_GROUP || 'basic');
  const leaverToken = await leaver.signIn();
  const leaverArn = (await post(base, '/exchange-credentials', {}, leaverToken)).body?.userArn;
  const leaverChannel = await openConversation(base, leaverToken, `deny-test leaver ${Date.now()}`);
  const leaverInvite = await post(base, '/invitations', { channelArn: leaverChannel, name: 'Deny Test Orphan', mode: 'sign-in' }, leaverToken);
  if (leaverInvite.status !== 201) throw new Error(`O1: the leaver's invitation could not be issued: ${leaverInvite.status}`);
  const orphanToken = tokenOf(leaverInvite.body.link);
  const consoleCall = await consoleCaller(base, await idToken(clientId, secret.testAdmin.email, secret.testAdmin.password));
  const deleted = await consoleCall('POST', '/users/delete', { personArn: leaverArn });
  if (deleted.status !== 200) fail(`O1: the inviter could not be offboarded: ${deleted.status}`);
  else {
    const read = await post(base, '/invitations/peek', { token: orphanToken });
    const late = await freshAccount(poolId, clientId, process.env.INVITE_TEST_GROUP || 'basic');
    const redeem = await post(base, '/exchange-credentials', { invitation: orphanToken }, await late.signIn());
    read.status === 404 && redeem.status >= 400 && redeem.body?.userArn === undefined
      ? pass(`O1: an offboarded inviter's invitation no longer redeems (peek ${read.status}, sign-in ${redeem.status} ${redeem.body?.code})`)
      : fail(`O1: peek ${read.status} ${JSON.stringify(read.body)}, sign-in ${redeem.status} ${JSON.stringify(redeem.body)}`);
  }

  console.log(failures.length ? `\n${failures.length} refusal(s) did not hold (instance ${INSTANCE})` : `\nevery refusal held (instance ${INSTANCE})`);
  return failures.length ? 1 : 0;
}

// NO process.exit() HERE: on Windows it aborts inside libuv after a fetch and the run ends with the abort's
// status instead of its verdict (lib/exit-when-drained.cjs). The code is set and the loop drains.
const finish = (code) => { destroyClients(cfn, sm, ssm, idp, chimeIdentity, messaging, doc); exitWhenDrained(code); };
main()
  .then(async (code) => { for (const c of cleanups) await c(); finish(code); })
  .catch(async (err) => {
    for (const c of cleanups) await c();
    console.error('setup error:', err?.message || err);
    finish(2);
  });
