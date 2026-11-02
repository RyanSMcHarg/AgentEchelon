/**
 * Live measurement: IAM CANNOT GATE WHO A `manage-membership` CREDENTIAL TARGETS, so the membership
 * audit is the enforcement for that axis rather than a backstop behind one.
 *
 * THIS SCRIPT USED TO CLAIM THE OPPOSITE, AND RUNNING IT IS WHAT DISPROVED THE CLAIM. It was written
 * as a deny-test for an explicit `Deny` on the bot ARN in the vended session policy, on the reading
 * that Amazon Chime SDK authorizes `DeleteChannelMembership` and `CreateChannelModerator` against the
 * `app-instance-bot` resource as well as the channel. MEASURED 2026-09-28: with that Deny in force the
 * assistant was REMOVED and PROMOTED. `memberArn` is a request PARAMETER, not a resource - CloudTrail
 * records no `resources` entry for the target, and the IAM simulator returns `explicitDeny` on the bot
 * ARN, so the policy was correct and simply never consulted. The `Deny` has been removed rather than
 * left in place looking like a control, and `credential-exchange.test.ts` now pins its ABSENCE.
 *
 * SO WHAT IT ASSERTS NOW IS THE TRUE SHAPE, and each line is load-bearing:
 *
 *   1. CONTROL - `CreateChannelMembership` naming a HUMAN succeeds. The vend works and the `user/*`
 *      resource is reachable, so a later denial means something.
 *   2. CONTROL FOR THE CONTROL - an UNREQUESTED action (`SendChannelMessage`) IS denied. This is what
 *      separates "the session policy is inert" from "the target is not an evaluated resource". They
 *      are very different bugs with very different fixes, and without this line the first version of
 *      this script could not tell them apart.
 *   3. THE MEASUREMENT - removing and promoting the ASSISTANT SUCCEED. That is the finding, not a
 *      failure: the authorization is on the CHANNEL, which the credential legitimately holds.
 *
 * IT EXITS 0 WHEN REALITY MATCHES THAT, which is the only honest polarity. A red script nobody can fix
 * gets ignored, and the useful signal here is the INVERSE: if line 3 ever starts being denied, AWS has
 * changed how it authorizes these verbs, and the audit could be demoted from the enforcement to a
 * backstop. This script is how that would be noticed.
 *
 * THE RULE IT EXISTS TO SERVE: only a backend service admin may remove or change
 * the status of the primary assistant. The assistant is the orchestrator, so a conversation that has
 * lost its human moderators stays recoverable only while the assistant is still in it and able to act.
 * That rule is enforced today by `conversation-management.ts` refusing a bot target, plus the
 * membership audit - NOT by IAM, and the console's direct Chime path bypasses the handler.
 *
 * ON A THROWAWAY CHANNEL, created and deleted by this script with the runner's own admin credentials.
 * Line 3 REMOVES the bot from the channel, which is exactly why it must not be somebody's conversation.
 *
 * ── AND THE SERVICE-ADMIN BEARER ──────────────────────────────────
 *
 * The creators (the router's drift split, the conversation split, the typed-conversation creator and
 * the conversation creation function) change membership bearing the service admin, an AppInstanceUser
 * tagged `classification=admin`, which matches no creator's classification. Their grant has two legs, `membershipAsServiceAdminStatements`:
 * the channel, conditioned on `aws:ResourceTag/classification`, and the bearer, the admin's exact ARN
 * with NO tag condition. Neither leg had been measured for a user bearer, so this part measures the
 * shape itself, on a scratch IAM role holding exactly that grant for `basic` (the deployed creator roles
 * trust only Lambda and cannot be assumed here):
 *
 *   4. ALLOWED on a `basic` channel, bearing the admin: add a person, make them a moderator, drop the
 *      moderator, remove them. All four actions the creators hold, on both legs.
 *   5. REFUSED on a channel of another classification (`standard`), bearing the admin.
 *   6. REFUSED on an UNTAGGED channel, bearing the admin: the condition fails closed on a missing tag.
 *   7. REFUSED on the `basic` channel bearing a PERSON: the bearer leg names the admin and nobody else.
 *   8. INFORMATIONAL: the same grant with the classification condition ALSO on the bearer leg. Expected
 *      refused, because the admin's `admin` tag matches no creator's classification; this is why the bearer leg names the exact ARN without
 *      one. IF IAM EVALUATES THE ADMIN BEARER DIFFERENTLY - line 4 refused while
 *      lines 5 and 6 hold - the bearer leg is what to change: it names the exact ARN without a tag
 *      condition (as it does) and the channel leg carries the classification alone. If line 8 is
 *      ALLOWED, the bearer's tag is not evaluated for a user bearer at all, which changes nothing here
 *      but is worth recording in ADR-042.
 *
 * ── AND THE ADMIN PLANE ───────────────────────────────────────────
 *
 * The admin-plane roles (the membership audit, user deletion, archive and removal) evict in a
 * conversation of any classification, and held `DeleteChannelMembership` on `channel/*` and `user/*`
 * with no condition: any channel, as any person. `adminPlaneMembershipStatements` narrows them to a
 * channel carrying any DECLARED classification and the service admin's exact ARN. On the same scratch
 * role, with that grant in place of the step 31 one:
 *
 *   9.  ALLOWED: evict a person from the `standard` channel, bearing the admin.
 *   10. REFUSED: the same eviction bearing a PERSON.
 *   11. REFUSED: an eviction from the UNTAGGED channel, bearing the admin. A channel with no
 *       classification is reported by the audit and not evicted from.
 *
 *
 * ── AND A CREATOR CREATES ONLY ITS OWN CLASSIFICATION ──────────────
 *
 * Every admin-bearing creator's `CreateChannel` requires `aws:RequestTag/classification` equal to its
 * own (`Null` false), and its tag-on-create channel leg requires the same requested value and allows it
 * only where the channel carries no `classification` or that same one (`StringEqualsIfExists` on
 * `aws:ResourceTag/classification`). A second leg allows the same requested value on the app instance and
 * the bearer: a tagged create makes a dependent `TagResource` check against its bearer, and the admin's
 * `admin` tag would fail the channel leg's resource condition (measured: line 12 refused until the legs
 * were split). On the scratch role, holding that grant for `basic`:
 *
 *   12. ALLOWED: create a channel tagged `basic`, bearing the admin. It is deleted at once.
 *   13. REFUSED: create a channel tagged `standard`.
 *   14. REFUSED: create an untagged channel.
 *   15. REFUSED: `TagResource` `classification=basic` on the existing `standard` scratch channel.
 *
 * ── AND THE AUDIENCE TAG (tenet D3, the classification-independence plan) ─────────────────────────
 *
 * Every creator also requires `aws:RequestTag/audience` equal to its classification's declared audience in
 * the same create, and a role that serves the deployment's own people in every conversation (invitations, the
 * share, Battle Mode) is denied its membership changes on a channel whose `audience` is `outside` or absent:
 *
 *   16. REFUSED: create a channel tagged `basic` with `audience=outside`.
 *   17. REFUSED: create a channel tagged `basic` with no `audience`.
 *   18. ALLOWED: the member-side grant adds a person to a `basic` channel with `audience=members`.
 *   19. REFUSED: the same add on a `basic` channel with `audience=outside`.
 *   20. REFUSED: the same add on the `basic` scratch channel with no `audience`.
 *
 * ── AND CONVERSATION MANAGEMENT (tenet D3: leave and archive everywhere, an add into no outside conversation) ──
 *
 * Conversation management serves a customer's own leave, a moderator's removal and the console's archive, so
 * its grant reaches every classified conversation with no audience condition, and it is denied a membership add
 * on a channel whose `audience` is `outside` or absent (`neverAnOutsideConversation`, `CONVERSATION_MANAGEMENT_ADDS`
 * in `conversations-stack.ts`). The scratch grant folds in an add allow it never holds, so the denial is what
 * refuses lines 22 and 23:
 *
 *   21. ALLOWED: its grant removes a person from a `basic` channel with `audience=outside` (a customer's own leave).
 *   22. REFUSED: an add on that outside channel.
 *   23. REFUSED: an add on the `basic` scratch channel with no `audience`.
 *   24. ALLOWED: an add on the `audience=members` channel, so 22 and 23 are refused by the denial alone.
 *
 * Lines 12 and 18 are the ones to read first here too: they prove Amazon Chime SDK supplies
 * `aws:RequestTag/audience` to `CreateChannel` and `aws:ResourceTag/audience` to a membership change.
 *
 * WHAT THIS MEASURES BEFORE A DEPLOY. Line 12 is the one to read first: it proves Amazon Chime SDK
 * supplies `aws:RequestTag/classification` (and so `Null` on it) to the `CreateChannel` authorization,
 * and that `StringEqualsIfExists` on `aws:ResourceTag/classification` passes the dependent `TagResource`
 * check a tagged create makes, whatever resource that check evaluates. If line 12 is refused, every
 * creator would be refused at deploy: do not deploy step 39 until it is allowed. Lines 13 to 15 are the
 * boundary.
 *
 * Lines 4 to 7 and 9 to 24 are pass/fail. The scratch role trusts this account and is deleted at the end; the
 * runner needs `iam:CreateRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, `iam:DeleteRole` and
 * `sts:AssumeRole`, which an administrator profile has.
 *
 *   EXCHANGE_API_URL=https://<id>.execute-api.us-east-1.amazonaws.com/prod \
 *   ADMIN_EXCHANGE_API_URL=https://<id>.execute-api.us-east-1.amazonaws.com/prod \
 *   AWS_PROFILE=<your-profile> node backend/scripts/deny-test-assistant-membership.mjs
 *
 * `SSM_ROOT` (or any instance variable `scripts/lib/stack-lookup.cjs` reads) names the instance whose service admin is read from
 * `${SSM_ROOT}/app-instance-admin-arn`.
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  ChimeSDKMessagingClient, CreateChannelCommand, DeleteChannelCommand,
  CreateChannelMembershipCommand, DeleteChannelMembershipCommand, CreateChannelModeratorCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { ChimeSDKIdentityClient, ListAppInstanceBotsCommand } from '@aws-sdk/client-chime-sdk-identity';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = require('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const EXCHANGE_API_URL = (process.env.EXCHANGE_API_URL || '').replace(/\/$/, '');
const ADMIN_EXCHANGE_API_URL = (process.env.ADMIN_EXCHANGE_API_URL || '').replace(/\/$/, '');
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';

if (!EXCHANGE_API_URL) {
  console.error(`EXCHANGE_API_URL is required (CDK output ${resolveStackPrefix(process.env)}PersonApi.PersonApiUrl).`);
  process.exit(2);
}
if (!ADMIN_EXCHANGE_API_URL) {
  console.error(`ADMIN_EXCHANGE_API_URL is required (CDK output ${resolveStackPrefix(process.env)}AdminApi.AdminApiUrl).`);
  process.exit(2);
}

const idp = new CognitoIdentityProviderClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
const identity = new ChimeSDKIdentityClient({ region: REGION });
const adminChime = new ChimeSDKMessagingClient({ region: REGION }); // the runner's own creds, for setup

/** An authorization refusal, as opposed to a bad request or a missing resource. */
const isAccessDenied = (e) => {
  const name = e?.name || '';
  const msg = String(e?.message || '');
  return name === 'AccessDeniedException' || name === 'ForbiddenException'
    || /not authorized|access denied|explicit deny/i.test(msg);
};

async function authIdToken(email, password, clientId) {
  const r = await idp.send(new InitiateAuthCommand({
    ClientId: clientId, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const t = r.AuthenticationResult?.IdToken;
  if (!t) throw new Error(`No IdToken for ${email}`);
  return t;
}

async function exchange(idToken, body) {
  const resp = await fetch(`${EXCHANGE_API_URL}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`exchange ${resp.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * An admin-plane credential, requested as the admin console requests it: the person signed in at the
 * person exchange, a console session from the admin exchange, then
 * `POST exchange-credentials/admin/<capability>` on the admin exchange signed with that session, with a
 * stated reason. The person exchange refuses `identity: 'admin'` (ADMIN_VEND_MOVED).
 */
async function adminVend(idToken, capability, body) {
  await exchange(idToken, {});
  const consoleResp = await fetch(`${ADMIN_EXCHANGE_API_URL}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'console' }),
  });
  const consoleText = await consoleResp.text();
  if (!consoleResp.ok) throw new Error(`console session ${consoleResp.status}: ${consoleText.slice(0, 300)}`);
  const session = JSON.parse(consoleText);
  const credentials = {
    accessKeyId: session.credentials.AccessKeyId,
    secretAccessKey: session.credentials.SecretAccessKey,
    sessionToken: session.credentials.SessionToken,
  };
  const u = new URL(`${ADMIN_EXCHANGE_API_URL}/exchange-credentials/admin/${capability}`);
  const payload = JSON.stringify(body);
  const signed = await new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 }).sign({
    method: 'POST', protocol: u.protocol, hostname: u.hostname, path: u.pathname,
    headers: { host: u.host, 'content-type': 'application/json' }, body: payload,
  });
  const resp = await fetch(u.toString(), { method: 'POST', headers: signed.headers, body: payload });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`admin vend ${capability} ${resp.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * THREE OUTCOMES, NOT TWO, and the difference is what keeps this honest. A first version reported
 * `denied: false` for ANY error, so a broken credential object read as "the control passed" - the
 * control is supposed to prove the credential WORKS, and it happily proved nothing while the two
 * real assertions failed for the same reason. `ok` means the call actually succeeded.
 */
const attempt = async (client, cmd) => {
  try {
    await client.send(cmd);
    return { ok: true, denied: false, err: null };
  } catch (e) {
    return { ok: false, denied: isAccessDenied(e), err: e };
  }
};

let channelArn = null;
let botArn = null;
/** The service-admin part's scratch channels and role, cleaned up whatever happens. */
const scratchChannels = [];
let scratchRoleName = null;

const SSM_ROOT = `/${resolveInstanceName(process.env)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The step 31 grant, as `membershipAsServiceAdminStatements` renders it, for one classification. */
const CREATOR_ACTIONS = [
  'chime:CreateChannelMembership', 'chime:CreateChannelModerator',
  'chime:DeleteChannelMembership', 'chime:DeleteChannelModerator',
];
function serviceAdminGrant(appInstanceArn, serviceAdminArn, classification, { conditionTheBearer = false } = {}) {
  const condition = { StringEquals: { 'aws:ResourceTag/classification': [classification] } };
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'InDeclaredClassifications', Effect: 'Allow', Action: CREATOR_ACTIONS, Resource: `${appInstanceArn}/channel/*`, Condition: condition },
      { Sid: 'AsTheServiceAdmin', Effect: 'Allow', Action: CREATOR_ACTIONS, Resource: serviceAdminArn, ...(conditionTheBearer ? { Condition: condition } : {}) },
    ],
  });
}

/**
 * The step 38 grant, as `adminPlaneMembershipStatements` renders it for an eviction with `EVERY_CLASSIFICATION`:
 * a channel carrying a `classification` tag, whatever its value, and no audience condition (admins are across
 * everything, outside classifications included).
 */
function adminPlaneGrant(appInstanceArn, serviceAdminArn) {
  const actions = ['chime:DeleteChannelMembership'];
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AuditEvictsInItsClassifications', Effect: 'Allow', Action: actions, Resource: `${appInstanceArn}/channel/*`,
        Condition: { Null: { 'aws:ResourceTag/classification': 'false' } },
      },
      { Sid: 'AuditEvictsAsItsBearer', Effect: 'Allow', Action: actions, Resource: serviceAdminArn },
    ],
  });
}

/**
 * A MEMBER-SIDE grant, as `membershipAsServiceAdminStatements` renders it with `EVERY_CLASSIFICATION` (the
 * invitations function; the share and Battle Mode bear an assistant with the same channel leg): any
 * conversation's classification by its tag being present, the admin plane's excluded, and the second layer,
 * denied on a channel whose `audience` is `outside` and on one with no `audience`.
 */
function memberSideGrant(appInstanceArn, serviceAdminArn) {
  const actions = ['chime:CreateChannelMembership', 'chime:DeleteChannelMembership'];
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'InviteeMembershipInDeclaredClassifications', Effect: 'Allow', Action: actions, Resource: `${appInstanceArn}/channel/*`,
        Condition: { Null: { 'aws:ResourceTag/classification': 'false' }, StringNotEquals: { 'aws:ResourceTag/classification': ['admin'] } },
      },
      { Sid: 'InviteeMembershipAsTheServiceAdmin', Effect: 'Allow', Action: actions, Resource: serviceAdminArn },
      {
        Sid: 'InviteeMembershipNeverAnOutsideConversation', Effect: 'Deny', Action: actions, Resource: `${appInstanceArn}/channel/*`,
        Condition: { StringEquals: { 'aws:ResourceTag/audience': 'outside' } },
      },
      {
        Sid: 'InviteeMembershipNeverAConversationWithNoAudience', Effect: 'Deny', Action: actions, Resource: `${appInstanceArn}/channel/*`,
        Condition: { Null: { 'aws:ResourceTag/audience': 'true' } },
      },
    ],
  });
}

/**
 * CONVERSATION MANAGEMENT's grant, as `conversations-stack.ts` renders it: its membership changes on any
 * classified channel bearing the admin, with no audience condition, and its add denial on a channel whose
 * `audience` is `outside` or absent. The add allow is the scratch grant's, never the role's, so lines 22 and 23
 * are refused by the denial and by nothing else.
 */
function conversationManagementGrant(appInstanceArn, serviceAdminArn) {
  const removes = ['chime:DeleteChannelMembership'];
  const adds = ['chime:CreateChannelMembership', 'chime:BatchCreateChannelMembership', 'chime:CreateChannelModerator'];
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ConversationManagementInAnyClassifiedChannel', Effect: 'Allow', Action: [...removes, 'chime:CreateChannelMembership'], Resource: `${appInstanceArn}/channel/*`,
        Condition: { Null: { 'aws:ResourceTag/classification': 'false' } },
      },
      { Sid: 'ConversationManagementAsTheServiceAdmin', Effect: 'Allow', Action: [...removes, 'chime:CreateChannelMembership'], Resource: serviceAdminArn },
      {
        Sid: 'ConversationManagementAddsNeverAnOutsideConversation', Effect: 'Deny', Action: adds, Resource: `${appInstanceArn}/channel/*`,
        Condition: { StringEquals: { 'aws:ResourceTag/audience': 'outside' } },
      },
      {
        Sid: 'ConversationManagementAddsNeverAConversationWithNoAudience', Effect: 'Deny', Action: adds, Resource: `${appInstanceArn}/channel/*`,
        Condition: { Null: { 'aws:ResourceTag/audience': 'true' } },
      },
    ],
  });
}

/**
 * The step 39 creator grant for one classification, as `driftChannelCreateStatements` renders its create
 * and its tag-on-create channel leg: `CreateChannel` only when the request carries `classification`
 * equal to its own, and `TagResource` only with that value and only where the resource carries no
 * classification or that same one.
 */
function creatorGrant(appInstanceArn, serviceAdminArn, classification, audience = 'members') {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DriftCreateConversation', Effect: 'Allow', Action: ['chime:CreateChannel'],
        Resource: [appInstanceArn, `${appInstanceArn}/channel/*`, serviceAdminArn],
        Condition: {
          StringEquals: { 'aws:RequestTag/classification': [classification], 'aws:RequestTag/audience': [audience] },
          Null: { 'aws:RequestTag/classification': 'false', 'aws:RequestTag/audience': 'false' },
        },
      },
      {
        Sid: 'DriftStampOwnClassificationOnly', Effect: 'Allow', Action: ['chime:TagResource'],
        Resource: [`${appInstanceArn}/channel/*`],
        Condition: {
          StringEquals: { 'aws:RequestTag/classification': [classification], 'aws:RequestTag/audience': [audience] },
          StringEqualsIfExists: { 'aws:ResourceTag/classification': [classification], 'aws:ResourceTag/audience': [audience] },
        },
      },
      {
        Sid: 'DriftStampOwnClassificationOnlyOnBearer', Effect: 'Allow', Action: ['chime:TagResource'],
        Resource: [appInstanceArn, serviceAdminArn],
        Condition: { StringEquals: { 'aws:RequestTag/classification': [classification], 'aws:RequestTag/audience': [audience] } },
      },
    ],
  });
}

/**
 * Lines 4 to 8 (see the header), lines 9 to 11 (step 38) and lines 12 to 15 (step 39). Returns result rows in the same shape as the lines above, plus the
 * informational line 8 as a string.
 */
async function serviceAdminBearerCases({ appInstanceArn, adminChatArn, humanArn }) {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const { IAMClient, CreateRoleCommand, PutRolePolicyCommand } = await import('@aws-sdk/client-iam');
  const { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const serviceAdminArn = (await new SSMClient({ region: REGION }).send(new GetParameterCommand({
    Name: `${SSM_ROOT}/app-instance-admin-arn`,
  }))).Parameter?.Value?.trim();
  if (!serviceAdminArn) throw new Error(`no service admin at ${SSM_ROOT}/app-instance-admin-arn`);

  // Three scratch channels, created by the runner bearing the test admin person.
  const scratch = async (label, tags) => {
    const c = await adminChime.send(new CreateChannelCommand({
      AppInstanceArn: appInstanceArn, Name: `deny-test-svcadmin-${label}-${Date.now()}`,
      Mode: 'RESTRICTED', Privacy: 'PRIVATE', ChimeBearer: adminChatArn, ...(tags ? { Tags: tags } : {}),
    }));
    scratchChannels.push(c.ChannelArn);
    return c.ChannelArn;
  };
  const own = await scratch('basic', [{ Key: 'classification', Value: 'basic' }]);
  const other = await scratch('standard', [{ Key: 'classification', Value: 'standard' }]);
  const untagged = await scratch('untagged', null);
  console.log(`service admin:    ${serviceAdminArn}`);
  console.log(`scratch channels: basic ${own.split('/').pop()}, standard ${other.split('/').pop()}, untagged ${untagged.split('/').pop()}`);

  // The scratch role, holding exactly the step 31 grant for `basic`.
  const iam = new IAMClient({ region: REGION });
  const account = (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
  scratchRoleName = `deny-test-svcadmin-membership-${Date.now()}`;
  const role = await iam.send(new CreateRoleCommand({
    RoleName: scratchRoleName,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:root` }, Action: 'sts:AssumeRole' }],
    }),
  }));
  const putGrant = (opts) => iam.send(new PutRolePolicyCommand({
    RoleName: scratchRoleName, PolicyName: 'ServiceAdminMembership',
    PolicyDocument: serviceAdminGrant(appInstanceArn, serviceAdminArn, 'basic', opts),
  }));
  await putGrant();
  const putCreatorGrant = () => iam.send(new PutRolePolicyCommand({
    RoleName: scratchRoleName, PolicyName: 'ServiceAdminMembership',
    PolicyDocument: creatorGrant(appInstanceArn, serviceAdminArn, 'basic'),
  }));
  const putAdminPlaneGrant = () => iam.send(new PutRolePolicyCommand({
    RoleName: scratchRoleName, PolicyName: 'ServiceAdminMembership',
    PolicyDocument: adminPlaneGrant(appInstanceArn, serviceAdminArn),
  }));

  // A new role is not assumable at once, and a new policy is not in force at once. Retry both rather
  // than read an eventual-consistency denial as a measurement.
  const assume = async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const r = await new STSClient({ region: REGION }).send(new AssumeRoleCommand({
          RoleArn: role.Role.Arn, RoleSessionName: 'deny-test-svcadmin',
        }));
        const k = r.Credentials;
        return new ChimeSDKMessagingClient({
          region: REGION,
          credentials: { accessKeyId: k.AccessKeyId, secretAccessKey: k.SecretAccessKey, sessionToken: k.SessionToken },
        });
      } catch (e) {
        if (i === 19) throw e;
        await sleep(3000);
      }
    }
  };
  let asCreator = await assume();
  const add = (client, ch, bearer) => attempt(client, new CreateChannelMembershipCommand({
    ChannelArn: ch, MemberArn: humanArn, Type: 'DEFAULT', ChimeBearer: bearer,
  }));

  // 4. The allowed case first, retried until the new policy is in force, so a later denial is not
  // propagation. Then the other three actions, in the order a creator uses them.
  let added = await add(asCreator, own, serviceAdminArn);
  for (let i = 0; i < 20 && added.denied; i++) {
    await sleep(3000);
    asCreator = await assume();
    added = await add(asCreator, own, serviceAdminArn);
  }
  const rows = [['STEP 31  bearing the admin, ADD a member on its own classification\'s channel', added.ok, added.err]];
  const promoted = await attempt(asCreator, new CreateChannelModeratorCommand({
    ChannelArn: own, ChannelModeratorArn: humanArn, ChimeBearer: serviceAdminArn,
  }));
  rows.push(['STEP 31  bearing the admin, MAKE a moderator on its own classification\'s channel', promoted.ok, promoted.err]);
  const { DeleteChannelModeratorCommand } = await import('@aws-sdk/client-chime-sdk-messaging');
  const demoted = await attempt(asCreator, new DeleteChannelModeratorCommand({
    ChannelArn: own, ChannelModeratorArn: humanArn, ChimeBearer: serviceAdminArn,
  }));
  rows.push(['STEP 31  bearing the admin, DROP a moderator on its own classification\'s channel', demoted.ok, demoted.err]);
  const removed = await attempt(asCreator, new DeleteChannelMembershipCommand({
    ChannelArn: own, MemberArn: humanArn, ChimeBearer: serviceAdminArn,
  }));
  rows.push(['STEP 31  bearing the admin, REMOVE a member on its own classification\'s channel', removed.ok, removed.err]);

  // 5, 6, 7. Each refused, and refused as an authorization failure rather than any error.
  const onOther = await add(asCreator, other, serviceAdminArn);
  rows.push(['STEP 31  bearing the admin, REFUSED on another classification\'s channel', onOther.denied, onOther.err]);
  const onUntagged = await add(asCreator, untagged, serviceAdminArn);
  rows.push(['STEP 31  bearing the admin, REFUSED on an untagged channel', onUntagged.denied, onUntagged.err]);
  const asPerson = await add(asCreator, own, adminChatArn);
  rows.push(['STEP 31  bearing a PERSON, REFUSED on its own classification\'s channel', asPerson.denied, asPerson.err]);

  // 8. Informational: the bearer leg conditioned too. Polled until the policy change is in force.
  await putGrant({ conditionTheBearer: true });
  let conditioned = { ok: true };
  for (let i = 0; i < 20 && conditioned.ok; i++) {
    await sleep(3000);
    asCreator = await assume();
    conditioned = await add(asCreator, own, serviceAdminArn);
    if (conditioned.ok) {
      // Undo the add so the next poll measures the same request.
      await adminChime.send(new DeleteChannelMembershipCommand({ ChannelArn: own, MemberArn: humanArn, ChimeBearer: adminChatArn })).catch(() => {});
    }
  }
  const informational = conditioned.denied
    ? 'INFO     a classification condition on the admin bearer is REFUSED: the admin carries the `admin` tag, which fails it, so the bearer leg names the exact ARN without one'
    : `INFO     a classification condition on the admin bearer was NOT refused after a minute (${conditioned.ok ? 'allowed' : conditioned.err?.name}): the bearer's tag is not evaluated for a user bearer; record it in ADR-042`;

  // 9, 10, 11. STEP 38: an admin-plane role's eviction (the membership audit, user deletion, archive
  // and removal), as `adminPlaneMembershipStatements` renders it: the channel conditioned on EVERY
  // declared classification, the bearer the service admin's exact ARN. The person is put back in the
  // `standard` and untagged channels by the runner first, so each line measures one removal.
  await putAdminPlaneGrant();
  for (const ch of [other, untagged]) {
    await adminChime.send(new CreateChannelMembershipCommand({
      ChannelArn: ch, MemberArn: humanArn, Type: 'DEFAULT', ChimeBearer: adminChatArn,
    })).catch(() => {});
  }
  const evict = (client, ch, bearer) => attempt(client, new DeleteChannelMembershipCommand({
    ChannelArn: ch, MemberArn: humanArn, ChimeBearer: bearer,
  }));
  let evicted = await evict(asCreator, other, serviceAdminArn);
  for (let i = 0; i < 20 && evicted.denied; i++) {
    await sleep(3000);
    asCreator = await assume();
    evicted = await evict(asCreator, other, serviceAdminArn);
  }
  rows.push(['STEP 38  admin plane, bearing the admin, EVICT on a classified channel of any classification', evicted.ok, evicted.err]);
  await adminChime.send(new CreateChannelMembershipCommand({
    ChannelArn: other, MemberArn: humanArn, Type: 'DEFAULT', ChimeBearer: adminChatArn,
  })).catch(() => {});
  const evictAsPerson = await evict(asCreator, other, adminChatArn);
  rows.push(['STEP 38  admin plane, bearing a PERSON, REFUSED', evictAsPerson.denied, evictAsPerson.err]);
  const evictUntagged = await evict(asCreator, untagged, serviceAdminArn);
  rows.push(['STEP 38  admin plane, bearing the admin, REFUSED on an untagged channel', evictUntagged.denied, evictUntagged.err]);

  // 12 to 15. STEP 39: a `basic` creator creates only `basic`, and retags nothing that exists.
  await putCreatorGrant();
  // A created channel is deleted at once, bearing the admin that created it, so a pass leaves nothing.
  const createAndClean = async (client, tags) => {
    try {
      const c = await client.send(new CreateChannelCommand({
        AppInstanceArn: appInstanceArn, Name: `deny-test-step39-${Date.now()}`, Mode: 'RESTRICTED', Privacy: 'PRIVATE',
        ChimeBearer: serviceAdminArn, ...(tags ? { Tags: tags } : {}),
      }));
      await adminChime.send(new DeleteChannelCommand({ ChannelArn: c.ChannelArn, ChimeBearer: serviceAdminArn }))
        .catch(() => scratchChannels.push(c.ChannelArn));
      return { ok: true, denied: false, err: null };
    } catch (e) {
      return { ok: false, denied: isAccessDenied(e), err: e };
    }
  };
  const basicTags = [{ Key: 'classification', Value: 'basic' }, { Key: 'audience', Value: 'members' }];
  let ownCreate = await createAndClean(asCreator, basicTags);
  for (let i = 0; i < 20 && ownCreate.denied; i++) {
    await sleep(3000);
    asCreator = await assume();
    ownCreate = await createAndClean(asCreator, basicTags);
  }
  rows.push(['STEP 39  bearing the admin, CREATE tagged with its own classification', ownCreate.ok, ownCreate.err]);
  const otherCreate = await createAndClean(asCreator, [{ Key: 'classification', Value: 'standard' }, { Key: 'audience', Value: 'members' }]);
  rows.push(['STEP 39  bearing the admin, REFUSED a create tagged with another classification', otherCreate.denied, otherCreate.err]);
  const untaggedCreate = await createAndClean(asCreator, null);
  rows.push(['STEP 39  bearing the admin, REFUSED an untagged create', untaggedCreate.denied, untaggedCreate.err]);
  const { TagResourceCommand } = await import('@aws-sdk/client-chime-sdk-messaging');
  const retag = await attempt(asCreator, new TagResourceCommand({ ResourceARN: other, Tags: basicTags }));
  rows.push(['STEP 39  REFUSED retagging an existing conversation of another classification', retag.denied, retag.err]);

  // 16 and 17. THE AUDIENCE IS THE CLASSIFICATION'S OWN, in the same create: a `basic` create that names
  // another audience, or none, is refused at the create.
  const outsideCreate = await createAndClean(asCreator, [{ Key: 'classification', Value: 'basic' }, { Key: 'audience', Value: 'outside' }]);
  rows.push(['AUDIENCE bearing the admin, REFUSED a create of its own classification at another audience', outsideCreate.denied, outsideCreate.err]);
  const noAudienceCreate = await createAndClean(asCreator, [{ Key: 'classification', Value: 'basic' }]);
  rows.push(['AUDIENCE bearing the admin, REFUSED a create of its own classification with no audience', noAudienceCreate.denied, noAudienceCreate.err]);

  // 18 to 20. A MEMBER-SIDE ROLE (invitations, the share, Battle Mode) reaches a member conversation and never
  // an outside one or one with no audience. Two more scratch channels, tagged by the runner; the person is
  // added and removed bearing the admin, so each line measures one add.
  const members = await scratch('members', [{ Key: 'classification', Value: 'basic' }, { Key: 'audience', Value: 'members' }]);
  const outsideAudience = await scratch('outside', [{ Key: 'classification', Value: 'basic' }, { Key: 'audience', Value: 'outside' }]);
  await iam.send(new PutRolePolicyCommand({
    RoleName: scratchRoleName, PolicyName: 'ServiceAdminMembership',
    PolicyDocument: memberSideGrant(appInstanceArn, serviceAdminArn),
  }));
  let memberAdd = await add(asCreator, members, serviceAdminArn);
  for (let i = 0; i < 20 && memberAdd.denied; i++) {
    await sleep(3000);
    asCreator = await assume();
    memberAdd = await add(asCreator, members, serviceAdminArn);
  }
  rows.push(['AUDIENCE member side, bearing the admin, ADD in a members conversation', memberAdd.ok, memberAdd.err]);
  const outsideAdd = await add(asCreator, outsideAudience, serviceAdminArn);
  rows.push(['AUDIENCE member side, bearing the admin, REFUSED in an outside conversation', outsideAdd.denied, outsideAdd.err]);
  const noAudienceAdd = await add(asCreator, own, serviceAdminArn);
  rows.push(['AUDIENCE member side, bearing the admin, REFUSED in a conversation with no audience', noAudienceAdd.denied, noAudienceAdd.err]);

  // 21 to 24. CONVERSATION MANAGEMENT leaves and removes in an outside conversation, and an add is refused there
  // and in a conversation with no audience by its denial alone.
  await iam.send(new PutRolePolicyCommand({
    RoleName: scratchRoleName, PolicyName: 'ServiceAdminMembership',
    PolicyDocument: conversationManagementGrant(appInstanceArn, serviceAdminArn),
  }));
  await adminChime.send(new CreateChannelMembershipCommand({
    ChannelArn: outsideAudience, MemberArn: humanArn, Type: 'DEFAULT', ChimeBearer: serviceAdminArn,
  })).catch(() => {});
  let leave = await evict(asCreator, outsideAudience, serviceAdminArn);
  for (let i = 0; i < 20 && leave.denied; i++) {
    await sleep(3000);
    asCreator = await assume();
    leave = await evict(asCreator, outsideAudience, serviceAdminArn);
  }
  rows.push(['MANAGEMENT bearing the admin, REMOVE in an outside conversation (a customer leaves)', leave.ok, leave.err]);
  const managementOutsideAdd = await add(asCreator, outsideAudience, serviceAdminArn);
  rows.push(['MANAGEMENT bearing the admin, REFUSED an add in an outside conversation', managementOutsideAdd.denied, managementOutsideAdd.err]);
  const managementNoAudienceAdd = await add(asCreator, own, serviceAdminArn);
  rows.push(['MANAGEMENT bearing the admin, REFUSED an add in a conversation with no audience', managementNoAudienceAdd.denied, managementNoAudienceAdd.err]);
  await adminChime.send(new DeleteChannelMembershipCommand({ ChannelArn: members, MemberArn: humanArn, ChimeBearer: serviceAdminArn })).catch(() => {});
  const managementMembersAdd = await add(asCreator, members, serviceAdminArn);
  rows.push(['MANAGEMENT bearing the admin, an add in a members conversation (the denial alone refuses 22 and 23)', managementMembersAdd.ok, managementMembersAdd.err]);
  return { rows, informational };
}

(async () => {
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const clientId = secret.cognitoClientId;

  // The admin's CHAT vend tells us the app instance without guessing: an account can hold several.
  const adminTok = await authIdToken(secret.testAdmin.email, secret.testAdmin.password, clientId);
  const chatVend = await exchange(adminTok, {});
  const appInstanceArn = appInstanceArnOf(chatVend.userArn);
  const adminChatArn = chatVend.userArn;

  const humanTok = await authIdToken(secret.basicUser.email, secret.basicUser.password, clientId);
  const humanArn = (await exchange(humanTok, {})).userArn;

  const bots = await identity.send(new ListAppInstanceBotsCommand({ AppInstanceArn: appInstanceArn }));
  botArn = bots.AppInstanceBots?.[0]?.AppInstanceBotArn;
  if (!botArn) throw new Error(`no app-instance bot on ${appInstanceArn}`);

  // ── SETUP, with the runner's own credentials ────────────────────────────────────────────────
  const created = await adminChime.send(new CreateChannelCommand({
    AppInstanceArn: appInstanceArn,
    Name: `deny-test-assistant-${Date.now()}`,
    Mode: 'RESTRICTED',
    Privacy: 'PRIVATE',
    ChimeBearer: adminChatArn,
    Tags: [{ Key: 'classification', Value: 'basic' }],
  }));
  channelArn = created.ChannelArn;
  await adminChime.send(new CreateChannelMembershipCommand({
    ChannelArn: channelArn, MemberArn: botArn, Type: 'DEFAULT', ChimeBearer: adminChatArn,
  }));
  console.log(`setup: channel ${channelArn.split('/channel/').pop()} with the assistant as a member`);

  // ── THE PRINCIPAL UNDER TEST: an admin-plane manage-membership vend on that channel ──────────
  const vend = await adminVend(adminTok, 'manage-membership', {
    channelArn, reason: 'deny-test: membership verbs on a scratch channel',
  });
  const c = vend.credentials;
  const vended = new ChimeSDKMessagingClient({
    region: REGION,
    // The exchange returns STS-shaped keys, capitalized, as the handler declares them.
    credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
  });
  const adminBearer = vend.adminArn || vend.userArn;

  // WHICH PRINCIPAL IS THIS, REALLY. A deny-test that cannot name the identity it ran as proves
  // nothing about the policy attached to it.
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const who = await new STSClient({ region: REGION, credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } })
    .send(new GetCallerIdentityCommand({}));
  console.log('vended principal: ' + who.Arn);
  console.log('bearer:           ' + adminBearer);
  console.log('bot target:       ' + botArn);
  console.log('channel:          ' + channelArn);

  const results = [];

  // 1. CONTROL - a human target is reachable. Also proves `user/*` landed.
  const control = await attempt(vended, new CreateChannelMembershipCommand({
    ChannelArn: channelArn, MemberArn: humanArn, Type: 'DEFAULT', ChimeBearer: adminBearer,
  }));
  results.push(['CONTROL  add a HUMAN member', control.ok, control.err]);

  // 1b. CONTROL FOR THE CONTROL - is the session policy enforced AT ALL? `SendChannelMessage` was
  // not among the requested capabilities, so the Allow does not cover it. If this is NOT denied, the
  // session policy is not being applied and nothing below means anything. This assertion is the
  // difference between "the policy is inert" and "the bot resource is not evaluated", which are very
  // different bugs with very different fixes.
  const unrequested = await attempt(vended, new (await import('@aws-sdk/client-chime-sdk-messaging')).SendChannelMessageCommand({
    ChannelArn: channelArn, Content: 'deny-test', Type: 'STANDARD', Persistence: 'NON_PERSISTENT', ChimeBearer: adminBearer,
  }));
  results.push(['CONTROL  an UNREQUESTED action is denied', unrequested.denied, unrequested.err]);

  // 3. THE MEASUREMENT - the target is not an evaluated resource, so both of these SUCCEED. Expecting
  // success is the point: it is the finding this script exists to hold, and inverting the expectation
  // is what stopped it asserting a control that does not exist.
  const removeBot = await attempt(vended, new DeleteChannelMembershipCommand({
    ChannelArn: channelArn, MemberArn: botArn, ChimeBearer: adminBearer,
  }));
  results.push(['MEASURED remove the ASSISTANT succeeds (target is a parameter)', removeBot.ok, removeBot.err]);

  const promoteBot = await attempt(vended, new CreateChannelModeratorCommand({
    ChannelArn: channelArn, ChannelModeratorArn: botArn, ChimeBearer: adminBearer,
  }));
  results.push(['MEASURED promote the ASSISTANT succeeds (target is a parameter)', promoteBot.ok, promoteBot.err]);

  // 4 to 8. The service-admin bearer the creators hold membership as (step 31).
  const svc = await serviceAdminBearerCases({ appInstanceArn, adminChatArn, humanArn });
  results.push(...svc.rows);
  console.log(svc.informational);

  console.log('');
  let unexpected = 0;
  for (const [label, asExpected, err] of results) {
    console.log(`${asExpected ? 'as measured' : 'CHANGED   '}  ${label}${err ? `   [${err.name}: ${(asExpected ? String(err.message).slice(0, 90) : String(err.message))}]` : ''}`);
    if (!asExpected) unexpected++;
  }
  console.log('');
  if (unexpected) {
    // Either direction is news, so say which rather than calling it a failure.
    console.error(`${unexpected} line(s) no longer match the 2026-09-28 measurement.`);
    console.error('If the two MEASURED lines are now DENIED, Amazon Chime SDK has changed how it authorizes');
    console.error('these verbs - re-read SPEC-CREDENTIAL-EXCHANGE FR17, because the membership audit could');
    console.error('then be demoted from the enforcement to a backstop. If a CONTROL line changed, the vend');
    console.error('or the session policy is broken and nothing else here means anything. If a STEP 31 line');
    console.error('changed, the creators\' membership grant does not hold as written: read the header before');
    console.error('deploying `membershipAsServiceAdminStatements`. If a STEP 38 line changed, the same holds for');
    console.error('`adminPlaneMembershipStatements` and the admin-plane roles built from it.');
  } else {
    console.log('As measured: the channel is the authorized resource and the target is not.');
    console.log('The assistant is protected by the handler refusing a bot target plus the membership audit,');
    console.log('and the console\'s direct Chime path bypasses the handler - so the audit is the enforcement.');
  }
  process.exitCode = unexpected ? 1 : 0;
})().catch((e) => {
  console.error('deny-test could not run:', e?.name, String(e?.message).slice(0, 300));
  process.exitCode = 2;
}).finally(async () => {
  // The service-admin part's scratch role and channels first: they hold nothing anybody else uses.
  if (scratchRoleName) {
    try {
      const { IAMClient, DeleteRolePolicyCommand, DeleteRoleCommand } = await import('@aws-sdk/client-iam');
      const iam = new IAMClient({ region: REGION });
      await iam.send(new DeleteRolePolicyCommand({ RoleName: scratchRoleName, PolicyName: 'ServiceAdminMembership' })).catch(() => {});
      await iam.send(new DeleteRoleCommand({ RoleName: scratchRoleName }));
      console.log('cleanup: scratch role deleted');
    } catch (e) {
      console.warn(`cleanup FAILED, delete the IAM role by hand: ${scratchRoleName} (${e?.name})`);
    }
  }
  if (scratchChannels.length) {
    try {
      const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
      const tok = await authIdToken(secret.testAdmin.email, secret.testAdmin.password, secret.cognitoClientId);
      const bearer = (await exchange(tok, {})).userArn;
      for (const arn of scratchChannels) await adminChime.send(new DeleteChannelCommand({ ChannelArn: arn, ChimeBearer: bearer }));
      console.log('cleanup: service-admin scratch channels deleted');
    } catch (e) {
      console.warn(`cleanup FAILED, delete by hand: ${scratchChannels.join(', ')} (${e?.name})`);
    }
  }
  if (!channelArn) return;
  try {
    const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
    const tok = await authIdToken(secret.testAdmin.email, secret.testAdmin.password, secret.cognitoClientId);
    const bearer = (await exchange(tok, {})).userArn;
    await adminChime.send(new DeleteChannelCommand({ ChannelArn: channelArn, ChimeBearer: bearer }));
    console.log('cleanup: scratch channel deleted');
  } catch (e) {
    console.warn(`cleanup FAILED, delete by hand: ${channelArn} (${e?.name})`);
  }
});
