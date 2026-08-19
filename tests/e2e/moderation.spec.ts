/**
 * Moderation E2E — redact is gated on the CHANNEL MODERATOR role, not on holding the capability.
 *
 * WHY THIS SPEC EXISTS. `SPEC-MODERATION` is `Partial` with redact and delete built and neither
 * driven by a test. Its central claim is a separation of authority: "keeping the channel-scoped
 * moderator (redact) distinct from the cross-conversation admin (delete)". That is an authorisation
 * boundary, and authorisation boundaries fail SILENTLY in the permissive direction - nobody files a
 * bug because they could do more than they should.
 *
 * WHAT THE BOUNDARY ACTUALLY IS. An AppInstanceAdmin CAN redact without holding the ChannelModerator
 * role - that is intended, and confirmed against the deployed system. So the containment is not the
 * channel ROLE; it is the channel SCOPE on the vended credential. The credential-exchange model
 * states it directly: the admin identity "only ever receives a channel-scoped, short-lived, AUDITED
 * cred", so cross-conversation admin authority never rides on a broad standing credential.
 *
 * Three layers, all asserted here:
 *
 *   1. Chat plane asks for a moderation capability -> refused. The chat identity carries no
 *      moderation authority whoever holds it.
 *   2. Non-admin asks for the admin plane          -> refused. Group membership gates the plane.
 *   3. Admin plane cred scoped to channel A        -> CANNOT act on channel B, and CAN act on A.
 *
 * Layer 3 is the one worth the effort. If the session policy stopped pinning the channel, every
 * admin moderation cred would silently become a cross-conversation one — no error, no behaviour
 * change for any legitimate use, and the audited-and-scoped property quietly gone. The paired
 * positive control is what makes the refusal meaningful: without it, a denial could be a bad ARN,
 * an expired session, or a missing capability, and the test would report containment where there is
 * only a broken request.
 *
 * An earlier version of this file asserted that redact REQUIRES the moderator role. The deployed
 * system disagreed, and the assertion was wrong rather than the system — recorded here because the
 * failing run is what established the real model.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { signIn, createConversation, sendAndWaitForResponse } from './helpers/agent-helpers';
import { WebSocketMonitor } from './helpers/websocket-monitor';
import { getAdminUser, getTestCredentials, hasTestCredentials, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';

guardConsoleErrors();

const E2E_RUNNABLE = hasTestCredentials();
const REGION = process.env.AWS_REGION || 'us-east-1';
const EXCHANGE_URL = (process.env.VITE_CREDENTIAL_EXCHANGE_API_URL || process.env.EXCHANGE_API_URL || '').replace(/\/$/, '');

/**
 * This deployment's app-instance ARN, read at runtime from the shared SSM contract.
 *
 * Resolved rather than hardcoded for two reasons. It kept a REAL account id and app-instance id in a
 * tracked file, which is exactly what a public repo should not carry; and a literal only matches the
 * one account it was copied from, so the same test on anyone else's deployment would be refused for
 * naming a foreign instance rather than for the authorization reason under test - a pass, or a fail,
 * for the wrong reason. The repo's convention elsewhere is the reserved placeholder 123456789012.
 */
function appInstanceArn(): string {
  const admin = execSync(
    'aws ssm get-parameter --name "/agent-echelon/app-instance-admin-arn" '
    + '--query "Parameter.Value" --output text --region us-east-1',
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  ).trim();
  return admin.split('/user/')[0];
}

function awsJson(args: string): any {
  const out = execSync(`aws ${args} --region ${REGION} --output json`, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 10e6,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
  return out ? JSON.parse(out) : null;
}

function getIdToken(email: string, password: string, clientId: string): string {
  const raw = execSync(
    `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "${clientId}" `
    + `--auth-parameters USERNAME="${email}",PASSWORD="${password}" `
    + `--query AuthenticationResult.IdToken --output text --region ${REGION}`,
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  ).trim();
  if (!raw || raw === 'None') throw new Error(`No IdToken for ${email}`);
  return raw;
}

/** POST the credential exchange. Returns { status, body } so a REFUSAL is inspectable, not thrown. */
async function exchange(idToken: string, payload: unknown): Promise<{ status: number; body: any }> {
  // `Authorization: Bearer <idToken>` — the shape the Cognito authorizer expects. Sending the raw
  // token makes API Gateway fall through to SigV4 parsing and answer 403 "Authorization header
  // requires 'Credential' parameter", which LOOKS like an authorisation refusal and is really a
  // malformed request. Both refusal tests below passed against that before this was corrected, and
  // proved nothing: they would have passed with the boundary wide open.
  // The Cognito authorizer is on `/exchange-credentials`, NOT on the API root. Posting to the root
  // reaches a path with no authorizer, so API Gateway falls through to SigV4 and answers 403
  // "Invalid key=value pair ... in Authorization header" — which reads exactly like an authorisation
  // refusal. Both refusal tests below were green against that, and would have stayed green with the
  // boundary wide open.
  const resp = await fetch(`${EXCHANGE_URL}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  try { return { status: resp.status, body: JSON.parse(text) }; }
  catch { return { status: resp.status, body: { raw: text } }; }
}

/** Redact a message with explicit credentials. Returns the AWS error code, or null on success. */
function redactWith(creds: any, channelArn: string, messageId: string, callerArn: string): string | null {
  try {
    execSync(
      `aws chime-sdk-messaging redact-channel-message --channel-arn "${channelArn}" `
      + `--message-id "${messageId}" --chime-bearer "${callerArn}" --region ${REGION}`,
      {
        encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
        // AWS_PROFILE must be DELETED, not set to '' — an empty profile name makes the CLI fail
        // before it reaches Chime, with empty stderr, which reads as "the call was refused" and is
        // really "the call never happened". The vended session credentials must be the only
        // identity in play, or this test would be measuring the operator's own admin rights.
        env: (() => {
          const e: NodeJS.ProcessEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };
          delete e.AWS_PROFILE;
          e.AWS_ACCESS_KEY_ID = creds.accessKeyId ?? creds.AccessKeyId;
          e.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey ?? creds.SecretAccessKey;
          e.AWS_SESSION_TOKEN = creds.sessionToken ?? creds.SessionToken;
          return e;
        })(),
      },
    );
    return null;
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || '');
    const m = /\(([A-Za-z]+)\)\s+when calling/.exec(msg);
    return m ? m[1] : msg.slice(0, 200);
  }
}

test.describe('Moderation — the credential-exchange refusals', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users.');
  test.skip(!EXCHANGE_URL, 'Needs VITE_CREDENTIAL_EXCHANGE_API_URL.');
  guardBackendErrors('moderation-exchange');

  test('a moderation capability is refused on the chat plane', async () => {
    const creds = await getTestCredentials();
    const token = getIdToken(creds.standardUser.email, creds.standardUser.password, creds.cognitoClientId);

    // Layer 1. The chat identity carries no moderation authority at all, whoever holds it.
    //
    // Asserted as "refused, and nothing vended" rather than as a specific status. The exchange
    // answers 403 here (the caller's role cannot request the capability) where the plane check
    // further down answers 400 — both are correct refusals, and pinning the code would encode an
    // implementation detail while telling us nothing more about the boundary. What matters is that
    // no usable credential comes back.
    const res = await exchange(token, { capabilities: ['redact'] });
    console.log(`[moderation] chat-plane redact request -> ${res.status}`);
    expect(
      res.status,
      `the chat plane vended a redact capability (status ${res.status}). A chat identity holding `
      + 'redact would let any user moderate a conversation they merely belong to.',
    ).toBeGreaterThanOrEqual(400);
    expect(
      JSON.stringify(res.body ?? {}),
      'the refusal response nonetheless carried credentials',
    ).not.toMatch(/accessKeyId|AccessKeyId/);
  });

  test('the admin plane is refused to a non-admin', async () => {
    const creds = await getTestCredentials();
    const token = getIdToken(creds.standardUser.email, creds.standardUser.password, creds.cognitoClientId);

    // Layer 2. Group membership gates the plane itself.
    //
    // The ARN must be WELL-FORMED, or shape validation refuses first and the test passes without
    // ever reaching the group check — a refusal for the wrong reason, which is the failure mode this
    // whole file kept tripping over. This is a real channel ARN shape the caller has no rights to.
    const res = await exchange(token, {
      identity: 'admin',
      capabilities: ['redact'],
      channelArn: `${appInstanceArn()}/channel/conv-does-not-exist`,
    });
    console.log(`[moderation] non-admin admin-plane request -> ${res.status}`);
    expect(
      res.status,
      `a standard user obtained admin-plane credentials (status ${res.status})`,
    ).toBe(403);
    expect(
      JSON.stringify(res.body ?? {}),
      'the refusal nonetheless carried credentials',
    ).not.toMatch(/AccessKeyId/i);
  });
});


test.describe('Moderation — an admin cred is pinned to the channel it was scoped to', () => {
  test.skip(!E2E_RUNNABLE, 'Needs provisioned test users.');
  test.skip(!EXCHANGE_URL, 'Needs VITE_CREDENTIAL_EXCHANGE_API_URL.');
  guardBackendErrors('moderation-scope');

  test('a cred scoped to conversation A cannot redact in conversation B, but can in A', async ({ page }) => {
    test.setTimeout(600_000);
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));
    const creds = await getTestCredentials();

    // Two real conversations, each with a real bot message to target. A fabricated messageId would
    // fail as NotFound and say nothing about authorisation.
    const ws = new WebSocketMonitor();
    await signIn(page, admin.email, admin.password, ws);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    const make = async (label: string): Promise<{ arn: string; messageId: string }> => {
      const createResp = page.waitForResponse(
        (r) => r.url().includes('/create-conversation') && r.request().method() === 'POST',
        { timeout: 30000 },
      );
      await createConversation(page, `${label} ${Date.now()}`, 'Open');
      const arn: string = (await (await createResp).json())?.conversation?.conversationArn || '';
      expect(arn, `${label} channelArn`).toBeTruthy();
      await expect(page.locator('.message-textarea')).toBeEnabled({ timeout: 15000 });
      await sendAndWaitForResponse(page, 'Say hello in one short sentence.', 90_000, ws);
      const messageId = ws.lastBotMessageId;
      expect(messageId, `${label} messageId`).toBeTruthy();
      return { arn, messageId: messageId! };
    };

    const a = await make('Moderation A');
    const b = await make('Moderation B');
    console.log(`\n--- scope test ---\nA=${a.arn}\nB=${b.arn}`);

    // ONE credential, scoped to A only.
    const token = getIdToken(admin.email, admin.password, creds.cognitoClientId);
    const vended = await exchange(token, { identity: 'admin', capabilities: ['redact'], channelArn: a.arn });
    expect(vended.status, `vend failed: ${JSON.stringify(vended.body).slice(0, 300)}`).toBe(200);
    const sessionCreds = vended.body.credentials;
    const adminArn: string = vended.body.userArn;
    expect(adminArn, 'vended admin userArn').toBeTruthy();
    console.log(`scopedTo=${JSON.stringify(vended.body.scopedTo)}`);

    // THE CONTAINMENT. Same credential, a channel it was NOT scoped to.
    const crossChannel = redactWith(sessionCreds, b.arn, b.messageId, adminArn);
    console.log(`--- redact in the UNSCOPED channel B: ${crossChannel ?? 'SUCCEEDED'} ---`);
    expect(
      crossChannel,
      'a moderation credential scoped to one conversation redacted a message in ANOTHER. The '
      + 'credential-exchange model rests on admin authority being channel-scoped, short-lived and '
      + 'audited — an unpinned cred makes every admin moderation action a cross-conversation one, '
      + 'silently, with no behaviour change any legitimate user would notice.',
    ).not.toBeNull();

    // POSITIVE CONTROL. The same credential in the channel it WAS scoped to must work — otherwise
    // the refusal above proves only that the request was broken.
    const inScope = redactWith(sessionCreds, a.arn, a.messageId, adminArn);
    console.log(`--- redact in the SCOPED channel A: ${inScope ?? 'SUCCEEDED'} ---`);
    expect(
      inScope,
      `the credential could not redact in the channel it was scoped to (${inScope}), so the `
      + 'cross-channel refusal above is not evidence of scoping — the call itself is broken.',
    ).toBeNull();
  });
});
