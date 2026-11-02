/**
 * Live deny-test for the Credential Exchange (docs/SPEC-CREDENTIAL-EXCHANGE.md §9).
 *
 * THE behavioral proof that synth/unit tests cannot give: that the bearer pin is
 * actually ENFORCED by IAM, not just written into the policy. Requires the exchange
 * to be DEPLOYED (`<Prefix>Identity`) + the tier test users to exist
 * (`npm run provision-test-users`). Run after `aws sso login --profile <your-profile>`.
 *
 *   EXCHANGE_API_URL=https://<id>.execute-api.us-east-1.amazonaws.com/prod \
 *   AWS_PROFILE=<your-profile> node backend/scripts/deny-test-credential-exchange.mjs
 *
 * What it proves — the bearer pin is ISOLATED on a REAL basic-classified channel, so the
 * channel-half of the grant (the `classification` tag-gate) passes and ONLY the bearer
 * differs between the two assertions. Setup uses the runner's admin creds (AdministratorAccess
 * SSO) to create a channel tagged `classification=basic` with the basic user as creator/member;
 * the assertions then run as the basic user's bearer-pinned exchange creds:
 *   1. CONTROL — SendChannelMessage on the real channel bearing the basic user's OWN ARN is
 *      sent (channel-half + bearer-half both pass); any refusal, AccessDenied or not, fails it.
 *   2. BEARER PIN — the same send bearing the PREMIUM user's ARN is AccessDenied. The channel-half
 *      still passes (basic channel), so the deny is the bearer pin alone — the impersonation vector.
 *   3. (optional) CLASSIFICATION — if PREMIUM_CHANNEL_ARN is set (a REAL premium channel), basic
 *      creds bearing their OWN ARN are AccessDenied acting on it (the tag-gate half).
 * If channel setup fails (insufficient Chime admin perms on the runner), the script exits 2 with
 * a clear message rather than asserting on a confounded synthetic channel.
 *
 * Then, by IAM simulation over every role the deployment's stacks create: only the exchange and
 * offboarding write Identities. A subject is mapped to a person only by the one exchange every issuer
 * shares, so a role that could write a row there could make a subject sign in as anyone. Every role
 * that `dynamodb:PutItem`, `UpdateItem` or `DeleteItem` on the `Identities` table simulates as allowed
 * must be the exchange's own role, the role offboarding runs on, or, with a `provisioned-only` issuer, a
 * subject provisioner's role (whose narrowing `deny-test-pending-identities.mjs` proves).
 *
 * And, by IAM simulation of the vend roles: AN ADMIN'S CHAT SESSION CANNOT REACH A MEMBER CONVERSATION IT IS NOT
 * CLEARED FOR (SPEC-ADMIN-IDENTITY FR1). The admin plane's chat vend role (`<instance>-exchange-admin`) is denied a
 * send on a premium-tagged channel and allowed one on an admin-tagged channel; a member vend role
 * (`<instance>-exchange-premium`) reaches an admin-tagged channel only with the `adminPlane` principal tag `true`.
 *
 * Exit 0 = all asserted denies/allows held; non-zero = a gap (or setup error).
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import {
  ChimeSDKMessagingClient,
  SendChannelMessageCommand,
  CreateChannelCommand,
  DeleteChannelCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const { resolveStackPrefix, resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = require('./lib/person-arn.cjs');
const { instanceStacksAmong, listStackNames, listStackResources } = require('./lib/stack-resources.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const EXCHANGE_API_URL = (process.env.EXCHANGE_API_URL || '').replace(/\/$/, '');
const PREMIUM_CHANNEL_ARN = process.env.PREMIUM_CHANNEL_ARN || '';
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';

if (!EXCHANGE_API_URL) {
  console.error(`EXCHANGE_API_URL is required (CDK output ${resolveStackPrefix(process.env)}PersonApi.PersonApiUrl).`);
  process.exit(2);
}

const sm = new SecretsManagerClient({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });

const decodeSub = (idToken) => JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8')).sub;

async function authIdToken(email, password, clientId) {
  const r = await idp.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const idToken = r.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error(`No IdToken for ${email} (check USER_PASSWORD_AUTH is enabled + user confirmed)`);
  return idToken;
}

async function exchange(idToken) {
  const resp = await fetch(`${EXCHANGE_API_URL}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!resp.ok) throw new Error(`exchange ${resp.status}: ${await resp.text()}`);
  return resp.json(); // { credentials, userArn, tier }
}

const isAccessDenied = (e) => e?.name === 'AccessDeniedException' || /not authorized|access denied/i.test(String(e?.message));

async function trySend(client, channelArn, bearer) {
  try {
    await client.send(new SendChannelMessageCommand({
      ChannelArn: channelArn, Content: 'deny-test', Type: 'STANDARD', Persistence: 'NON_PERSISTENT', ChimeBearer: bearer,
    }));
    return { denied: false, err: null };
  } catch (e) {
    return { denied: isAccessDenied(e), err: e };
  }
}


/**
 * ONLY THE EXCHANGE AND OFFBOARDING WRITE IDENTITIES, by IAM simulation over every role this instance's
 * stacks create. Returns one [label, pass] per finding, and a control that the exchange role is allowed.
 */
async function identitiesWriters() {
  const WRITES = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'];
  const ssmParam = `/${resolveInstanceName(process.env)}/shared/tables/identities-arn`;
  const tableArn = (await new SSMClient({ region: REGION }).send(new GetParameterCommand({ Name: ssmParam }))).Parameter?.Value;
  if (!tableArn) throw new Error(`${ssmParam} is not published; deploy Identity first`);
  const cfn = new CloudFormationClient({ region: REGION });
  const prefix = resolveStackPrefix(process.env);
  const roles = [];
  for (const stack of instanceStacksAmong(await listStackNames(cfn), prefix)) {
    const resources = await listStackResources(cfn, stack);
    for (const r of resources.filter((x) => x.ResourceType === 'AWS::IAM::Role')) {
      roles.push({ stack, logicalId: r.LogicalResourceId, roleName: r.PhysicalResourceId });
    }
  }
  if (!roles.some((r) => /^CredentialExchangeRole/.test(r.logicalId))) {
    throw new Error('no CredentialExchangeRole among the instance stacks; nothing to compare against');
  }
  const writers = [];
  for (const role of roles) {
    const arn = JSON.parse(execFileSync('aws', ['iam', 'get-role', '--role-name', role.roleName, '--output', 'json'], { encoding: 'utf8' })).Role?.Arn;
    const sim = JSON.parse(execFileSync('aws', ['iam', 'simulate-principal-policy', '--policy-source-arn', arn,
      '--action-names', ...WRITES, '--resource-arns', tableArn, '--output', 'json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    const allowed = (sim.EvaluationResults || []).filter((e) => e.EvalDecision === 'allowed').map((e) => e.EvalActionName);
    if (allowed.length) writers.push({ ...role, allowed });
  }
  // The exchange; offboarding, which removes rows and writes markers; and, with a provisioned-only issuer, the
  // subject provisioners (P-13), whose grants hold them to a pending row of their own issuers. A simulation
  // with no request context passes their LeadingKeys condition, so their narrowing is proven by
  // deny-test-pending-identities.mjs, which simulates each key and attribute set.
  const sanctioned = (w) => /^CredentialExchangeRole/.test(w.logicalId) || /^OffboardingRole/.test(w.logicalId)
    || /^SubjectProvisioner(Admin|Connectors)Role/.test(w.logicalId);
  const results = writers.map((w) => [
    `only the exchange and offboarding write Identities: ${w.stack}/${w.logicalId} may ${w.allowed.join(', ')}`,
    sanctioned(w),
  ]);
  results.push(['control: the exchange role is among the Identities writers', writers.some((w) => /^CredentialExchangeRole/.test(w.logicalId))]);
  return results;
}

/**
 * AN ADMIN'S CHAT SESSION REACHES ADMIN CONVERSATIONS AND WHAT ITS MEMBER CLASSIFICATION GRANTS, NOTHING ELSE.
 * Simulated against the deployed vend roles with the channel's tag and the session's tags supplied as context.
 */
function adminChatReach(appInstanceArn) {
  const instance = resolveInstanceName(process.env);
  const channel = `${appInstanceArn}/channel/deny-test-admin-chat`;
  const roleArn = (token) => JSON.parse(execFileSync('aws', ['iam', 'get-role', '--role-name', `${instance}-exchange-${token}`, '--output', 'json'], { encoding: 'utf8' })).Role?.Arn;
  const decide = (arn, entries) => {
    const ctx = entries.flatMap(([k, v]) => ['ContextKeyName=' + k + ',ContextKeyValues=' + v + ',ContextKeyType=string']);
    const sim = JSON.parse(execFileSync('aws', ['iam', 'simulate-principal-policy', '--policy-source-arn', arn,
      '--action-names', 'chime:SendChannelMessage', '--resource-arns', channel, '--context-entries', ...ctx, '--output', 'json'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    return sim.EvaluationResults?.[0]?.EvalDecision;
  };
  const admin = roleArn('admin');
  const premium = roleArn('premium');
  return [
    ["admin chat role: send on a premium conversation → denied", decide(admin, [['aws:ResourceTag/classification', 'premium']]) !== 'allowed'],
    ["admin chat role: send on an admin conversation → allowed (control)", decide(admin, [['aws:ResourceTag/classification', 'admin']]) === 'allowed'],
    ["premium chat role without adminPlane: send on an admin conversation → denied", decide(premium, [['aws:ResourceTag/classification', 'admin']]) !== 'allowed'],
    ["premium chat role with adminPlane=true: send on an admin conversation → allowed", decide(premium, [['aws:ResourceTag/classification', 'admin'], ['aws:PrincipalTag/adminPlane', 'true']]) === 'allowed'],
  ];
}

(async () => {
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const clientId = secret.cognitoClientId;

  const basicTok = await authIdToken(secret.basicUser.email, secret.basicUser.password, clientId);
  const premTok = await authIdToken(secret.premiumUser.email, secret.premiumUser.password, clientId);

  const basicEx = await exchange(basicTok);          // basic creds, bearer pinned to basic's sub
  const premEx = await exchange(premTok);
  const basicArn = basicEx.userArn;
  const premArn = premEx.userArn;
  const appInstanceArn = appInstanceArnOf(basicArn);

  // Basic user's bearer-pinned exchange creds — the principal under test.
  const client = new ChimeSDKMessagingClient({
    region: REGION,
    credentials: {
      accessKeyId: basicEx.credentials.AccessKeyId,
      secretAccessKey: basicEx.credentials.SecretAccessKey,
      sessionToken: basicEx.credentials.SessionToken,
    },
  });

  // Setup: the runner's default-chain creds (AdministratorAccess SSO) create a REAL channel
  // tagged classification=basic, bearing the basic user so they become creator/member. This
  // makes the channel-half of the basic role's grant PASS, isolating the bearer pin.
  const admin = new ChimeSDKMessagingClient({ region: REGION });
  let realChannel = null;
  try {
    const created = await admin.send(new CreateChannelCommand({
      AppInstanceArn: appInstanceArn,
      Name: `deny-test-${Date.now()}`,
      Mode: 'RESTRICTED',
      Privacy: 'PRIVATE',
      ChimeBearer: basicArn,                               // basic = creator/moderator/member
      ClientRequestToken: `denytest${Date.now()}`,
      Tags: [{ Key: 'classification', Value: 'basic' }],   // satisfies classificationsAllowedFor(basic)
    }));
    realChannel = created.ChannelArn;
  } catch (e) {
    console.error('SETUP FAILED — could not create the real basic-classified test channel.');
    console.error('  The runner needs Chime admin perms (create/tag/delete channel). Detail:', String(e?.message || e));
    process.exit(2);
  }

  const results = [];
  try {
    // 1. CONTROL: own bearer on the basic channel SUCCEEDS (channel + bearer both pass). Any refusal fails
    // it, not only AccessDenied: a send refused by the membership check (ForbiddenException) proves no
    // path works, and then the deny in row 2 proves nothing either.
    const ctl = await trySend(client, realChannel, basicArn);
    results.push(['control: send on basic channel bearing OWN ARN → sent', ctl.err === null]);
    if (ctl.denied) {
      console.error('  ↳ own-bearer send was AccessDenied: the `person` session tag may not be resolving,');
      console.error('    or the channel tag did not take. Bearer pin cannot be isolated until this passes.');
    } else if (ctl.err) {
      console.error(`  ↳ own-bearer send was refused with ${ctl.err?.name}: ${String(ctl.err?.message || '').slice(0, 160)}`);
    }
    // 2. BEARER PIN — premium bearer on the SAME basic channel → AccessDenied (only the bearer differs).
    const imp = await trySend(client, realChannel, premArn);
    results.push(['bearer pin: send on basic channel bearing PREMIUM ARN → AccessDenied', imp.denied]);
    // 3. Optional classification deny on a REAL premium channel (own bearer, higher-tier channel).
    if (PREMIUM_CHANNEL_ARN) {
      const cls = await trySend(client, PREMIUM_CHANNEL_ARN, basicArn);
      results.push(['classification: basic creds → premium channel → AccessDenied', cls.denied]);
    }
  } finally {
    // Teardown the test channel (best-effort).
    try { await admin.send(new DeleteChannelCommand({ ChannelArn: realChannel, ChimeBearer: basicArn })); }
    catch (e) { console.error(`(cleanup) failed to delete ${realChannel}: ${String(e?.message || e)}`); }
  }

  // Only the exchange and offboarding write Identities.
  results.push(...await identitiesWriters());
  // An admin's chat session reaches only what its classifications grant.
  results.push(...adminChatReach(appInstanceArn));

  let ok = true;
  for (const [label, pass] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n✅ Bearer pin ENFORCED.' : '\n❌ A deny did not hold — investigate.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('deny-test error:', e); process.exit(2); });
