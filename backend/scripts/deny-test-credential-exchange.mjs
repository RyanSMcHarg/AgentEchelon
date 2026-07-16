/**
 * Live deny-test for the Credential Exchange (docs/SPEC-CREDENTIAL-EXCHANGE.md §9).
 *
 * THE behavioral proof that synth/unit tests cannot give: that the bearer pin is
 * actually ENFORCED by IAM, not just written into the policy. Requires the exchange
 * to be DEPLOYED (AgentEchelonCognitoAuth) + the tier test users to exist
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
 *      NOT AccessDenied (channel-half + bearer-half both pass).
 *   2. BEARER PIN — the same send bearing the PREMIUM user's ARN is AccessDenied. The channel-half
 *      still passes (basic channel), so the deny is the bearer pin alone — the impersonation vector.
 *   3. (optional) CLASSIFICATION — if PREMIUM_CHANNEL_ARN is set (a REAL premium channel), basic
 *      creds bearing their OWN ARN are AccessDenied acting on it (the tag-gate half).
 * If channel setup fails (insufficient Chime admin perms on the runner), the script exits 2 with
 * a clear message rather than asserting on a confounded synthetic channel.
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

const REGION = process.env.AWS_REGION || 'us-east-1';
const EXCHANGE_API_URL = (process.env.EXCHANGE_API_URL || '').replace(/\/$/, '');
const PREMIUM_CHANNEL_ARN = process.env.PREMIUM_CHANNEL_ARN || '';
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';

if (!EXCHANGE_API_URL) {
  console.error('EXCHANGE_API_URL is required (CDK output AgentEchelonCognitoAuth.CredentialExchangeApiUrl).');
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


(async () => {
  const secret = JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);
  const clientId = secret.cognitoClientId;

  const basicTok = await authIdToken(secret.basicUser.email, secret.basicUser.password, clientId);
  const premTok = await authIdToken(secret.premiumUser.email, secret.premiumUser.password, clientId);

  const basicEx = await exchange(basicTok);          // basic creds, bearer pinned to basic's sub
  const premEx = await exchange(premTok);
  const basicArn = basicEx.userArn;
  const premArn = premEx.userArn;
  const appInstanceArn = basicArn.split('/user/')[0];

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
  // makes the channel-half of the basic rung's grant PASS, isolating the bearer pin.
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
    // 1. CONTROL — own bearer on the basic channel → NOT AccessDenied (channel + bearer both pass).
    const ctl = await trySend(client, realChannel, basicArn);
    results.push(['control: send on basic channel bearing OWN ARN → NOT AccessDenied', !ctl.denied]);
    if (ctl.denied) {
      console.error('  ↳ own-bearer send was AccessDenied — the `sub` session tag may not be resolving,');
      console.error('    or the channel tag did not take. Bearer pin cannot be isolated until this passes.');
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

  let ok = true;
  for (const [label, pass] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n✅ Bearer pin ENFORCED.' : '\n❌ A deny did not hold — investigate.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('deny-test error:', e); process.exit(2); });
