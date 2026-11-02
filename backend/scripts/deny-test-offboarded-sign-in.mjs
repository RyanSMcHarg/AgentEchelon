#!/usr/bin/env node
/**
 * DENY-TEST: AN OFFBOARDED PERSON IS NEVER SIGNED IN AGAIN, AND NEVER MINTED AGAIN (ADR-058); A DISABLED ONE IS
 * REFUSED AT THEIR NEXT VEND.
 *
 * For each issuer that mints on first sign-in (this deployment's pool, and a host app's pool when the
 * trusted-issuer registry declares one), against the DEPLOYED stacks:
 *
 *   1. A disposable account signs in and exchanges its token: the control, which mints the person.
 *   2. An administrator offboards that person through the console route (`POST /users/delete`, signed on
 *      a console session). The answer is 200, and the same call again is 404.
 *   3. The ID token issued BEFORE the offboarding is exchanged again: refused, and the person it named is
 *      not resolved.
 *   4. The subject signs in again where its account still exists (the host pool keeps its accounts; this
 *      deployment's pool account is deleted, so its sign-in is refused by Cognito) and exchanges: refused.
 *   5. No AppInstanceUser was created by any of the refused exchanges: the instance's AppInstanceUsers are
 *      listed before step 3 and after step 4, and the two sets are equal.
 *
 * A DISABLED POOL ACCOUNT IS REFUSED AT ITS NEXT VEND (SPEC-CREDENTIAL-EXCHANGE §4b, "An account disabled
 * at its issuer"). A second disposable account of this deployment's pool signs in and exchanges (the
 * control); the pool disables it (`AdminDisableUser`); the token issued before the disable is exchanged
 * again and refused 403 `PERSON_NOT_ACTIVE`, with no AppInstanceUser created; the pool re-enables it and
 * the same token is vended again, with no step on the platform's side; the account is then offboarded
 * through the console, which removes it.
 *
 * The disposable pool account is created here and removed by the offboarding itself. The host pool's
 * account is the test secret's `federatedOffboardUser`, which this script leaves in place; its subject
 * stays revoked until it is re-admitted, which the script does at the end (`POST /users/readmit`) so the
 * fixture can be used again.
 *
 * USAGE
 *   AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node backend/scripts/deny-test-offboarded-sign-in.mjs
 *
 * Needs: the backend built (`npm run build`), frontend/packages/admin/.env (`VITE_ADMIN_API_URL`), and the test secret
 * (`TEST_SECRET_NAME`, default `agent-interface/test-credentials`) holding `cognitoClientId`, `testAdmin`
 * `{ email, password }`, and for the host pool `federatedClientId` and `federatedOffboardUser`
 * `{ email, password }`. Without the host-pool fixture that half is skipped with the reason printed;
 * `REQUIRE_FEDERATED=1` fails instead.
 *
 * Exit 0 = every refusal held; 1 = a gap; 2 = a setup error.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { ChimeSDKIdentityClient, ListAppInstanceUsersCommand } from '@aws-sdk/client-chime-sdk-identity';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';

const require = createRequire(import.meta.url);
const { resolveStackPrefix } = require('./lib/stack-lookup.cjs');
const { appInstanceArnOf } = require('./lib/person-arn.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';
const PREFIX = resolveStackPrefix(process.env);
const STACK = process.env.COGNITO_STACK || `${PREFIX}Identity`;
const PERSON_API_STACK = `${PREFIX}PersonApi`;
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const REQUIRE_FEDERATED = process.env.REQUIRE_FEDERATED === '1';

const cfn = new CloudFormationClient({ region: REGION });
const sm = new SecretsManagerClient({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });
const chime = new ChimeSDKIdentityClient({ region: REGION });

const failures = [];
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures.push(m); console.error(`  FAIL  ${m}`); };
const skip = (m) => (REQUIRE_FEDERATED ? fail(`required but skipped: ${m}`) : console.log(`  SKIP  ${m}`));

const adminEnv = {};
for (const line of fs.readFileSync(new URL('../../frontend/packages/admin/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) adminEnv[m[1]] = m[2].trim();
}

async function stackOutputs(stackName = STACK) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const out = {};
  for (const o of r.Stacks?.[0]?.Outputs || []) out[o.OutputKey] = o.OutputValue;
  return out;
}

async function idToken(client, clientId, username, password) {
  const r = await client.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  const t = r.AuthenticationResult?.IdToken;
  if (!t) throw new Error('no ID token');
  return t;
}

async function exchange(url, token, body = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

/**
 * A console session for the test admin, and a signed call on the user-management API with it. The admin
 * is signed in at the person exchange first; the console session is the admin exchange's.
 */
async function consoleCaller(exchangeUrl, adminToken) {
  const adminApi = (adminEnv.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
  if (!adminApi) throw new Error('frontend/packages/admin/.env names no VITE_ADMIN_API_URL');
  const adminExchange = adminApi;
  await exchange(exchangeUrl, adminToken, {});
  const vend = await exchange(`${adminExchange}/exchange-credentials`, adminToken, { identity: 'console' });
  if (vend.status !== 200) throw new Error(`the test admin was refused a console session: ${vend.status}`);
  const credentials = {
    accessKeyId: vend.body.credentials.AccessKeyId,
    secretAccessKey: vend.body.credentials.SecretAccessKey,
    sessionToken: vend.body.credentials.SessionToken,
  };
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const base = `${adminApi}/users`;
  return async (path, json) => {
    const u = new URL(`${base}${path}`);
    const body = JSON.stringify(json);
    const signed = await signer.sign({
      method: 'POST', protocol: u.protocol, hostname: u.hostname, path: u.pathname,
      headers: { host: u.host, 'content-type': 'application/json' }, body,
    });
    const res = await fetch(u.toString(), { method: 'POST', headers: signed.headers, body });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

async function appInstanceUsers(appInstanceArn) {
  const out = new Set();
  let NextToken;
  do {
    const page = await chime.send(new ListAppInstanceUsersCommand({ AppInstanceArn: appInstanceArn, MaxResults: 50, NextToken }));
    for (const u of page.AppInstanceUsers || []) out.add(u.AppInstanceUserArn);
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

/** Steps 1 to 5 for one issuer. `signInAgain` returns a fresh token, or null when the issuer refuses the sign-in. */
async function offboardAndRetry(label, { exchangeUrl, token, signInAgain, consoleCall, readmit, body = {} }) {
  console.log(`\n${label}\n`);
  const first = await exchange(exchangeUrl, token, body);
  if (first.status !== 200 || !first.body.userArn) { fail(`${label}: the control exchange answered ${first.status}`); return null; }
  pass(`${label}: the control exchange minted ${first.body.userArn}`);
  const appInstanceArn = appInstanceArnOf(first.body.userArn);

  const off = await consoleCall('/delete', { personArn: first.body.userArn });
  if (off.status === 200) pass(`${label}: offboarded (removed ${JSON.stringify(off.body.removed)})`);
  else { fail(`${label}: offboarding answered ${off.status}`); return appInstanceArn; }
  const again = await consoleCall('/delete', { personArn: first.body.userArn });
  if (again.status === 404) pass(`${label}: offboarding again is 404`);
  else fail(`${label}: offboarding again answered ${again.status}, expected 404`);

  const before = await appInstanceUsers(appInstanceArn);
  const stale = await exchange(exchangeUrl, token, body);
  if (stale.status === 403 || stale.status === 401) pass(`${label}: the token issued before the offboarding is refused (${stale.status})`);
  else fail(`${label}: the token issued before the offboarding answered ${stale.status}`);

  const fresh = await signInAgain();
  if (!fresh) pass(`${label}: the issuer refuses the sign-in`);
  else {
    const retry = await exchange(exchangeUrl, fresh, body);
    if (retry.status === 403 || retry.status === 401) pass(`${label}: a new sign-in is refused at the exchange (${retry.status})`);
    else fail(`${label}: a new sign-in answered ${retry.status}`);
  }

  const after = await appInstanceUsers(appInstanceArn);
  const minted = [...after].filter((a) => !before.has(a));
  if (minted.length === 0 && !after.has(first.body.userArn)) pass(`${label}: no AppInstanceUser was created, and the offboarded one is gone`);
  else fail(`${label}: AppInstanceUsers created by a refused exchange: ${minted.join(', ') || '(the offboarded one still exists)'}`);

  if (readmit) {
    const r = await consoleCall('/readmit', readmit);
    if (r.status === 200) pass(`${label}: re-admitted, so the fixture can be used again`);
    else fail(`${label}: re-admission answered ${r.status}`);
  }
  return appInstanceArn;
}

/** A disposable, approved account of this deployment's pool, cleared at the floor classification. */
async function disposableAccount(poolId) {
  const username = `offboard-${randomUUID()}@deny-test.invalid`;
  const password = `Aa1!${randomBytes(12).toString('base64url')}`;
  await idp.send(new AdminCreateUserCommand({ UserPoolId: poolId, Username: username, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' }] }));
  await idp.send(new AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: username, Password: password, Permanent: true }));
  await idp.send(new AdminUpdateUserAttributesCommand({ UserPoolId: poolId, Username: username,
    UserAttributes: [{ Name: 'custom:approved', Value: 'true' }] }));
  // Cleared at the floor classification through its group, which is what the exchange reads.
  await idp.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: username, GroupName: process.env.OFFBOARD_TEST_GROUP || 'basic' }));
  return { username, password };
}

/**
 * A disable at the pool is refused at the next vend, by the exchange's live read, and a re-enable is
 * vended again. The account is offboarded at the end, which removes it.
 */
async function disableAndRetry(label, { exchangeUrl, poolId, clientId, consoleCall }) {
  console.log(`\n${label}\n`);
  const { username, password } = await disposableAccount(poolId);
  const token = await idToken(idp, clientId, username, password);
  const first = await exchange(exchangeUrl, token);
  if (first.status !== 200 || !first.body.userArn) { fail(`${label}: the control exchange answered ${first.status}`); return; }
  pass(`${label}: the control exchange minted ${first.body.userArn}`);
  const appInstanceArn = appInstanceArnOf(first.body.userArn);
  try {
    await idp.send(new AdminDisableUserCommand({ UserPoolId: poolId, Username: username }));
    const before = await appInstanceUsers(appInstanceArn);
    const refused = await exchange(exchangeUrl, token);
    if (refused.status === 403 && refused.body.code === 'PERSON_NOT_ACTIVE') pass(`${label}: the token issued before the disable is refused (403 PERSON_NOT_ACTIVE)`);
    else fail(`${label}: a vend after the disable answered ${refused.status} ${refused.body.code || ''}`);
    const after = await appInstanceUsers(appInstanceArn);
    const minted = [...after].filter((a) => !before.has(a));
    if (minted.length === 0) pass(`${label}: the refused vend created no AppInstanceUser`);
    else fail(`${label}: AppInstanceUsers created by a refused vend: ${minted.join(', ')}`);

    await idp.send(new AdminEnableUserCommand({ UserPoolId: poolId, Username: username }));
    const back = await exchange(exchangeUrl, token);
    if (back.status === 200 && back.body.userArn === first.body.userArn) pass(`${label}: re-enabled, the next vend is the same person`);
    else fail(`${label}: a vend after the re-enable answered ${back.status} for ${back.body.userArn || 'nobody'}`);
  } finally {
    const off = await consoleCall('/delete', { personArn: first.body.userArn });
    if (off.status === 200) pass(`${label}: the disposable account is offboarded`);
    else fail(`${label}: offboarding the disposable account answered ${off.status}`);
  }
}

async function main() {
  const outputs = await stackOutputs();
  const personApi = await stackOutputs(PERSON_API_STACK);
  if (!personApi.PersonApiUrl) { console.error(`${PERSON_API_STACK} has no PersonApiUrl output`); process.exit(2); }
  const exchangeUrl = `${personApi.PersonApiUrl.replace(/\/$/, '')}/exchange-credentials`;
  const poolId = outputs.UserPoolId;
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const consoleCall = await consoleCaller(exchangeUrl, await idToken(idp, secret.cognitoClientId, secret.testAdmin.email, secret.testAdmin.password));

  // THIS DEPLOYMENT'S POOL: a disposable, approved account.
  const { username, password } = await disposableAccount(poolId);
  const appInstanceArn = await offboardAndRetry('1. This deployment\'s pool', {
    exchangeUrl,
    token: await idToken(idp, secret.cognitoClientId, username, password),
    consoleCall,
    signInAgain: async () => idToken(idp, secret.cognitoClientId, username, password).catch(() => null),
  });

  // A HOST APP'S POOL, in the trusted-issuer registry: its account outlives the offboarding, so the
  // refusal is the marker's. Its people sign in through the same exchange as everyone else.
  if (!appInstanceArn) skip('the pool half did not mint, so no app instance is known to name a conversation in');
  else if (!secret.federatedOffboardUser || !secret.federatedClientId) skip('the test secret names no federatedOffboardUser and federatedClientId');
  else {
    const fedIdp = new CognitoIdentityProviderClient({ region: secret.federatedRegion || REGION });
    const signIn = () => idToken(fedIdp, secret.federatedClientId, secret.federatedOffboardUser.email, secret.federatedOffboardUser.password);
    const token = await signIn();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    await offboardAndRetry("2. A host app's pool", {
      exchangeUrl,
      token,
      consoleCall,
      signInAgain: () => signIn().catch(() => null),
      readmit: { issuer: claims.iss, subject: claims.sub },
      // The one-conversation vend names one conversation; it need not exist for the exchange to mint or refuse.
      body: { channelArn: `${appInstanceArn}/channel/deny-test-${randomUUID()}` },
    });
  }

  // A DISABLE AT THE POOL: refused at the next vend, and admitted again on re-enable.
  await disableAndRetry('3. A pool account disabled at the pool', { exchangeUrl, poolId, clientId: secret.cognitoClientId, consoleCall });

  console.log(failures.length ? `\n${failures.length} gap(s)` : '\nEvery refusal held');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => { console.error('setup error:', err?.name || err); process.exit(2); });
