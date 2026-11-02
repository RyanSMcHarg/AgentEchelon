#!/usr/bin/env node
/**
 * DENY-TEST: every admin capability is refused, by IAM at the gateway, to a role that does not hold it
 * (SPEC-ADMIN-CONSOLE FR0a, FR43, FR46; acceptance criterion (d)).
 *
 * Measured against the DEPLOYED API rather than read from a policy, because a scoped role is a claim
 * about what is REFUSED and only a refusal measured against the deployment proves it. Three passes:
 *
 *   1. As a `team-members` user, call EVERY route the capability catalog declares. Each must be refused
 *      by API Gateway's IAM check (an HTTP API's bare `{"message":"Forbidden"}`), not by a
 *      handler - a handler refusal would mean the route is reachable and something else said no. A
 *      write is safe to send: the gateway refuses it before any handler runs.
 *   2. As an `admins` user, call every READ route (GET). Each must be admitted by the gateway - a 2xx,
 *      or a handler's own 4xx for a probe id that does not exist - so the refusals in pass 1 cannot be a
 *      broken route refusing everyone.
 *   3. For every WRITE route, ask IAM (simulate-principal-policy) whether the admins role is allowed and
 *      the team-members role is not, so the admin side of a write is proven without performing it.
 *
 *   4. As the team member, on their own team's routes, which the gateway admits: a create at a
 *      classification their clearance does not reach, at a role the classification does not declare, and
 *      at a declared role the deployment has not enabled, and moving an owned assistant to a team they are
 *      not in. Each must be the handler's refusal, before anything is written. A check this deployment
 *      cannot set up prints `skipped:` and why.
 *
 * A capability is checked against whatever the catalog GRANTS each role today (`roleIsGranted`), so the
 * same script proves the team scoping once a team capability is wired.
 *
 * Usage: AWS_PROFILE=... node scripts/deny-test-admin-capabilities.mjs
 * Needs: backend built (`npm run build`), frontend/packages/admin/.env, and the test-credentials secret
 * holding `testAdmin` and `teamOpsUser`.
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { execFileSync } from 'child_process';
import { SignatureV4 } from '@smithy/signature-v4';
import { ChimeSDKMessagingClient, ListChannelMembershipsCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { Sha256 } from '@aws-crypto/sha256-js';
import * as fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ADMIN_API_MOUNTS, ADMIN_CAPABILITIES, roleIsGranted } = require('../lib/config/admin-capabilities.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_NAME = process.env.TEST_SECRET_NAME || 'agent-interface/test-credentials';
const PROBE_ID = 'deny-test-probe';

const env = {};
for (const line of fs.readFileSync(new URL('../../frontend/packages/admin/.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

/**
 * The root of each catalog surface on `AdminApi`, the one admin HTTP API the console is built with: the
 * API's base URL and the surface's mount (`ADMIN_API_MOUNTS`, the analytics query below `/query`).
 */
const ADMIN_API = (env.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
if (!ADMIN_API) { console.error('admin/.env has no VITE_ADMIN_API_URL'); process.exit(2); }
const API_ROOT = Object.fromEntries(Object.entries(ADMIN_API_MOUNTS).map(([surface, mount]) => [surface, `${ADMIN_API}${mount}`]));
/**
 * The origin the preflight is sent from: the admin console's, read from the deployed API's own CORS
 * configuration, since the generated .env names the API and not the console's address.
 */
const ADMIN_ORIGIN = process.env.DENY_TEST_ADMIN_ORIGIN || (() => {
  const origins = JSON.parse(execFileSync('aws', [
    'apigatewayv2', 'get-api', '--region', REGION, '--api-id', new URL(ADMIN_API).hostname.split('.')[0],
    '--query', 'CorsConfiguration.AllowOrigins', '--output', 'json',
  ], { encoding: 'utf8' }) || 'null');
  if (!origins?.length) { console.error('the admin API declares no CORS origin, so no console can call it'); process.exit(2); }
  return origins[0];
})();
/** The person credential exchange, on `PersonApi`: the only minter, and where every person's own chat credential comes from. */
const PERSON_EXCHANGE = (env.VITE_PERSON_API_URL || '').replace(/\/$/, '');
if (!PERSON_EXCHANGE) { console.error('admin/.env has no VITE_PERSON_API_URL'); process.exit(2); }

/** The person exchange's answer for an id token: signs the person in (the admin exchange never mints). */
async function personExchange(idToken) {
  const res = await fetch(`${PERSON_EXCHANGE}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

const secret = JSON.parse((await new SecretsManagerClient({ region: REGION })
  .send(new GetSecretValueCommand({ SecretId: SECRET_NAME }))).SecretString);

/** The exchange's raw answer to a console-session request for a test user, refusals included. */
async function consoleAnswer(key) {
  const user = secret[key];
  if (!user?.email || !user?.password) throw new Error(`${key} credentials missing from ${SECRET_NAME}`);
  const auth = await new CognitoIdentityProviderClient({ region: REGION }).send(new InitiateAuthCommand({
    ClientId: secret.cognitoClientId,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: user.email, PASSWORD: user.password },
  }));
  const person = await personExchange(auth.AuthenticationResult?.IdToken);
  if (!person.ok) return { status: person.status, body: person.body };
  const res = await fetch(`${API_ROOT['admin-exchange']}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.AuthenticationResult?.IdToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'console' }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Sign in as a test user and return a signer on their console session, one on their own chat credential, and the role the console session assumed. */
async function sessionFor(key) {
  const user = secret[key];
  if (!user?.email || !user?.password) throw new Error(`${key} credentials missing from ${SECRET_NAME}`);
  const auth = await new CognitoIdentityProviderClient({ region: REGION }).send(new InitiateAuthCommand({
    ClientId: secret.cognitoClientId,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: user.email, PASSWORD: user.password },
  }));
  const idToken = auth.AuthenticationResult?.IdToken;
  if (!idToken) throw new Error(`no IdToken for ${key}`);
  // THE CONSOLE SESSION, as the console obtains it: the person signed in at the person exchange, then
  // their token for an hour on the console role their groups name, from the admin exchange. Their own
  // chat credential, vended by the person exchange, holds no admin grant.
  const signedIn = await personExchange(idToken);
  if (!signedIn.ok) throw new Error(`${key} was refused at the person exchange: ${signedIn.status}`);
  const vend = await fetch(`${API_ROOT['admin-exchange']}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'console' }),
  });
  const vended = await vend.json();
  if (!vend.ok) throw new Error(`${key} was refused a console session: ${vend.status} ${JSON.stringify(vended)}`);
  const credentials = {
    accessKeyId: vended.credentials.AccessKeyId,
    secretAccessKey: vended.credentials.SecretAccessKey,
    sessionToken: vended.credentials.SessionToken,
  };
  // Which role the session assumed, asked of STS with the session's own credentials.
  const who = JSON.parse(execFileSync('aws', ['sts', 'get-caller-identity', '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'AWS_PROFILE')),
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken,
    },
  }));
  // arn:aws:sts::<acct>:assumed-role/<RoleName>/<session> -> the role ARN IAM evaluates.
  const m = who.Arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
  if (!m) throw new Error(`${key} is not on an assumed role: ${who.Arn}`);
  const roleArn = `arn:aws:iam::${m[1]}:role/${m[2]}`;
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  const call = async (method, url, json) => {
    const u = new URL(url);
    const body = method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(json ?? {});
    const signed = await signer.sign({
      method, protocol: u.protocol, hostname: u.hostname, path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: { host: u.host, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
    });
    const res = await fetch(u.toString(), { method, headers: signed.headers, ...(body ? { body } : {}) });
    return { status: res.status, text: await res.text() };
  };
  // The person's own chat credential (the person exchange's default vend), to prove it holds no admin
  // route: every admin credential is a console session.
  const chatVend = await fetch(`${PERSON_EXCHANGE}/exchange-credentials`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const chatVended = await chatVend.json();
  if (!chatVend.ok) throw new Error(`${key} was refused a chat credential: ${chatVend.status}`);
  const chat = {
    accessKeyId: chatVended.credentials.AccessKeyId,
    secretAccessKey: chatVended.credentials.SecretAccessKey,
    sessionToken: chatVended.credentials.SessionToken,
  };
  const chatSigner = new SignatureV4({ service: 'execute-api', region: REGION, credentials: chat, sha256: Sha256 });
  const chatCall = async (method, url) => {
    const u = new URL(url);
    const body = method === 'GET' || method === 'DELETE' ? undefined : '{}';
    const signed = await chatSigner.sign({
      method, protocol: u.protocol, hostname: u.hostname, path: u.pathname,
      headers: { host: u.host, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
    });
    const res = await fetch(u.toString(), { method, headers: signed.headers, ...(body ? { body } : {}) });
    return { status: res.status, text: await res.text() };
  };
  return { call, chatCall, roleArn, capabilities: vended.capabilities ?? [], assistants: vended.assistants ?? [] };
}

/**
 * True when the response is API Gateway's own IAM refusal, rather than a handler's. An HTTP API answers
 * an IAM denial with the bare body `{"message":"Forbidden"}`; a handler's refusal carries its own code.
 * The REST API wording is kept so the check reads either kind of API.
 */
const gatewayRefused = (r) => r.status === 403 && (
  /^\s*\{\s*"message"\s*:\s*"Forbidden"\s*\}\s*$/.test(r.text)
  || /not authorized to perform: execute-api:Invoke|explicit deny|no identity-based policy/i.test(r.text));

/** A signed GET or POST on explicit credentials: a vended per-conversation credential, not a session. */
function signerFor(credentials) {
  const signer = new SignatureV4({ service: 'execute-api', region: REGION, credentials, sha256: Sha256 });
  return async (method, url) => {
    const u = new URL(url);
    const signed = await signer.sign({
      method, protocol: u.protocol, hostname: u.hostname, path: u.pathname,
      query: Object.fromEntries(u.searchParams), headers: { host: u.host },
    });
    const res = await fetch(u.toString(), { method, headers: signed.headers });
    return { status: res.status, text: await res.text() };
  };
}

/**
 * The execute-api ARN of a route, for the IAM simulation. The API serves one `$default` stage, so the
 * URL carries no stage segment: everything after the host, the surface's mount included, is the path.
 */
function executeApiArn(apiRoot, method, path) {
  const u = new URL(apiRoot);
  const apiId = u.hostname.split('.')[0];
  const full = [u.pathname.replace(/^\/|\/$/g, ''), path.replace(/\*/g, PROBE_ID)].filter(Boolean).join('/');
  return `arn:aws:execute-api:${REGION}:${process.env.AWS_ACCOUNT_ID || '*'}:${apiId}/$default/${method}/${full}`;
}

const admin = await sessionFor('testAdmin');

// ── A TEAM THAT OWNS SOMETHING (SPEC-ADMIN-CONSOLE FR47, FR48) ───────────────────────────────────────
//
// A team member holds capabilities only on their team's assistants and on their own team's routes
// (creating an assistant the team will own). So for the run, the ops team owns one assistant, set through
// the real ownership route as an admin, and the owner it had is put back at the end whatever happens.
const OWNED = process.env.DENY_TEST_TEAM_ASSISTANT || 'analyst';
// The member's own team, which their session names under `/teams/`.
const TEAM = 'ops';
const NOT_OWNED = process.env.DENY_TEST_OTHER_ASSISTANT || 'advisor';
const ownershipUrl = `${API_ROOT['assistant-admin']}/admin/ownership`;
const before = JSON.parse((await admin.call('GET', ownershipUrl)).text);
const priorOwner = before.assistants?.find((a) => a.assistant === OWNED)?.ownerTeam ?? null;
const otherOwner = before.assistants?.find((a) => a.assistant === NOT_OWNED)?.ownerTeam ?? null;
if (otherOwner === 'ops') throw new Error(`${NOT_OWNED} is owned by ops, so it cannot stand for an assistant ops does not own`);
const assign = async (team, why) => {
  const r = await admin.call('POST', ownershipUrl, { assistant: OWNED, team, reason: why });
  if (r.status !== 200) throw new Error(`ownership change refused: ${r.status} ${r.text.slice(0, 200)}`);
};
await assign('ops', 'deny-test: the ops team owns one assistant for this run');
const restore = () => assign(priorOwner, 'deny-test: restoring the owner it had before the run').catch((e) => console.error(String(e)));
let team;
try {
  team = await sessionFor('teamOpsUser');
} catch (e) {
  await restore();
  throw e;
}
const accountId = admin.roleArn.split(':')[4];
process.env.AWS_ACCOUNT_ID = accountId;
console.log(`admins session      -> ${admin.roleArn}`);
console.log(`team-members session -> ${team.roleArn}`);

// IAM throttles the simulator; adaptive retry backs off rather than failing the run.
const simulate = async (roleArn, arn) => execFileSync('aws', [
  'iam', 'simulate-principal-policy', '--region', REGION,
  '--policy-source-arn', roleArn, '--action-names', 'execute-api:Invoke', '--resource-arns', arn,
  '--query', 'EvaluationResults[0].EvalDecision', '--output', 'text',
], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', AWS_RETRY_MODE: 'adaptive', AWS_MAX_ATTEMPTS: '12' } }).trim();

// THE ROUTES THIS DEPLOYMENT SERVES. A capability can be wired in the catalog while its route exists only
// where the configuration declares the feature (guest registration approval needs a guest issuer; sleep
// and wake need the Archive stack's sleep function). Such a route is absent from the API, which nobody
// can reach, so it is listed as not deployed here rather than checked.
const deployedRoutes = JSON.parse(execFileSync('aws', [
  'apigatewayv2', 'get-routes', '--region', REGION, '--api-id', new URL(ADMIN_API).hostname.split('.')[0],
  '--query', 'Items[].RouteKey', '--output', 'json',
], { encoding: 'utf8' })).map((key) => {
  const [method, routePath] = key.split(' ');
  return { method, re: new RegExp(`^${routePath.replace(/\{[^}]+\}/g, '[^/]+')}$`) };
});
const isDeployed = (method, url) => {
  const p = new URL(url).pathname;
  return deployedRoutes.some((d) => (d.method === method || d.method === 'ANY') && d.re.test(p));
};
const notDeployed = [];

const failures = [];
let checked = 0;
for (const cap of Object.values(ADMIN_CAPABILITIES)) {
  if (!cap.wired) continue;
  const teamGranted = roleIsGranted('team-members', cap);
  const adminGranted = roleIsGranted('admins', cap);
  for (const r of cap.resources) {
    // An exchangeVend capability's own resource is reached only by a per-conversation vend; what a role
    // holds standing is its REQUEST route on the exchange, which is what is checked here.
    if (cap.enforcement === 'exchangeVend' && r.api !== 'admin-exchange') continue;
    const root = API_ROOT[r.api];
    const path = r.path.replace(/\*/g, PROBE_ID);
    const url = `${root}/${path}`.replace(/\/$/, '') || root;
    const label = `${cap.key}: ${r.method} /${r.path}`;
    if (!isDeployed(r.method, url)) { notDeployed.push(label); continue; }
    checked++;

    // 0. The person's own chat credential holds nothing here: every admin credential is a console session.
    const p = await admin.chatCall(r.method, url);
    if (!gatewayRefused(p)) failures.push(`${label} - a chat credential was NOT refused at the gateway (${p.status})`);

    // 0b. A browser can send a signed request here: the preflight admits the SigV4 headers.
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: ADMIN_ORIGIN,
        'Access-Control-Request-Method': r.method,
        'Access-Control-Request-Headers': 'authorization,content-type,x-amz-date,x-amz-security-token',
      },
    });
    const allowed = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
    if (!allowed.includes('x-amz-date') || !allowed.includes('x-amz-security-token')) {
      failures.push(`${label} - the CORS preflight does not admit the SigV4 headers (${pre.status} "${allowed}")`);
    }

    // 1. The team member, live: refused on every unscoped route, which reaches across assistants.
    //    What a team holds is the same work under its own assistant's path, checked below.
    const t = await team.call(r.method, url);
    if (!gatewayRefused(t)) failures.push(`${label} - team-members was NOT refused at the gateway on the unscoped route (${t.status} ${t.text.slice(0, 120)})`);

    // 2/3. The admin: live for a read, simulated for a write.
    // THE ANALYTICS ROOT is a read, so it is called live like a GET, with a harmless aggregate query.
    // It is also the one resource IAM's policy simulator misjudges: it reports implicitDeny for the
    // bare root path even when the grant names it exactly, so only the gateway's answer counts here.
    const liveRead = r.method === 'GET' || (r.api === 'analytics' && r.path === '');
    if (liveRead) {
      const a = await admin.call(r.method, url, { queryType: 'conversation_volumes' });
      if (adminGranted && gatewayRefused(a)) failures.push(`${label} - admins holds it and was refused at the gateway`);
      if (adminGranted && a.status >= 500) failures.push(`${label} - admins was admitted but the route failed (${a.status} ${a.text.slice(0, 120)})`);
    } else {
      const arn = executeApiArn(root, r.method, r.path);
      const ad = await simulate(admin.roleArn, arn);
      const td = await simulate(team.roleArn, arn);
      if (adminGranted && ad !== 'allowed') failures.push(`${label} - IAM does not allow admins (${ad})`);
      if (!teamGranted && td === 'allowed') failures.push(`${label} - IAM allows team-members`);
    }
  }
}

// ── THE TEAM ROUTES: ITS OWN ASSISTANT ADMITTED, ANOTHER REFUSED ───────────────────────────────────
//
// Every team route, for the assistant the ops team owns and for one it does not, and every route under
// a team for the ops team and for one the member is not in. The owned one must pass the gateway; the handler may still answer a 4xx (a probe body names another assistant, so a
// write is refused by the handler's own check and nothing is written). The other one must be refused
// at the gateway, by the session policy the exchange built from the ownership tags.
if (!team.assistants?.includes(OWNED)) failures.push(`the team session does not name ${OWNED} (${JSON.stringify(team.assistants)})`);
for (const cap of Object.values(ADMIN_CAPABILITIES)) {
  if (!cap.wired || !roleIsGranted('team-members', cap)) continue;
  for (const r of cap.teamResources ?? []) {
    // A team route names an assistant, or the team itself (`{team}`, creating for it): TEAM is the
    // member's own team and PROBE_ID is a team they are not in.
    const byTeam = r.path.includes('{team}');
    const urlFor = (assistant) => `${API_ROOT[r.api]}/${r.path.replace('{assistant}', assistant)
      .replace('{team}', assistant === OWNED ? TEAM : PROBE_ID).replace(/\{[^}]+\}/g, PROBE_ID)}`;
    const body = r.api === 'analytics'
      ? { queryType: 'intent_effectiveness', dateRange: { start: '2026-01-01', end: '2026-01-02' } }
      : { profileName: NOT_OWNED };
    const label = `${cap.key}: ${r.method} /${r.path}`;
    checked += 2;
    const own = await team.call(r.method, urlFor(OWNED), body);
    if (gatewayRefused(own)) failures.push(`${label} - the owning team was refused at the gateway`);
    else if (own.status >= 500) failures.push(`${label} - the owning team was admitted but the route failed (${own.status} ${own.text.slice(0, 160)})`);
    const other = await team.call(r.method, urlFor(NOT_OWNED), body);
    if (!gatewayRefused(other)) failures.push(`${label} - a team reached ${byTeam ? 'a team it is not in' : 'an assistant it does not own'} (${other.status} ${other.text.slice(0, 120)})`);
  }
}
// The handler's own check on a write: a body naming an assistant other than the path's is refused.
{
  const r = await team.call('POST', `${API_ROOT['assistant-admin']}/admin/assistants/${OWNED}/profiles/version`, { profileName: NOT_OWNED });
  checked += 1;
  if (r.status !== 403 || !/ASSISTANT_MISMATCH/.test(r.text)) failures.push(`a scoped profile write naming another assistant answered ${r.status}, not 403 ASSISTANT_MISMATCH`);
}

// ── A TEAM MEMBER WITH NO TEAM GROUP REACHES NOTHING (acceptance criterion (c)) ─────────────────
{
  checked += 1;
  if (!secret.teamNoTeamUser) failures.push('teamNoTeamUser is not provisioned: run scripts/provision-test-users.mjs --only teamNoTeamUser');
  else {
    const none = await consoleAnswer('teamNoTeamUser');
    if (none.status !== 403 || none.body.code !== 'NO_TEAM') {
      failures.push(`a team-members user with no team group was answered ${none.status} ${JSON.stringify(none.body).slice(0, 120)}, not 403 NO_TEAM`);
    }
  }
}

// ── A CONVERSATION IS FOUND BY ITS ID, AS AN ADMIN AND AS ITS TEAM (acceptance criterion (g)) ─────
{
  const listed = JSON.parse((await admin.call('GET', `${API_ROOT['admin-conversations']}/admin/conversations?limit=2`)).text);
  const target = listed.conversations?.[0]?.channelArn;
  checked += 1;
  if (!target) failures.push('no conversation to find: the admin list is empty');
  else {
    const id = target.split('/channel/')[1];
    const found = await admin.call('GET', `${API_ROOT['admin-conversations']}/admin/conversations/find?id=${id}`);
    if (found.status !== 200 || JSON.parse(found.text).conversation?.channelArn !== target) {
      failures.push(`an admin looking up ${id} was answered ${found.status} ${found.text.slice(0, 120)}`);
    }
  }
  const teamList = JSON.parse((await team.call('GET', `${API_ROOT['admin-conversations']}/admin/assistants/${OWNED}/conversations?limit=1`)).text);
  const teamTarget = teamList.conversations?.[0]?.channelArn;
  checked += 1;
  if (teamTarget) {
    const id = teamTarget.split('/channel/')[1];
    const found = await team.call('GET', `${API_ROOT['admin-conversations']}/admin/assistants/${OWNED}/conversations/find?id=${id}`);
    if (found.status !== 200) failures.push(`the owning team looking up its own conversation ${id} was answered ${found.status}`);
  } else {
    failures.push(`the owning team listed no conversation of ${OWNED}, so the team lookup was not exercised`);
  }
}

// ── AN ADMINISTRATION-IDENTITY CREDENTIAL IS FOR ONE CONVERSATION (acceptance criterion (j)) ─────
//
// Asked live of the Amazon Chime SDK rather than of IAM's simulator: a live-member read vended for one
// conversation answers on it and is refused on another. And no moderation vend accepts a wildcard.
{
  const listed = JSON.parse((await admin.call('GET', `${API_ROOT['admin-conversations']}/admin/conversations?limit=5`)).text);
  const [a, b] = (listed.conversations ?? []).map((c) => c.channelArn).filter(Boolean);
  checked += 2;
  if (!a || !b) failures.push('fewer than two conversations to test a conversation-scoped administration credential across');
  else {
    const vendUrl = `${API_ROOT['admin-exchange']}/exchange-credentials/admin/view-live-members`;
    const v = await admin.call('POST', vendUrl, { channelArn: a, reason: 'deny-test: one conversation only' });
    if (v.status !== 200) failures.push(`a reasoned live-member vend answered ${v.status}: ${v.text.slice(0, 160)}`);
    else {
      const out = JSON.parse(v.text);
      const c = out.credentials ?? {};
      const bearer = out.userArn ?? out.adminIdentity ?? out.appInstanceUserArn;
      const messaging = new ChimeSDKMessagingClient({
        region: REGION,
        credentials: { accessKeyId: c.AccessKeyId ?? c.accessKeyId, secretAccessKey: c.SecretAccessKey ?? c.secretAccessKey, sessionToken: c.SessionToken ?? c.sessionToken },
      });
      const list = (channel) => messaging.send(new ListChannelMembershipsCommand({ ChannelArn: channel, ChimeBearer: bearer, MaxResults: 1 }))
        .then(() => 'allowed', (e) => e?.name || String(e));
      const own = await list(a);
      const other = await list(b);
      if (own !== 'allowed') failures.push(`a live-member credential for a conversation was refused on that conversation (${own})`);
      if (other === 'allowed') failures.push('a live-member credential for one conversation read another');
    }
  }
  for (const capability of ['redact', 'delete', 'manage-membership', 'view-live-members', 'delete-conversation']) {
    checked += 1;
    const r = await admin.call('POST', `${API_ROOT['admin-exchange']}/exchange-credentials/admin/${capability}`, {
      channelArn: `${env.VITE_APP_INSTANCE_ARN}/channel/*`, reason: 'deny-test: a wildcard must be refused',
    });
    if (r.status !== 400 || !/CHANNEL_NOT_LITERAL/.test(r.text)) failures.push(`a ${capability} vend for every conversation was answered ${r.status}, not 400 CHANNEL_NOT_LITERAL`);
  }
}

// SEPARABLE BY IAM (acceptance criterion (e)): a policy granting the redact route alone is allowed redact
// and refused delete, so a deployment can build a role that moderates without deleting.
{
  const root = API_ROOT['admin-exchange'];
  const u = new URL(root);
  const arnFor = (cap) => `arn:aws:execute-api:${REGION}:${accountId}:${u.hostname.split('.')[0]}/*/POST/exchange-credentials/admin/${cap}`;
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'execute-api:Invoke', Resource: arnFor('redact') }] });
  const decide = (cap) => execFileSync('aws', [
    'iam', 'simulate-custom-policy', '--region', REGION, '--policy-input-list', policy,
    '--action-names', 'execute-api:Invoke', '--resource-arns', arnFor(cap).replace('/*/', '/prod/'),
    '--query', 'EvaluationResults[0].EvalDecision', '--output', 'text',
  ], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
  if (decide('redact') !== 'allowed') failures.push('a role holding only the redact route is not allowed redact');
  if (decide('delete') === 'allowed') failures.push('a role holding only the redact route is allowed delete');
}

// A CONVERSATION CREDENTIAL IS FOR ONE CONVERSATION, AND ONLY WITH A REASON (SPEC FR51), live.
{
  const vendUrl = `${API_ROOT['admin-exchange']}/exchange-credentials/admin/view-messages`;
  const channel = (id) => `${env.VITE_APP_INSTANCE_ARN}/channel/${id}`;
  const messages = (id) => `${API_ROOT['admin-conversations']}/admin/conversations/${id}/messages`;

  const unreasoned = await admin.call('POST', vendUrl, { channelArn: channel('deny-test-a') });
  checked += 1;
  if (unreasoned.status !== 400 || !/REASON_REQUIRED/.test(unreasoned.text)) {
    failures.push(`a message-read vend with no reason answered ${unreasoned.status}, not 400 REASON_REQUIRED`);
  }

  const vended = await admin.call('POST', vendUrl, { channelArn: channel('deny-test-a'), reason: 'deny-test: one conversation only' });
  checked += 1;
  if (vended.status !== 200) {
    failures.push(`a reasoned message-read vend answered ${vended.status}: ${vended.text.slice(0, 200)}`);
  } else {
    const c = JSON.parse(vended.text).credentials ?? {};
    const scoped = signerFor({
      accessKeyId: c.accessKeyId ?? c.AccessKeyId,
      secretAccessKey: c.secretAccessKey ?? c.SecretAccessKey,
      sessionToken: c.sessionToken ?? c.SessionToken,
    });
    const own = await scoped('GET', messages('deny-test-a'));
    const other = await scoped('GET', messages('deny-test-b'));
    checked += 2;
    if (gatewayRefused(own)) failures.push('a credential vended for a conversation is refused on that conversation');
    if (!gatewayRefused(other)) failures.push(`a credential vended for one conversation reached another (${other.status})`);
  }
}

// ── A TEAM CREATES ONLY WHERE ITS CLEARANCE AND THE DEPLOYMENT ALLOW, AND MOVES ONLY TO ITS OWN TEAMS ──
//
// The gateway admits the team's own routes, so these are the HANDLER's refusals, measured live: each is
// refused before anything is written, so the probes create and move nothing. A check whose precondition
// this deployment cannot supply is SKIPPED and says why, rather than passing on nothing.
{
  const rosterUrl = `${API_ROOT['assistant-admin']}/admin/teams/${TEAM}/roster`;
  const teamTargets = JSON.parse((await team.call('GET', rosterUrl)).text).rosterTargets ?? [];
  const adminTargets = JSON.parse((await admin.call('GET', `${API_ROOT['assistant-admin']}/admin/profiles`)).text).rosterTargets ?? [];
  const probe = (classification, role) => ({
    assistantId: 'deny-test-probe-create', classification, role, displayName: 'Deny Test Probe',
    descriptor: { modelKey: 'haiku', classifierMode: 'keyword' },
  });
  const skipped = [];

  // 1. A classification the member's clearance does not reach: offered to an admin, not to this team.
  const uncleared = adminTargets.find((t) => !teamTargets.some((x) => x.classification === t.classification));
  if (!uncleared) skipped.push('create at an uncleared classification: the ops member is cleared for every create target');
  else {
    checked += 1;
    const r = await team.call('POST', rosterUrl, probe(uncleared.classification, uncleared.roles[0]));
    if (r.status !== 403 || !/CLASSIFICATION_NOT_CLEARED/.test(r.text)) {
      failures.push(`a team create at ${uncleared.classification}, which its clearance does not reach, answered ${r.status}, not 403 CLASSIFICATION_NOT_CLEARED`);
    }
  }

  // 2. A role the classification does not declare, and one it declares but the deployment has not enabled.
  const cleared = teamTargets[0];
  if (!cleared) skipped.push('create at an undeclared role: the ops member is offered no create target');
  else {
    checked += 1;
    const r = await team.call('POST', rosterUrl, probe(cleared.classification, 'deny-test-undeclared-role'));
    if (r.status !== 400 || !/not a role/.test(r.text)) failures.push(`a team create at an undeclared role answered ${r.status}, not 400 naming the role`);
    let declared = [];
    try {
      const { defaultProfileRegistry } = require('../lib/profile-registry.js');
      declared = defaultProfileRegistry.rolesFor(cleared.classification);
    } catch (e) {
      skipped.push(`create at a declared role that is not enabled: the registry could not be read (${String(e?.message || e).slice(0, 80)})`);
    }
    const notEnabled = declared.find((role) => !cleared.roles.includes(role));
    if (declared.length && !notEnabled) skipped.push(`create at a declared role that is not enabled: every role ${cleared.classification} declares is enabled`);
    if (notEnabled) {
      checked += 1;
      const n = await team.call('POST', rosterUrl, probe(cleared.classification, notEnabled));
      if (n.status !== 400 || !/not enabled/.test(n.text)) failures.push(`a team create at ${cleared.classification}/${notEnabled}, declared but not enabled, answered ${n.status}, not 400`);
    }
  }

  // 3. Moving an owned assistant to a team the member is not in.
  checked += 1;
  const moved = await team.call('POST', `${API_ROOT['assistant-admin']}/admin/assistants/${OWNED}/ownership`, {
    assistant: OWNED, team: 'denytestforeign', reason: 'deny-test: a team moves only to its own teams',
  });
  if (moved.status !== 403 || !/TEAM_NOT_YOURS/.test(moved.text)) {
    failures.push(`a team moving ${OWNED} to a team it is not in answered ${moved.status}, not 403 TEAM_NOT_YOURS`);
  }
  for (const s of skipped) console.log(`skipped: ${s}`);
}

await restore();
// ── REASSIGNING WITHDRAWS REACH ON THE NEXT SESSION, WITH NO DEPLOY (acceptance criterion (b)) ────
{
  checked += 1;
  if (priorOwner !== 'ops') {
    const after = await consoleAnswer('teamOpsUser');
    const still = after.status === 200 && (after.body.assistants ?? []).includes(OWNED);
    if (still) failures.push(`after ${OWNED}'s owner was restored, a new ops session still named it`);
  }
}
console.log(`\nchecked ${checked} routes`);
if (notDeployed.length) console.log(`not deployed on this instance, so not checked (${notDeployed.length}):\n  ${notDeployed.join('\n  ')}`);
if (notDeployed.length > checked / 4) failures.push(`${notDeployed.length} catalog routes are not on the deployed API: the route list was misread, or the check is close to vacuous`);
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('every admin capability is refused at the gateway to a role that does not hold it, and admitted to one that does');
